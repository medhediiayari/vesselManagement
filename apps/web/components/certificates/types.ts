/**
 * Contrats de l'API Certificats (apps/api/src/modules/certificates) côté interface.
 * Miroir des réponses de CertificatesService / CertificateWorkflowService / CertificateTypesService.
 */
import type { ValidityStatus } from '@amc/types';

export type SubjectKind = 'VESSEL' | 'MEMBER';
export type ExpiryKind = 'DATED' | 'UNLIMITED' | 'UNKNOWN';
export type RequestKind = 'CREATE' | 'RENEWAL' | 'CORRECTION' | 'ATTACHMENT';
export type ApprovalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'RETURNED' | 'REJECTED' | 'APPROVED' | 'CANCELLED';
export type RenewalStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED';
export type AttachmentStatus = 'PENDING_APPROVAL' | 'OFFICIAL' | 'ARCHIVED' | 'REJECTED';
export type DecisionKind = 'APPROVE' | 'REJECT' | 'RETURN';
export type PrincipalType = 'USER' | 'ROLE' | 'DEPARTMENT';
export type ReminderFrequency = 'AT_THRESHOLDS' | 'DAILY' | 'WEEKLY' | 'CUSTOM';

export interface UserRef {
  id: string;
  displayName: string | null;
}

/** Demande ouverte résumée (renvoyée même quand ses versions sont masquées : brouillon d'un autre). */
export interface OpenRequestSummary {
  id: string;
  kind: RequestKind;
  status: ApprovalStatus;
  requester?: UserRef | null;
  requestedBy?: UserRef | null;
  isMine: boolean;
  canCancel: boolean;
}

export interface VesselSubject {
  id: string;
  code: string;
  name: string;
  imoNumber?: string | null;
}

export interface MemberSubject {
  id: string;
  amcRef: string;
  firstName: string;
  lastName: string;
  rank?: string | null;
}

export interface Subject {
  label: string;
  vessel: VesselSubject | null;
  member: MemberSubject | null;
}

/** Données métier d'une révision ou d'une version de demande (CDC §4.2). */
export interface CertificateData {
  certificateNumber: string | null;
  issuer: string | null;
  authority: string | null;
  country: string | null;
  placeOfIssue: string | null;
  issuedOn: string | null;
  validFrom: string | null;
  expiryKind: ExpiryKind;
  expiryOn: string | null;
  remarks: string | null;
}

export interface OpenRequestRef {
  id: string;
  kind: RequestKind;
  status: ApprovalStatus;
  statusLabel: string;
  version: number;
  requestedById: string;
  requestedBy: UserRef;
  submittedAt: string | null;
  createdAt: string;
}

export interface CertificateTypeRef {
  id: string;
  code: string;
  name: string;
  category: string;
  subjectKind: SubjectKind;
  requiresDocument: boolean;
  allowMultiple: boolean;
}

export interface CertificateListItem {
  id: string;
  subjectKind: SubjectKind;
  vesselId: string | null;
  memberId: string | null;
  subject: Subject;
  type: CertificateTypeRef;
  hasCurrentRevision: boolean;
  currentNumber: string | null;
  currentExpiryKind: ExpiryKind | null;
  currentExpiryOn: string | null;
  validity: ValidityStatus | null;
  validityLabel: string | null;
  daysToExpiry: number | null;
  currentRevision: {
    id: string;
    revisionNo: number;
    issuer: string | null;
    authority: string | null;
    issuedOn: string | null;
    validFrom: string | null;
    approvedAt: string;
  } | null;
  documentMissing: boolean;
  documentRequired: boolean;
  renewal: { status: RenewalStatus; owner: UserRef | null; dueOn: string | null };
  openRequest: OpenRequestRef | null;
  pendingAttachmentRequest: OpenRequestRef | null;
  archivedAt: string | null;
  archiveReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FileSummary {
  id: string;
  originalName: string;
  kind: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: string;
  pageCount: number | null;
}

export interface AttachmentDto {
  id: string;
  status: AttachmentStatus;
  revisionId: string | null;
  revisionNo: number | null;
  isCurrentOfficial: boolean;
  uploadedBy: UserRef | null;
  uploadedAt: string;
  approvedBy: UserRef | null;
  approvedAt: string | null;
  archivedAt: string | null;
  /** null : pièce en attente hors du cercle demandeur / validateurs (CERT-05) */
  file: FileSummary | null;
  access: { preview: boolean; download: boolean; scope: 'WORKFLOW' | 'CURRENT' | 'ARCHIVED' };
}

export interface RevisionDto extends CertificateData {
  id: string;
  certificateId: string;
  revisionNo: number;
  lifecycle: 'CURRENT' | 'ARCHIVED';
  approvedRequestId: string;
  approvedById: string;
  approvedAt: string;
  archivedAt: string | null;
  createdAt: string;
  approvedBy: UserRef | null;
}

export interface RequestVersionDto extends CertificateData {
  id: string;
  requestId: string;
  versionNo: number;
  fileId: string | null;
  changeNote: string | null;
  createdById: string;
  createdAt: string;
  createdBy: UserRef | null;
}

export interface DecisionDto {
  id: string;
  requestId: string;
  versionNo: number;
  deciderId: string;
  decision: DecisionKind;
  comment: string | null;
  createdAt: string;
  decider: UserRef | null;
}

export interface RequestDto {
  id: string;
  kind: RequestKind;
  status: ApprovalStatus;
  statusLabel: string;
  version: number;
  requestedBy: UserRef | null;
  submittedAt: string | null;
  decidedBy: UserRef | null;
  decidedAt: string | null;
  decisionComment: string | null;
  cancelReason: string | null;
  duplicatedFromId: string | null;
  attachmentId: string | null;
  escalatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  canDecide: boolean;
  /** Versions immuables, la plus récente en premier */
  versions: RequestVersionDto[];
  decisions: DecisionDto[];
}

export interface RenewalTaskDto {
  id: string;
  certificateId: string;
  ownerId: string | null;
  status: RenewalStatus;
  dueOn: string | null;
  createdById: string;
  createdAt: string;
  completedAt: string | null;
  owner: UserRef | null;
  createdBy: UserRef | null;
}

export interface CommentDto {
  id: string;
  certificateId: string;
  authorId: string;
  body: string;
  createdAt: string;
  author: UserRef | null;
}

export interface CertificatePermissions {
  isRequester: boolean;
  canApprove: boolean;
  canApproveAttachment: boolean;
  canEditRequest: boolean;
  canSubmit: boolean;
  canCancelRequest: boolean;
  canRenew: boolean;
  canCorrect: boolean;
  canAddAttachment: boolean;
  canManageRenewal: boolean;
  canArchive: boolean;
  canPreviewCurrent: boolean;
  canDownloadCurrent: boolean;
  canDownloadArchived: boolean;
}

export interface CertificateDetail {
  id: string;
  subjectKind: SubjectKind;
  vesselId: string | null;
  memberId: string | null;
  subject: Subject;
  type: CertificateTypeRef & {
    defaultValidityMonths: number | null;
    isActive: boolean;
    reminderPolicy: { id: string; name: string; thresholdsDays: number[]; frequency: ReminderFrequency } | null;
    validatorsConfigured: number;
  };
  validity: ValidityStatus | null;
  validityLabel: string | null;
  daysToExpiry: number | null;
  expiringSoonDays: number;
  documentMissing: boolean;
  documentRequired: boolean;
  currentRevision: (RevisionDto & { officialAttachment: AttachmentDto | null }) | null;
  archivedRevisions: RevisionDto[];
  requests: RequestDto[];
  openRequestId: string | null;
  pendingAttachmentRequestId: string | null;
  /** Résumés des demandes ouvertes (sans données de version : brouillon d'un autre utilisateur masqué) */
  openRequest?: OpenRequestSummary | null;
  pendingAttachmentRequest?: OpenRequestSummary | null;
  attachments: AttachmentDto[];
  renewal: {
    status: RenewalStatus;
    owner: UserRef | null;
    dueOn: string | null;
    activeTask: RenewalTaskDto | null;
    history: RenewalTaskDto[];
  };
  comments: CommentDto[];
  createdBy: UserRef | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  archivedBy: UserRef | null;
  archiveReason: string | null;
  permissions: CertificatePermissions;
}

/** Ligne de GET /certificate-requests (boîte des demandes). */
export interface RequestListItem {
  id: string;
  kind: RequestKind;
  status: ApprovalStatus;
  statusLabel: string;
  version: number;
  submittedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
  escalatedAt: string | null;
  requestedBy: UserRef;
  decidedBy: UserRef | null;
  certificate: {
    id: string;
    subjectKind: SubjectKind;
    subject: Subject;
    type: { id: string; code: string; name: string };
    currentNumber: string | null;
  };
  proposed: {
    versionNo: number;
    certificateNumber: string | null;
    expiryKind: ExpiryKind;
    expiryOn: string | null;
    hasFile: boolean;
  } | null;
  canDecide: boolean;
}

/** Résultat des commandes de workflow (création, renouvellement, correction, soumission…). */
export interface WorkflowResult {
  certificateId?: string;
  request?: { id: string; certificateId: string; kind: RequestKind; status: ApprovalStatus; version: number };
  notifiedValidators?: number;
  warnings?: string[];
  /** Publication directe (certificates.self_approve) : aucune validation requise */
  autoApproved?: boolean;
}

export interface PrincipalDto {
  id?: string;
  principalType: PrincipalType;
  principalId: string;
  label: string | null;
}

export interface CertificateTypeDto {
  id: string;
  code: string;
  name: string;
  subjectKind: SubjectKind;
  category: string;
  description: string | null;
  defaultValidityMonths: number | null;
  requiresDocument: boolean;
  allowMultiple: boolean;
  reminderPolicyId: string | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  reminderPolicy: { id: string; name: string; thresholdsDays: number[]; frequency: ReminderFrequency } | null;
  certificateCount: number;
  /** null pour un non-gestionnaire (noms des principaux masqués) : voir validatorCount */
  validators: PrincipalDto[] | null;
  validatorCount?: number;
}

export interface ReminderPolicyDto {
  id: string;
  name: string;
  thresholdsDays: number[];
  frequency: ReminderFrequency;
  customIntervalDays: number | null;
  postExpiryIntervalDays: number | null;
  postExpiryMaxReminders: number | null;
  unknownExpiryIntervalDays: number | null;
  missingDocumentIntervalDays: number | null;
  approvalOverdueHours: number | null;
  escalationRoleId: string | null;
  escalationRole: { id: string; name: string | null } | null;
  createdAt: string;
  updatedAt: string;
  /** null pour un non-gestionnaire : voir recipientCount */
  recipients: PrincipalDto[] | null;
  recipientCount?: number;
  types: { id: string; code: string; name: string; subjectKind: SubjectKind }[];
}

export interface ReminderRunResult {
  jobRunId: string;
  asOf: string;
  certificatesScanned: number;
  certificatesWithoutPolicy: number;
  alerts: Partial<Record<'EXPIRY' | 'EXPIRED' | 'UNKNOWN_EXPIRY' | 'MISSING_DOCUMENT', number>>;
  notificationsCreated: number;
  approvalReminders: number;
  escalations: number;
  errors: number;
}

// -----------------------------------------------------------------------------
// Libellés FR (casse de phrase)
// -----------------------------------------------------------------------------

export const SUBJECT_KIND_LABELS: Record<SubjectKind, string> = {
  VESSEL: 'Navire',
  MEMBER: 'Marin',
};

export const REQUEST_KIND_LABELS: Record<RequestKind, string> = {
  CREATE: 'Création',
  RENEWAL: 'Renouvellement',
  CORRECTION: 'Correction',
  ATTACHMENT: 'Pièce jointe',
};

export const EXPIRY_KIND_LABELS: Record<ExpiryKind, string> = {
  DATED: "Date d'expiration",
  UNLIMITED: 'Illimité',
  UNKNOWN: 'Date inconnue',
};

export const DECISION_LABELS: Record<DecisionKind, string> = {
  APPROVE: 'Approuvée',
  REJECT: 'Refusée',
  RETURN: 'Retournée pour correction',
};

export const FREQUENCY_LABELS: Record<ReminderFrequency, string> = {
  AT_THRESHOLDS: 'Aux seuils uniquement',
  DAILY: 'Quotidienne',
  WEEKLY: 'Hebdomadaire',
  CUSTOM: 'Personnalisée',
};

export const PRINCIPAL_TYPE_LABELS: Record<PrincipalType, string> = {
  USER: 'Utilisateur',
  ROLE: 'Rôle',
  DEPARTMENT: 'Département',
};

export const OPEN_STATUSES: ApprovalStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'];

export const DATA_FIELD_LABELS: Record<keyof CertificateData, string> = {
  certificateNumber: 'Numéro',
  issuer: 'Émetteur',
  authority: 'Autorité',
  country: 'Pays',
  placeOfIssue: "Lieu d'émission",
  issuedOn: "Date d'émission",
  validFrom: 'Valide à partir du',
  expiryKind: "Type d'échéance",
  expiryOn: "Date d'expiration",
  remarks: 'Remarques',
};

export const DATA_KEYS = Object.keys(DATA_FIELD_LABELS) as (keyof CertificateData)[];
