import type { StoredFileDto } from '@/lib/api';

export type NoonStatus = 'DRAFT' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'CORRECTION_REQUESTED' | 'CORRECTED' | 'ARCHIVED';
export type NoonReportType = 'NOON' | 'MIDNIGHT' | 'ARRIVAL' | 'DEPARTURE';
export type ConsumptionBasis = 'SINCE_LAST_REPORT' | 'DAILY_24H';
export type LoadingCondition = 'LADEN' | 'BALLAST' | 'PART_LADEN' | 'LOADING' | 'DISCHARGING';

/** Valeurs des 7 sections telles que renvoyées par l'API (décimaux en chaîne, dates ISO UTC). */
export interface NoonValuesDto {
  reportType: NoonReportType;
  reportDateUtc: string;
  utcOffsetMinutes: number;
  reference: string | null;
  masterName: string | null;
  latitude: string | null;
  longitude: string | null;
  windDirection: string | null;
  windForceBeaufort: number | null;
  windSpeedKnots: string | null;
  weatherConditions: string | null;
  seaState: string | null;
  swellDirection: string | null;
  swellHeightM: string | null;
  visibility: string | null;
  courseDeg: string | null;
  speedKnots: string | null;
  distanceSinceLastNm: string | null;
  distanceRemainingNm: string | null;
  nextPort: string | null;
  etaNextPort: string | null;
  consumptionBasis: ConsumptionBasis;
  meRpm: string | null;
  foConsumptionMt: string | null;
  doConsumptionMt: string | null;
  lubeOilConsumptionL: string | null;
  runningHours: string | null;
  foRobMt: string | null;
  doRobMt: string | null;
  loRobL: string | null;
  ballastWaterM3: string | null;
  loadingCondition: LoadingCondition | null;
  cargoType: string | null;
  cargoQuantityMt: string | null;
  incidents: string | null;
  remarks: string | null;
  maintenanceDone: string | null;
  maintenancePlanned: string | null;
  deviations: string | null;
  additionalNotes: string | null;
}

export interface NoonIssue {
  path: string;
  message: string;
}

export interface NoonRevisionRef {
  id: string;
  revisionNo: number;
  reason: string | null;
  pdfFileId: string | null;
  createdById: string;
  createdAt: string;
  createdBy: string | null;
}

export interface NoonAttachment {
  id: string;
  noonReportId: string;
  fileId: string;
  uploadedById: string;
  createdAt: string;
  uploadedBy: string | null;
  file: StoredFileDto | null;
}

export interface NoonReportDetail extends NoonValuesDto {
  id: string;
  vesselId: string;
  voyageId: string;
  status: NoonStatus;
  currentRevisionNo: number;
  submittedById: string | null;
  submittedAt: string | null;
  acknowledgedById: string | null;
  acknowledgedAt: string | null;
  correctionRequest: string | null;
  lockVersion: number;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  reportDateLocal: string;
  vessel: { id: string; code: string; name: string; imoNumber: string | null; timezone: string | null };
  voyage: { id: string; reference: string; status: string };
  revisions: NoonRevisionRef[];
  attachments: NoonAttachment[];
  createdBy: string | null;
  submittedBy: string | null;
  acknowledgedBy: string | null;
  submissionCheck: NoonIssue[];
  /** Avertissements non bloquants (vraisemblance distance / ROB) */
  submissionWarnings?: NoonIssue[];
  /** Voyage planifié ou en cours : faux = brouillon figé */
  voyageOpen?: boolean;
  allowedTransitions: NoonStatus[];
  permissions: { edit: boolean; submit: boolean; acknowledge: boolean; requestCorrection: boolean; correct: boolean; export: boolean; discard?: boolean };
}

export interface NoonListItem {
  id: string;
  vesselId: string;
  voyageId: string;
  reportType: NoonReportType;
  reportDateUtc: string;
  utcOffsetMinutes: number;
  reference: string | null;
  masterName: string | null;
  latitude: string | null;
  longitude: string | null;
  courseDeg: string | null;
  speedKnots: string | null;
  distanceRemainingNm: string | null;
  nextPort: string | null;
  etaNextPort: string | null;
  status: NoonStatus;
  currentRevisionNo: number;
  submittedAt: string | null;
  acknowledgedAt: string | null;
  lockVersion: number;
  createdAt?: string;
  updatedAt: string;
  reportDateLocal: string;
  /** Brouillon : nombre de points bloquant la soumission (null hors brouillon) */
  pendingIssues?: number | null;
  vessel: { id: string; code: string; name: string };
  voyage: { id: string; reference: string; status: string };
}

export interface NoonChange {
  section: string;
  sectionTitle: string;
  field: string;
  label: string;
  before: string | number | null;
  after: string | number | null;
}

export interface NoonRevisionFull {
  id: string;
  noonReportId: string;
  revisionNo: number;
  reason: string | null;
  pdfFileId: string | null;
  createdById: string;
  createdAt: string;
  createdBy: string | null;
  values: Record<string, string | number | null>;
  changes: NoonChange[];
  data: { frozenAt: string; author: { id: string; displayName: string }; reportDateLocal: string };
}
