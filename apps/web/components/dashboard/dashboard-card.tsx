import { ChevronRight } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

/**
 * Bloc du tableau de bord : surface plate à filet, titre et lien « Voir tout » vers la liste complète.
 * Le lien est nommé explicitement pour les lecteurs d'écran (plusieurs « Voir tout » sur la page).
 */
export function DashboardCard({
  title,
  href,
  linkLabel,
  meta,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode;
  href?: string;
  /** Nom accessible du lien « Voir tout » (ex. « Voir tous les certificats ») */
  linkLabel?: string;
  meta?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn('panel flex min-w-0 flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-4 pb-2 pt-3.5">
        <div className="min-w-0">
          <h2 className="truncate text-[15px] font-semibold leading-6">{title}</h2>
          {meta && <p className="truncate text-xs text-ink-muted">{meta}</p>}
        </div>
        {href && (
          <Link href={href} aria-label={linkLabel} className="inline-flex shrink-0 items-center gap-0.5 text-sm font-medium text-action hover:underline">
            Voir tout <ChevronRight className="h-4 w-4" aria-hidden />
          </Link>
        )}
      </div>
      <div className={cn('min-w-0 flex-1 px-4 pb-4', bodyClassName)}>{children}</div>
    </section>
  );
}

/** Indication de défilement horizontal des tableaux sur petit écran (aucune colonne masquée en silence). */
export function ScrollHint() {
  return <p className="pb-1.5 text-xs text-ink-muted md:hidden">Faites défiler le tableau horizontalement pour voir toutes les colonnes.</p>;
}
