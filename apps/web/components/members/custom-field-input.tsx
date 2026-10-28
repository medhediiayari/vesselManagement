'use client';

import { useId } from 'react';
import { Field, Input, Select } from '@/components/ui/field';
import type { CustomFieldType, SelectOptions } from './types';

/**
 * Saisie d'un champ personnalisé selon son type (ADM-036). La validation fait foi côté serveur ;
 * la valeur vide est envoyée comme null (effacement).
 */
export function CustomFieldInput({
  field,
  value,
  onChange,
  disabled,
  error,
  hint,
}: {
  field: { key: string; label: string; type: CustomFieldType; options: SelectOptions | null; required: boolean };
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  error?: string;
  hint?: string;
}) {
  const id = useId();
  const choices = field.options?.choices ?? [];

  if (field.type === 'BOOLEAN') {
    return (
      <Field label={field.label} required={field.required} error={error} hint={hint} htmlFor={id}>
        <Select
          id={id}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          disabled={disabled}
          invalid={!!error}
          onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'true')}
        >
          <option value="">Non renseigné</option>
          <option value="true">Oui</option>
          <option value="false">Non</option>
        </Select>
      </Field>
    );
  }

  if (field.type === 'SELECT' && field.options?.multiple) {
    const selected = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="min-w-0">
        <legend className="field-label">
          {field.label}
          {field.required && (
            <span className="ml-0.5 text-danger" aria-hidden>
              *
            </span>
          )}
        </legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 rounded-md border border-line-strong px-3 py-2">
          {choices.map((c) => (
            <label key={c} className="inline-flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-line-strong text-action"
                checked={selected.includes(c)}
                disabled={disabled}
                onChange={(e) => onChange(e.target.checked ? [...selected, c] : selected.filter((x) => x !== c))}
              />
              {c}
            </label>
          ))}
        </div>
        {hint && !error && <p className="field-hint">{hint}</p>}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </fieldset>
    );
  }

  if (field.type === 'SELECT') {
    return (
      <Field label={field.label} required={field.required} error={error} hint={hint} htmlFor={id}>
        <Select id={id} value={typeof value === 'string' ? value : ''} disabled={disabled} invalid={!!error} onChange={(e) => onChange(e.target.value || null)}>
          <option value="">Non renseigné</option>
          {choices.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
    );
  }

  return (
    <Field label={field.label} required={field.required} error={error} hint={hint} htmlFor={id}>
      <Input
        id={id}
        type={field.type === 'DATE' ? 'date' : field.type === 'NUMBER' ? 'number' : 'text'}
        step={field.type === 'NUMBER' ? 'any' : undefined}
        value={value === null || value === undefined ? '' : String(value)}
        disabled={disabled}
        invalid={!!error}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === '') return onChange(null);
          onChange(field.type === 'NUMBER' ? Number(raw) : raw);
        }}
      />
    </Field>
  );
}

/** Erreurs de champs personnalisés renvoyées par l'API : details.errors = [{ key, message }]. */
export function customFieldErrors(details: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const errors = (details as { errors?: { key?: string; message?: string }[] } | undefined)?.errors;
  if (Array.isArray(errors)) for (const e of errors) if (e?.key) out[e.key] = e.message ?? 'Valeur invalide';
  return out;
}
