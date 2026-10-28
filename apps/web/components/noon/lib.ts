/**
 * Formulaire AMC des Noon Reports (CDC §8.2) — miroir client des règles de l'API
 * (apps/api/src/modules/noon/noon.logic.ts) : sections, plages numériques, cohérence et
 * champs minimaux à la soumission. Le serveur reste l'autorité : ce contrôle n'est qu'une aide.
 */
import type { NoonIssue, NoonValuesDto } from './types';

// -----------------------------------------------------------------------------
// Libellés
// -----------------------------------------------------------------------------

export const REPORT_TYPE_LABELS: Record<string, string> = {
  NOON: 'Noon',
  MIDNIGHT: 'Midnight',
  ARRIVAL: 'Arrival',
  DEPARTURE: 'Departure',
};

export const CONSUMPTION_BASIS_LABELS: Record<string, string> = {
  SINCE_LAST_REPORT: 'Since last report — depuis le rapport précédent',
  DAILY_24H: 'Daily (24 h) — valeurs journalières',
};

export const LOADING_CONDITION_LABELS: Record<string, string> = {
  LADEN: 'Laden (en charge)',
  BALLAST: 'Ballast (sur lest)',
  PART_LADEN: 'Part laden (charge partielle)',
  LOADING: 'Loading (en chargement)',
  DISCHARGING: 'Discharging (en déchargement)',
};

export const BEAUFORT_LABELS = [
  'Calm',
  'Light air',
  'Light breeze',
  'Gentle breeze',
  'Moderate breeze',
  'Fresh breeze',
  'Strong breeze',
  'Near gale',
  'Gale',
  'Strong gale',
  'Storm',
  'Violent storm',
  'Hurricane force',
];

export const noonKeys = {
  list: ['noon-reports'] as const,
  detail: (id: string) => ['noon-report', id] as const,
  revisions: (id: string) => ['noon-report', id, 'revisions'] as const,
};

// -----------------------------------------------------------------------------
// Sections et champs
// -----------------------------------------------------------------------------

export type NoonField = keyof NoonValuesDto;
export type FieldKind = 'text' | 'longtext' | 'decimal' | 'beaufort' | 'datetime' | 'offset' | 'enum' | 'coordinate';

export interface FieldDef {
  key: NoonField;
  label: string;
  kind: FieldKind;
  unit?: string;
  hint?: string;
  max?: number;
  options?: Record<string, string>;
  /** Champ sur toute la largeur de la grille */
  wide?: boolean;
}

export interface SectionDef {
  key: string;
  index: number;
  title: string;
  subtitle: string;
  fields: FieldDef[];
}

export const NOON_SECTIONS: SectionDef[] = [
  {
    key: 'general',
    index: 1,
    title: 'General Information',
    subtitle: 'Type, date / heure UTC et locale, Master, référence',
    fields: [
      { key: 'reportType', label: 'Type de rapport', kind: 'enum', options: REPORT_TYPE_LABELS },
      { key: 'reportDateUtc', label: 'Date / heure du rapport (UTC)', kind: 'datetime' },
      { key: 'utcOffsetMinutes', label: 'Décalage horaire du bord', kind: 'offset' },
      { key: 'masterName', label: 'Master', kind: 'text', max: 200 },
      { key: 'reference', label: 'Référence', kind: 'text', max: 80 },
    ],
  },
  {
    key: 'positionWeather',
    index: 2,
    title: 'Position & Weather',
    subtitle: 'Position, vent, mer, houle, visibilité',
    fields: [
      { key: 'latitude', label: 'Latitude', kind: 'coordinate', hint: 'Décimal (37.6) ou 37°36.0′ N' },
      { key: 'longitude', label: 'Longitude', kind: 'coordinate', hint: 'Décimal (-11.25) ou 11°15′ W' },
      { key: 'windDirection', label: 'Direction du vent', kind: 'text', max: 16, hint: 'Ex. NW, 315°' },
      { key: 'windForceBeaufort', label: 'Force du vent', kind: 'beaufort', unit: 'Bft' },
      { key: 'windSpeedKnots', label: 'Vitesse du vent', kind: 'decimal', unit: 'kn' },
      { key: 'weatherConditions', label: 'Conditions météo', kind: 'text', max: 200 },
      { key: 'seaState', label: 'État de la mer (sea state)', kind: 'text', max: 60 },
      { key: 'swellDirection', label: 'Direction de la houle (swell)', kind: 'text', max: 16 },
      { key: 'swellHeightM', label: 'Hauteur de houle', kind: 'decimal', unit: 'm' },
      { key: 'visibility', label: 'Visibilité', kind: 'text', max: 60 },
    ],
  },
  {
    key: 'navigation',
    index: 3,
    title: 'Navigation & Course',
    subtitle: 'Cap, vitesse, distances, prochain port, ETA',
    fields: [
      { key: 'courseDeg', label: 'Cap (course)', kind: 'decimal', unit: '°', hint: '0 à 359,9' },
      { key: 'speedKnots', label: 'Vitesse (speed)', kind: 'decimal', unit: 'kn' },
      { key: 'distanceSinceLastNm', label: 'Distance depuis le dernier rapport', kind: 'decimal', unit: 'nm' },
      { key: 'distanceRemainingNm', label: 'Distance restante', kind: 'decimal', unit: 'nm' },
      { key: 'nextPort', label: 'Prochain port', kind: 'text', max: 120 },
      { key: 'etaNextPort', label: 'ETA prochain port (UTC)', kind: 'datetime' },
    ],
  },
  {
    key: 'engineFuel',
    index: 4,
    title: 'Engine & Fuel',
    subtitle: 'Base de consommation explicite, ME RPM, FO / DO / lube oil, heures de marche, ROB',
    fields: [
      { key: 'consumptionBasis', label: 'Base de consommation', kind: 'enum', options: CONSUMPTION_BASIS_LABELS, wide: true },
      { key: 'meRpm', label: 'RPM moteur principal (ME)', kind: 'decimal', unit: 'rpm' },
      { key: 'runningHours', label: 'Heures de marche (running hours)', kind: 'decimal', unit: 'h' },
      { key: 'foConsumptionMt', label: 'Consommation FO', kind: 'decimal', unit: 'MT' },
      { key: 'doConsumptionMt', label: 'Consommation DO', kind: 'decimal', unit: 'MT' },
      { key: 'lubeOilConsumptionL', label: 'Consommation huile (lube oil)', kind: 'decimal', unit: 'L' },
      { key: 'foRobMt', label: 'FO ROB', kind: 'decimal', unit: 'MT', hint: 'Quantité restant à bord (pas une consommation)' },
      { key: 'doRobMt', label: 'DO ROB', kind: 'decimal', unit: 'MT' },
      { key: 'loRobL', label: 'LO ROB', kind: 'decimal', unit: 'L' },
    ],
  },
  {
    key: 'ballastCargo',
    index: 5,
    title: 'Ballast & Cargo',
    subtitle: 'Eau de ballast, condition de chargement, cargaison à bord',
    fields: [
      { key: 'ballastWaterM3', label: 'Eau de ballast', kind: 'decimal', unit: 'm³' },
      { key: 'loadingCondition', label: 'Condition de chargement', kind: 'enum', options: LOADING_CONDITION_LABELS },
      { key: 'cargoType', label: 'Type de cargaison', kind: 'text', max: 200 },
      { key: 'cargoQuantityMt', label: 'Cargaison à bord', kind: 'decimal', unit: 'MT' },
    ],
  },
  {
    key: 'incidentsRemarks',
    index: 6,
    title: 'Incidents & Remarks',
    subtitle: 'Incidents machines / opérationnels, anomalies, commentaires',
    fields: [
      { key: 'incidents', label: 'Incidents (machines / opérationnels)', kind: 'longtext', max: 10_000, wide: true },
      { key: 'remarks', label: 'Remarques (remarks)', kind: 'longtext', max: 10_000, wide: true, hint: 'Indiquer ici le motif si la vitesse n’est pas renseignée (mouillage, dérive, arrêt…).' },
    ],
  },
  {
    key: 'maintenance',
    index: 7,
    title: 'Maintenance & Observations',
    subtitle: 'Travaux effectués / prévus, déviations, notes',
    fields: [
      { key: 'maintenanceDone', label: 'Travaux effectués', kind: 'longtext', max: 10_000 },
      { key: 'maintenancePlanned', label: 'Travaux prévus', kind: 'longtext', max: 10_000 },
      { key: 'deviations', label: 'Déviations anormales', kind: 'longtext', max: 10_000 },
      { key: 'additionalNotes', label: 'Notes additionnelles', kind: 'longtext', max: 10_000 },
    ],
  },
];

export const FIELD_DEFS: Record<string, FieldDef> = Object.fromEntries(NOON_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, f])));
export const FIELD_SECTION: Record<string, string> = Object.fromEntries(NOON_SECTIONS.flatMap((s) => s.fields.map((f) => [f.key, s.key])));
export const NOON_FIELDS: NoonField[] = NOON_SECTIONS.flatMap((s) => s.fields.map((f) => f.key));

// -----------------------------------------------------------------------------
// Plages numériques (miroir NOON_NUMERIC_RULES)
// -----------------------------------------------------------------------------

interface NumericRule {
  min: number;
  max: number;
  maxExclusive?: boolean;
  scale: number;
  label: string;
}

export const NOON_NUMERIC_RULES: Record<string, NumericRule> = {
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
};

/** Contrôle d'un décimal (chaîne normalisée « . »). Retourne un message FR ou null. */
export function checkDecimal(raw: string, rule: NumericRule): string | null {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) return `${rule.label} : nombre décimal invalide`;
  const n = Number(raw);
  if (n < rule.min) return `${rule.label} : doit être ≥ ${rule.min}`;
  if (rule.maxExclusive ? n >= rule.max : n > rule.max) return `${rule.label} : doit être ${rule.maxExclusive ? '<' : '≤'} ${rule.max}`;
  if ((raw.split('.')[1]?.length ?? 0) > rule.scale) return `${rule.label} : au plus ${rule.scale} décimales`;
  return null;
}

export function checkUtcOffset(v: number): string | null {
  if (!Number.isInteger(v) || v < -720 || v > 840) return 'Décalage UTC : entre -12:00 et +14:00';
  if (v % 15 !== 0) return 'Décalage UTC : multiple de 15 minutes';
  return null;
}

// -----------------------------------------------------------------------------
// Coordonnées : décimal ou degrés / minutes / secondes avec N S E W
// -----------------------------------------------------------------------------

export type Axis = 'lat' | 'lon';

/** Analyse une saisie de position : « 37.6 », « -11.25 », « 37°36.0'N », « 37 36 N », « N 37 36.5 », « 011 15 W ». */
export function parseCoordinate(input: string, axis: Axis): { value: string | null; error?: string } {
  const raw = input.trim().toUpperCase().replace(/,/g, '.');
  if (!raw) return { value: null };
  const hemiMatch = raw.match(/[NSEWO]/g);
  const hemis = hemiMatch ? [...new Set(hemiMatch)] : [];
  if (hemis.length > 1) return { value: null, error: 'Un seul hémisphère (N/S ou E/W)' };
  const hemi = hemis[0] === 'O' ? 'W' : hemis[0];
  if (hemi && axis === 'lat' && !['N', 'S'].includes(hemi)) return { value: null, error: 'Latitude : hémisphère N ou S' };
  if (hemi && axis === 'lon' && !['E', 'W'].includes(hemi)) return { value: null, error: 'Longitude : hémisphère E ou W' };
  const negative = /^\s*-/.test(raw);
  if (negative && hemi) return { value: null, error: 'Utiliser soit le signe « - », soit l’hémisphère' };
  const nums = raw
    .replace(/[NSEWO]/g, ' ')
    .replace(/^-/, '')
    .split(/[^0-9.]+/)
    .filter(Boolean);
  if (!nums.length || nums.length > 3 || nums.some((n) => !/^\d+(\.\d+)?$/.test(n))) {
    return { value: null, error: 'Format : 37.6, -37.6, 37°36.0′ N ou 37 36 N' };
  }
  const [d, m = '0', s = '0'] = nums;
  const deg = Number(d);
  const min = Number(m);
  const sec = Number(s);
  if (nums.length >= 2 && !Number.isInteger(deg)) return { value: null, error: 'Degrés entiers lorsque les minutes sont saisies' };
  if (min >= 60 || sec >= 60) return { value: null, error: 'Minutes et secondes < 60' };
  let dec = deg + min / 60 + sec / 3600;
  if (negative || hemi === 'S' || hemi === 'W') dec = -dec;
  const limit = axis === 'lat' ? 90 : 180;
  if (Math.abs(dec) > limit) return { value: null, error: axis === 'lat' ? 'Latitude entre -90 et 90' : 'Longitude entre -180 et 180' };
  const fixed = dec.toFixed(6).replace(/\.?0+$/, '');
  return { value: fixed === '-0' ? '0' : fixed };
}

/** « 37.6 » -> « 37° 36,000′ N » (affichage marin). */
export function formatCoordinate(v: string | number | null | undefined, axis: Axis): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (Number.isNaN(n)) return String(v);
  const hemi = axis === 'lat' ? (n < 0 ? 'S' : 'N') : n < 0 ? 'W' : 'E';
  const abs = Math.abs(n);
  let deg = Math.floor(abs);
  let min = Number(((abs - deg) * 60).toFixed(3));
  if (min >= 60) {
    deg += 1;
    min = 0;
  }
  return `${axis === 'lon' ? String(deg).padStart(3, '0') : String(deg).padStart(2, '0')}° ${min.toFixed(3).replace('.', ',').padStart(6, '0')}′ ${hemi}`;
}

export function formatPosition(lat: string | null | undefined, lon: string | null | undefined): string {
  if (!lat && !lon) return '—';
  return `${formatCoordinate(lat, 'lat')} / ${formatCoordinate(lon, 'lon')}`;
}

// -----------------------------------------------------------------------------
// Heure locale / décalage UTC
// -----------------------------------------------------------------------------

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Options de décalage : -12:00 à +14:00 par pas de 15 min. */
export const UTC_OFFSET_OPTIONS = Array.from({ length: (840 + 720) / 15 + 1 }, (_, i) => -720 + i * 15);

/** Heure locale du bord (« AAAA-MM-JJ HH:mm ») à partir de l'UTC et du décalage. */
export function localFromUtc(utcInput: string, offsetMinutes: number): string {
  if (!utcInput) return '';
  const d = new Date(`${utcInput.length === 16 ? `${utcInput}:00` : utcInput}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 16);
}

export function utcFromLocal(localInput: string, offsetMinutes: number): string {
  if (!localInput) return '';
  const d = new Date(`${localInput.length === 16 ? `${localInput}:00` : localInput}Z`);
  if (Number.isNaN(d.getTime())) return '';
  return new Date(d.getTime() - offsetMinutes * 60_000).toISOString().slice(0, 16);
}

/** Décalage courant d'un fuseau IANA (ex. Africa/Tunis -> 60), arrondi au quart d'heure ; null si inconnu. */
export function offsetForTimeZone(tz: string | null | undefined, at = new Date()): number | null {
  if (!tz) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' }).formatToParts(at);
    const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
    const m = name.match(/GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/);
    if (!m) return null;
    if (!m[1]) return 0;
    const v = (Number(m[2]) * 60 + Number(m[3] ?? 0)) * (m[1] === '-' ? -1 : 1);
    return Math.round(v / 15) * 15;
  } catch {
    return null;
  }
}

/** « 2026-02-10 12:00 (UTC+01:00) » à partir d'une date ISO UTC et d'un décalage. */
export function localLabel(utcIso: string | null | undefined, offsetMinutes: number): string {
  if (!utcIso) return '—';
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return '—';
  const local = new Date(d.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');
  return `${local} (${formatUtcOffset(offsetMinutes)})`;
}

// -----------------------------------------------------------------------------
// Valeurs de formulaire (chaînes) <-> API
// -----------------------------------------------------------------------------

export type FormValues = Record<NoonField, string>;

function toUtcInput(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16);
}

export function toFormValues(r: Partial<NoonValuesDto>): FormValues {
  const out = {} as FormValues;
  for (const k of NOON_FIELDS) {
    const def = FIELD_DEFS[k];
    const v = r[k];
    if (def.kind === 'datetime') out[k] = toUtcInput(v as string | null);
    else out[k] = v === null || v === undefined ? '' : String(v);
  }
  return out;
}

export type ApiValue = string | number | null;

/** Valeur API d'un champ, ou erreur de format / plage. */
export function toApiValue(k: NoonField, raw: string): { value: ApiValue; error?: string } {
  const def = FIELD_DEFS[k];
  const s = raw.trim();
  switch (def.kind) {
    case 'text':
    case 'longtext':
      return { value: s === '' ? null : s };
    case 'enum':
      if (k === 'reportType' || k === 'consumptionBasis') return s ? { value: s } : { value: null, error: `${def.label} requis` };
      return { value: s === '' ? null : s };
    case 'datetime':
      if (!s) return k === 'reportDateUtc' ? { value: null, error: 'Date du rapport requise' } : { value: null };
      return { value: `${s.length === 16 ? `${s}:00` : s}Z` };
    case 'offset': {
      const n = Number(s);
      const err = s === '' ? 'Décalage requis' : checkUtcOffset(n);
      return err ? { value: null, error: err } : { value: n };
    }
    case 'beaufort': {
      if (!s) return { value: null };
      const n = Number(s);
      return Number.isInteger(n) && n >= 0 && n <= 12 ? { value: n } : { value: null, error: 'Force du vent : échelle de Beaufort 0 à 12' };
    }
    case 'coordinate': {
      const p = parseCoordinate(s, k === 'latitude' ? 'lat' : 'lon');
      if (p.error) return { value: null, error: p.error };
      if (p.value === null) return { value: null };
      const err = checkDecimal(p.value, NOON_NUMERIC_RULES[k]);
      return err ? { value: null, error: err } : { value: p.value };
    }
    case 'decimal': {
      if (!s) return { value: null };
      const norm = s.replace(',', '.');
      const err = checkDecimal(norm, NOON_NUMERIC_RULES[k]);
      return err ? { value: null, error: err } : { value: norm };
    }
  }
}

/** Valeurs API de tous les champs + erreurs de format / plage. */
export function toApiValues(values: FormValues): { api: Record<string, ApiValue>; errors: Record<string, string> } {
  const api: Record<string, ApiValue> = {};
  const errors: Record<string, string> = {};
  for (const k of NOON_FIELDS) {
    const r = toApiValue(k, values[k] ?? '');
    api[k] = r.value;
    if (r.error) errors[k] = r.error;
  }
  return { api, errors };
}

/** Comparaison normalisée (12.50 == 12.5 ; 37°36′N == 37.6). */
export function sameValue(k: NoonField, a: string, b: string): boolean {
  if (a === b) return true;
  const va = toApiValue(k, a);
  const vb = toApiValue(k, b);
  if (va.error || vb.error) return false;
  if (typeof va.value === 'string' && typeof vb.value === 'string' && FIELD_DEFS[k].kind !== 'text' && FIELD_DEFS[k].kind !== 'longtext') {
    const na = Number(va.value);
    const nb = Number(vb.value);
    if (!Number.isNaN(na) && !Number.isNaN(nb) && /^-?\d/.test(va.value)) return na === nb;
  }
  return va.value === vb.value;
}

// -----------------------------------------------------------------------------
// Cohérence et champs minimaux (miroir validateNoonConsistency / missingForSubmission)
// -----------------------------------------------------------------------------

const blank = (v: ApiValue | undefined) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

export function consistencyIssues(api: Record<string, ApiValue>, now = new Date()): NoonIssue[] {
  const issues: NoonIssue[] = [];
  if (api.consumptionBasis === 'DAILY_24H' && !blank(api.runningHours) && Number(api.runningHours) > 24) {
    issues.push({ path: 'runningHours', message: 'Base « Daily (24 h) » : heures de marche ≤ 24' });
  }
  const report = typeof api.reportDateUtc === 'string' ? new Date(api.reportDateUtc) : null;
  const eta = typeof api.etaNextPort === 'string' ? new Date(api.etaNextPort) : null;
  if (report && eta && eta < report) issues.push({ path: 'etaNextPort', message: 'ETA du prochain port antérieure à la date du rapport' });
  if (report && report.getTime() > now.getTime() + 24 * 3_600_000) issues.push({ path: 'reportDateUtc', message: 'Date du rapport dans le futur' });
  return issues;
}

export function missingForSubmission(api: Record<string, ApiValue>): NoonIssue[] {
  const issues: NoonIssue[] = [];
  const need = (field: string, message: string) => {
    if (blank(api[field])) issues.push({ path: field, message });
  };
  need('reportType', 'Type de rapport requis');
  need('reportDateUtc', 'Date / heure UTC du rapport requise');
  need('utcOffsetMinutes', 'Décalage horaire local requis');
  need('masterName', 'Nom du Master requis');
  need('latitude', 'Latitude requise');
  need('longitude', 'Longitude requise');
  need('consumptionBasis', 'Base de consommation requise (since last report / daily 24 h)');
  const speed = blank(api.speedKnots) ? null : Number(api.speedKnots);
  if (!speed && blank(api.remarks)) issues.push({ path: 'speedKnots', message: 'Vitesse requise, ou motif de son absence dans « Remarks »' });
  if (speed && speed > 0) need('courseDeg', 'Cap requis lorsque le navire fait route');
  const type = api.reportType;
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

/** Contrôle complet avant soumission / correction (format, plages, cohérence, champs minimaux). */
export function submissionIssues(values: FormValues): NoonIssue[] {
  const { api, errors } = toApiValues(values);
  return [...missingForSubmission(api), ...Object.entries(errors).map(([path, message]) => ({ path, message })), ...consistencyIssues(api)];
}

/** Affichage lisible d'une valeur de snapshot / API pour un champ. */
export function displayValue(k: string, v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—';
  const def = FIELD_DEFS[k];
  if (!def) return String(v);
  if (def.kind === 'coordinate') return formatCoordinate(v, k === 'latitude' ? 'lat' : 'lon');
  if (def.kind === 'enum' && def.options) return def.options[String(v)] ?? String(v);
  if (def.kind === 'offset') return formatUtcOffset(Number(v));
  if (def.kind === 'beaufort') return `${v} Bft — ${BEAUFORT_LABELS[Number(v)] ?? ''}`;
  if (def.kind === 'datetime') {
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? String(v) : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  }
  if (def.kind === 'decimal') return `${String(v).replace('.', ',')}${def.unit ? ` ${def.unit}` : ''}`;
  return String(v);
}
