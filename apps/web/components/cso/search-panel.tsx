'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderSearch, Search, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/page';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { FolderPickerDialog } from './folder-picker';
import { libraryLabel, useCategoryFields, useLibraries } from './lib';
import { PrincipalPicker } from './principal-picker';
import type { CsoCategory, CsoFolderDetail, CsoSearchItem } from './types';
import { CSO_DOC_STATUS_LABELS } from './types';
import { DocStatusBadge, DueDate, Reference, userName, ViaShareBadge } from './ui';

export interface CsoSearchParams {
  q?: string;
  vesselId?: string;
  libraryId?: string;
  folderId?: string;
  categoryId?: string;
  status?: string;
  authorId?: string;
  from?: string;
  to?: string;
  fieldId?: string;
  fieldValue?: string;
  includeArchived?: string;
}

const KEYS: (keyof CsoSearchParams)[] = ['q', 'vesselId', 'libraryId', 'folderId', 'categoryId', 'status', 'authorId', 'from', 'to', 'fieldId', 'fieldValue', 'includeArchived'];

export function readSearchParams(sp: URLSearchParams): CsoSearchParams {
  const out: CsoSearchParams = {};
  for (const k of KEYS) {
    const v = sp.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/**
 * Recherche CSO (CSO-013) : texte (nom, référence, description, contenu indexé) + filtres
 * navire / bibliothèque / dossier / catégorie / statut / auteur / dates / champ personnalisé.
 * Résultats filtrés par droits AVANT réponse ; pagination serveur par curseur opaque.
 */
export function CsoSearch({ params, onChange }: { params: CsoSearchParams; onChange: (p: CsoSearchParams) => void }) {
  const { me, can } = useSession();
  const libs = useLibraries();
  const ids = { q: useId(), vessel: useId(), lib: useId(), cat: useId(), status: useId(), from: useId(), to: useId(), field: useId(), fv: useId(), author: useId() };
  const [draft, setDraft] = useState<CsoSearchParams>(params);
  const [pickFolder, setPickFolder] = useState(false);
  const [authorLabel, setAuthorLabel] = useState<string | null>(null);
  useEffect(() => setDraft(params), [params]);

  const categories = useQuery({ queryKey: ['cso', 'categories', 'all'], queryFn: () => api.get<CsoCategory[]>('/cso/categories'), staleTime: 60_000 });
  const fields = useCategoryFields(draft.categoryId ?? null);
  const folder = useQuery({
    queryKey: ['cso', 'folder', params.folderId],
    queryFn: () => api.get<CsoFolderDetail>(`/cso/folders/${params.folderId}`),
    enabled: !!params.folderId,
    retry: false,
  });

  const query = useMemo(() => Object.fromEntries(Object.entries(params).filter(([, v]) => v)), [params]);
  const res = useCursorList<CsoSearchItem>(['cso', 'search'], '/cso/search', query, true);

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const clean = Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined && v !== '')) as CsoSearchParams;
    if (!clean.fieldId) delete clean.fieldValue;
    if (clean.fieldId && !clean.fieldValue) delete clean.fieldId;
    onChange(clean);
  }
  const set = (k: keyof CsoSearchParams, v: string) => setDraft((d) => ({ ...d, [k]: v || undefined }));
  const activeFilters = Object.keys(params).filter((k) => k !== 'q').length;

  return (
    <div className="space-y-3">
      <form onSubmit={submit}>
        <FilterBar>
          <Field label="Rechercher" htmlFor={ids.q} className="min-w-[240px] flex-[2]">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden />
              <Input id={ids.q} value={draft.q ?? ''} onChange={(e) => set('q', e.target.value)} placeholder="Titre, référence, description…" className="pl-8" maxLength={200} />
            </div>
          </Field>
          {me.accessibleVessels.length > 0 && (
            <Field label="Navire" htmlFor={ids.vessel} className="w-44">
              <Select id={ids.vessel} value={draft.vesselId ?? ''} onChange={(e) => set('vesselId', e.target.value)}>
                <option value="">Tous</option>
                {me.accessibleVessels.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Bibliothèque" htmlFor={ids.lib} className="w-48">
            <Select id={ids.lib} value={draft.libraryId ?? ''} onChange={(e) => set('libraryId', e.target.value)}>
              <option value="">Toutes</option>
              {libs.data?.map((l) => (
                <option key={l.id} value={l.id}>
                  {libraryLabel(l)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Catégorie" htmlFor={ids.cat} className="w-48">
            <Select id={ids.cat} value={draft.categoryId ?? ''} onChange={(e) => setDraft((d) => ({ ...d, categoryId: e.target.value || undefined, fieldId: undefined, fieldValue: undefined }))}>
              <option value="">Toutes</option>
              {categories.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Statut" htmlFor={ids.status} className="w-36">
            <Select id={ids.status} value={draft.status ?? ''} onChange={(e) => set('status', e.target.value)}>
              <option value="">Tous</option>
              {['PUBLISHED', 'DRAFT', ...(can('cso.archive.view') ? ['ARCHIVED'] : [])].map((s) => (
                <option key={s} value={s}>
                  {CSO_DOC_STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Créé du" htmlFor={ids.from} className="w-40">
            <Input id={ids.from} type="date" value={draft.from ?? ''} onChange={(e) => set('from', e.target.value)} />
          </Field>
          <Field label="au" htmlFor={ids.to} className="w-40">
            <Input id={ids.to} type="date" value={draft.to ?? ''} onChange={(e) => set('to', e.target.value)} />
          </Field>
          {draft.categoryId && (fields.data?.length ?? 0) > 0 && (
            <>
              <Field label="Champ" htmlFor={ids.field} className="w-44">
                <Select id={ids.field} value={draft.fieldId ?? ''} onChange={(e) => set('fieldId', e.target.value)}>
                  <option value="">—</option>
                  {fields.data?.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.fieldId && (
                <Field label="Valeur contient" htmlFor={ids.fv} className="w-40">
                  <Input id={ids.fv} value={draft.fieldValue ?? ''} onChange={(e) => set('fieldValue', e.target.value)} maxLength={200} />
                </Field>
              )}
            </>
          )}
          <div className="flex h-9 items-center gap-4">
            <Checkbox label="Mes documents" checked={draft.authorId === me.id} onChange={(e) => set('authorId', e.target.checked ? me.id : '')} />
            {can('cso.archive.view') && (
              <Checkbox label="Inclure les archives" checked={draft.includeArchived === 'true'} onChange={(e) => set('includeArchived', e.target.checked ? 'true' : '')} />
            )}
          </div>
          <div className="flex items-end gap-2">
            <Button type="submit">
              <Search className="h-4 w-4" aria-hidden /> Rechercher
            </Button>
            {(activeFilters > 0 || params.q) && (
              <Button variant="ghost" onClick={() => onChange({})}>
                <X className="h-4 w-4" aria-hidden /> Réinitialiser
              </Button>
            )}
          </div>
        </FilterBar>
      </form>
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-ink-muted">Dossier :</span>
        {params.folderId ? (
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-0.5">
            {folder.data ? `${libraryLabel(folder.data.library)} / ${folder.data.name}` : '…'} (et sous-dossiers)
            <button type="button" className="rounded p-0.5 text-ink-muted hover:bg-navy-50" aria-label="Retirer le filtre dossier" onClick={() => onChange({ ...params, folderId: undefined })}>
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        ) : (
          <span className="text-ink-muted">tous</span>
        )}
        <Button variant="ghost" size="sm" onClick={() => setPickFolder(true)}>
          <FolderSearch className="h-4 w-4" aria-hidden /> Choisir un dossier
        </Button>
        {can('users.view') && (
          <details className="ml-auto">
            <summary className="cursor-pointer text-sm text-action">Filtrer par un autre auteur{authorLabel && params.authorId && params.authorId !== me.id ? ` (${authorLabel})` : ''}</summary>
            <div className="mt-2 rounded-md border border-line bg-white p-2">
              <PrincipalPicker
                types={['USER']}
                addLabel="Filtrer"
                onAdd={(p) => {
                  setAuthorLabel(p.label);
                  onChange({ ...params, authorId: p.principalId });
                }}
              />
            </div>
          </details>
        )}
      </div>

      {res.error ? (
        <ErrorState error={res.error} onRetry={() => res.refetch()} />
      ) : (
        <div className="overflow-hidden rounded-lg bg-white shadow-panel">
          <div className="overflow-x-auto">
            <table className="table-amc">
              <caption className="sr-only">Résultats de recherche</caption>
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Référence</th>
                  <th scope="col" className="hidden md:table-cell">Emplacement</th>
                  <th scope="col" className="hidden lg:table-cell">Catégorie</th>
                  <th scope="col">Statut</th>
                  <th scope="col" className="hidden lg:table-cell">Révision</th>
                  <th scope="col" className="hidden xl:table-cell">Auteur</th>
                  <th scope="col" className="hidden sm:table-cell">Modifié</th>
                </tr>
              </thead>
              <tbody>
                {res.loading &&
                  Array.from({ length: 6 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={8}>
                        <Skeleton className="h-4 w-full" />
                      </td>
                    </tr>
                  ))}
                {res.rows?.map((d) => (
                  <tr key={d.id}>
                    <td className="max-w-[340px]">
                      <Link href={`/cso/documents/${d.id}`} className="font-medium text-navy hover:text-action hover:underline">
                        {d.title}
                      </Link>
                      {d.viaShare && <ViaShareBadge />}
                      {d.description && <p className="line-clamp-2 text-xs text-ink-muted">{d.description}</p>}
                    </td>
                    <td>
                      <Reference value={d.reference} />
                    </td>
                    <td className="hidden md:table-cell">
                      <span className="block text-xs text-ink-muted">{libraryLabel(d.library)}</span>
                      {d.folder ? (
                        <Link href={`/cso?folderId=${d.folder.id}&doc=${d.id}`} className="text-sm text-action hover:underline">
                          {d.folder.name}
                        </Link>
                      ) : (
                        <span className="text-ink-soft">—</span>
                      )}
                    </td>
                    <td className="hidden lg:table-cell">{d.category?.name ?? <span className="text-ink-soft">—</span>}</td>
                    <td>
                      <DocStatusBadge status={d.status} />
                    </td>
                    <td className="hidden lg:table-cell">
                      <DueDate value={d.nextReviewOn} />
                    </td>
                    <td className="hidden xl:table-cell">{userName(d.author)}</td>
                    <td className="hidden tabular sm:table-cell">{fmtDate(d.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!res.loading && res.rows?.length === 0 && (
            <EmptyState title="Aucun document trouvé" description="Seuls les documents que vos droits permettent de voir sont recherchés. Modifiez les termes ou les filtres." />
          )}
          {!res.loading && (res.rows?.length ?? 0) > 0 && (
            <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-muted">
              <span className="tabular">{res.rows?.length} résultat(s) affiché(s)</span>
              {res.hasMore && (
                <Button variant="secondary" size="sm" onClick={() => res.loadMore()} loading={res.loadingMore}>
                  Résultats suivants
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      <FolderPickerDialog
        open={pickFolder}
        onOpenChange={setPickFolder}
        title="Limiter à un dossier"
        description="La recherche inclut les sous-dossiers."
        requiredActions={['view']}
        initialLibraryId={params.libraryId ?? null}
        confirmLabel="Appliquer"
        onConfirm={(t) => {
          if (t.folderId) onChange({ ...params, folderId: t.folderId });
        }}
      />
    </div>
  );
}
