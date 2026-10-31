'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive, Download, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { csoErrorMessage, openSignedLink } from './lib';
import { JOB_STATUS_LABELS, type ZipJob } from './types';
import { Notice } from './ui';

export interface ZipRequest {
  documentIds: string[];
  folderIds: string[];
  includeArchived: boolean;
}

const TERMINAL = ['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'];

/**
 * Téléchargement ZIP asynchrone (CSO-023) : les droits sont filtrés PAR FICHIER à la génération ;
 * les éléments exclus sont seulement comptés, jamais détaillés (aucune divulgation).
 */
export function ZipDialog({ open, onOpenChange, request }: { open: boolean; onOpenChange: (o: boolean) => void; request: ZipRequest | null }) {
  const [jobId, setJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const started = useRef<ZipRequest | null>(null);

  useEffect(() => {
    if (!open || !request || started.current === request) return;
    started.current = request;
    setJobId(null);
    setError(null);
    api
      .post<ZipJob>('/cso/zip', request)
      .then((j) => setJobId(j.id))
      .catch((e) => setError(csoErrorMessage(e)));
  }, [open, request]);

  const job = useQuery({
    queryKey: ['cso', 'zip', jobId],
    queryFn: () => api.get<ZipJob>(`/cso/zip/${jobId}`),
    enabled: !!jobId && open,
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 1500),
    gcTime: 0,
  });
  const j = job.data;
  const ready = !!j && (j.status === 'COMPLETED' || j.status === 'PARTIALLY_FAILED');
  const excluded = j?.excludedCount ?? 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Archive ZIP"
      description={request ? `${request.documentIds.length} document(s) et ${request.folderIds.length} dossier(s) sélectionné(s)` : undefined}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
          {ready && (
            <Button
              loading={downloading}
              onClick={async () => {
                setDownloading(true);
                try {
                  // Lien signé éphémère : redemandé au clic pour éviter un lien expiré
                  const fresh = await api.get<ZipJob>(`/cso/zip/${jobId}`);
                  if (fresh.link) openSignedLink(fresh.link.url, fresh.link.fileName);
                  else setError('Lien de téléchargement indisponible.');
                } catch (e) {
                  setError(csoErrorMessage(e));
                } finally {
                  setDownloading(false);
                }
              }}
            >
              <Download className="h-4 w-4" aria-hidden /> Télécharger l&apos;archive
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3" aria-live="polite">
        {error && <Notice tone="danger">{error}</Notice>}
        {!error && (!j || !TERMINAL.includes(j.status)) && (
          <p className="flex items-center gap-2 text-sm">
            <Loader2 className="h-4 w-4 animate-spin text-action" aria-hidden />
            {j ? `${JOB_STATUS_LABELS[j.status] ?? j.status} — préparation de l'archive…` : 'Demande en cours…'}
          </p>
        )}
        {ready && (
          <>
            <p className="flex items-center gap-2 text-sm">
              <Archive className="h-4 w-4 text-ok" aria-hidden />
              Archive prête : {j.itemCount ?? 0} fichier(s).
            </p>
            {excluded > 0 && <Notice tone="warn">{excluded} fichier(s) non inclus : droit de téléchargement manquant ou fichier indisponible.</Notice>}
            {j.status === 'PARTIALLY_FAILED' && <Notice tone="warn">Certains fichiers n&apos;ont pas pu être ajoutés.</Notice>}
          </>
        )}
        {j?.status === 'FAILED' && <Notice tone="danger">La génération a échoué{j.error ? ` : ${j.error}` : ''}.</Notice>}
        <p className="text-xs text-ink-soft">Lien de téléchargement temporaire, réservé à votre compte ; la demande est journalisée.</p>
      </div>
    </Dialog>
  );
}
