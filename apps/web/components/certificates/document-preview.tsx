'use client';

import { useQuery } from '@tanstack/react-query';
import { Expand, FileWarning, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ApiError, api, errorMessage, type FileLink } from '@/lib/api';
import { cn } from '@/lib/format';
import { DownloadButton, FilePreviewDialog } from '@/components/amc/file-preview';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/states';

/**
 * Aperçu intégré du document officiel courant via GET /certificates/:id/preview (lien inline
 * éphémère, consultation journalisée). Sans droit de téléchargement : aucun bouton
 * « Télécharger » et barre d'outils du lecteur PDF masquée (CERT-06) — le serveur refuse de
 * toute façon la route de téléchargement.
 */
export function InlineCertificatePreview({
  certificateId,
  title,
  canDownload,
  className,
  frameClassName = 'h-[420px]',
}: {
  certificateId: string;
  title: string;
  canDownload: boolean;
  className?: string;
  frameClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const previewPath = `/certificates/${certificateId}/preview`;
  const downloadPath = `/certificates/${certificateId}/download`;
  const link = useQuery({
    queryKey: ['certificate-preview', certificateId],
    queryFn: () => api.get<FileLink>(previewPath),
    staleTime: 45_000,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const mime = link.data?.mimeType ?? '';
  const isPdf = mime === 'application/pdf';
  const isImage = mime.startsWith('image/');
  const src = link.data ? (isPdf && !canDownload ? `${link.data.url}#toolbar=0&navpanes=0` : link.data.url) : '';

  return (
    <div className={cn('space-y-2', className)}>
      {link.isLoading && <Skeleton className={cn('w-full', frameClassName)} />}
      {link.error && (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-strong px-4 py-8 text-center text-sm text-ink-muted">
          <FileWarning className="h-5 w-5 text-warn" aria-hidden />
          <p>{link.error instanceof ApiError && link.error.status === 404 ? 'Aucun document officiel pour la révision courante.' : errorMessage(link.error)}</p>
          {!(link.error instanceof ApiError && link.error.status === 404) && (
            <Button variant="secondary" size="sm" onClick={() => link.refetch()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Réessayer
            </Button>
          )}
        </div>
      )}
      {link.data && isPdf && (
        <iframe title={`Aperçu — ${title}`} src={src} className={cn('w-full rounded-md border border-line bg-white', frameClassName)} />
      )}
      {link.data && isImage && (
        <div className={cn('flex items-center justify-center overflow-hidden rounded-md border border-line bg-navy-900/5', frameClassName)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={link.data.url} alt={`Document officiel — ${title}`} className="max-h-full max-w-full object-contain" />
        </div>
      )}
      {link.data && !isPdf && !isImage && <p className="text-sm text-ink-muted">Aperçu non disponible pour ce format.</p>}
      {link.data && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => setExpanded(true)}>
            <Expand className="h-4 w-4" aria-hidden /> Agrandir
          </Button>
          {canDownload && <DownloadButton path={downloadPath} size="sm" />}
          <span className="text-xs text-ink-soft">{link.data.fileName} — lien temporaire, consultation journalisée.</span>
        </div>
      )}
      {expanded && (
        <FilePreviewDialog
          open={expanded}
          onOpenChange={setExpanded}
          title={title}
          previewPath={previewPath}
          downloadPath={downloadPath}
          canDownload={canDownload}
          kind={isPdf ? 'PDF' : isImage ? 'IMAGE' : undefined}
        />
      )}
    </div>
  );
}
