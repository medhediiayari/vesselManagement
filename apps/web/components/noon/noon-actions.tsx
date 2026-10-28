'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Archive, CheckCheck, MessageSquareWarning, Send } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { FormError, TextAreaField } from '@/components/voyages/common';
import { notifyError } from '@/components/voyages/lib';
import { noonKeys } from './lib';
import type { NoonReportDetail } from './types';

/** Actions Ops à terre : accusé de réception (+ accusé de lecture optionnel), demande de correction, archivage. */
export function OpsActions({ report }: { report: NoonReportDetail }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [ackOpen, setAckOpen] = useState(false);
  const [readReceipt, setReadReceipt] = useState(true);
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [corrOpen, setCorrOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const refresh = async () => {
    await Promise.all([qc.invalidateQueries({ queryKey: noonKeys.detail(report.id) }), qc.invalidateQueries({ queryKey: noonKeys.list }), qc.invalidateQueries({ queryKey: ['voyage', report.voyageId] })]);
  };
  const canArchive = can('noon.approve') && report.allowedTransitions.includes('ARCHIVED');

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/noon-reports/${report.id}/acknowledge`, { expectedVersion: report.lockVersion, readReceipt, comment: comment.trim() || undefined });
      toast.success(readReceipt ? 'Accusé de réception enregistré — l’auteur est notifié de la lecture' : 'Accusé de réception enregistré');
      setAckOpen(false);
      await refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  if (!report.permissions.acknowledge && !report.permissions.requestCorrection && !canArchive) return null;
  return (
    <>
      {report.permissions.acknowledge && (
        <Button
          onClick={() => {
            setComment('');
            setError(null);
            setAckOpen(true);
          }}
        >
          <CheckCheck className="h-4 w-4" aria-hidden /> Accuser réception
        </Button>
      )}
      {report.permissions.requestCorrection && (
        <Button variant="secondary" onClick={() => setCorrOpen(true)}>
          <MessageSquareWarning className="h-4 w-4" aria-hidden /> Demander une correction
        </Button>
      )}
      {canArchive && (
        <Button variant="ghost" onClick={() => setArchiveOpen(true)}>
          <Archive className="h-4 w-4" aria-hidden /> Archiver
        </Button>
      )}
      <Dialog
        open={ackOpen}
        onOpenChange={setAckOpen}
        title="Accuser réception du Noon Report"
        description={`Révision ${report.currentRevisionNo}. Aucune seconde signature formelle n’est requise.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setAckOpen(false)}>
              Annuler
            </Button>
            <Button onClick={acknowledge} loading={busy}>
              <Send className="h-4 w-4" aria-hidden /> Accuser réception
            </Button>
          </>
        }
      >
        <FormError
          error={error}
          onReload={() => {
            setAckOpen(false);
            void refresh();
          }}
        />
        {error instanceof ApiError && error.code === 'SELF_APPROVAL_FORBIDDEN' && (
          <p className="mb-2 text-sm text-ink-muted">Vous avez soumis ce rapport : l’accusé de réception doit venir d’un autre utilisateur.</p>
        )}
        <div className="space-y-3">
          <Checkbox
            label="Envoyer un accusé de lecture à l’auteur"
            description="Notification au Master indiquant que le rapport a été lu à terre."
            checked={readReceipt}
            onChange={(e) => setReadReceipt(e.target.checked)}
          />
          <TextAreaField label="Commentaire" value={comment} onChange={setComment} rows={3} maxLength={2000} hint="Facultatif — joint à l’accusé de lecture." />
        </div>
      </Dialog>
      <ConfirmDialog
        open={corrOpen}
        onOpenChange={setCorrOpen}
        title="Demander une correction au bord"
        description="Le Master est notifié (application + e-mail). La révision soumise reste intacte ; la correction créera une nouvelle révision."
        confirmLabel="Demander la correction"
        requireReason
        reasonLabel="Commentaire pour le bord (champs à revoir)"
        onConfirm={async (c) => {
          try {
            await api.post(`/noon-reports/${report.id}/request-correction`, { comment: c, expectedVersion: report.lockVersion });
            toast.success('Correction demandée');
          } catch (e) {
            notifyError(e, () => void refresh());
          }
          await refresh();
        }}
      />
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archiver le Noon Report"
        description="Le rapport et ses révisions restent consultables ; plus aucune correction ne sera possible."
        confirmLabel="Archiver"
        onConfirm={async () => {
          try {
            await api.post(`/noon-reports/${report.id}/archive`, { expectedVersion: report.lockVersion });
            toast.success('Noon Report archivé');
          } catch (e) {
            notifyError(e, () => void refresh());
          }
          await refresh();
        }}
      />
    </>
  );
}
