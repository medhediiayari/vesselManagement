'use client';

import { FileText, Info, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { ApiError, api, errorMessage, type StoredFileDto } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { announceWorkflow, selfApproves } from './lib';
import type { CertificateDetail, WorkflowResult } from './types';

/**
 * Pièce ajoutée ou remplacée après validation = demande ATTACHMENT autonome, à valider par une
 * autre personne. Tant qu'elle n'est pas approuvée, elle n'est jamais officielle : l'ancien
 * document (ou le badge « Document manquant ») reste affiché (CERT-05).
 */
export function AttachmentDialog({
  certificate,
  open,
  onOpenChange,
  onDone,
}: {
  certificate: CertificateDetail;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: () => void | Promise<void>;
}) {
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noteId = useId();
  const { can } = useSession();
  const replacing = !!certificate.currentRevision?.officialAttachment;
  // Publication directe (self_approve) : la pièce devient officielle sans validation
  const publishes = selfApproves(can, 'ATTACHMENT');

  useEffect(() => {
    if (open) {
      setFile(null);
      setNote('');
      setError(null);
    }
  }, [open]);

  async function save() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<WorkflowResult>(`/certificates/${certificate.id}/attachments`, { fileId: file.id, note: note.trim() || undefined });
      announceWorkflow(res, res.autoApproved ? 'Document officiel publié' : 'Pièce déposée — en attente de validation');
      await onDone();
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={replacing ? 'Remplacer le document officiel' : 'Ajouter le document officiel'}
      description={`${certificate.type.name} — ${certificate.subject.label}`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Annuler
          </Button>
          <Button onClick={save} disabled={!file} loading={busy}>
            {publishes ? 'Publier le document' : 'Soumettre la pièce à validation'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="flex items-start gap-1.5 rounded-md bg-info-bg px-3 py-2 text-sm text-info">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          {publishes ? (
            <span>
              Publication directe : la pièce devient le document officiel dès l’enregistrement
              {replacing ? ' et le document actuel est archivé.' : '.'}
            </span>
          ) : (
            <span>
              La pièce reste en attente et n’est jamais officielle avant son approbation par une autre personne.{' '}
              {replacing
                ? 'Le document officiel actuel reste actif jusque-là.'
                : certificate.documentRequired
                  ? 'Le badge « Document manquant » reste affiché jusque-là.'
                  : ''}
            </span>
          )}
        </p>
        {error && (
          <p role="alert" className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}
        {file ? (
          <div className="flex items-center gap-2 rounded-md border border-ok-line bg-ok-bg px-3 py-2 text-sm">
            <FileText className="h-4 w-4 text-ok" aria-hidden />
            <span className="min-w-0 flex-1 truncate">
              {file.originalName} <span className="text-xs text-ink-muted">({fmtBytes(file.sizeBytes)})</span>
            </span>
            <button type="button" className="rounded p-0.5 text-ink-muted hover:bg-white" aria-label="Retirer la pièce déposée" onClick={() => setFile(null)}>
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ) : (
          <FileUploader context="CERTIFICATE" vesselId={certificate.vesselId} label="Déposer le certificat (PDF ou image)" onUploaded={setFile} />
        )}
        <Field label={publishes ? 'Note pour l’historique' : 'Note pour le validateur'} htmlFor={noteId} hint="Facultatif.">
          <Textarea id={noteId} rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}
