import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

export type RegisterTone = 'danger' | 'warn' | 'info' | 'ok' | 'neutral';

const VALUE_TONE: Record<RegisterTone, string> = {
  danger: 'text-danger',
  warn: 'text-warn',
  info: 'text-info',
  ok: 'text-ok',
  neutral: 'text-navy',
};

/**
 * Registre chiffré : lignes libellé / valeur alignées à droite en chiffres tabulaires, à la manière d'un journal
 * de bord. Remplace les mosaïques de tuiles : on compare d'un coup d'œil, chaque ligne mène à la liste filtrée.
 */
export function Register({ title, children, className }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={className}>
      {title && <h3 className="mb-1 text-xs font-semibold text-ink-muted">{title}</h3>}
      <ul className="divide-y divide-line border-y border-line">{children}</ul>
    </div>
  );
}

/** La couleur n'est qu'un renfort : le libellé porte le sens (WCAG 1.4.1). Une valeur nulle reste neutre. */
export function RegisterRow({
  label,
  value,
  tone = 'neutral',
  href,
  hint,
}: {
  label: ReactNode;
  value: number | string | null | undefined;
  tone?: RegisterTone;
  href?: string;
  hint?: ReactNode;
}) {
  const zero = value === 0 || value === null || value === undefined;
  const content = (
    <>
      <span className="min-w-0 flex-1 text-sm text-ink">
        {label}
        {hint && <span className="block text-xs text-ink-muted">{hint}</span>}
      </span>
      <span className={cn('tabular shrink-0 text-[15px] font-semibold', zero ? 'text-ink-soft' : VALUE_TONE[tone])}>{value ?? '—'}</span>
      {href ? <ChevronRight className="h-4 w-4 shrink-0 text-ink-soft group-hover:text-action" aria-hidden /> : <span className="w-4 shrink-0" aria-hidden />}
    </>
  );
  return (
    <li>
      {href ? (
        <Link href={href} className="group -mx-2 flex items-center gap-3 rounded px-2 py-2 hover:bg-action-50">
          {content}
        </Link>
      ) : (
        <div className="flex items-center gap-3 py-2">{content}</div>
      )}
    </li>
  );
}
