'use client';

import { Archive, Lock } from 'lucide-react';
import { useId } from 'react';
import { fmtDate, fmtDecimal } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Field, Input, Select } from '@/components/ui/field';
import type { CsoCustomFieldValue, CsoFieldDefinition } from './types';

export type FieldValue = string | number | boolean | null;

/** Saisie typée d'un champ personnalisé (texte, nombre, date, liste, booléen). */
export function CustomFieldInput({
  field,
  value,
  onChange,
  disabled,
  error,
}: {
  field: Pick<CsoFieldDefinition, 'key' | 'label' | 'type' | 'options' | 'required' | 'isConfidential'>;
  value: FieldValue | undefined;
  onChange: (v: FieldValue) => void;
  disabled?: boolean;
  error?: string;
}) {
  const id = useId();
  const label = field.label;
  const hint = field.isConfidential ? 'Champ confidentiel : visible uniquement des personnes autorisées.' : undefined;
  if (field.type === 'BOOLEAN') {
    return (
      <Field label={label} htmlFor={id} required={field.required} hint={hint} error={error}>
        <Select id={id} value={value === true ? 'true' : value === false ? 'false' : ''} disabled={disabled} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}>
          <option value="">—</option>
          <option value="true">Oui</option>
          <option value="false">Non</option>
        </Select>
      </Field>
    );
  }
  if (field.type === 'SELECT') {
    return (
      <Field label={label} htmlFor={id} required={field.required} hint={hint} error={error}>
        <Select id={id} value={(value as string | null) ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <Field label={label} htmlFor={id} required={field.required} hint={hint} error={error}>
      <Input
        id={id}
        type={field.type === 'DATE' ? 'date' : 'text'}
        inputMode={field.type === 'NUMBER' ? 'decimal' : undefined}
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)}
      />
    </Field>
  );
}

export function formatFieldValue(f: Pick<CsoCustomFieldValue, 'type' | 'value'>): string {
  if (f.value === null || f.value === undefined || f.value === '') return '—';
  if (f.type === 'BOOLEAN') return f.value ? 'Oui' : 'Non';
  if (f.type === 'DATE') return fmtDate(String(f.value));
  if (f.type === 'NUMBER') return fmtDecimal(f.value as number, 6);
  return String(f.value);
}

/** Valeurs visibles d'un document (les champs non autorisés sont absents de la réponse API). */
export function CustomFieldsView({ fields }: { fields: CsoCustomFieldValue[] }) {
  if (!fields.length) return null;
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {fields.map((f) => (
        <div key={f.fieldId} className="min-w-0">
          <dt className="flex flex-wrap items-center gap-1 text-xs text-ink-muted">
            {f.label}
            {f.isConfidential && (
              <Badge tone="warn" icon={<Lock className="h-3 w-3" aria-hidden />} className="px-1.5 py-0 text-[11px]">
                Confidentiel
              </Badge>
            )}
            {f.archived && (
              <Badge tone="neutral" icon={<Archive className="h-3 w-3" aria-hidden />} className="px-1.5 py-0 text-[11px]">
                Archivé
              </Badge>
            )}
          </dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{formatFieldValue(f)}</dd>
        </div>
      ))}
    </dl>
  );
}
