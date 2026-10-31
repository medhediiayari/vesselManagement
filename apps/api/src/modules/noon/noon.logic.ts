/**
 * Règles pures des Noon Reports (CDC §8, V1 §11) : automate d'états, formulaire en 7 sections,
 * contrôles de plages, champs minimaux à la soumission, snapshot figé et diff de révisions.
 * Aucun accès base — testé unitairement (noon.logic.spec.ts).
 */
import { Prisma } from '@prisma/client';
import type { NoonReportType, NoonStatus } from '@prisma/client';

// -----------------------------------------------------------------------------
// Automate (CDC §8.1, §12) : DRAFT → SUBMITTED → ACKNOWLEDGED | CORRECTION_REQUESTED → CORRECTED
// -----------------------------------------------------------------------------

export const NOON_TRANSITIONS: Record<NoonStatus, NoonStatus[]> = {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['ACKNOWLEDGED', 'CORRECTION_REQUESTED', 'CORRECTED'],
  ACKNOWLEDGED: ['CORRECTION_REQUESTED', 'CORRECTED', 'ARCHIVED'],
  CORRECTION_REQUESTED: ['CORRECTED'],
  // Correction successive possible : chaque correction est une nouvelle révision
  CORRECTED: ['ACKNOWLEDGED', 'CORRECTION_REQUESTED', 'CORRECTED', 'ARCHIVED'],
  ARCHIVED: [],
};

export function canTransitionNoon(from: NoonStatus, to: NoonStatus): boolean {
  return NOON_TRANSITIONS[from]?.includes(to) ?? false;
}

/** États où les valeurs de travail sont modifiables (autosave). */
export const NOON_EDITABLE_STATUSES: NoonStatus[] = ['DRAFT', 'CORRECTION_REQUESTED'];

// -----------------------------------------------------------------------------
// Formulaire AMC en sept sections (CDC §8.2)
// -----------------------------------------------------------------------------

export type NoonFieldKind = 'text' | 'decimal' | 'int' | 'datetime' | 'enum';

export interface NoonFieldDef {
  key: string;
  label: string;
  kind: NoonFieldKind;
  unit?: string;
  /** Champ long (paragraphe dans le PDF) */
  long?: boolean;
}

export interface NoonSectionDef {
  key: 'general' | 'positionWeather' | 'navigation' | 'engineFuel' | 'ballastCargo' | 'incidentsRemarks' | 'maintenance';
  index: number;
  title: string;
  fields: NoonFieldDef[];
}

export const NOON_SECTIONS: NoonSectionDef[] = [
  {
    key: 'general',
    index: 1,
    title: 'General Information',
    fields: [
      { key: 'reportType', label: 'Report type', kind: 'enum' },
      { key: 'reportDateUtc', label: 'Report date / time (UTC)', kind: 'datetime' },
      { key: 'utcOffsetMinutes', label: 'UTC offset', kind: 'int', unit: 'min' },
      { key: 'reference', label: 'Reference', kind: 'text' },
      { key: 'masterName', label: 'Master', kind: 'text' },
    ],
  },
  {
    key: 'positionWeather',
    index: 2,
    title: 'Position & Weather',
    fields: [
      { key: 'latitude', label: 'Latitude', kind: 'decimal', unit: '°' },
      { key: 'longitude', label: 'Longitude', kind: 'decimal', unit: '°' },
      { key: 'windDirection', label: 'Wind direction', kind: 'text' },
      { key: 'windForceBeaufort', label: 'Wind force', kind: 'int', unit: 'Bft' },
      { key: 'windSpeedKnots', label: 'Wind speed', kind: 'decimal', unit: 'kn' },
      { key: 'weatherConditions', label: 'Weather conditions', kind: 'text' },
      { key: 'seaState', label: 'Sea state', kind: 'text' },
      { key: 'swellDirection', label: 'Swell direction', kind: 'text' },
      { key: 'swellHeightM', label: 'Swell height', kind: 'decimal', unit: 'm' },
      { key: 'visibility', label: 'Visibility', kind: 'text' },
    ],
  },
  {
    key: 'navigation',
    index: 3,
    title: 'Navigation & Course',
    fields: [
      { key: 'courseDeg', label: 'Course', kind: 'decimal', unit: '°' },
      { key: 'speedKnots', label: 'Speed', kind: 'decimal', unit: 'kn' },
      { key: 'distanceSinceLastNm', label: 'Distance since last report', kind: 'decimal', unit: 'nm' },
      { key: 'distanceRemainingNm', label: 'Distance remaining', kind: 'decimal', unit: 'nm' },
      { key: 'nextPort', label: 'Next port', kind: 'text' },
      { key: 'etaNextPort', label: 'ETA next port (UTC)', kind: 'datetime' },
    ],
  },
  {
    key: 'engineFuel',
    index: 4,
    title: 'Engine & Fuel',
    fields: [
      { key: 'consumptionBasis', label: 'Consumption basis', kind: 'enum' },
      { key: 'meRpm', label: 'Main engine RPM', kind: 'decimal', unit: 'rpm' },
      { key: 'foConsumptionMt', label: 'FO consumption', kind: 'decimal', unit: 'MT' },
      { key: 'doConsumptionMt', label: 'DO consumption', kind: 'decimal', unit: 'MT' },
      { key: 'lubeOilConsumptionL', label: 'Lube oil consumption', kind: 'decimal', unit: 'L' },
      { key: 'runningHours', label: 'Running hours', kind: 'decimal', unit: 'h' },
      { key: 'foRobMt', label: 'FO ROB', kind: 'decimal', unit: 'MT' },
      { key: 'doRobMt', label: 'DO ROB', kind: 'decimal', unit: 'MT' },
      { key: 'loRobL', label: 'LO ROB', kind: 'decimal', unit: 'L' },
    ],
  },
  {
    key: 'ballastCargo',
    index: 5,
    title: 'Ballast & Cargo',
    fields: [
      { key: 'ballastWaterM3', label: 'Ballast water', kind: 'decimal', unit: 'm³' },
      { key: 'loadingCondition', label: 'Loading condition', kind: 'enum' },
      { key: 'cargoType', label: 'Cargo type', kind: 'text' },
      { key: 'cargoQuantityMt', label: 'Cargo on board', kind: 'decimal', unit: 'MT' },
    ],
  },
  {
    key: 'incidentsRemarks',
    index: 6,
    title: 'Incidents & Remarks',
    fields: [
      { key: 'incidents', label: 'Incidents (machinery / operational)', kind: 'text', long: true },
      { key: 'remarks', label: 'Remarks', kind: 'text', long: true },
    ],
  },
  {
    key: 'maintenance',
    index: 7,
    title: 'Maintenance & Observations',
    fields: [
      { key: 'maintenanceDone', label: 'Work carried out', kind: 'text', long: true },
      { key: 'maintenancePlanned', label: 'Work planned', kind: 'text', long: true },
      { key: 'deviations', label: 'Abnormal deviations', kind: 'text', long: true },
      { key: 'additionalNotes', label: 'Additional notes', kind: 'text', long: true },
    ],
  },
];

export const NOON_FIELDS: string[] = NOON_SECTIONS.flatMap((s) => s.fields.map((f) => f.key));

export const CONSUMPTION_BASIS_LABELS: Record<string, string> = {
  SINCE_LAST_REPORT: 'Since last report',
  DAILY_24H: 'Daily (24 h)',
};

// -----------------------------------------------------------------------------
// Plages numériques (CDC §8.3) — bornes = plages métier ∩ précision des colonnes
// -----------------------------------------------------------------------------

export interface NumericRule {
  min: number;
  max: number;
  /** Borne max exclue (cap 0–360 exclu) */
  maxExclusive?: boolean;
  scale: number;
  label: string;
}

export const NOON_NUMERIC_RULES = {
  latitude: { min: -90, max: 90, scale: 6, label: 'Latitude' },
  longitude: { min: -180, max: 180, scale: 6, label: 'Longitude' },
  windSpeedKnots: { min: 0, max: 9999.9, scale: 1, label: 'Vitesse du vent' },
  swellHeightM: { min: 0, max: 999.9, scale: 1, label: 'Hauteur de houle' },
  courseDeg: { min: 0, max: 360, maxExclusive: true, scale: 1, label: 'Cap' },
  speedKnots: { min: 0, max: 999.99, scale: 2, label: 'Vitesse' },
  distanceSinceLastNm: { min: 0, max: 999_999.99, scale: 2, label: 'Distance depuis le dernier rapport' },
  distanceRemainingNm: { min: 0, max: 999_999.99, scale: 2, label: 'Distance restante' },
  meRpm: { min: 0, max: 99_999.9, scale: 1, label: 'RPM moteur principal' },
  foConsumptionMt: { min: 0, max: 9_999_999.999, scale: 3, label: 'Consommation FO' },
  doConsumptionMt: { min: 0, max: 9_999_999.999, scale: 3, label: 'Consommation DO' },
  lubeOilConsumptionL: { min: 0, max: 99_999_999.99, scale: 2, label: 'Consommation huile' },
  runningHours: { min: 0, max: 48, scale: 2, label: 'Heures de marche' },
  foRobMt: { min: 0, max: 9_999_999.999, scale: 3, label: 'FO ROB' },
  doRobMt: { min: 0, max: 9_999_999.999, scale: 3, label: 'DO ROB' },
  loRobL: { min: 0, max: 99_999_999.99, scale: 2, label: 'LO ROB' },
  ballastWaterM3: { min: 0, max: 99_999_999.99, scale: 2, label: 'Eau de ballast' },
  cargoQuantityMt: { min: 0, max: 99_999_999_999.999, scale: 3, label: 'Cargaison à bord' },
} satisfies Record<string, NumericRule>;

export type NoonDecimalField = keyof typeof NOON_NUMERIC_RULES;

/** Contrôle d'une valeur décimale (calcul exact Prisma.Decimal, jamais float). Retourne un message FR ou null. */
export function checkDecimal(raw: string, rule: NumericRule): string | null {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return `${rule.label} : nombre décimal invalide`;
  const d = new Prisma.Decimal(raw);
  if (d.lessThan(rule.min)) return `${rule.label} : doit être ≥ ${rule.min}`;
  if (rule.maxExclusive ? d.greaterThanOrEqualTo(rule.max) : d.greaterThan(rule.max)) {
    return `${rule.label} : doit être ${rule.maxExclusive ? '<' : '≤'} ${rule.max}`;
  }
  if (d.decimalPlaces() > rule.scale) return `${rule.label} : au plus ${rule.scale} décimales`;
  return null;
}

export const UTC_OFFSET_MIN = -720;
export const UTC_OFFSET_MAX = 840;

export function checkUtcOffset(v: number): string | null {
  if (!Number.isInteger(v) || v < UTC_OFFSET_MIN || v > UTC_OFFSET_MAX) return 'Décalage UTC : entre -720 et +840 minutes';
  if (v % 15 !== 0) return 'Décalage UTC : multiple de 15 minutes';
  return null;
}

// -----------------------------------------------------------------------------
// Validation (plages, cohérence, champs minimaux à la soumission)
// -----------------------------------------------------------------------------

export type NoonScalar = string | number | Date | Prisma.Decimal | null | undefined;
export type NoonValues = Record<string, NoonScalar>;

export interface NoonIssue {
  path: string;
  message: string;
}

const isBlank = (v: NoonScalar) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const toDecimal = (v: NoonScalar): Prisma.Decimal | null =>
  isBlank(v) || v instanceof Date ? null : new Prisma.Decimal(v as Prisma.Decimal.Value);

/** Plages de toutes les valeurs présentes (latitude, longitude, cap, Beaufort, non-négativité…). */
export function validateNoonRanges(values: NoonValues): NoonIssue[] {
  const issues: NoonIssue[] = [];
  for (const [field, rule] of Object.entries(NOON_NUMERIC_RULES) as [NoonDecimalField, NumericRule][]) {
    const v = values[field];
    if (isBlank(v)) continue;
    const err = checkDecimal(String(v), rule);
    if (err) issues.push({ path: field, message: err });
  }
  const bft = values.windForceBeaufort;
  if (!isBlank(bft)) {
    const n = Number(bft);
    if (!Number.isInteger(n) || n < 0 || n > 12) issues.push({ path: 'windForceBeaufort', message: 'Force du vent : échelle de Beaufort 0 à 12' });
  }
  if (!isBlank(values.utcOffsetMinutes)) {
    const err = checkUtcOffset(Number(values.utcOffsetMinutes));
    if (err) issues.push({ path: 'utcOffsetMinutes', message: err });
  }
  return issues;
}

/** Tolérance pour la date du rapport par rapport à l'horloge serveur. */
export const REPORT_DATE_FUTURE_TOLERANCE_MS = 24 * 3_600_000;

/**
 * Cohérence entre champs : base de consommation explicite (une base DAILY_24H ne peut pas
 * dépasser 24 h de marche — aucun cumul aveugle), ETA postérieure au rapport, date non future.
 */
export function validateNoonConsistency(values: NoonValues, now: Date): NoonIssue[] {
  const issues: NoonIssue[] = [];
  const hours = toDecimal(values.runningHours);
  if (values.consumptionBasis === 'DAILY_24H' && hours && hours.greaterThan(24)) {
    issues.push({ path: 'runningHours', message: 'Base « Daily (24 h) » : heures de marche ≤ 24' });
  }
  const report = values.reportDateUtc instanceof Date ? values.reportDateUtc : null;
  const eta = values.etaNextPort instanceof Date ? values.etaNextPort : null;
  if (report && eta && eta < report) issues.push({ path: 'etaNextPort', message: 'ETA du prochain port antérieure à la date du rapport' });
  if (report && report.getTime() > now.getTime() + REPORT_DATE_FUTURE_TOLERANCE_MS) {
    issues.push({ path: 'reportDateUtc', message: 'Date du rapport dans le futur' });
  }
  return issues;
}

/**
 * Champs minimaux exigés à la soumission (définis pour la V1) :
 * - toujours : type, date UTC, décalage UTC, Master, latitude, longitude, base de consommation ;
 * - vitesse, OU motif renseigné dans « Remarks » (mouillage, dérive, arrêt…) ;
 * - cap si la vitesse est > 0 ;
 * - NOON / MIDNIGHT : consommations FO et DO et heures de marche explicites (0 accepté) ;
 * - DEPARTURE : prochain port et ETA.
 */
export function missingForSubmission(values: NoonValues): NoonIssue[] {
  const issues: NoonIssue[] = [];
  const need = (field: string, message: string) => {
    if (isBlank(values[field])) issues.push({ path: field, message });
  };
  need('reportType', 'Type de rapport requis');
  need('reportDateUtc', 'Date / heure UTC du rapport requise');
  need('utcOffsetMinutes', 'Décalage horaire local requis');
  need('masterName', 'Nom du Master requis');
  need('latitude', 'Latitude requise');
  need('longitude', 'Longitude requise');
  need('consumptionBasis', 'Base de consommation requise (since last report / daily 24 h)');
  const speed = toDecimal(values.speedKnots);
  if (!speed && isBlank(values.remarks)) {
    issues.push({ path: 'speedKnots', message: 'Vitesse requise, ou motif de son absence dans « Remarks »' });
  }
  if (speed && speed.greaterThan(0)) need('courseDeg', 'Cap requis lorsque le navire fait route');
  const type = values.reportType as NoonReportType | undefined;
  if (type === 'NOON' || type === 'MIDNIGHT') {
    need('foConsumptionMt', 'Consommation FO requise (0 si aucune)');
    need('doConsumptionMt', 'Consommation DO requise (0 si aucune)');
    need('runningHours', 'Heures de marche requises (0 si aucune)');
  }
  if (type === 'DEPARTURE') {
    need('nextPort', 'Prochain port requis pour un rapport de départ');
    need('etaNextPort', 'ETA du prochain port requise pour un rapport de départ');
  }
  return issues;
}

export function validateForSubmission(values: NoonValues, now: Date): NoonIssue[] {
  return [...missingForSubmission(values), ...validateNoonRanges(values), ...validateNoonConsistency(values, now)];
}

// -----------------------------------------------------------------------------
// Unicité par jour local, bornes par rapport au voyage, vraisemblance (audit FLT-07 / FLT-11)
// -----------------------------------------------------------------------------

/** Rapports quotidiens : un seul par voyage et par jour local du bord. */
export const DAILY_REPORT_TYPES: NoonReportType[] = ['NOON', 'MIDNIGHT'];

/** Jour local du bord (AAAA-MM-JJ) d'un horodatage UTC. */
export function localDayKey(utc: Date, offsetMinutes: number | null | undefined): string {
  return new Date(utc.getTime() + Number(offsetMinutes ?? 0) * 60_000).toISOString().slice(0, 10);
}

export interface ReportSlot {
  reportType: NoonReportType;
  reportDateUtc: Date;
  utcOffsetMinutes: number | null | undefined;
}

/** Même créneau : même jour local pour NOON / MIDNIGHT, même horodatage pour ARRIVAL / DEPARTURE. */
export function sameReportSlot(a: ReportSlot, b: ReportSlot): boolean {
  if (a.reportType !== b.reportType) return false;
  if (DAILY_REPORT_TYPES.includes(a.reportType)) {
    return localDayKey(a.reportDateUtc, a.utcOffsetMinutes) === localDayKey(b.reportDateUtc, b.utcOffsetMinutes);
  }
  return a.reportDateUtc.getTime() === b.reportDateUtc.getTime();
}

/**
 * Date du rapport au plus tôt au début du voyage : la plus ancienne date connue parmi la
 * création, l'ETD, l'ATD et le début de laycan, moins 24 h (un rapport de 2019 sur un voyage de 2026 est refusé).
 */
export function reportDateBeforeVoyage(
  report: Date,
  voyage: { createdAt: Date; etd: Date | null; atd: Date | null; laycanFrom: Date | null },
): NoonIssue | null {
  const known = [voyage.createdAt, voyage.etd, voyage.atd, voyage.laycanFrom].filter((d): d is Date => !!d);
  const earliest = Math.min(...known.map((d) => d.getTime()));
  if (report.getTime() >= earliest - REPORT_DATE_FUTURE_TOLERANCE_MS) return null;
  return { path: 'reportDateUtc', message: `Date du rapport antérieure au début du voyage (${new Date(earliest).toISOString().slice(0, 10)})` };
}

/** Facteur de tolérance distance / (vitesse × heures). */
export const DISTANCE_TOLERANCE = 1.2;

export interface PreviousReport {
  reportDateUtc: Date;
  foRobMt: NoonScalar;
  doRobMt: NoonScalar;
}

/**
 * Avertissements NON bloquants affichés avant soumission : distance invraisemblable pour la
 * vitesse déclarée, ROB en hausse par rapport au rapport précédent sans soutage signalé.
 */
export function noonPlausibilityWarnings(values: NoonValues, previous: PreviousReport | null): NoonIssue[] {
  const warnings: NoonIssue[] = [];
  const report = values.reportDateUtc instanceof Date ? values.reportDateUtc : null;
  const distance = toDecimal(values.distanceSinceLastNm);
  const speed = toDecimal(values.speedKnots);
  // Heures écoulées depuis le rapport précédent, à défaut heures de marche déclarées
  const elapsed = previous && report ? (report.getTime() - previous.reportDateUtc.getTime()) / 3_600_000 : null;
  const hours = elapsed && elapsed > 0 ? new Prisma.Decimal(elapsed.toFixed(2)) : toDecimal(values.runningHours);
  if (distance && speed && hours && hours.greaterThan(0)) {
    const max = speed.mul(hours).mul(DISTANCE_TOLERANCE);
    if (distance.greaterThan(max)) {
      warnings.push({
        path: 'distanceSinceLastNm',
        message: `Distance ${distance.toString()} nm supérieure à vitesse × heures (${speed.toString()} kn × ${hours.toString()} h, tolérance 20 %) : à vérifier`,
      });
    }
  }
  if (previous) {
    for (const [field, label] of [
      ['foRobMt', 'FO ROB'],
      ['doRobMt', 'DO ROB'],
    ] as const) {
      const before = toDecimal(previous[field]);
      const now = toDecimal(values[field]);
      if (before && now && now.greaterThan(before)) {
        warnings.push({
          path: field,
          message: `${label} en hausse depuis le rapport précédent (${before.toString()} → ${now.toString()} MT) : préciser le soutage dans « Remarks »`,
        });
      }
    }
  }
  return warnings;
}

// -----------------------------------------------------------------------------
// Heure locale
// -----------------------------------------------------------------------------

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Heure locale du bord pour affichage : « 2026-02-10 12:00 (UTC+01:00) ». */
export function localTimeLabel(utc: Date, offsetMinutes: number): string {
  const local = new Date(utc.getTime() + offsetMinutes * 60_000);
  return `${local.toISOString().slice(0, 16).replace('T', ' ')} (${formatUtcOffset(offsetMinutes)})`;
}

// -----------------------------------------------------------------------------
// Snapshot figé (révision) et diff
// -----------------------------------------------------------------------------

export type SnapshotValue = string | number | null;

export interface NoonSnapshot {
  schemaVersion: 1;
  revisionNo: number;
  frozenAt: string;
  author: { id: string; displayName: string };
  vessel: { id: string; code: string; name: string; imoNumber: string | null };
  voyage: { id: string; reference: string };
  reportDateLocal: string;
  sections: Record<NoonSectionDef['key'], Record<string, SnapshotValue>>;
}

export function snapshotValue(v: NoonScalar): SnapshotValue {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Prisma.Decimal.isDecimal(v)) return (v as Prisma.Decimal).toString();
  if (typeof v === 'number') return v;
  return String(v);
}

/** Snapshot JSON des 7 sections (valeurs décimales en chaîne, dates ISO UTC). */
export function buildNoonSnapshot(
  values: NoonValues,
  meta: { revisionNo: number; frozenAt: Date; author: NoonSnapshot['author']; vessel: NoonSnapshot['vessel']; voyage: NoonSnapshot['voyage'] },
): NoonSnapshot {
  const sections = {} as NoonSnapshot['sections'];
  for (const s of NOON_SECTIONS) {
    sections[s.key] = {};
    for (const f of s.fields) sections[s.key][f.key] = snapshotValue(values[f.key]);
  }
  const reportDate = values.reportDateUtc instanceof Date ? values.reportDateUtc : null;
  return {
    schemaVersion: 1,
    revisionNo: meta.revisionNo,
    frozenAt: meta.frozenAt.toISOString(),
    author: meta.author,
    vessel: meta.vessel,
    voyage: meta.voyage,
    reportDateLocal: reportDate ? localTimeLabel(reportDate, Number(values.utcOffsetMinutes ?? 0)) : '',
    sections,
  };
}

/** Valeurs à plat d'un snapshot (clé de champ -> valeur). */
export function flattenSnapshot(s: Pick<NoonSnapshot, 'sections'> | null | undefined): Record<string, SnapshotValue> {
  const out: Record<string, SnapshotValue> = {};
  if (!s) return out;
  for (const section of NOON_SECTIONS) for (const f of section.fields) out[f.key] = s.sections?.[section.key]?.[f.key] ?? null;
  return out;
}

/** Normalisation pour comparaison : décimaux « 12.50 » == « 12.5 ». */
function comparable(field: string, v: SnapshotValue): string | null {
  if (v === null || v === '') return null;
  if (field in NOON_NUMERIC_RULES && /^-?\d+(\.\d+)?$/.test(String(v))) return new Prisma.Decimal(String(v)).toString();
  return String(v);
}

export interface NoonChange {
  section: string;
  sectionTitle: string;
  field: string;
  label: string;
  before: SnapshotValue;
  after: SnapshotValue;
}

/** Diff champ par champ entre deux révisions (audit old/new, CDC §8.3). */
export function diffNoonSnapshots(prev: Pick<NoonSnapshot, 'sections'> | null, next: Pick<NoonSnapshot, 'sections'>): NoonChange[] {
  const a = flattenSnapshot(prev);
  const b = flattenSnapshot(next);
  const changes: NoonChange[] = [];
  for (const s of NOON_SECTIONS) {
    for (const f of s.fields) {
      if (comparable(f.key, a[f.key] ?? null) !== comparable(f.key, b[f.key] ?? null)) {
        changes.push({ section: s.key, sectionTitle: s.title, field: f.key, label: f.label, before: prev ? a[f.key] ?? null : null, after: b[f.key] ?? null });
      }
    }
  }
  return changes;
}
