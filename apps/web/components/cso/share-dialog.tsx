'use client';

import { useQuery } from '@tanstack/react-query';
import { Ban, Download, Eye, Share2, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Checkbox, Field, Textarea } from '@/components/ui/field';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { useCsoRun } from './lib';
import { PrincipalName, PrincipalPicker, type PickedPrincipal } from './principal-picker';
import type { CsoShare } from './types';
import { Notice } from './ui';

/**
 * Partage interne (CSO-014..016) : utilisateurs / départements, notification app + e-mail,
 * lien authentifié uniquement (aucun lien public). Le téléchargement ne peut être accordé que
 * si le partageur dispose lui-même du droit de télécharger.
 */
export function ShareDialog({
  open,
  onOpenChange,
  doc,
  canDownload,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  doc: { id: string; title: string };
  canDownload: boolean;
}) {
  const run = useCsoRun();
  const msgId = useId();
  const { me } = useSession();
  const [recipients, setRecipients] = useState<PickedPrincipal[]>([]);
  const [message, setMessage] = useState('');
  const [allowDownload, setAllowDownload] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRecipients([]);
      setMessage('');
      setAllowDownload(false);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Partager en interne"
      description={doc.title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            disabled={recipients.length === 0}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(
                  () =>
                    api.post<{ notifiedUsers: number }>('/cso/shares', {
                      documentId: doc.id,
                      recipientUserIds: recipients.filter((r) => r.principalType === 'USER').map((r) => r.principalId),
                      recipientDepartmentIds: recipients.filter((r) => r.principalType === 'DEPARTMENT').map((r) => r.principalId),
                      message: message.trim() || undefined,
                      allowDownload: canDownload && allowDownload,
                    }),
                  (res) => `Document partagé — ${res.notifiedUsers} personne(s) notifiée(s)`,
                );
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Share2 className="h-4 w-4" aria-hidden /> Partager
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Notice tone="info">
          Les destinataires reçoivent une notification et un lien authentifié. Le partage ne contourne ni leur périmètre navire, ni leurs
          permissions, ni un refus explicite.
        </Notice>
        <div>
          <p className="field-label">Destinataires</p>
          {recipients.length > 0 && (
            <ul className="mb-2 flex flex-wrap gap-2">
              {recipients.map((r, i) => (
                <li key={`${r.principalType}:${r.principalId}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-canvas py-0.5 pl-2.5 pr-1 text-sm">
                  <PrincipalName type={r.principalType} id={r.principalId} label={r.label} />
                  <IconButton label="Retirer ce destinataire" className="h-6 w-6" onClick={() => setRecipients((p) => p.filter((_, j) => j !== i))}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <PrincipalPicker
            types={['USER', 'DEPARTMENT']}
            exclude={[...recipients.map((r) => `${r.principalType}:${r.principalId}`), `USER:${me.id}`]}
            onAdd={(p) => setRecipients((prev) => [...prev, p])}
          />
        </div>
        <Field label="Message" htmlFor={msgId} hint="Facultatif — inclus dans la notification.">
          <Textarea id={msgId} rows={2} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
        </Field>
        {canDownload ? (
          <Checkbox
            label="Autoriser le téléchargement"
            description="Sinon, consultation et aperçu uniquement."
            checked={allowDownload}
            onChange={(e) => setAllowDownload(e.target.checked)}
          />
        ) : (
          <p className="text-xs text-ink-muted">Partage en consultation et aperçu uniquement (vous ne disposez pas vous-même du droit de téléchargement).</p>
        )}
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/** Liste des partages d'un document + révocation ciblée ou globale (instantanée). */
export function SharesList({ documentId, canRevoke }: { documentId: string; canRevoke: boolean }) {
  const run = useCsoRun();
  const q = useQuery({ queryKey: ['cso', 'shares', documentId], queryFn: () => api.get<CsoShare[]>(`/cso/documents/${documentId}/shares`) });
  const [revoking, setRevoking] = useState<CsoShare | null>(null);
  const [revokeAll, setRevokeAll] = useState(false);
  if (q.isLoading) return <LoadingBlock rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const rows = q.data ?? [];
  const active = rows.filter((s) => !s.revokedAt);
  return (
    <div>
      {canRevoke && active.length > 1 && (
        <div className="mb-3 flex justify-end">
          <Button variant="secondary" size="sm" onClick={() => setRevokeAll(true)}>
            <Ban className="h-4 w-4" aria-hidden /> Révoquer tous les partages ({active.length})
          </Button>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState title="Aucun partage" description="Ce document n'a pas été partagé en interne." icon={<Share2 className="h-5 w-5" aria-hidden />} />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">Destinataire</th>
                <th scope="col">Partagé par</th>
                <th scope="col">Droits</th>
                <th scope="col">Statut</th>
                {canRevoke && <th scope="col" className="w-10"><span className="sr-only">Actions</span></th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <PrincipalName
                      type={s.recipientUserId ? 'USER' : 'DEPARTMENT'}
                      id={(s.recipientUserId ?? s.recipientDepartmentId)!}
                      label={s.recipientName}
                    />
                    {s.message && <p className="mt-0.5 max-w-xs truncate text-xs text-ink-muted" title={s.message}>« {s.message} »</p>}
                  </td>
                  <td>
                    <span className="block">{s.sharedByName ?? '—'}</span>
                    <span className="text-xs text-ink-muted">{fmtDateTime(s.createdAt)}</span>
                  </td>
                  <td>
                    {s.allowDownload ? (
                      <Badge tone="info" icon={<Download className="h-3.5 w-3.5" aria-hidden />}>Consultation + téléchargement</Badge>
                    ) : (
                      <Badge tone="neutral" icon={<Eye className="h-3.5 w-3.5" aria-hidden />}>Consultation</Badge>
                    )}
                  </td>
                  <td>
                    {s.revokedAt ? (
                      <span className="text-xs text-ink-muted">
                        <Badge tone="neutral" icon={<Ban className="h-3.5 w-3.5" aria-hidden />}>Révoqué</Badge>
                        <span className="mt-0.5 block">
                          {fmtDateTime(s.revokedAt)}
                          {s.revokedByName ? ` par ${s.revokedByName}` : ''}
                        </span>
                      </span>
                    ) : (
                      <Badge tone="ok">Actif</Badge>
                    )}
                  </td>
                  {canRevoke && (
                    <td>
                      {!s.revokedAt && (
                        <IconButton label="Révoquer ce partage" onClick={() => setRevoking(s)}>
                          <Ban className="h-4 w-4" />
                        </IconButton>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title="Révoquer ce partage ?"
        description={`L'accès de ${revoking?.recipientName ?? 'ce destinataire'} via ce partage est retiré immédiatement (ses droits propres sont conservés).`}
        confirmLabel="Révoquer"
        tone="danger"
        onConfirm={async () => {
          await run(() => api.delete(`/cso/shares/${revoking!.id}`), 'Partage révoqué');
        }}
      />
      <ConfirmDialog
        open={revokeAll}
        onOpenChange={setRevokeAll}
        title="Révoquer tous les partages ?"
        description="Tous les accès accordés par partage sur ce document sont retirés immédiatement. Les droits propres des utilisateurs ne sont pas modifiés."
        confirmLabel="Tout révoquer"
        tone="danger"
        onConfirm={async () => {
          await run(() => api.post<{ revoked: number }>(`/cso/documents/${documentId}/shares/revoke-all`), (r) => `${r.revoked} partage(s) révoqué(s)`);
        }}
      />
    </div>
  );
}
