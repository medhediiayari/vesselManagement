'use client';

import { PERMISSIONS } from '@amc/types';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { ApiError, api, errorMessage } from '@/lib/api';
import { CUSTOM_FIELD_TYPE_LABELS, type CustomFieldType, type FieldDefinition, type FieldSection } from './types';

/** Permissions utilisables pour la visibilité / l'édition d'un champ : module Members uniquement (ADM-037). */
export const MEMBER_PERMISSIONS = PERMISSIONS.filter((p) => p.module === 'members');

export function permissionLabel(key: string | null, fallback: string): string {
  if (!key) return fallback;
  return MEMBER_PERMISSIONS.find((p) => p.key === key)?.label ?? key;
}

function slugify(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[a-z]/.test(s) ? s : s ? `f_${s}`.slice(0, 64) : '';
}

export function SectionDialog({
  open,
  onOpenChange,
  section,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  section: FieldSection | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setName(section?.name ?? '');
  }, [open, section]);
  const save = async () => {
    setBusy(true);
    try {
      if (section) await api.patch(`/members/custom-fields/sections/${section.id}`, { name: name.trim() });
      else await api.post('/members/custom-fields/sections', { name: name.trim() });
      toast.success(section ? 'Section renommée' : 'Section créée');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={section ? 'Renommer la section' : 'Nouvelle section'}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy} disabled={name.trim().length < 2}>
            Enregistrer
          </Button>
        </>
      }
    >
      <Field label="Nom de la section" required htmlFor="section-name" hint="2 à 120 caractères, ex. « Tailles et équipements »">
        <Input id="section-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}

interface FieldForm {
  key: string;
  label: string;
  type: CustomFieldType;
  choices: string;
  multiple: boolean;
  required: boolean;
  sectionId: string;
  viewPermission: string;
  editPermission: string;
  selfEditable: boolean;
}

export function FieldDialog({
  open,
  onOpenChange,
  field,
  sections,
  defaultSectionId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  field: FieldDefinition | null;
  sections: FieldSection[];
  defaultSectionId?: string | null;
  onSaved: () => void;
}) {
  const [f, setF] = useState<FieldForm>({
    key: '',
    label: '',
    type: 'TEXT',
    choices: '',
    multiple: false,
    required: false,
    sectionId: '',
    viewPermission: '',
    editPermission: '',
    selfEditable: false,
  });
  const [keyTouched, setKeyTouched] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setErrors({});
    setKeyTouched(!!field);
    setF({
      key: field?.key ?? '',
      label: field?.label ?? '',
      type: field?.type ?? 'TEXT',
      choices: field?.options?.choices?.join('\n') ?? '',
      multiple: !!field?.options?.multiple,
      required: field?.required ?? false,
      sectionId: field ? field.sectionId ?? '' : defaultSectionId ?? '',
      viewPermission: field?.viewPermission ?? '',
      editPermission: field?.editPermission ?? '',
      selfEditable: field?.selfEditable ?? false,
    });
  }, [open, field, defaultSectionId]);

  const set = <K extends keyof FieldForm>(k: K, v: FieldForm[K]) => setF((p) => ({ ...p, [k]: v }));
  const choices = f.choices
    .split('\n')
    .map((c) => c.trim())
    .filter(Boolean);
  const keyValid = /^[a-z][a-z0-9_]{1,63}$/.test(f.key);
  const dupChoices = choices.length !== new Set(choices).size;
  const valid = f.label.trim().length >= 2 && (field || keyValid) && (f.type !== 'SELECT' || (choices.length > 0 && !dupChoices));

  const save = async () => {
    setBusy(true);
    setErrors({});
    const options = f.type === 'SELECT' ? { choices, ...(f.multiple ? { multiple: true } : {}) } : null;
    const common = {
      sectionId: f.sectionId || null,
      label: f.label.trim(),
      required: f.required,
      viewPermission: f.viewPermission || null,
      editPermission: f.editPermission || null,
      selfEditable: f.selfEditable,
    };
    try {
      if (field) {
        await api.patch(`/members/custom-fields/fields/${field.id}`, { ...common, ...(field.type === 'SELECT' ? { options } : {}) });
      } else {
        await api.post('/members/custom-fields/fields', { ...common, key: f.key, type: f.type, ...(options ? { options } : {}) });
      }
      toast.success(field ? 'Champ mis à jour' : 'Champ créé');
      onOpenChange(false);
      onSaved();
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        const d = (e.details ?? {}) as { choices?: string[] };
        if (Array.isArray(d.choices)) setErrors((x) => ({ ...x, options: `Choix encore utilisés : ${d.choices!.join(', ')}` }));
      }
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const activeSections = sections.filter((s) => !s.archivedAt || s.id === field?.sectionId);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={field ? `Modifier le champ « ${field.label} »` : 'Nouveau champ personnalisé'}
      description="Champs propres aux fiches Members. La clé et le type sont définitifs : les valeurs existantes sont toujours préservées."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy} disabled={!valid}>
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
        <Field label="Libellé" required htmlFor="cf-label" error={errors.label}>
          <Input
            id="cf-label"
            value={f.label}
            maxLength={120}
            onChange={(e) => {
              set('label', e.target.value);
              if (!keyTouched && !field) set('key', slugify(e.target.value));
            }}
          />
        </Field>
        <Field
          label="Clé technique"
          required={!field}
          htmlFor="cf-key"
          error={errors.key || (!field && f.key && !keyValid ? '2 à 64 caractères a-z, 0-9, _ (commence par une lettre)' : undefined)}
          hint={field ? 'Immuable' : 'Utilisée par l’API et les imports'}
        >
          <Input
            id="cf-key"
            value={f.key}
            disabled={!!field}
            maxLength={64}
            className="font-mono"
            onChange={(e) => {
              setKeyTouched(true);
              set('key', e.target.value.toLowerCase());
            }}
          />
        </Field>
        <Field label="Type" required htmlFor="cf-type" hint={field ? 'Immuable' : undefined}>
          <Select id="cf-type" value={f.type} disabled={!!field} onChange={(e) => set('type', e.target.value as CustomFieldType)}>
            {Object.entries(CUSTOM_FIELD_TYPE_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Section" htmlFor="cf-section">
          <Select id="cf-section" value={f.sectionId} onChange={(e) => set('sectionId', e.target.value)}>
            <option value="">Aucune (informations complémentaires)</option>
            {activeSections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
                {s.archivedAt ? ' (archivée)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        {f.type === 'SELECT' && (
          <div className="sm:col-span-2">
            <Field
              label="Choix proposés (un par ligne)"
              required
              htmlFor="cf-choices"
              error={errors.options || errors['options.choices'] || (dupChoices ? 'Choix en double' : undefined)}
              hint="Un choix utilisé par des fiches ne peut pas être retiré."
            >
              <Textarea id="cf-choices" rows={4} value={f.choices} onChange={(e) => set('choices', e.target.value)} />
            </Field>
            <Checkbox className="mt-2" label="Sélection multiple" checked={f.multiple} onChange={(e) => set('multiple', e.target.checked)} />
          </div>
        )}
        <Field label="Consultation" htmlFor="cf-view" hint="Permission requise pour voir la valeur">
          <Select id="cf-view" value={f.viewPermission} onChange={(e) => set('viewPermission', e.target.value)}>
            <option value="">Par défaut : voir les fiches</option>
            {MEMBER_PERMISSIONS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Modification" htmlFor="cf-edit" hint="Permission requise pour modifier la valeur">
          <Select id="cf-edit" value={f.editPermission} onChange={(e) => set('editPermission', e.target.value)}>
            <option value="">Par défaut : modifier les fiches</option>
            {MEMBER_PERMISSIONS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          label="Obligatoire"
          description="Exigé à la création d'une fiche (pour les utilisateurs autorisés à le saisir)."
          checked={f.required}
          onChange={(e) => set('required', e.target.checked)}
        />
        <Checkbox
          label="Modifiable en libre-service"
          description="La personne liée à la fiche peut le mettre à jour elle-même (audité)."
          checked={f.selfEditable}
          onChange={(e) => set('selfEditable', e.target.checked)}
        />
      </div>
    </Dialog>
  );
}
