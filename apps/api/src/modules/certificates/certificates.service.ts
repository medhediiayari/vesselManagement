import { Injectable } from '@nestjs/common';
import { Prisma, StoredFile } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can } from '../access/auth-context';
import { VISIBLE_ASSIGNMENT_STATUSES } from '../access/member-access';
import { SettingsService } from '../settings/settings.service';
import { CertificateAccessService, actorOf } from './certificate-access.service';
import {
  CertificateValidity,
  DATA_REQUEST_KINDS,
  OPEN_REQUEST_STATUSES,
  VALIDITY_LABELS,
  addDays,
  attachmentRights,
  computeValidity,
  daysToExpiry,
  isOpenRequest,
  isoDay,
  requestStatusLabel,
  subjectLabel,
  utcDay,
} from './certificate.logic';
import { ComplianceQuery, ListCertificatesQuery, ListRequestsQuery } from './certificates.dto';

const OPEN = [...OPEN_REQUEST_STATUSES];
const DATA_KINDS = [...DATA_REQUEST_KINDS];

const LIST_INCLUDE = {
  type: { select: { id: true, code: true, name: true, category: true, subjectKind: true, requiresDocument: true, allowMultiple: true } },
  vessel: { select: { id: true, code: true, name: true } },
  member: { select: { id: true, amcRef: true, firstName: true, lastName: true, rank: true } },
  currentRevision: {
    select: { id: true, revisionNo: true, issuer: true, authority: true, issuedOn: true, validFrom: true, approvedAt: true },
  },
  requests: {
    where: { status: { in: OPEN } },
    select: { id: true, kind: true, status: true, version: true, requestedById: true, submittedAt: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
  renewalTasks: {
    where: { status: { not: 'COMPLETED' } },
    select: { id: true, ownerId: true, dueOn: true, status: true, createdAt: true },
  },
} satisfies Prisma.CertificateInclude;

const DETAIL_INCLUDE = {
  type: {
    include: {
      validators: { select: { principalType: true, principalId: true } },
      reminderPolicy: { select: { id: true, name: true, thresholdsDays: true, frequency: true } },
    },
  },
  vessel: { select: { id: true, code: true, name: true, imoNumber: true } },
  member: { select: { id: true, amcRef: true, firstName: true, lastName: true, rank: true } },
  revisions: { orderBy: { revisionNo: 'desc' } },
  requests: {
    orderBy: { createdAt: 'desc' },
    include: { versions: { orderBy: { versionNo: 'desc' } }, decisions: { orderBy: { createdAt: 'asc' } } },
  },
  attachments: { orderBy: { uploadedAt: 'desc' } },
  renewalTasks: { orderBy: { createdAt: 'desc' } },
  comments: { orderBy: { createdAt: 'desc' }, take: 200 },
} satisfies Prisma.CertificateInclude;

type ListRow = Prisma.CertificateGetPayload<{ include: typeof LIST_INCLUDE }>;

export interface ComplianceCounts {
  total: number;
  valid: number;
  expiringSoon: number;
  expiringWithin30Days: number;
  expiringWithin60Days: number;
  expiringWithin90Days: number;
  expired: number;
  expiryUnknown: number;
  unlimited: number;
  renewalInProgress: number;
  documentMissing: number;
}

/** Résumé fichier exposé au client : jamais de bucket, de clé objet ni d'URL (CDC §11.1). */
function fileSummary(f: StoredFile | undefined) {
  if (!f) return null;
  return {
    id: f.id,
    originalName: f.originalName,
    kind: f.kind,
    mimeType: f.mimeType,
    extension: f.extension,
    sizeBytes: Number(f.sizeBytes),
    sha256: f.sha256,
    scanStatus: f.scanStatus,
    pageCount: f.pageCount,
  };
}

/**
 * Lecture du moteur Certificats (CDC §4) : explorateur paginé, tableau de conformité
 * transversal, fiche détaillée et boîte des demandes. Toutes les lectures passent par
 * `CertificateAccessService.visibleWhere` (scope navire + ADM-070) : un numéro ou un fichier
 * de certificat n'est jamais exposé hors droits, recherche comprise (CDC §4.6).
 */
@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly certAccess: CertificateAccessService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Explorateur
  // ---------------------------------------------------------------------------

  async list(ctx: AuthContext, q: ListCertificatesQuery) {
    const today = utcDay(new Date());
    const soon = await this.settings.get('certificates.expiringSoonDays');
    const filters = this.listFilters(ctx, q, today, soon);

    const sortField = q.sort === 'expiryOn' ? 'currentExpiryOn' : q.sort;
    const orderBy: Prisma.CertificateOrderByWithRelationInput[] = [
      sortField === 'currentExpiryOn'
        ? { currentExpiryOn: { sort: q.order, nulls: 'last' } }
        : { [sortField]: q.order },
      { id: 'asc' },
    ];
    // Pagination par clé (keyset) : le curseur Prisma ne gère pas les tris sur colonne nullable
    const keyset = q.cursor ? await this.keysetAfter(ctx, q.cursor, sortField, q.order) : null;
    const where: Prisma.CertificateWhereInput = { AND: [...filters, ...(keyset ? [keyset] : [])] };

    const [rows, total] = await Promise.all([
      this.prisma.certificate.findMany({ where, include: LIST_INCLUDE, orderBy, take: q.limit + 1 }),
      this.prisma.certificate.count({ where: { AND: filters } }),
    ]);
    const page = toPage(rows, q, total);
    const users = await this.userNames([
      ...page.items.map((r) => r.renewalOwnerId),
      ...page.items.flatMap((r) => r.requests.map((x) => x.requestedById)),
    ]);
    return { ...page, expiringSoonDays: soon, items: page.items.map((r) => this.presentListItem(r, today, soon, users)) };
  }

  private listFilters(ctx: AuthContext, q: ListCertificatesQuery, today: Date, soon: number): Prisma.CertificateWhereInput[] {
    const and: Prisma.CertificateWhereInput[] = [this.certAccess.visibleWhere(ctx)];
    and.push(q.archived ? { archivedAt: { not: null } } : { archivedAt: null });
    if (!q.archived && !q.includeAbandoned && q.hasCurrentRevision === undefined) {
      // Coquille sans révision ni demande ouverte (création refusée / annulée) : masquée par défaut
      and.push({
        OR: [
          { currentRevisionId: { not: null } },
          { requests: { some: { status: { in: OPEN }, kind: { in: DATA_KINDS } } } },
        ],
      });
    }
    if (q.subjectKind) and.push({ subjectKind: q.subjectKind });
    if (q.vesselId) {
      this.access.assertVesselAccess(ctx, q.vesselId);
      and.push({ vesselId: q.vesselId });
    }
    if (q.vesselIds?.length) {
      // Sélection multiple du Vessel Switcher : certificats des navires + des marins affectés à ces navires
      for (const id of q.vesselIds) this.access.assertVesselAccess(ctx, id);
      and.push({
        OR: [
          { subjectKind: 'VESSEL', vesselId: { in: q.vesselIds } },
          {
            subjectKind: 'MEMBER',
            member: { crewAssignments: { some: { vesselId: { in: q.vesselIds }, status: { in: [...VISIBLE_ASSIGNMENT_STATUSES] } } } },
          },
        ],
      });
    }
    if (q.renewalOwner === 'me') and.push({ renewalOwnerId: ctx.userId });
    if (q.memberId) and.push({ memberId: q.memberId });
    if (q.crewVesselId) {
      this.access.assertVesselAccess(ctx, q.crewVesselId);
      and.push({
        subjectKind: 'MEMBER',
        member: { crewAssignments: { some: { vesselId: q.crewVesselId, status: { in: [...VISIBLE_ASSIGNMENT_STATUSES] } } } },
      });
    }
    if (q.typeId) and.push({ typeId: q.typeId });
    if (q.category) and.push({ type: { category: q.category } });
    if (q.validity?.length) and.push({ OR: q.validity.map((v) => this.validityWhere(v, today, soon)) });
    if (q.expiringWithinDays !== undefined) {
      and.push({ currentExpiryKind: 'DATED', currentExpiryOn: { gte: today, lte: addDays(today, q.expiringWithinDays) } });
    }
    if (q.renewalStatus) and.push({ renewalStatus: q.renewalStatus });
    if (q.documentMissing === true) {
      // Aligné sur le compteur de conformité : seuls les types exigeant un document sont « manquants »
      and.push({ documentMissing: true, currentRevisionId: { not: null }, type: { requiresDocument: true } });
    } else if (q.documentMissing === false) {
      and.push({ currentRevisionId: { not: null }, OR: [{ documentMissing: false }, { type: { requiresDocument: false } }] });
    }
    if (q.pendingApproval !== undefined) {
      const some = { requests: { some: { status: 'PENDING_APPROVAL' as const } } };
      and.push(q.pendingApproval ? some : { NOT: some });
    }
    if (q.hasCurrentRevision !== undefined) and.push({ currentRevisionId: q.hasCurrentRevision ? { not: null } : null });
    if (q.search) {
      const s = q.search;
      and.push({
        OR: [
          { currentNumber: { contains: s, mode: 'insensitive' } },
          { type: { name: { contains: s, mode: 'insensitive' } } },
          { type: { code: { contains: s.toUpperCase() } } },
          { vessel: { name: { contains: s, mode: 'insensitive' } } },
          { member: { lastName: { contains: s, mode: 'insensitive' } } },
          { member: { firstName: { contains: s, mode: 'insensitive' } } },
          { member: { amcRef: { contains: s, mode: 'insensitive' } } },
        ],
      });
    }
    return and;
  }

  /** Traduction SQL de computeValidity (même convention : la date d'expiration est le dernier jour valide). */
  private validityWhere(v: CertificateValidity, today: Date, soon: number): Prisma.CertificateWhereInput {
    switch (v) {
      case 'EXPIRED':
        return { currentExpiryKind: 'DATED', currentExpiryOn: { lt: today } };
      case 'EXPIRING_SOON':
        return { currentExpiryKind: 'DATED', currentExpiryOn: { gte: today, lte: addDays(today, soon) } };
      case 'VALID':
        return { currentExpiryKind: 'DATED', currentExpiryOn: { gt: addDays(today, soon) } };
      case 'UNLIMITED':
        return { currentExpiryKind: 'UNLIMITED' };
      case 'EXPIRY_UNKNOWN':
        return { currentExpiryKind: 'UNKNOWN' };
    }
  }

  /**
   * Le certificat-curseur est chargé À TRAVERS le filtre de visibilité : un curseur hors droits est
   * rejeté comme un curseur inexistant (pas d'oracle sur la date d'expiration d'un certificat invisible).
   */
  private async keysetAfter(
    ctx: AuthContext,
    cursorId: string,
    field: 'currentExpiryOn' | 'updatedAt' | 'createdAt',
    order: 'asc' | 'desc',
  ): Promise<Prisma.CertificateWhereInput> {
    const c = await this.prisma.certificate.findFirst({
      where: { AND: [{ id: cursorId }, this.certAccess.visibleWhere(ctx)] },
      select: { id: true, currentExpiryOn: true, updatedAt: true, createdAt: true },
    });
    if (!c) throw Errors.validation('Curseur de pagination invalide');
    const value = c[field];
    const cmp = order === 'asc' ? 'gt' : 'lt';
    if (value === null) return { [field]: null, id: { gt: c.id } };
    const ors: Prisma.CertificateWhereInput[] = [{ [field]: { [cmp]: value } }, { [field]: value, id: { gt: c.id } }];
    if (field === 'currentExpiryOn') ors.push({ currentExpiryOn: null }); // NULLS LAST
    return { OR: ors };
  }

  private presentListItem(r: ListRow, today: Date, soon: number, users: Map<string, string>) {
    const validity = r.currentRevisionId && r.currentExpiryKind ? computeValidity(r.currentExpiryKind, r.currentExpiryOn, today, soon) : null;
    const openData = r.requests.find((x) => x.kind !== 'ATTACHMENT') ?? null;
    const openAttachment = r.requests.find((x) => x.kind === 'ATTACHMENT') ?? null;
    const task = r.renewalTasks[0] ?? null;
    const presentRequest = (x: ListRow['requests'][number] | null) =>
      x ? { ...x, statusLabel: requestStatusLabel(x.status), requestedBy: { id: x.requestedById, displayName: users.get(x.requestedById) ?? null } } : null;
    return {
      id: r.id,
      subjectKind: r.subjectKind,
      vesselId: r.vesselId,
      memberId: r.memberId,
      subject: { label: subjectLabel(r), vessel: r.vessel, member: r.member },
      type: r.type,
      hasCurrentRevision: !!r.currentRevisionId,
      currentNumber: r.currentNumber,
      currentExpiryKind: r.currentExpiryKind,
      currentExpiryOn: r.currentExpiryOn,
      validity,
      validityLabel: validity ? VALIDITY_LABELS[validity] : null,
      daysToExpiry: daysToExpiry(r.currentExpiryKind, r.currentExpiryOn, today),
      currentRevision: r.currentRevision,
      documentMissing: r.documentMissing,
      documentRequired: r.type.requiresDocument,
      renewal: {
        status: r.renewalStatus,
        owner: r.renewalOwnerId ? { id: r.renewalOwnerId, displayName: users.get(r.renewalOwnerId) ?? null } : null,
        dueOn: task?.dueOn ?? null,
      },
      openRequest: presentRequest(openData),
      pendingAttachmentRequest: presentRequest(openAttachment),
      archivedAt: r.archivedAt,
      archiveReason: r.archiveReason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Tableau de conformité transversal (CDC §4.5, §9)
  // ---------------------------------------------------------------------------

  /**
   * Vues dashboard : expirés, échéances 30/60/90 j, renouvellements en cours, pièces manquantes,
   * dates inconnues, approbations en attente et tâches assignées. Avec `vesselId` : certificats du
   * navire + certificats des marins affectés (PLANNED / ONBOARD) à ce navire.
   */
  async compliance(ctx: AuthContext, q: ComplianceQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const today = utcDay(new Date());
    const soon = await this.settings.get('certificates.expiringSoonDays');
    const visible = this.certAccess.visibleWhere(ctx);

    const subjectWhere = (kind: 'VESSEL' | 'MEMBER'): Prisma.CertificateWhereInput => ({
      AND: [
        visible,
        { subjectKind: kind, archivedAt: null },
        kind === 'VESSEL' && q.vesselId ? { vesselId: q.vesselId } : {},
        kind === 'MEMBER' && q.vesselId
          ? { member: { crewAssignments: { some: { vesselId: q.vesselId, status: { in: [...VISIBLE_ASSIGNMENT_STATUSES] } } } } }
          : {},
      ],
    });
    const kinds = (q.subjectKind ? [q.subjectKind] : (['VESSEL', 'MEMBER'] as const)).filter(
      (k) => k === 'VESSEL' || this.certAccess.canSeeMemberCertificates(ctx),
    );

    const subjects: Record<string, ComplianceCounts | null> = { VESSEL: null, MEMBER: null };
    for (const k of kinds) subjects[k] = await this.countsFor(subjectWhere(k), today, soon);

    const scopeWhere: Prisma.CertificateWhereInput = { OR: kinds.map((k) => subjectWhere(k)) };
    const certScope = kinds.length ? scopeWhere : { id: { in: [] } };
    const [pendingApprovals, pendingForMe, myOpenRequests, myRenewalTasks] = await Promise.all([
      this.prisma.certificateApprovalRequest.count({ where: { status: 'PENDING_APPROVAL', certificate: certScope } }),
      this.prisma.certificateApprovalRequest.count({
        where: { AND: [this.certAccess.approvableRequestsWhere(ctx), { certificate: certScope }] },
      }),
      this.prisma.certificateApprovalRequest.count({
        where: { requestedById: ctx.userId, status: { in: ['DRAFT', 'RETURNED'] }, certificate: certScope },
      }),
      this.prisma.certificateRenewalTask.count({
        where: { ownerId: ctx.userId, status: { not: 'COMPLETED' }, certificate: certScope },
      }),
    ]);

    const totals = Object.values(subjects).reduce<ComplianceCounts | null>((acc, c) => {
      if (!c) return acc;
      if (!acc) return { ...c };
      for (const key of Object.keys(c) as (keyof ComplianceCounts)[]) acc[key] += c[key];
      return acc;
    }, null);

    return {
      asOf: isoDay(today),
      expiringSoonDays: soon,
      vesselId: q.vesselId ?? null,
      totals,
      subjects,
      approvals: { pending: pendingApprovals, awaitingMyDecision: pendingForMe, myRequestsToComplete: myOpenRequests },
      tasks: { myRenewalTasks },
    };
  }

  private async countsFor(base: Prisma.CertificateWhereInput, today: Date, soon: number): Promise<ComplianceCounts> {
    const w = (extra: Prisma.CertificateWhereInput) => ({ AND: [base, { currentRevisionId: { not: null } }, extra] });
    const dated = (lte: Date) => w({ currentExpiryKind: 'DATED', currentExpiryOn: { gte: today, lte } });
    const [total, valid, expiringSoon, e30, e60, e90, expired, unknown, unlimited, renewal, missing] = await Promise.all([
      this.prisma.certificate.count({ where: w({}) }),
      this.prisma.certificate.count({ where: w(this.validityWhere('VALID', today, soon)) }),
      this.prisma.certificate.count({ where: w(this.validityWhere('EXPIRING_SOON', today, soon)) }),
      this.prisma.certificate.count({ where: dated(addDays(today, 30)) }),
      this.prisma.certificate.count({ where: dated(addDays(today, 60)) }),
      this.prisma.certificate.count({ where: dated(addDays(today, 90)) }),
      this.prisma.certificate.count({ where: w(this.validityWhere('EXPIRED', today, soon)) }),
      this.prisma.certificate.count({ where: w({ currentExpiryKind: 'UNKNOWN' }) }),
      this.prisma.certificate.count({ where: w({ currentExpiryKind: 'UNLIMITED' }) }),
      // IN_PROGRESS ne masque jamais EXPIRED : compteur indépendant (CDC §4.3)
      this.prisma.certificate.count({ where: w({ renewalStatus: 'IN_PROGRESS' }) }),
      this.prisma.certificate.count({ where: w({ documentMissing: true, type: { requiresDocument: true } }) }),
    ]);
    return {
      total,
      valid,
      expiringSoon,
      expiringWithin30Days: e30,
      expiringWithin60Days: e60,
      expiringWithin90Days: e90,
      expired,
      expiryUnknown: unknown,
      unlimited,
      renewalInProgress: renewal,
      documentMissing: missing,
    };
  }

  // ---------------------------------------------------------------------------
  // Fiche détaillée
  // ---------------------------------------------------------------------------

  async get(ctx: AuthContext, id: string) {
    const cert = await this.prisma.certificate.findUnique({ where: { id }, include: DETAIL_INCLUDE });
    if (!cert) throw Errors.notFound('Certificat');
    await this.certAccess.assertVisible(ctx, cert);

    const today = utcDay(new Date());
    const soon = await this.settings.get('certificates.expiringSoonDays');
    const actor = actorOf(ctx);
    const validators = cert.type.validators;

    // Brouillon d'autrui : contenu (versions, décisions) et pièces proposées restent privés à son
    // demandeur ; seule son existence est exposée, car il bloque renouvellement / correction.
    const isOthersDraft = (r: { status: string; requestedById: string }) => r.status === 'DRAFT' && r.requestedById !== ctx.userId;
    const visibleRequests = cert.requests.filter((r) => !isOthersDraft(r));
    const privateDraftFiles = new Set(
      cert.requests.filter(isOthersDraft).flatMap((r) => r.versions.map((v) => v.fileId).filter((x): x is string => !!x)),
    );
    const visibleAttachments = cert.attachments.filter((a) => !(privateDraftFiles.has(a.fileId) && a.uploadedById !== ctx.userId));
    const openData = cert.requests.find((r) => isOpenRequest(r.status) && r.kind !== 'ATTACHMENT') ?? null;
    const openAttachment = cert.requests.find((r) => isOpenRequest(r.status) && r.kind === 'ATTACHMENT') ?? null;

    const files = new Map(
      (await this.prisma.storedFile.findMany({ where: { id: { in: visibleAttachments.map((a) => a.fileId) } } })).map((f) => [f.id, f]),
    );
    const users = await this.userNames([
      cert.createdById,
      cert.renewalOwnerId,
      cert.archivedById,
      openData?.requestedById,
      openAttachment?.requestedById,
      ...cert.revisions.map((r) => r.approvedById),
      ...visibleRequests.flatMap((r) => [r.requestedById, r.decidedById, ...r.versions.map((v) => v.createdById), ...r.decisions.map((d) => d.deciderId)]),
      ...visibleAttachments.flatMap((a) => [a.uploadedById, a.approvedById]),
      ...cert.renewalTasks.flatMap((t) => [t.ownerId, t.createdById]),
      ...cert.comments.map((c) => c.authorId),
    ]);
    const who = (userId: string | null) => (userId ? { id: userId, displayName: users.get(userId) ?? null } : null);

    // Pièce proposée -> demande (pour réserver l'accès des pièces en attente au demandeur / validateurs)
    const fileRequest = new Map<string, { kind: (typeof cert.requests)[number]['kind']; requestedById: string; status: (typeof cert.requests)[number]['status'] }>();
    for (const r of cert.requests) {
      for (const v of r.versions) if (v.fileId) fileRequest.set(v.fileId, { kind: r.kind, requestedById: r.requestedById, status: r.status });
    }
    const uploaderOf = (attachmentId: string | null) => cert.attachments.find((a) => a.id === attachmentId)?.uploadedById;

    const revisionNo = new Map(cert.revisions.map((r) => [r.id, r.revisionNo]));
    const attachments = visibleAttachments.map((a) => {
      const file = files.get(a.fileId);
      const rights = attachmentRights(actor, {
        status: a.status,
        isCurrentOfficial: a.status === 'OFFICIAL' && !!a.revisionId && a.revisionId === cert.currentRevisionId,
        uploadedById: a.uploadedById,
        request: fileRequest.get(a.fileId) ?? null,
        validators,
        previewable: file?.kind === 'PDF' || file?.kind === 'IMAGE',
      });
      return {
        id: a.id,
        status: a.status,
        revisionId: a.revisionId,
        revisionNo: a.revisionId ? (revisionNo.get(a.revisionId) ?? null) : null,
        isCurrentOfficial: a.status === 'OFFICIAL' && a.revisionId === cert.currentRevisionId,
        uploadedBy: who(a.uploadedById),
        uploadedAt: a.uploadedAt,
        approvedBy: who(a.approvedById),
        approvedAt: a.approvedAt,
        archivedAt: a.archivedAt,
        // Métadonnées d'une pièce en attente réservées aux parties du workflow (CERT-05)
        file: rights.preview || rights.download ? fileSummary(file) : null,
        access: { preview: rights.preview, download: rights.download, scope: rights.scope },
      };
    });
    const official = attachments.find((a) => a.isCurrentOfficial) ?? null;
    const current = cert.revisions.find((r) => r.id === cert.currentRevisionId) ?? null;

    const requests = visibleRequests.map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      statusLabel: requestStatusLabel(r.status),
      version: r.version,
      requestedBy: who(r.requestedById),
      submittedAt: r.submittedAt,
      decidedBy: who(r.decidedById),
      decidedAt: r.decidedAt,
      decisionComment: r.decisionComment,
      cancelReason: r.cancelReason,
      duplicatedFromId: r.duplicatedFromId,
      attachmentId: r.attachmentId,
      escalatedAt: r.escalatedAt,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      canDecide:
        r.status === 'PENDING_APPROVAL' &&
        this.certAccess.isEligible(ctx, { kind: r.kind, requestedById: r.requestedById, uploadedById: uploaderOf(r.attachmentId) }, validators),
      versions: r.versions.map((v) => ({ ...v, createdBy: who(v.createdById) })),
      decisions: r.decisions.map((d) => ({ ...d, decider: who(d.deciderId) })),
    }));

    const active = !cert.archivedAt;
    const canCancel = (r: (typeof cert.requests)[number] | null) =>
      !!r &&
      (r.requestedById === ctx.userId ||
        this.certAccess.isSupervisor(ctx, { kind: r.kind, requestedById: r.requestedById, uploadedById: uploaderOf(r.attachmentId) }, validators));
    // Résumé sans données : suffit à expliquer le blocage et à proposer l'annulation de supervision
    const openSummary = (r: (typeof cert.requests)[number] | null) =>
      r
        ? {
            id: r.id,
            kind: r.kind,
            status: r.status,
            statusLabel: requestStatusLabel(r.status),
            version: r.version,
            requestedBy: who(r.requestedById),
            submittedAt: r.submittedAt,
            createdAt: r.createdAt,
            isMine: r.requestedById === ctx.userId,
            canCancel: canCancel(r),
          }
        : null;
    const validity = current ? computeValidity(current.expiryKind, current.expiryOn, today, soon) : null;
    const activeTask = cert.renewalTasks.find((t) => t.status !== 'COMPLETED') ?? null;

    return {
      id: cert.id,
      subjectKind: cert.subjectKind,
      vesselId: cert.vesselId,
      memberId: cert.memberId,
      subject: { label: subjectLabel(cert), vessel: cert.vessel, member: cert.member },
      type: {
        id: cert.type.id,
        code: cert.type.code,
        name: cert.type.name,
        category: cert.type.category,
        subjectKind: cert.type.subjectKind,
        requiresDocument: cert.type.requiresDocument,
        allowMultiple: cert.type.allowMultiple,
        defaultValidityMonths: cert.type.defaultValidityMonths,
        isActive: cert.type.isActive,
        reminderPolicy: cert.type.reminderPolicy,
        validatorsConfigured: validators.length,
      },
      validity,
      validityLabel: validity ? VALIDITY_LABELS[validity] : null,
      daysToExpiry: current ? daysToExpiry(current.expiryKind, current.expiryOn, today) : null,
      expiringSoonDays: soon,
      documentMissing: cert.documentMissing,
      documentRequired: cert.type.requiresDocument,
      currentRevision: current ? { ...current, approvedBy: who(current.approvedById), officialAttachment: official } : null,
      archivedRevisions: cert.revisions
        .filter((r) => r.id !== cert.currentRevisionId)
        .map((r) => ({ ...r, approvedBy: who(r.approvedById) })),
      requests,
      openRequestId: openData?.id ?? null,
      pendingAttachmentRequestId: openAttachment?.id ?? null,
      openRequest: openSummary(openData),
      pendingAttachmentRequest: openSummary(openAttachment),
      attachments,
      renewal: {
        status: cert.renewalStatus,
        owner: who(cert.renewalOwnerId),
        dueOn: activeTask?.dueOn ?? null,
        activeTask: activeTask ? { ...activeTask, owner: who(activeTask.ownerId), createdBy: who(activeTask.createdById) } : null,
        history: cert.renewalTasks.map((t) => ({ ...t, owner: who(t.ownerId), createdBy: who(t.createdById) })),
      },
      comments: cert.comments.map((c) => ({ ...c, author: who(c.authorId) })),
      createdBy: who(cert.createdById),
      createdAt: cert.createdAt,
      updatedAt: cert.updatedAt,
      archivedAt: cert.archivedAt,
      archivedBy: who(cert.archivedById),
      archiveReason: cert.archiveReason,
      // Indications pour l'interface — le serveur revérifie tout à chaque commande
      permissions: {
        isRequester: !!openData && openData.requestedById === ctx.userId,
        canApprove: requests.some((r) => r.canDecide && r.kind !== 'ATTACHMENT'),
        canApproveAttachment: requests.some((r) => r.canDecide && r.kind === 'ATTACHMENT'),
        canEditRequest: !!openData && active && openData.requestedById === ctx.userId && can(ctx, 'certificates.edit'),
        canSubmit:
          !!openData && active && openData.requestedById === ctx.userId && openData.status !== 'PENDING_APPROVAL' && can(ctx, 'certificates.submit'),
        canCancelRequest: canCancel(openData),
        canSubmitAttachment:
          !!openAttachment &&
          active &&
          openAttachment.requestedById === ctx.userId &&
          openAttachment.status !== 'PENDING_APPROVAL' &&
          can(ctx, 'certificates.submit'),
        canCancelAttachmentRequest: canCancel(openAttachment),
        canRenew: active && !!current && !openData && can(ctx, 'certificates.create'),
        canCorrect: active && !!current && !openData && (can(ctx, 'certificates.create') || can(ctx, 'certificates.edit')),
        canAddAttachment: active && !!current && !openAttachment && (can(ctx, 'certificates.create') || can(ctx, 'certificates.edit')),
        canManageRenewal: active && can(ctx, 'certificates.renewal.manage'),
        canArchive: active && can(ctx, 'certificates.archive'),
        canPreviewCurrent: !!official?.access.preview,
        canDownloadCurrent: !!official?.access.download,
        canDownloadArchived: can(ctx, 'certificates.download_archived'),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // Boîte des demandes (mes demandes / à approuver)
  // ---------------------------------------------------------------------------

  async listRequests(ctx: AuthContext, q: ListRequestsQuery) {
    const and: Prisma.CertificateApprovalRequestWhereInput[] = [
      { certificate: this.certAccess.visibleWhere(ctx) },
      // Un brouillon reste personnel tant qu'il n'est pas soumis
      { OR: [{ status: { not: 'DRAFT' } }, { requestedById: ctx.userId }] },
    ];
    // Curseur : doit désigner une demande que l'appelant peut voir (sinon rejet, comme un curseur inexistant)
    if (q.cursor) {
      const visibleCursor = await this.prisma.certificateApprovalRequest.count({ where: { AND: [{ id: q.cursor }, ...and] } });
      if (!visibleCursor) throw Errors.validation('Curseur de pagination invalide');
    }
    if (q.toApprove) and.push(this.certAccess.approvableRequestsWhere(ctx));
    if (q.mine) and.push({ requestedById: ctx.userId });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.kind) and.push({ kind: q.kind });
    if (q.certificateId) and.push({ certificateId: q.certificateId });
    const where: Prisma.CertificateApprovalRequestWhereInput = { AND: and };

    const [rows, total] = await Promise.all([
      this.prisma.certificateApprovalRequest.findMany({
        where,
        include: {
          certificate: {
            select: {
              id: true,
              subjectKind: true,
              vesselId: true,
              memberId: true,
              currentNumber: true,
              type: { select: { id: true, code: true, name: true, validators: { select: { principalType: true, principalId: true } } } },
              vessel: { select: { id: true, code: true, name: true } },
              member: { select: { id: true, amcRef: true, firstName: true, lastName: true } },
            },
          },
          attachment: { select: { id: true, uploadedById: true, status: true } },
          versions: { orderBy: { versionNo: 'desc' }, take: 1 },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        ...cursorArgs(q),
      }),
      this.prisma.certificateApprovalRequest.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    const users = await this.userNames(page.items.flatMap((r) => [r.requestedById, r.decidedById]));
    return {
      ...page,
      items: page.items.map((r) => {
        const { validators, ...type } = r.certificate.type;
        const latest = r.versions[0] ?? null;
        return {
          id: r.id,
          kind: r.kind,
          status: r.status,
          statusLabel: requestStatusLabel(r.status),
          version: r.version,
          submittedAt: r.submittedAt,
          decidedAt: r.decidedAt,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
          escalatedAt: r.escalatedAt,
          requestedBy: { id: r.requestedById, displayName: users.get(r.requestedById) ?? null },
          decidedBy: r.decidedById ? { id: r.decidedById, displayName: users.get(r.decidedById) ?? null } : null,
          certificate: {
            id: r.certificate.id,
            subjectKind: r.certificate.subjectKind,
            subject: { label: subjectLabel(r.certificate), vessel: r.certificate.vessel, member: r.certificate.member },
            type,
            currentNumber: r.certificate.currentNumber,
          },
          proposed: latest
            ? {
                versionNo: latest.versionNo,
                certificateNumber: latest.certificateNumber,
                expiryKind: latest.expiryKind,
                expiryOn: latest.expiryOn,
                hasFile: !!latest.fileId,
              }
            : null,
          canDecide:
            r.status === 'PENDING_APPROVAL' &&
            this.certAccess.isEligible(ctx, { kind: r.kind, requestedById: r.requestedById, uploadedById: r.attachment?.uploadedById }, validators),
        };
      }),
    };
  }

  private async userNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
    return new Map(rows.map((u) => [u.id, u.displayName]));
  }
}
