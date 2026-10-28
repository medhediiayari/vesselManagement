import type { StoredFileDto } from '@/lib/api';

/** DTO Voyages / Charter Parties tels que renvoyés par l'API (dates ISO, décimaux en chaîne). */

export type VoyageStatus = 'DRAFT' | 'PLANNED' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';
export type PortCallType = 'LOAD' | 'DISCHARGE' | 'INTERMEDIATE' | 'BUNKERING';
export type NoticeStatus = 'PLANNED' | 'DRAFTED' | 'VALIDATED' | 'SENT' | 'CANCELLED';
export type TaskStatus = 'OPEN' | 'DONE' | 'CANCELLED';
export type InstructionStatus = 'DRAFT' | 'ISSUED' | 'SUPERSEDED';
export type CpStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'SUPERSEDED' | 'CANCELLED';
export type CpType = 'VOYAGE' | 'TIME' | 'BAREBOAT' | 'COA' | 'OTHER';
export type CpVersionKind = 'ORIGINAL' | 'ADDENDUM' | 'REVISION';
export type ApprovalStatus = 'DRAFT' | 'PENDING_APPROVAL' | 'RETURNED' | 'REJECTED' | 'APPROVED' | 'CANCELLED';

export interface VesselMini {
  id: string;
  code: string;
  name: string;
  imoNumber?: string | null;
  timezone?: string | null;
  status?: string;
}

export interface VoyageBase {
  id: string;
  reference: string;
  vesselId: string;
  status: VoyageStatus;
  charterer: string | null;
  broker: string | null;
  charterPartyId: string | null;
  /** true : une CP est rattachée mais l'utilisateur n'a pas charter_party.view */
  charterPartyRestricted?: boolean;
  description: string | null;
  laycanFrom: string | null;
  laycanTo: string | null;
  etd: string | null;
  eta: string | null;
  atd: string | null;
  ata: string | null;
  notes: string | null;
  closedAt: string | null;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface VoyageListItem extends VoyageBase {
  vessel: VesselMini;
  ports: { id: string; sequence: number; type: PortCallType; portName: string; country: string | null; eta: string | null; ata: string | null }[];
  _count: { cargos: number; tasks: number; notices: number; noonReports: number };
}

export interface VoyagePort {
  id: string;
  voyageId: string;
  sequence: number;
  type: PortCallType;
  portName: string;
  country: string | null;
  unlocode: string | null;
  berth: string | null;
  agentId: string | null;
  eta: string | null;
  ata: string | null;
  etd: string | null;
  atd: string | null;
  cargoOperations: string | null;
  notes: string | null;
  agent?: { id: string; name: string; role: string } | null;
}

export interface VoyageAgent {
  id: string;
  voyageId: string;
  role: string;
  name: string;
  city: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

export interface CargoRow {
  id: string;
  voyageId: string;
  commodity: string;
  description: string | null;
  qtyMinMt: string | null;
  qtyMaxMt: string | null;
  qtyActualMt: string | null;
  unit: string;
  quantityOption: string | null;
  stowageFactor: string | null;
  stowageFactorUnit: string | null;
  isDangerous: boolean;
  documentation: string | null;
  notes: string | null;
}

export interface PortRef {
  id: string;
  portName: string;
  sequence: number;
  type?: PortCallType;
}

export interface NoticeRow {
  id: string;
  voyageId: string;
  portId: string | null;
  kind: string;
  scheduleLabel: string | null;
  dueAt: string | null;
  recipients: string | null;
  draftBody: string | null;
  status: NoticeStatus;
  validatedById: string | null;
  validatedAt: string | null;
  sentAt: string | null;
  sentById: string | null;
  createdAt: string;
  validatedBy: string | null;
  sentBy: string | null;
  overdue?: boolean;
  port?: PortRef | null;
}

export interface NoticeEmail {
  to: string | null;
  subject: string | null;
  body: string | null;
  validated: boolean;
  notice: string;
}

export interface NorRow {
  id: string;
  voyageId: string;
  portId: string;
  tenderedAt: string;
  acceptedAt: string | null;
  acceptedBy: string | null;
  remarks: string | null;
  fileId: string | null;
  createdById: string;
  createdAt: string;
  createdBy?: string | null;
  port?: PortRef | null;
}

export interface TaskRow {
  id: string;
  voyageId: string;
  portId: string | null;
  title: string;
  description: string | null;
  category: string;
  assigneeId: string | null;
  dueAt: string | null;
  status: TaskStatus;
  completedAt: string | null;
  completedById: string | null;
  evidenceFileId: string | null;
  comment: string | null;
  sortOrder: number;
  createdAt: string;
  assignee: string | null;
  completedBy: string | null;
  canComplete?: boolean;
  port?: PortRef | null;
}

export type InstructionFieldValue = string | number | boolean | null | string[];

export interface InstructionRow {
  id: string;
  voyageId: string;
  versionNo: number;
  title: string;
  fileId: string | null;
  fields: Record<string, InstructionFieldValue> | null;
  notices: string | null;
  status: InstructionStatus;
  issuedById: string | null;
  issuedAt: string | null;
  createdById: string;
  createdAt: string;
  acknowledgements: number;
  acknowledgedByMe: string | null;
}

export interface AcknowledgementList {
  acknowledgements: { userId: string; displayName: string | null; ackAt?: string; acknowledgedAt?: string }[];
  pendingMasters: { userId: string; displayName: string | null }[];
}

export type CpSummary =
  | null
  | { linked: false }
  | {
      linked: true;
      id: string;
      reference: string;
      cpType: CpType;
      cpDate: string | null;
      status: CpStatus;
      charterer: string | null;
      owner: string | null;
      laycanFrom: string | null;
      laycanTo: string | null;
      currentVersion: { id: string; versionNo: number; kind: CpVersionKind; decidedAt: string | null; fileId: string | null } | null;
      pendingVersion: { id: string; versionNo: number; kind: CpVersionKind; submittedAt: string } | null;
      acknowledgedByMe: string | null;
    };

export interface NoonSummary {
  total: number;
  byStatus: Record<string, number>;
  latest: { id: string; reportType: string; reportDateUtc: string; utcOffsetMinutes: number; status: string; currentRevisionNo: number }[];
}

export interface VoyageFileRow {
  id: string;
  voyageId: string;
  fileId: string;
  category: string;
  title: string;
  uploadedById: string;
  createdAt: string;
  uploadedBy: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  file: StoredFileDto | null;
}

export interface TimelineEvent {
  at: string;
  kind: string;
  label: string;
  actor?: string | null;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
}

export interface VoyageWorkspace {
  overview: VoyageBase & { vessel: VesselMini; route: string | null };
  ports: VoyagePort[];
  agents: VoyageAgent[];
  cargo: CargoRow[];
  notices: NoticeRow[];
  nor: NorRow[];
  charterParty: CpSummary;
  instructions: InstructionRow[];
  noonReports: NoonSummary | null;
  files: VoyageFileRow[];
  tasks: TaskRow[];
  timeline: TimelineEvent[];
  permissions: { edit: boolean; activate: boolean; close: boolean; manageInstructions: boolean; allowedTransitions: VoyageStatus[] };
}

export interface CertificateCheck {
  available: boolean;
  reason?: string;
  informativeOnly?: boolean;
  disclaimer: string;
  voyageEnd?: string | null;
  voyageEndBasis?: 'ATA' | 'ETA' | 'PORT_SCHEDULE' | 'LAYCAN_TO' | null;
  checkedCertificates?: number;
  counts?: { expired: number; expiringBeforeVoyageEnd: number; expiryUnknown: number };
  items?: {
    id: string;
    currentNumber: string | null;
    currentExpiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN' | null;
    currentExpiryOn: string | null;
    documentMissing: boolean;
    type: { code: string; name: string; category: string };
    flag: 'EXPIRED' | 'EXPIRES_BEFORE_VOYAGE_END' | 'EXPIRY_UNKNOWN';
  }[];
}

// -----------------------------------------------------------------------------
// Charter Parties
// -----------------------------------------------------------------------------

export const CP_CLAUSE_FIELDS = ['norClause', 'laytimeClause', 'freightTerms', 'demurrageTerms', 'otherClauses'] as const;
export const CP_CONTRACT_FIELDS = [
  'cpType',
  'cpDate',
  'charterer',
  'owner',
  'broker',
  'signatories',
  'laycanFrom',
  'laycanTo',
  'loadPorts',
  'dischargePorts',
  'cargoDescription',
  ...CP_CLAUSE_FIELDS,
] as const;
export type CpContractField = (typeof CP_CONTRACT_FIELDS)[number];

export interface CharterPartyBase {
  id: string;
  reference: string;
  cpType: CpType;
  cpDate: string | null;
  vesselId: string | null;
  charterer: string | null;
  owner: string | null;
  broker: string | null;
  signatories: string | null;
  laycanFrom: string | null;
  laycanTo: string | null;
  loadPorts: string | null;
  dischargePorts: string | null;
  cargoDescription: string | null;
  norClause: string | null;
  laytimeClause: string | null;
  freightTerms: string | null;
  demurrageTerms: string | null;
  otherClauses: string | null;
  status: CpStatus;
  currentVersionId: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
}

export interface CpListItem extends CharterPartyBase {
  vessel: VesselMini | null;
  currentVersion: { id: string; versionNo: number; kind: CpVersionKind; decidedAt: string | null } | null;
  voyages: { id: string; reference: string; status: VoyageStatus }[];
  _count: { versions: number };
}

export interface CpVersionRow {
  id: string;
  charterPartyId: string;
  versionNo: number;
  kind: CpVersionKind;
  fileId: string | null;
  summary: string | null;
  clauses: Record<string, string | null> | null;
  status: ApprovalStatus;
  submittedById: string;
  submittedAt: string;
  decidedById: string | null;
  decidedAt: string | null;
  decisionComment: string | null;
  supersededAt: string | null;
  submittedBy: string | null;
  decidedBy: string | null;
  file: StoredFileDto | null;
  opposable: boolean;
  acknowledgementCount: number;
  acknowledgedByMe: string | null;
}

export interface CpDetail extends CharterPartyBase {
  vessel: VesselMini | null;
  voyages: { id: string; reference: string; status: VoyageStatus; vesselId: string }[];
  versions: CpVersionRow[];
  opposableVersion: CpVersionRow | null;
  pendingVersion: CpVersionRow | null;
  permissions: { manage: boolean; approve: boolean; editDraft: boolean };
}
