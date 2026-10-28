import { PdfService } from '../documents/pdf.service';
import { CONSUMPTION_BASIS_LABELS, NOON_SECTIONS, NoonSnapshot, SnapshotValue, formatUtcOffset } from './noon.logic';

function fmtValue(kind: string, v: SnapshotValue, unit?: string, key?: string): string | null {
  if (v === null || v === '') return null;
  if (kind === 'datetime') return `${String(v).slice(0, 16).replace('T', ' ')} UTC`;
  if (key === 'utcOffsetMinutes') return formatUtcOffset(Number(v));
  if (key === 'consumptionBasis') return CONSUMPTION_BASIS_LABELS[String(v)] ?? String(v);
  if (key === 'windForceBeaufort') return `${v} Bft`;
  return unit ? `${v} ${unit}` : String(v);
}

/**
 * PDF lisible du Noon Report en 7 sections (CDC §8.3), généré depuis le snapshot FIGÉ de la
 * révision : régénérer le PDF d'une révision produit toujours le même contenu métier.
 */
export function renderNoonPdf(pdf: PdfService, s: NoonSnapshot, opts: { reason?: string | null }): Promise<Buffer> {
  const general = s.sections.general;
  const reportUtc = general.reportDateUtc ? `${String(general.reportDateUtc).slice(0, 16).replace('T', ' ')} UTC` : '—';
  const stamp = String(general.reportDateUtc ?? '').slice(0, 16).replace(/[-:T]/g, '');
  return pdf.render(
    {
      title: `${String(general.reportType ?? 'NOON')} Report`,
      subtitle: `${s.vessel.name}${s.vessel.imoNumber ? ` — IMO ${s.vessel.imoNumber}` : ''} — Voyage ${s.voyage.reference}`,
      reference: `${s.vessel.code}-NR-${stamp} rév. ${s.revisionNo}`,
      meta: [
        ['Date du rapport (UTC)', reportUtc],
        ['Heure locale du bord', s.reportDateLocal || '—'],
        ['Révision', `${s.revisionNo} — ${s.revisionNo > 1 ? 'correction' : 'originale'}`],
      ],
      author: s.author.displayName,
    },
    (b) => {
      for (const section of NOON_SECTIONS) {
        b.section(section.title, section.index);
        const values = s.sections[section.key] ?? {};
        if (section.key === 'general') {
          b.fields(
            [
              ['Vessel', s.vessel.name],
              ['IMO', s.vessel.imoNumber],
              ['Voyage', s.voyage.reference],
              ['Local date / time', s.reportDateLocal || null],
            ],
            2,
          );
        }
        const short = section.fields.filter((f) => !f.long);
        const long = section.fields.filter((f) => f.long);
        if (short.length) {
          b.fields(
            short.map((f) => [f.label, fmtValue(f.kind, values[f.key] ?? null, f.unit, f.key)] as [string, string | null]),
            section.key === 'positionWeather' || section.key === 'engineFuel' ? 3 : 2,
          );
        }
        for (const f of long) b.paragraph(f.label, (values[f.key] as string | null) ?? null);
        if (section.key === 'engineFuel') {
          b.note(
            `Base de consommation déclarée : ${CONSUMPTION_BASIS_LABELS[String(values.consumptionBasis)] ?? '—'}. ` +
              'Valeurs saisies telles quelles (since last report / daily / ROB) : aucun cumul calculé automatiquement.',
          );
        }
      }
      if (opts.reason) {
        b.section('Correction');
        b.paragraph('Motif de la correction', opts.reason);
      }
      b.signatures([
        { label: 'Master', name: (general.masterName as string | null) ?? null, date: s.reportDateLocal || null },
        { label: s.revisionNo > 1 ? 'Corrigé par' : 'Soumis par', name: s.author.displayName, date: `${s.frozenAt.slice(0, 16).replace('T', ' ')} UTC` },
      ]);
      b.note(
        `Révision ${s.revisionNo} figée : toute correction ultérieure fait l’objet d’une nouvelle révision sans remplacer l’originale (CDC §8.3). ` +
          'Attribution et horodatage plateforme — pas de signature cryptographique en V1.',
      );
    },
  );
}
