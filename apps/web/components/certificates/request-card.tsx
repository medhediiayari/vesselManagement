'use client';

import { AlertTriangle, Ban, CheckCircle2, ChevronDown, Copy, FilePen, FilePlus2, Pencil, Send, Siren, Undo2, XCircle } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { AttachmentFileRow } from './attachment-file';
import { DecisionPanel } from './decision-panel';
import { announceWorkflow, conflictMessage, fmtDataValue, selfApproves } from './lib';
import { AttachmentStatusBadge, RequestKindBadge, RequestStatusBadge } from './status';
import {
  DATA_FIELD_LABELS,
  DATA_KEYS,
  DECISION_LABELS,
  OPEN_STATUSES,
  REQUEST_KIND_LABELS,
  type AttachmentDto,
  type CertificateData,
  type CertificateDetail,
  type RequestDto,
  type RequestVersionDto,
  type WorkflowResult,
} from './types';

/** Tableau « proposé / actuel » : les champs modifiés sont signalés par un libellé, pas seulement une couleur. */
export function VersionDataTable({ data, current }: { data: Partial<CertificateData>; current?: Partial<CertificateData> | null }) {
  const keys = DATA_KEYS.filter((k) => k !== 'expiryOn' || data.expiryKind === 'DATED' || current?.expiryKind === 'DATED');
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col" className="w-44">
              Champ
            </th>
            <th scope="col">Proposé</th>
            {current && <th scope="col">Révision courante</th>}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const proposed = fmtDataValue(k, data);
            const actual = current ? fmtDataValue(k, current) : null;
            const changed = !!current && proposed !== actual;
            return (
              <tr key={k}>
                <th scope="row" className="whitespace-nowrap border-b border-line px-3 py-1.5 text-left text-xs font-medium text-ink-muted">
                  {DATA_FIELD_LABELS[k]}
                </th>
                <td className={cn('tabular', changed && 'bg-warn-bg/60 font-medium')}>
                  <span className="whitespace-pre-line break-words">{proposed}</span>
                  {changed && <span className="ml-1.5 text-xs font-medium text-warn">(modifié)</span>}
                </td>
                {current && <td className="tabular text-ink-muted">{actual}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Pièce proposée par une version : visible du demandeur, du déposant et des validateurs uniquement (CERT-05). */
export function ProposedFile({ certificateId, attachment }: { certificateId: string; attachment: AttachmentDto | undefined }) {
  if (!attachment?.file) {
    return (
      <p className="rounded-md border border-dashed border-line-strong px-3 py-2 text-sm text-ink-muted">
        Pièce jointe proposée — accès réservé au demandeur et aux validateurs éligibles.
      </p>
    );
  }
  return (
    <AttachmentFileRow
      certificateId={certificateId}
      attachment={attachment}
      extra={<AttachmentStatusBadge status={attachment.status} current={attachment.isCurrentOfficial} />}
    />
  );
}

interface TimelineEvent {
  at: string;
  label: string;
  by?: string | null;
  detail?: string | null;
  icon: ReactNode;
  tone: 'ok' | 'warn' | 'danger' | 'neutral' | 'info';
}

const DOT: Record<TimelineEvent['tone'], string> = {
  ok: 'bg-ok text-white',
  warn: 'bg-warn text-white',
  danger: 'bg-danger text-white',
  neutral: 'bg-neutral text-white',
  info: 'bg-action text-white',
};

/** Auteur réel d'une annulation : demandeur, supervision ou workflow (jamais supposé). */
function cancellationEvent(request: RequestDto): { label: string; by?: string | null } {
  const c = request.cancellation;
  if (c?.mode === 'AUTOMATIC') return { label: 'Annulée automatiquement' };
  if (c?.mode === 'SUPERVISOR') return { label: 'Annulée en supervision', by: c.by?.displayName };
  if (c?.mode === 'REQUESTER') return { label: 'Annulée par le demandeur', by: c.by?.displayName ?? request.requestedBy?.displayName };
  return { label: 'Demande annulée' };
}

/** Chronologie d'une demande : versions immuables, soumission, décisions, annulation, escalade. */
export function RequestTimeline({ request }: { request: RequestDto }) {
  const ic = 'h-3 w-3';
  const versionsAsc = [...request.versions].sort((a, b) => a.versionNo - b.versionNo);
  const events: TimelineEvent[] = [
    {
      at: request.createdAt,
      label: request.duplicatedFromId ? 'Demande créée par duplication (version 1)' : 'Demande créée (version 1)',
      by: request.requestedBy?.displayName,
      detail: versionsAsc[0]?.changeNote,
      icon: <FilePlus2 className={ic} aria-hidden />,
      tone: 'neutral' as const,
    },
    ...versionsAsc
      .filter((v) => v.versionNo > 1)
      .map<TimelineEvent>((v) => ({
        at: v.createdAt,
        label: `Version ${v.versionNo} enregistrée`,
        by: v.createdBy?.displayName,
        detail: v.changeNote,
        icon: <FilePen className={ic} aria-hidden />,
        tone: 'info',
      })),
    ...(request.submittedAt
      ? [{ at: request.submittedAt, label: 'Soumise à approbation', by: request.requestedBy?.displayName, icon: <Send className={ic} aria-hidden />, tone: 'warn' as const }]
      : []),
    ...request.decisions.map<TimelineEvent>((d) => ({
      at: d.createdAt,
      label: `${DECISION_LABELS[d.decision]} — version ${d.versionNo}`,
      by: d.decider?.displayName,
      detail: d.comment,
      icon: d.decision === 'APPROVE' ? <CheckCircle2 className={ic} aria-hidden /> : d.decision === 'REJECT' ? <XCircle className={ic} aria-hidden /> : <Undo2 className={ic} aria-hidden />,
      tone: d.decision === 'APPROVE' ? 'ok' : d.decision === 'REJECT' ? 'danger' : 'warn',
    })),
    ...(request.status === 'CANCELLED'
      ? [{ at: request.updatedAt, ...cancellationEvent(request), detail: request.cancelReason, icon: <Ban className={ic} aria-hidden />, tone: 'neutral' as const }]
      : []),
    ...(request.escalatedAt
      ? [{ at: request.escalatedAt, label: 'Escalade : approbation en retard', icon: <Siren className={ic} aria-hidden />, tone: 'danger' as const }]
      : []),
  ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  return (
    <ol className="relative ml-2.5 border-l border-line">
      {events.map((e, i) => (
        <li key={`${e.at}-${i}`} className="mb-3 ml-5 last:mb-0">
          <span className={cn('absolute -left-[9px] flex h-[18px] w-[18px] items-center justify-center rounded-full ring-2 ring-white', DOT[e.tone])}>{e.icon}</span>
          <p className="text-sm font-medium text-ink">{e.label}</p>
          <p className="text-xs text-ink-muted">
            {fmtDateTime(e.at)}
            {e.by ? ` — ${e.by}` : ''}
          </p>
          {e.detail && <p className="mt-1 whitespace-pre-line rounded-md bg-canvas px-2 py-1 text-sm text-ink">« {e.detail} »</p>}
        </li>
      ))}
    </ol>
  );
}

function VersionHistory({ versions, current }: { versions: RequestVersionDto[]; current?: Partial<CertificateData> | null }) {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <ul className="space-y-1.5">
      {versions.map((v) => {
        const expanded = open === v.versionNo;
        return (
          <li key={v.id} className="rounded-md border border-line">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : v.versionNo)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-canvas"
            >
              <ChevronDown className={cn('h-4 w-4 text-ink-muted transition-transform', expanded && 'rotate-180')} aria-hidden />
              <span className="font-medium">Version {v.versionNo}</span>
              <span className="text-xs text-ink-muted">
                {fmtDateTime(v.createdAt)} — {v.createdBy?.displayName ?? '—'}
              </span>
              {v.fileId && (
                <Badge tone="info" icon={false} className="ml-auto">
                  Pièce jointe
                </Badge>
              )}
            </button>
            {expanded && (
              <div className="space-y-2 border-t border-line p-2">
                {v.changeNote && <p className="text-sm text-ink-muted">Note : « {v.changeNote} »</p>}
                <VersionDataTable data={v} current={current} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Carte d'une demande (création / renouvellement / correction / pièce jointe) avec ses versions
 * immuables, sa chronologie et les actions permises selon le rôle : le demandeur modifie,
 * soumet, annule (motif) ou duplique ; un validateur éligible décide.
 */
export function RequestCard({
  certificate,
  request,
  highlighted,
  onChanged,
  onConflict,
  onEdit,
}: {
  certificate: CertificateDetail;
  request: RequestDto;
  highlighted?: boolean;
  onChanged: () => void | Promise<void>;
  onConflict: (message: string) => void | Promise<void>;
  onEdit?: (request: RequestDto) => void;
}) {
  const { me, can, canAny } = useSession();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [dupOpen, setDupOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showHistory, setShowHistory] = useState(highlighted ?? false);

  const latest = request.versions[0];
  const active = !certificate.archivedAt;
  const open = OPEN_STATUSES.includes(request.status);
  const mine = request.requestedBy?.id === me.id;
  const canEdit = active && mine && open && request.kind !== 'ATTACHMENT' && can('certificates.edit');
  // Publication directe : elle vaut soumission (même règle que l'API)
  const publishes = selfApproves(can, request.kind);
  const canSubmit = active && mine && (request.status === 'DRAFT' || request.status === 'RETURNED') && (can('certificates.submit') || publishes);
  const canCancel = mine && open && canAny('certificates.create', 'certificates.edit', 'certificates.submit');
  // Une seule demande de données ouverte par certificat : pas de duplicata tant qu'une autre est en cours
  const canDuplicate =
    active &&
    !certificate.openRequestId &&
    (request.status === 'CANCELLED' || request.status === 'REJECTED') &&
    request.kind !== 'ATTACHMENT' &&
    can('certificates.create');
  // Demandes closes : détail replié par défaut (la fiche reste lisible)
  const showBody = open || showHistory;
  const current = request.kind === 'CREATE' ? null : certificate.currentRevision;
  const attachment =
    request.kind === 'ATTACHMENT'
      ? certificate.attachments.find((a) => a.id === request.attachmentId)
      : latest?.fileId
        ? certificate.attachments.find((a) => a.file?.id === latest.fileId)
        : undefined;

  async function handleConflict(e: unknown): Promise<boolean> {
    const msg = conflictMessage(e);
    if (!msg) return false;
    await onConflict(msg);
    return true;
  }

  async function submit() {
    setSubmitting(true);
    try {
      const res = await api.post<WorkflowResult>(`/certificate-requests/${request.id}/submit`, { expectedVersion: request.version });
      announceWorkflow(res, res.autoApproved ? 'Demande publiée' : 'Demande soumise à approbation');
      await onChanged();
    } catch (e) {
      if (!(await handleConflict(e))) toast.error(errorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <article
      id={`request-${request.id}`}
      aria-label={`Demande de ${REQUEST_KIND_LABELS[request.kind].toLowerCase()}`}
      className={cn('rounded-lg border bg-white p-4 shadow-panel', highlighted ? 'border-action ring-2 ring-action-100' : 'border-transparent')}
    >
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <RequestKindBadge kind={request.kind} />
            <RequestStatusBadge status={request.status} />
            <Badge tone="navy" icon={false} title="Version courante de la demande">
              v{request.version}
            </Badge>
            {request.escalatedAt && (
              <Badge tone="danger" icon={<Siren className="h-3.5 w-3.5" aria-hidden />}>
                Escaladée
              </Badge>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            Demandée par {request.requestedBy?.displayName ?? '—'} le {fmtDateTime(request.createdAt)}
            {request.submittedAt && ` — soumise le ${fmtDateTime(request.submittedAt)}`}
            {request.decidedAt && ` — décidée le ${fmtDateTime(request.decidedAt)} par ${request.decidedBy?.displayName ?? '—'}`}
          </p>
          {request.duplicatedFromId && (
            <p className="text-xs text-ink-muted">
              Duplicata de la{' '}
              <a href={`#request-${request.duplicatedFromId}`} className="text-action hover:underline">
                demande d’origine
              </a>
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {canEdit && onEdit && (
            <Button size="sm" variant="secondary" onClick={() => onEdit(request)}>
              <Pencil className="h-4 w-4" aria-hidden /> Modifier
            </Button>
          )}
          {canSubmit && (
            <Button size="sm" onClick={submit} loading={submitting}>
              <Send className="h-4 w-4" aria-hidden /> {publishes ? 'Publier' : 'Soumettre'}
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>
              <Ban className="h-4 w-4" aria-hidden /> Annuler la demande
            </Button>
          )}
          {canDuplicate && (
            <Button size="sm" variant="secondary" onClick={() => setDupOpen(true)}>
              <Copy className="h-4 w-4" aria-hidden /> Dupliquer
            </Button>
          )}
        </div>
      </header>

      {(request.status === 'RETURNED' || request.status === 'REJECTED') && request.decisionComment && (
        <div
          role="note"
          className={cn(
            'mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-sm',
            request.status === 'REJECTED' ? 'border-danger-line bg-danger-bg text-danger' : 'border-warn-line bg-warn-bg text-warn',
          )}
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="font-medium">{request.status === 'REJECTED' ? 'Motif du refus' : 'À corriger'} :</span> {request.decisionComment}
            {request.status === 'RETURNED' && mine && ' — modifiez la demande puis soumettez-la à nouveau.'}
          </span>
        </div>
      )}
      {request.status === 'CANCELLED' && request.cancelReason && (
        <p className="mt-3 rounded-md bg-canvas px-3 py-2 text-sm text-ink-muted">Motif d’annulation : « {request.cancelReason} »</p>
      )}

      <div className="mt-3 space-y-3">
        {!showBody ? null : request.kind === 'ATTACHMENT' ? (
          attachment ? (
            <div className="space-y-1">
              {latest?.changeNote && <p className="text-sm text-ink-muted">Note du déposant : « {latest.changeNote} »</p>}
              <p className="text-xs text-ink-muted">
                Pièce déposée le {fmtDateTime(attachment.uploadedAt)} par {attachment.uploadedBy?.displayName ?? '—'}
                {attachment.revisionNo ? ` pour la révision n° ${attachment.revisionNo}` : ''}. Elle ne remplace le document officiel qu’après approbation par une autre personne.
              </p>
              <ProposedFile certificateId={certificate.id} attachment={attachment} />
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Pièce jointe non accessible.</p>
          )
        ) : (
          latest && (
            <>
              {latest.changeNote && <p className="text-sm text-ink-muted">Note du demandeur : « {latest.changeNote} »</p>}
              <VersionDataTable data={latest} current={current} />
              {latest.fileId ? (
                <ProposedFile certificateId={certificate.id} attachment={attachment} />
              ) : (
                <p className="text-xs text-ink-muted">Aucun document joint à cette version.</p>
              )}
            </>
          )
        )}

        {request.canDecide && active && (
          <DecisionPanel request={request} onDecided={onChanged} onConflict={onConflict} />
        )}

        <div>
          <button
            type="button"
            aria-expanded={showHistory}
            onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-1 text-sm font-medium text-action hover:underline"
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform', showHistory && 'rotate-180')} aria-hidden />
            {open ? 'Chronologie et versions' : 'Détail, chronologie et versions'} ({request.versions.length} version{request.versions.length > 1 ? 's' : ''},{' '}
            {request.decisions.length} décision{request.decisions.length > 1 ? 's' : ''})
          </button>
          {showHistory && (
            <div className="mt-3 grid gap-4 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs font-semibold text-ink-muted">Chronologie</h4>
                <RequestTimeline request={request} />
              </div>
              {request.kind !== 'ATTACHMENT' && (
                <div>
                  <h4 className="mb-2 text-xs font-semibold text-ink-muted">Versions immuables</h4>
                  <VersionHistory versions={request.versions} current={current} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Annuler la demande"
        description="Les validateurs sont notifiés. Une demande annulée peut ensuite être dupliquée."
        confirmLabel="Annuler la demande"
        tone="danger"
        requireReason
        reasonLabel="Motif d’annulation"
        onConfirm={async (reason) => {
          try {
            await api.post(`/certificate-requests/${request.id}/cancel`, { reason, expectedVersion: request.version });
            toast.success('Demande annulée');
            await onChanged();
          } catch (e) {
            if (!(await handleConflict(e))) throw e;
          }
        }}
      />
      <ConfirmDialog
        open={dupOpen}
        onOpenChange={setDupOpen}
        title="Dupliquer la demande"
        description="Une nouvelle demande indépendante est créée en brouillon à partir de la dernière version, avec un lien vers la demande d’origine."
        confirmLabel="Dupliquer"
        onConfirm={async () => {
          const res = await api.post<WorkflowResult>(`/certificate-requests/${request.id}/duplicate`, {});
          announceWorkflow(res, 'Demande dupliquée en brouillon');
          await onChanged();
        }}
      />
    </article>
  );
}
