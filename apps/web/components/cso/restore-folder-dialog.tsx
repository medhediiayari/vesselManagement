'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { Folder } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { api, type Page } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Textarea } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import { LoadingBlock } from '@/components/ui/states';
import { useCsoRun } from './lib';
import type { CsoDocumentListItem, CsoTreeNode } from './types';
import { Notice, Reference } from './ui';

function flatten(nodes: CsoTreeNode[], out: CsoTreeNode[] = []) {
  nodes.forEach((n) => {
    out.push(n);
    flatten(n.children, out);
  });
  return out;
}

/**
 * Restauration d'un dossier archivé (CSO-019/020) : complète (récursive) ou sélective — les
 * éléments non choisis restent archivés ; chaque document restauré repasse par une nouvelle
 * approbation avant republication.
 */
export function RestoreFolderDialog({ open, onOpenChange, folder }: { open: boolean; onOpenChange: (o: boolean) => void; folder: { id: string; name: string } }) {
  const run = useCsoRun();
  const reasonId = useId();
  const [recursive, setRecursive] = useState(true);
  const [selective, setSelective] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setRecursive(true);
      setSelective(false);
      setSelected(new Set());
      setReason('');
      setError(null);
    }
  }, [open]);

  const subtree = useQuery({
    queryKey: ['cso', 'restore-subtree', folder.id],
    queryFn: () => api.get<CsoTreeNode[]>(`/cso/folders/${folder.id}/tree`, { query: { includeArchived: true } }),
    enabled: open && selective,
  });
  const scopeFolders = useMemo(() => {
    const all = flatten(subtree.data ?? []);
    return (recursive ? all : all.filter((f) => f.id === folder.id)).filter((f) => f.status === 'ARCHIVED').slice(0, 30);
  }, [subtree.data, recursive, folder.id]);
  const docs = useQueries({
    queries: scopeFolders.map((f) => ({
      queryKey: ['cso', 'restore-docs', f.id],
      queryFn: () => api.get<Page<CsoDocumentListItem>>('/cso/documents', { query: { folderId: f.id, includeArchived: true, limit: 200 } }),
      enabled: open && selective,
    })),
  });
  const groups = scopeFolders.map((f, i) => ({
    folder: f,
    docs: (docs[i]?.data?.items ?? []).filter((d) => d.status === 'ARCHIVED' && d.actions?.includes('restore')),
  }));
  const loadingDocs = subtree.isLoading || docs.some((d) => d.isLoading);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Restaurer « ${folder.name} »`}
      description="Les documents restaurés repassent par une nouvelle approbation avant d'être republiés."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            loading={busy}
            disabled={reason.trim().length < 3 || (selective && selected.size === 0)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(
                  () =>
                    api.post<{ foldersRestored: number; documentsRestored: number; documentsLeftArchived: number }>(`/cso/folders/${folder.id}/restore`, {
                      recursive,
                      includeDocumentIds: selective ? [...selected] : undefined,
                      reason: reason.trim(),
                    }),
                  (r) =>
                    `${r.foldersRestored} dossier(s) restauré(s) ; ${r.documentsRestored} document(s) en attente de nouvelle approbation${r.documentsLeftArchived ? ` ; ${r.documentsLeftArchived} resté(s) archivé(s)` : ''}`,
                );
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Restaurer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Checkbox
          label="Inclure les sous-dossiers archivés"
          description="Sinon, seul ce dossier est restauré ; ses sous-dossiers restent archivés."
          checked={recursive}
          onChange={(e) => setRecursive(e.target.checked)}
        />
        <Checkbox
          label="Restauration sélective des documents"
          description="Choisir les documents à restaurer ; les autres restent archivés."
          checked={selective}
          onChange={(e) => setSelective(e.target.checked)}
        />
        {selective && (
          <div className="max-h-64 overflow-y-auto rounded-md border border-line p-2">
            {loadingDocs ? (
              <LoadingBlock rows={3} />
            ) : groups.every((g) => g.docs.length === 0) ? (
              <p className="p-2 text-sm text-ink-muted">Aucun document archivé restaurable dans ce périmètre.</p>
            ) : (
              groups
                .filter((g) => g.docs.length > 0)
                .map((g) => (
                  <fieldset key={g.folder.id} className="mb-2">
                    <legend className="flex items-center gap-1 text-xs font-semibold text-ink-muted">
                      <Folder className="h-3.5 w-3.5" aria-hidden /> {g.folder.name}
                    </legend>
                    <ul className="mt-1 space-y-1">
                      {g.docs.map((d) => (
                        <li key={d.id}>
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              className="h-4 w-4 rounded border-line-strong"
                              checked={selected.has(d.id)}
                              onChange={(e) => {
                                const n = new Set(selected);
                                if (e.target.checked) n.add(d.id);
                                else n.delete(d.id);
                                setSelected(n);
                              }}
                            />
                            <span className="min-w-0 flex-1 truncate">{d.title}</span>
                            <Reference value={d.reference} />
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ))
            )}
          </div>
        )}
        <Field label="Motif" htmlFor={reasonId} required hint="Obligatoire — conservé dans le journal d'audit.">
          <Textarea id={reasonId} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}
