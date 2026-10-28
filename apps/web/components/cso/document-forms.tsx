'use client';

import { RefreshCw } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtBytes } from '@/lib/format';
import { useSession } from '@/lib/session';
import { fileIcon, FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { CustomFieldInput, type FieldValue } from './custom-fields';
import { titleFromFileName, useCategoriesFor, useCategoryFields, useCsoRun } from './lib';
import type { CsoDocumentDetail, CsoLibrary, CsoVersion } from './types';
import { Notice } from './ui';

function UploadedFile({ file, onReplace }: { file: StoredFileDto; onReplace: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2">
      {fileIcon(file.kind)}
      <span className="min-w-0 flex-1 truncate text-sm" title={file.originalName}>
        {file.originalName}
      </span>
      <span className="text-xs tabular text-ink-muted">{fmtBytes(file.sizeBytes)}</span>
      <Button variant="ghost" size="sm" onClick={onReplace}>
        <RefreshCw className="h-4 w-4" aria-hidden /> Remplacer
      </Button>
    </div>
  );
}

function SubmitChoice({ submit, onChange }: { submit: boolean; onChange: (v: boolean) => void }) {
  return (
    <fieldset>
      <legend className="field-label">Après enregistrement</legend>
      <div className="space-y-1.5">
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="cso-submit" className="mt-0.5 h-4 w-4" checked={submit} onChange={() => onChange(true)} />
          <span>
            <span className="font-medium">Soumettre pour approbation</span>
            <span className="block text-xs text-ink-muted">Un validateur désigné (autre que vous) devra approuver avant publication.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="cso-submit" className="mt-0.5 h-4 w-4" checked={!submit} onChange={() => onChange(false)} />
          <span>
            <span className="font-medium">Garder en brouillon</span>
            <span className="block text-xs text-ink-muted">Vous pourrez la soumettre plus tard depuis la liste des versions.</span>
          </span>
        </label>
      </div>
    </fieldset>
  );
}

/**
 * Création d'un document : métadonnées + première version (CSO-005). Les champs standard
 * obligatoires et les champs personnalisés dépendent de la catégorie choisie.
 */
export function CreateDocumentDialog({
  open,
  onOpenChange,
  folder,
  library,
  initialFile,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  folder: { id: string; name: string };
  library: CsoLibrary;
  initialFile?: StoredFileDto | null;
  onCreated?: (doc: CsoDocumentDetail) => void;
}) {
  const { can } = useSession();
  const run = useCsoRun();
  const ids = { title: useId(), desc: useId(), cat: useId(), ref: useId(), review: useId(), expiry: useId(), note: useId() };
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [reference, setReference] = useState('');
  const [nextReviewOn, setNextReviewOn] = useState('');
  const [expiryOn, setExpiryOn] = useState('');
  const [changeNote, setChangeNote] = useState('');
  const [submit, setSubmit] = useState(true);
  const [custom, setCustom] = useState<Record<string, FieldValue>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const categories = useCategoriesFor(open ? library : null);
  const category = categories.data?.find((c) => c.id === categoryId) ?? null;
  const fields = useCategoryFields(categoryId || null);
  const required = useMemo(() => new Set(category?.requiredFields ?? []), [category]);
  const manualRef = !category || category.referenceMode === 'MANUAL';
  const canEditFields = can('cso.fields.edit');
  const activeFields = useMemo(() => (fields.data ?? []).filter((f) => !f.archived), [fields.data]);

  useEffect(() => {
    if (!open) return;
    setFile(initialFile ?? null);
    setTitle(initialFile ? titleFromFileName(initialFile.originalName) : '');
    setDescription('');
    setCategoryId('');
    setReference('');
    setNextReviewOn('');
    setExpiryOn('');
    setChangeNote('');
    setSubmit(true);
    setCustom({});
    setError(null);
  }, [open, initialFile]);

  const missing = useMemo(() => {
    const m: string[] = [];
    if (!file) m.push('fichier');
    if (!title.trim()) m.push('titre');
    if (required.has('description') && !description.trim()) m.push('description');
    if (required.has('nextReviewOn') && !nextReviewOn) m.push('prochaine révision');
    if (required.has('expiryOn') && !expiryOn) m.push('expiration');
    if (category?.referenceMode === 'MANUAL' && !reference.trim()) m.push('référence');
    if (required.has('reference') && manualRef && !reference.trim()) m.push('référence');
    if (canEditFields) activeFields.filter((f) => f.required && (custom[f.key] === undefined || custom[f.key] === null || custom[f.key] === '')).forEach((f) => m.push(f.label));
    return [...new Set(m)];
  }, [file, title, description, nextReviewOn, expiryOn, reference, category, required, manualRef, canEditFields, activeFields, custom]);

  async function save() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const customFields = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null && v !== ''));
      const doc = await run(
        () =>
          api.post<CsoDocumentDetail>('/cso/documents', {
            folderId: folder.id,
            title: title.trim(),
            description: description.trim() || null,
            categoryId: categoryId || null,
            reference: manualRef && reference.trim() ? reference.trim() : undefined,
            nextReviewOn: nextReviewOn || null,
            expiryOn: expiryOn || null,
            fileId: file.id,
            changeNote: changeNote.trim() || undefined,
            submit,
            customFields: canEditFields && Object.keys(customFields).length ? customFields : undefined,
          }),
        (d) => (submit ? `Document « ${d.title} » créé — version soumise pour approbation` : `Document « ${d.title} » créé en brouillon`),
      );
      onOpenChange(false);
      onCreated?.(doc);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Nouveau document"
      description={`Dans « ${folder.name} » — la première version suit le circuit d'approbation avant publication.`}
      size="lg"
      footer={
        <>
          {missing.length > 0 && <p className="mr-auto self-center text-xs text-ink-muted">À compléter : {missing.join(', ')}</p>}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy} disabled={missing.length > 0}>
            {submit ? 'Créer et soumettre' : 'Créer le brouillon'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <p className="field-label">
            Fichier<span className="ml-0.5 text-danger" aria-hidden>*</span>
          </p>
          {file ? (
            <UploadedFile file={file} onReplace={() => setFile(null)} />
          ) : (
            <FileUploader context="CSO_DOCUMENT" vesselId={library.vessel?.id ?? null} onUploaded={setFile} label="Déposer le fichier du document" />
          )}
        </div>
        <Field label="Titre" htmlFor={ids.title} required className="sm:col-span-2">
          <Input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
        </Field>
        <Field label="Catégorie" htmlFor={ids.cat} hint={categories.data?.length === 0 ? 'Aucune catégorie disponible pour cette bibliothèque.' : undefined}>
          <Select
            id={ids.cat}
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setCustom({});
            }}
          >
            <option value="">Sans catégorie</option>
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </Select>
        </Field>
        {manualRef ? (
          <Field
            label="Référence officielle"
            htmlFor={ids.ref}
            required={category?.referenceMode === 'MANUAL' || required.has('reference')}
            hint="Unique. Lettres, chiffres, . _ - / et espaces."
          >
            <Input id={ids.ref} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={120} />
          </Field>
        ) : (
          <div>
            <p className="field-label">Référence officielle</p>
            <p className="rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-muted">
              Générée automatiquement{category?.referenceFormat ? ` (format ${category.referenceFormat})` : ''}
            </p>
          </div>
        )}
        <Field label="Description" htmlFor={ids.desc} required={required.has('description')} className="sm:col-span-2">
          <Textarea id={ids.desc} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={10000} />
        </Field>
        <Field label="Prochaine révision" htmlFor={ids.review} required={required.has('nextReviewOn')}>
          <Input id={ids.review} type="date" value={nextReviewOn} onChange={(e) => setNextReviewOn(e.target.value)} />
        </Field>
        <Field label="Expiration" htmlFor={ids.expiry} required={required.has('expiryOn')}>
          <Input id={ids.expiry} type="date" value={expiryOn} onChange={(e) => setExpiryOn(e.target.value)} />
        </Field>
        {categoryId && activeFields.length > 0 && (
          <fieldset className="rounded-md border border-line p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-semibold text-navy">Champs de la catégorie</legend>
            {canEditFields ? (
              <div className="grid gap-3 sm:grid-cols-2">
                {activeFields.map((f) => (
                  <CustomFieldInput key={f.id} field={f} value={custom[f.key]} onChange={(v) => setCustom((p) => ({ ...p, [f.key]: v }))} />
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Vous n&apos;avez pas le droit de renseigner les champs personnalisés : ils pourront être complétés par une personne habilitée.</p>
            )}
          </fieldset>
        )}
        <Field label="Note de version" htmlFor={ids.note} className="sm:col-span-2" hint="Facultatif — visible des validateurs.">
          <Input id={ids.note} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={1000} />
        </Field>
        <div className="sm:col-span-2">
          <SubmitChoice submit={submit} onChange={setSubmit} />
        </div>
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Nouvelle version : l'officielle actuelle reste publiée tant que la nouvelle n'est pas approuvée (CSO-007). */
export function NewVersionDialog({ open, onOpenChange, doc }: { open: boolean; onOpenChange: (o: boolean) => void; doc: Pick<CsoDocumentDetail, 'id' | 'title' | 'vesselId' | 'currentVersion'> }) {
  const run = useCsoRun();
  const noteId = useId();
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [changeNote, setChangeNote] = useState('');
  const [submit, setSubmit] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFile(null);
      setChangeNote('');
      setSubmit(true);
      setError(null);
    }
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Nouvelle version"
      description={doc.title}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            disabled={!file}
            loading={busy}
            onClick={async () => {
              if (!file) return;
              setBusy(true);
              setError(null);
              try {
                await run(
                  () => api.post<CsoVersion>(`/cso/documents/${doc.id}/versions`, { fileId: file.id, changeNote: changeNote.trim() || undefined, submit }),
                  (v) => `Version ${v.versionNo} ${submit ? 'soumise pour approbation' : 'enregistrée en brouillon'}`,
                );
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {submit ? 'Déposer et soumettre' : 'Déposer en brouillon'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {doc.currentVersion && (
          <Notice tone="info">La version officielle actuelle (v{doc.currentVersion.versionNo}) reste publiée et consultable pendant la validation.</Notice>
        )}
        {file ? (
          <UploadedFile file={file} onReplace={() => setFile(null)} />
        ) : (
          <FileUploader context="CSO_DOCUMENT" vesselId={doc.vesselId} onUploaded={setFile} label="Déposer le fichier de la nouvelle version" />
        )}
        <Field label="Note de version" htmlFor={noteId} hint="Ce qui change par rapport à la version précédente.">
          <Textarea id={noteId} rows={2} value={changeNote} onChange={(e) => setChangeNote(e.target.value)} maxLength={1000} />
        </Field>
        <SubmitChoice submit={submit} onChange={setSubmit} />
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}

/** Édition des métadonnées (titre, description, dates, champs) — verrou optimiste sur updatedAt. */
export function EditDocumentDialog({ open, onOpenChange, doc }: { open: boolean; onOpenChange: (o: boolean) => void; doc: CsoDocumentDetail }) {
  const run = useCsoRun();
  const { can } = useSession();
  const ids = { title: useId(), desc: useId(), review: useId(), expiry: useId(), cat: useId() };
  const [title, setTitle] = useState(doc.title);
  const [description, setDescription] = useState(doc.description ?? '');
  const [nextReviewOn, setNextReviewOn] = useState(doc.nextReviewOn ?? '');
  const [expiryOn, setExpiryOn] = useState(doc.expiryOn ?? '');
  const [categoryId, setCategoryId] = useState(doc.category?.id ?? '');
  const [custom, setCustom] = useState<Record<string, FieldValue>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const categories = useCategoriesFor(open ? doc.library : null);
  const categoryChanged = categoryId !== (doc.category?.id ?? '');
  const newFields = useCategoryFields(categoryChanged && categoryId ? categoryId : null);
  const category = categories.data?.find((c) => c.id === categoryId) ?? null;
  const required = new Set(category?.requiredFields ?? []);

  useEffect(() => {
    if (!open) return;
    setTitle(doc.title);
    setDescription(doc.description ?? '');
    setNextReviewOn(doc.nextReviewOn ?? '');
    setExpiryOn(doc.expiryOn ?? '');
    setCategoryId(doc.category?.id ?? '');
    setCustom(Object.fromEntries(doc.customFields.filter((f) => f.canEdit && !f.archived).map((f) => [f.key, f.value])));
    setError(null);
  }, [open, doc]);

  const editableFields = categoryChanged
    ? (newFields.data ?? []).filter((f) => !f.archived)
    : doc.customFields.filter((f) => f.canEdit && !f.archived);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Modifier les informations"
      description="Les modifications sont journalisées avec le détail avant / après."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            loading={busy}
            disabled={!title.trim()}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const original = Object.fromEntries(doc.customFields.map((f) => [f.key, f.value]));
                const changed = Object.fromEntries(
                  Object.entries(custom).filter(([k, v]) => categoryChanged || JSON.stringify(v ?? null) !== JSON.stringify(original[k] ?? null)),
                );
                await run(
                  () =>
                    api.patch(`/cso/documents/${doc.id}`, {
                      title: title.trim(),
                      description: description.trim() || null,
                      nextReviewOn: nextReviewOn || null,
                      expiryOn: expiryOn || null,
                      ...(categoryChanged ? { categoryId: categoryId || null } : {}),
                      customFields: can('cso.fields.edit') && Object.keys(changed).length ? changed : undefined,
                      expectedUpdatedAt: doc.updatedAt,
                    }),
                  'Informations enregistrées',
                );
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Titre" htmlFor={ids.title} required className="sm:col-span-2">
          <Input id={ids.title} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
        </Field>
        <Field label="Catégorie" htmlFor={ids.cat} hint="La référence officielle ne change pas ; utilisez « Changer la référence » si nécessaire.">
          <Select id={ids.cat} value={categoryId} onChange={(e) => { setCategoryId(e.target.value); setCustom({}); }}>
            <option value="">Sans catégorie</option>
            {doc.category && !categories.data?.some((c) => c.id === doc.category?.id) && <option value={doc.category.id}>{doc.category.name} (inactive)</option>}
            {categories.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.code})
              </option>
            ))}
          </Select>
        </Field>
        <div />
        <Field label="Description" htmlFor={ids.desc} required={required.has('description')} className="sm:col-span-2">
          <Textarea id={ids.desc} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Prochaine révision" htmlFor={ids.review} required={required.has('nextReviewOn')}>
          <Input id={ids.review} type="date" value={nextReviewOn} onChange={(e) => setNextReviewOn(e.target.value)} />
        </Field>
        <Field label="Expiration" htmlFor={ids.expiry} required={required.has('expiryOn')}>
          <Input id={ids.expiry} type="date" value={expiryOn} onChange={(e) => setExpiryOn(e.target.value)} />
        </Field>
        {can('cso.fields.edit') && editableFields.length > 0 && (
          <fieldset className="rounded-md border border-line p-3 sm:col-span-2">
            <legend className="px-1 text-sm font-semibold text-navy">Champs personnalisés modifiables</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {editableFields.map((f) => (
                <CustomFieldInput
                  key={f.key}
                  field={{ ...f, options: f.options ?? null }}
                  value={custom[f.key]}
                  onChange={(v) => setCustom((p) => ({ ...p, [f.key]: v }))}
                />
              ))}
            </div>
          </fieldset>
        )}
        {error && (
          <div className="sm:col-span-2">
            <Notice tone="danger">{error}</Notice>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** Demande de changement de référence officielle : approbation distincte, l'ancienne reste active (CSO-027). */
export function ReferenceChangeDialog({ open, onOpenChange, doc }: { open: boolean; onOpenChange: (o: boolean) => void; doc: Pick<CsoDocumentDetail, 'id' | 'reference'> }) {
  const run = useCsoRun();
  const ids = { ref: useId(), reason: useId() };
  const [newReference, setNewReference] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setNewReference('');
      setReason('');
      setError(null);
    }
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Changer la référence officielle"
      description={`Référence actuelle : ${doc.reference ?? 'aucune'}`}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            loading={busy}
            disabled={!newReference.trim() || reason.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(() => api.post(`/cso/documents/${doc.id}/reference-change`, { newReference: newReference.trim(), reason: reason.trim() }), 'Demande de changement de référence envoyée aux validateurs');
                onOpenChange(false);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Demander le changement
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice tone="info">L&apos;ancienne référence reste active jusqu&apos;à l&apos;approbation par un autre validateur.</Notice>
        <Field label="Nouvelle référence" htmlFor={ids.ref} required>
          <Input id={ids.ref} value={newReference} onChange={(e) => setNewReference(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Motif" htmlFor={ids.reason} required hint="Obligatoire — conservé dans le journal d'audit.">
          <Textarea id={ids.reason} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </Field>
        {error && <Notice tone="danger">{error}</Notice>}
      </div>
    </Dialog>
  );
}
