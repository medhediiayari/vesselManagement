import { CreateExportSchema } from './exports.controller';

describe('ADM-11 — filtres d’export validés par ressource', () => {
  it('refuse un navire, une date ou une clé invalides (422 au lieu de 500)', () => {
    expect(CreateExportSchema.safeParse({ resource: 'certificates', filters: { vesselId: 'abc' } }).success).toBe(false);
    expect(CreateExportSchema.safeParse({ resource: 'audit', filters: { from: 'abc' } }).success).toBe(false);
    expect(CreateExportSchema.safeParse({ resource: 'audit', filters: { module: 'inconnu' } }).success).toBe(false);
    expect(CreateExportSchema.safeParse({ resource: 'vessels', filters: { search: 'x' } }).success).toBe(false);
    const bad = CreateExportSchema.safeParse({ resource: 'certificates', filters: { subjectKind: 'CREW' } });
    expect(!bad.success && bad.error.issues[0].path).toEqual(['filters', 'subjectKind']);
  });

  it('accepte les filtres connus', () => {
    expect(
      CreateExportSchema.safeParse({
        resource: 'certificates',
        format: 'CSV',
        filters: { vesselId: '0b9d2c56-2f43-4f7e-9a51-0b8d3f0b2a11', subjectKind: 'VESSEL', includeArchived: 'true' },
      }).success,
    ).toBe(true);
    expect(CreateExportSchema.safeParse({ resource: 'audit', filters: { module: 'auth', from: '2026-10-01', to: '2026-10-30T23:59:59Z' } }).success).toBe(true);
    expect(CreateExportSchema.safeParse({ resource: 'vessels' }).success).toBe(true);
  });
});
