/**
 * Règles métier PURES du moteur Certificats (CDC §4, V1 §7) — sans accès base ni Nest :
 * validité calculée, automate des demandes, éligibilité des validateurs, droits fichiers,
 * décisions de rappels. Testées unitairement (certificate.logic.spec.ts).
 */
import type {
  ApprovalDecisionKind,
  ApprovalStatus,
  AttachmentStatus,
  CertificateRequestKind,
  ExpiryKind,
  PrincipalType,
  ReminderFrequency,
  RenewalStatus,
} from '@prisma/client';
import { Errors } from '../../common/errors';

// =============================================================================
// Dates (colonnes @db.Date = minuit UTC)
// =============================================================================

const DAY_MS = 86_400_000;

/** Ramène un instant au jour calendaire UTC (minuit). */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function addDays(d: Date, days: number): Date {
  return new Date(utcDay(d).getTime() + days * DAY_MS);
}

/** Nombre de jours calendaires de `from` à `to` (négatif si `to` est antérieur). */
export function diffDays(from: Date, to: Date): number {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / DAY_MS);
}

export function isoDay(d: Date): string {
  return utcDay(d).toISOString().slice(0, 10);
}

// =============================================================================
// Validité calculée (jamais stockée) — CDC §4.3, ADM-061/062
// =============================================================================

export const VALIDITY_STATUSES = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'UNLIMITED', 'EXPIRY_UNKNOWN'] as const;
export type CertificateValidity = (typeof VALIDITY_STATUSES)[number];

/**
 * Validité réelle d'une révision courante. La date d'expiration est le dernier jour valide :
 * EXPIRED dès le lendemain. UNLIMITED ≠ EXPIRY_UNKNOWN (ADM-062). Le statut de renouvellement
 * n'intervient JAMAIS ici (IN_PROGRESS ne masque pas EXPIRED — CDC §4.3).
 */
export function computeValidity(
  expiryKind: ExpiryKind,
  expiryOn: Date | null,
  today: Date,
  expiringSoonDays: number,
): CertificateValidity {
  if (expiryKind === 'UNLIMITED') return 'UNLIMITED';
  if (expiryKind === 'UNKNOWN' || !expiryOn) return 'EXPIRY_UNKNOWN';
  const left = diffDays(today, expiryOn);
  if (left < 0) return 'EXPIRED';
  if (left <= expiringSoonDays) return 'EXPIRING_SOON';
  return 'VALID';
}

/** Jours restants avant expiration (négatif = jours de dépassement), null si non daté. */
export function daysToExpiry(expiryKind: ExpiryKind | null, expiryOn: Date | null, today: Date): number | null {
  if (expiryKind !== 'DATED' || !expiryOn) return null;
  return diffDays(today, expiryOn);
}

// =============================================================================
// Données d'une version de demande / révision officielle
// =============================================================================

export const CERTIFICATE_DATA_KEYS = [
  'certificateNumber',
  'issuer',
  'authority',
  'country',
  'placeOfIssue',
  'issuedOn',
  'validFrom',
  'expiryKind',
  'expiryOn',
  'remarks',
] as const;

export interface CertificateData {
  certificateNumber: string | null;
  issuer: string | null;
  authority: string | null;
  country: string | null;
  placeOfIssue: string | null;
  issuedOn: Date | null;
  validFrom: Date | null;
  expiryKind: ExpiryKind;
  expiryOn: Date | null;
  remarks: string | null;
}

export type CertificateDataPatch = { [K in keyof CertificateData]?: CertificateData[K] | null | undefined };

export const EMPTY_CERTIFICATE_DATA: CertificateData = {
  certificateNumber: null,
  issuer: null,
  authority: null,
  country: null,
  placeOfIssue: null,
  issuedOn: null,
  validFrom: null,
  expiryKind: 'UNKNOWN',
  expiryOn: null,
  remarks: null,
};

/** Extrait les seules colonnes de données (version, révision) d'un enregistrement. */
export function pickCertificateData(src: CertificateData): CertificateData {
  const out = {} as Record<string, unknown>;
  for (const k of CERTIFICATE_DATA_KEYS) out[k] = src[k] ?? null;
  return out as unknown as CertificateData;
}

/**
 * Fusionne un patch (undefined = inchangé, null = effacé) sur des données existantes.
 * Passer à UNLIMITED / UNKNOWN sans préciser expiryOn efface la date (contrainte CHECK).
 */
export function mergeCertificateData(base: CertificateData, patch: CertificateDataPatch): CertificateData {
  const out = { ...pickCertificateData(base) } as Record<string, unknown>;
  for (const k of CERTIFICATE_DATA_KEYS) {
    const v = patch[k];
    if (v !== undefined) out[k] = v;
  }
  if (out.expiryKind === null || out.expiryKind === undefined) out.expiryKind = base.expiryKind;
  if (out.expiryKind !== 'DATED' && patch.expiryOn === undefined) out.expiryOn = null;
  return out as unknown as CertificateData;
}

export interface DataIssue {
  path: string;
  message: string;
}

/** Cohérence des dates (miroir des CHECK SQL + règles de bon sens). Liste vide = valide. */
export function validateCertificateData(d: CertificateData): DataIssue[] {
  const issues: DataIssue[] = [];
  if (d.expiryKind === 'DATED' && !d.expiryOn) {
    issues.push({ path: 'expiryOn', message: "Date d'expiration requise pour un certificat daté (DATED)" });
  }
  if (d.expiryKind !== 'DATED' && d.expiryOn) {
    issues.push({
      path: 'expiryOn',
      message: "Pas de date d'expiration pour un certificat UNLIMITED ou à date inconnue (UNKNOWN)",
    });
  }
  if (d.expiryOn && d.issuedOn && d.issuedOn.getTime() > d.expiryOn.getTime()) {
    issues.push({ path: 'issuedOn', message: "La date d'émission est postérieure à la date d'expiration" });
  }
  if (d.expiryOn && d.validFrom && d.validFrom.getTime() > d.expiryOn.getTime()) {
    issues.push({ path: 'validFrom', message: "Le début de validité est postérieur à la date d'expiration" });
  }
  return issues;
}

// =============================================================================
// Automate des demandes d'approbation — CDC §4.3 / §12
// =============================================================================

export const OPEN_REQUEST_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] as const satisfies readonly ApprovalStatus[];
/** Le demandeur peut modifier sa demande tant qu'elle n'est pas close (ADM-057). */
export const EDITABLE_REQUEST_STATUSES = OPEN_REQUEST_STATUSES;
/** Dupliquer une demande close non validée (ADM-060). */
export const DUPLICABLE_REQUEST_STATUSES = ['CANCELLED', 'REJECTED'] as const satisfies readonly ApprovalStatus[];
/** Demandes portant des données (une seule ouverte par certificat — index partiel). */
export const DATA_REQUEST_KINDS = ['CREATE', 'RENEWAL', 'CORRECTION'] as const satisfies readonly CertificateRequestKind[];

export const REQUEST_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['APPROVED', 'RETURNED', 'REJECTED', 'CANCELLED'],
  // Retour pour correction : le demandeur corrige puis soumet à nouveau
  RETURNED: ['PENDING_APPROVAL', 'CANCELLED'],
  REJECTED: [],
  APPROVED: [],
  CANCELLED: [],
};

export function isOpenRequest(status: ApprovalStatus): boolean {
  return (OPEN_REQUEST_STATUSES as readonly ApprovalStatus[]).includes(status);
}

export function canTransition(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return REQUEST_TRANSITIONS[from].includes(to);
}

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  DRAFT: 'brouillon',
  PENDING_APPROVAL: 'en attente d’approbation',
  RETURNED: 'retournée pour correction',
  REJECTED: 'refusée',
  APPROVED: 'approuvée',
  CANCELLED: 'annulée',
};

export function requestStatusLabel(status: ApprovalStatus): string {
  return STATUS_LABELS[status];
}

/** Lève 409 INVALID_STATE si la transition n'est pas prévue par l'automate. */
export function assertTransition(from: ApprovalStatus, to: ApprovalStatus): void {
  if (!canTransition(from, to)) {
    throw Errors.invalidState(`Transition interdite : demande ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`, { from, to });
  }
}

export const DECISION_TARGET: Record<ApprovalDecisionKind, ApprovalStatus> = {
  APPROVE: 'APPROVED',
  REJECT: 'REJECTED',
  RETURN: 'RETURNED',
};

/** Commentaire obligatoire pour refuser ou retourner (ADM-052). */
export function decisionRequiresComment(decision: ApprovalDecisionKind): boolean {
  return decision !== 'APPROVE';
}

/**
 * Erreur à renvoyer à un validateur qui décide sur une demande qui n'est plus en attente :
 * « déjà traité » si une décision / annulation est intervenue (CERT-04), état invalide sinon.
 */
export function decisionBlockedBy(status: ApprovalStatus): 'ALREADY_PROCESSED' | 'NOT_SUBMITTED' | null {
  if (status === 'PENDING_APPROVAL') return null;
  if (status === 'DRAFT') return 'NOT_SUBMITTED';
  return 'ALREADY_PROCESSED';
}

// =============================================================================
// Éligibilité des validateurs — ADM-051, CERT-03
// =============================================================================

export interface PrincipalRef {
  type: PrincipalType;
  id: string;
}

export interface ValidatorRef {
  principalType: PrincipalType;
  principalId: string;
}

/** Sujet évalué : l'appelant (AuthContext) ou tout objet équivalent. */
export interface Actor {
  userId: string;
  permissions: ReadonlySet<string>;
  principals: PrincipalRef[];
}

/** Permission d'approbation selon la nature de la demande (pièce ajoutée après validation : ADM-066). */
export function approvalPermissionFor(kind: CertificateRequestKind): string {
  return kind === 'ATTACHMENT' ? 'certificates.attachments.approve' : 'certificates.approve';
}

/** Aucun validateur configuré pour le type = toute personne habilitée (permission + scope). */
export function matchesValidatorPrincipals(principals: PrincipalRef[], validators: ValidatorRef[]): boolean {
  if (!validators.length) return true;
  return validators.some((v) => principals.some((p) => p.type === v.principalType && p.id === v.principalId));
}

/**
 * Validateur éligible (hors contrôle de scope, vérifié par ailleurs) :
 *  - données : `certificates.approve` + choisi par la configuration du type (ADM-051) ;
 *  - pièce jointe : `certificates.attachments.approve` (validation distincte, ADM-066).
 * Le demandeur n'est jamais éligible (CERT-03), même Super Admin.
 */
export function isEligibleValidator(
  actor: Actor,
  request: { kind: CertificateRequestKind; requestedById: string; uploadedById?: string | null },
  validators: ValidatorRef[],
): boolean {
  if (actor.userId === request.requestedById) return false;
  if (request.kind === 'ATTACHMENT' && request.uploadedById === actor.userId) return false;
  if (!actor.permissions.has(approvalPermissionFor(request.kind))) return false;
  if (request.kind === 'ATTACHMENT') return true;
  return matchesValidatorPrincipals(actor.principals, validators);
}

/** Configuration Super Admin des certificats : autorise aussi l'annulation de supervision. */
export const TYPES_MANAGE_PERMISSION = 'certificates.types.manage';

/**
 * Annulation de supervision d'une demande ouverte d'un AUTRE utilisateur (brouillon jamais soumis
 * qui bloque renouvellement / correction / archivage) : validateur éligible pour cette demande
 * (même règle que la décision) ou administrateur des types. Le demandeur annule via la règle ADM-059.
 */
export function isRequestSupervisor(
  actor: Actor,
  request: { kind: CertificateRequestKind; requestedById: string; uploadedById?: string | null },
  validators: ValidatorRef[],
): boolean {
  if (actor.userId === request.requestedById) return false;
  return actor.permissions.has(TYPES_MANAGE_PERMISSION) || isEligibleValidator(actor, request, validators);
}

// =============================================================================
// Droits sur les pièces jointes — ADM-068/069, CERT-05/06/07
// =============================================================================

export interface AttachmentRightsInput {
  status: AttachmentStatus;
  /** Pièce OFFICIAL rattachée à la révision courante du certificat */
  isCurrentOfficial: boolean;
  uploadedById: string;
  /**
   * Demande à laquelle la pièce en attente est liée (version ou demande ATTACHMENT). Tant qu'elle
   * est en brouillon, son contenu reste privé au demandeur : les validateurs n'y ont pas accès.
   */
  request: { kind: CertificateRequestKind; requestedById: string; status?: ApprovalStatus } | null;
  validators: ValidatorRef[];
  /** Seuls PDF / images s'affichent inline : sinon un aperçu équivaudrait à un téléchargement */
  previewable: boolean;
}

export interface AttachmentRights {
  preview: boolean;
  download: boolean;
  /** Catégorie retenue (pour messages et audit) */
  scope: 'CURRENT' | 'ARCHIVED' | 'WORKFLOW';
}

/**
 * Droits d'un utilisateur DÉJÀ autorisé à voir le certificat (view + scope / ADM-070) :
 *  - pièce officielle courante : aperçu avec View ; téléchargement = download_current ;
 *  - pièce archivée : aperçu avec View ; téléchargement = download_archived, jamais impliqué
 *    par download_current (CERT-07) ;
 *  - pièce en attente / refusée : réservée au déposant, au demandeur et aux validateurs éligibles
 *    (une pièce en attente n'est pas officielle — CERT-05).
 */
export function attachmentRights(actor: Actor, input: AttachmentRightsInput): AttachmentRights {
  let rights: AttachmentRights;
  if (input.status === 'PENDING_APPROVAL' || input.status === 'REJECTED') {
    const isUploader = input.uploadedById === actor.userId;
    const isRequester = !!input.request && input.request.requestedById === actor.userId;
    const isValidator =
      !!input.request &&
      input.request.status !== 'DRAFT' &&
      isEligibleValidator(
        actor,
        { kind: input.request.kind, requestedById: input.request.requestedById, uploadedById: input.uploadedById },
        input.validators,
      );
    const party = isUploader || isRequester || isValidator;
    rights = {
      scope: 'WORKFLOW',
      preview: party,
      download: party && (isUploader || actor.permissions.has('certificates.download_current')),
    };
  } else if (input.status === 'OFFICIAL' && input.isCurrentOfficial) {
    rights = { scope: 'CURRENT', preview: true, download: actor.permissions.has('certificates.download_current') };
  } else {
    rights = { scope: 'ARCHIVED', preview: true, download: actor.permissions.has('certificates.download_archived') };
  }
  // Format non affichable inline : l'aperçu serait un téléchargement déguisé (CERT-06)
  if (!input.previewable) rights.preview = rights.download;
  return rights;
}

// =============================================================================
// Rappels — ADM-044..047, 056, 063, 065 ; CERT-01 / CERT-02
// =============================================================================

export interface ReminderPolicyRules {
  thresholdsDays: number[];
  frequency: ReminderFrequency;
  customIntervalDays: number | null;
  postExpiryIntervalDays: number | null;
  postExpiryMaxReminders: number | null;
  unknownExpiryIntervalDays: number | null;
  missingDocumentIntervalDays: number | null;
}

export interface ReminderSubject {
  certificateId: string;
  /** N° de la révision courante : les rappels repartent à zéro après un renouvellement approuvé */
  revisionNo: number;
  expiryKind: ExpiryKind;
  expiryOn: Date | null;
  documentMissing: boolean;
  requiresDocument: boolean;
  /** Renouvellement opérationnel : volontairement IGNORÉ (CERT-02, ADM-048) */
  renewalStatus: RenewalStatus;
  /** Point de départ des rappels de complétion / pièce manquante (approbation de la révision) */
  anchorDate: Date;
}

export type ReminderAlertKind = 'EXPIRY' | 'EXPIRED' | 'UNKNOWN_EXPIRY' | 'MISSING_DOCUMENT';

/** Types de notification des rappels (entityType 'certificate') — résolus après renouvellement / archivage. */
export const REMINDER_NOTIFICATION_PREFIX = 'certificate.reminder.';
export const REMINDER_NOTIFICATION_TYPES: Record<ReminderAlertKind, string> = {
  EXPIRY: 'certificate.reminder.expiry',
  EXPIRED: 'certificate.reminder.expired',
  UNKNOWN_EXPIRY: 'certificate.reminder.unknown_expiry',
  MISSING_DOCUMENT: 'certificate.reminder.missing_document',
};
/** Notifications de validation en attente (entityType 'certificate_request') — résolues à la clôture. */
export const APPROVAL_NOTIFICATION_PREFIX = 'certificate.approval_';

export interface ReminderAlert {
  kind: ReminderAlertKind;
  /**
   * Clé de déduplication déterministe (certificat, révision, nature, seuil / tranche de dates) :
   * elle tient lieu de « marqueur de dernier envoi » — une ré-exécution du job le même jour
   * (ou dans la même tranche) ne renvoie rien (unicité user + dedupeKey).
   */
  dedupeKey: string;
  priority: 'NORMAL' | 'HIGH' | 'CRITICAL';
  daysToExpiry?: number;
  daysOverdue?: number;
  threshold?: number;
  occurrence?: number;
}

function periodicInterval(policy: ReminderPolicyRules): number {
  switch (policy.frequency) {
    case 'DAILY':
      return 1;
    case 'WEEKLY':
      return 7;
    case 'CUSTOM':
      return Math.max(1, policy.customIntervalDays ?? 7);
    default:
      return 0;
  }
}

/** Seuils positifs, uniques, triés par ordre croissant. */
export function normalizeThresholds(thresholds: number[]): number[] {
  return [...new Set(thresholds.filter((t) => Number.isInteger(t) && t > 0))].sort((a, b) => a - b);
}

/**
 * Décide les alertes à émettre aujourd'hui pour un certificat (fonction pure).
 *  - UNKNOWN et UNLIMITED : jamais d'alerte d'échéance (CERT-01, ADM-062) ; UNKNOWN produit un
 *    rappel de complétion distinct si la politique le prévoit (ADM-063).
 *  - Avant échéance : AT_THRESHOLDS = une alerte par seuil franchi (le plus urgent seulement si le
 *    job a manqué des jours) ; DAILY / WEEKLY / CUSTOM = répétition dans la fenêtre du plus grand seuil.
 *  - Après échéance : alerte « expiré » puis répétition tous les N jours, au plus M rappels (ADM-047).
 *  - Pièce officielle manquante : rappel périodique si le type exige un document (ADM-065).
 *  - Le statut de renouvellement n'est pas consulté : IN_PROGRESS ne supprime rien (CERT-02).
 */
export function decideCertificateReminders(
  policy: ReminderPolicyRules,
  subject: ReminderSubject,
  today: Date,
): ReminderAlert[] {
  const alerts: ReminderAlert[] = [];
  const base = `cert:${subject.certificateId}:r${subject.revisionNo}`;

  if (subject.expiryKind === 'DATED' && subject.expiryOn) {
    const left = diffDays(today, subject.expiryOn);
    if (left >= 0) {
      const thresholds = normalizeThresholds(policy.thresholdsDays);
      const priority = left <= 7 ? 'HIGH' : 'NORMAL';
      if (policy.frequency === 'AT_THRESHOLDS') {
        const reached = thresholds.filter((t) => left <= t);
        if (reached.length) {
          const threshold = reached[0];
          alerts.push({ kind: 'EXPIRY', dedupeKey: `${base}:expiry:t${threshold}`, priority, daysToExpiry: left, threshold });
        }
      } else if (thresholds.length) {
        const window = thresholds[thresholds.length - 1];
        if (left <= window) {
          const interval = periodicInterval(policy);
          const occurrence = Math.floor((window - left) / interval);
          alerts.push({
            kind: 'EXPIRY',
            dedupeKey: `${base}:expiry:p${interval}:${occurrence}`,
            priority,
            daysToExpiry: left,
            occurrence,
          });
        }
      }
    } else {
      const overdue = -left;
      const interval = policy.postExpiryIntervalDays;
      let occurrence = 0;
      if (interval && interval > 0) {
        occurrence = Math.floor((overdue - 1) / interval);
        // Au-delà du maximum de rappels : seule l'alerte initiale reste due (dédupliquée si déjà envoyée)
        if (policy.postExpiryMaxReminders !== null && occurrence > policy.postExpiryMaxReminders) occurrence = 0;
      }
      alerts.push({ kind: 'EXPIRED', dedupeKey: `${base}:expired:${occurrence}`, priority: 'CRITICAL', daysOverdue: overdue, occurrence });
    }
  }

  if (subject.expiryKind === 'UNKNOWN' && policy.unknownExpiryIntervalDays && policy.unknownExpiryIntervalDays > 0) {
    const since = Math.max(0, diffDays(subject.anchorDate, today));
    const occurrence = Math.floor(since / policy.unknownExpiryIntervalDays);
    alerts.push({ kind: 'UNKNOWN_EXPIRY', dedupeKey: `${base}:unknown:${occurrence}`, priority: 'NORMAL', occurrence });
  }

  if (
    subject.documentMissing &&
    subject.requiresDocument &&
    policy.missingDocumentIntervalDays &&
    policy.missingDocumentIntervalDays > 0
  ) {
    const since = Math.max(0, diffDays(subject.anchorDate, today));
    const occurrence = Math.floor(since / policy.missingDocumentIntervalDays);
    alerts.push({ kind: 'MISSING_DOCUMENT', dedupeKey: `${base}:missingdoc:${occurrence}`, priority: 'NORMAL', occurrence });
  }

  return alerts;
}

export interface ApprovalOverdueInput {
  requestId: string;
  version: number;
  submittedAt: Date;
  now: Date;
  overdueHours: number | null;
  alreadyEscalated: boolean;
  escalationConfigured: boolean;
}

export interface ApprovalOverdueDecision {
  remind: { dedupeKey: string; hoursPending: number; occurrence: number } | null;
  escalate: boolean;
}

/**
 * Validation en attente au-delà de N heures (ADM-056) : rappel aux validateurs éligibles toutes
 * les N heures (clé par tranche) et escalade unique vers le rôle configuré dès le premier retard.
 */
export function decideApprovalOverdue(input: ApprovalOverdueInput): ApprovalOverdueDecision {
  if (!input.overdueHours || input.overdueHours <= 0) return { remind: null, escalate: false };
  const hoursPending = Math.floor((input.now.getTime() - input.submittedAt.getTime()) / 3_600_000);
  if (hoursPending < input.overdueHours) return { remind: null, escalate: false };
  const occurrence = Math.floor(hoursPending / input.overdueHours);
  return {
    remind: { dedupeKey: `certreq:${input.requestId}:v${input.version}:overdue:${occurrence}`, hoursPending, occurrence },
    escalate: input.escalationConfigured && !input.alreadyEscalated,
  };
}

// =============================================================================
// Libellés (notifications / exports)
// =============================================================================

export const REQUEST_KIND_LABELS: Record<CertificateRequestKind, string> = {
  CREATE: 'création',
  RENEWAL: 'renouvellement',
  CORRECTION: 'correction',
  ATTACHMENT: 'pièce jointe',
};

export const VALIDITY_LABELS: Record<CertificateValidity, string> = {
  VALID: 'Valide',
  EXPIRING_SOON: 'Expire bientôt',
  EXPIRED: 'Expiré',
  UNLIMITED: 'Illimité',
  EXPIRY_UNKNOWN: 'Date d’expiration inconnue',
};

/** Libellé du titulaire pour notifications (jamais le numéro du certificat — CDC §4.6). */
export function subjectLabel(c: {
  vessel?: { name: string } | null;
  member?: { firstName: string; lastName: string } | null;
}): string {
  if (c.vessel) return c.vessel.name;
  if (c.member) return `${c.member.lastName} ${c.member.firstName}`;
  return 'Certificat';
}

/** Lien interne (deep link) — l'accès est revérifié à l'ouverture. */
export function certificateLink(certificateId: string, requestId?: string): string {
  return requestId ? `/certificates/${certificateId}?request=${requestId}` : `/certificates/${certificateId}`;
}

/** Nom de fichier sûr proposé au téléchargement (aucun caractère de chemin). */
export function safeDownloadName(parts: (string | number | null | undefined)[], extension: string): string {
  const stem = parts
    .filter((p) => p !== null && p !== undefined && String(p).trim() !== '')
    .map((p) =>
      String(p)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^\w.-]+/g, '_'),
    )
    .join('_')
    .replace(/_+/g, '_')
    .slice(0, 150);
  const ext = extension.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin';
  return `${stem || 'certificat'}.${ext}`;
}
