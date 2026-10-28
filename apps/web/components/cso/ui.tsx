'use client';

import { CSO_VERSION_STATUS_LABELS } from '@amc/types';
import { AlertTriangle, Archive, CheckCircle2, ChevronRight, Clock, FileText, Folder, Library, Share2, ShieldCheck, Undo2, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn, daysUntil, fmtDate } from '@/lib/format';
import { Badge, type Tone } from '@/components/ui/badge';
import { CSO_ACTION_LABELS, CSO_ACTIONS, CSO_DOC_STATUS_LABELS, type Breadcrumb, type CsoAction, type CsoVersionStatus } from './types';

const VERSION_TONE: Record<CsoVersionStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warn',
  RETURNED: 'danger',
  REJECTED: 'danger',
  PUBLISHED: 'ok',
  SUPERSEDED: 'neutral',
  CANCELLED: 'neutral',
};

const VERSION_ICON: Partial<Record<CsoVersionStatus, ReactNode>> = {
  DRAFT: <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  PENDING_APPROVAL: <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  RETURNED: <Undo2 className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  SUPERSEDED: <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />,
  CANCELLED: <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden />,
};

export function VersionStatusBadge({ status }: { status: CsoVersionStatus | string }) {
  const s = status as CsoVersionStatus;
  return (
    <Badge tone={VERSION_TONE[s] ?? 'info'} icon={VERSION_ICON[s]}>
      {CSO_VERSION_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function DocStatusBadge({ status }: { status: string }) {
  const tone: Tone = status === 'PUBLISHED' ? 'ok' : status === 'ARCHIVED' ? 'neutral' : 'warn';
  const icon =
    status === 'PUBLISHED' ? (
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
    ) : status === 'ARCHIVED' ? (
      <Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />
    ) : (
      <Clock className="h-3.5 w-3.5 shrink-0" aria-hidden />
    );
  return (
    <Badge tone={tone} icon={icon}>
      {CSO_DOC_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

export function ArchivedFolderBadge() {
  return (
    <Badge tone="neutral" icon={<Archive className="h-3.5 w-3.5 shrink-0" aria-hidden />}>
      Archivé
    </Badge>
  );
}

export function ViaShareBadge() {
  return (
    <Badge tone="teal" icon={<Share2 className="h-3.5 w-3.5 shrink-0" aria-hidden />} title="Accès accordé par un partage interne">
      Partagé avec vous
    </Badge>
  );
}

/**
 * Droits effectifs lisibles (CDC §5.3 / priorité UI 2 « permissions visibles ») : uniquement les
 * actions ACCORDÉES, telles que calculées par l'API (permission module ∧ scope ∧ ACL).
 */
export function EffectiveRights({
  actions,
  scope = 'all',
  viaShare,
  label = 'Vos droits',
  className,
}: {
  actions: CsoAction[] | undefined;
  scope?: 'all' | 'document' | 'folder';
  viaShare?: boolean;
  label?: string;
  className?: string;
}) {
  const DOC_ONLY: CsoAction[] = ['folder_create', 'folder_rename', 'folder_archive'];
  const shown = CSO_ACTIONS.filter((a) => actions?.includes(a)).filter((a) => (scope === 'document' ? !DOC_ONLY.includes(a) : true));
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink-muted">
        <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> {label} :
      </span>
      {shown.length === 0 && <span className="text-xs text-ink-muted">aucun</span>}
      <ul className="contents" aria-label={label}>
        {shown.map((a) => (
          <li key={a}>
            <span className="inline-flex items-center gap-1 rounded-full border border-teal-100 bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              {CSO_ACTION_LABELS[a]}
            </span>
          </li>
        ))}
      </ul>
      {viaShare && <ViaShareBadge />}
    </div>
  );
}

/** Date d'échéance (révision / expiration) : texte + icône lorsque dépassée ou proche (≤ 30 j). */
export function DueDate({ value, kind = 'review' }: { value: string | null | undefined; kind?: 'review' | 'expiry' }) {
  if (!value) return <span className="text-ink-soft">—</span>;
  const d = daysUntil(value);
  if (d !== null && d < 0) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-danger" title={kind === 'expiry' ? 'Expiré' : 'Révision dépassée'}>
        <XCircle className="h-3.5 w-3.5" aria-hidden /> {fmtDate(value)}
        <span className="sr-only">{kind === 'expiry' ? '(expiré)' : '(révision dépassée)'}</span>
      </span>
    );
  }
  if (d !== null && d <= 30) {
    return (
      <span className="inline-flex items-center gap-1 font-medium text-warn" title={`Dans ${d} jour(s)`}>
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {fmtDate(value)}
        <span className="sr-only">(dans {d} jour(s))</span>
      </span>
    );
  }
  return <span className="tabular">{fmtDate(value)}</span>;
}

/** Fil d'Ariane CSO : les ancêtres non visibles ne sont jamais nommés (« … »). */
export function CsoBreadcrumb({
  libraryName,
  breadcrumb,
  current,
  onNavigate,
  onRoot,
}: {
  libraryName: string;
  breadcrumb?: Breadcrumb | null;
  current?: string | null;
  onNavigate?: (folderId: string) => void;
  onRoot?: () => void;
}) {
  const item = 'inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-navy-50 hover:text-action';
  return (
    <nav aria-label="Fil d'Ariane du dossier" className="flex min-w-0 flex-wrap items-center gap-0.5 text-sm text-ink-muted">
      {onRoot ? (
        <button type="button" className={item} onClick={onRoot}>
          <Library className="h-3.5 w-3.5" aria-hidden /> {libraryName}
        </button>
      ) : (
        <span className="inline-flex items-center gap-1 px-1">
          <Library className="h-3.5 w-3.5" aria-hidden /> {libraryName}
        </span>
      )}
      {breadcrumb?.truncated && (
        <span className="inline-flex items-center gap-0.5">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          <span title="Dossiers parents hors de vos droits">…</span>
          <span className="sr-only">dossiers parents non accessibles</span>
        </span>
      )}
      {breadcrumb?.items.map((b) => (
        <span key={b.id} className="inline-flex items-center gap-0.5">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          {onNavigate ? (
            <button type="button" className={item} onClick={() => onNavigate(b.id)}>
              {b.name}
            </button>
          ) : (
            <span className="px-1">{b.name}</span>
          )}
        </span>
      ))}
      {current && (
        <span className="inline-flex items-center gap-0.5">
          <ChevronRight className="h-3.5 w-3.5" aria-hidden />
          <span aria-current="page" className="inline-flex items-center gap-1 px-1 font-medium text-navy">
            <Folder className="h-3.5 w-3.5" aria-hidden /> {current}
          </span>
        </span>
      )}
    </nav>
  );
}

export function Reference({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="text-ink-soft">—</span>;
  return <span className="whitespace-nowrap font-mono text-xs text-ink">{value}</span>;
}

export function userName(u: { displayName: string | null } | null | undefined, fallback = 'Utilisateur') {
  return u?.displayName ?? fallback;
}

export function Notice({ tone = 'info', children, className }: { tone?: 'info' | 'warn' | 'danger' | 'ok'; children: ReactNode; className?: string }) {
  const cls = {
    info: 'border-info-line bg-info-bg text-info',
    warn: 'border-warn-line bg-warn-bg text-warn',
    danger: 'border-danger-line bg-danger-bg text-danger',
    ok: 'border-ok-line bg-ok-bg text-ok',
  }[tone];
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'info' ? Clock : AlertTriangle;
  return (
    <div className={cn('flex items-start gap-2 rounded-md border px-3 py-2 text-sm', cls, className)} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0 text-ink">{children}</div>
    </div>
  );
}
