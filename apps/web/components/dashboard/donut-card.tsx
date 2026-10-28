'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/format';
import { DashboardCard } from './dashboard-card';

export interface DonutSegment {
  key: string;
  label: string;
  value: number;
  /** Couleur de la marque uniquement : le texte reste à l'encre (jamais la couleur seule) */
  color: string;
  href?: string;
}

/*
 * Palettes validées (scripts dataviz, surface blanche) :
 *  - STATE : états réglementaires (valide / à surveiller / expiré / sans état). Le gris « sans état » est
 *    volontairement non saturé : il signifie l'absence d'état et porte toujours son libellé.
 *  - STAGE : étapes ordonnées d'un circuit (une seule teinte, du clair au foncé), pas des catégories.
 */
export const STATE = { ok: '#08703F', info: '#1D5FB8', warn: '#C9780A', danger: '#B42318', none: '#7A8896' } as const;
export const STAGE = ['#7FBDC7', '#3F9AA8', '#1F7584', '#0F4A57'] as const;

const SIZE = 124;
const STROKE = 16;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;
/** Espace de surface entre deux segments */
const GAP = 2;

/**
 * Répartition « part d'un tout » (≤ 5 segments) : anneau + légende chiffrée. La légende est l'alternative
 * accessible (liste, valeurs en texte, liens vers les listes filtrées) ; le survol d'un segment ou d'une ligne
 * affiche sa valeur et sa part au centre.
 */
export function DonutCard({
  title,
  href,
  linkLabel,
  centerLabel,
  centerValue,
  segments,
  footnote,
  emptyLabel,
  className,
}: {
  title: string;
  href?: string;
  linkLabel?: string;
  centerLabel: string;
  /** Valeur affichée au centre au repos (par défaut : le total) */
  centerValue?: ReactNode;
  className?: string;
  segments: DonutSegment[];
  footnote?: ReactNode;
  emptyLabel?: string;
}) {
  const [active, setActive] = useState<string | null>(null);
  const total = segments.reduce((s, x) => s + x.value, 0);
  const drawn = segments.filter((s) => s.value > 0);
  const current = segments.find((s) => s.key === active && s.value > 0) ?? null;

  let start = 0;
  const arcs = drawn.map((s) => {
    const len = (s.value / total) * C;
    const dash = drawn.length > 1 ? Math.max(len - GAP, 0.75) : len;
    const arc = { ...s, dash, start };
    start += len;
    return arc;
  });

  return (
    <DashboardCard title={title} href={href} linkLabel={linkLabel} className={className}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
        <div className="relative shrink-0" style={{ width: SIZE, height: SIZE }}>
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} width={SIZE} height={SIZE} className="-rotate-90" aria-hidden>
            <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="#EFF2F5" strokeWidth={STROKE} />
            {arcs.map((a) => (
              <circle
                key={a.key}
                cx={SIZE / 2}
                cy={SIZE / 2}
                r={R}
                fill="none"
                stroke={a.color}
                strokeWidth={STROKE}
                strokeDasharray={`${a.dash} ${C - a.dash}`}
                strokeDashoffset={-a.start}
                className="transition-opacity duration-150"
                style={{ opacity: current && current.key !== a.key ? 0.28 : 1 }}
                onMouseEnter={() => setActive(a.key)}
                onMouseLeave={() => setActive(null)}
              />
            ))}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-5 text-center">
            <span className="tabular text-[26px] font-semibold leading-8 text-navy">{current ? current.value : (centerValue ?? total)}</span>
            <span className="text-2xs leading-tight text-ink-muted">
              {current ? (
                <>
                  {current.label}
                  <span className="tabular block font-semibold text-ink">{Math.round((current.value / total) * 100)} %</span>
                </>
              ) : (
                centerLabel
              )}
            </span>
          </div>
        </div>

        <ul className="min-w-[150px] flex-1" aria-label={`${title} : répartition`}>
          {segments.map((s) => {
            const content = (
              <>
                <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: s.color }} aria-hidden />
                <span className="min-w-0 flex-1 truncate text-ink" title={s.label}>
                  {s.label}
                </span>
                <span className={cn('tabular shrink-0 font-semibold', s.value ? 'text-ink' : 'text-ink-soft')}>{s.value}</span>
              </>
            );
            const row = 'flex items-center gap-2 rounded px-1.5 py-[5px] text-sm';
            return (
              <li key={s.key} onMouseEnter={() => setActive(s.key)} onMouseLeave={() => setActive(null)}>
                {s.href ? (
                  <Link href={s.href} className={cn(row, 'hover:bg-action-50/70')} onFocus={() => setActive(s.key)} onBlur={() => setActive(null)}>
                    {content}
                  </Link>
                ) : (
                  <div className={row}>{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {total === 0 && emptyLabel && <p className="mt-3 text-xs text-ink-muted">{emptyLabel}</p>}
      {footnote && <p className="mt-3 border-t border-line pt-2.5 text-xs text-ink-muted">{footnote}</p>}
    </DashboardCard>
  );
}
