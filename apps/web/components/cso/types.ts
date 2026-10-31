/**
 * Types CSO (miroir des présentateurs de l'API : apps/api/src/modules/cso/cso-presenters.ts).
 * L'UI n'affiche que ce que l'API renvoie : zones / champs non autorisés sont absents des réponses.
 */

export type CsoAction =
  | 'view'
  | 'preview'
  | 'download'
  | 'view_archived'
  | 'download_archived'
  | 'edit'
  | 'folder_create'
  | 'folder_rename'
  | 'folder_move'
  | 'folder_archive'
  | 'acl_manage'
  | 'approve'
  | 'restore'
  | 'share';

export const CSO_ACTIONS: CsoAction[] = [
  'view',
  'preview',
  'download',
  'view_archived',
  'download_archived',
  'edit',
  'folder_create',
  'folder_rename',
  'folder_move',
  'folder_archive',
  'acl_manage',
  'approve',
  'restore',
  'share',
];

/** Libellés lisibles des droits effectifs (affichés à l'utilisateur — CDC §5.3 « permissions visibles »). */
export const CSO_ACTION_LABELS: Record<CsoAction, string> = {
  view: 'Consulter',
  preview: 'Aperçu',
  download: 'Télécharger',
  view_archived: 'Consulter les archives',
  download_archived: 'Télécharger les archives',
  edit: 'Déposer / modifier',
  folder_create: 'Créer des dossiers',
  folder_rename: 'Renommer',
  folder_move: 'Déplacer',
  folder_archive: 'Archiver des dossiers',
  acl_manage: 'Gérer les accès',
  approve: 'Approuver',
  restore: 'Restaurer',
  share: 'Partager',
};

export const CSO_DOC_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Non publié',
  PUBLISHED: 'Publié',
  ARCHIVED: 'Archivé',
};

export const CSO_FOLDER_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Actif',
  ARCHIVED: 'Archivé',
};

export const PRINCIPAL_TYPE_LABELS: Record<PrincipalType, string> = {
  USER: 'Utilisateur',
  ROLE: 'Rôle',
  DEPARTMENT: 'Département',
};

export const STANDARD_FIELD_LABELS: Record<string, string> = {
  description: 'Description',
  nextReviewOn: 'Prochaine révision',
  expiryOn: 'Expiration',
  reference: 'Référence',
};
export const STANDARD_FIELDS = ['description', 'nextReviewOn', 'expiryOn', 'reference'] as const;

export const FIELD_TYPE_LABELS: Record<string, string> = {
  TEXT: 'Texte',
  NUMBER: 'Nombre',
  DATE: 'Date',
  SELECT: 'Liste de choix',
  BOOLEAN: 'Oui / non',
};

export type PrincipalType = 'USER' | 'ROLE' | 'DEPARTMENT';

export interface UserLabel {
  id: string;
  displayName: string | null;
}

export interface CsoLibrary {
  id: string;
  kind: 'CENTRAL' | 'VESSEL';
  name: string;
  vessel: { id: string; code: string; name: string; status?: string } | null;
  canCreateRootFolder?: boolean;
}

export interface CsoTreeNode {
  id: string;
  name: string;
  status: 'ACTIVE' | 'ARCHIVED';
  depth: number;
  actions: CsoAction[];
  children: CsoTreeNode[];
}

export interface CsoFolder {
  id: string;
  libraryId: string;
  parentId: string | null;
  name: string;
  depth: number;
  status: 'ACTIVE' | 'ARCHIVED';
  inheritAcl: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  actions?: CsoAction[];
}

export interface Breadcrumb {
  items: { id: string; name: string }[];
  truncated: boolean;
}

export interface CsoFolderDetail extends CsoFolder {
  library: CsoLibrary;
  breadcrumb: Breadcrumb;
}

export interface EffectiveAccess {
  actions: CsoAction[];
  map: Record<CsoAction, boolean>;
  status: string;
  viaShare?: boolean;
  folderId?: string;
  documentId?: string;
}

export interface CsoFileInfo {
  originalName: string;
  kind: string;
  mimeType: string;
  extension: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number | null;
  scanStatus: string;
}

export type CsoVersionStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'RETURNED' | 'REJECTED' | 'PUBLISHED' | 'SUPERSEDED' | 'CANCELLED';

export interface CsoVersion {
  id: string;
  documentId: string;
  versionNo: number;
  status: CsoVersionStatus;
  changeNote: string | null;
  isRestoration: boolean;
  lockVersion: number;
  submittedBy: UserLabel;
  submittedAt: string | null;
  decidedBy: UserLabel | null;
  decidedAt: string | null;
  decisionComment: string | null;
  publishedAt: string | null;
  supersededAt: string | null;
  createdAt: string;
  file: CsoFileInfo | null;
}

export interface CsoCategoryRef {
  id: string;
  code: string;
  name: string;
  referenceMode?: 'AUTO' | 'MANUAL';
}

export interface CsoDocumentSummary {
  id: string;
  libraryId: string;
  folderId: string;
  vesselId: string | null;
  reference: string | null;
  title: string;
  description: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  category: CsoCategoryRef | null;
  author: UserLabel;
  currentVersionId: string | null;
  nextReviewOn: string | null;
  expiryOn: string | null;
  inheritAcl: boolean;
  copiedFromId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  actions?: CsoAction[];
  viaShare?: boolean;
}

/** Document archivé : APPROVAL = nouvelle approbation ; DRAFT = jamais approuvé, restauré en brouillon (CSO-03). */
export type CsoRestoreMode = 'APPROVAL' | 'DRAFT';

export interface CsoDocumentListItem extends CsoDocumentSummary {
  currentVersion: CsoVersion | null;
  restoreMode?: CsoRestoreMode | null;
}

export interface CsoCustomFieldValue {
  fieldId: string;
  key: string;
  label: string;
  type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN';
  options: string[] | null;
  required: boolean;
  isConfidential: boolean;
  archived: boolean;
  value: string | number | boolean | null;
  updatedAt: string | null;
  canEdit: boolean;
}

export interface CsoDocumentDetail extends CsoDocumentSummary {
  library: CsoLibrary;
  folder: { id: string; name: string | null };
  breadcrumb: Breadcrumb;
  currentVersion: CsoVersion | null;
  pendingVersion: CsoVersion | null;
  versions: CsoVersion[];
  customFields: CsoCustomFieldValue[];
  pendingReferenceChange: {
    id: string;
    oldReference: string | null;
    newReference: string;
    reason: string | null;
    requestedBy: UserLabel | null;
    createdAt: string;
  } | null;
  copiedFrom: { id: string; reference: string | null; title: string } | null;
  restoreMode?: CsoRestoreMode | null;
}

export interface CsoReferenceChange {
  id: string;
  documentId: string;
  oldReference: string | null;
  newReference: string;
  reason: string | null;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedBy: UserLabel | null;
  decidedBy: UserLabel | null;
  decidedAt: string | null;
  decisionComment: string | null;
  createdAt: string;
}

export interface CsoCategory {
  id: string;
  code: string;
  name: string;
  scope: 'FLEET' | 'VESSEL';
  vesselId: string | null;
  referenceMode: 'AUTO' | 'MANUAL';
  referenceFormat: string | null;
  requiredFields: string[];
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  activeFieldCount?: number;
}

export interface CsoFieldDefinition {
  id: string;
  categoryId: string | null;
  key: string;
  label: string;
  type: 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN';
  options: string[] | null;
  required: boolean;
  isConfidential: boolean;
  sortOrder: number;
  archivedAt: string | null;
  archived: boolean;
  aclEntryCount?: number;
  createdAt: string;
}

export interface AclEntry {
  id?: string;
  principalType: PrincipalType;
  principalId: string;
  principalLabel?: string | null;
  actions: CsoAction[];
  effect: 'ALLOW' | 'DENY';
  createdAt?: string;
}

export interface AclView {
  kind: 'folder' | 'document';
  id: string;
  inheritAcl: boolean;
  entries: AclEntry[];
  inherited: { folderId: string; folderName: string | null; inheritAcl: boolean; entries: AclEntry[] }[];
}

export interface ValidatorsView {
  folderId: string;
  validators: { principalType: PrincipalType; principalId: string; label: string | null }[];
  effective: {
    fromFolderId: string;
    inherited: boolean;
    validators: { principalType: PrincipalType; principalId: string; label: string | null }[];
  } | null;
  fallbackToApprovePermission: boolean;
}

export interface CsoShare {
  id: string;
  documentId: string;
  sharedById: string;
  recipientUserId: string | null;
  recipientDepartmentId: string | null;
  message: string | null;
  allowDownload: boolean;
  createdAt: string;
  revokedAt: string | null;
  revokedById: string | null;
  sharedByName: string | null;
  recipientName: string | null;
  revokedByName: string | null;
}

export interface SharedWithMeItem {
  id: string;
  message: string | null;
  allowDownload: boolean;
  canDownload: boolean;
  canPreview: boolean;
  createdAt: string;
  sharedBy: UserLabel | null;
  document: { id: string; title: string; reference: string | null; vesselId: string | null; updatedAt: string; fileKind: string | null };
}

export interface ApprovalsInbox {
  versions: { document: CsoDocumentSummary; version: CsoVersion }[];
  referenceChanges: { id: string; documentId: string; oldReference: string | null; newReference: string; reason: string | null; createdAt: string }[];
}

export interface CsoSearchItem extends CsoDocumentSummary {
  rank: number;
  library: CsoLibrary;
  folder: { id: string; name: string } | null;
}

export interface ZipJob {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIALLY_FAILED' | 'FAILED' | 'CANCELLED';
  format: string;
  itemCount: number | null;
  excludedCount: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  link?: { url: string; fileName: string; expiresAt: string } | null;
}

export interface CsoHistoryEvent {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  result: 'SUCCESS' | 'DENIED' | 'FAILURE';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

// -----------------------------------------------------------------------------
// Import en masse (CSO-033/034)
// -----------------------------------------------------------------------------

export type ImportRowStatus = 'PENDING' | 'VALID' | 'INVALID' | 'DUPLICATE_SUSPECTED' | 'APPLIED' | 'SKIPPED' | 'FAILED';
export type ImportDecision = 'PENDING' | 'CREATE' | 'IGNORE' | 'CREATE_INDEPENDENT' | 'SUBMIT_NEW_VERSION';

export const IMPORT_ROW_STATUS_LABELS: Record<string, string> = {
  PENDING: 'En analyse',
  VALID: 'Valide',
  INVALID: 'Invalide',
  DUPLICATE_SUSPECTED: 'Doublon suspecté',
  APPLIED: 'Appliqué',
  SKIPPED: 'Ignoré',
  FAILED: 'En échec',
};

export const IMPORT_DECISION_LABELS: Record<string, string> = {
  PENDING: 'À décider',
  CREATE: 'Créer',
  IGNORE: 'Ignorer',
  CREATE_INDEPENDENT: 'Créer un document indépendant',
  SUBMIT_NEW_VERSION: 'Soumettre comme nouvelle version',
};

export const IMPORT_PHASE_LABELS: Record<string, string> = {
  UPLOADED: 'Déposé',
  MAPPING: 'Analyse',
  PREVIEW_READY: 'Prévisualisation prête',
  COMMITTING: 'Application en cours',
  COMMITTED: 'Appliqué',
};

export const JOB_STATUS_LABELS: Record<string, string> = {
  QUEUED: 'En attente',
  RUNNING: 'En cours',
  COMPLETED: 'Terminé',
  PARTIALLY_FAILED: 'Terminé avec erreurs',
  FAILED: 'Échec',
  CANCELLED: 'Annulé',
};

export const DUPLICATE_REASON_LABELS: Record<string, string> = {
  REFERENCE: 'Même référence',
  SAME_NAME_IN_FOLDER: 'Même nom dans le dossier',
  CONTENT_HASH: 'Contenu identique (SHA-256)',
};

export interface ImportNormalized {
  path: string;
  folderSegments: string[];
  fileName: string;
  entryIndex: number | null;
  sha256: string | null;
  sizeBytes: number;
  kind: string | null;
  title: string;
  reference: string | null;
  categoryId: string | null;
  description: string | null;
  nextReviewOn: string | null;
  expiryOn: string | null;
}

export interface DuplicateCandidate {
  documentId: string;
  reference: string | null;
  title: string;
  status: string;
  folderName: string | null;
  versionCount: number;
  currentVersionNo: number | null;
  reasons: ('REFERENCE' | 'SAME_NAME_IN_FOLDER' | 'CONTENT_HASH')[];
}

export interface ImportRow {
  id: string;
  jobId: string;
  rowNumber: number;
  raw: { path?: string; sizeBytes?: number; metadataRow?: number | null } | null;
  normalized: ImportNormalized | null;
  errors: string[] | null;
  warnings: string[] | null;
  duplicateCandidates: DuplicateCandidate[] | null;
  status: ImportRowStatus;
  decision: ImportDecision;
  decisionTargetId: string | null;
  appliedEntityId: string | null;
  appliedAt: string | null;
  errorMessage: string | null;
}

export interface ImportJob {
  id: string;
  kind: string;
  status: string;
  phase: string;
  sourceFileId: string;
  metadataFileId: string | null;
  vesselId: string | null;
  targetFolderId: string | null;
  options: { defaultCategoryId?: string | null } | null;
  summary: {
    entries?: number;
    directories?: number;
    ignoredSystemEntries?: number;
    valid?: number;
    invalid?: number;
    duplicatesSuspected?: number;
    metadataRows?: number;
    unmatchedMetadataRows?: number[];
    commit?: { applied: number; skipped: number; failed: number; alreadyApplied: number; remainingFailed: number; at: string };
  } | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  rowCounts?: Record<string, number>;
  pendingDecisions?: number;
}
