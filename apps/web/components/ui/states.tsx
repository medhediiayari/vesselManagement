import { AlertOctagon, Inbox, Lock, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';
import { Button } from './button';

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-navy-50', className)} aria-hidden />;
}

export function LoadingBlock({ rows = 5, label = 'Chargement…' }: { rows?: number; label?: string }) {
  return (
    <div className="space-y-2 p-4" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      <div className="mb-3 rounded-full bg-navy-50 p-3 text-navy-600">{icon ?? <Inbox className="h-5 w-5" aria-hidden />}</div>
      <p className="font-semibold text-navy">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-ink-muted">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Forbidden({ message }: { message?: string }) {
  return (
    <EmptyState
      icon={<Lock className="h-5 w-5" aria-hidden />}
      title="Accès non autorisé"
      description={message ?? "Vos droits ou votre périmètre navire ne permettent pas d'afficher ce contenu. Contactez un administrateur si nécessaire."}
    />
  );
}

/** Affiche erreur / accès refusé selon le code renvoyé par l'API. */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 403) return <Forbidden message={error.message} />;
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState title="Introuvable" description={error.message} />;
  }
  return (
    <EmptyState
      icon={<AlertOctagon className="h-5 w-5 text-danger" aria-hidden />}
      title="Le chargement a échoué"
      description={
        <>
          {errorMessage(error)}
          {error instanceof ApiError && error.requestId && (
            <span className="mt-1 block text-xs text-ink-soft">Référence : {error.requestId}</span>
          )}
        </>
      }
      action={
        onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Réessayer
          </Button>
        )
      }
    />
  );
}
