'use client';

import { useQuery } from '@tanstack/react-query';
import { Download, Eye, Minus, Plus, RotateCw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api, errorMessage, type FileLink } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { fileIcon } from './file-uploader';

/**
 * Prévisualisation intégrée PDF / images (zoom, rotation) avec URL signée courte.
 * `previewPath` / `downloadPath` : routes API (génériques /files/:id/… ou métier dédiées).
 * Le bouton de téléchargement n'apparaît que si l'appelant indique le droit (canDownload) ;
 * le serveur refuse de toute façon sans permission (CERT-06).
 */
export function FilePreviewDialog({
  open,
  onOpenChange,
  title,
  previewPath,
  downloadPath,
  canDownload,
  kind,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  previewPath: string;
  downloadPath?: string;
  canDownload?: boolean;
  kind?: string;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const link = useQuery({
    queryKey: ['file-link', previewPath],
    queryFn: () => api.get<FileLink>(previewPath),
    enabled: open,
    staleTime: 30_000,
    gcTime: 0,
  });
  const isImage = kind === 'IMAGE' || link.data?.mimeType.startsWith('image/');
  const isPdf = kind === 'PDF' || link.data?.mimeType === 'application/pdf';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="xl"
      footer={
        <>
          {isImage && (
            <div className="mr-auto flex items-center gap-1">
              <Button variant="secondary" size="sm" onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))} aria-label="Zoom arrière">
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-12 text-center text-sm tabular">{Math.round(zoom * 100)}%</span>
              <Button variant="secondary" size="sm" onClick={() => setZoom((z) => Math.min(4, z + 0.25))} aria-label="Zoom avant">
                <Plus className="h-4 w-4" />
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setRotate((r) => (r + 90) % 360)} aria-label="Pivoter">
                <RotateCw className="h-4 w-4" />
              </Button>
            </div>
          )}
          {canDownload && downloadPath && (
            <DownloadButton path={downloadPath} />
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        </>
      }
    >
      {link.isLoading && <LoadingBlock rows={6} label="Préparation de l'aperçu sécurisé…" />}
      {link.error && <ErrorState error={link.error} onRetry={() => link.refetch()} />}
      {link.data && isPdf && (
        <iframe
          title={`Aperçu ${title}`}
          // Sans droit de téléchargement : barre d'outils du lecteur PDF masquée (pas de bouton télécharger / imprimer)
          src={canDownload ? link.data.url : `${link.data.url}#toolbar=0&navpanes=0`}
          className="h-[70vh] w-full rounded-md border border-line"
        />
      )}
      {link.data && isImage && (
        <div className="flex h-[70vh] items-center justify-center overflow-auto rounded-md bg-navy-900/5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={link.data.url}
            alt={title}
            style={{ transform: `scale(${zoom}) rotate(${rotate}deg)`, transformOrigin: 'center' }}
            className="max-h-full max-w-full transition-transform"
          />
        </div>
      )}
      {link.data && !isPdf && !isImage && (
        <p className="text-sm text-ink-muted">Aperçu non disponible pour ce format. Utilisez le téléchargement si vous y êtes autorisé.</p>
      )}
      <p className="mt-2 text-xs text-ink-soft">Lien d’accès temporaire, consultation journalisée.</p>
    </Dialog>
  );
}

export function DownloadButton({ path, label = 'Télécharger', size = 'md' }: { path: string; label?: string; size?: 'sm' | 'md' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      size={size}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const link = await api.get<FileLink>(path);
          const a = document.createElement('a');
          a.href = link.url;
          a.rel = 'noopener';
          a.download = link.fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download className="h-4 w-4" aria-hidden /> {label}
    </Button>
  );
}

/** Ligne fichier compacte : icône, nom, taille, actions aperçu / téléchargement. */
export function FileRow({
  fileId,
  name,
  kind,
  sizeBytes,
  canDownload = true,
  previewPath,
  downloadPath,
  extra,
}: {
  fileId: string;
  name: string;
  kind?: string;
  sizeBytes?: number;
  canDownload?: boolean;
  previewPath?: string;
  downloadPath?: string;
  extra?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const pPath = previewPath ?? `/files/${fileId}/preview`;
  const dPath = downloadPath ?? `/files/${fileId}/download`;
  const previewable = kind === 'PDF' || kind === 'IMAGE';
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2">
      {fileIcon(kind)}
      <span className="min-w-0 flex-1 truncate text-sm" title={name}>
        {name}
      </span>
      {extra}
      {sizeBytes !== undefined && <span className="hidden text-xs tabular text-ink-muted sm:inline">{fmtBytes(sizeBytes)}</span>}
      {previewable && (
        <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
          <Eye className="h-4 w-4" aria-hidden /> Aperçu
        </Button>
      )}
      {canDownload && <DownloadButton path={dPath} size="sm" label="Télécharger" />}
      {previewable && (
        <FilePreviewDialog
          open={open}
          onOpenChange={setOpen}
          title={name}
          previewPath={pPath}
          downloadPath={dPath}
          canDownload={canDownload}
          kind={kind}
        />
      )}
    </div>
  );
}
