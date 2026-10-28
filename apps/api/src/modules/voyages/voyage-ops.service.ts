import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { NoticeStatus, Prisma, Voyage, VoyageNotice } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService } from '../files/files.service';
import { SCHEDULED_JOBS } from '../jobs/queues';
import { SchedulerRegistry } from '../jobs/scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OWNER_NOR_RECORD, OWNER_TASK_EVIDENCE, OWNER_VOYAGE_FILE, loadVoyageFiles, userLabels } from './voyages.common';
import {
  AddVoyageFileDto,
  CompleteTaskDto,
  CreateNoticeDto,
  CreateNorDto,
  CreateTaskDto,
  MarkNoticeSentDto,
  UpdateNoticeDto,
  UpdateNorDto,
  UpdateTaskDto,
} from './voyages.dto';
import { buildNoticeEmailDraft, canCompleteTask, canTransitionNotice, utcDayKey } from './voyages.logic';
import { VoyagesService } from './voyages.service';

const SUBJECT_PREFIX = 'Subject: ';
/** Tolérance d'horloge pour une date « réelle » saisie (envoi, NOR) */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Sépare « Subject: … » (1re ligne) du corps d'un brouillon de notice. */
function splitDraft(draft: string | null): { subject: string | null; body: string | null } {
  if (!draft) return { subject: null, body: null };
  if (draft.startsWith(SUBJECT_PREFIX)) {
    const [first, ...rest] = draft.split('\n');
    return { subject: first.slice(SUBJECT_PREFIX.length).trim(), body: rest.join('\n').replace(/^\n+/, '') };
  }
  return { subject: null, body: draft };
}

/**
 * Exécution opérationnelle d'un voyage (CDC §7.4) : checklist / tâches par escale avec preuve,
 * notices d'arrivée (brouillon → validation humaine → marquage SENT manuel, aucun envoi
 * externe automatique en V1), NOR, fichiers du voyage et rappels planifiés des notices.
 */
@Injectable()
export class VoyageOpsService implements OnModuleInit {
  private readonly logger = new Logger('VoyageNotices');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly notifications: NotificationsService,
    private readonly scheduler: SchedulerRegistry,
    private readonly voyages: VoyagesService,
  ) {}

  onModuleInit(): void {
    // Fichiers voyage, preuves de tâches et NOR : voyages.view + scope navire (tous modes)
    const grant = (ctx: AuthContext, entityType: string, entityId: string, vesselId: string | undefined) => {
      if (!vesselId) throw Errors.notFound('Fichier');
      this.access.assertVesselAccess(ctx, vesselId);
      return { module: 'voyages' as const, entityType, entityId, vesselId };
    };
    this.registry.register(OWNER_VOYAGE_FILE, async (ctx, file) => {
      this.access.assertCan(ctx, 'voyages.view');
      const vf = await this.prisma.voyageFile.findUnique({ where: { id: file.ownerId! }, select: { voyage: { select: { vesselId: true } } } });
      return grant(ctx, 'voyage_file', file.ownerId!, vf?.voyage.vesselId);
    });
    this.registry.register(OWNER_TASK_EVIDENCE, async (ctx, file) => {
      this.access.assertCan(ctx, 'voyages.view');
      const t = await this.prisma.voyageTask.findUnique({ where: { id: file.ownerId! }, select: { voyage: { select: { vesselId: true } } } });
      return grant(ctx, 'voyage_task', file.ownerId!, t?.voyage.vesselId);
    });
    this.registry.register(OWNER_NOR_RECORD, async (ctx, file) => {
      this.access.assertCan(ctx, 'voyages.view');
      const n = await this.prisma.norRecord.findUnique({ where: { id: file.ownerId! }, select: { voyage: { select: { vesselId: true } } } });
      return grant(ctx, 'nor_record', file.ownerId!, n?.voyage.vesselId);
    });
    this.scheduler.register(SCHEDULED_JOBS.VOYAGE_NOTICES, () => this.runNoticeReminders());
  }

  private async openVoyage(ctx: AuthContext, voyageId: string): Promise<Voyage> {
    const v = await this.voyages.getAccessible(ctx, voyageId);
    this.voyages.assertOpen(v);
    return v;
  }

  private async assertPortOfVoyage(voyageId: string, portId: string | null | undefined) {
    if (!portId) return;
    if (!(await this.prisma.voyagePort.count({ where: { id: portId, voyageId } }))) throw Errors.validation('Escale inconnue pour ce voyage');
  }

  // ---------------------------------------------------------------------------
  // Tâches / checklist
  // ---------------------------------------------------------------------------

  async listTasks(ctx: AuthContext, voyageId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    const tasks = await this.prisma.voyageTask.findMany({
      where: { voyageId },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      include: { port: { select: { id: true, portName: true, sequence: true } } },
    });
    const labels = await userLabels(this.prisma, tasks.flatMap((t) => [t.assigneeId, t.completedById]));
    return tasks.map((t) => ({
      ...t,
      assignee: t.assigneeId ? labels.get(t.assigneeId) ?? null : null,
      completedBy: t.completedById ? labels.get(t.completedById) ?? null : null,
      canComplete: t.status === 'OPEN' && canCompleteTask({ voyagesEdit: can(ctx, 'voyages.edit'), noonSubmit: can(ctx, 'noon.submit') }, t.assigneeId, ctx.userId),
    }));
  }

  /** Responsable : utilisateur actif ayant voyages.view sur le navire. */
  private async assertAssignee(assigneeId: string | null | undefined, vesselId: string) {
    if (!assigneeId) return;
    if (!(await this.access.userCan(assigneeId, 'voyages.view', vesselId))) {
      throw Errors.validation('Responsable sans accès au voyage (voyages.view + navire requis)');
    }
  }

  private async getTask(voyageId: string, taskId: string) {
    const t = await this.prisma.voyageTask.findFirst({ where: { id: taskId, voyageId } });
    if (!t) throw Errors.notFound('Tâche');
    return t;
  }

  async createTask(ctx: AuthContext, voyageId: string, dto: CreateTaskDto) {
    const v = await this.openVoyage(ctx, voyageId);
    await this.assertPortOfVoyage(voyageId, dto.portId);
    await this.assertAssignee(dto.assigneeId, v.vesselId);
    return this.prisma.$transaction(async (tx) => {
      const sortOrder = dto.sortOrder ?? ((await tx.voyageTask.aggregate({ where: { voyageId }, _max: { sortOrder: true } }))._max.sortOrder ?? -1) + 1;
      const task = await tx.voyageTask.create({ data: { ...dto, voyageId, sortOrder } as Prisma.VoyageTaskUncheckedCreateInput });
      await this.audit.record(
        ctx,
        { action: 'voyage.task_created', module: 'voyages', entityType: 'voyage_task', entityId: task.id, vesselId: v.vesselId, after: task, metadata: { voyageId } },
        tx,
      );
      return task;
    });
  }

  async updateTask(ctx: AuthContext, voyageId: string, taskId: string, dto: UpdateTaskDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.getTask(voyageId, taskId);
    if (before.status !== 'OPEN') throw Errors.invalidState('Seule une tâche ouverte peut être modifiée', { status: before.status });
    if (dto.portId !== undefined) await this.assertPortOfVoyage(voyageId, dto.portId);
    if (dto.assigneeId !== undefined) await this.assertAssignee(dto.assigneeId, v.vesselId);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageTask.updateMany({ where: { id: taskId, status: 'OPEN' }, data: dto as Prisma.VoyageTaskUncheckedUpdateManyInput });
      if (res.count === 0) throw Errors.alreadyProcessed('Tâche déjà traitée');
      const after = await tx.voyageTask.findUniqueOrThrow({ where: { id: taskId } });
      await this.audit.record(
        ctx,
        { action: 'voyage.task_updated', module: 'voyages', entityType: 'voyage_task', entityId: taskId, vesselId: v.vesselId, ...diffFields(before as never, after as never), metadata: { voyageId } },
        tx,
      );
      return after;
    });
  }

  /**
   * Cocher une tâche (CDC §7.4) : services terre (voyages.edit), Master (noon.submit) ou
   * responsable désigné — toujours avec scope navire. Commentaire + preuve (fichier VOYAGE).
   */
  async completeTask(ctx: AuthContext, voyageId: string, taskId: string, dto: CompleteTaskDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const task = await this.getTask(voyageId, taskId);
    if (!canCompleteTask({ voyagesEdit: can(ctx, 'voyages.edit'), noonSubmit: can(ctx, 'noon.submit') }, task.assigneeId, ctx.userId)) {
      throw Errors.forbidden('Réservé aux services terre (voyages.edit), au Master (noon.submit) ou au responsable de la tâche', {
        anyOf: ['voyages.edit', 'noon.submit'],
      });
    }
    if (task.status !== 'OPEN') throw Errors.alreadyProcessed('Tâche déjà traitée');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      if (dto.evidenceFileId) {
        await this.files.attach(ctx, dto.evidenceFileId, { type: OWNER_TASK_EVIDENCE, id: taskId, contexts: ['VOYAGE'], vesselId: v.vesselId }, tx);
      }
      const res = await tx.voyageTask.updateMany({
        where: { id: taskId, status: 'OPEN' },
        data: {
          status: 'DONE',
          completedAt: now,
          completedById: ctx.userId,
          comment: dto.comment ?? task.comment,
          ...(dto.evidenceFileId ? { evidenceFileId: dto.evidenceFileId } : {}),
        },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Tâche déjà traitée');
      await this.audit.record(
        ctx,
        {
          action: 'voyage.task_completed',
          module: 'voyages',
          entityType: 'voyage_task',
          entityId: taskId,
          vesselId: v.vesselId,
          before: { status: 'OPEN' },
          after: { status: 'DONE', completedAt: now, comment: dto.comment ?? null, evidenceFileId: dto.evidenceFileId ?? null },
          metadata: { voyageId, title: task.title },
        },
        tx,
      );
      return tx.voyageTask.findUniqueOrThrow({ where: { id: taskId } });
    });
  }

  async reopenTask(ctx: AuthContext, voyageId: string, taskId: string, reason: string) {
    const v = await this.openVoyage(ctx, voyageId);
    const task = await this.getTask(voyageId, taskId);
    if (task.status !== 'DONE') throw Errors.invalidState('Seule une tâche réalisée peut être rouverte');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageTask.updateMany({
        where: { id: taskId, status: 'DONE' },
        data: { status: 'OPEN', completedAt: null, completedById: null, evidenceFileId: null },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Tâche déjà traitée');
      await this.audit.record(
        ctx,
        {
          action: 'voyage.task_reopened',
          module: 'voyages',
          entityType: 'voyage_task',
          entityId: taskId,
          vesselId: v.vesselId,
          before: { status: 'DONE', completedAt: task.completedAt, completedById: task.completedById, evidenceFileId: task.evidenceFileId },
          after: { status: 'OPEN' },
          metadata: { voyageId, reason },
        },
        tx,
      );
      return tx.voyageTask.findUniqueOrThrow({ where: { id: taskId } });
    });
  }

  async cancelTask(ctx: AuthContext, voyageId: string, taskId: string, reason: string) {
    const v = await this.openVoyage(ctx, voyageId);
    await this.getTask(voyageId, taskId);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageTask.updateMany({ where: { id: taskId, status: 'OPEN' }, data: { status: 'CANCELLED' } });
      if (res.count === 0) throw Errors.invalidState('Seule une tâche ouverte peut être annulée');
      await this.audit.record(
        ctx,
        { action: 'voyage.task_cancelled', module: 'voyages', entityType: 'voyage_task', entityId: taskId, vesselId: v.vesselId, before: { status: 'OPEN' }, after: { status: 'CANCELLED' }, metadata: { voyageId, reason } },
        tx,
      );
      return tx.voyageTask.findUniqueOrThrow({ where: { id: taskId } });
    });
  }

  // ---------------------------------------------------------------------------
  // Notices (CDC §7.4) — jamais d'envoi externe automatique
  // ---------------------------------------------------------------------------

  async listNotices(ctx: AuthContext, voyageId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    const notices = await this.prisma.voyageNotice.findMany({
      where: { voyageId },
      orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }],
      include: { port: { select: { id: true, portName: true, sequence: true } } },
    });
    const labels = await userLabels(this.prisma, notices.flatMap((n) => [n.validatedById, n.sentById]));
    const now = Date.now();
    return notices.map((n) => ({
      ...n,
      validatedBy: n.validatedById ? labels.get(n.validatedById) ?? null : null,
      sentBy: n.sentById ? labels.get(n.sentById) ?? null : null,
      overdue: !!n.dueAt && n.dueAt.getTime() < now && ['PLANNED', 'DRAFTED', 'VALIDATED'].includes(n.status),
    }));
  }

  private async getNotice(voyageId: string, noticeId: string) {
    const n = await this.prisma.voyageNotice.findFirst({ where: { id: noticeId, voyageId } });
    if (!n) throw Errors.notFound('Notice');
    return n;
  }

  private assertNoticeTransition(n: VoyageNotice, to: NoticeStatus) {
    if (!canTransitionNotice(n.status, to)) {
      throw Errors.invalidState(`Notice ${n.status} : passage à ${to} impossible`, { from: n.status, to });
    }
  }

  async createNotice(ctx: AuthContext, voyageId: string, dto: CreateNoticeDto) {
    const v = await this.openVoyage(ctx, voyageId);
    await this.assertPortOfVoyage(voyageId, dto.portId);
    return this.prisma.$transaction(async (tx) => {
      const notice = await tx.voyageNotice.create({
        data: { ...dto, voyageId, status: dto.draftBody ? 'DRAFTED' : 'PLANNED' } as Prisma.VoyageNoticeUncheckedCreateInput,
      });
      await this.audit.record(
        ctx,
        { action: 'voyage.notice_created', module: 'voyages', entityType: 'voyage_notice', entityId: notice.id, vesselId: v.vesselId, after: notice, metadata: { voyageId } },
        tx,
      );
      return notice;
    });
  }

  /** Toute modification d'une notice validée invalide la validation (retour DRAFTED). */
  async updateNotice(ctx: AuthContext, voyageId: string, noticeId: string, dto: UpdateNoticeDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.getNotice(voyageId, noticeId);
    if (dto.portId !== undefined) await this.assertPortOfVoyage(voyageId, dto.portId);
    if (!['PLANNED', 'DRAFTED', 'VALIDATED'].includes(before.status)) {
      throw Errors.invalidState(`Notice ${before.status} : modification impossible`, { status: before.status });
    }
    const body = dto.draftBody !== undefined ? dto.draftBody : before.draftBody;
    const status: NoticeStatus = body ? 'DRAFTED' : 'PLANNED';
    if (status !== before.status) this.assertNoticeTransition(before, status);
    const invalidated = before.status === 'VALIDATED';
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageNotice.updateMany({
        where: { id: noticeId, status: before.status },
        data: { ...(dto as Prisma.VoyageNoticeUncheckedUpdateManyInput), status, ...(invalidated ? { validatedAt: null, validatedById: null } : {}) },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Notice modifiée entre-temps : rechargez-la');
      const after = await tx.voyageNotice.findUniqueOrThrow({ where: { id: noticeId } });
      await this.audit.record(
        ctx,
        {
          action: 'voyage.notice_updated',
          module: 'voyages',
          entityType: 'voyage_notice',
          entityId: noticeId,
          vesselId: v.vesselId,
          ...diffFields(before as never, after as never),
          metadata: { voyageId, ...(invalidated ? { validationInvalidated: true } : {}) },
        },
        tx,
      );
      return after;
    });
  }

  /**
   * Génère le brouillon d'e-mail à partir des données du voyage (rien n'est inventé : les
   * valeurs manquantes sont marquées TO BE CONFIRMED). Aucun envoi : validation humaine requise.
   */
  async generateDraft(ctx: AuthContext, voyageId: string, noticeId: string, overwrite: boolean) {
    const v = await this.openVoyage(ctx, voyageId);
    const n = await this.getNotice(voyageId, noticeId);
    if (n.draftBody && !overwrite) return { notice: n, generated: false, email: this.composeEmail(n) };
    this.assertNoticeTransition(n, 'DRAFTED');
    const [vessel, port, cargos] = await Promise.all([
      this.prisma.vessel.findUniqueOrThrow({ where: { id: v.vesselId }, select: { name: true, imoNumber: true } }),
      n.portId ? this.prisma.voyagePort.findUnique({ where: { id: n.portId }, include: { agent: { select: { name: true } } } }) : Promise.resolve(null),
      this.prisma.cargo.findMany({ where: { voyageId }, orderBy: { commodity: 'asc' } }),
    ]);
    const draft = buildNoticeEmailDraft({
      vesselName: vessel.name,
      vesselImo: vessel.imoNumber,
      voyageReference: v.reference,
      charterer: v.charterer,
      notice: { kind: n.kind, scheduleLabel: n.scheduleLabel, recipients: n.recipients },
      port: port ? { portName: port.portName, country: port.country, type: port.type, eta: port.eta, etd: port.etd, agentName: port.agent?.name ?? null } : null,
      voyageEta: v.eta,
      cargo: cargos.map((c) => ({ commodity: c.commodity, qtyMinMt: c.qtyMinMt?.toString() ?? null, qtyMaxMt: c.qtyMaxMt?.toString() ?? null, qtyActualMt: c.qtyActualMt?.toString() ?? null, unit: c.unit })),
    });
    const draftBody = `${SUBJECT_PREFIX}${draft.subject}\n\n${draft.body}`;
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageNotice.updateMany({
        where: { id: noticeId, status: n.status },
        data: { draftBody, status: 'DRAFTED', ...(n.status === 'VALIDATED' ? { validatedAt: null, validatedById: null } : {}) },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Notice modifiée entre-temps : rechargez-la');
      await this.audit.record(
        ctx,
        {
          action: 'voyage.notice_drafted',
          module: 'voyages',
          entityType: 'voyage_notice',
          entityId: noticeId,
          vesselId: v.vesselId,
          before: { status: n.status, draftBody: n.draftBody },
          after: { status: 'DRAFTED', draftBody },
          metadata: { voyageId, generated: true, overwrite },
        },
        tx,
      );
      return tx.voyageNotice.findUniqueOrThrow({ where: { id: noticeId } });
    });
    return { notice: updated, generated: true, email: this.composeEmail(updated) };
  }

  private composeEmail(n: VoyageNotice) {
    const { subject, body } = splitDraft(n.draftBody);
    return {
      to: n.recipients,
      subject,
      body,
      validated: n.status === 'VALIDATED' || n.status === 'SENT',
      notice: 'Aucun envoi automatique (CDC §7.4) : copier ce brouillon validé dans votre messagerie, puis marquer la notice envoyée.',
    };
  }

  async emailDraft(ctx: AuthContext, voyageId: string, noticeId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    return this.composeEmail(await this.getNotice(voyageId, noticeId));
  }

  /** Validation humaine du brouillon (destinataires et texte requis). */
  async validateNotice(ctx: AuthContext, voyageId: string, noticeId: string) {
    const v = await this.openVoyage(ctx, voyageId);
    const n = await this.getNotice(voyageId, noticeId);
    if (n.status === 'VALIDATED') throw Errors.alreadyProcessed('Notice déjà validée');
    this.assertNoticeTransition(n, 'VALIDATED');
    if (!n.draftBody?.trim()) throw Errors.business('Brouillon vide : rédiger ou générer le texte avant validation');
    if (!n.recipients?.trim()) throw Errors.business('Destinataires non renseignés');
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const res = await tx.voyageNotice.updateMany({ where: { id: noticeId, status: 'DRAFTED' }, data: { status: 'VALIDATED', validatedById: ctx.userId, validatedAt: now } });
      if (res.count === 0) throw Errors.alreadyProcessed('Notice modifiée entre-temps : rechargez-la');
      await this.audit.record(
        ctx,
        { action: 'voyage.notice_validated', module: 'voyages', entityType: 'voyage_notice', entityId: noticeId, vesselId: v.vesselId, before: { status: 'DRAFTED' }, after: { status: 'VALIDATED', validatedAt: now }, metadata: { voyageId } },
        tx,
      );
      return tx.voyageNotice.findUniqueOrThrow({ where: { id: noticeId } });
    });
  }

  /** Marquage manuel de l'envoi effectué hors plateforme (sentBy / sentAt). */
  async markSent(ctx: AuthContext, voyageId: string, noticeId: string, dto: MarkNoticeSentDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const n = await this.getNotice(voyageId, noticeId);
    if (n.status === 'SENT') throw Errors.alreadyProcessed('Notice déjà marquée envoyée');
    if (n.status !== 'VALIDATED') throw Errors.invalidState('La notice doit être validée avant d’être marquée envoyée', { status: n.status });
    const sentAt = dto.sentAt ?? new Date();
    if (sentAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw Errors.validation('Date d’envoi dans le futur');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageNotice.updateMany({ where: { id: noticeId, status: 'VALIDATED' }, data: { status: 'SENT', sentAt, sentById: ctx.userId } });
      if (res.count === 0) throw Errors.alreadyProcessed('Notice modifiée entre-temps : rechargez-la');
      await this.audit.record(
        ctx,
        {
          action: 'voyage.notice_marked_sent',
          module: 'voyages',
          entityType: 'voyage_notice',
          entityId: noticeId,
          vesselId: v.vesselId,
          before: { status: 'VALIDATED' },
          after: { status: 'SENT', sentAt },
          metadata: { voyageId, channel: dto.channel, comment: dto.comment, sentOutsidePlatform: true, automaticSending: false },
        },
        tx,
      );
      await this.notifications.resolveForEntity('voyage_notice', noticeId, 'voyage.notice', tx);
      return tx.voyageNotice.findUniqueOrThrow({ where: { id: noticeId } });
    });
  }

  async cancelNotice(ctx: AuthContext, voyageId: string, noticeId: string, reason: string) {
    const v = await this.openVoyage(ctx, voyageId);
    const n = await this.getNotice(voyageId, noticeId);
    this.assertNoticeTransition(n, 'CANCELLED');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyageNotice.updateMany({ where: { id: noticeId, status: n.status }, data: { status: 'CANCELLED' } });
      if (res.count === 0) throw Errors.alreadyProcessed('Notice modifiée entre-temps : rechargez-la');
      await this.audit.record(
        ctx,
        { action: 'voyage.notice_cancelled', module: 'voyages', entityType: 'voyage_notice', entityId: noticeId, vesselId: v.vesselId, before: { status: n.status }, after: { status: 'CANCELLED' }, metadata: { voyageId, reason } },
        tx,
      );
      await this.notifications.resolveForEntity('voyage_notice', noticeId, 'voyage.notice', tx);
      return tx.voyageNotice.findUniqueOrThrow({ where: { id: noticeId } });
    });
  }

  /**
   * Rappels planifiés (SCHEDULED_JOBS.VOYAGE_NOTICES, toutes les heures) : notices non envoyées
   * dont l'échéance tombe dans les 24 h (ou dépassée) sur un voyage PLANNED / ACTIVE ->
   * notification plateforme + e-mail aux utilisateurs voyages.edit du navire, une fois par
   * notice et par jour (dedupeKey). Aucun envoi externe.
   */
  async runNoticeReminders(now = new Date()) {
    const horizon = new Date(now.getTime() + 24 * 3_600_000);
    const notices = await this.prisma.voyageNotice.findMany({
      where: { status: { in: ['PLANNED', 'DRAFTED', 'VALIDATED'] }, dueAt: { not: null, lte: horizon }, voyage: { status: { in: ['PLANNED', 'ACTIVE'] } } },
      include: {
        voyage: { select: { id: true, reference: true, vesselId: true, vessel: { select: { name: true } } } },
        port: { select: { portName: true } },
      },
      orderBy: { dueAt: 'asc' },
      take: 2000,
    });
    const recipientsByVessel = new Map<string, string[]>();
    let notified = 0;
    let failed = 0;
    for (const n of notices) {
      try {
        const vesselId = n.voyage.vesselId;
        if (!recipientsByVessel.has(vesselId)) recipientsByVessel.set(vesselId, await this.access.usersWithPermission('voyages.edit', vesselId));
        const users = recipientsByVessel.get(vesselId)!;
        if (!users.length) continue;
        const overdue = n.dueAt! < now;
        const due = `${n.dueAt!.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
        const label = n.scheduleLabel ?? n.kind;
        const sent = await this.notifications.notify({
          userIds: users,
          type: overdue ? 'voyage.notice_overdue' : 'voyage.notice_due',
          title: `${overdue ? 'Notice en retard' : 'Notice à préparer'} — ${n.voyage.vessel.name} ${n.voyage.reference} : ${label}`,
          body:
            `Échéance : ${due}${n.port ? ` — escale ${n.port.portName}` : ''}. Statut : ${n.status}. Destinataires prévus : ${n.recipients ?? 'non renseignés'}.\n` +
            'Aucun envoi externe automatique : préparer le brouillon, le faire valider, l’envoyer puis le marquer envoyé (CDC §7.4).',
          module: 'voyages',
          entityType: 'voyage_notice',
          entityId: n.id,
          vesselId,
          link: `/voyages/${n.voyage.id}?tab=notices`,
          priority: overdue ? 'HIGH' : 'NORMAL',
          dedupeKey: `voyage-notice:${n.id}:${utcDayKey(now)}`,
          email: true,
          requiredPermission: 'voyages.edit',
        });
        notified += sent.length;
      } catch (e) {
        failed++;
        this.logger.error(`Rappel notice ${n.id} échoué : ${String(e)}`);
      }
    }
    return { scanned: notices.length, notified, failed };
  }

  // ---------------------------------------------------------------------------
  // NOR (Notice of Readiness) — enregistrement, aucune interprétation laytime
  // ---------------------------------------------------------------------------

  async listNor(ctx: AuthContext, voyageId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    const rows = await this.prisma.norRecord.findMany({
      where: { voyageId },
      orderBy: { tenderedAt: 'asc' },
      include: { port: { select: { id: true, portName: true, sequence: true, type: true } } },
    });
    const labels = await userLabels(this.prisma, rows.map((r) => r.createdById));
    return rows.map((r) => ({ ...r, createdBy: labels.get(r.createdById) ?? null }));
  }

  async createNor(ctx: AuthContext, voyageId: string, dto: CreateNorDto) {
    const v = await this.openVoyage(ctx, voyageId);
    await this.assertPortOfVoyage(voyageId, dto.portId);
    this.assertNorTimes(dto.tenderedAt, dto.acceptedAt ?? null);
    return this.prisma.$transaction(async (tx) => {
      const { fileId, ...data } = dto;
      const nor = await tx.norRecord.create({ data: { ...data, voyageId, createdById: ctx.userId } as Prisma.NorRecordUncheckedCreateInput });
      if (fileId) {
        await this.files.attach(ctx, fileId, { type: OWNER_NOR_RECORD, id: nor.id, contexts: ['VOYAGE'], vesselId: v.vesselId }, tx);
        await tx.norRecord.update({ where: { id: nor.id }, data: { fileId } });
      }
      await this.audit.record(
        ctx,
        { action: 'voyage.nor_recorded', module: 'voyages', entityType: 'nor_record', entityId: nor.id, vesselId: v.vesselId, after: { ...nor, fileId: fileId ?? null }, metadata: { voyageId } },
        tx,
      );
      return tx.norRecord.findUniqueOrThrow({ where: { id: nor.id } });
    });
  }

  async updateNor(ctx: AuthContext, voyageId: string, norId: string, dto: UpdateNorDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.prisma.norRecord.findFirst({ where: { id: norId, voyageId } });
    if (!before) throw Errors.notFound('NOR');
    if (dto.fileId && before.fileId) throw Errors.conflict('Un document est déjà joint à cette NOR');
    this.assertNorTimes(dto.tenderedAt ?? before.tenderedAt, dto.acceptedAt !== undefined ? dto.acceptedAt : before.acceptedAt);
    return this.prisma.$transaction(async (tx) => {
      if (dto.fileId) await this.files.attach(ctx, dto.fileId, { type: OWNER_NOR_RECORD, id: norId, contexts: ['VOYAGE'], vesselId: v.vesselId }, tx);
      const after = await tx.norRecord.update({ where: { id: norId }, data: dto as Prisma.NorRecordUncheckedUpdateInput });
      await this.audit.record(
        ctx,
        { action: 'voyage.nor_updated', module: 'voyages', entityType: 'nor_record', entityId: norId, vesselId: v.vesselId, ...diffFields(before as never, after as never), metadata: { voyageId } },
        tx,
      );
      return after;
    });
  }

  private assertNorTimes(tenderedAt: Date, acceptedAt: Date | null) {
    if (tenderedAt.getTime() > Date.now() + FUTURE_TOLERANCE_MS) throw Errors.validation('NOR remise dans le futur');
    if (acceptedAt && acceptedAt < tenderedAt) throw Errors.validation('Acceptation de la NOR antérieure à sa remise');
  }

  async norFileLink(ctx: AuthContext, voyageId: string, norId: string, mode: 'preview' | 'download') {
    await this.voyages.getAccessible(ctx, voyageId);
    const nor = await this.prisma.norRecord.findFirst({ where: { id: norId, voyageId }, select: { fileId: true } });
    if (!nor) throw Errors.notFound('NOR');
    if (!nor.fileId) throw Errors.notFound('Document NOR');
    return this.files.issueLink(ctx, nor.fileId, mode);
  }

  // ---------------------------------------------------------------------------
  // Fichiers du voyage
  // ---------------------------------------------------------------------------

  async listFiles(ctx: AuthContext, voyageId: string, includeArchived: boolean) {
    await this.voyages.getAccessible(ctx, voyageId);
    return loadVoyageFiles(this.prisma, voyageId, includeArchived);
  }

  /** Ajout possible sur un voyage clôturé (dossier de fin de voyage), pas sur un voyage annulé. */
  async addFile(ctx: AuthContext, voyageId: string, dto: AddVoyageFileDto) {
    const v = await this.voyages.getAccessible(ctx, voyageId);
    if (v.status === 'CANCELLED') throw Errors.invalidState('Voyage annulé : ajout de fichier impossible');
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.voyageFile.create({ data: { voyageId, fileId: dto.fileId, category: dto.category, title: dto.title, uploadedById: ctx.userId } });
      await this.files.attach(ctx, dto.fileId, { type: OWNER_VOYAGE_FILE, id: row.id, contexts: ['VOYAGE'], vesselId: v.vesselId }, tx);
      await this.audit.record(
        ctx,
        { action: 'voyage.file_added', module: 'voyages', entityType: 'voyage_file', entityId: row.id, vesselId: v.vesselId, after: row, metadata: { voyageId } },
        tx,
      );
      return row;
    });
  }

  async setFileArchived(ctx: AuthContext, voyageId: string, voyageFileId: string, archived: boolean, reason?: string) {
    const v = await this.voyages.getAccessible(ctx, voyageId);
    const all = await loadVoyageFiles(this.prisma, voyageId, true);
    const row = all.find((f) => f.id === voyageFileId);
    if (!row) throw Errors.notFound('Fichier du voyage');
    if (archived === !!row.archivedAt) throw Errors.alreadyProcessed(archived ? 'Fichier déjà archivé' : 'Fichier non archivé');
    await this.prisma.$transaction(async (tx) => {
      // Mise à jour conditionnelle : deux demandes concurrentes ne peuvent pas toutes deux réussir
      const res = await tx.voyageFile.updateMany({
        where: { id: voyageFileId, voyageId, archivedAt: archived ? null : { not: null } },
        data: archived ? { archivedAt: new Date(), archivedById: ctx.userId } : { archivedAt: null, archivedById: null },
      });
      if (res.count !== 1) throw Errors.alreadyProcessed(archived ? 'Fichier déjà archivé' : 'Fichier non archivé');
      await this.audit.record(
        ctx,
        {
          action: archived ? 'voyage.file_archived' : 'voyage.file_unarchived',
          module: 'voyages',
          entityType: 'voyage_file',
          entityId: voyageFileId,
          vesselId: v.vesselId,
          before: { archived: !archived },
          after: { archived },
          metadata: { voyageId, fileId: row.fileId, title: row.title, reason },
        },
        tx,
      );
    });
    return (await loadVoyageFiles(this.prisma, voyageId, true)).find((f) => f.id === voyageFileId);
  }
}
