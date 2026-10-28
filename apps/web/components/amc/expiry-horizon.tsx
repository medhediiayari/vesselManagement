'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { cn, fmtDate } from '@/lib/format';

export interface HorizonItem {
  id: string;
  subjectKind: 'VESSEL' | 'MEMBER';
  typeCode: string;
  typeName: string;
  subject: string;
  vesselCode: string | null;
  expiryOn: string;
  daysLeft: number;
  renewalStatus: string;
  documentMissing: boolean;
}

const MIN = -30;
const MAX = 90;
const SPAN = MAX - MIN;

function severity(d: number) {
  if (d < 0) return { fill: '#B42318', ring: '#FDECEA', label: 'Expiré' };
  if (d <= 30) return { fill: '#B54708', ring: '#FEF3E6', label: 'Expire sous 30 jours' };
  return { fill: '#1D5FB8', ring: '#EAF1FB', label: 'Expire sous 90 jours' };
}

/**
 * Horizon des échéances : les certificats posés sur un axe de J-30 à J+90, comme des escales
 * sur une route. Chaque marqueur est un lien ; la liste « Échéances prioritaires » est l'alternative accessible.
 */
export function ExpiryHorizon({ items }: { items: HorizonItem[] }) {
  const [hover, setHover] = useState<string | null>(null);

  // Répartition en couloirs pour éviter les chevauchements de marqueurs proches
  const placed = useMemo(() => {
    const lanes: number[] = [];
    return [...items]
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .map((it) => {
        const x = ((Math.min(Math.max(it.daysLeft, MIN), MAX) - MIN) / SPAN) * 100;
        let lane = lanes.findIndex((lastX) => x - lastX > 2.6);
        if (lane === -1) {
          lane = lanes.length;
          lanes.push(x);
        } else lanes[lane] = x;
        return { ...it, x, lane: Math.min(lane, 4) };
      });
  }, [items]);

  const todayX = ((0 - MIN) / SPAN) * 100;
  const ticks = [-30, 0, 30, 60, 90];
  const expired = items.filter((i) => i.daysLeft < 0).length;
  const soon = items.filter((i) => i.daysLeft >= 0 && i.daysLeft <= 30).length;
  const later = items.length - expired - soon;
  const next = placed.slice(0, 6);

  return (
    <div className="grid gap-x-6 gap-y-4 xl:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0">
        {/* Marge interne : les libellés J-30 / J+90 centrés sur les extrémités restent dans le panneau */}
        <div className="relative mx-6 h-[132px] select-none" role="img" aria-label={`Horizon des échéances : ${expired} certificat(s) expiré(s) depuis moins de 30 jours, ${soon} expirant sous 30 jours, ${items.length} au total sur la période.`}>
          {/* Zone passée (expirés) */}
          <div className="absolute inset-y-6 left-0 rounded-l-md bg-danger-bg/70" style={{ width: `${todayX}%` }} aria-hidden />
          {/* Zone 0–30 j */}
          <div className="absolute inset-y-6 bg-warn-bg/70" style={{ left: `${todayX}%`, width: `${(30 / SPAN) * 100}%` }} aria-hidden />
          {/* Axe */}
          <div className="absolute left-0 right-0 top-[104px] h-px bg-line-strong" aria-hidden />
          {ticks.map((t) => {
            const x = ((t - MIN) / SPAN) * 100;
            return (
              <div key={t} className="absolute top-[100px] -translate-x-1/2 text-center" style={{ left: `${x}%` }} aria-hidden>
                <div className={cn('mx-auto h-2 w-px', t === 0 ? 'bg-navy' : 'bg-line-strong')} />
                <span className={cn('mt-1 block text-xs tabular', t === 0 ? 'font-semibold text-navy' : 'text-ink-muted')}>
                  {t === 0 ? "Aujourd'hui" : t > 0 ? `J+${t}` : `J${t}`}
                </span>
              </div>
            );
          })}
          {/* Ligne « aujourd'hui » */}
          <div className="absolute bottom-7 top-2 w-0.5 bg-navy" style={{ left: `${todayX}%` }} aria-hidden />
          {placed.map((it) => {
            const s = severity(it.daysLeft);
            const top = 84 - it.lane * 16;
            return (
              <Link
                key={it.id}
                href={`/certificates/${it.id}`}
                className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full focus-visible:outline-offset-1"
                style={{ left: `${it.x}%`, top }}
                onMouseEnter={() => setHover(it.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(it.id)}
                onBlur={() => setHover(null)}
                aria-label={`${it.typeName} — ${it.subject} — ${s.label} (${fmtDate(it.expiryOn)})`}
              >
                <span
                  className="block h-3.5 w-3.5 rounded-full border-2 border-white"
                  style={{ background: s.fill, boxShadow: `0 0 0 3px ${s.ring}` }}
                />
                {hover === it.id && (
                  <span className="absolute bottom-5 left-1/2 z-10 w-56 -translate-x-1/2 rounded-md bg-navy px-3 py-2 text-left text-xs text-white shadow-pop">
                    <span className="block font-semibold">{it.typeCode} — {it.subject}</span>
                    <span className="block text-white/80">{it.typeName}</span>
                    <span className="mt-0.5 block tabular">
                      Échéance {fmtDate(it.expiryOn)} ({it.daysLeft < 0 ? `il y a ${-it.daysLeft} j` : `dans ${it.daysLeft} j`})
                    </span>
                    {it.renewalStatus === 'IN_PROGRESS' && <span className="block text-teal-100">Renouvellement en cours</span>}
                    {it.documentMissing && <span className="block text-[#F5C890]">Document manquant</span>}
                  </span>
                )}
              </Link>
            );
          })}
          {!items.length && (
            <p className="absolute inset-x-0 top-10 text-center text-sm text-ink-muted">
              Aucune échéance entre J-30 et J+90 dans votre périmètre.
            </p>
          )}
        </div>
        <div className="mx-6 mt-2 flex flex-wrap gap-4 text-xs text-ink-muted" aria-hidden>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-danger" />Expiré <span className="tabular font-semibold text-ink">{expired}</span></span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-warn" />Sous 30 jours <span className="tabular font-semibold text-ink">{soon}</span></span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full bg-info" />31 à 90 jours <span className="tabular font-semibold text-ink">{later}</span></span>
        </div>
      </div>

      {/* Alternative lisible au graphique : les échéances les plus proches, sans survol nécessaire */}
      <div className="min-w-0 xl:border-l xl:border-line xl:pl-6">
        <h3 className="mb-1.5 text-sm font-semibold text-navy">Échéances prioritaires</h3>
        {next.length === 0 ? (
          <p className="text-sm text-ink-muted">Aucune échéance sur la période.</p>
        ) : (
          <ul className="divide-y divide-line">
            {next.map((it) => {
              const s = severity(it.daysLeft);
              return (
                <li key={it.id}>
                  <Link href={`/certificates/${it.id}`} className="flex items-center gap-2.5 py-1.5 text-sm hover:text-action">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.fill }} aria-hidden />
                    <span className="min-w-0 flex-1 truncate" title={`${it.typeName} — ${it.subject}`}>
                      <span className="font-medium">{it.typeCode}</span> <span className="text-ink-muted">· {it.subject}</span>
                    </span>
                    <span className={cn('shrink-0 text-xs tabular', it.daysLeft < 0 ? 'font-semibold text-danger' : 'text-ink-muted')}>
                      {it.daysLeft < 0 ? `il y a ${-it.daysLeft} j` : it.daysLeft === 0 ? 'aujourd’hui' : `J+${it.daysLeft}`}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {items.length > next.length && <p className="mt-1 text-xs text-ink-soft">+ {items.length - next.length} autre(s) dans l’explorateur.</p>}
      </div>
    </div>
  );
}
