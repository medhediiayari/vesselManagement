import { Injectable, OnModuleInit } from '@nestjs/common';
import { NoonReport, NoonReportRevision, NoonStatus, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { Db, PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { PdfService } from '../documents/pdf.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService, toFileDto } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { renderNoonPdf } from './noon-pdf';
import {
  AcknowledgeNoonReportDto,
  AddNoonAttachmentDto,
  ArchiveNoonReportDto,
  CorrectNoonReportDto,
  CreateNoonReportDto,
  ListNoonReportsQuery,
  NoonChanges,
  RequestCorrectionDto,
  UpdateNoonReportDto,
} from './noon.dto';
import {
  NOON_EDITABLE_STATUSES,
  NOON_FIELDS,
  NOON_TRANSITIONS,
  NoonIssue,
  NoonSnapshot,
  NoonValues,
  PreviousReport,
  ReportSlot,
  buildNoonSnapshot,
  canTransitionNoon,
  diffNoonSnapshots,
  flattenSnapshot,
  localDayKey,
  localTimeLabel,
  noonPlausibilityWarnings,
  reportDateBeforeVoyage,
  sameReportSlot,
  validateForSubmission,
  validateNoonConsistency,
  validateNoonRanges,
} from './noon.logic';

export const OWNER_NOON_REVISION_PDF = 'noon_report_revision_pdf';
export const OWNER_NOON_ATTACHMENT = 'noon_report_attachment';

/** Un Noon Report n'est saisi que sur un voyage planifié ou en cours. */
const REPORTABLE_VOYAGE_STATUSES = ['PLANNED', 'ACTIVE'];
/** Audit FLT-05 : plus aucun rapport sur un navire vendu ou inactif. */
const CLOSED_VESSEL_STATUSES = ['SOLD', 'INACTIVE'];
/** Statuts d'un rapport transmis (référence pour les contrôles de vraisemblance). */
const SENT_STATUSES: NoonStatus[] = ['SUBMITTED', 'ACKNOWLEDGED', 'CORRECTION_REQUESTED', 'CORRECTED'];
const VOYAGE_BOUNDS_SELECT = { id: true, vesselId: true, status: true, reference: true, createdAt: true, etd: true, atd: true, laycanFrom: true } as const;
const TX_OPTIONS = { timeout: 30_000 };

function pickNoonValues(r: Record<string, unknown>): NoonValues {
  const out: NoonValues = {};
  for (const f of NOON_FIELDS) out[f] = r[f] as NoonValues[string];
  return out;
}

/**
 * Noon Reports (CDC §8, V1 §11) : formulaire AMC en 7 sections rattaché à un navire ET un voyage,
 * autosave sécurisé (verrou optimiste), soumission figée en révision immuable + PDF, accusé
 * de réception Ops, demande de correction, correction en NOUVELLE révision (audit old/new).
 */
@Injectable()
export class NoonService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly pdf: PdfService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    // PDF de révision : consultation noon.view ; téléchargement / export noon.export (droit distinct)
    this.registry.register(OWNER_NOON_REVISION_PDF, async (ctx, file, mode) => {
      this.access.assertCan(ctx, 'noon.view');
      if (mode === 'download') this.access.assertCan(ctx, 'noon.export');
      const rev = await this.prisma.noonReportRevision.findUnique({
        where: { id: file.ownerId! },
        include: { noonReport: { select: { id: true, vesselId: true, reportType: true, reportDateUtc: true, vessel: { select: { code: true } } } } },
      });
      if (!rev) throw Errors.notFound('Fichier');
      this.access.assertVesselAccess(ctx, rev.noonReport.vesselId);
      const stamp = rev.noonReport.reportDateUtc.toISOString().slice(0, 16).replace(/[-:T]/g, '');
      return {
        module: 'noon',
        entityType: 'noon_report',
        entityId: rev.noonReport.id,
        vesselId: rev.noonReport.vesselId,
        downloadName: `${rev.noonReport.vessel.code}-${rev.noonReport.reportType}-${stamp}-rev${rev.revisionNo}.pdf`,
      };
    });
    this.registry.register(OWNER_NOON_ATTACHMENT, async (ctx, file) => {
      this.access.assertCan(ctx, 'noon.view');
      const att = await this.prisma.noonReportAttachment.findUnique({
        where: { id: file.ownerId! },
        select: { noonReportId: true, noonReport: { select: { vesselId: true } } },
      });
      if (!att) throw Errors.notFound('Fichier');
      this.access.assertVesselAccess(ctx, att.noonReport.vesselId);
      return { module: 'noon', entityType: 'noon_report_attachment', entityId: file.ownerId!, vesselId: att.noonReport.vesselId };
    });
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async getAccessible(ctx: AuthContext, id: string, db: Db = this.prisma): Promise<NoonReport> {
    const r = await db.noonReport.findUnique({ where: { id } });
    if (!r) throw Errors.notFound('Noon Report');
    this.access.assertVesselAccess(ctx, r.vesselId);
    return r;
  }

  async list(ctx: AuthContext, q: ListNoonReportsQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const where: Prisma.NoonReportWhereInput = {
      AND: [
        vesselWhere(ctx) as Prisma.NoonReportWhereInput,
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.voyageId ? { voyageId: q.voyageId } : {},
        q.status ? { status: q.status } : {},
        q.reportType ? { reportType: q.reportType } : {},
        q.from ? { reportDateUtc: { gte: q.from } } : {},
        q.to ? { reportDateUtc: { lt: new Date(q.to.getTime() + 86_400_000) } } : {},
        // Brouillons oubliés (audit FLT-25) : non modifiés depuis N jours
        q.staleDraftDays ? { status: 'DRAFT' as const, updatedAt: { lt: new Date(Date.now() - q.staleDraftDays * 86_400_000) } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.noonReport.findMany({
        where,
        orderBy: [{ reportDateUtc: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
          vesselId: true,
          voyageId: true,
          reportType: true,
          reportDateUtc: true,
          utcOffsetMinutes: true,
          reference: true,
          masterName: true,
          latitude: true,
          longitude: true,
          courseDeg: true,
          speedKnots: true,
          distanceRemainingNm: true,
          nextPort: true,
          etaNextPort: true,
          status: true,
          currentRevisionNo: true,
          submittedAt: true,
          acknowledgedAt: true,
          lockVersion: true,
          createdAt: true,
          updatedAt: true,
          vessel: { select: { id: true, code: true, name: true } },
          voyage: { select: { id: true, reference: true, status: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.noonReport.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    // Brouillons : nombre de points bloquant la soumission, pour relancer l'auteur (audit FLT-25)
    const draftIds = page.items.filter((r) => r.status === 'DRAFT').map((r) => r.id);
    const drafts = draftIds.length ? await this.prisma.noonReport.findMany({ where: { id: { in: draftIds } } }) : [];
    const now = new Date();
    const pending = new Map(drafts.map((d) => [d.id, validateForSubmission(pickNoonValues(d), now).length]));
    return {
      ...page,
      items: page.items.map((r) => ({
        ...r,
        reportDateLocal: localTimeLabel(r.reportDateUtc, r.utcOffsetMinutes),
        pendingIssues: r.status === 'DRAFT' ? pending.get(r.id) ?? 0 : null,
      })),
    };
  }

  async get(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    const r = await this.prisma.noonReport.findUniqueOrThrow({
      where: { id },
      include: {
        vessel: { select: { id: true, code: true, name: true, imoNumber: true, timezone: true } },
        voyage: { select: { id: true, reference: true, status: true } },
        revisions: { orderBy: { revisionNo: 'asc' }, select: { id: true, revisionNo: true, reason: true, pdfFileId: true, createdById: true, createdAt: true } },
        attachments: { orderBy: { createdAt: 'asc' } },
      },
    });
    const [labels, files] = await Promise.all([
      this.labels([r.createdById, r.submittedById, r.acknowledgedById, ...r.revisions.map((x) => x.createdById), ...r.attachments.map((a) => a.uploadedById)]),
      this.prisma.storedFile.findMany({ where: { id: { in: r.attachments.map((a) => a.fileId) } } }),
    ]);
    // Audit FLT-18 : brouillon d'un voyage clôturé figé (ni modification ni soumission) ; suppression proposée
    const voyageOpen = REPORTABLE_VOYAGE_STATUSES.includes(r.voyage.status);
    const editable = NOON_EDITABLE_STATUSES.includes(r.status) && (r.status !== 'DRAFT' || voyageOpen);
    const previous = editable ? await this.previousSent(r) : null;
    return {
      ...r,
      reportDateLocal: localTimeLabel(r.reportDateUtc, r.utcOffsetMinutes),
      createdBy: labels.get(r.createdById) ?? null,
      submittedBy: r.submittedById ? labels.get(r.submittedById) ?? null : null,
      acknowledgedBy: r.acknowledgedById ? labels.get(r.acknowledgedById) ?? null : null,
      revisions: r.revisions.map((x) => ({ ...x, createdBy: labels.get(x.createdById) ?? null })),
      attachments: r.attachments.map((a) => {
        const f = files.find((x) => x.id === a.fileId);
        return { ...a, uploadedBy: labels.get(a.uploadedById) ?? null, file: f ? toFileDto(f) : null };
      }),
      /** Contrôle préalable à la soumission (preview) : champs minimaux manquants / incohérences */
      submissionCheck: editable ? validateForSubmission(pickNoonValues(r), new Date()) : [],
      /** Avertissements non bloquants (vraisemblance, audit FLT-11) */
      submissionWarnings: editable ? noonPlausibilityWarnings(pickNoonValues(r), previous) : [],
      voyageOpen,
      allowedTransitions: NOON_TRANSITIONS[r.status],
      permissions: {
        edit: editable && (r.status === 'DRAFT' ? can(ctx, 'noon.create') : can(ctx, 'noon.create') || can(ctx, 'noon.correct')),
        submit: r.status === 'DRAFT' && voyageOpen && can(ctx, 'noon.submit'),
        discard: r.status === 'DRAFT' && r.currentRevisionNo === 0 && (r.createdById === ctx.userId || can(ctx, 'noon.correct')),
        acknowledge:
          (r.status === 'SUBMITTED' || r.status === 'CORRECTED') &&
          can(ctx, 'noon.approve') &&
          r.submittedById !== ctx.userId &&
          r.revisions[r.revisions.length - 1]?.createdById !== ctx.userId,
        requestCorrection: canTransitionNoon(r.status, 'CORRECTION_REQUESTED') && can(ctx, 'noon.approve'),
        correct: r.status !== 'DRAFT' && canTransitionNoon(r.status, 'CORRECTED') && can(ctx, 'noon.correct'),
        export: r.currentRevisionNo > 0 && can(ctx, 'noon.export'),
      },
    };
  }

  private async labels(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map<string, string>();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
    return new Map(users.map((u) => [u.id, u.displayName]));
  }

  // ---------------------------------------------------------------------------
  // Brouillon : création + autosave
  // ---------------------------------------------------------------------------

  /** Un rapport appartient toujours à un navire ET à un voyage de ce navire (CDC §8.1). */
  async create(ctx: AuthContext, dto: CreateNoonReportDto) {
    const { voyageId, vesselId, ...fields } = dto;
    const voyage = await this.prisma.voyage.findUnique({ where: { id: voyageId }, select: VOYAGE_BOUNDS_SELECT });
    if (!voyage) throw Errors.notFound('Voyage');
    this.access.assertVesselAccess(ctx, voyage.vesselId);
    if (vesselId && vesselId !== voyage.vesselId) throw Errors.validation('Le voyage n’appartient pas à ce navire');
    if (!REPORTABLE_VOYAGE_STATUSES.includes(voyage.status)) {
      throw Errors.business(`Voyage ${voyage.reference} ${voyage.status} : Noon Report possible uniquement sur un voyage planifié ou en cours`);
    }
    await this.assertVesselReporting(voyage.vesselId);
    const bound = reportDateBeforeVoyage(fields.reportDateUtc, voyage);
    this.assertValid([...validateNoonRanges(fields as NoonValues), ...validateNoonConsistency(fields as NoonValues, new Date()), ...(bound ? [bound] : [])]);
    await this.assertUniqueSlot(voyageId, { reportType: fields.reportType, reportDateUtc: fields.reportDateUtc, utcOffsetMinutes: fields.utcOffsetMinutes });

    return this.prisma.$transaction(async (tx) => {
      const r = await tx.noonReport.create({
        data: { ...fields, vesselId: voyage.vesselId, voyageId, status: 'DRAFT', createdById: ctx.userId } as Prisma.NoonReportUncheckedCreateInput,
      });
      await this.audit.record(
        ctx,
        { action: 'noon.created', module: 'noon', entityType: 'noon_report', entityId: r.id, vesselId: r.vesselId, after: r, metadata: { voyageId } },
        tx,
      );
      return { ...r, reportDateLocal: localTimeLabel(r.reportDateUtc, r.utcOffsetMinutes) };
    });
  }

  /** Autosave (DRAFT / CORRECTION_REQUESTED) : verrou optimiste expectedVersion -> 409 si périmé. */
  async update(ctx: AuthContext, id: string, dto: UpdateNoonReportDto) {
    const { expectedVersion, ...fields } = dto;
    const before = await this.getAccessible(ctx, id);
    if (!NOON_EDITABLE_STATUSES.includes(before.status)) {
      throw Errors.invalidState(`Noon Report ${before.status} : valeurs figées — utiliser une correction (nouvelle révision)`, { status: before.status });
    }
    if (before.status === 'DRAFT' && !can(ctx, 'noon.create')) throw Errors.forbidden('Permission requise : noon.create', { permission: 'noon.create' });
    if (before.lockVersion !== expectedVersion) throw Errors.staleVersion(undefined, { currentVersion: before.lockVersion });
    const voyage = await this.prisma.voyage.findUniqueOrThrow({ where: { id: before.voyageId }, select: VOYAGE_BOUNDS_SELECT });
    if (before.status === 'DRAFT' && !REPORTABLE_VOYAGE_STATUSES.includes(voyage.status)) {
      // Audit FLT-18 : une modification ne pourrait jamais être soumise
      throw Errors.invalidState(`Voyage ${voyage.reference} clôturé ou annulé : brouillon figé, à supprimer`, { voyageStatus: voyage.status });
    }
    const merged = { ...pickNoonValues(before), ...(fields as NoonValues) };
    const bound = fields.reportDateUtc ? reportDateBeforeVoyage(fields.reportDateUtc, voyage) : null;
    this.assertValid([...validateNoonRanges(fields as NoonValues), ...validateNoonConsistency(merged, new Date()), ...(bound ? [bound] : [])]);
    if (this.slotChanged(before, fields)) {
      await this.assertUniqueSlot(before.voyageId, this.slotOf(before, fields), id);
    }
    return this.prisma.$transaction(async (tx) => {
      await this.updateLocked(tx, before, expectedVersion, fields as Prisma.NoonReportUncheckedUpdateManyInput);
      const after = await tx.noonReport.findUniqueOrThrow({ where: { id } });
      const diff = diffFields(pickNoonValues(before) as never, pickNoonValues(after) as never);
      await this.audit.record(
        ctx,
        { action: 'noon.updated', module: 'noon', entityType: 'noon_report', entityId: id, vesselId: after.vesselId, ...diff, metadata: { status: after.status, autosave: true } },
        tx,
      );
      return { ...after, reportDateLocal: localTimeLabel(after.reportDateUtc, after.utcOffsetMinutes) };
    });
  }

  // ---------------------------------------------------------------------------
  // Soumission (révision figée + PDF + notification Ops)
  // ---------------------------------------------------------------------------

  async submit(ctx: AuthContext, id: string, expectedVersion: number) {
    const r = await this.getAccessible(ctx, id);
    if (r.status !== 'DRAFT') throw Errors.alreadyProcessed('Noon Report déjà soumis');
    if (r.lockVersion !== expectedVersion) throw Errors.staleVersion(undefined, { currentVersion: r.lockVersion });
    const voyage = await this.prisma.voyage.findUniqueOrThrow({ where: { id: r.voyageId }, select: { status: true, reference: true } });
    if (!REPORTABLE_VOYAGE_STATUSES.includes(voyage.status)) {
      throw Errors.business(`Voyage ${voyage.reference} ${voyage.status} : soumission impossible`);
    }
    await this.assertVesselReporting(r.vesselId);
    this.assertValid(validateForSubmission(pickNoonValues(r), new Date()), 'Noon Report incomplet ou invalide : soumission refusée');

    const revisionNo = r.currentRevisionNo + 1;
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.updateLocked(tx, r, expectedVersion, {
        status: 'SUBMITTED',
        submittedById: ctx.userId,
        submittedAt: now,
        currentRevisionNo: revisionNo,
        correctionRequest: null,
      });
      const snapshot = await this.snapshot(tx, r, pickNoonValues(r), revisionNo, now, ctx);
      const revision = await this.freezeRevision(tx, ctx, r, snapshot, null);
      await this.audit.record(
        ctx,
        {
          action: 'noon.submitted',
          module: 'noon',
          entityType: 'noon_report',
          entityId: id,
          vesselId: r.vesselId,
          before: { status: 'DRAFT' },
          after: { status: 'SUBMITTED', revisionNo, pdfFileId: revision.pdfFileId },
          metadata: { voyageId: r.voyageId, revisionId: revision.id },
        },
        tx,
      );
      await this.notifyOps(ctx, r, snapshot, 'noon.submitted', `Noon Report soumis — ${snapshot.vessel.name} ${snapshot.reportDateLocal}`, tx);
      return revision;
    }, TX_OPTIONS);
    return { ...(await this.prisma.noonReport.findUniqueOrThrow({ where: { id } })), revision: result };
  }

  // ---------------------------------------------------------------------------
  // Revue Ops : accusé de réception, demande de correction, archivage
  // ---------------------------------------------------------------------------

  /** Accusé de réception Ops (pas de seconde signature formelle obligatoire, CDC §8.3). */
  async acknowledge(ctx: AuthContext, id: string, dto: AcknowledgeNoonReportDto) {
    const r = await this.getAccessible(ctx, id);
    if (r.status === 'ACKNOWLEDGED') throw Errors.alreadyProcessed('Noon Report déjà accusé');
    this.assertTransition(r.status, 'ACKNOWLEDGED');
    // Ni l'auteur de la soumission, ni l'auteur de la révision courante (correcteur) ne peut accuser réception
    const current = await this.prisma.noonReportRevision.findUnique({
      where: { noonReportId_revisionNo: { noonReportId: id, revisionNo: r.currentRevisionNo } },
      select: { createdById: true },
    });
    if (r.submittedById === ctx.userId || current?.createdById === ctx.userId) throw Errors.selfApproval();
    const expected = dto.expectedVersion ?? r.lockVersion;
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await this.updateLocked(tx, r, expected, { status: 'ACKNOWLEDGED', acknowledgedById: ctx.userId, acknowledgedAt: now });
      await this.audit.record(
        ctx,
        {
          action: 'noon.acknowledged',
          module: 'noon',
          entityType: 'noon_report',
          entityId: id,
          vesselId: r.vesselId,
          before: { status: r.status },
          after: { status: 'ACKNOWLEDGED', acknowledgedAt: now },
          metadata: { revisionNo: r.currentRevisionNo, readReceipt: dto.readReceipt, comment: dto.comment },
        },
        tx,
      );
      await this.notifications.resolveForEntity('noon_report', id, 'noon.', tx);
      if (dto.readReceipt && r.submittedById) {
        await this.notifications.notify(
          {
            userIds: [r.submittedById],
            type: 'noon.read_receipt',
            title: `Noon Report du ${localTimeLabel(r.reportDateUtc, r.utcOffsetMinutes)} : lu par ${ctx.displayName}`,
            body: dto.comment,
            module: 'noon',
            entityType: 'noon_report',
            entityId: id,
            vesselId: r.vesselId,
            link: `/noon-reports/${id}`,
            dedupeKey: `noon:${id}:read-receipt:${r.currentRevisionNo}`,
            requiredPermission: 'noon.view',
          },
          tx,
        );
      }
      return tx.noonReport.findUniqueOrThrow({ where: { id } });
    });
  }

  async requestCorrection(ctx: AuthContext, id: string, dto: RequestCorrectionDto) {
    const r = await this.getAccessible(ctx, id);
    if (r.status === 'CORRECTION_REQUESTED') throw Errors.alreadyProcessed('Correction déjà demandée');
    this.assertTransition(r.status, 'CORRECTION_REQUESTED');
    const expected = dto.expectedVersion ?? r.lockVersion;
    return this.prisma.$transaction(async (tx) => {
      await this.updateLocked(tx, r, expected, { status: 'CORRECTION_REQUESTED', correctionRequest: dto.comment });
      await this.audit.record(
        ctx,
        {
          action: 'noon.correction_requested',
          module: 'noon',
          entityType: 'noon_report',
          entityId: id,
          vesselId: r.vesselId,
          before: { status: r.status },
          after: { status: 'CORRECTION_REQUESTED' },
          metadata: { comment: dto.comment, revisionNo: r.currentRevisionNo },
        },
        tx,
      );
      const correctors = await this.access.usersWithPermission('noon.correct', r.vesselId, tx);
      await this.notifications.notify(
        {
          userIds: [...correctors, ...(r.submittedById ? [r.submittedById] : [])],
          excludeUserIds: [ctx.userId],
          type: 'noon.correction_requested',
          title: `Correction demandée — Noon Report du ${localTimeLabel(r.reportDateUtc, r.utcOffsetMinutes)}`,
          body: dto.comment,
          module: 'noon',
          entityType: 'noon_report',
          entityId: id,
          vesselId: r.vesselId,
          link: `/noon-reports/${id}`,
          priority: 'HIGH',
          dedupeKey: `noon:${id}:correction-request:${r.lockVersion}`,
          email: true,
          requiredPermission: 'noon.correct',
        },
        tx,
      );
      return tx.noonReport.findUniqueOrThrow({ where: { id } });
    });
  }

  async archive(ctx: AuthContext, id: string, dto: ArchiveNoonReportDto) {
    const r = await this.getAccessible(ctx, id);
    if (r.status === 'ARCHIVED') throw Errors.alreadyProcessed('Noon Report déjà archivé');
    this.assertTransition(r.status, 'ARCHIVED');
    return this.prisma.$transaction(async (tx) => {
      await this.updateLocked(tx, r, dto.expectedVersion ?? r.lockVersion, { status: 'ARCHIVED' });
      await this.audit.record(
        ctx,
        { action: 'noon.archived', module: 'noon', entityType: 'noon_report', entityId: id, vesselId: r.vesselId, before: { status: r.status }, after: { status: 'ARCHIVED' }, metadata: { reason: dto.reason } },
        tx,
      );
      return tx.noonReport.findUniqueOrThrow({ where: { id } });
    });
  }

  // ---------------------------------------------------------------------------
  // Correction : nouvelle révision, l'originale reste intacte (CDC §8.3)
  // ---------------------------------------------------------------------------

  async correct(ctx: AuthContext, id: string, dto: CorrectNoonReportDto) {
    const r = await this.getAccessible(ctx, id);
    if (r.status === 'DRAFT') throw Errors.invalidState('Brouillon : modifier puis soumettre (aucune révision à corriger)');
    this.assertTransition(r.status, 'CORRECTED');
    if (r.lockVersion !== dto.expectedVersion) throw Errors.staleVersion(undefined, { currentVersion: r.lockVersion });
    const changes: NoonChanges = dto.changes ?? {};
    const values = { ...pickNoonValues(r), ...(changes as NoonValues) };
    const voyage = changes.reportDateUtc ? await this.prisma.voyage.findUniqueOrThrow({ where: { id: r.voyageId }, select: VOYAGE_BOUNDS_SELECT }) : null;
    const bound = voyage && changes.reportDateUtc ? reportDateBeforeVoyage(changes.reportDateUtc, voyage) : null;
    this.assertValid(
      [...validateForSubmission(values, new Date()), ...(bound ? [bound] : [])],
      'Correction invalide : champs minimaux manquants ou valeurs hors plage',
    );
    if (this.slotChanged(r, changes)) {
      await this.assertUniqueSlot(r.voyageId, this.slotOf(r, changes), id);
    }
    const previous = await this.prisma.noonReportRevision.findFirst({ where: { noonReportId: id }, orderBy: { revisionNo: 'desc' } });
    const prevSnapshot = (previous?.data as unknown as NoonSnapshot | undefined) ?? null;

    const revisionNo = r.currentRevisionNo + 1;
    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await this.snapshot(tx, r, values, revisionNo, now, ctx);
      const changeList = diffNoonSnapshots(prevSnapshot, snapshot);
      if (!changeList.length) {
        throw Errors.business(`Aucune modification par rapport à la révision ${previous?.revisionNo ?? r.currentRevisionNo}`);
      }
      await this.updateLocked(tx, r, dto.expectedVersion, {
        ...(changes as Prisma.NoonReportUncheckedUpdateManyInput),
        status: 'CORRECTED',
        currentRevisionNo: revisionNo,
        correctionRequest: null,
      });
      const revision = await this.freezeRevision(tx, ctx, r, snapshot, dto.reason);
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const c of changeList) {
        before[c.field] = c.before;
        after[c.field] = c.after;
      }
      await this.audit.record(
        ctx,
        {
          action: 'noon.corrected',
          module: 'noon',
          entityType: 'noon_report',
          entityId: id,
          vesselId: r.vesselId,
          before,
          after,
          metadata: {
            fromStatus: r.status,
            reason: dto.reason,
            previousRevisionNo: previous?.revisionNo ?? null,
            revisionNo,
            revisionId: revision.id,
            changedFields: changeList.map((c) => `${c.section}.${c.field}`),
            correctionRequest: r.correctionRequest,
          },
        },
        tx,
      );
      await this.notifyOps(ctx, r, snapshot, 'noon.corrected', `Noon Report corrigé (révision ${revisionNo}) — ${snapshot.vessel.name} ${snapshot.reportDateLocal}`, tx, dto.reason);
      const updated = await tx.noonReport.findUniqueOrThrow({ where: { id } });
      return { ...updated, revision, changes: changeList };
    }, TX_OPTIONS);
  }

  // ---------------------------------------------------------------------------
  // Révisions, PDF, pièces jointes
  // ---------------------------------------------------------------------------

  async listRevisions(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    const revisions = await this.prisma.noonReportRevision.findMany({ where: { noonReportId: id }, orderBy: { revisionNo: 'asc' } });
    const labels = await this.labels(revisions.map((r) => r.createdById));
    return revisions.map((rev, i) => {
      const data = rev.data as unknown as NoonSnapshot;
      const prev = i > 0 ? (revisions[i - 1].data as unknown as NoonSnapshot) : null;
      return {
        ...rev,
        createdBy: labels.get(rev.createdById) ?? null,
        values: flattenSnapshot(data),
        changes: prev ? diffNoonSnapshots(prev, data) : [],
      };
    });
  }

  /**
   * Suppression d'un brouillon JAMAIS soumis (aucune révision figée) : par son auteur ou un correcteur
   * habilité du navire. Les pièces jointes sont marquées supprimées (blobs conservés : pas de suppression
   * physique) ; l'action est auditée. Un rapport soumis ne se supprime jamais (archivage seulement).
   */
  async discardDraft(ctx: AuthContext, id: string) {
    const r = await this.getAccessible(ctx, id);
    if (r.status !== 'DRAFT' || r.currentRevisionNo > 0) {
      throw Errors.invalidState('Seul un brouillon jamais soumis peut être supprimé (utiliser l’archivage sinon)');
    }
    if (r.createdById !== ctx.userId && !can(ctx, 'noon.correct')) {
      throw Errors.forbidden('Seul l’auteur du brouillon (ou un correcteur habilité) peut le supprimer');
    }
    await this.prisma.$transaction(async (tx) => {
      const atts = await tx.noonReportAttachment.findMany({ where: { noonReportId: id }, select: { fileId: true } });
      if (atts.length) {
        await tx.storedFile.updateMany({ where: { id: { in: atts.map((a) => a.fileId) } }, data: { deletedAt: new Date() } });
        await tx.noonReportAttachment.deleteMany({ where: { noonReportId: id } });
      }
      const res = await tx.noonReport.deleteMany({ where: { id, status: 'DRAFT', currentRevisionNo: 0, lockVersion: r.lockVersion } });
      if (res.count !== 1) throw Errors.staleVersion();
      await this.audit.record(
        ctx,
        {
          action: 'noon.draft_discarded',
          module: 'noon',
          entityType: 'noon_report',
          entityId: id,
          vesselId: r.vesselId,
          before: pickNoonValues(r) as never,
          metadata: { voyageId: r.voyageId, attachments: atts.length },
        },
        tx,
      );
    });
  }

  /** Lien éphémère vers le PDF d'une révision (dernière par défaut) ; régénéré depuis le snapshot si absent. */
  async pdfLink(ctx: AuthContext, id: string, revisionNo: number | undefined, mode: 'preview' | 'download') {
    if (mode === 'download') this.access.assertCan(ctx, 'noon.export');
    const r = await this.getAccessible(ctx, id);
    const rev = await this.prisma.noonReportRevision.findFirst({
      where: { noonReportId: id, ...(revisionNo ? { revisionNo } : {}) },
      orderBy: { revisionNo: 'desc' },
    });
    if (!rev) throw revisionNo ? Errors.notFound(`Révision ${revisionNo}`) : Errors.invalidState('Aucune révision soumise : pas de PDF');
    let fileId = rev.pdfFileId;
    if (!fileId) {
      fileId = await this.prisma.$transaction(async (tx) => (await this.attachPdf(tx, ctx, r, rev)).id, TX_OPTIONS);
    }
    return { revisionNo: rev.revisionNo, ...(await this.files.issueLink(ctx, fileId, mode)) };
  }

  async listAttachments(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    const atts = await this.prisma.noonReportAttachment.findMany({ where: { noonReportId: id }, orderBy: { createdAt: 'asc' } });
    const [files, labels] = await Promise.all([
      this.prisma.storedFile.findMany({ where: { id: { in: atts.map((a) => a.fileId) } } }),
      this.labels(atts.map((a) => a.uploadedById)),
    ]);
    return atts.map((a) => {
      const f = files.find((x) => x.id === a.fileId);
      return { ...a, uploadedBy: labels.get(a.uploadedById) ?? null, file: f ? toFileDto(f) : null };
    });
  }

  /** Pièce jointe (contexte NOON_REPORT) : brouillon / correction demandée, ou par noon.correct ensuite. */
  async addAttachment(ctx: AuthContext, id: string, dto: AddNoonAttachmentDto) {
    const r = await this.getAccessible(ctx, id);
    if (r.status === 'ARCHIVED') throw Errors.invalidState('Noon Report archivé');
    const editable = NOON_EDITABLE_STATUSES.includes(r.status);
    if (!(editable && (can(ctx, 'noon.create') || can(ctx, 'noon.correct'))) && !can(ctx, 'noon.correct')) {
      throw Errors.forbidden('Après soumission, l’ajout de pièce jointe requiert noon.correct', { permission: 'noon.correct' });
    }
    return this.prisma.$transaction(async (tx) => {
      const att = await tx.noonReportAttachment.create({ data: { noonReportId: id, fileId: dto.fileId, uploadedById: ctx.userId } });
      await this.files.attach(ctx, dto.fileId, { type: OWNER_NOON_ATTACHMENT, id: att.id, contexts: ['NOON_REPORT'], vesselId: r.vesselId }, tx);
      await this.audit.record(
        ctx,
        { action: 'noon.attachment_added', module: 'noon', entityType: 'noon_report', entityId: id, vesselId: r.vesselId, after: { attachmentId: att.id, fileId: dto.fileId }, metadata: { status: r.status } },
        tx,
      );
      return att;
    });
  }

  // ---------------------------------------------------------------------------
  // Internes
  // ---------------------------------------------------------------------------

  private assertValid(issues: NoonIssue[], message = 'Données du Noon Report invalides') {
    if (issues.length) throw Errors.validation(message, issues);
  }

  private assertTransition(from: NoonStatus, to: NoonStatus) {
    if (!canTransitionNoon(from, to)) {
      throw Errors.invalidState(`Transition ${from} → ${to} interdite`, { from, to, allowed: NOON_TRANSITIONS[from] });
    }
  }

  /**
   * Un seul rapport par voyage et par créneau (audit FLT-07) : même jour local du bord pour
   * NOON / MIDNIGHT (sinon les consommations sont comptées deux fois), même horodatage pour
   * ARRIVAL / DEPARTURE. Un rapport archivé ne bloque que le même horodatage (index unique en base).
   */
  private async assertUniqueSlot(voyageId: string, slot: ReportSlot, excludeId?: string) {
    // Fenêtre de 2 jours de part et d'autre : couvre tous les décalages horaires (-12 h / +14 h)
    const window = 2 * 86_400_000;
    const candidates = await this.prisma.noonReport.findMany({
      where: {
        voyageId,
        reportType: slot.reportType,
        reportDateUtc: { gte: new Date(slot.reportDateUtc.getTime() - window), lte: new Date(slot.reportDateUtc.getTime() + window) },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true, status: true, reportType: true, reportDateUtc: true, utcOffsetMinutes: true },
    });
    const dup = candidates.find(
      (c) => c.reportDateUtc.getTime() === slot.reportDateUtc.getTime() || (c.status !== 'ARCHIVED' && sameReportSlot(c, slot)),
    );
    if (dup) {
      const daily = dup.reportType === 'NOON' || dup.reportType === 'MIDNIGHT';
      throw Errors.duplicate(
        daily
          ? `Un rapport ${dup.reportType} existe déjà pour ce voyage le ${localDayKey(dup.reportDateUtc, dup.utcOffsetMinutes)} (jour local du bord)`
          : 'Un rapport de ce type existe déjà à cette date pour ce voyage',
        { existingId: dup.id },
      );
    }
  }

  private slotChanged(r: NoonReport, f: { reportType?: NoonReport['reportType']; reportDateUtc?: Date; utcOffsetMinutes?: number | null }) {
    return (
      (f.reportType !== undefined && f.reportType !== r.reportType) ||
      (f.reportDateUtc !== undefined && f.reportDateUtc.getTime() !== r.reportDateUtc.getTime()) ||
      (f.utcOffsetMinutes !== undefined && f.utcOffsetMinutes !== r.utcOffsetMinutes)
    );
  }

  private slotOf(r: NoonReport, f: { reportType?: NoonReport['reportType']; reportDateUtc?: Date; utcOffsetMinutes?: number | null }): ReportSlot {
    return {
      reportType: f.reportType ?? r.reportType,
      reportDateUtc: f.reportDateUtc ?? r.reportDateUtc,
      utcOffsetMinutes: f.utcOffsetMinutes !== undefined ? f.utcOffsetMinutes : r.utcOffsetMinutes,
    };
  }

  private async assertVesselReporting(vesselId: string) {
    const vessel = await this.prisma.vessel.findUnique({ where: { id: vesselId }, select: { status: true } });
    if (vessel && CLOSED_VESSEL_STATUSES.includes(vessel.status)) {
      throw Errors.business('Navire vendu ou inactif : aucun Noon Report ne peut être saisi ni soumis');
    }
  }

  /** Dernier rapport transmis avant celui-ci sur le même voyage (référence de vraisemblance). */
  private async previousSent(r: NoonReport): Promise<PreviousReport | null> {
    return this.prisma.noonReport.findFirst({
      where: { voyageId: r.voyageId, id: { not: r.id }, status: { in: SENT_STATUSES }, reportDateUtc: { lt: r.reportDateUtc } },
      orderBy: { reportDateUtc: 'desc' },
      select: { reportDateUtc: true, foRobMt: true, doRobMt: true },
    });
  }

  /** Mise à jour sous verrou optimiste + état attendu ; 409 STALE_VERSION ou ALREADY_PROCESSED. */
  private async updateLocked(tx: Tx, r: NoonReport, expectedVersion: number, data: Prisma.NoonReportUncheckedUpdateManyInput) {
    const res = await tx.noonReport.updateMany({
      where: { id: r.id, lockVersion: expectedVersion, status: r.status },
      data: { ...data, lockVersion: { increment: 1 } },
    });
    if (res.count === 0) {
      const now = await tx.noonReport.findUnique({ where: { id: r.id }, select: { status: true, lockVersion: true } });
      if (now && now.status !== r.status) throw Errors.alreadyProcessed(`Noon Report déjà traité (statut ${now.status})`);
      throw Errors.staleVersion(undefined, { currentVersion: now?.lockVersion });
    }
  }

  private async snapshot(tx: Tx, r: NoonReport, values: NoonValues, revisionNo: number, at: Date, ctx: AuthContext): Promise<NoonSnapshot> {
    // Requêtes séquentielles : client de transaction interactive
    const vessel = await tx.vessel.findUniqueOrThrow({ where: { id: r.vesselId }, select: { id: true, code: true, name: true, imoNumber: true } });
    const voyage = await tx.voyage.findUniqueOrThrow({ where: { id: r.voyageId }, select: { id: true, reference: true } });
    return buildNoonSnapshot(values, { revisionNo, frozenAt: at, author: { id: ctx.userId, displayName: ctx.displayName }, vessel, voyage });
  }

  /** Révision immuable + PDF 7 sections rattaché (seul pdf_file_id est modifiable par trigger). */
  private async freezeRevision(tx: Tx, ctx: AuthContext, r: NoonReport, snapshot: NoonSnapshot, reason: string | null) {
    const revision = await tx.noonReportRevision.create({
      data: { noonReportId: r.id, revisionNo: snapshot.revisionNo, data: snapshot as unknown as Prisma.InputJsonValue, reason, createdById: ctx.userId },
    });
    const file = await this.attachPdf(tx, ctx, r, revision);
    return { ...revision, pdfFileId: file.id };
  }

  private async attachPdf(tx: Tx, ctx: AuthContext, r: NoonReport, rev: NoonReportRevision) {
    const snapshot = rev.data as unknown as NoonSnapshot;
    const buffer = await renderNoonPdf(this.pdf, snapshot, { reason: rev.reason });
    const stamp = r.reportDateUtc.toISOString().slice(0, 16).replace(/[-:T]/g, '');
    const file = await this.files.storeGenerated(
      buffer,
      `${snapshot.vessel.code}-${r.reportType}-${stamp}-rev${rev.revisionNo}.pdf`,
      'PDF',
      'application/pdf',
      'GENERATED',
      r.vesselId,
      ctx.userId,
      { type: OWNER_NOON_REVISION_PDF, id: rev.id },
      tx,
    );
    await tx.noonReportRevision.update({ where: { id: rev.id }, data: { pdfFileId: file.id } });
    return file;
  }

  /** Notification Ops à terre (noon.approve sur le navire) : plateforme + e-mail. */
  private async notifyOps(ctx: AuthContext, r: NoonReport, s: NoonSnapshot, type: string, title: string, tx: Tx, reason?: string) {
    const ops = await this.access.usersWithPermission('noon.approve', r.vesselId, tx);
    const pos = s.sections.positionWeather;
    await this.notifications.notify(
      {
        userIds: ops,
        excludeUserIds: [ctx.userId],
        type,
        title,
        body:
          `Voyage ${s.voyage.reference} — ${s.sections.general.reportType} — révision ${s.revisionNo} par ${ctx.displayName}.` +
          (pos.latitude !== null ? ` Position ${pos.latitude} / ${pos.longitude}.` : '') +
          (reason ? ` Motif : ${reason}` : ''),
        module: 'noon',
        entityType: 'noon_report',
        entityId: r.id,
        vesselId: r.vesselId,
        link: `/noon-reports/${r.id}`,
        dedupeKey: `noon:${r.id}:rev:${s.revisionNo}`,
        email: true,
        requiredPermission: 'noon.approve',
      },
      tx,
    );
  }
}
