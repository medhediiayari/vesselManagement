import { Prisma } from '@prisma/client';
import {
  NOON_FIELDS,
  NOON_NUMERIC_RULES,
  NOON_SECTIONS,
  NoonValues,
  buildNoonSnapshot,
  canTransitionNoon,
  checkDecimal,
  checkUtcOffset,
  diffNoonSnapshots,
  flattenSnapshot,
  localTimeLabel,
  missingForSubmission,
  validateForSubmission,
  validateNoonConsistency,
  validateNoonRanges,
} from './noon.logic';

const NOW = new Date('2026-04-23T12:00:00Z');

/** Rapport NOON complet (valeurs saisies par le bord). */
function validReport(over: NoonValues = {}): NoonValues {
  return {
    reportType: 'NOON',
    reportDateUtc: new Date('2026-04-23T11:00:00Z'),
    utcOffsetMinutes: 60,
    masterName: 'Capt. Demo',
    latitude: '35.123456',
    longitude: '10.5',
    courseDeg: '45.5',
    speedKnots: '11.20',
    consumptionBasis: 'SINCE_LAST_REPORT',
    foConsumptionMt: '12.5',
    doConsumptionMt: '0',
    runningHours: '24',
    ...over,
  };
}

const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

describe('Automate Noon Report (CDC §8.1)', () => {
  it('DRAFT → SUBMITTED → ACKNOWLEDGED | CORRECTION_REQUESTED → CORRECTED', () => {
    expect(canTransitionNoon('DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransitionNoon('SUBMITTED', 'ACKNOWLEDGED')).toBe(true);
    expect(canTransitionNoon('SUBMITTED', 'CORRECTION_REQUESTED')).toBe(true);
    expect(canTransitionNoon('CORRECTION_REQUESTED', 'CORRECTED')).toBe(true);
    expect(canTransitionNoon('CORRECTED', 'ACKNOWLEDGED')).toBe(true);
  });

  it('interdit les retours en brouillon et l’accusé direct d’un brouillon', () => {
    expect(canTransitionNoon('SUBMITTED', 'DRAFT')).toBe(false);
    expect(canTransitionNoon('DRAFT', 'ACKNOWLEDGED')).toBe(false);
    expect(canTransitionNoon('DRAFT', 'CORRECTED')).toBe(false);
    expect(canTransitionNoon('CORRECTION_REQUESTED', 'ACKNOWLEDGED')).toBe(false);
    expect(canTransitionNoon('ARCHIVED', 'CORRECTED')).toBe(false);
  });
});

describe('Formulaire en 7 sections (CDC §8.2)', () => {
  it('reproduit les sept sections dans l’ordre', () => {
    expect(NOON_SECTIONS.map((s) => s.title)).toEqual([
      'General Information',
      'Position & Weather',
      'Navigation & Course',
      'Engine & Fuel',
      'Ballast & Cargo',
      'Incidents & Remarks',
      'Maintenance & Observations',
    ]);
    expect(NOON_SECTIONS.map((s) => s.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('ne déclare aucun champ en double', () => {
    expect(new Set(NOON_FIELDS).size).toBe(NOON_FIELDS.length);
  });
});

describe('Plages (CDC §8.3)', () => {
  it('latitude [-90 ; 90], longitude [-180 ; 180]', () => {
    expect(checkDecimal('90', NOON_NUMERIC_RULES.latitude)).toBeNull();
    expect(checkDecimal('-90', NOON_NUMERIC_RULES.latitude)).toBeNull();
    expect(checkDecimal('90.000001', NOON_NUMERIC_RULES.latitude)).toMatch(/≤ 90/);
    expect(checkDecimal('-180', NOON_NUMERIC_RULES.longitude)).toBeNull();
    expect(checkDecimal('180.5', NOON_NUMERIC_RULES.longitude)).toMatch(/≤ 180/);
  });

  it('cap [0 ; 360[', () => {
    expect(checkDecimal('0', NOON_NUMERIC_RULES.courseDeg)).toBeNull();
    expect(checkDecimal('359.9', NOON_NUMERIC_RULES.courseDeg)).toBeNull();
    expect(checkDecimal('360', NOON_NUMERIC_RULES.courseDeg)).toMatch(/< 360/);
    expect(checkDecimal('-1', NOON_NUMERIC_RULES.courseDeg)).toMatch(/≥ 0/);
  });

  it('quantités non négatives, heures de marche 0–48, précision des colonnes', () => {
    expect(checkDecimal('-0.001', NOON_NUMERIC_RULES.foConsumptionMt)).toMatch(/≥ 0/);
    expect(checkDecimal('48', NOON_NUMERIC_RULES.runningHours)).toBeNull();
    expect(checkDecimal('48.01', NOON_NUMERIC_RULES.runningHours)).toMatch(/≤ 48/);
    expect(checkDecimal('12.3456', NOON_NUMERIC_RULES.foConsumptionMt)).toMatch(/3 décimales/);
    expect(checkDecimal('abc', NOON_NUMERIC_RULES.speedKnots)).toMatch(/invalide/);
  });

  it('Beaufort 0–12 et décalage UTC', () => {
    expect(paths(validateNoonRanges({ windForceBeaufort: 12 }))).toEqual([]);
    expect(paths(validateNoonRanges({ windForceBeaufort: 13 }))).toEqual(['windForceBeaufort']);
    expect(checkUtcOffset(60)).toBeNull();
    expect(checkUtcOffset(345)).toBeNull();
    expect(checkUtcOffset(61)).toMatch(/15/);
    expect(checkUtcOffset(900)).toMatch(/-720/);
  });

  it('accepte les Prisma.Decimal lus en base', () => {
    expect(validateNoonRanges({ latitude: new Prisma.Decimal('-33.9'), speedKnots: new Prisma.Decimal('12.5') })).toEqual([]);
  });
});

describe('Cohérence et champs minimaux à la soumission', () => {
  it('un rapport complet est soumissible', () => {
    expect(validateForSubmission(validReport(), NOW)).toEqual([]);
  });

  it('exige position, Master et base de consommation', () => {
    const issues = missingForSubmission(validReport({ latitude: null, longitude: '', masterName: undefined, consumptionBasis: null }));
    expect(paths(issues)).toEqual(expect.arrayContaining(['latitude', 'longitude', 'masterName', 'consumptionBasis']));
  });

  it('vitesse requise, sauf motif dans Remarks', () => {
    expect(paths(missingForSubmission(validReport({ speedKnots: null })))).toContain('speedKnots');
    expect(paths(missingForSubmission(validReport({ speedKnots: null, courseDeg: null, remarks: 'At anchor Gabès roads' })))).toEqual([]);
  });

  it('cap requis quand le navire fait route, pas à l’arrêt', () => {
    expect(paths(missingForSubmission(validReport({ courseDeg: null })))).toContain('courseDeg');
    expect(paths(missingForSubmission(validReport({ courseDeg: null, speedKnots: '0' })))).not.toContain('courseDeg');
  });

  it('NOON / MIDNIGHT : consommations et heures de marche explicites (0 accepté)', () => {
    expect(paths(missingForSubmission(validReport({ foConsumptionMt: null, runningHours: undefined })))).toEqual(
      expect.arrayContaining(['foConsumptionMt', 'runningHours']),
    );
    expect(missingForSubmission(validReport({ foConsumptionMt: '0', doConsumptionMt: '0', runningHours: '0' }))).toEqual([]);
    expect(missingForSubmission(validReport({ reportType: 'ARRIVAL', foConsumptionMt: null, doConsumptionMt: null, runningHours: null }))).toEqual([]);
  });

  it('DEPARTURE : prochain port et ETA requis', () => {
    expect(paths(missingForSubmission(validReport({ reportType: 'DEPARTURE' })))).toEqual(['nextPort', 'etaNextPort']);
  });

  it('base DAILY_24H : jamais plus de 24 h de marche (pas de cumul aveugle)', () => {
    expect(paths(validateNoonConsistency(validReport({ consumptionBasis: 'DAILY_24H', runningHours: '30' }), NOW))).toEqual(['runningHours']);
    expect(validateNoonConsistency(validReport({ consumptionBasis: 'SINCE_LAST_REPORT', runningHours: '30' }), NOW)).toEqual([]);
  });

  it('ETA postérieure au rapport, date non future', () => {
    expect(paths(validateNoonConsistency(validReport({ etaNextPort: new Date('2026-04-20T00:00:00Z') }), NOW))).toEqual(['etaNextPort']);
    expect(paths(validateNoonConsistency(validReport({ reportDateUtc: new Date('2026-04-26T00:00:00Z') }), NOW))).toEqual(['reportDateUtc']);
  });
});

describe('Heure locale', () => {
  it('affiche l’heure du bord avec son décalage', () => {
    expect(localTimeLabel(new Date('2026-02-10T11:00:00Z'), 60)).toBe('2026-02-10 12:00 (UTC+01:00)');
    expect(localTimeLabel(new Date('2026-02-10T11:00:00Z'), -210)).toBe('2026-02-10 07:30 (UTC-03:30)');
  });
});

describe('Snapshot figé et diff de révisions (audit old/new)', () => {
  const meta = (revisionNo: number) => ({
    revisionNo,
    frozenAt: NOW,
    author: { id: 'u1', displayName: 'Capitaine' },
    vessel: { id: 'isk', code: 'ISK', name: 'M/V ISKANDER', imoNumber: '9375587' },
    voyage: { id: 'v1', reference: 'ISK-VOY-2026-0001' },
  });

  it('range les valeurs dans les 7 sections (décimaux en chaîne, dates ISO)', () => {
    const s = buildNoonSnapshot(validReport({ latitude: new Prisma.Decimal('35.123456') }), meta(1));
    expect(Object.keys(s.sections)).toHaveLength(7);
    expect(s.sections.positionWeather.latitude).toBe('35.123456');
    expect(s.sections.general.reportDateUtc).toBe('2026-04-23T11:00:00.000Z');
    expect(s.sections.engineFuel.consumptionBasis).toBe('SINCE_LAST_REPORT');
    expect(s.reportDateLocal).toBe('2026-04-23 12:00 (UTC+01:00)');
    expect(flattenSnapshot(s).speedKnots).toBe('11.20');
  });

  it('ne liste que les champs réellement modifiés (12.50 == 12.5)', () => {
    const a = buildNoonSnapshot(validReport({ foConsumptionMt: '12.50' }), meta(1));
    const b = buildNoonSnapshot(validReport({ foConsumptionMt: '12.5', latitude: '35.2', remarks: 'Corrected position' }), meta(2));
    const diff = diffNoonSnapshots(a, b);
    expect(diff.map((c) => c.field)).toEqual(['latitude', 'remarks']);
    expect(diff[0]).toMatchObject({ section: 'positionWeather', before: '35.123456', after: '35.2' });
  });

  it('aucune différence entre deux snapshots identiques', () => {
    expect(diffNoonSnapshots(buildNoonSnapshot(validReport(), meta(1)), buildNoonSnapshot(validReport(), meta(2)))).toEqual([]);
  });
});
