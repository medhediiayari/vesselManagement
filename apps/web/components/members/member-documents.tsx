'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive, FilePlus2 } from 'lucide-react';
import { useState } from 'react';
import { FileRow } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { DOCUMENT_CATEGORIES, type MemberDetail, type MemberDocument } from './types';

/**
 * Onglet Documents : dépôt MEMBER_DOCUMENT, aperçu (members.view + ADM-070), téléchargement
 * seulement si la fiche l'indique (permission distincte), archivage avec motif (jamais de suppression).
 */
export function MemberDocuments({ member, readOnly }: { member: MemberDetail; readOnly?: boolean }) {
  const id = member.id;
  const canEdit = !readOnly && member.permissions.canEdit && !member.archivedAt;
  const [showArchived, setShowArchived] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [pending, setPending] = useState<StoredFileDto | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState(DOCUMENT_CATEGORIES[0]);
  const [archiving, setArchiving] = useState<MemberDocument | null>(null);

  const docs = useQuery({
    queryKey: ['member-documents', id, showArchived],
    queryFn: () => api.get<MemberDocument[]>(`/members/${id}/documents`, { query: { archived: showArchived || undefined } }),
  });

  const add = useAction(() => api.post(`/members/${id}/documents`, { fileId: pending!.id, title: title.trim(), category }), {
    success: 'Document ajouté',
    invalidate: [['member-documents', id], ['member', id]],
    onSuccess: () => {
      setAddOpen(false);
      setPending(null);
      setTitle('');
    },
  });

  const list = docs.data ?? [];

  return (
    <Panel
      title="Documents de la fiche"
      actions={
        <>
          <Checkbox label="Afficher les archivés" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {canEdit && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <FilePlus2 className="h-4 w-4" aria-hidden /> Ajouter
            </Button>
          )}
        </>
      }
    >
      {docs.isLoading && <LoadingBlock rows={3} />}
      {docs.error && <ErrorState error={docs.error} onRetry={() => docs.refetch()} />}
      {docs.data && list.length === 0 && (
        <EmptyState title="Aucun document" description="Contrats, pièces d'identité, attestations : stockage privé, consultation journalisée." />
      )}
      <ul className="space-y-2">
        {list.map((d) => (
          <li key={d.id}>
            {d.file ? (
              <FileRow
                fileId={d.file.id}
                name={`${d.title} — ${d.file.originalName}`}
                kind={d.file.kind}
                sizeBytes={d.file.sizeBytes}
                previewPath={`/members/${id}/documents/${d.id}/preview`}
                downloadPath={`/members/${id}/documents/${d.id}/download`}
                canDownload={member.permissions.canDownloadDocuments}
                extra={
                  <span className="flex shrink-0 items-center gap-1.5">
                    <Badge tone="neutral" icon={false}>
                      {d.category}
                    </Badge>
                    {d.archivedAt ? (
                      <Badge tone="neutral" icon={<Archive className="h-3.5 w-3.5" aria-hidden />}>
                        Archivé le {fmtDate(d.archivedAt)}
                      </Badge>
                    ) : (
                      <span className="hidden text-xs text-ink-muted md:inline">{fmtDate(d.createdAt)}</span>
                    )}
                    {canEdit && !d.archivedAt && (
                      <IconButton label={`Archiver ${d.title}`} onClick={() => setArchiving(d)}>
                        <Archive className="h-4 w-4" />
                      </IconButton>
                    )}
                  </span>
                }
              />
            ) : (
              <p className="rounded-md border border-line px-3 py-2 text-sm text-ink-muted">{d.title} — fichier indisponible</p>
            )}
          </li>
        ))}
      </ul>
      {!member.permissions.canDownloadDocuments && list.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">Aperçu uniquement : le téléchargement exige une permission distincte.</p>
      )}

      <Dialog
        open={addOpen}
        onOpenChange={(o) => {
          setAddOpen(o);
          if (!o) setPending(null);
        }}
        title="Ajouter un document"
        footer={
          <>
            <Button variant="secondary" onClick={() => setAddOpen(false)}>
              Annuler
            </Button>
            <Button onClick={() => add.mutate(undefined)} loading={add.isPending} disabled={!pending || title.trim().length < 2}>
              Enregistrer
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <FileUploader
            context="MEMBER_DOCUMENT"
            onUploaded={(f) => {
              setPending(f);
              if (!title) setTitle(f.originalName.replace(/\.[^.]+$/, '').slice(0, 200));
            }}
          />
          <Field label="Titre" required htmlFor="doc-title">
            <Input id="doc-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <Field label="Catégorie" required htmlFor="doc-cat">
            <Select id="doc-cat" value={category} onChange={(e) => setCategory(e.target.value)}>
              {DOCUMENT_CATEGORIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title="Archiver le document"
        description={archiving ? `${archiving.title} — le fichier reste conservé et consultable dans les archives.` : undefined}
        confirmLabel="Archiver"
        tone="danger"
        requireReason
        reasonLabel="Motif de l'archivage"
        onConfirm={async (reason) => {
          if (!archiving) return;
          await api.post(`/members/${id}/documents/${archiving.id}/archive`, { reason });
          await docs.refetch();
        }}
      />
    </Panel>
  );
}
