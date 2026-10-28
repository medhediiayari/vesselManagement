'use client';

import { VESSEL_STATUS_LABELS } from '@amc/types';
import type { UseQueryResult } from '@tanstack/react-query';
import { Ship } from 'lucide-react';
import Link from 'next/link';
import { cn, fmtDateTime, fmtRelative } from '@/lib/format';
import type { VesselRef } from '@/lib/session';
import { SecureImage } from '@/components/amc/secure-image';
import { formatCoordinate } from '@/components/noon/lib';
import { Badge, StatusBadge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/states';
import { ScrollHint } from './dashboard-card';
import type { ActiveVoyage, VesselWorkspace } from './types';

const muted = <span className="text-ink-soft">—</span>;

/** Situation déduite des données déclarées : voyage actif + escale en cours (ATA sans ATD). */
function Situation({ voyage, itinerary }: { voyage: { id: string; reference: string } | null; itinerary: ActiveVoyage | undefined }) {
  if (!voyage) return <span className="text-sm text-ink-muted">Sans voyage actif</span>;
  const alongside = itinerary?.alongsidePort;
  return (
    <>
      <span className="flex items-center gap-1.5 whitespace-nowrap text-sm font-medium text-ink">
        <span className={cn('h-2 w-2 shrink-0 rounded-full', alongside ? 'bg-info' : 'bg-ok')} aria-hidden />
        {alongside ? 'À quai' : 'En route'}
      </span>
      <Link href={`/voyages/${voyage.id}`} className="ref block truncate text-xs text-action hover:underline">
        {voyage.reference}
      </Link>
    </>
  );
}

function CertificateRatio({ vesselId, c }: { vesselId: string; c: NonNullable<VesselWorkspace['sections']['certificates']> }) {
  if (!c.total) return <span className="text-sm text-ink-muted">Aucun</span>;
  // « Échéance inconnue » n'est jamais comptée comme valide
  const valid = c.total - c.expired - c.expiryUnknown;
  const tone = c.expired ? 'danger' : c.expiringWithin90Days || c.expiryUnknown || c.documentMissing ? 'warn' : 'ok';
  const detail = [
    c.expired && `${c.expired} expiré${c.expired > 1 ? 's' : ''}`,
    c.expiringWithin90Days && `${c.expiringWithin90Days} sous 90 j`,
    c.expiryUnknown && `${c.expiryUnknown} échéance inconnue`,
    c.documentMissing && `${c.documentMissing} justificatif manquant`,
  ].filter(Boolean);
  return (
    <Link href={`/certificates?vesselId=${vesselId}`} className="inline-flex flex-col items-start hover:underline" aria-label={`${valid} certificats valides sur ${c.total}${detail.length ? ` : ${detail.join(', ')}` : ''}`}>
      <Badge tone={tone} className="tabular">
        {valid} / {c.total}
      </Badge>
      {detail[0] && <span className={cn('mt-0.5 text-xs', tone === 'danger' ? 'text-danger' : 'text-warn')}>{detail[0]}</span>}
    </Link>
  );
}

/**
 * Aperçu de la flotte : une ligne par navire du périmètre, données de `/vessels/:id/workspace`
 * (chaque section n'existe qu'avec la permission correspondante, « — » sinon).
 */
export function FleetOverview({
  vessels,
  results,
  activeVoyages,
}: {
  vessels: VesselRef[];
  results: UseQueryResult<VesselWorkspace>[];
  activeVoyages: ActiveVoyage[];
}) {
  const itineraries = new Map(activeVoyages.map((v) => [v.id, v]));
  return (
    <>
      <ScrollHint />
      <div className="relative -mx-4 overflow-x-auto">
        <table className="table-amc min-w-[700px]">
          <caption className="sr-only">Aperçu de la flotte : type, situation, dernière position déclarée et certificats par navire</caption>
          <thead>
            <tr>
              <th scope="col">Navire</th>
              <th scope="col">Situation</th>
              <th scope="col">Dernière position</th>
              <th scope="col">Prochain port</th>
              <th scope="col">Certificats valides</th>
            </tr>
          </thead>
          <tbody>
            {vessels.map((v, i) => {
              const r = results[i];
              const ws = r?.data;
              const s = ws?.sections;
              const voyage = s?.voyages?.active ?? null;
              const itinerary = voyage ? itineraries.get(voyage.id) : undefined;
              const noon = s?.voyages?.lastNoonReport ?? null;
              const nextPortName = noon?.nextPort ?? itinerary?.nextPort?.name ?? null;
              const nextPortEta = noon?.nextPort ? noon.etaNextPort : (itinerary?.nextPort?.eta ?? null);
              return (
                <tr key={v.id}>
                  <td>
                    <div className="flex items-center gap-3">
                      {ws?.vessel.photoFileId ? (
                        <SecureImage fileId={ws.vessel.photoFileId} alt="" className="h-9 w-14 shrink-0 rounded border border-line" />
                      ) : (
                        <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded border border-line bg-navy-50 text-navy-600" aria-hidden>
                          <Ship className="h-4 w-4" />
                        </span>
                      )}
                      <span className="min-w-0">
                        <Link href={`/vessels/${v.id}`} className="block truncate font-semibold text-navy hover:text-action hover:underline">
                          {v.name}
                        </Link>
                        <span className="block truncate text-xs text-ink-muted">
                          <span className="ref">{v.imoNumber ? `IMO ${v.imoNumber}` : v.code}</span>
                          {ws?.vessel.vesselType && ` · ${ws.vessel.vesselType}`}
                        </span>
                      </span>
                    </div>
                  </td>
                  {r?.isLoading ? (
                    Array.from({ length: 4 }).map((_, k) => (
                      <td key={k}>
                        <Skeleton className="h-4 w-20" />
                      </td>
                    ))
                  ) : r?.error || !s ? (
                    <td colSpan={4} className="text-sm text-ink-muted">
                      Synthèse indisponible pour ce navire.
                    </td>
                  ) : (
                    <>
                      <td>
                        {v.status !== 'ACTIVE' ? (
                          <StatusBadge status={v.status} labels={VESSEL_STATUS_LABELS} />
                        ) : s.voyages ? (
                          <Situation voyage={voyage} itinerary={itinerary} />
                        ) : (
                          muted
                        )}
                      </td>
                      <td>
                        {!noon ? (
                          s.voyages && s.voyages.lastNoonReport === null && voyage ? <span className="text-sm text-ink-muted">Aucun Noon Report</span> : muted
                        ) : (
                          <>
                            {noon.latitude || noon.longitude ? (
                              <span className="ref block whitespace-nowrap text-xs text-ink">
                                {formatCoordinate(noon.latitude, 'lat')}
                                <br />
                                {formatCoordinate(noon.longitude, 'lon')}
                              </span>
                            ) : (
                              <span className="text-sm text-ink-muted">Position non renseignée</span>
                            )}
                            <span className="block whitespace-nowrap text-xs text-ink-muted" title={fmtDateTime(noon.reportDateUtc)}>
                              Noon {fmtRelative(noon.reportDateUtc)}
                            </span>
                            {itinerary?.noonReportMissing && <span className="block text-xs font-medium text-warn">Non reçu &gt; 30 h</span>}
                          </>
                        )}
                      </td>
                      <td>
                        {nextPortName ? (
                          <>
                            <span className="block truncate text-sm text-ink">{nextPortName}</span>
                            {nextPortEta && <span className="tabular block whitespace-nowrap text-xs text-ink-muted">ETA {fmtDateTime(nextPortEta)}</span>}
                          </>
                        ) : (
                          muted
                        )}
                      </td>
                      <td>{s.certificates ? <CertificateRatio vesselId={v.id} c={s.certificates} /> : muted}</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
