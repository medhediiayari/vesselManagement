'use client';

import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, KeyRound, Lock, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import { useCsoRun } from '@/components/cso/lib';
import { PrincipalName, PrincipalPicker } from '@/components/cso/principal-picker';
import {
  FIELD_TYPE_LABELS,
  STANDARD_FIELD_LABELS,
  STANDARD_FIELDS,
  type CsoCategory,
  type CsoFieldDefinition,
  type PrincipalType,
} from '@/components/cso/types';
import { Notice } from '@/components/cso/ui';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';

const TOKEN_RE = /\{([A-Z]+)(?::(\d{1,2}))?\}/g;

/** Contrôle indicatif du format de référence (le serveur reste l'autorité). */
function formatError(f: string): string | null {
  const tokens = [...f.matchAll(TOKEN_RE)];
  for (const t of tokens) {
    if (!['CAT', 'VESSEL', 'YYYY', 'SEQ'].includes(t[1])) return `Jeton inconnu {${t[1]}}`;
    if (t[2] !== undefined && t[1] !== 'SEQ') return `Le jeton {${t[1]}} n'accepte pas de longueur`;
  }
  if (tokens.filter((t) => t[1] === 'SEQ').length !== 1) return 'Le format doit contenir exactement un jeton {SEQ} ou {SEQ:n}';
  if (!/^[A-Za-z0-9._\-/ ]*$/.test(f.replace(TOKEN_RE, ''))) return 'Caractères autorisés : A-Z 0-9 . _ - / espace';
  return null;
}

function formatExample(f: string, code: string, vessel: string): string {
  return f.replace(TOKEN_RE, (_m, t: string, len?: string) =>
    t === 'CAT' ? code || 'CAT' : t === 'VESSEL' ? vessel : t === 'YYYY' ? String(new Date().getFullYear()) : t === 'SEQ' ? '1'.padStart(len ? Number(len) : 4, '0') : '',
  );
}

interface CategoryForm {
  code: string;
  name: string;
  scope: 'FLEET' | 'VESSEL';
  vesselId: string;
  referenceMode: 'AUTO' | 'MANUAL';
  referenceFormat: string;
  requiredFields: string[];
  sortOrder: number;
}

function CategoryFields({ form, setForm, creating }: { form: CategoryForm; setForm: (f: CategoryForm) => void; creating: boolean }) {
  const { me } = useSession();
  const ids = { code: useId(), name: useId(), scope: useId(), vessel: useId(), mode: useId(), fmt: useId(), sort: useId() };
  const fmtErr = form.referenceMode === 'AUTO' ? (form.referenceFormat ? formatError(form.referenceFormat) : 'Format requis en mode automatique') : form.referenceFormat ? formatError(form.referenceFormat) : null;
  const vesselCode = form.scope === 'VESSEL' ? me.accessibleVessels.find((v) => v.id === form.vesselId)?.code ?? 'NAV' : 'ISK';
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Code" htmlFor={ids.code} required={creating} hint={creating ? '2 à 40 caractères A-Z 0-9 _ -' : 'Non modifiable'}>
        <Input id={ids.code} value={form.code} disabled={!creating} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} maxLength={40} />
      </Field>
      <Field label="Nom" htmlFor={ids.name} required>
        <Input id={ids.name} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={200} />
      </Field>
      <Field label="Portée" htmlFor={ids.scope} hint={creating ? undefined : 'Non modifiable'}>
        <Select id={ids.scope} value={form.scope} disabled={!creating} onChange={(e) => setForm({ ...form, scope: e.target.value as 'FLEET' | 'VESSEL', vesselId: '' })}>
          <option value="FLEET">Toute la flotte</option>
          <option value="VESSEL">Un navire</option>
        </Select>
      </Field>
      {form.scope === 'VESSEL' ? (
        <Field label="Navire" htmlFor={ids.vessel} required={creating}>
          <Select id={ids.vessel} value={form.vesselId} disabled={!creating} onChange={(e) => setForm({ ...form, vesselId: e.target.value })}>
            <option value="">Choisir…</option>
            {me.accessibleVessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.code})
              </option>
            ))}
          </Select>
        </Field>
      ) : (
        <div />
      )}
      <Field label="Mode de référence" htmlFor={ids.mode}>
        <Select id={ids.mode} value={form.referenceMode} onChange={(e) => setForm({ ...form, referenceMode: e.target.value as 'AUTO' | 'MANUAL' })}>
          <option value="AUTO">Automatique (format)</option>
          <option value="MANUAL">Manuelle (saisie)</option>
        </Select>
      </Field>
      <Field
        label="Format de référence"
        htmlFor={ids.fmt}
        required={form.referenceMode === 'AUTO'}
        error={form.referenceFormat || form.referenceMode === 'AUTO' ? fmtErr ?? undefined : undefined}
        hint={
          <>
            Jetons : {'{CAT}'} {'{VESSEL}'} {'{YYYY}'} {'{SEQ:n}'}
            {form.referenceFormat && !fmtErr && <span className="block">Exemple : <span className="font-mono">{formatExample(form.referenceFormat, form.code, vesselCode)}</span></span>}
          </>
        }
      >
        <Input id={ids.fmt} value={form.referenceFormat} onChange={(e) => setForm({ ...form, referenceFormat: e.target.value })} className="font-mono" maxLength={120} placeholder="CSO-{CAT}-{VESSEL}-{YYYY}-{SEQ:4}" />
      </Field>
      <fieldset className="sm:col-span-2">
        <legend className="field-label">Champs standard obligatoires</legend>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {STANDARD_FIELDS.map((f) => (
            <Checkbox
              key={f}
              label={STANDARD_FIELD_LABELS[f]}
              checked={form.requiredFields.includes(f)}
              onChange={(e) => setForm({ ...form, requiredFields: e.target.checked ? [...form.requiredFields, f] : form.requiredFields.filter((x) => x !== f) })}
            />
          ))}
        </div>
        <p className="field-hint">Socle minimal : titre et fichier sont toujours obligatoires.</p>
      </fieldset>
      <Field label="Ordre d'affichage" htmlFor={ids.sort}>
        <Input id={ids.sort} type="number" min={0} max={10000} value={form.sortOrder} onChange={(e) => setForm({ ...form, sortOrder: Number(e.target.value) || 0 })} />
      </Field>
    </div>
  );
}

function formValid(f: CategoryForm, creating: boolean) {
  if (f.name.trim().length < 2) return false;
  if (creating && !/^[A-Z0-9_-]{2,40}$/.test(f.code.trim())) return false;
  if (creating && f.scope === 'VESSEL' && !f.vesselId) return false;
  if (f.referenceMode === 'AUTO' && (!f.referenceFormat || formatError(f.referenceFormat))) return false;
  if (f.referenceMode === 'MANUAL' && f.referenceFormat && formatError(f.referenceFormat)) return false;
  return true;
}

function FieldDialog({ open, onOpenChange, categoryId, field }: { open: boolean; onOpenChange: (o: boolean) => void; categoryId: string; field: CsoFieldDefinition | null }) {
  const run = useCsoRun();
  const ids = { key: useId(), label: useId(), type: useId(), options: useId(), sort: useId() };
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CsoFieldDefinition['type']>('TEXT');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [confidential, setConfidential] = useState(false);
  const [sortOrder, setSortOrder] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setKey(field?.key ?? '');
    setLabel(field?.label ?? '');
    setType(field?.type ?? 'TEXT');
    setOptions((field?.options ?? []).join('\n'));
    setRequired(field?.required ?? false);
    setConfidential(field?.isConfidential ?? false);
    setSortOrder(field?.sortOrder ?? 0);
    setError(null);
  }, [open, field]);
  const opts = options.split('\n').map((o) => o.trim()).filter(Boolean);
  const valid = label.trim().length > 0 && (field || /^[a-z][a-z0-9_]{1,63}$/.test(key)) && (type !== 'SELECT' || opts.length > 0);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={field ? `Modifier le champ « ${field.label} »` : 'Nouveau champ personnalisé'}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const body = { label: label.trim(), options: type === 'SELECT' ? opts : undefined, required, isConfidential: confidential, sortOrder };
                if (field) await run(() => api.patch(`/cso/fields/${field.id}`, body), 'Champ mis à jour');
                else await run(() => api.post(`/cso/categories/${categoryId}/fields`, { ...body, key, type }), 'Champ créé');
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
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Clé technique" htmlFor={ids.key} required={!field} hint={field ? 'Non modifiable' : 'minuscules, chiffres, _ (ex. niveau_surete)'}>
          <Input id={ids.key} value={key} disabled={!!field} onChange={(e) => setKey(e.target.value)} className="font-mono" maxLength={64} />
        </Field>
        <Field label="Libellé" htmlFor={ids.label} required>
          <Input id={ids.label} value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
        </Field>
        <Field label="Type" htmlFor={ids.type} hint={field ? 'Non modifiable' : undefined}>
          <Select id={ids.type} value={type} disabled={!!field} onChange={(e) => setType(e.target.value as CsoFieldDefinition['type'])}>
            {Object.entries(FIELD_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Ordre" htmlFor={ids.sort}>
          <Input id={ids.sort} type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value) || 0)} />
        </Field>
        {type === 'SELECT' && (
          <Field label="Choix (un par ligne)" htmlFor={ids.options} required className="sm:col-span-2" hint={field ? 'Une valeur utilisée par des documents ne peut pas être retirée.' : undefined}>
            <Textarea id={ids.options} rows={4} value={options} onChange={(e) => setOptions(e.target.value)} />
          </Field>
        )}
        <div className="space-y-2 sm:col-span-2">
          <Checkbox label="Obligatoire" description="Exigé à la création pour les personnes autorisées à le renseigner." checked={required} onChange={(e) => setRequired(e.target.checked)} />
          <Checkbox
            label="Confidentiel"
            description="Jamais renvoyé aux personnes qui voient le document sans droit sur ce champ (permission « champs confidentiels » ou ACL de champ)."
            checked={confidential}
            onChange={(e) => setConfidential(e.target.checked)}
          />
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

interface FieldAclEntry {
  principalType: PrincipalType;
  principalId: string;
  principalLabel?: string | null;
  canView: boolean;
  canEdit: boolean;
}

function FieldAclDialog({ open, onOpenChange, field }: { open: boolean; onOpenChange: (o: boolean) => void; field: CsoFieldDefinition }) {
  const run = useCsoRun();
  const q = useQuery({ queryKey: ['cso', 'field-acl', field.id], queryFn: () => api.get<FieldAclEntry[]>(`/cso/fields/${field.id}/acl`), enabled: open });
  const [entries, setEntries] = useState<FieldAclEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && open) {
      setEntries(q.data.map((e) => ({ ...e })));
      setError(null);
    }
  }, [q.data, open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Accès au champ « ${field.label} »`}
      description="Visibilité et modification séparées par utilisateur, rôle ou département (CSO-031/032)."
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(
                  () => api.put(`/cso/fields/${field.id}/acl`, { entries: entries.map((e) => ({ principalType: e.principalType, principalId: e.principalId, canView: e.canView || e.canEdit, canEdit: e.canEdit })) }),
                  'Accès au champ mis à jour',
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
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <div className="space-y-3">
          <Notice tone="info">
            Sans règle, le champ suit les droits du document{field.isConfidential ? ' — étant confidentiel, il reste réservé aux titulaires de la permission « champs confidentiels »' : ''}.
          </Notice>
          {entries.length === 0 ? (
            <p className="text-sm text-ink-muted">Aucune règle spécifique.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {entries.map((e, i) => (
                <li key={`${e.principalType}:${e.principalId}`} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <PrincipalName type={e.principalType} id={e.principalId} label={e.principalLabel} />
                  </span>
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={e.canView || e.canEdit} disabled={e.canEdit} onChange={(ev) => setEntries((p) => p.map((x, j) => (j === i ? { ...x, canView: ev.target.checked } : x)))} />
                    Voir
                  </label>
                  <label className="inline-flex items-center gap-1.5">
                    <input type="checkbox" checked={e.canEdit} onChange={(ev) => setEntries((p) => p.map((x, j) => (j === i ? { ...x, canEdit: ev.target.checked, canView: x.canView || ev.target.checked } : x)))} />
                    Modifier
                  </label>
                  <IconButton label="Retirer cette règle" onClick={() => setEntries((p) => p.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ul>
          )}
          <PrincipalPicker
            exclude={entries.map((e) => `${e.principalType}:${e.principalId}`)}
            onAdd={(p) => setEntries((prev) => [...prev, { principalType: p.principalType, principalId: p.principalId, principalLabel: p.label, canView: true, canEdit: false }])}
          />
          {error && <Notice tone="danger">{error}</Notice>}
        </div>
      )}
    </Dialog>
  );
}

function CategoryEditor({ category }: { category: CsoCategory }) {
  const run = useCsoRun();
  const { vesselById } = useSession();
  const toForm = (c: CsoCategory): CategoryForm => ({
    code: c.code,
    name: c.name,
    scope: c.scope,
    vesselId: c.vesselId ?? '',
    referenceMode: c.referenceMode,
    referenceFormat: c.referenceFormat ?? '',
    requiredFields: c.requiredFields,
    sortOrder: c.sortOrder,
  });
  const [form, setForm] = useState<CategoryForm>(toForm(category));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toggling, setToggling] = useState(false);
  const [fieldDialog, setFieldDialog] = useState<{ field: CsoFieldDefinition | null } | null>(null);
  const [aclField, setAclField] = useState<CsoFieldDefinition | null>(null);
  const [archiving, setArchiving] = useState<CsoFieldDefinition | null>(null);
  useEffect(() => setForm(toForm(category)), [category]);
  const fields = useQuery({
    queryKey: ['cso', 'category-fields', category.id, 'all'],
    queryFn: () => api.get<CsoFieldDefinition[]>(`/cso/categories/${category.id}/fields`, { query: { includeArchived: true } }),
  });
  const original = toForm(category);
  const dirty = JSON.stringify(form) !== JSON.stringify(original);

  return (
    <div className="space-y-5">
      <Panel
        title={
          <span className="flex flex-wrap items-center gap-2">
            {category.name}
            {!category.isActive && <Badge tone="neutral">Désactivée</Badge>}
          </span>
        }
        actions={
          <>
            <Button variant="ghost" size="sm" onClick={() => setToggling(true)}>
              <Power className="h-4 w-4" aria-hidden /> {category.isActive ? 'Désactiver' : 'Réactiver'}
            </Button>
            <Button
              size="sm"
              disabled={!dirty || !formValid(form, false)}
              loading={saving}
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  await run(
                    () =>
                      api.patch(`/cso/categories/${category.id}`, {
                        name: form.name.trim(),
                        referenceMode: form.referenceMode,
                        referenceFormat: form.referenceFormat.trim() || null,
                        requiredFields: form.requiredFields,
                        sortOrder: form.sortOrder,
                      }),
                    'Catégorie enregistrée',
                  );
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Enregistrer
            </Button>
          </>
        }
      >
        <CategoryFields form={form} setForm={setForm} creating={false} />
        {category.scope === 'VESSEL' && <p className="mt-2 text-xs text-ink-muted">Catégorie propre au navire {vesselById(category.vesselId)?.name ?? category.vesselId}.</p>}
        {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
      </Panel>

      <Panel
        title="Champs personnalisés"
        bodyClassName="p-0"
        actions={
          <Button size="sm" variant="secondary" onClick={() => setFieldDialog({ field: null })}>
            <Plus className="h-4 w-4" aria-hidden /> Nouveau champ
          </Button>
        }
      >
        {fields.isLoading ? (
          <LoadingBlock rows={3} />
        ) : fields.error ? (
          <ErrorState error={fields.error} onRetry={() => fields.refetch()} />
        ) : !fields.data?.length ? (
          <EmptyState title="Aucun champ" description="Ajoutez des champs texte, nombre, date, liste ou oui/non propres à cette catégorie." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Libellé</th>
                  <th scope="col">Type</th>
                  <th scope="col">Règles</th>
                  <th scope="col" className="hidden md:table-cell">Accès</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {fields.data.map((f) => (
                  <tr key={f.id} className={cn(f.archived && 'text-ink-muted')}>
                    <td>
                      <span className="font-medium">{f.label}</span>
                      <span className="block font-mono text-xs text-ink-soft">{f.key}</span>
                    </td>
                    <td>
                      {FIELD_TYPE_LABELS[f.type] ?? f.type}
                      {f.type === 'SELECT' && f.options && <span className="block max-w-[220px] truncate text-xs text-ink-muted">{f.options.join(' · ')}</span>}
                    </td>
                    <td>
                      <span className="flex flex-wrap gap-1">
                        {f.required && <Badge tone="info" icon={false}>Obligatoire</Badge>}
                        {f.isConfidential && <Badge tone="warn" icon={<Lock className="h-3 w-3" aria-hidden />}>Confidentiel</Badge>}
                        {f.archived && <Badge tone="neutral" icon={<Archive className="h-3 w-3" aria-hidden />}>Archivé</Badge>}
                        {!f.required && !f.isConfidential && !f.archived && <span className="text-ink-soft">—</span>}
                      </span>
                    </td>
                    <td className="hidden md:table-cell">{f.aclEntryCount ? `${f.aclEntryCount} règle(s)` : 'Droits du document'}</td>
                    <td>
                      <span className="flex justify-end gap-1">
                        {!f.archived && (
                          <IconButton label={`Modifier ${f.label}`} onClick={() => setFieldDialog({ field: f })}>
                            <Pencil className="h-4 w-4" />
                          </IconButton>
                        )}
                        <IconButton label={`Accès au champ ${f.label}`} onClick={() => setAclField(f)}>
                          <KeyRound className="h-4 w-4" />
                        </IconButton>
                        <IconButton label={f.archived ? `Réactiver ${f.label}` : `Archiver ${f.label}`} onClick={() => setArchiving(f)}>
                          {f.archived ? <ArchiveRestore className="h-4 w-4" /> : <Archive className="h-4 w-4" />}
                        </IconButton>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {fieldDialog && <FieldDialog open onOpenChange={(o) => !o && setFieldDialog(null)} categoryId={category.id} field={fieldDialog.field} />}
      {aclField && <FieldAclDialog open onOpenChange={(o) => !o && setAclField(null)} field={aclField} />}
      <ConfirmDialog
        open={toggling}
        onOpenChange={setToggling}
        title={category.isActive ? 'Désactiver la catégorie ?' : 'Réactiver la catégorie ?'}
        description={
          category.isActive
            ? 'Elle ne sera plus proposée pour les nouveaux documents. Les documents existants et leurs valeurs sont conservés.'
            : 'Elle sera de nouveau proposée pour les nouveaux documents.'
        }
        confirmLabel={category.isActive ? 'Désactiver' : 'Réactiver'}
        tone={category.isActive ? 'danger' : 'primary'}
        onConfirm={async () => {
          await run(() => api.post(`/cso/categories/${category.id}/${category.isActive ? 'deactivate' : 'reactivate'}`), category.isActive ? 'Catégorie désactivée' : 'Catégorie réactivée');
        }}
      />
      <ConfirmDialog
        open={!!archiving}
        onOpenChange={(o) => !o && setArchiving(null)}
        title={archiving?.archived ? `Réactiver « ${archiving?.label} » ?` : `Archiver « ${archiving?.label ?? ''} » ?`}
        description={
          archiving?.archived
            ? 'Le champ redevient saisissable.'
            : 'Le champ n’est jamais supprimé : les valeurs existantes sont conservées et restent consultables en lecture seule.'
        }
        confirmLabel={archiving?.archived ? 'Réactiver' : 'Archiver'}
        onConfirm={async () => {
          await run(() => api.post(`/cso/fields/${archiving!.id}/${archiving!.archived ? 'reactivate' : 'archive'}`), archiving!.archived ? 'Champ réactivé' : 'Champ archivé');
        }}
      />
    </div>
  );
}

const EMPTY_FORM: CategoryForm = { code: '', name: '', scope: 'FLEET', vesselId: '', referenceMode: 'AUTO', referenceFormat: 'CSO-{CAT}-{VESSEL}-{YYYY}-{SEQ:3}', requiredFields: ['description'], sortOrder: 0 };

/** /cso/categories — catégories, références, champs standard et personnalisés, ACL de champ (CSO-026..032). */
export default function CsoCategoriesPage() {
  const { can, vesselById } = useSession();
  const run = useCsoRun();
  const list = useQuery({
    queryKey: ['cso', 'categories', 'manage'],
    queryFn: () => api.get<CsoCategory[]>('/cso/categories', { query: { includeInactive: true } }),
    enabled: can('cso.categories.manage'),
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<CategoryForm>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!can('cso.categories.manage')) return <Forbidden message="La gestion des catégories CSO requiert la permission « Gérer catégories, références et champs »." />;
  const selected = list.data?.find((c) => c.id === selectedId) ?? list.data?.[0] ?? null;

  return (
    <>
      <CsoPageHeader
        section="categories"
        title="Catégories CSO"
        description="Catégories de la flotte ou d'un navire, politique de référence (automatique ou manuelle), champs standard obligatoires et champs personnalisés avec visibilité par utilisateur, rôle ou département."
        breadcrumb={[{ label: 'Documents CSO', href: '/cso' }, { label: 'Catégories' }]}
      />
      {list.isLoading ? (
        <LoadingBlock rows={8} />
      ) : list.error ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
          <nav aria-label="Catégories" className="panel h-fit p-1">
            <div className="p-2">
              <Button
                className="w-full"
                size="sm"
                onClick={() => {
                  setForm(EMPTY_FORM);
                  setError(null);
                  setCreating(true);
                }}
              >
                <Plus className="h-4 w-4" aria-hidden /> Nouvelle catégorie
              </Button>
            </div>
            {!list.data?.length && <p className="px-3 py-2 text-sm text-ink-muted">Aucune catégorie.</p>}
            <ul>
              {list.data?.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(c.id)}
                    aria-current={selected?.id === c.id ? 'true' : undefined}
                    className={cn('flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-navy-50', selected?.id === c.id && 'bg-action-50 font-medium text-navy', !c.isActive && 'text-ink-muted')}
                  >
                    <span className="min-w-0">
                      <span className="block truncate">{c.name}</span>
                      <span className="block text-xs text-ink-soft">
                        {c.code} · {c.scope === 'FLEET' ? 'Flotte' : vesselById(c.vesselId)?.code ?? 'Navire'} · {c.referenceMode === 'AUTO' ? 'Réf. auto' : 'Réf. manuelle'}
                      </span>
                    </span>
                    {!c.isActive ? (
                      <Badge tone="neutral" icon={false}>Inactive</Badge>
                    ) : (
                      <span className="text-xs tabular text-ink-muted" title="Champs actifs">{c.activeFieldCount ?? 0}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </nav>
          {selected ? <CategoryEditor key={selected.id} category={selected} /> : <EmptyState title="Aucune catégorie" description="Créez une première catégorie documentaire." />}
        </div>
      )}
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Nouvelle catégorie"
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Annuler
            </Button>
            <Button
              disabled={!formValid(form, true)}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  const c = await run(
                    () =>
                      api.post<CsoCategory>('/cso/categories', {
                        code: form.code.trim(),
                        name: form.name.trim(),
                        scope: form.scope,
                        vesselId: form.scope === 'VESSEL' ? form.vesselId : null,
                        referenceMode: form.referenceMode,
                        referenceFormat: form.referenceFormat.trim() || null,
                        requiredFields: form.requiredFields,
                        sortOrder: form.sortOrder,
                      }),
                    (r) => `Catégorie « ${r.name} » créée`,
                  );
                  setSelectedId(c.id);
                  setCreating(false);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Créer
            </Button>
          </>
        }
      >
        <CategoryFields form={form} setForm={setForm} creating />
        {error && <Notice tone="danger" className="mt-3">{error}</Notice>}
      </Dialog>
    </>
  );
}
