import { ExcelService } from './excel.service';

/** Normalisation des dates des fichiers AMC (CDC V1 §5.3). */
describe('ExcelService.parseDate', () => {
  it('texte JJ.MM.AAAA', () => {
    expect(ExcelService.parseDate('15.03.2027')).toEqual({ kind: 'DATE', value: '2027-03-15' });
    expect(ExcelService.parseDate('01/02/90')).toEqual({ kind: 'DATE', value: '1990-02-01' });
  });

  it('numéro de série Excel', () => {
    // 45658 = 2025-01-01 dans le système de dates 1900
    expect(ExcelService.parseDate(45658)).toEqual({ kind: 'DATE', value: '2025-01-01' });
  });

  it('PERMANENT / illimité => UNLIMITED (aucune alerte d’expiration)', () => {
    expect(ExcelService.parseDate('PERMANENT')).toEqual({ kind: 'UNLIMITED' });
    expect(ExcelService.parseDate('Illimité')).toEqual({ kind: 'UNLIMITED' });
  });

  it('cellule vide => EMPTY (échéance inconnue)', () => {
    expect(ExcelService.parseDate(null)).toEqual({ kind: 'EMPTY' });
    expect(ExcelService.parseDate('  ')).toEqual({ kind: 'EMPTY' });
    expect(ExcelService.parseDate('N/A')).toEqual({ kind: 'EMPTY' });
  });

  it('date impossible => INVALID (jamais de correction silencieuse)', () => {
    expect(ExcelService.parseDate('31.02.2026')).toEqual({ kind: 'INVALID', raw: '31.02.2026' });
    expect(ExcelService.parseDate('bientôt')).toEqual({ kind: 'INVALID', raw: 'bientôt' });
  });
});

describe('ExcelService.writeCsv', () => {
  it('neutralise l’injection de formules et échappe les séparateurs', () => {
    const csv = new ExcelService()
      .writeCsv(
        [
          { header: 'Désignation', key: 'd' },
          { header: 'Qté', key: 'q' },
        ],
        [{ d: '=HYPERLINK("x")', q: '3;5' }],
      )
      .toString('utf8');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain('"3;5"');
  });
});
