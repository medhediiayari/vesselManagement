import { Injectable } from '@nestjs/common';
import { ApprovalDecisionKind, ApprovalStatus, CertificateRequestKind, NotificationPriority, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Errors } from '../../common/errors';
import { Db, PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { type AuthContext, can } from '../access/auth-context';
import { assertMemberVisible } from '../access/member-access';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CertificateAccessService, MEMBER_CERT_VIEW } from './certificate-access.service';
import { OWNER_CERTIFICATE_ATTACHMENT } from './certificate-files.service';
import {
  APPROVAL_NOTIFICATION_PREFIX,
  CertificateData,
  DATA_REQUEST_KINDS,
  DECISION_TARGET,
  DUPLICABLE_REQUEST_STATUSES,
  EMPTY_CERTIFICATE_DATA,
  OPEN_REQUEST_STATUSES,
  REMINDER_NOTIFICATION_PREFIX,
  REMINDER_NOTIFICATION_TYPES,
  REQUEST_KIND_LABELS,
  approvalPermissionFor,
  assertTransition,
  certificateLink,
  decisionBlockedBy,
  decisionRequiresComment,
  isOpenRequest,
  mergeCertificateData,
  pickCertificateData,
  requestStatusLabel,
  subjectLabel,
  validateCertificateData,
} from './certificate.logic';
import {
  AddAttachmentDto,
  AddCommentDto,
  ArchiveCertificateDto,
  CancelRequestDto,
  CorrectionDto,
  CreateCertificateDto,
  DecisionDto,
  DuplicateRequestDto,
  RenewCertificateDto,
  SetRenewalDto,
  SubmitRequestDto,
  UpdateRequestDto,
} from './certificates.dto';

const MODULE = 'certificates' as const;
const OPEN = [...OPEN_REQUEST_STATUSES];
const DATA_KINDS = [...DATA_REQUEST_KINDS];
/** Notifications adressées aux validateurs eux-mêmes (l'escalade vise un rôle distinct). */
const VALIDATOR_NOTIFICATION_TYPES = ['certificate.approval_requested', 'certificate.approval_updated', 'certificate.approval_overdue'];

const CERT_INCLUDE = {
  type: { include: { validators: { select: { principalType: true, principalId: true } } } },
  vessel: { select: { id: true, code: true, name: true } },
  member: { select: { id: true, amcRef: true, firstName: true, lastName: true } },
} satisfies Prisma.CertificateInclude;
type Cert = Prisma.CertificateGetPayload<{ include: typeof CERT_INCLUDE }>;

const REQUEST_INCLUDE = {
  certificate: { include: CERT_INCLUDE },
  attachment: true,
  versions: { orderBy: { versionNo: 'desc' }, take: 1 },
  _count: { select: { decisions: true } },
} satisfies Prisma.CertificateApprovalRequestInclude;
type LoadedRequest = Prisma.CertificateApprovalRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

interface RequestRef {
  id: string;
  certificateId: string;
  kind: CertificateRequestKind;
  status: ApprovalStatus;
  version: number;
  requestedById: string;
  submittedAt: Date | null;
  uploadedById?: string | null;
}

function summary(r: RequestRef) {
  return {
    id: r.id,
    certificateId: r.certificateId,
    kind: r.kind,
    status: r.status,
    statusLabel: requestStatusLabel(r.status),
    version: r.version,
    submittedAt: r.submittedAt,
  };
}

/** Résultat d'une soumission : notification des validateurs ou publication directe. */
type SubmitOutcome = { notifiedValidators: number; warnings: string[]; autoApproved?: boolean } & Record<string, unknown>;

/** Publication directe : la réponse porte le statut APPROVED, pas PENDING_APPROVAL (CRT-10). */
function afterSubmitRef(ref: RequestRef, outcome: SubmitOutcome): RequestRef {
  return outcome.autoApproved ? { ...ref, status: 'APPROVED' } : ref;
}

/**
 * Publication directe sans circuit de validation : `certificates.self_approve` (toute demande de
 * l'auteur) ou `certificates.renewal.self_approve` (renouvellements uniquement).
 */
export function canSelfApprove(ctx: AuthContext, kind: CertificateRequestKind): boolean {
  return can(ctx, 'certificates.self_approve') || (kind === 'RENEWAL' && can(ctx, 'certificates.renewal.self_approve'));
}

const DECISION_LABELS: Record<ApprovalDecisionKind, string> = {
  APPROVE: 'approuvée',
  REJECT: 'refusée',
  RETURN: 'retournée pour correction',
};

/**
 * Commandes du workflow Certificats (CDC §4.4, V1 §7.3) — transitions par commandes, jamais par
 * PATCH status ; chaque commande est transactionnelle, auditée (module « certificates », navire
 * pour un certificat navire) et notifie les acteurs concernés (plateforme + e-mail).
 *
 * Invariants protégés en base (0002_db_hardening) : une seule révision CURRENT, une seule pièce
 * OFFICIAL par révision, une seule demande de données + une seule demande de pièce ouvertes par
 * certificat, un seul suivi de renouvellement actif ; versions / décisions / révisions immuables.
 */
@Injectable()
export class CertificateWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly certAccess: CertificateAccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly notifications: NotificationsService,
  ) {}

  // ===========================================================================
  // Création / renouvellement / correction
  // ===========================================================================

  /**
   * POST /certificates — certificat logique (titulaire + type) + demande CREATE version 1
   * (brouillon, ou soumise si `submit`). Type non multiple : un certificat actif existant impose
   * le renouvellement (409). Sérialisable : deux créations concurrentes ne passent pas toutes deux.
   */
  async create(ctx: AuthContext, dto: CreateCertificateDto) {
    // Publication directe : elle vaut soumission (même règle que renew / submit — CRT-09)
    if (dto.submit && !canSelfApprove(ctx, 'CREATE')) this.access.assertCan(ctx, 'certificates.submit');
    const { subjectKind, vesselId, memberId, typeId, fileId, changeNote, submit, folderId, ...patch } = dto;
    if (folderId) this.access.assertCan(ctx, 'certificates.folders.manage');
    const data = mergeCertificateData(EMPTY_CERTIFICATE_DATA, patch);
    this.checkData(data);

    return this.prisma.serializable(async (tx) => {
      if (folderId && !(await tx.certificateFolder.count({ where: { id: folderId } }))) throw Errors.notFound('Dossier');
      const type = await tx.certificateType.findUnique({ where: { id: typeId } });
      if (!type) throw Errors.notFound('Type de certificat');
      if (!type.isActive) throw Errors.business('Type de certificat désactivé');
      if (type.subjectKind !== subjectKind) {
        throw Errors.validation(`Ce type s'applique aux certificats ${type.subjectKind === 'VESSEL' ? 'navire' : 'Member'}`, [
          { path: 'typeId' },
        ]);
      }
      if (subjectKind === 'VESSEL') {
        if (!(await tx.vessel.count({ where: { id: vesselId! } }))) throw Errors.notFound('Navire');
        this.access.assertVesselAccess(ctx, vesselId);
      } else {
        this.access.assertCan(ctx, MEMBER_CERT_VIEW);
        await assertMemberVisible(tx, ctx, memberId!);
      }
      if (!type.allowMultiple) {
        await this.assertNoActiveCertificate(tx, typeId, { vesselId: vesselId ?? null, memberId: memberId ?? null });
      }

      const created = await tx.certificate.create({
        data: {
          subjectKind,
          vesselId: subjectKind === 'VESSEL' ? vesselId! : null,
          memberId: subjectKind === 'MEMBER' ? memberId! : null,
          typeId,
          folderId: folderId ?? null,
          documentMissing: true,
          createdById: ctx.userId,
        },
      });
      const cert = await tx.certificate.findUniqueOrThrow({ where: { id: created.id }, include: CERT_INCLUDE });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.created',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          after: { subjectKind, vesselId: cert.vesselId, memberId: cert.memberId, typeId, typeCode: type.code, folderId: cert.folderId },
        },
        tx,
      );
      const res = await this.openRequest(ctx, tx, cert, { kind: 'CREATE', data, fileId: fileId ?? null, attachFile: true, changeNote, submit });
      return { certificateId: cert.id, ...res };
    });
  }

  /**
   * POST /certificates/:id/renew — demande RENEWAL. L'ancien certificat reste courant (dates,
   * PDF et alertes) jusqu'à l'approbation du nouveau (ADM-049/050, CERT-02). Le suivi
   * opérationnel passe « en cours » sans toucher à la validité ni aux rappels (ADM-048).
   */
  async renew(ctx: AuthContext, certificateId: string, dto: RenewCertificateDto) {
    // Renouvellement sans approbation : la publication directe vaut soumission
    if (dto.submit && !canSelfApprove(ctx, 'RENEWAL')) this.access.assertCan(ctx, 'certificates.submit');
    return this.prisma.$transaction(async (tx) => {
      const cert = await this.loadCertificate(ctx, certificateId, tx);
      this.assertActive(cert);
      const current = await this.requireCurrentRevision(tx, cert);
      await this.assertNoOpenDataRequest(tx, cert.id);
      const { fileId, changeNote, submit, ...patch } = dto;
      // Identification reprise de la révision courante ; numéro, dates et remarques nouveaux
      const base: CertificateData = {
        ...EMPTY_CERTIFICATE_DATA,
        issuer: current.issuer,
        authority: current.authority,
        country: current.country,
        placeOfIssue: current.placeOfIssue,
      };
      const data = mergeCertificateData(base, patch);
      this.checkData(data);
      const res = await this.openRequest(ctx, tx, cert, { kind: 'RENEWAL', data, fileId: fileId ?? null, attachFile: true, changeNote, submit });
      // Publication directe : l'approbation a déjà clôturé le suivi, ne pas le rouvrir (CRT-01)
      if (!res.autoApproved) await this.ensureRenewalInProgress(ctx, tx, cert);
      return { certificateId: cert.id, ...res };
    });
  }

  /** POST /certificates/:id/corrections — demande CORRECTION (patch motivé de la révision courante). */
  async correct(ctx: AuthContext, certificateId: string, dto: CorrectionDto) {
    if (dto.submit && !canSelfApprove(ctx, 'CORRECTION')) this.access.assertCan(ctx, 'certificates.submit');
    return this.prisma.$transaction(async (tx) => {
      const cert = await this.loadCertificate(ctx, certificateId, tx);
      this.assertActive(cert);
      const current = await this.requireCurrentRevision(tx, cert);
      await this.assertNoOpenDataRequest(tx, cert.id);
      const { fileId, changeNote, submit, ...patch } = dto;
      const data = mergeCertificateData(pickCertificateData(current), patch);
      this.checkData(data);
      if (JSON.stringify(data) === JSON.stringify(pickCertificateData(current)) && !fileId) {
        throw Errors.business('Aucune donnée corrigée par rapport à la révision courante');
      }
      const res = await this.openRequest(ctx, tx, cert, { kind: 'CORRECTION', data, fileId: fileId ?? null, attachFile: true, changeNote, submit });
      return { certificateId: cert.id, ...res };
    });
  }

  // ===========================================================================
  // Vie de la demande : modification, soumission, annulation, duplication
  // ===========================================================================

  /**
   * PATCH /certificate-requests/:id — le demandeur modifie sa demande non close : nouvelle version
   * IMMUABLE, `version` incrémentée (verrou optimiste) ; si elle était en attente, les validateurs
   * sont notifiés et l'approbation de l'ancienne version devient impossible (ADM-057/058).
   */
  async updateRequest(ctx: AuthContext, requestId: string, dto: UpdateRequestDto) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.loadRequest(ctx, requestId, tx);
      const cert = req.certificate;
      if (req.requestedById !== ctx.userId) throw Errors.forbidden('Seul le demandeur peut modifier sa demande (ADM-057)');
      if (req.kind === 'ATTACHMENT') {
        throw Errors.business('Une demande de pièce jointe ne se modifie pas : annulez-la puis déposez une nouvelle pièce');
      }
      if (!isOpenRequest(req.status)) throw Errors.alreadyProcessed(`Demande ${requestStatusLabel(req.status)} : modification impossible`);
      if (req.version !== dto.expectedVersion) {
        throw Errors.staleVersion(undefined, { currentVersion: req.version, expectedVersion: dto.expectedVersion });
      }
      this.assertActive(cert);

      const last = req.versions[0];
      const { expectedVersion, fileId, changeNote, ...patch } = dto;
      const before = pickCertificateData(last);
      const data = mergeCertificateData(before, patch);
      this.checkData(data);
      const nextFileId = fileId === undefined ? last.fileId : fileId;
      if (JSON.stringify(data) === JSON.stringify(before) && nextFileId === last.fileId) {
        throw Errors.business('Aucune modification à enregistrer');
      }

      if (nextFileId !== last.fileId) {
        // La pièce proposée par la version précédente est remplacée (jamais officielle)
        if (last.fileId) {
          await tx.certificateAttachment.updateMany({
            where: { certificateId: cert.id, fileId: last.fileId, status: 'PENDING_APPROVAL' },
            data: { status: 'REJECTED' },
          });
        }
        if (nextFileId) await this.createPendingAttachment(ctx, tx, cert, nextFileId, null);
      }

      const cas = await tx.certificateApprovalRequest.updateMany({
        where: { id: req.id, version: expectedVersion, status: { in: OPEN } },
        data: { version: { increment: 1 } },
      });
      if (!cas.count) throw await this.casFailure(tx, req.id);
      const versionNo = expectedVersion + 1;
      await tx.certificateRequestVersion.create({
        data: { requestId: req.id, versionNo, ...data, fileId: nextFileId, changeNote: changeNote ?? null, createdById: ctx.userId },
      });

      const changed: Record<string, unknown> = {};
      const previous: Record<string, unknown> = {};
      for (const k of Object.keys(data) as (keyof CertificateData)[]) {
        if (JSON.stringify(data[k]) !== JSON.stringify(before[k])) {
          changed[k] = data[k];
          previous[k] = before[k];
        }
      }
      if (nextFileId !== last.fileId) {
        changed.fileId = nextFileId;
        previous.fileId = last.fileId;
      }
      await this.audit.record(
        ctx,
        {
          action: 'certificate.request_updated',
          module: MODULE,
          entityType: 'certificate_request',
          entityId: req.id,
          vesselId: cert.vesselId,
          before: previous,
          after: changed,
          metadata: { certificateId: cert.id, version: versionNo, status: req.status, changeNote },
        },
        tx,
      );

      const updated: RequestRef = { ...req, version: versionNo };
      let notified: string[] = [];
      if (req.status === 'PENDING_APPROVAL') {
        await this.notifications.resolveForEntity('certificate_request', req.id, APPROVAL_NOTIFICATION_PREFIX, tx);
        notified = await this.notifyValidators(ctx, tx, cert, updated, 'updated');
      }
      return { request: summary(updated), notifiedValidators: notified.length };
    });
  }

  /** POST /certificate-requests/:id/submit — DRAFT | RETURNED → PENDING_APPROVAL ; validateurs notifiés (ADM-055). */
  async submit(ctx: AuthContext, requestId: string, dto: SubmitRequestDto) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.loadRequest(ctx, requestId, tx);
      const cert = req.certificate;
      if (req.requestedById !== ctx.userId) throw Errors.forbidden('Seul le demandeur peut soumettre sa demande');
      if (!canSelfApprove(ctx, req.kind)) this.access.assertCan(ctx, 'certificates.submit');
      this.assertActive(cert);
      if (req.status === 'PENDING_APPROVAL') throw Errors.invalidState('Demande déjà soumise à approbation');
      assertTransition(req.status, 'PENDING_APPROVAL');
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== req.version) {
        throw Errors.staleVersion(undefined, { currentVersion: req.version, expectedVersion: dto.expectedVersion });
      }
      if (req.kind === 'ATTACHMENT' && (!req.attachment || req.attachment.revisionId !== cert.currentRevisionId)) {
        throw Errors.invalidState('La révision courante a changé depuis le dépôt : annulez cette demande et déposez la pièce à nouveau');
      }
      const now = new Date();
      const cas = await tx.certificateApprovalRequest.updateMany({
        where: { id: req.id, status: req.status, version: req.version },
        data: {
          status: 'PENDING_APPROVAL',
          submittedAt: now,
          decidedById: null,
          decidedAt: null,
          decisionComment: null,
          escalatedAt: null,
          lastReminderAt: null,
        },
      });
      if (!cas.count) throw await this.casFailure(tx, req.id);
      const submitted: RequestRef = { ...req, status: 'PENDING_APPROVAL', submittedAt: now, uploadedById: req.attachment?.uploadedById };
      const res = await this.afterSubmit(ctx, tx, cert, submitted, req.status, req._count.decisions, !!req.versions[0]?.fileId);
      return { request: summary(afterSubmitRef(submitted, res)), ...res };
    });
  }

  /**
   * POST /certificate-requests/:id/cancel — motif obligatoire, validateurs notifiés (ADM-059).
   *  - le demandeur annule sa demande non validée ;
   *  - annulation de SUPERVISION : un validateur éligible pour la demande (même règle que la
   *    décision) ou un administrateur des types peut annuler la demande d'autrui — typiquement un
   *    brouillon jamais soumis qui bloquerait renouvellement, correction et archivage. Auditée
   *    distinctement, le demandeur est notifié.
   */
  async cancel(ctx: AuthContext, requestId: string, dto: CancelRequestDto) {
    return this.prisma.$transaction(async (tx) => {
      const req = await this.loadRequest(ctx, requestId, tx);
      const cert = req.certificate;
      const supervisory = req.requestedById !== ctx.userId;
      if (
        supervisory &&
        !this.certAccess.isSupervisor(
          ctx,
          { kind: req.kind, requestedById: req.requestedById, uploadedById: req.attachment?.uploadedById },
          cert.type.validators,
        )
      ) {
        throw Errors.forbidden(
          "Seul le demandeur (ADM-059), un validateur désigné pour ce type ou un administrateur des types peut annuler cette demande",
        );
      }
      if (!isOpenRequest(req.status)) throw Errors.alreadyProcessed(`Demande déjà ${requestStatusLabel(req.status)}`);
      if (dto.expectedVersion !== undefined && dto.expectedVersion !== req.version) {
        throw Errors.staleVersion(undefined, { currentVersion: req.version, expectedVersion: dto.expectedVersion });
      }
      assertTransition(req.status, 'CANCELLED');
      const cancelReason = supervisory ? `Annulation par ${ctx.displayName} (supervision) : ${dto.reason}` : dto.reason;
      const cas = await tx.certificateApprovalRequest.updateMany({
        where: { id: req.id, status: req.status },
        data: { status: 'CANCELLED', cancelReason },
      });
      if (!cas.count) throw await this.casFailure(tx, req.id);
      await this.rejectPendingAttachmentsOf(tx, req.id, cert.id);
      await this.audit.record(
        ctx,
        {
          action: supervisory ? 'certificate.request_cancelled_by_supervisor' : 'certificate.request_cancelled',
          module: MODULE,
          entityType: 'certificate_request',
          entityId: req.id,
          vesselId: cert.vesselId,
          before: { status: req.status },
          after: { status: 'CANCELLED' },
          metadata: {
            certificateId: cert.id,
            kind: req.kind,
            version: req.version,
            reason: dto.reason,
            supervisory,
            requestedById: req.requestedById,
          },
        },
        tx,
      );
      const cancelled: RequestRef = { ...req, status: 'CANCELLED' };
      let notified: string[] = [];
      if (req.status !== 'DRAFT') {
        await this.notifications.resolveForEntity('certificate_request', req.id, APPROVAL_NOTIFICATION_PREFIX, tx);
        notified = await this.notifyValidators(ctx, tx, cert, cancelled, 'cancelled', { reason: cancelReason, cycle: req._count.decisions });
      }
      if (supervisory) await this.notifyRequesterOfSupervisoryCancel(ctx, tx, cert, cancelled, dto.reason);
      return { request: summary(cancelled), supervisory, notifiedValidators: notified.length };
    });
  }

  /** Le demandeur est toujours informé de l'annulation de sa demande par un tiers (motif inclus). */
  private async notifyRequesterOfSupervisoryCancel(ctx: AuthContext, tx: Tx, cert: Cert, req: RequestRef, reason: string) {
    const readers = await this.certAccess.filterReaders(tx, cert, [req.requestedById]);
    if (!readers.length) return;
    await this.notifications.notify(
      {
        userIds: readers,
        type: 'certificate.request_cancelled_by_supervisor',
        title: `Votre demande de certificat a été annulée : ${cert.type.name} — ${subjectLabel(cert)}`,
        body: `Demande de ${REQUEST_KIND_LABELS[req.kind]} annulée par ${ctx.displayName}. Motif : ${reason}. Elle peut être dupliquée si nécessaire (ADM-060).`,
        module: MODULE,
        entityType: 'certificate_request',
        entityId: req.id,
        vesselId: cert.vesselId,
        link: certificateLink(cert.id, req.id),
        priority: 'HIGH',
        email: true,
        dedupeKey: `certreq:${req.id}:v${req.version}:supervisor-cancelled`,
        requiredPermission: this.certAccess.readerPermission(cert),
      },
      tx,
    );
  }

  /**
   * POST /certificate-requests/:id/duplicate — nouvelle demande indépendante (brouillon) copiant la
   * dernière version d'une demande annulée / refusée, liée par `duplicatedFromId` (ADM-060).
   */
  async duplicate(ctx: AuthContext, requestId: string, dto: DuplicateRequestDto) {
    return this.prisma.$transaction(async (tx) => {
      const src = await this.loadRequest(ctx, requestId, tx);
      const cert = src.certificate;
      if (!(DUPLICABLE_REQUEST_STATUSES as readonly ApprovalStatus[]).includes(src.status)) {
        throw Errors.invalidState('Seule une demande annulée ou refusée peut être dupliquée (ADM-060)');
      }
      if (src.kind === 'ATTACHMENT') throw Errors.business('Une pièce jointe refusée se remplace par un nouveau dépôt');
      this.assertActive(cert);
      await this.assertNoOpenDataRequest(tx, cert.id);
      if (src.kind === 'CREATE') {
        if (cert.currentRevisionId) {
          throw Errors.business('Le certificat a déjà une révision approuvée : utilisez le renouvellement ou la correction');
        }
        if (!cert.type.isActive) throw Errors.business('Type de certificat désactivé');
        if (!cert.type.allowMultiple) {
          await this.assertNoActiveCertificate(tx, cert.typeId, { vesselId: cert.vesselId, memberId: cert.memberId }, cert.id);
        }
      } else if (!cert.currentRevisionId) {
        throw Errors.invalidState('Aucune révision courante à renouveler ou corriger');
      }

      const last = src.versions[0];
      const warnings: string[] = [];
      let fileId: string | null = null;
      if (last.fileId) {
        if (src.requestedById === ctx.userId) {
          // Nouvelle référence logique au même blob (un fichier ne se rattache qu'une fois)
          const attId = randomUUID();
          const clone = await this.files.cloneReference(
            last.fileId,
            { type: OWNER_CERTIFICATE_ATTACHMENT, id: attId, vesselId: cert.vesselId },
            ctx.userId,
            tx,
          );
          await tx.certificateAttachment.create({
            data: { id: attId, certificateId: cert.id, fileId: clone.id, status: 'PENDING_APPROVAL', uploadedById: ctx.userId },
          });
          fileId = clone.id;
        } else {
          warnings.push("La pièce de la demande d'origine n'est pas reprise (réservée à son demandeur) : joignez un document si nécessaire");
        }
      }
      const res = await this.openRequest(ctx, tx, cert, {
        kind: src.kind,
        data: pickCertificateData(last),
        fileId,
        attachFile: false,
        changeNote: dto.changeNote ?? `Duplicata de la demande ${src.id}`,
        submit: false,
        duplicatedFromId: src.id,
      });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.request_duplicated',
          module: MODULE,
          entityType: 'certificate_request',
          entityId: res.request.id,
          vesselId: cert.vesselId,
          metadata: { certificateId: cert.id, duplicatedFromId: src.id, sourceStatus: src.status, fileCopied: !!fileId },
        },
        tx,
      );
      return { certificateId: cert.id, ...res, warnings: [...res.warnings, ...warnings] };
    });
  }

  // ===========================================================================
  // Décision (Approve / Reject / Return) — ADM-051..058, CERT-03/04
  // ===========================================================================

  /**
   * POST /approvals/:requestId/decision. Transaction SERIALIZABLE + mise à jour conditionnelle sur
   * (status PENDING_APPROVAL, version attendue) : sur concurrence, un seul commit ; le second
   * validateur reçoit 409 « déjà traité » (CERT-04) — jamais deux révisions courantes.
   */
  async decide(ctx: AuthContext, requestId: string, dto: DecisionDto) {
    return this.prisma.serializable(async (tx) => {
      const req = await this.loadRequest(ctx, requestId, tx);
      const cert = req.certificate;
      this.access.assertCan(ctx, approvalPermissionFor(req.kind));
      // CERT-03 : le demandeur (ou le déposant de la pièce) ne valide jamais, même Super Admin
      if (req.requestedById === ctx.userId || (req.kind === 'ATTACHMENT' && req.attachment?.uploadedById === ctx.userId)) {
        throw Errors.selfApproval();
      }
      const blocked = decisionBlockedBy(req.status);
      if (blocked === 'ALREADY_PROCESSED') throw Errors.alreadyProcessed(`Demande déjà traitée (${requestStatusLabel(req.status)})`);
      if (blocked === 'NOT_SUBMITTED') throw Errors.invalidState("La demande n'a pas été soumise à approbation");
      if (req.version !== dto.expectedVersion) {
        throw Errors.staleVersion('Version périmée : la demande a été modifiée depuis votre lecture (ADM-058)', {
          currentVersion: req.version,
          expectedVersion: dto.expectedVersion,
        });
      }
      if (!this.certAccess.isEligible(ctx, { kind: req.kind, requestedById: req.requestedById, uploadedById: req.attachment?.uploadedById }, cert.type.validators)) {
        throw Errors.forbidden("Vous n'êtes pas validateur désigné pour ce type de certificat (ADM-051)");
      }
      if (decisionRequiresComment(dto.decision) && !dto.comment) {
        throw Errors.validation('Commentaire obligatoire pour un refus ou un retour (ADM-052)', [{ path: 'comment' }]);
      }
      this.assertActive(cert);
      const target = DECISION_TARGET[dto.decision];
      assertTransition(req.status, target);
      if (req.kind === 'ATTACHMENT' && dto.decision === 'APPROVE') this.assertAttachmentApprovable(req);

      const now = new Date();
      const cas = await tx.certificateApprovalRequest.updateMany({
        where: { id: req.id, status: 'PENDING_APPROVAL', version: dto.expectedVersion },
        data: { status: target, decidedById: ctx.userId, decidedAt: now, decisionComment: dto.comment ?? null },
      });
      if (!cas.count) throw Errors.alreadyProcessed();
      await tx.certificateApprovalDecision.create({
        data: { requestId: req.id, versionNo: req.version, deciderId: ctx.userId, decision: dto.decision, comment: dto.comment ?? null },
      });
      await this.audit.record(
        ctx,
        {
          action: `certificate.request_${target.toLowerCase()}`,
          module: MODULE,
          entityType: 'certificate_request',
          entityId: req.id,
          vesselId: cert.vesselId,
          before: { status: req.status },
          after: { status: target },
          metadata: { certificateId: cert.id, kind: req.kind, version: req.version, decision: dto.decision, comment: dto.comment },
        },
        tx,
      );

      let outcome: Record<string, unknown> = {};
      if (dto.decision === 'APPROVE') {
        outcome = req.kind === 'ATTACHMENT' ? await this.applyAttachmentApproval(ctx, tx, req, now) : await this.applyDataApproval(ctx, tx, req, now);
      } else if (dto.decision === 'REJECT') {
        await this.rejectPendingAttachmentsOf(tx, req.id, cert.id);
      }

      // ADM-055 : la première décision clôt la demande ; le demandeur et les autres validateurs sont informés
      await this.notifications.resolveForEntity('certificate_request', req.id, APPROVAL_NOTIFICATION_PREFIX, tx);
      const decided: RequestRef = { ...req, status: target };
      await this.notifyRequester(ctx, tx, cert, decided, dto.decision, dto.comment, req._count.decisions);
      // Un retour n'est pas une clôture : la demande reviendra après correction (CRT-12)
      await this.notifyValidators(ctx, tx, cert, decided, dto.decision === 'RETURN' ? 'returned' : 'closed', {
        decision: dto.decision,
        cycle: req._count.decisions,
      });
      return { request: summary(decided), decision: dto.decision, ...outcome };
    });
  }

  /**
   * Approbation d'une demande de données : nouvelle révision CURRENT (immuable) créée APRÈS
   * archivage de l'ancienne (index partiel), pièce proposée -> OFFICIAL, ancienne pièce archivée,
   * dénormalisation `certificates.current_*`, Document Missing recalculé (ADM-064), suivi de
   * renouvellement clôturé, alertes de l'ancienne révision closes (ADM-049/050).
   */
  private async applyDataApproval(ctx: AuthContext, tx: Tx, req: LoadedRequest, now: Date) {
    const cert = req.certificate;
    if (req.kind !== 'CREATE' && !cert.currentRevisionId) throw Errors.invalidState('Aucune révision courante');
    if (req.kind === 'CREATE' && cert.currentRevisionId) {
      throw Errors.invalidState('Le certificat a déjà une révision approuvée : demande de création caduque');
    }
    const version = await tx.certificateRequestVersion.findUniqueOrThrow({
      where: { requestId_versionNo: { requestId: req.id, versionNo: req.version } },
    });
    const data = pickCertificateData(version);
    this.checkData(data);

    const prev = cert.currentRevisionId ? await tx.certificateRevision.findUnique({ where: { id: cert.currentRevisionId } }) : null;
    const prevOfficial = prev ? await tx.certificateAttachment.findFirst({ where: { revisionId: prev.id, status: 'OFFICIAL' } }) : null;

    // 1. Archiver l'ancienne révision AVANT d'insérer la nouvelle (une seule CURRENT — index partiel)
    if (prev) await tx.certificateRevision.update({ where: { id: prev.id }, data: { lifecycle: 'ARCHIVED', archivedAt: now } });
    const max = await tx.certificateRevision.aggregate({ where: { certificateId: cert.id }, _max: { revisionNo: true } });
    const revision = await tx.certificateRevision.create({
      data: {
        certificateId: cert.id,
        revisionNo: (max._max.revisionNo ?? 0) + 1,
        ...data,
        lifecycle: 'CURRENT',
        approvedRequestId: req.id,
        approvedById: ctx.userId,
        approvedAt: now,
      },
    });

    // 2. Document officiel : l'ancienne pièce reste attachée à l'ancienne révision (archivée)
    if (prevOfficial) {
      await tx.certificateAttachment.update({ where: { id: prevOfficial.id }, data: { status: 'ARCHIVED', archivedAt: now } });
    }
    const proposed = version.fileId
      ? await tx.certificateAttachment.findFirst({ where: { certificateId: cert.id, fileId: version.fileId, status: 'PENDING_APPROVAL' } })
      : null;
    let official: { id: string; fileId: string } | null = null;
    let officialSource: 'PROPOSED' | 'CARRIED_OVER' | null = null;
    if (proposed) {
      official = await tx.certificateAttachment.update({
        where: { id: proposed.id },
        data: { status: 'OFFICIAL', revisionId: revision.id, approvedById: ctx.userId, approvedAt: now },
      });
      officialSource = 'PROPOSED';
    } else if (req.kind === 'CORRECTION' && prevOfficial) {
      // Correction de métadonnées sans nouveau scan : le même document reste officiel pour la
      // nouvelle révision (nouvelle référence logique au même blob ; l'archive reste intacte)
      const attId = randomUUID();
      const clone = await this.files.cloneReference(
        prevOfficial.fileId,
        { type: OWNER_CERTIFICATE_ATTACHMENT, id: attId, vesselId: cert.vesselId },
        ctx.userId,
        tx,
      );
      official = await tx.certificateAttachment.create({
        data: {
          id: attId,
          certificateId: cert.id,
          revisionId: revision.id,
          fileId: clone.id,
          status: 'OFFICIAL',
          uploadedById: prevOfficial.uploadedById,
          uploadedAt: prevOfficial.uploadedAt,
          approvedById: ctx.userId,
          approvedAt: now,
        },
      });
      officialSource = 'CARRIED_OVER';
    }
    // Pièces proposées par les versions antérieures de la demande : jamais officielles
    await this.rejectPendingAttachmentsOf(tx, req.id, cert.id);

    // 3. Demande de pièce jointe ouverte sur l'ancienne révision
    const openAttachment = await tx.certificateApprovalRequest.findFirst({
      where: { certificateId: cert.id, kind: 'ATTACHMENT', status: { in: OPEN } },
      include: { attachment: true },
    });
    if (openAttachment?.attachment) {
      if (req.kind === 'CORRECTION') {
        // Même certificat physique : la pièce en attente vise désormais la révision corrigée
        await tx.certificateAttachment.update({ where: { id: openAttachment.attachment.id }, data: { revisionId: revision.id } });
      } else {
        const reason = 'Révision remplacée par un renouvellement approuvé : déposez la pièce sur la nouvelle révision';
        await tx.certificateApprovalRequest.update({ where: { id: openAttachment.id }, data: { status: 'CANCELLED', cancelReason: reason } });
        await tx.certificateAttachment.update({ where: { id: openAttachment.attachment.id }, data: { status: 'REJECTED' } });
        await this.notifications.resolveForEntity('certificate_request', openAttachment.id, APPROVAL_NOTIFICATION_PREFIX, tx);
        await this.audit.record(
          ctx,
          {
            action: 'certificate.request_cancelled',
            module: MODULE,
            entityType: 'certificate_request',
            entityId: openAttachment.id,
            vesselId: cert.vesselId,
            before: { status: openAttachment.status },
            after: { status: 'CANCELLED' },
            metadata: { certificateId: cert.id, kind: 'ATTACHMENT', reason, automatic: true, supersededByRequestId: req.id },
          },
          tx,
        );
      }
    }

    // 4. Suivi opérationnel de renouvellement : clôturé (ADM-048)
    const task = await tx.certificateRenewalTask.findFirst({ where: { certificateId: cert.id, status: { not: 'COMPLETED' } } });
    if (task) await tx.certificateRenewalTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', completedAt: now } });
    const renewalCompleted = !!task || req.kind === 'RENEWAL';

    // 5. Dénormalisation de la révision courante
    const documentMissing = !official;
    await tx.certificate.update({
      where: { id: cert.id },
      data: {
        currentRevisionId: revision.id,
        currentNumber: data.certificateNumber,
        currentExpiryKind: data.expiryKind,
        currentExpiryOn: data.expiryOn,
        documentMissing,
        ...(renewalCompleted ? { renewalStatus: 'COMPLETED' as const } : {}),
      },
    });

    await this.audit.record(
      ctx,
      {
        action: 'certificate.revision_approved',
        module: MODULE,
        entityType: 'certificate',
        entityId: cert.id,
        vesselId: cert.vesselId,
        before: prev
          ? { revisionNo: prev.revisionNo, ...pickCertificateData(prev), documentMissing: cert.documentMissing }
          : null,
        after: { revisionNo: revision.revisionNo, ...data, documentMissing },
        metadata: { requestId: req.id, kind: req.kind, version: req.version, previousRevisionId: prev?.id ?? null, revisionId: revision.id },
      },
      tx,
    );
    if (official || prevOfficial) {
      await this.audit.record(
        ctx,
        {
          action: 'certificate.official_document_changed',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          before: { attachmentId: prevOfficial?.id ?? null, fileId: prevOfficial?.fileId ?? null },
          after: { attachmentId: official?.id ?? null, fileId: official?.fileId ?? null },
          metadata: { requestId: req.id, revisionId: revision.id, source: officialSource },
        },
        tx,
      );
    }
    if (renewalCompleted && cert.renewalStatus !== 'COMPLETED') {
      await this.audit.record(
        ctx,
        {
          action: 'certificate.renewal_updated',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          before: { renewalStatus: cert.renewalStatus },
          after: { renewalStatus: 'COMPLETED' },
          metadata: { automatic: true, requestId: req.id, taskId: task?.id ?? null },
        },
        tx,
      );
    }
    // 6. Alertes recalculées : celles de l'ancienne révision sont closes, le job émet les nouvelles
    await this.notifications.resolveForEntity('certificate', cert.id, REMINDER_NOTIFICATION_PREFIX, tx);
    return { revision: { id: revision.id, revisionNo: revision.revisionNo }, documentMissing, officialAttachmentId: official?.id ?? null };
  }

  /** Préconditions d'une pièce ajoutée après validation (vérifiées avant la mise à jour conditionnelle). */
  private assertAttachmentApprovable(req: LoadedRequest) {
    const att = req.attachment;
    if (!att || att.status !== 'PENDING_APPROVAL') throw Errors.invalidState("La pièce n'est plus en attente de validation");
    if (!att.revisionId || att.revisionId !== req.certificate.currentRevisionId) {
      throw Errors.invalidState('La révision courante a changé depuis le dépôt : refusez cette pièce et déposez-la sur la révision courante');
    }
  }

  /** ADM-066/067 : la pièce validée devient officielle ; l'ancienne (restée active jusque-là) est archivée. */
  private async applyAttachmentApproval(ctx: AuthContext, tx: Tx, req: LoadedRequest, now: Date) {
    const cert = req.certificate;
    const att = req.attachment!;
    const prevOfficial = await tx.certificateAttachment.findFirst({ where: { revisionId: att.revisionId, status: 'OFFICIAL' } });
    // Archiver avant de promouvoir (une seule OFFICIAL par révision — index partiel)
    if (prevOfficial) await tx.certificateAttachment.update({ where: { id: prevOfficial.id }, data: { status: 'ARCHIVED', archivedAt: now } });
    await tx.certificateAttachment.update({ where: { id: att.id }, data: { status: 'OFFICIAL', approvedById: ctx.userId, approvedAt: now } });
    await tx.certificate.update({ where: { id: cert.id }, data: { documentMissing: false } });
    await this.audit.record(
      ctx,
      {
        action: 'certificate.official_document_changed',
        module: MODULE,
        entityType: 'certificate',
        entityId: cert.id,
        vesselId: cert.vesselId,
        before: { attachmentId: prevOfficial?.id ?? null, fileId: prevOfficial?.fileId ?? null, documentMissing: cert.documentMissing },
        after: { attachmentId: att.id, fileId: att.fileId, documentMissing: false },
        metadata: { requestId: req.id, revisionId: att.revisionId, source: 'ATTACHMENT_REQUEST' },
      },
      tx,
    );
    await this.notifications.resolveForEntity('certificate', cert.id, REMINDER_NOTIFICATION_TYPES.MISSING_DOCUMENT, tx);
    return { officialAttachmentId: att.id, replacedAttachmentId: prevOfficial?.id ?? null, documentMissing: false };
  }

  // ===========================================================================
  // Pièces jointes ajoutées après validation — ADM-066/067, CERT-05
  // ===========================================================================

  /**
   * POST /certificates/:id/attachments — la pièce reste PENDING (non officielle, le badge
   * Document Missing persiste) et l'éventuel document officiel reste actif jusqu'à la validation
   * par une AUTRE personne (`certificates.attachments.approve`). Soumettre exige
   * `certificates.submit` comme toute autre demande ; `submit: false` crée un brouillon.
   */
  async addAttachment(ctx: AuthContext, certificateId: string, dto: AddAttachmentDto) {
    if (dto.submit && !canSelfApprove(ctx, 'ATTACHMENT')) this.access.assertCan(ctx, 'certificates.submit');
    return this.prisma.$transaction(async (tx) => {
      const cert = await this.loadCertificate(ctx, certificateId, tx);
      this.assertActive(cert);
      const current = cert.currentRevisionId ? await tx.certificateRevision.findUnique({ where: { id: cert.currentRevisionId } }) : null;
      if (!cert.currentRevisionId || !current) {
        throw Errors.business('Aucune révision approuvée : joignez le document à la demande en cours (modification de la demande)');
      }
      const open = await tx.certificateApprovalRequest.findFirst({
        where: { certificateId: cert.id, kind: 'ATTACHMENT', status: { in: OPEN } },
        select: { id: true },
      });
      if (open) throw Errors.conflict('Une pièce jointe est déjà en attente de validation pour ce certificat', { requestId: open.id });

      const att = await this.createPendingAttachment(ctx, tx, cert, dto.fileId, cert.currentRevisionId);
      const now = new Date();
      const request = await tx.certificateApprovalRequest.create({
        data: {
          certificateId: cert.id,
          kind: 'ATTACHMENT',
          status: dto.submit ? 'PENDING_APPROVAL' : 'DRAFT',
          version: 1,
          requestedById: ctx.userId,
          submittedAt: dto.submit ? now : null,
          attachmentId: att.id,
          versions: {
            create: {
              versionNo: 1,
              ...pickCertificateData(current),
              fileId: dto.fileId,
              changeNote: dto.note ?? null,
              createdById: ctx.userId,
            },
          },
        },
      });
      const officialBefore = await tx.certificateAttachment.findFirst({
        where: { revisionId: cert.currentRevisionId, status: 'OFFICIAL' },
        select: { id: true },
      });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.attachment_proposed',
          module: MODULE,
          entityType: 'certificate_request',
          entityId: request.id,
          vesselId: cert.vesselId,
          after: { attachmentId: att.id, fileId: dto.fileId, status: 'PENDING_APPROVAL' },
          metadata: { certificateId: cert.id, revisionId: cert.currentRevisionId, replacesAttachmentId: officialBefore?.id ?? null, note: dto.note },
        },
        tx,
      );
      const ref: RequestRef = { ...request, uploadedById: ctx.userId };
      const res: SubmitOutcome = dto.submit
        ? await this.afterSubmit(ctx, tx, cert, ref, 'DRAFT', 0, true)
        : { notifiedValidators: 0, warnings: ['Pièce enregistrée en brouillon : soumettez la demande pour la faire valider'] };
      return { certificateId: cert.id, attachmentId: att.id, request: summary(afterSubmitRef(ref, res)), ...res };
    });
  }

  // ===========================================================================
  // Suivi de renouvellement, commentaires, archivage
  // ===========================================================================

  /**
   * PUT /certificates/:id/renewal — statut opérationnel, responsable et échéance (ADM-048).
   * N'altère JAMAIS la validité ni les rappels (CERT-02) ; changement de responsable audité.
   */
  /**
   * Responsables de renouvellement éligibles : utilisateurs actifs pouvant réellement lire ce certificat
   * (permission + scope navire / ADM-070). Évite d'exiger users.view pour choisir un responsable.
   */
  async renewalOwnerCandidates(ctx: AuthContext, certificateId: string) {
    const cert = await this.loadCertificate(ctx, certificateId, this.prisma);
    const users = await this.prisma.user.findMany({
      where: { status: 'ACTIVE', lockedAt: null },
      select: { id: true, displayName: true, jobTitle: true },
      orderBy: { displayName: 'asc' },
      take: 1000,
    });
    const readers = new Set(await this.certAccess.filterReaders(this.prisma, cert, users.map((u) => u.id)));
    return users.filter((u) => readers.has(u.id));
  }

  /**
   * GET /certificates/:id/approvers?kind= — destinataires de la demande d'approbation si l'appelant
   * la soumettait maintenant (même règle que la notification : permission d'approbation + accès au
   * certificat + validateurs désignés du type ; jamais le demandeur), ou publication directe.
   */
  async approvers(ctx: AuthContext, certificateId: string, kind: CertificateRequestKind) {
    const cert = await this.loadCertificate(ctx, certificateId, this.prisma);
    const selfApprove = canSelfApprove(ctx, kind);
    const ids = selfApprove
      ? []
      : await this.certAccess.eligibleValidatorIds(this.prisma, cert, { kind, requestedById: ctx.userId }, cert.type.validators);
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids }, status: 'ACTIVE' },
          select: { id: true, displayName: true, jobTitle: true },
          orderBy: { displayName: 'asc' },
        })
      : [];
    return { selfApprove, validatorsConfigured: cert.type.validators.length, approvers: users };
  }

  /**
   * Validateurs d'un type modifiés (après la validation de la modification) : les demandes de
   * données en attente suivent la nouvelle désignation (CRT-03). Les notifications d'approbation
   * des personnes devenues inéligibles sont résolues ; les nouveaux validateurs sont notifiés
   * (plateforme + e-mail), sans doublon pour ceux qui l'étaient déjà. Exécuté hors transaction :
   * un type peut compter des centaines de demandes en attente (import Excel).
   */
  async realignPendingValidators(ctx: AuthContext, typeId: string, db: Db = this.prisma) {
    const pending = await db.certificateApprovalRequest.findMany({
      where: { status: 'PENDING_APPROVAL', kind: { in: DATA_KINDS }, certificate: { typeId, archivedAt: null } },
      include: REQUEST_INCLUDE,
    });
    let notified = 0;
    let withdrawn = 0;
    const now = Date.now();
    // Éligibilité identique pour un même titulaire (navire / marin), au demandeur près
    const bySubject = new Map<string, string[]>();
    for (const req of pending) {
      const cert = req.certificate;
      const key = `${cert.subjectKind}:${cert.vesselId ?? cert.memberId}`;
      if (!bySubject.has(key)) {
        bySubject.set(key, await this.certAccess.eligibleValidatorIds(db, cert, { kind: req.kind, requestedById: '' }, cert.type.validators));
      }
      const eligible = bySubject.get(key)!.filter((id) => id !== req.requestedById);
      const stale = await db.notification.updateMany({
        where: {
          entityType: 'certificate_request',
          entityId: req.id,
          resolvedAt: null,
          type: { in: VALIDATOR_NOTIFICATION_TYPES },
          userId: { notIn: eligible },
        },
        data: { resolvedAt: new Date() },
      });
      withdrawn += stale.count;
      const already = new Set(
        (
          await db.notification.findMany({
            where: { entityType: 'certificate_request', entityId: req.id, resolvedAt: null, type: { in: VALIDATOR_NOTIFICATION_TYPES } },
            select: { userId: true },
          })
        ).map((n) => n.userId),
      );
      const newcomers = eligible.filter((id) => !already.has(id));
      if (!newcomers.length) continue;
      const sent = await this.notifications.notify(
        {
          userIds: newcomers,
          type: 'certificate.approval_requested',
          title: `Certificat à approuver : ${cert.type.name} — ${subjectLabel(cert)}`,
          body: `Demande de ${REQUEST_KIND_LABELS[req.kind]} (version ${req.version}) en attente : vous êtes désormais validateur désigné pour ce type (modification par ${ctx.displayName}).`,
          module: MODULE,
          entityType: 'certificate_request',
          entityId: req.id,
          vesselId: cert.vesselId,
          link: certificateLink(cert.id, req.id),
          priority: 'HIGH',
          mandatory: true,
          email: true,
          dedupeKey: `certreq:${req.id}:v${req.version}:reassigned:${now}`,
          requiredPermission: approvalPermissionFor(req.kind),
        },
        db,
      );
      notified += sent.length;
    }
    return { pendingRequests: pending.length, notifiedValidators: notified, withdrawnNotifications: withdrawn };
  }

  async setRenewal(ctx: AuthContext, certificateId: string, dto: SetRenewalDto) {
    return this.prisma.$transaction(async (tx) => {
      const cert = await this.loadCertificate(ctx, certificateId, tx);
      this.assertActive(cert);
      const task = await tx.certificateRenewalTask.findFirst({ where: { certificateId: cert.id, status: { not: 'COMPLETED' } } });
      const ownerId = dto.ownerId === undefined ? cert.renewalOwnerId : dto.ownerId;
      if (ownerId && ownerId !== cert.renewalOwnerId) {
        const readers = await this.certAccess.filterReaders(tx, cert, [ownerId]);
        if (!readers.length) {
          throw Errors.validation('Responsable sans accès à ce certificat (permission ou périmètre navire / Member)', [{ path: 'ownerId' }]);
        }
      }
      const dueOn = dto.dueOn === undefined ? (task?.dueOn ?? null) : dto.dueOn;
      const now = new Date();

      let taskId = task?.id ?? null;
      if (dto.status === 'COMPLETED') {
        if (task) await tx.certificateRenewalTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', completedAt: now, ownerId, dueOn } });
      } else if (task) {
        await tx.certificateRenewalTask.update({ where: { id: task.id }, data: { status: dto.status, ownerId, dueOn } });
      } else if (dto.status === 'IN_PROGRESS' || ownerId || dueOn) {
        const created = await tx.certificateRenewalTask.create({
          data: { certificateId: cert.id, ownerId, status: dto.status, dueOn, createdById: ctx.userId },
        });
        taskId = created.id;
      }
      await tx.certificate.update({ where: { id: cert.id }, data: { renewalStatus: dto.status, renewalOwnerId: ownerId } });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.renewal_updated',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          before: { renewalStatus: cert.renewalStatus, ownerId: cert.renewalOwnerId, dueOn: task?.dueOn ?? null },
          after: { renewalStatus: dto.status, ownerId, dueOn },
          metadata: { taskId },
        },
        tx,
      );
      if (ownerId && ownerId !== cert.renewalOwnerId && ownerId !== ctx.userId) {
        await this.notifications.notify(
          {
            userIds: [ownerId],
            type: 'certificate.renewal_assigned',
            title: `Renouvellement à piloter : ${cert.type.name} — ${subjectLabel(cert)}`,
            body: `${ctx.displayName} vous a désigné responsable du renouvellement${dueOn ? ` (échéance ${dueOn.toISOString().slice(0, 10)})` : ''}.`,
            module: MODULE,
            entityType: 'certificate',
            entityId: cert.id,
            vesselId: cert.vesselId,
            link: certificateLink(cert.id),
            dedupeKey: `cert:${cert.id}:renewal-owner:${ownerId}:${now.getTime()}`,
            email: true,
            requiredPermission: this.certAccess.readerPermission(cert),
          },
          tx,
        );
      }
      return { certificateId: cert.id, renewal: { status: dto.status, ownerId, dueOn, taskId } };
    });
  }

  /** POST /certificates/:id/comments — commentaires de suivi (ADM-048). */
  async addComment(ctx: AuthContext, certificateId: string, dto: AddCommentDto) {
    return this.prisma.$transaction(async (tx) => {
      const cert = await this.loadCertificate(ctx, certificateId, tx);
      this.assertActive(cert);
      const comment = await tx.certificateComment.create({ data: { certificateId: cert.id, authorId: ctx.userId, body: dto.body } });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.comment_added',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          after: { commentId: comment.id, body: dto.body },
        },
        tx,
      );
      return { ...comment, author: { id: ctx.userId, displayName: ctx.displayName } };
    });
  }

  /** POST /certificates/:id/archive — archivage motivé, jamais de suppression (CDC §4.4). */
  async archive(ctx: AuthContext, certificateId: string, dto: ArchiveCertificateDto) {
    return this.prisma.$transaction(async (tx) => {
      const cert = await this.loadCertificate(ctx, certificateId, tx);
      if (cert.archivedAt) throw Errors.invalidState('Certificat déjà archivé');
      const open = await tx.certificateApprovalRequest.findMany({
        where: { certificateId: cert.id, status: { in: OPEN } },
        select: { id: true, kind: true, status: true },
      });
      if (open.length) {
        throw Errors.invalidState('Des demandes sont en cours : elles doivent être annulées ou décidées avant l’archivage', { requests: open });
      }
      const now = new Date();
      const cas = await tx.certificate.updateMany({
        where: { id: cert.id, archivedAt: null },
        data: { archivedAt: now, archivedById: ctx.userId, archiveReason: dto.reason },
      });
      if (!cas.count) throw Errors.alreadyProcessed('Certificat déjà archivé');
      await this.audit.record(
        ctx,
        {
          action: 'certificate.archived',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          before: { archivedAt: null },
          after: { archivedAt: now, reason: dto.reason },
        },
        tx,
      );
      // Suivi de renouvellement sans objet : tâche active clôturée, statut remis à zéro (CRT-04)
      const task = await tx.certificateRenewalTask.findFirst({ where: { certificateId: cert.id, status: { not: 'COMPLETED' } } });
      if (task) await tx.certificateRenewalTask.update({ where: { id: task.id }, data: { status: 'COMPLETED', completedAt: now } });
      const resetStatus = cert.renewalStatus === 'IN_PROGRESS';
      if (task || resetStatus) {
        if (resetStatus) await tx.certificate.update({ where: { id: cert.id }, data: { renewalStatus: 'NOT_STARTED' } });
        await this.audit.record(
          ctx,
          {
            action: 'certificate.renewal_updated',
            module: MODULE,
            entityType: 'certificate',
            entityId: cert.id,
            vesselId: cert.vesselId,
            before: { renewalStatus: cert.renewalStatus, taskStatus: task?.status ?? null },
            after: { renewalStatus: resetStatus ? 'NOT_STARTED' : cert.renewalStatus, taskStatus: task ? 'COMPLETED' : null },
            metadata: { automatic: true, reason: 'Certificat archivé', taskId: task?.id ?? null },
          },
          tx,
        );
      }
      // Plus aucun rappel sur un certificat archivé
      await this.notifications.resolveForEntity('certificate', cert.id, REMINDER_NOTIFICATION_PREFIX, tx);
      return { certificateId: cert.id, archivedAt: now, archiveReason: dto.reason };
    });
  }

  // ===========================================================================
  // Outils internes
  // ===========================================================================

  private async loadCertificate(ctx: AuthContext, id: string, tx: Tx): Promise<Cert> {
    const cert = await tx.certificate.findUnique({ where: { id }, include: CERT_INCLUDE });
    if (!cert) throw Errors.notFound('Certificat');
    await this.certAccess.assertVisible(ctx, cert, tx);
    return cert;
  }

  private async loadRequest(ctx: AuthContext, id: string, tx: Tx): Promise<LoadedRequest> {
    const req = await tx.certificateApprovalRequest.findUnique({ where: { id }, include: REQUEST_INCLUDE });
    if (!req) throw Errors.notFound('Demande de certificat');
    await this.certAccess.assertVisible(ctx, req.certificate, tx, 'Demande de certificat');
    return req;
  }

  private assertActive(cert: { archivedAt: Date | null }) {
    if (cert.archivedAt) throw Errors.invalidState('Certificat archivé : aucune modification possible');
  }

  private async requireCurrentRevision(tx: Tx, cert: Cert) {
    const current = cert.currentRevisionId ? await tx.certificateRevision.findUnique({ where: { id: cert.currentRevisionId } }) : null;
    if (!current) throw Errors.business("Aucune révision approuvée : la demande de création n'est pas encore validée");
    return current;
  }

  private checkData(data: CertificateData) {
    const issues = validateCertificateData(data);
    if (issues.length) throw Errors.validation('Données de certificat invalides', issues);
  }

  /** Type non multiple : un seul certificat vivant (révision courante ou demande ouverte) par titulaire. */
  private async assertNoActiveCertificate(
    tx: Tx,
    typeId: string,
    subject: { vesselId: string | null; memberId: string | null },
    excludeId?: string,
  ) {
    const existing = await tx.certificate.findFirst({
      where: {
        typeId,
        vesselId: subject.vesselId,
        memberId: subject.memberId,
        archivedAt: null,
        ...(excludeId ? { id: { not: excludeId } } : {}),
        OR: [{ currentRevisionId: { not: null } }, { requests: { some: { status: { in: OPEN }, kind: { in: DATA_KINDS } } } }],
      },
      select: { id: true, currentRevisionId: true },
    });
    if (existing) {
      throw Errors.conflict(
        existing.currentRevisionId
          ? 'Un certificat actif de ce type existe déjà pour ce titulaire : utilisez le renouvellement ou la correction'
          : 'Une demande de création est déjà en cours pour ce titulaire et ce type',
        { certificateId: existing.id, allowMultiple: false },
      );
    }
  }

  private async assertNoOpenDataRequest(tx: Tx, certificateId: string) {
    const open = await tx.certificateApprovalRequest.findFirst({
      where: { certificateId, status: { in: OPEN }, kind: { in: DATA_KINDS } },
      select: { id: true, kind: true, status: true },
    });
    if (open) {
      throw Errors.conflict(
        'Une demande est déjà en cours pour ce certificat : son demandeur peut la modifier ou l’annuler (un validateur désigné peut aussi l’annuler)',
        { requestId: open.id, kind: open.kind, status: open.status },
      );
    }
  }

  /** Pièce candidate PENDING_APPROVAL (jamais officielle avant approbation — CERT-05) + rattachement du fichier. */
  private async createPendingAttachment(ctx: AuthContext, tx: Tx, cert: Cert, fileId: string, revisionId: string | null) {
    if (await tx.certificateAttachment.count({ where: { fileId } })) {
      throw Errors.conflict('Fichier déjà rattaché à une pièce de certificat');
    }
    const att = await tx.certificateAttachment.create({
      data: { certificateId: cert.id, revisionId, fileId, status: 'PENDING_APPROVAL', uploadedById: ctx.userId },
    });
    await this.files.attach(ctx, fileId, { type: OWNER_CERTIFICATE_ATTACHMENT, id: att.id, contexts: ['CERTIFICATE'], vesselId: cert.vesselId }, tx);
    return att;
  }

  /** Correction sans nouveau scan : le document officiel courant est repris à l'approbation (CRT-08). */
  private async keepsOfficialDocument(tx: Tx, cert: Cert, kind: CertificateRequestKind): Promise<boolean> {
    if (kind !== 'CORRECTION' || !cert.currentRevisionId) return false;
    return (await tx.certificateAttachment.count({ where: { revisionId: cert.currentRevisionId, status: 'OFFICIAL' } })) > 0;
  }

  /** Pièces proposées par les versions d'une demande et restées en attente -> REJECTED. */
  private async rejectPendingAttachmentsOf(tx: Tx, requestId: string, certificateId: string) {
    const versions = await tx.certificateRequestVersion.findMany({ where: { requestId }, select: { fileId: true } });
    const fileIds = versions.map((v) => v.fileId).filter((x): x is string => !!x);
    if (!fileIds.length) return;
    await tx.certificateAttachment.updateMany({
      where: { certificateId, fileId: { in: fileIds }, status: 'PENDING_APPROVAL' },
      data: { status: 'REJECTED' },
    });
  }

  /** Échec de la mise à jour conditionnelle : déjà traité (état changé) ou version périmée. */
  private async casFailure(tx: Tx, requestId: string) {
    const now = await tx.certificateApprovalRequest.findUnique({ where: { id: requestId }, select: { status: true, version: true } });
    if (!now || !isOpenRequest(now.status)) return Errors.alreadyProcessed();
    return Errors.staleVersion(undefined, { currentVersion: now.version });
  }

  private async openRequest(
    ctx: AuthContext,
    tx: Tx,
    cert: Cert,
    input: {
      kind: CertificateRequestKind;
      data: CertificateData;
      fileId: string | null;
      /** false si la pièce a déjà été créée (duplicata) */
      attachFile: boolean;
      changeNote?: string;
      submit: boolean;
      duplicatedFromId?: string;
    },
  ) {
    const now = new Date();
    if (input.fileId && input.attachFile) await this.createPendingAttachment(ctx, tx, cert, input.fileId, null);
    const request = await tx.certificateApprovalRequest.create({
      data: {
        certificateId: cert.id,
        kind: input.kind,
        status: input.submit ? 'PENDING_APPROVAL' : 'DRAFT',
        version: 1,
        requestedById: ctx.userId,
        submittedAt: input.submit ? now : null,
        duplicatedFromId: input.duplicatedFromId ?? null,
        versions: {
          create: {
            versionNo: 1,
            ...input.data,
            fileId: input.fileId,
            changeNote: input.changeNote ?? null,
            createdById: ctx.userId,
          },
        },
      },
    });
    await this.audit.record(
      ctx,
      {
        action: 'certificate.request_created',
        module: MODULE,
        entityType: 'certificate_request',
        entityId: request.id,
        vesselId: cert.vesselId,
        after: { kind: input.kind, status: request.status, version: 1, ...input.data, fileId: input.fileId },
        metadata: { certificateId: cert.id, changeNote: input.changeNote, duplicatedFromId: input.duplicatedFromId },
      },
      tx,
    );
    let res: SubmitOutcome = { notifiedValidators: 0, warnings: [] };
    if (input.submit) res = await this.afterSubmit(ctx, tx, cert, request, 'DRAFT', 0, !!input.fileId);
    return { request: summary(afterSubmitRef(request, res)), ...res };
  }

  /** Audit de soumission + notification de TOUS les validateurs éligibles (ADM-055) + avertissements. */
  private async afterSubmit(
    ctx: AuthContext,
    tx: Tx,
    cert: Cert,
    req: RequestRef,
    fromStatus: ApprovalStatus,
    cycle: number,
    hasFile: boolean,
  ): Promise<SubmitOutcome> {
    await this.audit.record(
      ctx,
      {
        action: 'certificate.request_submitted',
        module: MODULE,
        entityType: 'certificate_request',
        entityId: req.id,
        vesselId: cert.vesselId,
        before: { status: fromStatus },
        after: { status: 'PENDING_APPROVAL' },
        metadata: { certificateId: cert.id, kind: req.kind, version: req.version },
      },
      tx,
    );
    const warnings: string[] = [];
    if (!hasFile && cert.type.requiresDocument && req.kind !== 'ATTACHMENT' && !(await this.keepsOfficialDocument(tx, cert, req.kind))) {
      warnings.push('Aucun document joint : le certificat sera signalé « Document manquant » après approbation (ADM-064)');
    }
    // Publication directe : certificates.self_approve (Super Admin, CSO…) ou, pour un renouvellement,
    // certificates.renewal.self_approve — pas de circuit de validation
    if (canSelfApprove(ctx, req.kind)) {
      const outcome = await this.autoApprove(ctx, tx, req.id);
      return { notifiedValidators: 0, warnings, autoApproved: true, ...outcome };
    }
    const notified = await this.notifyValidators(ctx, tx, cert, req, 'submitted', { cycle });
    if (!notified.length) {
      warnings.push('Aucun validateur éligible (permission, périmètre et configuration du type) : la demande restera en attente');
    }
    return { notifiedValidators: notified.length, warnings };
  }

  /** Approbation immédiate par l'auteur lui-même (canSelfApprove), tracée comme une décision APPROVE. */
  private async autoApprove(ctx: AuthContext, tx: Tx, requestId: string): Promise<Record<string, unknown>> {
    const req = await this.loadRequest(ctx, requestId, tx);
    const cert = req.certificate;
    if (req.kind === 'ATTACHMENT') this.assertAttachmentApprovable(req);
    const now = new Date();
    const comment = 'Publication directe (sans approbation)';
    const cas = await tx.certificateApprovalRequest.updateMany({
      where: { id: req.id, status: 'PENDING_APPROVAL', version: req.version },
      data: { status: 'APPROVED', decidedById: ctx.userId, decidedAt: now, decisionComment: comment },
    });
    if (!cas.count) throw Errors.alreadyProcessed();
    await tx.certificateApprovalDecision.create({
      data: { requestId: req.id, versionNo: req.version, deciderId: ctx.userId, decision: 'APPROVE', comment },
    });
    await this.audit.record(
      ctx,
      {
        action: 'certificate.request_approved',
        module: MODULE,
        entityType: 'certificate_request',
        entityId: req.id,
        vesselId: cert.vesselId,
        before: { status: 'PENDING_APPROVAL' },
        after: { status: 'APPROVED' },
        metadata: { certificateId: cert.id, kind: req.kind, version: req.version, decision: 'APPROVE', selfApproved: true },
      },
      tx,
    );
    return req.kind === 'ATTACHMENT' ? this.applyAttachmentApproval(ctx, tx, req, now) : this.applyDataApproval(ctx, tx, req, now);
  }

  private async notifyValidators(
    ctx: AuthContext,
    tx: Tx,
    cert: Cert,
    req: RequestRef,
    event: 'submitted' | 'updated' | 'cancelled' | 'closed' | 'returned',
    detail: { cycle?: number; reason?: string; decision?: ApprovalDecisionKind } = {},
  ): Promise<string[]> {
    const recipients = await this.certAccess.eligibleValidatorIds(tx, cert, req, cert.type.validators, [ctx.userId]);
    if (!recipients.length) return [];
    const label = `${cert.type.name} — ${subjectLabel(cert)}`;
    const kind = REQUEST_KIND_LABELS[req.kind];
    const content: Record<typeof event, { type: string; title: string; body: string; email: boolean; mandatory: boolean; priority: NotificationPriority }> = {
      submitted: {
        type: 'certificate.approval_requested',
        title: `Certificat à approuver : ${label}`,
        body: `Demande de ${kind} (version ${req.version}) soumise par ${ctx.displayName}.`,
        email: true,
        mandatory: true,
        priority: 'HIGH',
      },
      updated: {
        type: 'certificate.approval_updated',
        title: `Demande de certificat modifiée : ${label}`,
        body: `${ctx.displayName} a créé la version ${req.version} de la demande de ${kind} : seule cette version peut être approuvée.`,
        email: true,
        mandatory: true,
        priority: 'HIGH',
      },
      cancelled: {
        type: 'certificate.request_cancelled',
        title: `Demande de certificat annulée : ${label}`,
        body: `${ctx.displayName} a annulé la demande de ${kind}. Motif : ${detail.reason ?? '—'}`,
        email: true,
        mandatory: false,
        priority: 'NORMAL',
      },
      closed: {
        type: 'certificate.request_closed',
        title: `Demande de certificat clôturée : ${label}`,
        body: `Demande de ${kind} ${detail.decision ? DECISION_LABELS[detail.decision] : 'traitée'} par ${ctx.displayName} : aucune action requise.`,
        email: false,
        mandatory: false,
        priority: 'LOW',
      },
      returned: {
        type: 'certificate.request_returned',
        title: `Demande de certificat retournée au demandeur : ${label}`,
        body: `Demande de ${kind} retournée pour correction par ${ctx.displayName} : aucune action requise avant sa nouvelle soumission.`,
        email: false,
        mandatory: false,
        priority: 'LOW',
      },
    };
    const c = content[event];
    return this.notifications.notify(
      {
        userIds: recipients,
        type: c.type,
        title: c.title,
        body: c.body,
        module: MODULE,
        entityType: 'certificate_request',
        entityId: req.id,
        vesselId: cert.vesselId,
        link: certificateLink(cert.id, req.id),
        priority: c.priority,
        mandatory: c.mandatory,
        email: c.email,
        dedupeKey: `certreq:${req.id}:v${req.version}:${event}:${detail.cycle ?? 0}`,
        requiredPermission: approvalPermissionFor(req.kind),
      },
      tx,
    );
  }

  private async notifyRequester(
    ctx: AuthContext,
    tx: Tx,
    cert: Cert,
    req: RequestRef,
    decision: ApprovalDecisionKind,
    comment: string | undefined,
    cycle: number,
  ) {
    const readers = await this.certAccess.filterReaders(tx, cert, [req.requestedById]);
    if (!readers.length) return;
    await this.notifications.notify(
      {
        userIds: readers,
        type: 'certificate.request_decided',
        title: `Demande de certificat ${DECISION_LABELS[decision]} : ${cert.type.name} — ${subjectLabel(cert)}`,
        body: comment ? `Décision de ${ctx.displayName} : ${comment}` : `Décision de ${ctx.displayName}.`,
        module: MODULE,
        entityType: 'certificate_request',
        entityId: req.id,
        vesselId: cert.vesselId,
        link: certificateLink(cert.id, req.id),
        priority: decision === 'APPROVE' ? 'NORMAL' : 'HIGH',
        email: true,
        dedupeKey: `certreq:${req.id}:v${req.version}:decided:${cycle}`,
        requiredPermission: this.certAccess.readerPermission(cert),
      },
      tx,
    );
  }

  /** Renouvellement demandé : suivi opérationnel « en cours » s'il n'existe pas (sans effet sur la validité). */
  private async ensureRenewalInProgress(ctx: AuthContext, tx: Tx, cert: Cert) {
    const task = await tx.certificateRenewalTask.findFirst({ where: { certificateId: cert.id, status: { not: 'COMPLETED' } } });
    if (task?.status === 'IN_PROGRESS' && cert.renewalStatus === 'IN_PROGRESS') return;
    if (task) await tx.certificateRenewalTask.update({ where: { id: task.id }, data: { status: 'IN_PROGRESS' } });
    else {
      await tx.certificateRenewalTask.create({
        data: { certificateId: cert.id, ownerId: cert.renewalOwnerId, status: 'IN_PROGRESS', createdById: ctx.userId },
      });
    }
    if (cert.renewalStatus !== 'IN_PROGRESS') {
      await tx.certificate.update({ where: { id: cert.id }, data: { renewalStatus: 'IN_PROGRESS' } });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.renewal_updated',
          module: MODULE,
          entityType: 'certificate',
          entityId: cert.id,
          vesselId: cert.vesselId,
          before: { renewalStatus: cert.renewalStatus },
          after: { renewalStatus: 'IN_PROGRESS' },
          metadata: { automatic: true, reason: 'Demande de renouvellement créée' },
        },
        tx,
      );
    }
  }
}
