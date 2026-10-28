'use client';

import { CheckCircle2, Gavel, Undo2, XCircle } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { conflictMessage } from './lib';
import { DECISION_LABELS, REQUEST_KIND_LABELS, type DecisionKind, type RequestDto } from './types';

const DECISION_TITLES: Record<DecisionKind, string> = {
  APPROVE: 'Approuver la demande',
  REJECT: 'Refuser la demande',
  RETURN: 'Retourner pour correction',
};

/**
 * Décision d'un validateur éligible (Approve / Reject / Return) avec la version vue
 * (`expectedVersion`) : une version périmée ou une demande déjà traitée est refusée par le
 * serveur (409) — l'écran est alors rafraîchi et un message clair est affiché (CERT-04, ADM-058).
 */
export function DecisionPanel({
  request,
  onDecided,
  onConflict,
  compact,
}: {
  request: Pick<RequestDto, 'id' | 'kind' | 'version' | 'submittedAt' | 'requestedBy'>;
  onDecided: () => void | Promise<void>;
  onConflict: (message: string) => void | Promise<void>;
  compact?: boolean;
}) {
  const [decision, setDecision] = useState<DecisionKind | null>(null);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commentId = useId();
  const needsComment = decision === 'REJECT' || decision === 'RETURN';
  const commentOk = !needsComment || comment.trim().length >= 3;

  const close = () => {
    setDecision(null);
    setComment('');
    setError(null);
  };

  async function confirm() {
    if (!decision) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/approvals/${request.id}/decision`, {
        decision,
        comment: comment.trim() || undefined,
        expectedVersion: request.version,
      });
      toast.success(`Demande ${DECISION_LABELS[decision].toLowerCase()}`, {
        description:
          decision === 'APPROVE'
            ? request.kind === 'ATTACHMENT'
              ? 'La pièce est désormais le document officiel ; l’ancienne est archivée.'
              : 'La nouvelle révision est courante ; la précédente est archivée intégralement.'
            : 'Le demandeur est notifié.',
      });
      close();
      await onDecided();
    } catch (e) {
      const conflict = conflictMessage(e);
      if (conflict) {
        close();
        toast.warning(conflict, { duration: 10_000 });
        await onConflict(conflict);
      } else if (e instanceof ApiError && e.fieldErrors.comment) {
        setError(e.fieldErrors.comment);
      } else {
        setError(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Décision du validateur" className="rounded-md border border-action/30 bg-action-50/60 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-navy">
            <Gavel className="h-4 w-4" aria-hidden /> Votre décision
          </h3>
          <p className="text-xs text-ink-muted">
            Demande de {REQUEST_KIND_LABELS[request.kind].toLowerCase()} — version {request.version}
            {request.submittedAt ? `, soumise le ${fmtDateTime(request.submittedAt)}` : ''}
            {request.requestedBy?.displayName ? ` par ${request.requestedBy.displayName}` : ''}. Une seule approbation suffit.
          </p>
        </div>
        <div className={compact ? 'flex flex-wrap gap-1.5' : 'flex flex-wrap gap-2'}>
          <Button size="sm" onClick={() => setDecision('APPROVE')}>
            <CheckCircle2 className="h-4 w-4" aria-hidden /> Approuver
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDecision('RETURN')}>
            <Undo2 className="h-4 w-4" aria-hidden /> Retourner
          </Button>
          <Button size="sm" variant="danger" onClick={() => setDecision('REJECT')}>
            <XCircle className="h-4 w-4" aria-hidden /> Refuser
          </Button>
        </div>
      </div>

      <Dialog
        open={!!decision}
        onOpenChange={(o) => !o && close()}
        title={decision ? DECISION_TITLES[decision] : ''}
        description={`Décision sur la version ${request.version} — si la demande a été modifiée entre-temps, elle sera refusée et l'écran actualisé.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={close} disabled={busy}>
              Annuler
            </Button>
            <Button variant={decision === 'REJECT' ? 'danger' : decision === 'RETURN' ? 'navy' : 'primary'} disabled={!commentOk} loading={busy} onClick={confirm}>
              {decision === 'APPROVE' ? 'Approuver' : decision === 'REJECT' ? 'Refuser' : 'Retourner au demandeur'}
            </Button>
          </>
        }
      >
        <Field
          label={needsComment ? 'Commentaire' : 'Commentaire (facultatif)'}
          required={needsComment}
          htmlFor={commentId}
          error={error ?? undefined}
          hint={needsComment ? 'Obligatoire pour un refus ou un retour — transmis au demandeur et conservé dans l’historique.' : 'Visible dans l’historique de la demande.'}
        >
          <Textarea id={commentId} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={4000} autoFocus invalid={!!error} />
        </Field>
      </Dialog>
    </section>
  );
}
