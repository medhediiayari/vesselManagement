'use client';

import { AlertTriangle, CheckCircle2, ChevronDown, ChevronsDownUp, ChevronsUpDown, CloudOff, Loader2, RefreshCw, Save } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import {
  BEAUFORT_LABELS,
  CONSUMPTION_BASIS_LABELS,
  FIELD_DEFS,
  NOON_SECTIONS,
  UTC_OFFSET_OPTIONS,
  displayValue,
  formatCoordinate,
  formatUtcOffset,
  localFromUtc,
  parseCoordinate,
  utcFromLocal,
  type FieldDef,
  type FormValues,
  type NoonField,
  type SectionDef,
} from './lib';
import type { SaveStatus } from './use-noon-draft';

export const fieldId = (k: string) => `noon-field-${k}`;

// -----------------------------------------------------------------------------
// Indicateur d'enregistrement
// -----------------------------------------------------------------------------

export function SaveIndicator({ status, lastSavedAt, onRetry }: { status: SaveStatus; lastSavedAt: Date | null; onRetry?: () => void }) {
  const map: Record<SaveStatus, { icon: ReactNode; text: string; cls: string }> = {
    idle: { icon: <Save className="h-4 w-4" aria-hidden />, text: 'Enregistrement automatique activé', cls: 'text-ink-muted' },
    dirty: { icon: <Save className="h-4 w-4" aria-hidden />, text: 'Modifications en attente…', cls: 'text-ink-muted' },
    saving: { icon: <Loader2 className="h-4 w-4 animate-spin" aria-hidden />, text: 'Enregistrement…', cls: 'text-info' },
    saved: {
      icon: <CheckCircle2 className="h-4 w-4" aria-hidden />,
      text: `Enregistré${lastSavedAt ? ` à ${lastSavedAt.toLocaleTimeString('fr-FR')}` : ''}`,
      cls: 'text-ok',
    },
    invalid: { icon: <AlertTriangle className="h-4 w-4" aria-hidden />, text: 'Champs invalides non enregistrés — corrigez-les', cls: 'text-warn' },
    error: { icon: <CloudOff className="h-4 w-4" aria-hidden />, text: 'Échec de l’enregistrement', cls: 'text-danger' },
    conflict: { icon: <AlertTriangle className="h-4 w-4" aria-hidden />, text: 'Conflit de version — enregistrement suspendu', cls: 'text-danger' },
    locked: { icon: <AlertTriangle className="h-4 w-4" aria-hidden />, text: 'Rapport verrouillé (statut modifié)', cls: 'text-danger' },
  };
  const m = map[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', m.cls)} role="status" aria-live="polite">
      {m.icon}
      {m.text}
      {status === 'error' && onRetry && (
        <Button size="sm" variant="ghost" onClick={onRetry}>
          <RefreshCw className="h-4 w-4" aria-hidden /> Réessayer
        </Button>
      )}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Champs
// -----------------------------------------------------------------------------

function UnitInput({ id, value, onChange, unit, invalid, inputMode = 'decimal', placeholder }: { id: string; value: string; onChange: (v: string) => void; unit?: string; invalid?: boolean; inputMode?: 'decimal' | 'text'; placeholder?: string }) {
  return (
    <div className="relative">
      <Input
        id={id}
        value={value}
        inputMode={inputMode}
        autoComplete="off"
        onChange={(e) => onChange(e.target.value)}
        invalid={invalid}
        placeholder={placeholder}
        className={cn('tabular', unit && 'pr-12')}
      />
      {unit && <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-ink-muted">{unit}</span>}
    </div>
  );
}

/** Position : décimal signé ou degrés / minutes avec hémisphère (normalisée en décimal à la sortie du champ). */
function CoordinateInput({ k, value, onChange, invalid }: { k: 'latitude' | 'longitude'; value: string; onChange: (v: string) => void; invalid?: boolean }) {
  const axis = k === 'latitude' ? 'lat' : 'lon';
  const parsed = parseCoordinate(value, axis);
  return (
    <div>
      <Input
        id={fieldId(k)}
        value={value}
        autoComplete="off"
        inputMode="text"
        placeholder={axis === 'lat' ? '37°36.0′ N ou 37.6' : '011°15.0′ E ou 11.25'}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => {
          if (parsed.value !== null && !parsed.error && parsed.value !== value.trim()) onChange(parsed.value);
        }}
        invalid={invalid}
        className="tabular"
        aria-describedby={`${fieldId(k)}-fmt`}
      />
      <p id={`${fieldId(k)}-fmt`} className="mt-1 text-xs tabular text-ink-muted">
        {parsed.value !== null && !parsed.error ? `${formatCoordinate(parsed.value, axis)} (${parsed.value}°)` : ' '}
      </p>
    </div>
  );
}

function FieldInput({ def, values, onChange, error }: { def: FieldDef; values: FormValues; onChange: (k: NoonField, v: string) => void; error?: string }) {
  const k = def.key;
  const id = fieldId(k);
  const v = values[k] ?? '';
  const set = (x: string) => onChange(k, x);
  switch (def.kind) {
    case 'coordinate':
      return <CoordinateInput k={k as 'latitude' | 'longitude'} value={v} onChange={set} invalid={!!error} />;
    case 'decimal':
      return <UnitInput id={id} value={v} onChange={set} unit={def.unit} invalid={!!error} />;
    case 'beaufort':
      return (
        <Select id={id} value={v} onChange={(e) => set(e.target.value)} invalid={!!error}>
          <option value="">—</option>
          {BEAUFORT_LABELS.map((l, i) => (
            <option key={i} value={String(i)}>
              {i} — {l}
            </option>
          ))}
        </Select>
      );
    case 'enum':
      return (
        <Select id={id} value={v} onChange={(e) => set(e.target.value)} invalid={!!error}>
          {k !== 'reportType' && k !== 'consumptionBasis' && <option value="">—</option>}
          {Object.entries(def.options ?? {}).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
      );
    case 'datetime':
      return <Input id={id} type="datetime-local" value={v} onChange={(e) => set(e.target.value)} invalid={!!error} className="tabular" />;
    case 'offset':
      return (
        <Select id={id} value={v} onChange={(e) => set(e.target.value)} invalid={!!error}>
          {v === '' && <option value="">—</option>}
          {UTC_OFFSET_OPTIONS.map((o) => (
            <option key={o} value={String(o)}>
              {formatUtcOffset(o)}
            </option>
          ))}
        </Select>
      );
    case 'longtext':
      return <Textarea id={id} value={v} rows={3} maxLength={def.max} onChange={(e) => set(e.target.value)} invalid={!!error} />;
    default:
      return <Input id={id} value={v} maxLength={def.max} onChange={(e) => set(e.target.value)} invalid={!!error} />;
  }
}

function FormField({ def, values, onChange, error, missing, className }: { def: FieldDef; values: FormValues; onChange: (k: NoonField, v: string) => void; error?: string; missing?: string; className?: string }) {
  return (
    <Field
      label={`${def.label}${def.unit && def.kind !== 'decimal' ? ` (${def.unit})` : ''}`}
      htmlFor={fieldId(def.key)}
      error={error}
      hint={missing ? <span className="font-medium text-warn">{missing}</span> : def.hint}
      className={cn(def.wide && 'sm:col-span-2 lg:col-span-3', def.kind === 'longtext' && !def.wide && 'sm:col-span-1 lg:col-span-1', className)}
    >
      <FieldInput def={def} values={values} onChange={onChange} error={error} />
    </Field>
  );
}

// -----------------------------------------------------------------------------
// Sections spécifiques
// -----------------------------------------------------------------------------

/** Section 1 : date UTC + heure locale du bord (éditable) + décalage. */
function GeneralSection({ values, onChange, errors, missing, context }: SectionProps) {
  const localId = useId();
  const offset = Number(values.utcOffsetMinutes || 0);
  const local = localFromUtc(values.reportDateUtc, offset);
  return (
    <div className="space-y-4">
      {context && <div className="rounded-md bg-canvas px-3 py-2 text-sm">{context}</div>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <FormField def={FIELD_DEFS.reportType} values={values} onChange={onChange} error={errors.reportType} missing={missing.reportType} />
        <FormField def={FIELD_DEFS.reportDateUtc} values={values} onChange={onChange} error={errors.reportDateUtc} missing={missing.reportDateUtc} />
        <FormField def={FIELD_DEFS.utcOffsetMinutes} values={values} onChange={onChange} error={errors.utcOffsetMinutes} missing={missing.utcOffsetMinutes} />
        <Field label="Heure locale du bord" htmlFor={localId} hint={values.reportDateUtc ? `Locale = UTC ${formatUtcOffset(offset).slice(3)} — modifier l’une met l’autre à jour.` : 'Renseigner d’abord la date UTC ou saisir l’heure locale.'}>
          <Input
            id={localId}
            type="datetime-local"
            className="tabular"
            value={local}
            onChange={(e) => {
              const utc = utcFromLocal(e.target.value, offset);
              if (utc) onChange('reportDateUtc', utc);
            }}
          />
        </Field>
        <FormField def={FIELD_DEFS.masterName} values={values} onChange={onChange} error={errors.masterName} missing={missing.masterName} />
        <FormField def={FIELD_DEFS.reference} values={values} onChange={onChange} error={errors.reference} missing={missing.reference} />
      </div>
    </div>
  );
}

const ENGINE_GROUPS: { title: string; hint?: string; fields: NoonField[] }[] = [
  { title: 'Moteur principal', fields: ['meRpm', 'runningHours'] },
  { title: 'Consommations', hint: 'Quantités consommées sur la base choisie ci-dessus (jamais cumulées automatiquement).', fields: ['foConsumptionMt', 'doConsumptionMt', 'lubeOilConsumptionL'] },
  { title: 'ROB — restant à bord', hint: 'Quantités présentes à bord à l’heure du rapport (pas des consommations).', fields: ['foRobMt', 'doRobMt', 'loRobL'] },
];

/** Section 4 : base de consommation EXPLICITE (since last report vs daily 24 h), consommations et ROB distincts. */
function EngineSection({ values, onChange, errors, missing }: SectionProps) {
  const basis = values.consumptionBasis;
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="field-label">
          Base de consommation<span className="ml-0.5 text-danger" aria-hidden>*</span>
        </legend>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" id={fieldId('consumptionBasis')}>
          {Object.entries(CONSUMPTION_BASIS_LABELS).map(([value, label]) => (
            <label
              key={value}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm',
                basis === value ? 'border-action bg-action-50' : 'border-line-strong hover:bg-canvas',
              )}
            >
              <input type="radio" name="consumptionBasis" className="mt-0.5" value={value} checked={basis === value} onChange={() => onChange('consumptionBasis', value)} />
              <span>
                <span className="font-medium text-ink">{label.split(' — ')[0]}</span>
                <span className="block text-xs text-ink-muted">{label.split(' — ')[1]}</span>
                {value === 'DAILY_24H' && <span className="block text-xs text-ink-muted">Heures de marche ≤ 24.</span>}
              </span>
            </label>
          ))}
        </div>
        {errors.consumptionBasis && <p className="field-error">{errors.consumptionBasis}</p>}
      </fieldset>
      {ENGINE_GROUPS.map((g) => (
        <fieldset key={g.title} className="rounded-md border border-line p-3">
          <legend className="px-1 text-sm font-semibold text-navy">
            {g.title}
            {g.title === 'Consommations' && basis && (
              <Badge tone="info" icon={false} className="ml-2 align-middle">
                {basis === 'DAILY_24H' ? 'Daily (24 h)' : 'Since last report'}
              </Badge>
            )}
          </legend>
          {g.hint && <p className="mb-2 text-xs text-ink-muted">{g.hint}</p>}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {g.fields.map((k) => (
              <FormField key={k} def={FIELD_DEFS[k]} values={values} onChange={onChange} error={errors[k]} missing={missing[k]} />
            ))}
          </div>
        </fieldset>
      ))}
    </div>
  );
}

interface SectionProps {
  values: FormValues;
  onChange: (k: NoonField, v: string) => void;
  errors: Record<string, string>;
  missing: Record<string, string>;
  context?: ReactNode;
}

function GenericSection({ section, values, onChange, errors, missing }: SectionProps & { section: SectionDef }) {
  const long = section.fields.every((f) => f.kind === 'longtext');
  return (
    <div className={cn('grid gap-4', long ? 'md:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3')}>
      {section.fields.map((f) => (
        <FormField key={f.key} def={long ? { ...f, wide: false } : f} values={values} onChange={onChange} error={errors[f.key]} missing={missing[f.key]} />
      ))}
    </div>
  );
}

/** Lecture seule : valeurs telles qu'enregistrées / figées. */
function ReadonlySection({ section, values }: { section: SectionDef; values: Record<string, string | number | null> }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
      {section.fields.map((f) => (
        <div key={f.key} className={cn('min-w-0', f.kind === 'longtext' && 'sm:col-span-2 lg:col-span-3')}>
          <dt className="text-xs text-ink-muted">{f.label}</dt>
          <dd className={cn('mt-0.5 break-words text-sm text-ink', f.kind === 'longtext' && 'whitespace-pre-wrap', f.kind !== 'text' && f.kind !== 'longtext' && 'tabular')}>
            {displayValue(f.key, values[f.key])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// -----------------------------------------------------------------------------
// Formulaire en 7 sections repliables
// -----------------------------------------------------------------------------

export function NoonForm({
  values,
  onChange,
  errors,
  missing,
  readOnly,
  readOnlyValues,
  open,
  onToggle,
  onToggleAll,
  general,
  showMissing,
}: {
  values: FormValues;
  onChange: (k: NoonField, v: string) => void;
  errors: Record<string, string>;
  missing: Record<string, string>;
  readOnly?: boolean;
  /** Valeurs API (lecture seule) */
  readOnlyValues?: Record<string, string | number | null>;
  open: Record<string, boolean>;
  onToggle: (key: string) => void;
  onToggleAll: (open: boolean) => void;
  /** Bloc de contexte en tête de la section 1 (navire, IMO, voyage) */
  general?: ReactNode;
  /** Afficher les champs minimaux manquants (après une tentative de soumission) */
  showMissing?: boolean;
}) {
  const allOpen = NOON_SECTIONS.every((s) => open[s.key]);
  const shownMissing = showMissing ? missing : {};
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={() => onToggleAll(!allOpen)}>
          {allOpen ? <ChevronsDownUp className="h-4 w-4" aria-hidden /> : <ChevronsUpDown className="h-4 w-4" aria-hidden />}
          {allOpen ? 'Tout replier' : 'Tout déplier'}
        </Button>
      </div>
      {NOON_SECTIONS.map((s) => {
        const isOpen = !!open[s.key];
        const errCount = readOnly ? 0 : s.fields.filter((f) => errors[f.key]).length;
        const missCount = readOnly ? 0 : s.fields.filter((f) => missing[f.key]).length;
        const contentId = `noon-section-${s.key}`;
        const props: SectionProps = { values, onChange, errors, missing: shownMissing, context: general };
        return (
          <section key={s.key} className="panel overflow-hidden" aria-labelledby={`${contentId}-h`}>
            <h2 id={`${contentId}-h`} className="m-0">
              <button
                type="button"
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-canvas/70"
                aria-expanded={isOpen}
                aria-controls={contentId}
                onClick={() => onToggle(s.key)}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-navy text-sm font-semibold tabular text-white">{s.index}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-md font-semibold text-navy">{s.title}</span>
                  <span className="block truncate text-xs font-normal text-ink-muted">{s.subtitle}</span>
                </span>
                {errCount > 0 && <Badge tone="danger">{errCount} erreur(s)</Badge>}
                {errCount === 0 && missCount > 0 && <Badge tone="warn">{missCount} requis</Badge>}
                {!readOnly && errCount === 0 && missCount === 0 && <Badge tone="ok">Complet</Badge>}
                <ChevronDown className={cn('h-5 w-5 shrink-0 text-ink-muted transition-transform', isOpen && 'rotate-180')} aria-hidden />
              </button>
            </h2>
            <div id={contentId} hidden={!isOpen} className="border-t border-line px-4 py-4">
              {readOnly ? (
                <>
                  {s.key === 'general' && general && <div className="mb-3 rounded-md bg-canvas px-3 py-2 text-sm">{general}</div>}
                  <ReadonlySection section={s} values={readOnlyValues ?? {}} />
                </>
              ) : s.key === 'general' ? (
                <GeneralSection {...props} />
              ) : s.key === 'engineFuel' ? (
                <EngineSection {...props} />
              ) : (
                <GenericSection section={s} {...props} />
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** Ouvre la section d'un champ puis lui donne le focus. */
export function focusNoonField(field: string, open: (sectionKey: string) => void) {
  const section = NOON_SECTIONS.find((s) => s.fields.some((f) => f.key === field));
  if (section) open(section.key);
  setTimeout(() => {
    const el = document.getElementById(fieldId(field));
    if (!el) return;
    const target = (el.matches('input,select,textarea') ? el : el.querySelector('input,select,textarea')) as HTMLElement | null;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target?.focus({ preventScroll: true });
  }, 60);
}

/** Récapitulatif lisible des 7 sections (aperçu avant soumission). */
export function NoonSummary({ values }: { values: Record<string, string | number | null> }) {
  return (
    <div className="space-y-4">
      {NOON_SECTIONS.map((s) => (
        <section key={s.key}>
          <h3 className="mb-2 text-sm font-semibold text-navy">
            {s.index}. {s.title}
          </h3>
          <ReadonlySection section={s} values={values} />
        </section>
      ))}
    </div>
  );
}

export function useSectionState(initial: Record<string, boolean>) {
  const [open, setOpen] = useState<Record<string, boolean>>(initial);
  return {
    open,
    toggle: (k: string) => setOpen((p) => ({ ...p, [k]: !p[k] })),
    openOne: (k: string) => setOpen((p) => ({ ...p, [k]: true })),
    setAll: (v: boolean) => setOpen(Object.fromEntries(NOON_SECTIONS.map((s) => [s.key, v]))),
  };
}

