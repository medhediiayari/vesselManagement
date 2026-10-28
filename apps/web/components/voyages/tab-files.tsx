'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileRow } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { FormError, SelectField, TextInputField } from './common';
import { VOYAGE_FILE_CATEGORIES, useOp, voyageKeys } from './lib';
import type { VoyageFileRow, VoyageWorkspace } from './types';

function AddFileDialog({ open, onOpenChange, ws }: { open: boolean; onOpenChange: (o: boolean) => void; ws: VoyageWorkspace }) {
  const id = ws.overview.id;
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('OTHER');
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setFile(null);
      setTitle('');
      setCategory('OTHER');
      setError(null);
    }
  }, [open]);
  const add = useOp(() => api.post(`/voyages/${id}/files`, { fileId: file!.id, title: title.trim(), category }), {
    success: 'Fichier ajouté au dossier du voyage',
    invalidate: [voyageKeys.ws(id)],
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      setError(e);
      return true;
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Ajouter un fichier au voyage"
      description="Stockage privé, contrôle antivirus et accès selon le périmètre navire."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => add.mutate(undefined)} loading={add.isPending} disabled={!file || title.trim().length < 2}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <FileUploader
          context="VOYAGE"
          vesselId={ws.overview.vesselId}
          onUploaded={(f) => {
            setFile(f);
            setTitle((t) => t || f.originalName.replace(/\.[^.]+$/, ''));
          }}
        />
        <TextInputField label="Titre" required value={title} onChange={setTitle} maxLength={200} />
        <SelectField label="Catégorie" value={category} onChange={setCategory} options={VOYAGE_FILE_CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()) }))} />
      </div>
    </Dialog>
  );
}

export function FilesTab({ ws }: { ws: VoyageWorkspace }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const id = ws.overview.id;
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const [toggle, setToggle] = useState<VoyageFileRow | null>(null);
  const q = useQuery({
    queryKey: voyageKeys.sub(id, 'files', archived),
    queryFn: () => api.get<VoyageFileRow[]>(`/voyages/${id}/files`, { query: { archived: archived ? 'true' : undefined } }),
  });
  const canAdd = can('voyages.edit') && ws.overview.status !== 'CANCELLED';

  return (
    <Panel
      title="Fichiers du voyage"
      actions={
        <>
          <label className="flex items-center gap-1.5 text-sm text-ink-muted">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="h-4 w-4 rounded border-line-strong" />
            Inclure les archivés
          </label>
          {canAdd && (
            <Button size="sm" onClick={() => setAdding(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Ajouter
            </Button>
          )}
        </>
      }
    >
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState title="Aucun fichier" description="Statement of facts, B/L, surveys, correspondance… Le PDF de la CP reste dans sa fiche confidentielle." />}
      <div className="space-y-2">
        {q.data?.map((f) =>
          f.file ? (
            <div key={f.id} className={f.archivedAt ? 'opacity-70' : undefined}>
              <FileRow
                fileId={f.file.id}
                name={`${f.title} — ${f.file.originalName}`}
                kind={f.file.kind}
                sizeBytes={f.file.sizeBytes}
                extra={
                  <span className="hidden items-center gap-1 md:inline-flex">
                    <Badge tone="neutral" icon={false}>
                      {f.category}
                    </Badge>
                    {f.archivedAt && <Badge tone="neutral">Archivé</Badge>}
                    <span className="text-xs text-ink-muted">
                      {f.uploadedBy ?? '—'}, {fmtDateTime(f.createdAt)}
                    </span>
                    {can('voyages.edit') && (
                      <IconButton label={f.archivedAt ? `Désarchiver ${f.title}` : `Archiver ${f.title}`} onClick={() => setToggle(f)}>
                        {f.archivedAt ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                      </IconButton>
                    )}
                  </span>
                }
              />
            </div>
          ) : null,
        )}
      </div>
      <AddFileDialog open={adding} onOpenChange={setAdding} ws={ws} />
      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.archivedAt ? `Désarchiver « ${toggle.title} »` : `Archiver « ${toggle?.title ?? ''} »`}
        description="Le fichier n’est jamais supprimé : l’archivage est tracé et réversible."
        confirmLabel={toggle?.archivedAt ? 'Désarchiver' : 'Archiver'}
        requireReason
        onConfirm={async (reason) => {
          if (!toggle) return;
          await api.post(`/voyages/${id}/files/${toggle.id}/${toggle.archivedAt ? 'unarchive' : 'archive'}`, { reason });
          await qc.invalidateQueries({ queryKey: voyageKeys.ws(id) });
        }}
      />
    </Panel>
  );
}
