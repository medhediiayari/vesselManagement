'use client';

import { Eye } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { fmtBytes } from '@/lib/format';
import { DownloadButton, FilePreviewDialog } from '@/components/amc/file-preview';
import { fileIcon } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import type { AttachmentDto } from './types';

/**
 * Ligne fichier d'une pièce de certificat (routes dédiées /certificates/:id/attachments/:aid/*).
 * Mise en page qui passe à la ligne dans les panneaux étroits. Les boutons ne sont affichés que
 * selon les droits calculés par le serveur (`access`) : sans droit de téléchargement, aucun
 * bouton « Télécharger » (CERT-06) ; archive : download_archived (CERT-07).
 */
export function AttachmentFileRow({ certificateId, attachment, extra }: { certificateId: string; attachment: AttachmentDto; extra?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const f = attachment.file;
  if (!f) return null;
  const base = `/certificates/${certificateId}/attachments/${attachment.id}`;
  const previewable = attachment.access.preview && (f.kind === 'PDF' || f.kind === 'IMAGE');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-line bg-white px-3 py-2">
      <span className="flex min-w-[10rem] flex-1 items-center gap-2">
        {fileIcon(f.kind)}
        <span className="min-w-0 truncate text-sm" title={f.originalName}>
          {f.originalName}
        </span>
        <span className="shrink-0 text-xs tabular text-ink-muted">{fmtBytes(f.sizeBytes)}</span>
      </span>
      {extra}
      <span className="ml-auto flex items-center gap-1">
        {previewable && (
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <Eye className="h-4 w-4" aria-hidden /> Aperçu
          </Button>
        )}
        {attachment.access.download && <DownloadButton path={`${base}/download`} size="sm" />}
      </span>
      {previewable && open && (
        <FilePreviewDialog
          open={open}
          onOpenChange={setOpen}
          title={f.originalName}
          previewPath={`${base}/preview`}
          downloadPath={`${base}/download`}
          canDownload={attachment.access.download}
          kind={f.kind}
        />
      )}
    </div>
  );
}
