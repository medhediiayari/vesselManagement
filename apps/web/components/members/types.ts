import type { StoredFileDto } from '@/lib/api';

/**
 * Contrats de l'API Members & Crew (apps/api/src/modules/members) côté web.
 * Les formes suivent exactement les réponses des services (dates civiles en AAAA-MM-JJ).
 */

export type MemberStatus = 'ON_BOARD' | 'AVAILABLE' | 'ON_LEAVE' | 'PLANNED_JOIN' | 'INACTIVE';
export type ManualMemberStatus = 'AVAILABLE' | 'ON_LEAVE' | 'INACTIVE';
export type CrewDepartment = 'DECK' | 'ENGINE' | 'CATERING' | 'OTHER';
export type AssignmentStatus = 'PLANNED' | 'ONBOARD' | 'COMPLETED' | 'CANCELLED';
export type CustomFieldType = 'TEXT' | 'NUMBER' | 'DATE' | 'SELECT' | 'BOOLEAN';
export type Gender = 'M' | 'F' | 'X';

export interface VesselMini {
  id: string;
  code: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Fiches
// ---------------------------------------------------------------------------

export interface MemberListItem {
  id: string;
  amcRef: string | null;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  nationality: string | null;
  rank: string | null;
  crewDepartment: CrewDepartment | null;
  status: MemberStatus;
  photoFileId: string | null;
  archivedAt: string | null;
  updatedAt: string;
  currentAssignments: {
    id: string;
    status: AssignmentStatus;
    rank: string;
    plannedJoinDate: string | null;
    actualJoinDate: string | null;
    /** Fin de contrat prévue (débarquement planifié) */
    plannedSignOffDate: string | null;
    vessel: VesselMini;
  }[];
  seamanBookNumber: string | null;
  seamanBookExpiry: string | null;
  /** Absent sans la permission members.certificates.view */
  certificateSummary?: MemberCertificateCounts;
  /** Avec withCertificates=true : certificats courants (vue matrice) */
  certificates?: MemberMatrixCertificate[];
}

export interface MemberMatrixCertificate {
  id: string;
  typeCode: string;
  validity: MemberCertificateSummary['validity'];
  expiryKind: MemberCertificateSummary['expiryKind'];
  expiryOn: string | null;
}

/** Métadonnées de la liste avec withCertificates=true : types en colonnes, ordre du référentiel. */
export interface MemberMatrixMeta {
  certificateTypes?: { id: string; code: string; name: string; category: string }[];
}

/** Répartition des certificats courants d'un marin par validité (mêmes règles que la fiche). */
export interface MemberCertificateCounts {
  total: number;
  valid: number;
  unlimited: number;
  expiringSoon: number;
  expired: number;
  expiryUnknown: number;
  notApproved: number;
  documentMissing: number;
}

/** GET /members/stats : population visible (ADM-070), fiches non archivées. */
export interface MemberStats {
  total: number;
  byStatus: Partial<Record<MemberStatus, number>>;
  /** Seuil « expire bientôt » paramétré (certificates.expiringSoonDays) */
  expiringSoonDays: number;
  certificates?: { expired: number; expiringSoon: number; documentMissing: number; membersConcerned: number };
}

export interface MemberCore {
  id: string;
  amcRef: string | null;
  firstName: string;
  lastName: string;
  birthDate: string | null;
  birthPlace: string | null;
  nationality: string | null;
  gender: Gender | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  passportNumber: string | null;
  passportCountry: string | null;
  passportExpiry: string | null;
  seamanBookNumber: string | null;
  seamanBookExpiry: string | null;
  rank: string | null;
  crewDepartment: CrewDepartment | null;
  status: MemberStatus;
  departmentId: string | null;
  photoFileId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface SelectOptions {
  choices?: string[];
  multiple?: boolean;
}

export interface CustomFieldValue {
  id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  options: SelectOptions | null;
  required: boolean;
  value: unknown;
  updatedAt: string | null;
  editable: boolean;
}

export interface CustomFieldSectionValues {
  id: string | null;
  name: string;
  sortOrder: number;
  fields: CustomFieldValue[];
}

export interface MemberAssignment {
  id: string;
  vessel: VesselMini;
  voyage: { id: string; reference: string } | null;
  rank: string;
  position: string | null;
  status: AssignmentStatus;
  plannedJoinDate: string | null;
  actualJoinDate: string | null;
  plannedSignOffDate: string | null;
  actualSignOffDate: string | null;
  joinPort: string | null;
  signOffPort: string | null;
  relievesAssignmentId: string | null;
  updatedAt: string;
}

export interface MemberCertificateSummary {
  id: string;
  type: { code: string; name: string; category: string | null };
  number: string | null;
  expiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN' | null;
  expiryOn: string | null;
  validity: 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNLIMITED' | 'EXPIRY_UNKNOWN' | 'NOT_APPROVED';
  documentMissing: boolean;
  openRequests: { id: string; kind: string; status: string; version: number }[];
}

export interface MemberDetail extends MemberCore {
  department: { id: string; code: string; name: string; status: string } | null;
  photo: StoredFileDto | null;
  linkedUser: {
    id: string;
    displayName: string;
    status: string;
    username?: string;
    email?: string | null;
    lastLoginAt?: string | null;
  } | null;
  customFields: CustomFieldSectionValues[];
  currentAssignments: MemberAssignment[];
  assignmentHistory: MemberAssignment[];
  assignmentScope: 'FULL' | 'ACCESSIBLE_VESSELS';
  documentsCount: number;
  certificates?: MemberCertificateSummary[];
  protectedFields: string[];
  permissions: { canEdit: boolean; canEditProtected: boolean; canAssign: boolean; canDownloadDocuments: boolean };
}

export interface MemberSelfDetail extends MemberDetail {
  selfEditableFields: string[];
  selfEditableCustomFields: string[];
}

export interface DuplicateCandidate {
  memberId: string;
  score: number;
  reasons: string[];
  reasonLabels: string[];
  archived: boolean;
  visible: boolean;
  member: {
    id: string;
    amcRef: string | null;
    firstName: string;
    lastName: string;
    birthDate: string | null;
    nationality: string | null;
    passportNumber: string | null;
    seamanBookNumber: string | null;
    rank: string | null;
    status: MemberStatus;
    archivedAt: string | null;
  } | null;
}

export interface MemberDocument {
  id: string;
  memberId: string;
  fileId: string;
  category: string;
  title: string;
  uploadedById: string | null;
  createdAt: string;
  archivedAt: string | null;
  file: StoredFileDto | null;
}

export interface MemberHistoryEvent {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Affectations & roster
// ---------------------------------------------------------------------------

export interface CrewAssignmentDto {
  id: string;
  memberId: string;
  vesselId: string;
  voyageId: string | null;
  rank: string;
  position: string | null;
  status: AssignmentStatus;
  plannedJoinDate: string | null;
  actualJoinDate: string | null;
  plannedSignOffDate: string | null;
  actualSignOffDate: string | null;
  joinPort: string | null;
  signOffPort: string | null;
  relievesAssignmentId: string | null;
  notes: string | null;
  updatedAt: string;
  vessel: VesselMini;
  voyage: { id: string; reference: string } | null;
  member: {
    id: string;
    amcRef: string | null;
    firstName: string;
    lastName: string;
    nationality: string | null;
    rank: string | null;
    crewDepartment: CrewDepartment | null;
    status: MemberStatus;
    photoFileId: string | null;
  };
  /** Roster : fiche consultable par l'utilisateur (ADM-070) */
  memberAccessible?: boolean;
  warnings?: string[];
}

export interface Roster {
  vessel: VesselMini & { status: string };
  date: string | null;
  onboard: CrewAssignmentDto[];
  planned: CrewAssignmentDto[];
  counts: { onboard: number; planned: number };
}

// ---------------------------------------------------------------------------
// Champs personnalisés (administration)
// ---------------------------------------------------------------------------

export interface FieldDefinition {
  id: string;
  sectionId: string | null;
  key: string;
  label: string;
  type: CustomFieldType;
  options: SelectOptions | null;
  required: boolean;
  sortOrder: number;
  viewPermission: string | null;
  editPermission: string | null;
  selfEditable: boolean;
  archivedAt: string | null;
  createdAt: string;
  valuesCount: number;
}

export interface FieldSection {
  id: string;
  name: string;
  sortOrder: number;
  archivedAt: string | null;
  createdAt: string;
  fields: FieldDefinition[];
}

export interface FieldConfig {
  sections: FieldSection[];
  unsectioned: FieldDefinition[];
}

// ---------------------------------------------------------------------------
// Import Excel
// ---------------------------------------------------------------------------

export type ImportJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'PARTIALLY_FAILED' | 'FAILED' | 'CANCELLED';
export type ImportPhase = 'UPLOADED' | 'MAPPING' | 'PREVIEW_READY' | 'COMMITTING' | 'COMMITTED';
export type ImportRowStatus = 'PENDING' | 'VALID' | 'INVALID' | 'DUPLICATE_SUSPECTED' | 'APPLIED' | 'SKIPPED' | 'FAILED';
export type ImportDecision = 'PENDING' | 'CREATE' | 'UPDATE' | 'IGNORE' | 'CORRECT';

export interface DiscoveredColumn {
  letter: string;
  index: number;
  header: string;
  samples: string[];
  suggested: string | null;
}

export interface DiscoveredSheet {
  name: string;
  rowCount: number;
  headerRow: number;
  headerRowCount: 1 | 2;
  columns: DiscoveredColumn[];
  suggestedMapping: Record<string, string>;
  suggestedDefaults: { crewDepartment?: CrewDepartment };
  suggestedInclude: boolean;
}

export interface AppliedSheetMapping {
  name: string;
  include: boolean;
  headerRow: number;
  headerRowCount: 1 | 2;
  columns: { letter: string; header: string; target: string }[];
  defaults?: { rank?: string; crewDepartment?: CrewDepartment; vesselId?: string };
}

export interface PreviewSummary {
  totalRows: number;
  valid: number;
  invalid: number;
  duplicateSuspected: number;
  blankRowsIgnored: number;
  existingMemberMatches: number;
  inFileDuplicates: number;
  sheets: { name: string; rows: number; blank: number; valid: number; invalid: number; duplicateSuspected: number }[];
  certificates: { total: number; byCode: Record<string, number>; dated: number; unlimited: number; unknownExpiry: number; expired: number };
  assignmentsDetected: number;
}

export interface CommitRun {
  created: number;
  updated: number;
  ignored: number;
  skippedInvalid: number;
  failed: number;
  alreadyApplied: number;
  certificateRequests: number;
  certificatesSkipped: number;
  assignments: number;
  status?: ImportJobStatus;
  at?: string;
}

export interface ImportJob {
  id: string;
  kind: 'MEMBERS';
  status: ImportJobStatus;
  phase: ImportPhase;
  sourceFile: { id: string; originalName: string; sizeBytes: number; sha256: string } | null;
  vesselId: string | null;
  sheets: DiscoveredSheet[];
  mapping: AppliedSheetMapping[] | null;
  createAssignments: boolean;
  defaultVesselId: string | null;
  summary: { preview?: PreviewSummary; commit?: CommitRun; commitRuns?: CommitRun[] } | null;
  counts: {
    byStatus: Partial<Record<ImportRowStatus, number>>;
    byDecision: Partial<Record<ImportDecision, number>>;
    pendingDuplicateDecisions: number;
  };
  canCommit: boolean;
  errorMessage: string | null;
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ImportJobListItem {
  id: string;
  status: ImportJobStatus;
  phase: ImportPhase;
  sourceFile: { id: string; originalName: string } | null;
  summary: ImportJob['summary'];
  createdBy: { id: string; displayName: string } | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RowIssue {
  column?: string;
  field?: string;
  message: string;
}

export interface FieldDiff {
  field: string;
  current: unknown;
  imported: unknown;
  changed: boolean;
  protected: boolean;
}

export interface ImportMemberSummary {
  id: string;
  amcRef: string | null;
  lastName: string;
  firstName: string;
  birthDate: string | null;
  passportNumber: string | null;
  seamanBookNumber: string | null;
  rank: string | null;
  status: MemberStatus;
  archived: boolean;
}

export type ImportCandidate =
  | {
      kind: 'MEMBER';
      memberId: string;
      score: number;
      reasons: string[];
      reasonLabels: string[];
      archived?: boolean;
      visible: boolean;
      member: ImportMemberSummary | null;
      diff: FieldDiff[] | null;
    }
  | { kind: 'ROW'; rowId: string; sheetName: string; rowNumber: number; score: number; reasons: string[]; reasonLabels: string[] };

export interface ImportedCertificate {
  code: string;
  number: string | null;
  expiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN';
  expiryOn: string | null;
  issuedOn: string | null;
  columns: string[];
}

export interface ImportRow {
  id: string;
  sheetName: string;
  rowNumber: number;
  status: ImportRowStatus;
  decision: ImportDecision;
  decisionTargetId: string | null;
  decisionTarget: ImportMemberSummary | null;
  decisionTargetDiff: FieldDiff[] | null;
  decisionReason: string | null;
  decidedBy: { id: string; displayName: string } | null;
  decidedAt: string | null;
  appliedEntityId: string | null;
  appliedAt: string | null;
  errorMessage: string | null;
  raw: { column: string; header: string; value: unknown }[];
  normalized: {
    member: Partial<Record<string, string>>;
    certificates: ImportedCertificate[];
    assignment: { joinDate: string | null; signOffDate: string | null; vesselText: string | null } | null;
    vesselId?: string | null;
    vesselLabel?: string | null;
    corrections?: Record<string, { from: unknown; to: unknown }>;
    outcome?: {
      memberId: string;
      action: 'CREATED' | 'UPDATED';
      changedFields: string[];
      certificates: { code: string; result: 'REQUEST_CREATED' | 'SKIPPED'; reason?: string }[];
      assignment?: { result: 'CREATED' | 'SKIPPED'; reason?: string };
    };
  };
  errors: RowIssue[];
  warnings: RowIssue[];
  candidates: ImportCandidate[];
}

// ---------------------------------------------------------------------------
// Libellés (sentence case, FR)
// ---------------------------------------------------------------------------

export const CREW_DEPARTMENT_LABELS: Record<CrewDepartment, string> = {
  DECK: 'Pont',
  ENGINE: 'Machine',
  CATERING: 'Catering',
  OTHER: 'Autre',
};

export const GENDER_LABELS: Record<Gender, string> = { M: 'Homme', F: 'Femme', X: 'Non précisé' };

export const MANUAL_STATUS_LABELS: Record<ManualMemberStatus, string> = {
  AVAILABLE: 'Disponible',
  ON_LEAVE: 'En congé',
  INACTIVE: 'Inactif',
};

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  PLANNED: 'Planifié',
  ONBOARD: 'À bord',
  COMPLETED: 'Débarqué',
  CANCELLED: 'Annulé',
};

export const IMPORT_JOB_STATUS_LABELS: Record<ImportJobStatus, string> = {
  QUEUED: 'En cours de préparation',
  RUNNING: 'Validation en cours',
  COMPLETED: 'Terminé',
  PARTIALLY_FAILED: 'Terminé avec erreurs',
  FAILED: 'Échec',
  CANCELLED: 'Annulé',
};

export const IMPORT_PHASE_LABELS: Record<ImportPhase, string> = {
  UPLOADED: 'Fichier déposé',
  MAPPING: 'Mapping à définir',
  PREVIEW_READY: 'Prévisualisation prête',
  COMMITTING: 'Validation en cours',
  COMMITTED: 'Validé',
};

export const IMPORT_ROW_STATUS_LABELS: Record<ImportRowStatus, string> = {
  PENDING: 'En attente',
  VALID: 'Valide',
  INVALID: 'Invalide',
  DUPLICATE_SUSPECTED: 'Doublon suspecté',
  APPLIED: 'Appliquée',
  SKIPPED: 'Non importée',
  FAILED: 'Échec',
};

export const IMPORT_DECISION_LABELS: Record<ImportDecision, string> = {
  PENDING: 'Sans décision',
  CREATE: 'Créer',
  UPDATE: 'Mettre à jour',
  IGNORE: 'Ignorer',
  CORRECT: 'Corrigée',
};

export const CUSTOM_FIELD_TYPE_LABELS: Record<CustomFieldType, string> = {
  TEXT: 'Texte',
  NUMBER: 'Nombre',
  DATE: 'Date',
  SELECT: 'Liste de choix',
  BOOLEAN: 'Oui / non',
};

/** Libellés des champs de fiche (formulaires, historique, diff d'import). */
export const MEMBER_FIELD_LABELS: Record<string, string> = {
  amcRef: 'Matricule AMC',
  lastName: 'Nom',
  firstName: 'Prénom',
  birthDate: 'Date de naissance',
  birthPlace: 'Lieu de naissance',
  nationality: 'Nationalité',
  gender: 'Genre',
  email: 'E-mail',
  phone: 'Téléphone',
  address: 'Adresse',
  emergencyContactName: "Contact d'urgence",
  emergencyContactPhone: "Téléphone d'urgence",
  passportNumber: 'N° de passeport',
  passportCountry: 'Pays émetteur du passeport',
  passportExpiry: 'Expiration du passeport',
  seamanBookNumber: 'N° de seaman book',
  seamanBookExpiry: 'Expiration du seaman book',
  rank: 'Fonction (rank)',
  crewDepartment: 'Service à bord',
  departmentId: 'Département',
  notes: 'Notes',
  status: 'Statut',
  photoFileId: 'Photo',
  archivedAt: 'Archivage',
  customFields: 'Champs personnalisés',
};

export const MEMBER_HISTORY_ACTION_LABELS: Record<string, string> = {
  'member.created': 'Fiche créée',
  'member.updated': 'Fiche modifiée',
  'member.self_updated': 'Coordonnées modifiées par la personne',
  'member.status_changed': 'Statut administratif modifié',
  'member.status_synced': 'Statut synchronisé avec les affectations',
  'member.archived': 'Fiche archivée',
  'member.restored': 'Fiche restaurée',
  'member.photo_changed': 'Photo modifiée',
};

/** Données personnelles protégées (miroir de PROTECTED_MEMBER_FIELDS côté API). */
export const PROTECTED_FIELDS = [
  'amcRef',
  'birthDate',
  'birthPlace',
  'nationality',
  'gender',
  'passportNumber',
  'passportCountry',
  'passportExpiry',
  'seamanBookNumber',
  'seamanBookExpiry',
] as const;

export const DOCUMENT_CATEGORIES = [
  "Pièce d'identité",
  'Contrat',
  'Médical',
  'Formation',
  'Livret / seaman book',
  'Correspondance',
  'Autre',
];

export function memberName(m: { lastName: string; firstName: string }): string {
  return `${m.lastName.toUpperCase()} ${m.firstName}`.trim();
}

/** Date du jour (UTC) au format AAAA-MM-JJ. */
export function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}
