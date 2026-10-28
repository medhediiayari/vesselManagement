import Link from 'next/link';
import type { ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/format';

/** Zone 1 de page : titre + contexte + actions (CDC V1 §2.3). */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumb,
  meta,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumb?: { label: string; href?: string }[];
  meta?: ReactNode;
}) {
  return (
    // En-tête de document : identité de la page séparée du contenu par un filet, comme un en-tête de rapport de bord
    <header className="mb-5 border-b border-line pb-4">
      {breadcrumb && breadcrumb.length > 0 && (
        <nav aria-label="Fil d'Ariane" className="mb-1.5 flex flex-wrap items-center gap-1 text-xs text-ink-muted">
          {breadcrumb.map((b, i) => (
            <span key={i} className="inline-flex items-center gap-1">
              {i > 0 && <ChevronRight className="h-3 w-3 text-ink-soft" aria-hidden />}
              {b.href ? (
                <Link href={b.href} className="hover:text-action hover:underline">
                  {b.label}
                </Link>
              ) : (
                <span aria-current="page" className="text-ink">{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold leading-tight">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-sm text-ink-muted">{description}</p>}
          {meta && <div className="mt-2.5 flex flex-wrap items-center gap-2">{meta}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** Zone 2 : barre de filtres. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-3 flex flex-wrap items-end gap-2 rounded-lg bg-white p-3 shadow-panel', className)} role="search">
      {children}
    </div>
  );
}

export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('panel', className)}>
      {(title || actions) && (
        <div className="flex min-h-[48px] items-center justify-between gap-2 rounded-t-lg border-b border-line bg-surface-sunken px-4 py-2">
          {title && <h2 className="text-[15px] font-semibold leading-6">{title}</h2>}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Liste clé/valeur dense pour fiches détail. */
export function DefinitionGrid({ items, columns = 2 }: { items: [string, ReactNode][]; columns?: 2 | 3 | 4 }) {
  const cols = { 2: 'sm:grid-cols-2', 3: 'sm:grid-cols-3', 4: 'sm:grid-cols-2 lg:grid-cols-4' }[columns];
  return (
    <dl className={cn('grid grid-cols-1 gap-x-6 gap-y-3', cols)}>
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs text-ink-muted">{k}</dt>
          <dd className="mt-0.5 break-words text-sm font-medium text-ink">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}
