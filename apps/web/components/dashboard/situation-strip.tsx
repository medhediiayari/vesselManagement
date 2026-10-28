import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

export interface SituationCell {
  key: string;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'critical' | 'warn' | 'ok';
}

const TONE: Record<NonNullable<SituationCell['tone']>, string> = {
  critical: 'text-[#FFA197]',
  warn: 'text-[#F8C77E]',
  ok: 'text-[#86DDB8]',
};

/**
 * Bande de situation (lecture passerelle) : quelques chiffres réels en tête du tableau de bord, sur fond marine.
 * Les valeurs proviennent des mêmes sources que les blocs détaillés en dessous ; la couleur double le libellé.
 */
export function SituationStrip({ cells }: { cells: SituationCell[] }) {
  if (!cells.length) return null;
  return (
    <section aria-label="Situation" className="relative mb-5 overflow-hidden rounded-lg bg-navy text-white">
      <span className="absolute inset-x-0 top-0 h-[3px] bg-teal" aria-hidden />
      <dl className="grid grid-cols-2 sm:grid-cols-3 xl:flex">
        {cells.map((c) => (
          <div key={c.key} className="min-w-0 flex-1 border-white/10 px-4 pb-3 pt-4 xl:border-l xl:first:border-l-0">
            <dt className="truncate text-2xs font-semibold uppercase tracking-[0.08em] text-white/55">{c.label}</dt>
            <dd className={cn('mt-0.5 truncate text-xl font-semibold tabular leading-8', c.tone ? TONE[c.tone] : 'text-white')}>{c.value}</dd>
            {c.sub && <dd className="truncate text-xs text-white/65">{c.sub}</dd>}
          </div>
        ))}
      </dl>
    </section>
  );
}
