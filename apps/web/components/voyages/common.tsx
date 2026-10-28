'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Info, RefreshCw, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useId, type ReactNode } from 'react';
import { ApiError, api, errorMessage, type StoredFileDto } from '@/lib/api';
import { cn } from '@/lib/format';
import { FileRow } from '@/components/amc/file-preview';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { errorDetails, isStale } from './lib';

/** Erreur API affichée dans un formulaire (validation champ par champ, conflit de version). */
export function FormError({ error, onReload }: { error: unknown; onReload?: () => void }) {
  if (!error) return null;
  const stale = isStale(error);
  const details = errorDetails(error);
  const self = error instanceof ApiError && error.code === 'SELF_APPROVAL_FORBIDDEN';
  return (
    <div role="alert" className="mb-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
      <p className="flex items-start gap-2 font-medium">
        {self ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
        <span>
          {stale ? 'Version périmée : la fiche a été modifiée par un autre utilisateur entre-temps.' : errorMessage(error)}
          {self && <span className="block font-normal">La séparation des tâches impose qu’un autre utilisateur habilité décide.</span>}
        </span>
      </p>
      {details.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-8 text-xs">
          {details.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
      {stale && onReload && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={onReload}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Recharger la dernière version
        </Button>
      )}
    </div>
  );
}

/** Encadré d'information / avertissement (texte + icône). */
export function Notice({ tone = 'info', title, children, className }: { tone?: 'info' | 'warn'; title?: ReactNode; children?: ReactNode; className?: string }) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div
      className={cn(
        'flex gap-2 rounded-md border px-3 py-2 text-sm',
        tone === 'warn' ? 'border-warn-line bg-warn-bg text-warn' : 'border-info-line bg-info-bg text-info',
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div className="min-w-0">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5', 'text-ink')}>{children}</div>}
      </div>
    </div>
  );
}

/** Texte contractuel / libre affiché tel que stocké (retours à la ligne conservés). */
export function StoredText({ children, className }: { children: string | null | undefined; className?: string }) {
  if (!children) return <span className="text-ink-soft">—</span>;
  return <p className={cn('whitespace-pre-wrap break-words text-sm text-ink', className)}>{children}</p>;
}

export function TextInputField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  className,
  placeholder,
  maxLength,
  list,
  autoFocus,
  disabled,
  type = 'text',
  inputMode,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  list?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  type?: string;
  inputMode?: 'text' | 'decimal' | 'email' | 'tel' | 'numeric';
}) {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className} htmlFor={id}>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        invalid={!!error}
        placeholder={placeholder}
        maxLength={maxLength}
        list={list}
        autoFocus={autoFocus}
        disabled={disabled}
        inputMode={inputMode}
        required={required}
      />
    </Field>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  rows = 3,
  hint,
  error,
  className,
  required,
  maxLength,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  hint?: ReactNode;
  error?: string;
  className?: string;
  required?: boolean;
  maxLength?: number;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} className={className} htmlFor={id} required={required}>
      <Textarea id={id} rows={rows} value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} maxLength={maxLength} disabled={disabled} />
    </Field>
  );
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  required,
  hint,
  error,
  className,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className} htmlFor={id}>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} disabled={disabled} required={required}>
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Date + heure saisies en UTC (pratique maritime), libellé explicite. */
export function UtcDateTimeField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <Field label={`${label} (UTC)`} required={required} hint={hint} error={error} className={className} htmlFor={id}>
      <Input id={id} type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} required={required} className="tabular" />
    </Field>
  );
}

export function DateField({
  label,
  value,
  onChange,
  required,
  hint,
  error,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <Field label={label} required={required} hint={hint} error={error} className={className} htmlFor={id}>
      <Input id={id} type="date" value={value} onChange={(e) => onChange(e.target.value)} invalid={!!error} required={required} className="tabular" />
    </Field>
  );
}

const LINK_VARIANTS = {
  primary: 'bg-action text-white hover:bg-action-700',
  secondary: 'bg-white text-ink border border-line-strong hover:bg-canvas',
  ghost: 'bg-transparent text-ink hover:bg-navy-50',
};

/** Lien de navigation présenté comme un bouton (pas d'élément interactif imbriqué). */
export function LinkButton({
  href,
  children,
  variant = 'secondary',
  size = 'sm',
  className,
}: {
  href: string;
  children: ReactNode;
  variant?: keyof typeof LINK_VARIANTS;
  size?: 'sm' | 'md';
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-md font-medium transition-colors',
        size === 'sm' ? 'h-8 gap-1.5 px-3 text-sm' : 'h-9 gap-2 px-4 text-base',
        LINK_VARIANTS[variant],
        className,
      )}
    >
      {children}
    </Link>
  );
}

/** Ligne fichier à partir d'un identifiant seul (métadonnées chargées, droits revérifiés par l'API). */
export function StoredFileRow({ fileId, label, canDownload = true }: { fileId: string; label?: string; canDownload?: boolean }) {
  const q = useQuery({ queryKey: ['file-meta', fileId], queryFn: () => api.get<StoredFileDto>(`/files/${fileId}`), staleTime: 60_000 });
  if (q.isLoading) return <p className="text-xs text-ink-muted">Chargement du document…</p>;
  if (q.error || !q.data) return <p className="text-xs text-danger">{q.error ? errorMessage(q.error) : 'Document indisponible'}</p>;
  return (
    <FileRow
      fileId={fileId}
      name={label ? `${label} — ${q.data.originalName}` : q.data.originalName}
      kind={q.data.kind}
      sizeBytes={q.data.sizeBytes}
      canDownload={canDownload}
    />
  );
}

/** Petit compteur / indicateur pour les vues d'ensemble. */
export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'danger' | 'warn' | 'ok'; hint?: ReactNode }) {
  return (
    <div className="gauge">
      <p className="text-xs text-ink-muted">{label}</p>
      <p
        className={cn(
          'text-lg font-semibold tabular',
          tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-navy',
        )}
      >
        {value}
      </p>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}
