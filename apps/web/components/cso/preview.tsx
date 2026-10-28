'use client';

import { useQuery } from '@tanstack/react-query';
import { Minus, Plus, RotateCw } from 'lucide-react';
import { useState } from 'react';
import { api, type FileLink } from '@/lib/api';
import { cn } from '@/lib/format';
import { DownloadButton } from '@/components/amc/file-preview';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { ErrorState, Skeleton } from '@/components/ui/states';

/**
 * Aperçu intégré PDF / image via lien signé court (droits revalidés et audités par l'API).
 * Sans droit de téléchargement, la barre d'outils du lecteur PDF du navigateur (télécharger /
 * imprimer) est masquée : l'interface ne propose jamais un téléchargement non autorisé.
 */
export function InlinePreview({
  previewPath,
  title,
  kind,
  canDownload,
  className,
  zoom = 1,
  rotate = 0,
}: {
  previewPath: string;
  title: string;
  kind?: string | null;
  canDownload: boolean;
  className?: string;
  zoom?: number;
  rotate?: number;
}) {
  const link = useQuery({
    queryKey: ['cso', 'preview-link', previewPath],
    queryFn: () => api.get<FileLink>(previewPath),
    staleTime: 45_000,
    gcTime: 0,
    retry: false,
  });
  if (link.isLoading) return <Skeleton className={cn('h-72 w-full', className)} />;
  if (link.error) return <ErrorState error={link.error} onRetry={() => link.refetch()} />;
  if (!link.data) return null;
  const isImage = kind === 'IMAGE' || link.data.mimeType.startsWith('image/');
  if (isImage) {
    return (
      <div className={cn('flex h-72 items-center justify-center overflow-auto rounded-md border border-line bg-navy-900/5', className)}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={link.data.url}
          alt={`Aperçu de ${title}`}
          style={{ transform: `scale(${zoom}) rotate(${rotate}deg)` }}
          className="max-h-full max-w-full object-contain transition-transform"
          onContextMenu={canDownload ? undefined : (e) => e.preventDefault()}
        />
      </div>
    );
  }
  const src = canDownload ? link.data.url : `${link.data.url}#toolbar=0&navpanes=0`;
  return <iframe title={`Aperçu de ${title}`} src={src} className={cn('h-72 w-full rounded-md border border-line bg-white', className)} />;
}

/** Aperçu plein écran (zoom / rotation des images, navigation PDF du lecteur intégré). */
export function CsoPreviewDialog({
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
  canDownload: boolean;
  kind?: string | null;
}) {
  const [zoom, setZoom] = useState(1);
  const [rotate, setRotate] = useState(0);
  const isImage = kind === 'IMAGE';
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
          {canDownload && downloadPath && <DownloadButton path={downloadPath} />}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        </>
      }
    >
      {open && <InlinePreview previewPath={previewPath} title={title} kind={kind} canDownload={canDownload} className="h-[70vh]" zoom={zoom} rotate={rotate} />}
      <p className="mt-2 text-xs text-ink-soft">Lien d&apos;accès temporaire, consultation journalisée.</p>
    </Dialog>
  );
}
