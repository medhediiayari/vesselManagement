'use client';

import { useId, type ReactNode } from 'react';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { fmtDate } from '@/lib/format';
import { formatPlainValue, ProtectedMark } from './member-ui';
import { CREW_DEPARTMENT_LABELS, GENDER_LABELS, PROTECTED_FIELDS, type MemberCore } from './types';

export type CoreKey =
  | 'lastName'
  | 'firstName'
  | 'amcRef'
  | 'birthDate'
  | 'birthPlace'
  | 'nationality'
  | 'gender'
  | 'email'
  | 'phone'
  | 'address'
  | 'emergencyContactName'
  | 'emergencyContactPhone'
  | 'passportNumber'
  | 'passportCountry'
  | 'passportExpiry'
  | 'seamanBookNumber'
  | 'seamanBookExpiry'
  | 'rank'
  | 'crewDepartment'
  | 'notes';

type InputKind = 'text' | 'date' | 'email' | 'tel' | 'country' | 'gender' | 'department' | 'textarea' | 'ref';

export interface CoreFieldDef {
  key: CoreKey;
  label: string;
  kind: InputKind;
  required?: boolean;
  hint?: string;
  maxLength?: number;
  wide?: boolean;
}

export type CoreGroup = 'identity' | 'contact' | 'documents' | 'crew';

export const CORE_GROUPS: { id: CoreGroup; title: string; fields: CoreFieldDef[] }[] = [
  {
    id: 'identity',
    title: 'Identité',
    fields: [
      { key: 'lastName', label: 'Nom', kind: 'text', required: true, maxLength: 120 },
      { key: 'firstName', label: 'Prénom', kind: 'text', required: true, maxLength: 120 },
      { key: 'amcRef', label: 'Matricule AMC', kind: 'ref', maxLength: 32, hint: 'Unique — enregistré en majuscules sans espaces' },
      { key: 'birthDate', label: 'Date de naissance', kind: 'date' },
      { key: 'birthPlace', label: 'Lieu de naissance', kind: 'text', maxLength: 120 },
      { key: 'nationality', label: 'Nationalité', kind: 'country', hint: 'Code pays ISO à 2 lettres, ex. TN' },
      { key: 'gender', label: 'Genre', kind: 'gender' },
    ],
  },
  {
    id: 'contact',
    title: 'Coordonnées',
    fields: [
      { key: 'email', label: 'E-mail', kind: 'email', maxLength: 320 },
      { key: 'phone', label: 'Téléphone', kind: 'tel', maxLength: 64 },
      { key: 'address', label: 'Adresse', kind: 'textarea', maxLength: 500, wide: true },
      { key: 'emergencyContactName', label: "Contact d'urgence", kind: 'text', maxLength: 200 },
      { key: 'emergencyContactPhone', label: "Téléphone d'urgence", kind: 'tel', maxLength: 64 },
    ],
  },
  {
    id: 'documents',
    title: 'Passeport et seaman book',
    fields: [
      { key: 'passportNumber', label: 'N° de passeport', kind: 'ref', maxLength: 32 },
      { key: 'passportCountry', label: 'Pays émetteur', kind: 'country', hint: 'Code ISO à 2 lettres' },
      { key: 'passportExpiry', label: 'Expiration du passeport', kind: 'date' },
      { key: 'seamanBookNumber', label: 'N° de seaman book', kind: 'ref', maxLength: 32 },
      { key: 'seamanBookExpiry', label: 'Expiration du seaman book', kind: 'date' },
    ],
  },
  {
    id: 'crew',
    title: 'Fonction à bord',
    fields: [
      { key: 'rank', label: 'Fonction (rank)', kind: 'text', maxLength: 120, hint: 'Ex. Master, Chief Officer, AB, Oiler' },
      { key: 'crewDepartment', label: 'Service à bord', kind: 'department' },
      { key: 'notes', label: 'Notes', kind: 'textarea', maxLength: 5000, wide: true },
    ],
  },
];

export const ALL_CORE_FIELDS: CoreFieldDef[] = CORE_GROUPS.flatMap((g) => g.fields);

export function isProtectedField(key: string): boolean {
  return (PROTECTED_FIELDS as readonly string[]).includes(key);
}

export type CoreValues = Record<CoreKey, string>;

export function emptyCoreValues(): CoreValues {
  return Object.fromEntries(ALL_CORE_FIELDS.map((f) => [f.key, ''])) as CoreValues;
}

export function toCoreValues(m: Partial<MemberCore>): CoreValues {
  const v = emptyCoreValues();
  for (const f of ALL_CORE_FIELDS) {
    const raw = (m as Record<string, unknown>)[f.key];
    v[f.key] = raw === null || raw === undefined ? '' : String(raw);
  }
  return v;
}

/** Valeur envoyée à l'API : chaîne vide => null (effacement explicite). */
function outValue(f: CoreFieldDef, v: string): string | null {
  const t = v.trim();
  if (!t) return null;
  if (f.kind === 'country') return t.toUpperCase();
  return t;
}

/** Champs modifiés uniquement (diff avec la fiche lue), pour un PATCH minimal et audité. */
export function buildCorePatch(original: CoreValues, values: CoreValues, keys?: Iterable<CoreKey>): Partial<Record<CoreKey, string | null>> {
  const allowed = keys ? new Set(keys) : null;
  const patch: Partial<Record<CoreKey, string | null>> = {};
  for (const f of ALL_CORE_FIELDS) {
    if (allowed && !allowed.has(f.key)) continue;
    const before = outValue(f, original[f.key]);
    const after = outValue(f, values[f.key]);
    if (before !== after) patch[f.key] = after;
  }
  return patch;
}

/** Corps de création : champs renseignés seulement. */
export function buildCorePayload(values: CoreValues, keys?: Iterable<CoreKey>): Partial<Record<CoreKey, string>> {
  const allowed = keys ? new Set(keys) : null;
  const out: Partial<Record<CoreKey, string>> = {};
  for (const f of ALL_CORE_FIELDS) {
    if (allowed && !allowed.has(f.key)) continue;
    const v = outValue(f, values[f.key]);
    if (v !== null) out[f.key] = v;
  }
  return out;
}

export function CoreFieldInput({
  def,
  value,
  onChange,
  disabled,
  error,
  hintOverride,
}: {
  def: CoreFieldDef;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  error?: string;
  hintOverride?: ReactNode;
}) {
  const id = useId();
  const hint = hintOverride ?? def.hint;
  const common = { id, disabled, invalid: !!error, value };
  let control: ReactNode;
  switch (def.kind) {
    case 'gender':
      control = (
        <Select {...common} onChange={(e) => onChange(e.target.value)}>
          <option value="">Non renseigné</option>
          {Object.entries(GENDER_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      );
      break;
    case 'department':
      control = (
        <Select {...common} onChange={(e) => onChange(e.target.value)}>
          <option value="">Non renseigné</option>
          {Object.entries(CREW_DEPARTMENT_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      );
      break;
    case 'textarea':
      control = <Textarea {...common} rows={2} maxLength={def.maxLength} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'country':
      control = (
        <Input
          {...common}
          maxLength={2}
          autoComplete="off"
          className="uppercase"
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
      );
      break;
    default:
      control = (
        <Input
          {...common}
          type={def.kind === 'date' ? 'date' : def.kind === 'email' ? 'email' : def.kind === 'tel' ? 'tel' : 'text'}
          maxLength={def.maxLength}
          autoComplete="off"
          // Suggestions issues du référentiel des rangs (saisie libre conservée)
          list={def.key === 'rank' ? 'amc-ranks' : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
  return (
    <Field label={def.label} required={def.required} error={error} hint={hint} htmlFor={id} className={def.wide ? 'sm:col-span-2' : undefined}>
      {control}
    </Field>
  );
}

/** Lecture seule d'un champ de fiche (dates civiles, libellés). */
export function coreDisplay(def: CoreFieldDef, value: string): string {
  if (!value) return '—';
  if (def.kind === 'date') return fmtDate(value);
  return formatPlainValue(def.key, value);
}

/** Grille d'un groupe de champs : éditables ou lecture seule (champ protégé signalé). */
export function CoreGroupFields({
  fields,
  values,
  onChange,
  editable,
  errors,
  editing,
}: {
  fields: CoreFieldDef[];
  values: CoreValues;
  onChange: (key: CoreKey, v: string) => void;
  editable: (key: CoreKey) => boolean;
  errors?: Record<string, string>;
  editing: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
      {fields.map((def) => {
        if (editing && editable(def.key)) {
          return (
            <CoreFieldInput key={def.key} def={def} value={values[def.key]} onChange={(v) => onChange(def.key, v)} error={errors?.[def.key]} />
          );
        }
        return (
          <div key={def.key} className={def.wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
            <p className="flex items-center gap-2 text-xs text-ink-muted">
              {def.label}
              {editing && isProtectedField(def.key) && <ProtectedMark label="Lecture seule" />}
            </p>
            <p className="mt-0.5 whitespace-pre-line break-words text-sm text-ink">{coreDisplay(def, values[def.key])}</p>
          </div>
        );
      })}
    </div>
  );
}
