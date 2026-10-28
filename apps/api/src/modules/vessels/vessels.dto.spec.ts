import { VesselBaseSchema, isValidImo } from './vessels.dto';

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
