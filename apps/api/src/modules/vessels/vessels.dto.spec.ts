import { VesselBaseSchema, isValidImo, isValidTimeZone, vesselConsistencyErrors } from './vessels.dto';

describe('Numéro OMI (anti-doublon et validation des identifiants, CDC §3.1)', () => {
  it('valide la clé de contrôle (ISKANDER 9375587)', () => {
    expect(isValidImo('9375587')).toBe(true);
  });

  it('refuse une clé incorrecte ou un format invalide', () => {
    expect(isValidImo('9375588')).toBe(false);
    expect(isValidImo('937558')).toBe(false);
    expect(isValidImo('ABCDEFG')).toBe(false);
  });

  it('accepte le préfixe « IMO » à la saisie', () => {
    const r = VesselBaseSchema.parse({ code: 'isk', name: 'M/V TEST', imoNumber: 'IMO 9375587' });
    expect(r.imoNumber).toBe('9375587');
    expect(r.code).toBe('ISK');
  });
});

describe('Fuseau horaire IANA (audit FLT-01)', () => {
  it('accepte un fuseau IANA et le met sous forme canonique', () => {
    expect(isValidTimeZone('Africa/Tunis')).toBe(true);
    expect(VesselBaseSchema.partial().parse({ timezone: 'africa/tunis' }).timezone).toBe('Africa/Tunis');
    expect(VesselBaseSchema.partial().parse({ timezone: 'UTC' }).timezone).toBe('UTC');
  });

  it('refuse un fuseau inconnu ou vide', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('Africa/Tunisia')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(VesselBaseSchema.partial().safeParse({ timezone: 'Mars/Olympus' }).success).toBe(false);
    expect(VesselBaseSchema.partial().safeParse({ timezone: '' }).success).toBe(false);
  });
});

describe('Vraisemblance des caractéristiques (audit FLT-20)', () => {
  it('année de construction au plus année courante + 3', () => {
    const y = new Date().getUTCFullYear();
    expect(vesselConsistencyErrors({ yearBuilt: y + 3 })).toEqual([]);
    expect(vesselConsistencyErrors({ yearBuilt: 2099 }).map((e) => e.path)).toEqual(['yearBuilt']);
  });

  it('jauge nette au plus la jauge brute', () => {
    expect(vesselConsistencyErrors({ grossTonnage: '1000', netTonnage: '1000' })).toEqual([]);
    expect(vesselConsistencyErrors({ grossTonnage: '1000', netTonnage: '5000' }).map((e) => e.path)).toEqual(['netTonnage']);
    expect(vesselConsistencyErrors({ grossTonnage: null, netTonnage: '5000' })).toEqual([]);
  });
});
