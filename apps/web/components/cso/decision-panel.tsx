'use client';

import { CheckCircle2, Eye, Undo2, XCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, fmtBytes, fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { CsoActionError, isConflict, isPreviewable, useCsoRun, useDocument, versionRights } from './lib';
import { CsoPreviewDialog } from './preview';
import type { CsoVersion } from './types';
import { Notice, Reference, userName, VersionStatusBadge } from './ui';

type Decision = 'APPROVE' | 'RETURN' | 'REJECT';

const OPTIONS: { value: Decision; label: string; help: string; icon: typeof CheckCircle2; tone: string }[] = [
  { value: 'APPROVE', label: 'Approuver et publier', help: 'La version devient officielle ; la précédente est archivée (remplacée).', icon: CheckCircle2, tone: 'text-ok' },
  { value: 'RETURN', label: 'Retourner pour correction', help: 'Le déposant pourra corriger puis resoumettre.', icon: Undo2, tone: 'text-warn' },
  { value: 'REJECT', label: 'Refuser', help: 'Décision définitive pour cette version.', icon: XCircle, tone: 'text-danger' },
];

/**
 * Décision d'approbation (CSO-006/007) — jamais par le déposant ; verrou optimiste
 * (expectedLockVersion) : un conflit 409 (version modifiée ou déjà traitée) est expliqué.
 */
export function VersionDecisionDialog({
  open,
  onOpenChange,
  doc,
  version: versionIn,
  canPreview: canPreviewIn,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  doc: { id: string; title: string; reference: string | null; currentVersion?: CsoVersion | null };
  version: CsoVersion;
  canPreview: boolean;
}) {
  const run = useCsoRun();
  // Depuis la boîte de validation, la version arrive sans fichier : la fiche est chargée pour l'examiner
  const detail = useDocument(open && !versionIn.file ? doc.id : null);
  const version = detail.data?.versions.find((x) => x.id === versionIn.id) ?? versionIn;
  const canPreview = detail.data ? versionRights(detail.data, version, detail.data.actions).preview : canPreviewIn;
  const currentVersion = doc.currentVersion ?? detail.data?.currentVersion ?? null;
  const commentId = useId();
  const [decision, setDecision] = useState<Decision>('APPROVE');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);

  useEffect(() => {
    if (open) {
      setDecision('APPROVE');
      setComment('');
      setError(null);
    }
  }, [open]);

  const needComment = decision !== 'APPROVE';
  const disabled = needComment && comment.trim().length < 3;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Décision — version ${version.versionNo}`}
        description={
          <>
            {doc.title} {doc.reference && <Reference value={doc.reference} />}
          </>
        }
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button
              variant={decision === 'REJECT' ? 'danger' : 'primary'}
              disabled={disabled}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await run(
                    () =>
                      api.post(`/cso/versions/${version.id}/decision`, {
                        decision,
                        comment: comment.trim() || undefined,
                        expectedLockVersion: version.lockVersion,
                      }),
                    decision === 'APPROVE' ? `Version ${version.versionNo} approuvée et publiée` : decision === 'RETURN' ? 'Version retournée au déposant' : 'Version refusée',
                  );
                  onOpenChange(false);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (e instanceof CsoActionError && isConflict(e.cause)) {
                    toast.error(msg);
                    onOpenChange(false);
                  } else setError(msg);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Confirmer la décision
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="rounded-md border border-line bg-canvas p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">Version {version.versionNo}</span>
              <VersionStatusBadge status={version.status} />
              {version.isRestoration && <span className="text-xs text-ink-muted">(restauration d&apos;un document archivé)</span>}
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              Déposée par {userName(version.submittedBy)} le {fmtDateTime(version.submittedAt ?? version.createdAt)}
            </p>
            {version.changeNote && <p className="mt-1">« {version.changeNote} »</p>}
            {version.file && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="truncate text-xs text-ink-muted">
                  {version.file.originalName} — {fmtBytes(version.file.sizeBytes)}
                </span>
                {canPreview && isPreviewable(version.file.kind) && (
                  <Button variant="secondary" size="sm" onClick={() => setPreview(true)}>
                    <Eye className="h-4 w-4" aria-hidden /> Examiner le fichier
                  </Button>
                )}
              </div>
            )}
            {currentVersion && currentVersion.id !== version.id && (
              <p className="mt-2 text-xs text-ink-muted">Version officielle actuelle : v{currentVersion.versionNo} — elle sera archivée si vous approuvez.</p>
            )}
          </div>
          <fieldset>
            <legend className="field-label">Décision</legend>
            <div className="space-y-2">
              {OPTIONS.map((o) => (
                <label
                  key={o.value}
                  className={cn('flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm', decision === o.value ? 'border-action bg-action-50' : 'border-line')}
                >
                  <input type="radio" name="cso-decision" className="mt-0.5 h-4 w-4" checked={decision === o.value} onChange={() => setDecision(o.value)} />
                  <o.icon className={cn('mt-0.5 h-4 w-4 shrink-0', o.tone)} aria-hidden />
                  <span>
                    <span className="font-medium">{o.label}</span>
                    <span className="block text-xs text-ink-muted">{o.help}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <Field label="Commentaire" htmlFor={commentId} required={needComment} hint={needComment ? 'Obligatoire pour un retour ou un refus — transmis au déposant.' : 'Facultatif.'}>
            <Textarea id={commentId} rows={3} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
          </Field>
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      </Dialog>
      {canPreview && version.file && (
        <CsoPreviewDialog
          open={preview}
          onOpenChange={setPreview}
          title={`${doc.title} — v${version.versionNo}`}
          previewPath={`/cso/versions/${version.id}/preview`}
          canDownload={false}
          kind={version.file.kind}
        />
      )}
    </>
  );
}

/** Décision sur une demande de changement de référence (CSO-027). */
export function ReferenceDecisionDialog({
  open,
  onOpenChange,
  request,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  request: { id: string; oldReference: string | null; newReference: string; reason: string | null; documentTitle?: string };
}) {
  const run = useCsoRun();
  const commentId = useId();
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setDecision('APPROVE');
      setComment('');
      setError(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Changement de référence"
      description={request.documentTitle}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            variant={decision === 'REJECT' ? 'danger' : 'primary'}
            disabled={decision === 'REJECT' && comment.trim().length < 3}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(
                  () => api.post(`/cso/reference-changes/${request.id}/decision`, { decision, comment: comment.trim() || undefined }),
                  decision === 'APPROVE' ? 'Nouvelle référence appliquée' : 'Changement de référence refusé',
                );
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Confirmer
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          <Reference value={request.oldReference} /> → <Reference value={request.newReference} />
        </p>
        {request.reason && <p className="text-ink-muted">Motif : {request.reason}</p>}
        <fieldset className="flex gap-4">
          <legend className="sr-only">Décision</legend>
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" name="ref-decision" checked={decision === 'APPROVE'} onChange={() => setDecision('APPROVE')} /> Approuver
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input type="radio" name="ref-decision" checked={decision === 'REJECT'} onChange={() => setDecision('REJECT')} /> Refuser
          </label>
        </fieldset>
        <Field label="Commentaire" htmlFor={commentId} required={decision === 'REJECT'}>
          <Textarea id={commentId} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}
