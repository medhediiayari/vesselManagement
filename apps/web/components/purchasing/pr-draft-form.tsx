'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, CopyPlus, Keyboard, MapPin, Plus, Trash2 } from 'lucide-react';
import { useCallback, useId, useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button, IconButton } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { COMMON_UNITS, PRIORITY_LABELS, decimalError, purKeys, toApiDecimal, toDateInput, todayInput } from './lib';
import type { PrFormDefaults, PrLine, PrPriority } from './types';
import { FormField } from './ui';

// =============================================================================
// En-tête PR
// =============================================================================

export interface PrHeaderState {
  vesselId: string;
  category: string;
  subject: string;
  priority: PrPriority;
  neededBy: string;
  requestDate: string;
  departmentId: string;
  comment: string;
}

export const PR_CATEGORY_SUGGESTIONS = [
  'Consommable machine',
  'Pièces de rechange machine',
  'Pont',
  'Sécurité',
  'Électricité',
  'Peinture',
  'Cuisine / avitaillement',
  'Cabine / hôtellerie',
  'Navigation / passerelle',
  'Médical',
  'Divers',
];

/** En-tête vide : date de la demande = aujourd'hui (date civile locale du poste). */
export function emptyHeader(vesselId = ''): PrHeaderState {
  return { vesselId, category: '', subject: '', priority: 'NORMAL', neededBy: '', requestDate: todayInput(), departmentId: '', comment: '' };
}

/** Contrôles affichés près des champs ; le serveur applique les mêmes règles (demande non future, besoin ≥ demande). */
export function headerErrors(h: PrHeaderState, requireVessel = true): Partial<Record<keyof PrHeaderState, string>> {
  const e: Partial<Record<keyof PrHeaderState, string>> = {};
  if (requireVessel && !h.vesselId) e.vesselId = 'Navire obligatoire';
  if (h.category.trim().length < 2) e.category = '2 caractères minimum';
  if (h.subject.trim().length < 2) e.subject = '2 caractères minimum';
  if (h.requestDate && h.requestDate > todayInput()) e.requestDate = 'La date de la demande ne peut pas être dans le futur';
  if (h.neededBy && h.neededBy < (h.requestDate || todayInput())) e.neededBy = 'Ne peut pas précéder la date de la demande';
  return e;
}

/** Départements proposés : liste complète si l'utilisateur peut la lire, sinon ses propres départements. */
function useDepartments() {
  const { me, canAny } = useSession();
  const all = useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => api.get<{ id: string; code: string; name: string; status?: string }[]>('/departments'),
    enabled: canAny('departments.view', 'departments.manage', 'users.view'),
    staleTime: 300_000,
  });
  const list = (all.data ?? me.departments).filter((d) => !('status' in d) || (d as { status?: string }).status !== 'INACTIVE');
  return list.map((d) => ({ id: d.id, label: `${d.name} (${d.code})` }));
}

/** Référence du formulaire (paramétrage Achats) et prochaine escale du navire choisi, pour proposer la date de besoin. */
function usePrFormDefaults(vesselId: string) {
  return useQuery({
    queryKey: purKeys.prFormDefaults(vesselId),
    queryFn: () => api.get<PrFormDefaults>(`/purchase-requests/form-defaults${vesselId ? `?vesselId=${encodeURIComponent(vesselId)}` : ''}`),
    staleTime: 60_000,
  });
}

export function PrHeaderFields({
  value,
  onChange,
  errors = {},
  vesselLocked,
  disabled,
  storedFormRef,
}: {
  value: PrHeaderState;
  onChange: (patch: Partial<PrHeaderState>) => void;
  errors?: Partial<Record<keyof PrHeaderState, string>>;
  vesselLocked?: boolean;
  disabled?: boolean;
  /** PR existante : référence figée à sa création (sinon, celle du paramétrage en vigueur) */
  storedFormRef?: string | null;
}) {
  const { me } = useSession();
  const departments = useDepartments();
  const defaults = usePrFormDefaults(value.vesselId);
  const listId = useId();
  const ids = { vessel: useId(), cat: useId(), subj: useId(), prio: useId(), need: useId(), req: useId(), dep: useId(), form: useId(), com: useId() };
  const formRef = storedFormRef !== undefined ? storedFormRef || '—' : defaults.data?.formRef ?? (defaults.isError ? '—' : 'Chargement…');
  const next = defaults.data?.nextPortCall;
  const etaDate = next ? toDateInput(next.eta) : '';
  const canSuggest = !!next && !disabled && etaDate !== value.neededBy && etaDate >= (value.requestDate || todayInput());
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <FormField label="Navire" required error={errors.vesselId} htmlFor={ids.vessel}>
        <Select id={ids.vessel} value={value.vesselId} onChange={(e) => onChange({ vesselId: e.target.value })} disabled={vesselLocked || disabled} invalid={!!errors.vesselId}>
          <option value="">— Choisir —</option>
          {me.accessibleVessels.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.code})
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Catégorie" required error={errors.category} htmlFor={ids.cat}>
        <Input id={ids.cat} list={listId} value={value.category} onChange={(e) => onChange({ category: e.target.value })} maxLength={120} disabled={disabled} invalid={!!errors.category} />
        <datalist id={listId}>
          {PR_CATEGORY_SUGGESTIONS.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
      </FormField>
      <FormField label="Objet" required error={errors.subject} className="md:col-span-2" htmlFor={ids.subj}>
        <Input id={ids.subj} value={value.subject} onChange={(e) => onChange({ subject: e.target.value })} maxLength={300} disabled={disabled} invalid={!!errors.subject} placeholder="ex. Consommables machine — escale Gabès" />
      </FormField>
      <FormField label="Priorité" htmlFor={ids.prio}>
        <Select id={ids.prio} value={value.priority} onChange={(e) => onChange({ priority: e.target.value as PrPriority })} disabled={disabled}>
          {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Date de la demande" error={errors.requestDate} hint="Aujourd’hui par défaut ; une date passée sert à saisir une demande papier" htmlFor={ids.req}>
        <Input
          id={ids.req}
          type="date"
          max={todayInput()}
          value={value.requestDate}
          onChange={(e) => onChange({ requestDate: e.target.value })}
          disabled={disabled}
          invalid={!!errors.requestDate}
        />
      </FormField>
      <FormField label="Besoin pour le" error={errors.neededBy} hint="Date à laquelle le matériel doit être à bord ; au-delà, la PR est signalée en retard" htmlFor={ids.need}>
        <div className="space-y-1">
          <Input
            id={ids.need}
            type="date"
            min={value.requestDate || undefined}
            value={value.neededBy}
            onChange={(e) => onChange({ neededBy: e.target.value })}
            disabled={disabled}
            invalid={!!errors.neededBy}
          />
          {canSuggest && next && (
            <button
              type="button"
              onClick={() => onChange({ neededBy: etaDate })}
              className="inline-flex max-w-full items-center gap-1 rounded text-left text-xs font-medium text-action hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action"
            >
              <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                Prochaine escale {next.portName} : ETA {fmtDate(next.eta)} — utiliser cette date
              </span>
            </button>
          )}
        </div>
      </FormField>
      <FormField label="Département" htmlFor={ids.dep}>
        <Select id={ids.dep} value={value.departmentId} onChange={(e) => onChange({ departmentId: e.target.value })} disabled={disabled}>
          <option value="">— Aucun —</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField
        label="Référence formulaire"
        hint={storedFormRef !== undefined ? 'Figée à la création de la PR' : 'Automatique — définie dans Achats › Paramétrage'}
        htmlFor={ids.form}
      >
        <Input id={ids.form} value={formRef} readOnly aria-readonly="true" className="cursor-default bg-surface-sunken text-ink-muted" />
      </FormField>
      <FormField label="Commentaire" className="md:col-span-2 xl:col-span-3" htmlFor={ids.com}>
        <Textarea id={ids.com} rows={2} value={value.comment} onChange={(e) => onChange({ comment: e.target.value })} maxLength={5000} disabled={disabled} className="min-h-[60px]" />
      </FormField>
    </div>
  );
}

/** Corps API de l'en-tête (chaînes vides => null / omis). La référence du formulaire est fixée par le serveur. */
export function headerToApi(h: PrHeaderState) {
  return {
    category: h.category.trim(),
    subject: h.subject.trim(),
    priority: h.priority,
    neededBy: h.neededBy || null,
    requestDate: h.requestDate || undefined,
    departmentId: h.departmentId || null,
    comment: h.comment.trim() || null,
  };
}

// =============================================================================
// Lignes « tableur »
// =============================================================================

export interface EditorRow {
  key: string;
  designation: string;
  reference: string;
  quantityRequested: string;
  unit: string;
  rob: string;
  remarks: string;
}

const COLS = ['designation', 'reference', 'quantityRequested', 'unit', 'rob', 'remarks'] as const;
type Col = (typeof COLS)[number];

let seq = 0;
export function newRow(partial: Partial<EditorRow> = {}): EditorRow {
  seq += 1;
  return { key: `r${Date.now().toString(36)}${seq}`, designation: '', reference: '', quantityRequested: '', unit: 'pcs', rob: '', remarks: '', ...partial };
}

export function rowsFromLines(lines: PrLine[]): EditorRow[] {
  return lines.map((l) =>
    newRow({
      designation: l.designation,
      reference: l.reference ?? '',
      quantityRequested: l.quantityRequested,
      unit: l.unit,
      rob: l.rob ?? '',
      remarks: l.remarks ?? '',
    }),
  );
}

function isEmptyRow(r: EditorRow): boolean {
  return !r.designation.trim() && !r.reference.trim() && !r.quantityRequested.trim() && !r.rob.trim() && !r.remarks.trim();
}

export function rowErrors(r: EditorRow): Partial<Record<Col, string>> {
  if (isEmptyRow(r)) return {};
  const e: Partial<Record<Col, string>> = {};
  if (!r.designation.trim()) e.designation = 'Désignation obligatoire';
  // Quantité négative : message explicite plutôt que « nombre décimal attendu » (UI-09)
  const q = r.quantityRequested.trim().startsWith('-') ? 'Quantité > 0' : decimalError(r.quantityRequested, { required: true, positive: true, scale: 3 });
  if (q) e.quantityRequested = q;
  if (!r.unit.trim()) e.unit = 'Unité obligatoire';
  return e;
}

/** Bilan des lignes : lignes valides (pour l'API), numéros des lignes incomplètes. */
export function linesSummary(rows: EditorRow[]) {
  const incomplete: number[] = [];
  const valid: EditorRow[] = [];
  rows.forEach((r, i) => {
    if (isEmptyRow(r)) return;
    if (Object.keys(rowErrors(r)).length) incomplete.push(i + 1);
    else valid.push(r);
  });
  return { incomplete, valid };
}

export function rowsToApi(rows: EditorRow[]) {
  return rows.map((r) => ({
    designation: r.designation.trim(),
    reference: r.reference.trim() || null,
    quantityRequested: toApiDecimal(r.quantityRequested),
    unit: r.unit.trim(),
    rob: r.rob.trim() || null,
    remarks: r.remarks.trim() || null,
  }));
}

/** Empreinte stable des lignes (détection des modifications à enregistrer). */
export function rowsFingerprint(rows: EditorRow[]): string {
  return JSON.stringify(rowsToApi(rows.filter((r) => !isEmptyRow(r))));
}

const HEADERS: Record<Col, { label: string; className: string; required?: boolean }> = {
  designation: { label: 'Désignation', className: 'min-w-[220px]', required: true },
  reference: { label: 'Référence', className: 'min-w-[130px]' },
  quantityRequested: { label: 'Qté', className: 'w-24', required: true },
  unit: { label: 'Unité', className: 'w-24', required: true },
  rob: { label: 'ROB', className: 'w-20' },
  remarks: { label: 'Remarques', className: 'min-w-[160px]' },
};

/**
 * Éditeur de lignes façon tableur (FORM 41 : ITEM, Désignation, Référence, Qté, Unité, ROB, Remarques).
 * Clavier : Entrée = ligne suivante (créée si besoin), ↑/↓ = ligne précédente/suivante, Ctrl+Suppr = supprimer
 * la ligne. Coller depuis Excel (colonnes séparées par tabulation) remplit plusieurs lignes d'un coup.
 */
export function PrLineEditor({ rows, onChange, disabled }: { rows: EditorRow[]; onChange: (rows: EditorRow[]) => void; disabled?: boolean }) {
  const refs = useRef(new Map<string, HTMLInputElement>());
  const unitsId = useId();
  const errId = useId();
  const errorRows = rows.map((r, i) => ({ i, errors: rowErrors(r) })).filter((x) => Object.keys(x.errors).length > 0);
  const focus = useCallback((rowIndex: number, col: Col) => {
    setTimeout(() => refs.current.get(`${rowIndex}:${col}`)?.focus(), 20);
  }, []);

  const update = (i: number, patch: Partial<EditorRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const insertAfter = (i: number, row = newRow({ unit: rows[i]?.unit || 'pcs' })) => {
    const next = [...rows.slice(0, i + 1), row, ...rows.slice(i + 1)];
    onChange(next);
    return next;
  };
  const remove = (i: number) => {
    const next = rows.filter((_, j) => j !== i);
    onChange(next.length ? next : [newRow()]);
  };
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= rows.length) return;
    const next = [...rows];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  const onKey = (i: number, col: Col) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (i === rows.length - 1) insertAfter(i);
      focus(i + 1, col);
    } else if ((e.key === 'Enter' && e.shiftKey) || e.key === 'ArrowUp') {
      if (i > 0) {
        e.preventDefault();
        focus(i - 1, col);
      }
    } else if (e.key === 'ArrowDown') {
      if (i < rows.length - 1) {
        e.preventDefault();
        focus(i + 1, col);
      }
    } else if (e.key === 'Delete' && e.ctrlKey) {
      e.preventDefault();
      remove(i);
      focus(Math.max(0, i - 1), col);
    }
  };

  /** Collage multi-cellules (Excel / tableur) : lignes \n, colonnes \t, à partir de la cellule active. */
  const onPaste = (i: number, col: Col) => (e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return;
    e.preventDefault();
    const matrix = text
      .replace(/\r/g, '')
      .split('\n')
      .filter((line, idx, arr) => line.length > 0 || idx < arr.length - 1)
      .map((line) => line.split('\t'));
    const startCol = COLS.indexOf(col);
    const next = [...rows];
    matrix.forEach((cells, r) => {
      const target = i + r;
      if (!next[target]) next[target] = newRow({ unit: next[target - 1]?.unit || 'pcs' });
      const patch: Partial<EditorRow> = {};
      cells.forEach((cell, c) => {
        const key = COLS[startCol + c];
        if (key) patch[key] = cell.trim();
      });
      next[target] = { ...next[target], ...patch };
    });
    onChange(next);
  };

  const cell = (i: number, col: Col, r: EditorRow, errors: Partial<Record<Col, string>>) => {
    const isNum = col === 'quantityRequested';
    return (
      <Input
        ref={(el) => {
          if (el) refs.current.set(`${i}:${col}`, el);
          else refs.current.delete(`${i}:${col}`);
        }}
        value={r[col]}
        onChange={(e) => update(i, { [col]: e.target.value } as Partial<EditorRow>)}
        onKeyDown={onKey(i, col)}
        onPaste={onPaste(i, col)}
        disabled={disabled}
        invalid={!!errors[col]}
        title={errors[col]}
        aria-label={`Ligne ${i + 1} — ${HEADERS[col].label}`}
        aria-describedby={errors[col] ? `${errId}-${i}` : undefined}
        list={col === 'unit' ? unitsId : undefined}
        inputMode={isNum ? 'decimal' : undefined}
        maxLength={col === 'designation' ? 500 : col === 'remarks' ? 1000 : col === 'unit' ? 32 : col === 'rob' ? 64 : 200}
        className={cn('h-8 rounded-none border-0 bg-transparent px-2 text-sm shadow-none focus:ring-2', isNum && 'text-right tabular', errors[col] && 'bg-danger-bg')}
      />
    );
  };

  return (
    <div>
      <datalist id={unitsId}>
        {COMMON_UNITS.map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      {/* relative : le libellé sr-only positionné en absolu reste rogné par la zone défilante (UI-01, mobile) */}
      <div className="relative overflow-x-auto rounded-md border border-line-strong">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-surface-sunken text-xs text-ink-muted">
              <th scope="col" className="w-10 border-b border-r border-line px-2 py-1.5 text-right font-semibold">
                N°
              </th>
              {COLS.map((c) => (
                <th key={c} scope="col" className={cn('border-b border-r border-line px-2 py-1.5 text-left font-semibold', HEADERS[c].className, c === 'quantityRequested' && 'text-right')}>
                  {HEADERS[c].label}
                  {HEADERS[c].required && (
                    <span className="ml-0.5 text-danger" aria-hidden>
                      *
                    </span>
                  )}
                </th>
              ))}
              <th scope="col" className="w-28 border-b border-line px-2 py-1.5 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const errors = rowErrors(r);
              const hasErr = Object.keys(errors).length > 0;
              return (
                <tr key={r.key} className={cn('group', hasErr && 'bg-danger-bg/30')}>
                  <td className="border-b border-r border-line px-2 text-right text-xs tabular text-ink-muted">{i + 1}</td>
                  {COLS.map((c) => (
                    <td key={c} className="border-b border-r border-line p-0">
                      {cell(i, c, r, errors)}
                    </td>
                  ))}
                  <td className="border-b border-line px-1 text-right">
                    <div className="flex justify-end opacity-70 group-focus-within:opacity-100 group-hover:opacity-100">
                      <IconButton label={`Monter la ligne ${i + 1}`} onClick={() => move(i, -1)} disabled={disabled || i === 0} className="h-7 w-7">
                        <ArrowUp className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton label={`Descendre la ligne ${i + 1}`} onClick={() => move(i, 1)} disabled={disabled || i === rows.length - 1} className="h-7 w-7">
                        <ArrowDown className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton
                        label={`Insérer une ligne après la ligne ${i + 1}`}
                        onClick={() => {
                          insertAfter(i);
                          focus(i + 1, 'designation');
                        }}
                        disabled={disabled}
                        className="h-7 w-7"
                      >
                        <CopyPlus className="h-3.5 w-3.5" />
                      </IconButton>
                      <IconButton label={`Supprimer la ligne ${i + 1}`} onClick={() => remove(i)} disabled={disabled} className="h-7 w-7 hover:text-danger">
                        <Trash2 className="h-3.5 w-3.5" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {errorRows.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-danger" aria-live="polite">
          {errorRows.map(({ i, errors }) => (
            <li key={rows[i].key} id={`${errId}-${i}`}>
              Ligne {i + 1} : {COLS.filter((c) => errors[c]).map((c) => `${HEADERS[c].label} — ${errors[c]}`).join(' · ')}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={() => {
            insertAfter(rows.length - 1);
            focus(rows.length, 'designation');
          }}
        >
          <Plus className="h-4 w-4" aria-hidden /> Ajouter une ligne
        </Button>
        <p className="hidden items-center gap-1.5 text-xs text-ink-muted sm:flex">
          <Keyboard className="h-3.5 w-3.5" aria-hidden />
          Entrée : ligne suivante · ↑/↓ : naviguer · Ctrl+Suppr : supprimer · coller depuis Excel remplit plusieurs lignes. Unités libres (pcs, L, bidon…).
        </p>
      </div>
    </div>
  );
}
