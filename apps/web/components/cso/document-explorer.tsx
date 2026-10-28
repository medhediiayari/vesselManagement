'use client';

import * as DM from '@radix-ui/react-dropdown-menu';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  ChevronDown,
  FileArchive,
  FileText,
  Folder,
  FolderInput,
  FolderPlus,
  KeyRound,
  Pencil,
  Search,
  Settings2,
  UploadCloud,
  UserCheck,
  X,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { api, errorMessage, uploadFile, type StoredFileDto } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { fileIcon } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock, Skeleton } from '@/components/ui/states';
import { AclEditorDialog } from './acl-editor';
import { CreateDocumentDialog } from './document-forms';
import { DocumentQuickView } from './document-panel';
import { FolderPickerDialog } from './folder-picker';
import { FolderTree } from './folder-tree';
import { has, libraryLabel, useCsoRun, useFolderAccess, useLibraries } from './lib';
import { RestoreFolderDialog } from './restore-folder-dialog';
import type { CsoDocumentListItem, CsoFolder, CsoFolderDetail, CsoLibrary } from './types';
import { ValidatorsDialog } from './validators-editor';
import { ArchivedFolderBadge, CsoBreadcrumb, DocStatusBadge, DueDate, EffectiveRights, Notice, Reference, ViaShareBadge } from './ui';
import { ZipDialog, type ZipRequest } from './zip';

export interface ExplorerLocation {
  libraryId: string | null;
  folderId: string | null;
  documentId: string | null;
}

interface UploadItem {
  key: string;
  name: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  error?: string;
}

type FolderDialog = 'new' | 'rename' | 'move' | 'archive' | 'restore' | 'acl' | 'validators' | null;

function NameDialog({
  open,
  onOpenChange,
  title,
  initial,
  confirmLabel,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title: string;
  initial: string;
  confirmLabel: string;
  onSubmit: (name: string) => Promise<unknown>;
}) {
  const id = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(initial);
      setError(null);
    }
  }, [open, initial]);
  const invalid = !name.trim() || /[/\\]/.test(name) || name.trim() === '.' || name.trim() === '..';
  async function submit(e?: FormEvent) {
    e?.preventDefault();
    if (invalid) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(name.trim());
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => submit()} loading={busy} disabled={invalid}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <Field label="Nom du dossier" htmlFor={id} required error={name && /[/\\]/.test(name) ? 'Les caractères / et \\ sont interdits' : undefined}>
          <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </form>
    </Dialog>
  );
}

function MenuItem({ icon, children, onSelect }: { icon: ReactNode; children: ReactNode; onSelect: () => void }) {
  return (
    <DM.Item onSelect={onSelect} className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-ink outline-none data-[highlighted]:bg-navy-50">
      {icon}
      {children}
    </DM.Item>
  );
}

/**
 * DocumentExplorer — bibliothèque documentaire CSO façon SharePoint (CDC §5, §6.2–6.4, priorité UI 2) :
 * arborescence (chargement paresseux), fil d'Ariane, contenu du dossier, dépôt glisser-déposer avec
 * progression, aperçu rapide du document, droits effectifs visibles, ZIP multi-sélection.
 * Les zones non autorisées sont simplement absentes : l'API ne renvoie que ce que l'utilisateur voit.
 */
export function DocumentExplorer({
  initialVesselId,
  initialLibraryId,
  initialFolderId,
  initialDocumentId,
  onLocationChange,
  onSearch,
}: {
  initialVesselId?: string | null;
  initialLibraryId?: string | null;
  initialFolderId?: string | null;
  initialDocumentId?: string | null;
  onLocationChange?: (loc: ExplorerLocation) => void;
  onSearch?: (q: string, scope: { libraryId: string | null; folderId: string | null }) => void;
}) {
  const { can, canAny } = useSession();
  const run = useCsoRun();
  const libs = useLibraries();
  const ids = { lib: useId(), search: useId() };
  const [libraryId, setLibraryId] = useState<string | null>(initialLibraryId ?? null);
  const [folderId, setFolderId] = useState<string | null>(initialFolderId ?? null);
  const [docId, setDocId] = useState<string | null>(initialDocumentId ?? null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selDocs, setSelDocs] = useState<Set<string>>(new Set());
  const [selFolders, setSelFolders] = useState<Set<string>>(new Set());
  const [zip, setZip] = useState<ZipRequest | null>(null);
  const [dialog, setDialog] = useState<FolderDialog>(null);
  const [manualCreate, setManualCreate] = useState(false);
  const [queue, setQueue] = useState<StoredFileDto[]>([]);
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const [search, setSearch] = useState('');
  const dragDepth = useRef(0);

  // --- Dossier courant ------------------------------------------------------
  const folder = useQuery({
    queryKey: ['cso', 'folder', folderId],
    queryFn: () => api.get<CsoFolderDetail>(`/cso/folders/${folderId}`),
    enabled: !!folderId,
    retry: false,
  });
  const access = useFolderAccess(folderId);

  // --- Résolution de la bibliothèque initiale --------------------------------
  useEffect(() => {
    if (libraryId || !libs.data) return;
    if (!libs.data.length) return;
    if (folderId) {
      if (folder.data) setLibraryId(folder.data.libraryId);
      else if (folder.error) {
        setNotice('Le dossier demandé est introuvable ou hors de vos droits.');
        setFolderId(null);
        setLibraryId(libs.data[0].id);
      }
      return;
    }
    if (initialVesselId) {
      const lib = libs.data.find((l) => l.vessel?.id === initialVesselId);
      if (lib) setLibraryId(lib.id);
      else {
        setNotice("La bibliothèque CSO de ce navire n'est pas accessible avec votre périmètre.");
        setLibraryId(libs.data[0].id);
      }
      return;
    }
    setLibraryId(libs.data[0].id);
  }, [libs.data, libraryId, folderId, folder.data, folder.error, initialVesselId]);

  useEffect(() => {
    onLocationChange?.({ libraryId, folderId, documentId: docId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId, folderId, docId]);

  const library: CsoLibrary | null = libs.data?.find((l) => l.id === libraryId) ?? null;
  const current = folderId && folder.data?.id === folderId ? folder.data : null;
  const actions = access.data?.actions ?? current?.actions;
  const active = current?.status === 'ACTIVE';

  // --- Contenu -------------------------------------------------------------------
  const subfolders = useQuery({
    queryKey: ['cso', 'subfolders', libraryId, folderId, includeArchived],
    queryFn: () => api.get<CsoFolder[]>('/cso/folders', { query: folderId ? { parentId: folderId, includeArchived } : { libraryId: libraryId!, includeArchived } }),
    enabled: !!libraryId && (!folderId || !!current),
  });
  const docs = useCursorList<CsoDocumentListItem>(['cso', 'documents', folderId], '/cso/documents', { folderId, includeArchived }, !!folderId && !!current);

  // --- Navigation -----------------------------------------------------------------
  function navigate(id: string | null) {
    setFolderId(id);
    setDocId(null);
    setSelDocs(new Set());
    setSelFolders(new Set());
    setNotice(null);
  }
  function changeLibrary(id: string) {
    setLibraryId(id);
    navigate(null);
  }

  const reveal = useMemo(
    () => (current ? { ids: current.breadcrumb.items.map((b) => b.id), depth: current.depth } : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [current?.id],
  );

  // --- Droits d'interface (indicatifs ; l'API revalide) --------------------------------
  const canNewFolder = folderId ? active && can('cso.folder.create') && has(actions, 'folder_create') : !!library?.canCreateRootFolder;
  const canUpload = !!current && active && can('cso.create') && has(actions, 'edit');
  const zipAllowed = canAny('cso.download', 'cso.archive.download');
  const folderMenu = current
    ? {
        rename: active && can('cso.folder.rename') && has(actions, 'folder_rename'),
        move: active && can('cso.folder.move') && has(actions, 'folder_move'),
        archive: active && can('cso.folder.archive') && has(actions, 'folder_archive'),
        restore: !active && can('cso.restore') && has(actions, 'restore') && has(actions, 'view_archived'),
        acl: can('cso.folder.acl_manage') && has(actions, 'acl_manage'),
        validators: true,
      }
    : null;
  const folderManageable = !!folderMenu && (folderMenu.rename || folderMenu.move || folderMenu.archive || folderMenu.restore || folderMenu.acl);
  const validatorsEditable = !!current && active && can('cso.categories.manage') && can('cso.folder.acl_manage') && has(actions, 'acl_manage');

  // --- Dépôt glisser-déposer -------------------------------------------------------------
  function startUploads(files: FileList | File[]) {
    if (!canUpload || !library) return;
    Array.from(files)
      .slice(0, 10)
      .forEach((f) => {
        const key = `${f.name}-${f.size}-${Date.now()}-${Math.random()}`;
        setUploads((prev) => [...prev, { key, name: f.name, progress: 0, status: 'uploading' }]);
        uploadFile(f, 'CSO_DOCUMENT', library.vessel?.id ?? null, (p) => setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, progress: p } : u))))
          .then((res) => {
            setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, status: 'done', progress: 100 } : u)));
            setQueue((q) => [...q, res]);
          })
          .catch((e) => setUploads((prev) => prev.map((u) => (u.key === key ? { ...u, status: 'error', error: errorMessage(e) } : u))));
      });
  }
  const dropHandlers = canUpload
    ? {
        onDragEnter: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          dragDepth.current += 1;
          setDragging(true);
        },
        onDragOver: (e: DragEvent) => {
          if (!e.dataTransfer.types.includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        },
        onDragLeave: () => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragging(false);
        },
        onDrop: (e: DragEvent) => {
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          if (e.dataTransfer.files.length) startUploads(e.dataTransfer.files);
        },
      }
    : {};

  // --- Sélection ZIP -------------------------------------------------------------------
  const zipableDoc = (d: CsoDocumentListItem) => (d.status === 'ARCHIVED' ? has(d.actions, 'download_archived') : has(d.actions, 'download'));
  const visibleDocs = docs.rows ?? [];
  const visibleFolders = subfolders.data ?? [];
  const selectableCount = visibleFolders.length + visibleDocs.filter(zipableDoc).length;
  const selectedCount = selDocs.size + selFolders.size;
  const allSelected = selectableCount > 0 && selectedCount === selectableCount;
  function toggleAll() {
    if (allSelected) {
      setSelDocs(new Set());
      setSelFolders(new Set());
    } else {
      setSelDocs(new Set(visibleDocs.filter(zipableDoc).map((d) => d.id)));
      setSelFolders(new Set(visibleFolders.map((f) => f.id)));
    }
  }

  // --- Rendu ---------------------------------------------------------------------------
  if (libs.isLoading) return <LoadingBlock rows={10} />;
  if (libs.error) return <ErrorState error={libs.error} onRetry={() => libs.refetch()} />;
  if (!libs.data?.length) return <EmptyState title="Aucune bibliothèque accessible" description="Votre périmètre ne comprend aucune bibliothèque CSO." />;

  const libName = libraryLabel(library);
  const folderTitle = current?.name ?? (folderId ? '…' : 'Racine de la bibliothèque');
  const loadingContent = (folderId && (folder.isLoading || !current)) || subfolders.isLoading || (!!current && docs.loading);
  const empty = !loadingContent && visibleFolders.length === 0 && visibleDocs.length === 0;
  const showPanel = !!docId;
  const createOpen = manualCreate || queue.length > 0;

  return (
    <div className={cn('grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]', showPanel && '2xl:grid-cols-[240px_minmax(0,1fr)_360px]')}>
      {/* ------------------------------------------------------------- Arborescence */}
      <aside className="panel flex h-fit flex-col gap-3 p-3 lg:sticky lg:top-4 lg:max-h-[calc(100vh-120px)]" aria-label="Bibliothèques et dossiers">
        <Field label="Bibliothèque" htmlFor={ids.lib}>
          <Select id={ids.lib} value={libraryId ?? ''} onChange={(e) => changeLibrary(e.target.value)}>
            {libs.data.map((l) => (
              <option key={l.id} value={l.id}>
                {libraryLabel(l)}
              </option>
            ))}
          </Select>
        </Field>
        {onSearch && (
          <form
            role="search"
            onSubmit={(e) => {
              e.preventDefault();
              if (search.trim()) onSearch(search.trim(), { libraryId, folderId });
            }}
          >
            <label htmlFor={ids.search} className="sr-only">
              Rechercher dans {folderId ? 'ce dossier' : 'cette bibliothèque'}
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-soft" aria-hidden />
              <Input
                id={ids.search}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={folderId ? 'Rechercher dans ce dossier…' : 'Rechercher dans la bibliothèque…'}
                className="pl-8"
              />
            </div>
          </form>
        )}
        {can('cso.archive.view') && (
          <Checkbox label="Afficher les archives" checked={includeArchived} onChange={(e) => setIncludeArchived(e.target.checked)} />
        )}
        <div className="-mx-1 min-h-0 overflow-y-auto">
          {library && (
            <FolderTree
              libraryId={library.id}
              libraryName={libName}
              includeArchived={includeArchived}
              selectedId={folderId}
              rootSelected={!folderId}
              onSelectRoot={() => navigate(null)}
              onSelect={(n) => navigate(n.id)}
              reveal={reveal}
            />
          )}
        </div>
      </aside>

      {/* ------------------------------------------------------------- Contenu du dossier */}
      <section className="min-w-0 space-y-3" aria-label="Contenu du dossier">
        {notice && (
          <Notice tone="warn">
            <span className="flex items-start justify-between gap-2">
              {notice}
              <button type="button" className="text-ink-muted hover:text-ink" onClick={() => setNotice(null)} aria-label="Masquer le message">
                <X className="h-4 w-4" />
              </button>
            </span>
          </Notice>
        )}
        <div className="panel space-y-3 p-4">
          <CsoBreadcrumb
            libraryName={libName}
            breadcrumb={current?.breadcrumb}
            current={folderId ? current?.name : null}
            onRoot={folderId ? () => navigate(null) : undefined}
            onNavigate={(id) => navigate(id)}
          />
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
                <Folder className="h-5 w-5 text-action" aria-hidden />
                <span className="break-words">{folderTitle}</span>
                {current?.status === 'ARCHIVED' && <ArchivedFolderBadge />}
              </h2>
              {current ? (
                access.isLoading ? (
                  <Skeleton className="mt-2 h-5 w-72" />
                ) : (
                  <EffectiveRights actions={actions} className="mt-2" label="Vos droits sur ce dossier" />
                )
              ) : (
                !folderId && <p className="mt-1 text-sm text-ink-muted">Choisissez un dossier : les documents sont rangés dans des dossiers.</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canNewFolder && (
                <Button variant="secondary" size="sm" onClick={() => setDialog('new')}>
                  <FolderPlus className="h-4 w-4" aria-hidden /> Nouveau dossier
                </Button>
              )}
              {canUpload && (
                <Button size="sm" onClick={() => setManualCreate(true)}>
                  <UploadCloud className="h-4 w-4" aria-hidden /> Déposer un document
                </Button>
              )}
              {folderMenu && !folderManageable && (
                <Button variant="ghost" size="sm" onClick={() => setDialog('validators')}>
                  <UserCheck className="h-4 w-4" aria-hidden /> Validateurs
                </Button>
              )}
              {folderMenu && folderManageable && (
                <DM.Root>
                  <DM.Trigger asChild>
                    <Button variant="secondary" size="sm">
                      <Settings2 className="h-4 w-4" aria-hidden /> Gérer le dossier <ChevronDown className="h-4 w-4" aria-hidden />
                    </Button>
                  </DM.Trigger>
                  <DM.Portal>
                    <DM.Content align="end" sideOffset={6} className="z-50 min-w-[220px] rounded-lg bg-white p-1 shadow-pop">
                      {folderMenu.rename && <MenuItem icon={<Pencil className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('rename')}>Renommer</MenuItem>}
                      {folderMenu.move && <MenuItem icon={<FolderInput className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('move')}>Déplacer…</MenuItem>}
                      {folderMenu.acl && <MenuItem icon={<KeyRound className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('acl')}>Gérer les accès</MenuItem>}
                      <MenuItem icon={<UserCheck className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('validators')}>
                        {validatorsEditable ? 'Validateurs' : 'Voir les validateurs'}
                      </MenuItem>
                      {folderMenu.archive && <MenuItem icon={<Archive className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('archive')}>Archiver le dossier</MenuItem>}
                      {folderMenu.restore && <MenuItem icon={<ArchiveRestore className="h-4 w-4" aria-hidden />} onSelect={() => setDialog('restore')}>Restaurer…</MenuItem>}
                    </DM.Content>
                  </DM.Portal>
                </DM.Root>
              )}
            </div>
          </div>
        </div>

        {zipAllowed && selectedCount > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-action-100 bg-action-50 px-3 py-2 text-sm" role="region" aria-label="Sélection">
            <span className="font-medium text-navy">{selectedCount} élément(s) sélectionné(s)</span>
            <Button
              size="sm"
              onClick={() => setZip({ documentIds: [...selDocs], folderIds: [...selFolders], includeArchived: includeArchived && can('cso.archive.download') })}
            >
              <FileArchive className="h-4 w-4" aria-hidden /> Télécharger en ZIP
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setSelDocs(new Set());
                setSelFolders(new Set());
              }}
            >
              Désélectionner
            </Button>
            <span className="text-xs text-ink-muted">Les fichiers hors de vos droits sont exclus de l&apos;archive.</span>
          </div>
        )}

        {uploads.length > 0 && (
          <ul className="space-y-1.5" aria-live="polite" aria-label="Dépôts en cours">
            {uploads.map((u) => (
              <li key={u.key} className="rounded-md border border-line bg-white px-3 py-2">
                <div className="flex items-center gap-2 text-sm">
                  <UploadCloud className="h-4 w-4 text-action" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{u.name}</span>
                  <span className="text-xs text-ink-muted">
                    {u.status === 'uploading' ? `${u.progress} %` : u.status === 'done' ? 'Déposé — compléter la fiche' : 'Échec'}
                  </span>
                  {u.status !== 'uploading' && (
                    <button type="button" className="rounded p-0.5 text-ink-muted hover:bg-navy-50" aria-label={`Retirer ${u.name} de la liste`} onClick={() => setUploads((p) => p.filter((x) => x.key !== u.key))}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
                {u.status === 'uploading' && (
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-navy-50" role="progressbar" aria-valuenow={u.progress} aria-valuemin={0} aria-valuemax={100} aria-label={`Dépôt de ${u.name}`}>
                    <div className="h-full bg-action transition-all" style={{ width: `${u.progress}%` }} />
                  </div>
                )}
                {u.error && <p className="mt-1 text-xs font-medium text-danger" role="alert">{u.error}</p>}
              </li>
            ))}
          </ul>
        )}

        <div className={cn('relative overflow-hidden rounded-lg bg-white shadow-panel', dragging && 'ring-2 ring-action')} {...dropHandlers}>
          {dragging && (
            <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-action bg-action-50/90 text-center">
              <UploadCloud className="h-8 w-8 text-action" aria-hidden />
              <p className="font-semibold text-navy">Déposez pour créer un document dans « {current?.name} »</p>
              <p className="text-sm text-ink-muted">Chaque fichier ouvre la fiche de création (titre, catégorie, dates).</p>
            </div>
          )}
          {folderId && folder.error ? (
            <ErrorState error={folder.error} onRetry={() => folder.refetch()} />
          ) : subfolders.error || docs.error ? (
            <ErrorState error={subfolders.error ?? docs.error} onRetry={() => { subfolders.refetch(); docs.refetch(); }} />
          ) : (
            <>
              {canUpload && (
                <p className="flex items-center gap-2 border-b border-line bg-canvas/60 px-3 py-2 text-xs text-ink-muted">
                  <UploadCloud className="h-4 w-4 text-action" aria-hidden /> Glissez-déposez des fichiers ici pour créer des documents dans ce dossier (barre de progression, fiche à compléter).
                </p>
              )}
              <div className="overflow-x-auto">
                <table className="table-amc">
                  <caption className="sr-only">Contenu de {folderTitle}</caption>
                  <thead>
                    <tr>
                      {zipAllowed && (
                        <th scope="col" className="w-8">
                          <input
                            type="checkbox"
                            className="h-4 w-4 rounded border-line-strong"
                            aria-label="Tout sélectionner pour le téléchargement ZIP"
                            checked={allSelected}
                            disabled={selectableCount === 0}
                            onChange={toggleAll}
                          />
                        </th>
                      )}
                      <th scope="col">Nom</th>
                      <th scope="col">Référence</th>
                      <th scope="col" className={cn('hidden md:table-cell', showPanel && '2xl:hidden')}>Catégorie</th>
                      <th scope="col">Statut</th>
                      <th scope="col" className={cn('hidden sm:table-cell', showPanel && '2xl:hidden')}>Version</th>
                      <th scope="col" className="hidden lg:table-cell">Révision</th>
                      <th scope="col" className="hidden lg:table-cell">Expiration</th>
                      <th scope="col" className={cn('hidden xl:table-cell', showPanel && '2xl:hidden')}>Modifié</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loadingContent &&
                      Array.from({ length: 5 }).map((_, i) => (
                        <tr key={`sk-${i}`}>
                          <td colSpan={9}>
                            <Skeleton className="h-4 w-full" />
                          </td>
                        </tr>
                      ))}
                    {!loadingContent &&
                      visibleFolders.map((f) => (
                        <tr
                          key={`f-${f.id}`}
                          className="cursor-pointer"
                          onDoubleClick={() => navigate(f.id)}
                        >
                          {zipAllowed && (
                            <td>
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-line-strong"
                                aria-label={`Sélectionner le dossier ${f.name}`}
                                checked={selFolders.has(f.id)}
                                onChange={(e) => {
                                  const n = new Set(selFolders);
                                  if (e.target.checked) n.add(f.id);
                                  else n.delete(f.id);
                                  setSelFolders(n);
                                }}
                              />
                            </td>
                          )}
                          <td>
                            <button type="button" className="inline-flex max-w-full items-center gap-2 text-left font-medium text-navy hover:text-action hover:underline" onClick={() => navigate(f.id)}>
                              {f.status === 'ARCHIVED' ? <Archive className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden /> : <Folder className="h-4 w-4 shrink-0 text-action" aria-hidden />}
                              <span className="truncate">{f.name}</span>
                            </button>
                          </td>
                          <td>
                            <span className="text-ink-soft">—</span>
                          </td>
                          <td className={cn('hidden md:table-cell', showPanel && '2xl:hidden')}>
                            <span className="text-ink-soft">—</span>
                          </td>
                          <td>{f.status === 'ARCHIVED' ? <ArchivedFolderBadge /> : <span className="text-xs text-ink-muted">Dossier</span>}</td>
                          <td className={cn('hidden sm:table-cell', showPanel && '2xl:hidden')} />
                          <td className="hidden lg:table-cell" />
                          <td className="hidden lg:table-cell" />
                          <td className={cn('hidden tabular xl:table-cell', showPanel && '2xl:hidden')}>{fmtDate(f.updatedAt)}</td>
                        </tr>
                      ))}
                    {!loadingContent &&
                      visibleDocs.map((d) => (
                        <tr
                          key={`d-${d.id}`}
                          data-selected={docId === d.id || undefined}
                          className="cursor-pointer"
                          onClick={(e) => {
                            if ((e.target as HTMLElement).closest('input,button,a')) return;
                            setDocId(d.id);
                          }}
                        >
                          {zipAllowed && (
                            <td>
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-line-strong"
                                aria-label={`Sélectionner ${d.title}`}
                                disabled={!zipableDoc(d)}
                                title={!zipableDoc(d) ? 'Téléchargement non autorisé' : undefined}
                                checked={selDocs.has(d.id)}
                                onChange={(e) => {
                                  const n = new Set(selDocs);
                                  if (e.target.checked) n.add(d.id);
                                  else n.delete(d.id);
                                  setSelDocs(n);
                                }}
                              />
                            </td>
                          )}
                          <td className="max-w-[320px]">
                            <button
                              type="button"
                              className="inline-flex max-w-full items-center gap-2 text-left font-medium text-ink hover:text-action hover:underline"
                              aria-pressed={docId === d.id}
                              onClick={() => setDocId(d.id)}
                            >
                              {d.currentVersion?.file ? fileIcon(d.currentVersion.file.kind) : <FileText className="h-4 w-4 shrink-0 text-ink-soft" aria-hidden />}
                              <span className="truncate">{d.title}</span>
                            </button>
                            {d.viaShare && <ViaShareBadge />}
                          </td>
                          <td>
                            <Reference value={d.reference} />
                          </td>
                          <td className={cn('hidden md:table-cell', showPanel && '2xl:hidden')}>{d.category?.name ?? <span className="text-ink-soft">—</span>}</td>
                          <td>
                            <DocStatusBadge status={d.status} />
                          </td>
                          <td className={cn('hidden tabular sm:table-cell', showPanel && '2xl:hidden')}>{d.currentVersion ? `v${d.currentVersion.versionNo}` : <span className="text-ink-soft">—</span>}</td>
                          <td className="hidden lg:table-cell">
                            <DueDate value={d.nextReviewOn} />
                          </td>
                          <td className="hidden lg:table-cell">
                            <DueDate value={d.expiryOn} kind="expiry" />
                          </td>
                          <td className={cn('hidden tabular xl:table-cell', showPanel && '2xl:hidden')}>{fmtDate(d.updatedAt)}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
              {empty && (
                <EmptyState
                  title={folderId ? 'Dossier vide' : 'Aucun dossier à la racine'}
                  description={
                    canUpload
                      ? 'Glissez-déposez un fichier ici ou utilisez « Déposer un document ».'
                      : folderId
                        ? 'Aucun élément visible avec vos droits dans ce dossier.'
                        : 'Aucun dossier visible avec vos droits dans cette bibliothèque.'
                  }
                />
              )}
              {!loadingContent && (docs.hasMore || visibleDocs.length > 0) && (
                <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-muted">
                  <span className="tabular">
                    {visibleFolders.length} dossier(s) · {visibleDocs.length}
                    {typeof docs.total === 'number' ? ` sur ${docs.total}` : ''} document(s)
                  </span>
                  {docs.hasMore && (
                    <Button variant="secondary" size="sm" onClick={() => docs.loadMore()} loading={docs.loadingMore}>
                      Charger la suite
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ------------------------------------------------------------- Aperçu rapide */}
      {showPanel && docId && (
        <>
          <div className="fixed inset-0 z-30 bg-navy-900/30 2xl:hidden" aria-hidden onClick={() => setDocId(null)} />
          <aside
            className="fixed inset-y-0 right-0 z-40 w-full max-w-md overflow-y-auto bg-white p-4 shadow-pop 2xl:static 2xl:z-auto 2xl:h-fit 2xl:max-h-[calc(100vh-120px)] 2xl:max-w-none 2xl:rounded-lg 2xl:shadow-panel 2xl:sticky 2xl:top-4"
            aria-label="Aperçu du document"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDocId(null);
            }}
          >
            <DocumentQuickView key={docId} documentId={docId} onClose={() => setDocId(null)} />
          </aside>
        </>
      )}

      {/* ------------------------------------------------------------- Dialogues */}
      {current && library && canUpload && (
        <CreateDocumentDialog
          open={createOpen}
          onOpenChange={(o) => {
            if (o) return;
            if (manualCreate) setManualCreate(false);
            else setQueue((q) => q.slice(1));
          }}
          folder={{ id: current.id, name: current.name }}
          library={library}
          initialFile={manualCreate ? null : (queue[0] ?? null)}
          onCreated={(d) => {
            setDocId(d.id);
            setUploads((p) => p.filter((u) => u.status !== 'done'));
          }}
        />
      )}
      <NameDialog
        open={dialog === 'new'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={folderId ? `Nouveau sous-dossier dans « ${current?.name ?? ''} »` : 'Nouveau dossier à la racine'}
        initial=""
        confirmLabel="Créer"
        onSubmit={(name) =>
          run(
            () => api.post<CsoFolder>('/cso/folders', folderId ? { parentId: folderId, name } : { libraryId, name }),
            (f) => `Dossier « ${f.name} » créé`,
          )
        }
      />
      {current && (
        <>
          <NameDialog
            open={dialog === 'rename'}
            onOpenChange={(o) => !o && setDialog(null)}
            title="Renommer le dossier"
            initial={current.name}
            confirmLabel="Renommer"
            onSubmit={(name) => run(() => api.patch(`/cso/folders/${current.id}`, { name, expectedUpdatedAt: current.updatedAt }), 'Dossier renommé')}
          />
          <FolderPickerDialog
            open={dialog === 'move'}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Déplacer « ${current.name} »`}
            description="Tout le contenu suit le dossier. Entre bibliothèques (navires), vos droits sont exigés des deux côtés ; aucun droit n'est acquis via la destination."
            requiredActions={['folder_create']}
            allowRoot
            disabledIds={[current.id, ...(current.parentId ? [current.parentId] : [])]}
            initialLibraryId={current.libraryId}
            confirmLabel="Déplacer"
            onConfirm={async (t) => {
              await run(
                () =>
                  api.patch<{ descendantsUpdated: number; documentsMoved: number }>(`/cso/folders/${current.id}/move`, {
                    ...(t.folderId ? { targetParentId: t.folderId } : { targetParentId: null, targetLibraryId: t.library.id }),
                    expectedUpdatedAt: current.updatedAt,
                  }),
                (r) => `Dossier déplacé (${r.descendantsUpdated} sous-dossier(s), ${r.documentsMoved} document(s))`,
              );
              if (t.library.id !== libraryId) setLibraryId(t.library.id);
              // l'arborescence et le fil d'Ariane sont rechargés
            }}
          />
          <ConfirmDialog
            open={dialog === 'archive'}
            onOpenChange={(o) => !o && setDialog(null)}
            title={`Archiver « ${current.name} » ?`}
            description="Le dossier, ses sous-dossiers et leurs documents sont archivés (aucune suppression). Une restauration complète ou sélective reste possible."
            confirmLabel="Archiver"
            tone="danger"
            requireReason
            onConfirm={async (reason) => {
              await run(
                () => api.post<{ foldersArchived: number; documentsArchived: number }>(`/cso/folders/${current.id}/archive`, { reason }),
                (r) => `${r.foldersArchived} dossier(s) et ${r.documentsArchived} document(s) archivés`,
              );
              if (!includeArchived) navigate(current.parentId);
            }}
          />
          {dialog === 'restore' && <RestoreFolderDialog open onOpenChange={(o) => !o && setDialog(null)} folder={current} />}
          {dialog === 'acl' && (
            <AclEditorDialog open onOpenChange={(o) => !o && setDialog(null)} kind="folder" id={current.id} name={current.name} canEdit={!!folderMenu?.acl} />
          )}
          {dialog === 'validators' && (
            <ValidatorsDialog open onOpenChange={(o) => !o && setDialog(null)} folderId={current.id} folderName={current.name} canEdit={validatorsEditable} />
          )}
        </>
      )}
      <ZipDialog open={!!zip} onOpenChange={(o) => !o && setZip(null)} request={zip} />
    </div>
  );
}
