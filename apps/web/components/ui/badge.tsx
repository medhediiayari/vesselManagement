import { AlertTriangle, CheckCircle2, Circle, Clock, Infinity as InfinityIcon, HelpCircle, XCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/format';

export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'navy' | 'teal';

const TONES: Record<Tone, string> = {
  ok: 'bg-ok-bg text-ok border-ok-line',
  warn: 'bg-warn-bg text-warn border-warn-line',
  danger: 'bg-danger-bg text-danger border-danger-line',
  info: 'bg-info-bg text-info border-info-line',
  neutral: 'bg-neutral-bg text-neutral border-neutral-line',
  navy: 'bg-navy-50 text-navy border-navy-100',
  teal: 'bg-teal-50 text-teal-700 border-teal-100',
};

const ICONS: Partial<Record<Tone, typeof Circle>> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  danger: XCircle,
  info: Clock,
};

/** Badge de statut : toujours un libellé texte + icône (jamais la couleur seule, WCAG 1.4.1). */
export function Badge({
  tone = 'neutral',
  children,
  icon,
  className,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  icon?: ReactNode | false;
  className?: string;
  title?: string;
}) {
  const Icon = ICONS[tone];
  return (
    <span
      title={title}
      className={cn(
        // Étiquette rectangulaire (registre / document de bord) plutôt que pastille SaaS
        'inline-flex max-w-full items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-xs font-medium',
        TONES[tone],
        className,
      )}
    >
      {icon === false ? null : icon ?? (Icon ? <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null)}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** Statuts génériques -> ton + libellé FR. */
export function StatusBadge({ status, labels, tones }: { status: string; labels: Record<string, string>; tones?: Record<string, Tone> }) {
  const tone = tones?.[status] ?? defaultTone(status);
  return <Badge tone={tone}>{labels[status] ?? status}</Badge>;
}

export function defaultTone(status: string): Tone {
  if (/APPROVED|PUBLISHED|VALID$|ACTIVE|COMPLETED|RECEIVED$|CLOSED|SENT|DONE|OFFICIAL|ACKNOWLEDGED|MATCHED|CLEAN|ONBOARD|ON_BOARD/.test(status)) return 'ok';
  if (/PENDING|SUBMITTED|UNDER_REVIEW|IN_PROGRESS|PARTIAL|QUOTED|ISSUED|PLANNED|EXPIRING|REVISED|SOURCING|DRAFTED|VALIDATED/.test(status)) return 'warn';
  if (/REJECTED|EXPIRED|CANCELLED|INFECTED|FAILED|DISPUTED|RETURNED|CORRECTION|DEACTIVATED|LOCKED|ERROR/.test(status)) return 'danger';
  if (/DRAFT|UNKNOWN|ARCHIVED|SUPERSEDED|INACTIVE|SKIPPED/.test(status)) return 'neutral';
  return 'info';
}

export function ValidityIcon({ status }: { status: string }) {
  switch (status) {
    case 'UNLIMITED':
      return <InfinityIcon className="h-3.5 w-3.5" aria-hidden />;
    case 'EXPIRY_UNKNOWN':
      return <HelpCircle className="h-3.5 w-3.5" aria-hidden />;
    default:
      return null;
  }
}
