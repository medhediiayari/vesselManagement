'use client';

import { APPROVAL_STATUS_LABELS, RENEWAL_STATUS_LABELS, ATTACHMENT_STATUS_LABELS, type ValidityStatus } from '@amc/types';
import {
  Archive,
  Ban,
  CheckCircle2,
  Clock,
  FileCheck2,
  FileClock,
  FilePen,
  Hourglass,
  RefreshCw,
  Ship,
  Undo2,
  UserRound,
  XCircle,
} from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge, type Tone } from '@/components/ui/badge';
import { CertificateBadge, MissingDocumentBadge } from '@/components/amc/certificate-badge';
import { cn, fmtDate } from '@/lib/format';
import {
  REQUEST_KIND_LABELS,
  SUBJECT_KIND_LABELS,
  type ApprovalStatus,
  type AttachmentStatus,
  type ExpiryKind,
  type RenewalStatus,
  type RequestKind,
  type Subject,
  type SubjectKind,
} from './types';

const ic = 'h-3.5 w-3.5 shrink-0';

/**
 * Validité réelle (calculée par le serveur). Sans révision approuvée : « Non validé »,
 * jamais une validité supposée.
 */
export function ValidityBadge({
  validity,
  expiryOn,
  compact,
}: {
  validity: ValidityStatus | null;
  expiryOn?: string | null;
  compact?: boolean;
}) {
  if (!validity) {
    return (
      <Badge tone="neutral" icon={<Hourglass className={ic} aria-hidden />} title="Aucune révision approuvée pour l'instant">
        Non validé
      </Badge>
    );
  }
  return <CertificateBadge status={validity} expiryOn={expiryOn ?? null} compact={compact} />;
}

/** Échéance + validité (cellule de tableau dense). */
export function ExpiryCell({
  validity,
  expiryKind,
  expiryOn,
}: {
  validity: ValidityStatus | null;
  expiryKind: ExpiryKind | null;
  expiryOn: string | null;
}) {
  return (
    <div className="flex flex-col items-start gap-1">
      <span className="tabular text-sm text-ink">
        {expiryKind === 'UNLIMITED' ? 'Sans échéance' : expiryKind === 'UNKNOWN' ? 'Date inconnue' : fmtDate(expiryOn)}
      </span>
      <ValidityBadge validity={validity} expiryOn={expiryOn} />
    </div>
  );
}

const RENEWAL_TONE: Record<RenewalStatus, Tone> = { NOT_STARTED: 'neutral', IN_PROGRESS: 'info', COMPLETED: 'ok' };

/**
 * Suivi opérationnel du renouvellement — affiché À CÔTÉ de la validité, jamais à sa place (CDC §4.3).
 * `hideIdle` : n'affiche rien pour « Non démarré » (tableaux).
 */
export function RenewalBadge({ status, hideIdle }: { status: RenewalStatus; hideIdle?: boolean }) {
  if (hideIdle && status === 'NOT_STARTED') return null;
  return (
    <Badge
      tone={RENEWAL_TONE[status]}
      icon={status === 'IN_PROGRESS' ? <RefreshCw className={ic} aria-hidden /> : status === 'COMPLETED' ? undefined : <Clock className={ic} aria-hidden />}
    >
      {status === 'NOT_STARTED' ? 'Renouvellement non démarré' : status === 'COMPLETED' ? 'Renouvellement terminé' : RENEWAL_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * Document officiel : « Document manquant » tant qu'aucune pièce n'est OFFICIELLE, même si une
 * pièce est en attente de validation (CERT-05).
 */
export function DocumentBadge({
  hasCurrentRevision,
  documentMissing,
  documentRequired,
  pendingAttachment,
}: {
  hasCurrentRevision: boolean;
  documentMissing: boolean;
  documentRequired: boolean;
  pendingAttachment?: boolean;
}) {
  if (!hasCurrentRevision) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {documentMissing ? (
        // Justificatif facultatif pour ce type : aucun signalement
        documentRequired ? <MissingDocumentBadge /> : null
      ) : (
        <Badge tone="ok" icon={<FileCheck2 className={ic} aria-hidden />}>
          Document officiel
        </Badge>
      )}
      {pendingAttachment && (
        <Badge tone="info" icon={<FileClock className={ic} aria-hidden />} title="Pièce déposée, non officielle tant qu'elle n'est pas approuvée">
          Pièce en attente
        </Badge>
      )}
    </span>
  );
}

const REQUEST_TONE: Record<ApprovalStatus, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warn',
  RETURNED: 'warn',
  REJECTED: 'danger',
  APPROVED: 'ok',
  CANCELLED: 'neutral',
};
const REQUEST_ICON: Record<ApprovalStatus, ReactNode> = {
  DRAFT: <FilePen className={ic} aria-hidden />,
  PENDING_APPROVAL: <Hourglass className={ic} aria-hidden />,
  RETURNED: <Undo2 className={ic} aria-hidden />,
  REJECTED: <XCircle className={ic} aria-hidden />,
  APPROVED: <CheckCircle2 className={ic} aria-hidden />,
  CANCELLED: <Ban className={ic} aria-hidden />,
};

export function RequestStatusBadge({ status }: { status: ApprovalStatus }) {
  return (
    <Badge tone={REQUEST_TONE[status]} icon={REQUEST_ICON[status]}>
      {APPROVAL_STATUS_LABELS[status] ?? status}
    </Badge>
  );
}

/** « Renouvellement — En attente d'approbation » : nature + statut de la demande ouverte. */
export function OpenRequestBadge({ kind, status }: { kind: RequestKind; status: ApprovalStatus }) {
  return (
    <Badge tone={REQUEST_TONE[status]} icon={REQUEST_ICON[status]} title={`Demande de ${REQUEST_KIND_LABELS[kind].toLowerCase()}`}>
      {REQUEST_KIND_LABELS[kind]} — {(APPROVAL_STATUS_LABELS[status] ?? status).toLowerCase()}
    </Badge>
  );
}

export function RequestKindBadge({ kind }: { kind: RequestKind }) {
  return (
    <Badge tone="navy" icon={false}>
      {REQUEST_KIND_LABELS[kind]}
    </Badge>
  );
}

const ATTACHMENT_TONE: Record<AttachmentStatus, Tone> = {
  PENDING_APPROVAL: 'info',
  OFFICIAL: 'ok',
  ARCHIVED: 'neutral',
  REJECTED: 'danger',
};

export function AttachmentStatusBadge({ status, current }: { status: AttachmentStatus; current?: boolean }) {
  const icon =
    status === 'OFFICIAL' ? <FileCheck2 className={ic} aria-hidden /> : status === 'PENDING_APPROVAL' ? <FileClock className={ic} aria-hidden /> : status === 'ARCHIVED' ? <Archive className={ic} aria-hidden /> : undefined;
  const label = status === 'OFFICIAL' && current ? 'Pièce officielle courante' : status === 'OFFICIAL' ? 'Pièce officielle (révision archivée)' : ATTACHMENT_STATUS_LABELS[status] ?? status;
  return (
    <Badge tone={ATTACHMENT_TONE[status]} icon={icon}>
      {label}
    </Badge>
  );
}

export function ArchivedBadge() {
  return (
    <Badge tone="neutral" icon={<Archive className={ic} aria-hidden />}>
      Archivé
    </Badge>
  );
}

/** Titulaire : lien vers la fiche navire / marin (l'accès est revérifié à l'ouverture). */
export function SubjectLink({
  subject,
  subjectKind,
  showRank,
  className,
  link = true,
}: {
  subject: Subject;
  subjectKind: SubjectKind;
  showRank?: boolean;
  className?: string;
  link?: boolean;
}) {
  const Icon = subjectKind === 'VESSEL' ? Ship : UserRound;
  const href = subject.vessel ? `/vessels/${subject.vessel.id}` : subject.member ? `/members/${subject.member.id}` : null;
  const label = subject.vessel ? subject.vessel.name : subject.member ? `${subject.member.lastName} ${subject.member.firstName}` : subject.label;
  const secondary = subject.vessel
    ? subject.vessel.code
    : subject.member
      ? [subject.member.amcRef, showRank ? subject.member.rank : null].filter(Boolean).join(' — ')
      : null;
  const body = (
    <>
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" aria-label={SUBJECT_KIND_LABELS[subjectKind]} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{label}</span>
        {secondary && <span className="block truncate text-xs text-ink-muted">{secondary}</span>}
      </span>
    </>
  );
  if (!link || !href) return <span className={cn('inline-flex min-w-0 items-start gap-1.5', className)}>{body}</span>;
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      className={cn('inline-flex min-w-0 items-start gap-1.5 text-ink hover:text-action hover:underline', className)}
    >
      {body}
    </Link>
  );
}
