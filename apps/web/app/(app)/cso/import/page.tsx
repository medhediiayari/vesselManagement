'use client';

import { useQuery } from '@tanstack/react-query';
import { FileArchive, FileSpreadsheet, FolderInput, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useId, useState, type ReactNode } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { fileIcon, FileUploader } from '@/components/amc/file-uploader';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import { FolderPickerDialog, type FolderTarget } from '@/components/cso/folder-picker';
import { csoErrorMessage, libraryLabel, useCategoriesFor } from '@/components/cso/lib';
import { IMPORT_PHASE_LABELS, JOB_STATUS_LABELS, type ImportJob } from '@/components/cso/types';
import { Notice } from '@/components/cso/ui';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';

function Step({ n, title, children, disabled }: { n: number; title: string; children: ReactNode; disabled?: boolean }) {
  return (
    <section className={disabled ? 'opacity-60' : undefined}>
      <h2 className="mb-2 flex items-center gap-2 text-md font-semibold">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-navy text-xs font-semibold text-white">{n}</span>
        {title}
      </h2>
      <div className="pl-8">{children}</div>
    </section>
  );
}

function PickedFile({ file, onReset }: { file: StoredFileDto; onReset: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2">
      {fileIcon(file.kind)}
      <span className="min-w-0 flex-1 truncate text-sm">{file.originalName}</span>
      <span className="text-xs tabular text-ink-muted">{fmtBytes(file.sizeBytes)}</span>
      <Button variant="ghost" size="sm" onClick={onReset}>
        <RefreshCw className="h-4 w-4" aria-hidden /> Remplacer
      </Button>
    </div>
  );
}

/** /cso/import — import en masse (CSO-033) : dossier cible, ZIP arborescent ou document, Excel de métadonnées. */
export default function CsoImportPage() {
  const { can } = useSession();
  const router = useRouter();
  const catId = useId();
  const [target, setTarget] = useState<FolderTarget | null>(null);
  const [picking, setPicking] = useState(false);
  const [mode, setMode] = useState<'ZIP' | 'FILE'>('ZIP');
  const [source, setSource] = useState<StoredFileDto | null>(null);
  const [metadata, setMetadata] = useState<StoredFileDto | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = useCategoriesFor(target?.library ?? null);
  const jobs = useQuery({ queryKey: ['cso', 'import-jobs'], queryFn: () => api.get<ImportJob[]>('/cso/import-jobs'), enabled: can('cso.import') });

  if (!can('cso.import')) return <Forbidden message="L'import en masse requiert la permission « Importer en masse (fichiers / ZIP / Excel) »." />;

  const sourceError = source && mode === 'ZIP' && source.kind !== 'ZIP' ? 'Le fichier source doit être une archive ZIP.' : null;
  const metaError = metadata && metadata.kind !== 'EXCEL' ? 'Le fichier de métadonnées doit être un classeur Excel (.xlsx / .xls).' : null;
  const ready = !!target?.folderId && !!source && !sourceError && !metaError;

  return (
    <>
      <CsoPageHeader
        section="import"
        title="Import en masse"
        description="Importer un ZIP arborescent (les dossiers sont conservés) ou un document, avec un classeur Excel de métadonnées facultatif. Prévisualisation et détection des doublons avant toute création ; rien n'est publié automatiquement."
        breadcrumb={[{ label: 'Documents CSO', href: '/cso' }, { label: 'Import en masse' }]}
      />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Panel title="Nouvel import">
          <div className="space-y-6">
            <Step n={1} title="Dossier de destination">
              {target?.folderId ? (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <FolderInput className="h-4 w-4 text-action" aria-hidden />
                  <span className="font-medium text-navy">
                    {libraryLabel(target.library)} / {target.folderName}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setPicking(true)}>
                    Changer
                  </Button>
                </div>
              ) : (
                <Button variant="secondary" onClick={() => setPicking(true)}>
                  <FolderInput className="h-4 w-4" aria-hidden /> Choisir le dossier
                </Button>
              )}
              <p className="field-hint">Exige les droits « Créer des dossiers » et « Déposer / modifier » sur ce dossier.</p>
            </Step>

            <Step n={2} title="Fichier source" disabled={!target}>
              <fieldset className="mb-2 flex flex-wrap gap-4 text-sm" disabled={!target}>
                <legend className="sr-only">Type de source</legend>
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" name="src" checked={mode === 'ZIP'} onChange={() => { setMode('ZIP'); setSource(null); }} />
                  <FileArchive className="h-4 w-4 text-action" aria-hidden /> Archive ZIP (arborescence conservée)
                </label>
                <label className="inline-flex items-center gap-1.5">
                  <input type="radio" name="src" checked={mode === 'FILE'} onChange={() => { setMode('FILE'); setSource(null); }} />
                  Document unique
                </label>
              </fieldset>
              {source ? (
                <PickedFile file={source} onReset={() => setSource(null)} />
              ) : (
                <FileUploader
                  key={`${mode}-${target?.library.id ?? ''}`}
                  context={mode === 'ZIP' ? 'IMPORT_SOURCE' : 'CSO_DOCUMENT'}
                  vesselId={target?.library.vessel?.id ?? null}
                  onUploaded={setSource}
                  disabled={!target}
                  label={mode === 'ZIP' ? "Déposer l'archive ZIP" : 'Déposer le document'}
                  hint={mode === 'ZIP' ? '.zip' : undefined}
                />
              )}
              {sourceError && <p className="field-error">{sourceError}</p>}
            </Step>

            <Step n={3} title="Métadonnées Excel (facultatif)" disabled={!target}>
              {metadata ? (
                <PickedFile file={metadata} onReset={() => setMetadata(null)} />
              ) : (
                <FileUploader context="IMPORT_SOURCE" vesselId={target?.library.vessel?.id ?? null} onUploaded={setMetadata} disabled={!target} label="Déposer le classeur de métadonnées" hint=".xlsx .xls" />
              )}
              {metaError && <p className="field-error">{metaError}</p>}
              <p className="field-hint">
                <FileSpreadsheet className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                Colonnes reconnues : <strong>Chemin</strong> ou <strong>Fichier</strong> (obligatoire), Titre, Référence, Catégorie (code ou nom), Description, Prochaine
                révision, Expiration.
              </p>
            </Step>

            <Step n={4} title="Catégorie par défaut (facultatif)" disabled={!target}>
              <Field label="Appliquée aux lignes sans catégorie" htmlFor={catId} className="max-w-sm">
                <Select id={catId} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} disabled={!target}>
                  <option value="">Aucune</option>
                  {categories.data?.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name} ({c.code})
                    </option>
                  ))}
                </Select>
              </Field>
            </Step>

            {error && <Notice tone="danger">{error}</Notice>}
            <div className="flex justify-end">
              <Button
                disabled={!ready}
                loading={busy}
                onClick={async () => {
                  if (!target?.folderId || !source) return;
                  setBusy(true);
                  setError(null);
                  try {
                    const job = await api.post<ImportJob>('/cso/import-jobs', {
                      sourceFileId: source.id,
                      metadataFileId: metadata?.id,
                      targetFolderId: target.folderId,
                      defaultCategoryId: categoryId || undefined,
                    });
                    router.push(`/cso/import/${job.id}`);
                  } catch (e) {
                    setError(csoErrorMessage(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Analyser et prévisualiser
              </Button>
            </div>
          </div>
        </Panel>

        <Panel title="Mes imports" bodyClassName="p-0">
          {jobs.isLoading ? (
            <LoadingBlock rows={4} />
          ) : jobs.error ? (
            <ErrorState error={jobs.error} onRetry={() => jobs.refetch()} />
          ) : !jobs.data?.length ? (
            <EmptyState title="Aucun import" description="Vos imports précédents apparaîtront ici." />
          ) : (
            <ul className="divide-y divide-line">
              {jobs.data.map((j) => (
                <li key={j.id}>
                  <Link href={`/cso/import/${j.id}`} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm hover:bg-canvas">
                    <span className="font-medium text-navy">{fmtDateTime(j.createdAt)}</span>
                    <StatusBadge status={j.phase} labels={IMPORT_PHASE_LABELS} tones={{ COMMITTED: 'ok', PREVIEW_READY: 'warn', COMMITTING: 'info', MAPPING: 'info', UPLOADED: 'info' }} />
                    <StatusBadge status={j.status} labels={JOB_STATUS_LABELS} />
                    {j.summary && (
                      <span className="w-full text-xs text-ink-muted">
                        {j.summary.valid ?? 0} valide(s) · {j.summary.duplicatesSuspected ?? 0} doublon(s) · {j.summary.invalid ?? 0} invalide(s)
                        {j.summary.commit && ` — ${j.summary.commit.applied} appliqué(s)`}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        title="Dossier de destination de l'import"
        requiredActions={['folder_create', 'edit']}
        initialLibraryId={target?.library.id ?? null}
        confirmLabel="Choisir"
        onConfirm={(t) => {
          if (t.library.id !== target?.library.id) {
            setSource(null);
            setMetadata(null);
            setCategoryId('');
          }
          setTarget(t);
        }}
      />
    </>
  );
}
