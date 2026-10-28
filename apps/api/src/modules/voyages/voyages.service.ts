import { Injectable } from '@nestjs/common';
import { Prisma, Voyage } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { NumberingService } from '../documents/numbering.service';
import { canAccessCp, loadVoyageFiles, serializeVoyage, userLabels } from './voyages.common';
import { CreateVoyageDto, ListVoyagesQuery, UpdateVoyageDto } from './voyages.dto';
import {
  CERTIFICATE_CHECK_DISCLAIMER,
  TIMELINE_SCHEDULE_FIELDS,
  TimelineEvent,
  VOYAGE_AUDIT_LABELS,
  VOYAGE_COMMANDS,
  VOYAGE_TRANSITIONS,
  VoyageCommand,
  canTransitionVoyage,
  charterPartyCandidates,
  checkCharterPartyRequirement,
  flagCertificate,
  isVoyageClosed,
  pickScheduleDetails,
  sortTimeline,
  stripCharterPartyReferences,
  voyageEndDate,
} from './voyages.logic';

/**
 * Voyages (CDC §7.1, §7.4, V1 §10) : référentiel voyage, automate d'états, workspace,
 * timeline maritime et contrôle informatif des certificats. Tout est filtré par le scope navire.
 */
@Injectable()
export class VoyagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
  ) {}

  // ---------------------------------------------------------------------------
  // Accès
  // ---------------------------------------------------------------------------

  /** Voyage + contrôle scope navire (anti-IDOR). */
  async getAccessible(ctx: AuthContext, id: string, db: Db = this.prisma): Promise<Voyage> {
    const v = await db.voyage.findUnique({ where: { id } });
    if (!v) throw Errors.notFound('Voyage');
    this.access.assertVesselAccess(ctx, v.vesselId);
    return v;
  }

  /** Un voyage clôturé (COMPLETED / CANCELLED) est en lecture seule. */
  assertOpen(v: Pick<Voyage, 'status' | 'reference'>): void {
    if (isVoyageClosed(v.status)) {
      throw Errors.invalidState(`Voyage ${v.reference} clôturé (${v.status}) : modification impossible`, { status: v.status });
    }
  }

  // ---------------------------------------------------------------------------
  // Liste & détail (workspace)
  // ---------------------------------------------------------------------------

  async list(ctx: AuthContext, q: ListVoyagesQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const toExclusive = q.to ? new Date(q.to.getTime() + 86_400_000) : null;
    const where: Prisma.VoyageWhereInput = {
      AND: [
        vesselWhere(ctx) as Prisma.VoyageWhereInput,
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.status ? { status: q.status } : {},
        q.charterer ? { charterer: { contains: q.charterer, mode: 'insensitive' } } : {},
        q.search
          ? {
              OR: [
                { reference: { contains: q.search, mode: 'insensitive' } },
                { description: { contains: q.search, mode: 'insensitive' } },
                { charterer: { contains: q.search, mode: 'insensitive' } },
                { ports: { some: { portName: { contains: q.search, mode: 'insensitive' } } } },
              ],
            }
          : {},
        // Période recoupant [from ; to] : au moins une date du voyage après `from` / avant `to`
        q.from
          ? {
              OR: [
                { laycanTo: { gte: q.from } },
                { laycanFrom: { gte: q.from } },
                { eta: { gte: q.from } },
                { ata: { gte: q.from } },
                { etd: { gte: q.from } },
              ],
            }
          : {},
        toExclusive
          ? {
              OR: [
                { laycanFrom: { lt: toExclusive } },
                { laycanTo: { lt: toExclusive } },
                { etd: { lt: toExclusive } },
                { atd: { lt: toExclusive } },
                { eta: { lt: toExclusive } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.voyage.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          vessel: { select: { id: true, code: true, name: true } },
          ports: { orderBy: { sequence: 'asc' }, select: { id: true, sequence: true, type: true, portName: true, country: true, eta: true, ata: true } },
          _count: { select: { cargos: true, tasks: true, notices: true, noonReports: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.voyage.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    return { ...page, items: page.items.map((v) => serializeVoyage(ctx, v)) };
  }

  /**
   * Voyage Workspace (CDC §7.4, V1 §10.3) : Overview, Ports & Agents, Cargo, Notices & NOR,
   * Charter Party (si charter_party.view), Voyage Instructions, Noon Reports (si noon.view),
   * Files, Tasks, Timeline.
   */
  async get(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    const v = await this.prisma.voyage.findUniqueOrThrow({
      where: { id },
      include: {
        vessel: { select: { id: true, code: true, name: true, imoNumber: true, timezone: true, status: true } },
        ports: { orderBy: { sequence: 'asc' }, include: { agent: { select: { id: true, name: true, role: true } } } },
        agents: { orderBy: [{ role: 'asc' }, { name: 'asc' }] },
        cargos: { orderBy: { commodity: 'asc' } },
        notices: { orderBy: [{ dueAt: 'asc' }, { createdAt: 'asc' }] },
        norRecords: { orderBy: { tenderedAt: 'asc' } },
        tasks: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    const { ports, agents, cargos, notices, norRecords, tasks, vessel, ...overview } = v;

    const [charterParty, instructions, noonReports, files, timeline] = await Promise.all([
      this.charterPartySummary(ctx, v),
      this.instructionsSummary(ctx, v.id),
      this.noonSummary(ctx, v.id),
      loadVoyageFiles(this.prisma, v.id, false),
      this.timeline(ctx, id, v),
    ]);
    const labels = await userLabels(this.prisma, [
      ...tasks.flatMap((t) => [t.assigneeId, t.completedById]),
      ...notices.flatMap((n) => [n.validatedById, n.sentById]),
    ]);
    const first = ports[0];
    const last = ports[ports.length - 1];

    return {
      overview: {
        ...serializeVoyage(ctx, overview),
        vessel,
        route: ports.length ? `${first.portName} → ${last.portName}` : null,
      },
      ports,
      agents,
      cargo: cargos,
      notices: notices.map((n) => ({
        ...n,
        validatedBy: n.validatedById ? labels.get(n.validatedById) ?? null : null,
        sentBy: n.sentById ? labels.get(n.sentById) ?? null : null,
      })),
      nor: norRecords,
      charterParty,
      instructions,
      noonReports,
      files,
      tasks: tasks.map((t) => ({
        ...t,
        assignee: t.assigneeId ? labels.get(t.assigneeId) ?? null : null,
        completedBy: t.completedById ? labels.get(t.completedById) ?? null : null,
      })),
      timeline,
      permissions: {
        edit: can(ctx, 'voyages.edit') && !isVoyageClosed(v.status),
        activate: can(ctx, 'voyages.activate'),
        close: can(ctx, 'voyages.close'),
        manageInstructions: can(ctx, 'instructions.manage'),
        allowedTransitions: VOYAGE_TRANSITIONS[v.status],
      },
    };
  }

  private async charterPartySummary(ctx: AuthContext, v: Voyage) {
    if (!can(ctx, 'charter_party.view')) return null; // confidentiel (CDC §7.2)
    if (!v.charterPartyId) return { linked: false };
    const cp = await this.prisma.charterParty.findUnique({
      where: { id: v.charterPartyId },
      select: {
        id: true,
        reference: true,
        cpType: true,
        cpDate: true,
        status: true,
        charterer: true,
        owner: true,
        laycanFrom: true,
        laycanTo: true,
        currentVersion: { select: { id: true, versionNo: true, kind: true, decidedAt: true, fileId: true } },
        versions: { where: { status: 'PENDING_APPROVAL' }, select: { id: true, versionNo: true, kind: true, submittedAt: true } },
      },
    });
    if (!cp) return { linked: false };
    const ack = cp.currentVersion
      ? await this.prisma.cpAcknowledgement.findUnique({
          where: { cpVersionId_userId: { cpVersionId: cp.currentVersion.id, userId: ctx.userId } },
          select: { acknowledgedAt: true },
        })
      : null;
    const { versions, ...rest } = cp;
    return { linked: true, ...rest, pendingVersion: versions[0] ?? null, acknowledgedByMe: ack?.acknowledgedAt ?? null };
  }

  private async instructionsSummary(ctx: AuthContext, voyageId: string) {
    const rows = await this.prisma.voyageInstruction.findMany({
      where: { voyageId, ...(can(ctx, 'instructions.manage') ? {} : { status: { not: 'DRAFT' } }) },
      orderBy: { versionNo: 'desc' },
      include: { acks: { select: { userId: true, ackAt: true } } },
    });
    return rows.map(({ acks, ...i }) => ({
      ...i,
      acknowledgements: acks.length,
      acknowledgedByMe: acks.find((a) => a.userId === ctx.userId)?.ackAt ?? null,
    }));
  }

  private async noonSummary(ctx: AuthContext, voyageId: string) {
    if (!can(ctx, 'noon.view')) return null;
    const [byStatus, latest] = await Promise.all([
      this.prisma.noonReport.groupBy({ by: ['status'], where: { voyageId }, _count: { _all: true } }),
      this.prisma.noonReport.findMany({
        where: { voyageId },
        orderBy: { reportDateUtc: 'desc' },
        take: 5,
        select: {
          id: true,
          reportType: true,
          reportDateUtc: true,
          utcOffsetMinutes: true,
          status: true,
          currentRevisionNo: true,
          latitude: true,
          longitude: true,
          speedKnots: true,
          submittedAt: true,
        },
      }),
    ]);
    return {
      total: byStatus.reduce((s, r) => s + r._count._all, 0),
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      latest,
    };
  }

  // ---------------------------------------------------------------------------
  // Création / modification
  // ---------------------------------------------------------------------------

  /** Création en DRAFT ; référence atomique ISK-VOY-2026-0002 (CP facultative en brouillon). */
  async create(ctx: AuthContext, dto: CreateVoyageDto) {
    this.access.assertVesselAccess(ctx, dto.vesselId);
    const vessel = await this.prisma.vessel.findUnique({ where: { id: dto.vesselId } });
    if (!vessel) throw Errors.notFound('Navire');
    if (vessel.status === 'SOLD') throw Errors.business('Navire vendu : création de voyage impossible');
    if (dto.charterPartyId) await this.loadLinkableCp(ctx, dto.charterPartyId, { id: null, vesselId: vessel.id });

    const voyage = await this.prisma.$transaction(async (tx) => {
      const reference = await this.numbering.nextFormatted('VOY', vessel.code, tx);
      const v = await tx.voyage.create({
        data: { ...dto, reference, status: 'DRAFT', createdById: ctx.userId } as Prisma.VoyageUncheckedCreateInput,
      });
      await this.audit.record(
        ctx,
        { action: 'voyage.created', module: 'voyages', entityType: 'voyage', entityId: v.id, vesselId: v.vesselId, after: v },
        tx,
      );
      return v;
    });
    return serializeVoyage(ctx, voyage);
  }

  /**
   * Modification (verrou optimiste expectedVersion). Les changements ETD/ETA/ATD/ATA et laycan
   * sont audités champ par champ. Le rattachement CP ne peut être retiré hors DRAFT (CDC §7.2).
   */
  async update(ctx: AuthContext, id: string, dto: UpdateVoyageDto) {
    const { expectedVersion, ...fields } = dto;
    const before = await this.getAccessible(ctx, id);
    this.assertOpen(before);
    if (before.lockVersion !== expectedVersion) throw Errors.staleVersion();

    const laycanFrom = fields.laycanFrom !== undefined ? fields.laycanFrom : before.laycanFrom;
    const laycanTo = fields.laycanTo !== undefined ? fields.laycanTo : before.laycanTo;
    if (laycanFrom && laycanTo && laycanFrom > laycanTo) {
      throw Errors.validation('Laycan : la date de début doit précéder la date de fin');
    }

    const cpChanged = fields.charterPartyId !== undefined && fields.charterPartyId !== before.charterPartyId;
    if (cpChanged) {
      if (!can(ctx, 'charter_party.view')) throw Errors.forbidden('Permission requise : charter_party.view', { permission: 'charter_party.view' });
      if (fields.charterPartyId === null) {
        if (before.status !== 'DRAFT') {
          throw Errors.business('Le rattachement à la Charter Party est obligatoire hors brouillon : il ne peut pas être retiré');
        }
      } else {
        await this.loadLinkableCp(ctx, fields.charterPartyId!, before);
      }
    }

    return this.prisma.$transaction(async (tx) => {
      const res = await tx.voyage.updateMany({
        where: { id, lockVersion: expectedVersion, status: before.status },
        data: { ...(fields as Prisma.VoyageUncheckedUpdateManyInput), lockVersion: { increment: 1 } },
      });
      if (res.count === 0) throw Errors.staleVersion();
      const after = await tx.voyage.findUniqueOrThrow({ where: { id } });
      const { updatedAt: _b, lockVersion: _lb, ...b } = before;
      const { updatedAt: _a, lockVersion: _la, ...a } = after;
      const diff = diffFields(b as never, a as never);
      const scheduleChanged = TIMELINE_SCHEDULE_FIELDS.filter((f) => diff.after && f in (diff.after as object));
      await this.audit.record(
        ctx,
        {
          action: 'voyage.updated',
          module: 'voyages',
          entityType: 'voyage',
          entityId: id,
          vesselId: after.vesselId,
          ...diff,
          metadata: scheduleChanged.length ? { scheduleChanged } : undefined,
        },
        tx,
      );
      if (cpChanged) {
        await this.audit.record(
          ctx,
          {
            action: 'voyage.charter_party_linked',
            module: 'voyages',
            entityType: 'voyage',
            entityId: id,
            vesselId: after.vesselId,
            before: { charterPartyId: before.charterPartyId },
            after: { charterPartyId: after.charterPartyId },
          },
          tx,
        );
      }
      return serializeVoyage(ctx, after);
    });
  }

  // ---------------------------------------------------------------------------
  // Commandes d'état (CDC §12) — jamais de PATCH status
  // ---------------------------------------------------------------------------

  async command(
    ctx: AuthContext,
    id: string,
    cmd: VoyageCommand,
    dto: { expectedVersion: number; comment?: string; reason?: string; charterPartyId?: string },
  ) {
    const def = VOYAGE_COMMANDS[cmd];
    this.access.assertCan(ctx, def.permission);
    const result = await this.prisma.serializable(async (tx) => {
      const v = await this.getAccessible(ctx, id, tx);
      if (!canTransitionVoyage(v.status, def.to)) {
        throw Errors.invalidState(`Transition ${v.status} → ${def.to} interdite`, { from: v.status, to: def.to, allowed: VOYAGE_TRANSITIONS[v.status] });
      }
      if (v.lockVersion !== dto.expectedVersion) throw Errors.staleVersion();

      let charterPartyId = v.charterPartyId;
      if (cmd === 'plan' && dto.charterPartyId && dto.charterPartyId !== v.charterPartyId) {
        if (!can(ctx, 'charter_party.view')) throw Errors.forbidden('Permission requise : charter_party.view', { permission: 'charter_party.view' });
        charterPartyId = (await this.loadLinkableCp(ctx, dto.charterPartyId, v, tx)).id;
      }
      if (cmd === 'plan' || cmd === 'activate') await this.assertCharterPartyRequirement(ctx, { ...v, charterPartyId }, tx);

      if (cmd === 'activate') {
        // Un seul voyage ACTIVE par navire (contrôle en transaction SERIALIZABLE)
        const other = await tx.voyage.findFirst({
          where: { vesselId: v.vesselId, status: 'ACTIVE', id: { not: v.id } },
          select: { id: true, reference: true },
        });
        if (other) {
          throw Errors.conflict(`Le navire a déjà un voyage actif (${other.reference}) : le clôturer avant d’en activer un autre`, {
            activeVoyageId: other.id,
            activeVoyage: other.reference,
          });
        }
      }

      const now = new Date();
      const res = await tx.voyage.updateMany({
        where: { id, lockVersion: dto.expectedVersion, status: v.status },
        data: {
          status: def.to,
          lockVersion: { increment: 1 },
          ...(charterPartyId !== v.charterPartyId ? { charterPartyId } : {}),
          ...(def.to === 'COMPLETED' || def.to === 'CANCELLED' ? { closedAt: now } : {}),
        },
      });
      if (res.count === 0) throw Errors.staleVersion();

      const metadata: Record<string, unknown> = {};
      if (dto.comment) metadata.comment = dto.comment;
      if (dto.reason) metadata.reason = dto.reason;
      if (charterPartyId !== v.charterPartyId) metadata.charterPartyLinked = charterPartyId;
      if (cmd === 'complete') {
        const openTasks = await tx.voyageTask.count({ where: { voyageId: id, status: 'OPEN' } });
        const pendingNotices = await tx.voyageNotice.count({ where: { voyageId: id, status: { in: ['PLANNED', 'DRAFTED', 'VALIDATED'] } } });
        const draftNoon = await tx.noonReport.count({ where: { voyageId: id, status: { in: ['DRAFT', 'CORRECTION_REQUESTED'] } } });
        Object.assign(metadata, { openTasks, pendingNotices, draftNoonReports: draftNoon });
      }
      await this.audit.record(
        ctx,
        {
          action: def.action,
          module: 'voyages',
          entityType: 'voyage',
          entityId: id,
          vesselId: v.vesselId,
          before: { status: v.status, charterPartyId: v.charterPartyId },
          after: { status: def.to, charterPartyId },
          metadata,
        },
        tx,
      );
      const after = await tx.voyage.findUniqueOrThrow({ where: { id } });
      return { voyage: after, warnings: cmd === 'complete' ? metadata : undefined };
    });
    return { ...serializeVoyage(ctx, result.voyage), ...(result.warnings ? { closureWarnings: result.warnings } : {}) };
  }

  /**
   * CDC §7.2 : rattachement principal obligatoire hors DRAFT lorsqu'une CP existe pour le voyage
   * (même navire, CP active non rattachée ailleurs, même affréteur ou laycan qui se recoupe).
   */
  private async assertCharterPartyRequirement(ctx: AuthContext, v: Voyage, db: Db) {
    const linked = v.charterPartyId
      ? await db.charterParty.findUnique({ where: { id: v.charterPartyId }, select: { status: true } })
      : null;
    const cps = linked
      ? []
      : await db.charterParty.findMany({
          where: { vesselId: v.vesselId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'] } },
          select: {
            id: true,
            reference: true,
            vesselId: true,
            charterer: true,
            laycanFrom: true,
            laycanTo: true,
            status: true,
            voyages: { select: { id: true } },
          },
        });
    const candidates = charterPartyCandidates(
      v,
      cps.map((c) => ({ ...c, linkedVoyageIds: c.voyages.map((x) => x.id) })),
    );
    const check = checkCharterPartyRequirement(linked, candidates);
    if (check.ok) return;
    if (check.code === 'CP_CANCELLED') {
      throw Errors.business('La Charter Party rattachée est annulée ou remplacée : rattacher la CP en vigueur');
    }
    const visible = can(ctx, 'charter_party.view');
    throw Errors.business(
      'Une Charter Party existe pour ce voyage : la rattacher avant de quitter le brouillon (CDC §7.2)',
      visible ? { candidates: candidates.map((c) => ({ id: c.id, reference: c.reference, status: c.status })) } : undefined,
    );
  }

  /** CP rattachable : visible (charter_party.view + périmètre), même navire, non annulée. */
  async loadLinkableCp(ctx: AuthContext, cpId: string, voyage: { id: string | null; vesselId: string }, db: Db = this.prisma) {
    if (!can(ctx, 'charter_party.view')) throw Errors.forbidden('Permission requise : charter_party.view', { permission: 'charter_party.view' });
    const cp = await db.charterParty.findUnique({
      where: { id: cpId },
      select: { id: true, reference: true, vesselId: true, status: true, voyages: { select: { id: true, vesselId: true } } },
    });
    if (!cp) throw Errors.notFound('Charter Party');
    if (!canAccessCp(ctx, cp)) throw Errors.scopeDenied();
    if (cp.vesselId && cp.vesselId !== voyage.vesselId) throw Errors.validation('La Charter Party concerne un autre navire');
    if (cp.status === 'CANCELLED' || cp.status === 'SUPERSEDED') throw Errors.business('Charter Party annulée ou remplacée : rattachement impossible');
    return cp;
  }

  // ---------------------------------------------------------------------------
  // Timeline maritime (CDC §7.1)
  // ---------------------------------------------------------------------------

  async timeline(ctx: AuthContext, id: string, loaded?: Voyage) {
    const v = loaded ?? (await this.getAccessible(ctx, id));
    const canCp = can(ctx, 'charter_party.view') && !!v.charterPartyId;
    const canNoon = can(ctx, 'noon.view');
    const [audits, ports, instructions, notices, nors, tasks, cpVersions, noons] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { module: 'voyages', entityType: 'voyage', entityId: id, result: 'SUCCESS' },
        orderBy: { occurredAt: 'asc' },
        take: 500,
        select: { id: true, occurredAt: true, action: true, actorLabel: true, after: true, metadata: true },
      }),
      this.prisma.voyagePort.findMany({ where: { voyageId: id }, orderBy: { sequence: 'asc' } }),
      this.prisma.voyageInstruction.findMany({
        where: { voyageId: id, status: { not: 'DRAFT' } },
        include: { acks: { select: { userId: true, ackAt: true } } },
      }),
      this.prisma.voyageNotice.findMany({ where: { voyageId: id, OR: [{ validatedAt: { not: null } }, { sentAt: { not: null } }] } }),
      this.prisma.norRecord.findMany({ where: { voyageId: id }, include: { port: { select: { portName: true } } } }),
      this.prisma.voyageTask.findMany({ where: { voyageId: id, status: 'DONE', completedAt: { not: null } } }),
      canCp
        ? this.prisma.cpVersion.findMany({
            where: { charterPartyId: v.charterPartyId!, status: 'APPROVED' },
            include: { charterParty: { select: { reference: true } } },
          })
        : Promise.resolve([]),
      canNoon
        ? this.prisma.noonReport.findMany({
            where: { voyageId: id, submittedAt: { not: null } },
            select: { id: true, reportType: true, reportDateUtc: true, submittedAt: true, submittedById: true, acknowledgedAt: true, acknowledgedById: true },
          })
        : Promise.resolve([]),
    ]);
    const labels = await userLabels(this.prisma, [
      ...instructions.flatMap((i) => [i.issuedById, ...i.acks.map((a) => a.userId)]),
      ...notices.flatMap((n) => [n.validatedById, n.sentById]),
      ...nors.map((n) => n.createdById),
      ...tasks.map((t) => t.completedById),
      ...cpVersions.map((c) => c.decidedById),
      ...noons.flatMap((n) => [n.submittedById, n.acknowledgedById]),
    ]);
    const who = (uid: string | null | undefined) => (uid ? labels.get(uid) ?? null : null);

    const events: (TimelineEvent | null)[] = [];
    const hasCreatedAudit = audits.some((a) => a.action === 'voyage.created');
    if (!hasCreatedAudit) events.push({ at: v.createdAt, kind: 'voyage.created', label: 'Voyage créé', entityType: 'voyage', entityId: v.id });
    for (const a of audits) {
      if (a.action === 'voyage.updated') {
        const changed = ((a.metadata as { scheduleChanged?: string[] } | null)?.scheduleChanged ?? []).map((f) => f.toUpperCase());
        if (!changed.length) continue; // la timeline ne reprend que les changements de planning
        // Détail limité aux champs de planning (jamais le rattachement CP ou d'autres champs modifiés)
        events.push({ at: a.occurredAt, kind: 'voyage.schedule_updated', label: `Planning mis à jour (${changed.join(', ')})`, actor: a.actorLabel, entityType: 'voyage', entityId: `${v.id}:${a.id}`, details: pickScheduleDetails(a.after) });
        continue;
      }
      const label = VOYAGE_AUDIT_LABELS[a.action];
      if (!label) continue;
      if (a.action === 'voyage.charter_party_linked' && !can(ctx, 'charter_party.view')) continue;
      const reason = (a.metadata as { reason?: string; comment?: string } | null) ?? null;
      events.push({ at: a.occurredAt, kind: a.action, label, actor: a.actorLabel, entityType: 'voyage', entityId: `${v.id}:${a.id}`, details: reason?.reason || reason?.comment ? { comment: reason.reason ?? reason.comment } : undefined });
    }
    if (v.closedAt && !audits.some((a) => a.action === 'voyage.completed' || a.action === 'voyage.cancelled')) {
      events.push({ at: v.closedAt, kind: v.status === 'CANCELLED' ? 'voyage.cancelled' : 'voyage.completed', label: v.status === 'CANCELLED' ? 'Voyage annulé' : 'Voyage clôturé', entityType: 'voyage', entityId: v.id });
    }
    for (const i of instructions) {
      if (i.issuedAt) events.push({ at: i.issuedAt, kind: 'instruction.issued', label: `Instructions de voyage v${i.versionNo} émises`, actor: who(i.issuedById), entityType: 'voyage_instruction', entityId: i.id });
      for (const ack of i.acks) {
        events.push({ at: ack.ackAt, kind: 'instruction.acknowledged', label: `Instructions v${i.versionNo} : accusé de lecture`, actor: who(ack.userId), entityType: 'voyage_instruction', entityId: `${i.id}:${ack.userId}` });
      }
    }
    for (const c of cpVersions) {
      if (c.decidedAt) events.push({ at: c.decidedAt, kind: 'charter_party.approved', label: `Charter Party ${c.charterParty.reference} v${c.versionNo} (${c.kind}) approuvée`, actor: who(c.decidedById), entityType: 'cp_version', entityId: c.id });
    }
    for (const n of notices) {
      const label = n.scheduleLabel ?? n.kind;
      if (n.validatedAt) events.push({ at: n.validatedAt, kind: 'notice.validated', label: `Notice validée : ${label}`, actor: who(n.validatedById), entityType: 'voyage_notice', entityId: n.id });
      if (n.sentAt) events.push({ at: n.sentAt, kind: 'notice.sent', label: `Notice marquée envoyée : ${label}`, actor: who(n.sentById), entityType: 'voyage_notice', entityId: n.id });
    }
    for (const p of ports) {
      if (p.ata) events.push({ at: p.ata, kind: 'port.arrival', label: `Arrivée à ${p.portName} (${p.type})`, entityType: 'voyage_port', entityId: p.id });
      if (p.atd) events.push({ at: p.atd, kind: 'port.departure', label: `Départ de ${p.portName} (${p.type})`, entityType: 'voyage_port', entityId: p.id });
    }
    for (const n of nors) {
      events.push({ at: n.tenderedAt, kind: 'nor.tendered', label: `NOR remise — ${n.port.portName}`, actor: who(n.createdById), entityType: 'nor_record', entityId: n.id });
      if (n.acceptedAt) events.push({ at: n.acceptedAt, kind: 'nor.accepted', label: `NOR acceptée — ${n.port.portName}${n.acceptedBy ? ` par ${n.acceptedBy}` : ''}`, entityType: 'nor_record', entityId: n.id });
    }
    for (const t of tasks) {
      events.push({ at: t.completedAt!, kind: 'task.done', label: `Tâche réalisée : ${t.title}`, actor: who(t.completedById), entityType: 'voyage_task', entityId: t.id });
    }
    for (const n of noons) {
      const d = n.reportDateUtc.toISOString().slice(0, 16).replace('T', ' ');
      events.push({ at: n.submittedAt!, kind: 'noon.submitted', label: `${n.reportType} report du ${d} UTC soumis`, actor: who(n.submittedById), entityType: 'noon_report', entityId: n.id });
      if (n.acknowledgedAt) events.push({ at: n.acknowledgedAt, kind: 'noon.acknowledged', label: `${n.reportType} report du ${d} UTC : accusé de réception`, actor: who(n.acknowledgedById), entityType: 'noon_report', entityId: n.id });
    }
    const timeline = sortTimeline(events);
    return can(ctx, 'charter_party.view') ? timeline : stripCharterPartyReferences(timeline);
  }

  // ---------------------------------------------------------------------------
  // Contrôle informatif des certificats (CDC §7.4)
  // ---------------------------------------------------------------------------

  async certificateCheck(ctx: AuthContext, id: string) {
    const v = await this.getAccessible(ctx, id);
    if (!can(ctx, 'certificates.view')) {
      return { available: false, reason: 'Permission certificates.view requise pour ce contrôle', disclaimer: CERTIFICATE_CHECK_DISCLAIMER };
    }
    const ports = await this.prisma.voyagePort.findMany({ where: { voyageId: id }, select: { eta: true, etd: true, ata: true, atd: true } });
    const end = voyageEndDate(v, ports);
    const endBasis = v.ata ? 'ATA' : v.eta ? 'ETA' : ports.some((p) => p.eta || p.etd || p.ata || p.atd) ? 'PORT_SCHEDULE' : v.laycanTo ? 'LAYCAN_TO' : null;
    const certs = await this.prisma.certificate.findMany({
      where: { vesselId: v.vesselId, subjectKind: 'VESSEL', archivedAt: null, currentRevisionId: { not: null } },
      select: {
        id: true,
        currentNumber: true,
        currentExpiryKind: true,
        currentExpiryOn: true,
        documentMissing: true,
        type: { select: { code: true, name: true, category: true } },
      },
      orderBy: { currentExpiryOn: 'asc' },
    });
    const today = new Date();
    const items = certs
      .map((c) => ({ ...c, flag: flagCertificate({ expiryKind: c.currentExpiryKind, expiryOn: c.currentExpiryOn }, end, today) }))
      .filter((c) => c.flag !== null);
    return {
      available: true,
      informativeOnly: true,
      disclaimer: CERTIFICATE_CHECK_DISCLAIMER,
      voyageEnd: end,
      voyageEndBasis: endBasis,
      checkedCertificates: certs.length,
      counts: {
        expired: items.filter((i) => i.flag === 'EXPIRED').length,
        expiringBeforeVoyageEnd: items.filter((i) => i.flag === 'EXPIRES_BEFORE_VOYAGE_END').length,
        expiryUnknown: items.filter((i) => i.flag === 'EXPIRY_UNKNOWN').length,
      },
      items,
    };
  }
}
