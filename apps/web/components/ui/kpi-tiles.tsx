'use client';

import type { LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Skeleton } from './states';

export type KpiTone = 'navy' | 'teal' | 'warn' | 'info' | 'ok' | 'danger' | 'neutral';
const TILE: Record<KpiTone, string> = {
  navy: 'bg-navy-50 text-navy',
  teal: 'bg-teal-50 text-teal-700',
  warn: 'bg-warn-bg text-warn',
  info: 'bg-info-bg text-info',
  ok: 'bg-ok-bg text-ok',
  danger: 'bg-danger-bg text-danger',
  neutral: 'bg-neutral-bg text-neutral',
};

export interface KpiTile {
  key: string;
  icon: LucideIcon;
  tone: KpiTone;
  value: ReactNode;
  label: string;
  sub?: ReactNode;
  /** Tuile-filtre (bouton à bascule) */
  onClick?: () => void;
  active?: boolean;
  /** Tuile-lien (vers une autre liste) */
  href?: string;
}

/**
 * Rangée d'indicateurs : pastille d'icône teintée, valeur, libellé, précision. Une tuile filtre la liste (bouton,
 * aria-pressed) ou ouvre une autre liste (lien) ; sans action, elle est purement informative.
 */
export function KpiTiles({ tiles, loading, label, className }: { tiles: KpiTile[]; loading?: boolean; label: string; className?: string }) {
  if (loading) {
    return (
      <div className={cn('mb-4 grid grid-cols-2 gap-3 md:grid-cols-3', className)} role="status">
        <span className="sr-only">Chargement des indicateurs…</span>
        {Array.from({ length: Math.max(tiles.length, 6) }).map((_, i) => (
          <Skeleton key={i} className="h-[84px] w-full rounded-lg" />
        ))}
      </div>
    );
  }
  return (
    <ul className={cn('mb-4 grid grid-cols-2 gap-3 md:grid-cols-3', className)} aria-label={label}>
      {tiles.map((k) => {
        const body = (
          <>
            <span className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-lg', TILE[k.tone])} aria-hidden>
              <k.icon className="h-5 w-5" />
            </span>
            <span className="min-w-0 text-left">
              <span className="block text-xs font-medium leading-tight text-ink-muted">{k.label}</span>
              <span className="tabular block text-xl font-semibold leading-7 text-navy">{k.value}</span>
              {k.sub && <span className="block text-xs leading-tight text-ink-muted">{k.sub}</span>}
            </span>
          </>
        );
        const cls = cn(
          'flex h-full w-full items-center gap-3 rounded-lg bg-white p-3 shadow-panel',
          (k.onClick || k.href) && 'transition-shadow hover:shadow-[0_0_0_1px_#C3CED8]',
          k.active && 'shadow-[0_0_0_2px_#176A79] hover:shadow-[0_0_0_2px_#176A79]',
        );
        return (
          <li key={k.key} className="min-w-0">
            {k.href ? (
              <Link href={k.href} className={cls}>
                {body}
              </Link>
            ) : k.onClick ? (
              <button type="button" className={cls} aria-pressed={!!k.active} onClick={k.onClick}>
                {body}
              </button>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
