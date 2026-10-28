'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, Plus, Search, ShieldCheck, UserRound, X } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { ApiError, api, errorMessage, type Page } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { useDebounced } from './lib';
import { PRINCIPAL_TYPE_LABELS, type PrincipalDto, type PrincipalType } from './types';

export interface PickOption {
  id: string;
  label: string;
  secondary?: string | null;
}

/**
 * Liste de choix avec recherche serveur (combobox ARIA : flèches, Entrée, Échap).
 * La recherche ne renvoie que ce que le serveur autorise (scope, ADM-070).
 */
export function SearchSelect({
  label,
  value,
  onChange,
  search,
  queryKey,
  placeholder = 'Rechercher…',
  error,
  hint,
  required,
  disabled,
  minChars = 1,
}: {
  label: string;
  value: PickOption | null;
  onChange: (v: PickOption | null) => void;
  search: (term: string) => Promise<PickOption[]>;
  queryKey: string;
  placeholder?: string;
  error?: string;
  hint?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  minChars?: number;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [term, setTerm] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const debounced = useDebounced(term.trim(), 250);
  const q = useQuery({
    queryKey: ['picker', queryKey, debounced],
    queryFn: () => search(debounced),
    enabled: open && debounced.length >= minChars,
    staleTime: 30_000,
  });
  const options = q.data ?? [];

  if (value) {
    return (
      <Field label={label} required={required} error={error} hint={hint}>
        <div className="flex h-9 items-center gap-2 rounded-md border border-line-strong bg-canvas/60 px-3">
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-medium">{value.label}</span>
            {value.secondary && <span className="ml-1.5 text-xs text-ink-muted">{value.secondary}</span>}
          </span>
          {!disabled && (
            <button
              type="button"
              className="rounded p-0.5 text-ink-muted hover:bg-navy-50 hover:text-ink"
              aria-label={`Retirer ${value.label}`}
              onClick={() => onChange(null)}
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          )}
        </div>
      </Field>
    );
  }

  const choose = (o: PickOption) => {
    onChange(o);
    setTerm('');
    setOpen(false);
  };

  return (
    <Field label={label} required={required} error={error} hint={hint} htmlFor={id}>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-soft" aria-hidden />
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && options[active] ? `${listId}-${active}` : undefined}
          invalid={!!error}
          className="pl-8"
          placeholder={placeholder}
          value={term}
          disabled={disabled}
          autoComplete="off"
          onChange={(e) => {
            setTerm(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, Math.max(options.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter' && open && options[active]) {
              e.preventDefault();
              choose(options[active]);
            } else if (e.key === 'Escape') {
              setOpen(false);
            }
          }}
        />
        {open && debounced.length >= minChars && (
          <ul
            id={listId}
            role="listbox"
            aria-label={label}
            className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border border-line bg-white py-1 shadow-pop"
          >
            {q.isLoading && <li className="px-3 py-2 text-sm text-ink-muted">Recherche…</li>}
            {q.error && (
              <li className="px-3 py-2 text-sm text-danger" role="alert">
                {errorMessage(q.error)}
              </li>
            )}
            {!q.isLoading && !q.error && options.length === 0 && <li className="px-3 py-2 text-sm text-ink-muted">Aucun résultat.</li>}
            {options.map((o, i) => (
              <li
                key={o.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(o);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn('cursor-pointer px-3 py-1.5 text-sm', i === active && 'bg-action-50')}
              >
                <span className="block truncate font-medium">{o.label}</span>
                {o.secondary && <span className="block truncate text-xs text-ink-muted">{o.secondary}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Field>
  );
}

interface MemberRow {
  id: string;
  amcRef: string;
  firstName: string;
  lastName: string;
  rank: string | null;
}

export function searchMembers(term: string): Promise<PickOption[]> {
  return api.get<Page<MemberRow>>('/members', { query: { search: term, limit: 10 } }).then((p) =>
    p.items.map((m) => ({ id: m.id, label: `${m.lastName} ${m.firstName}`, secondary: [m.amcRef, m.rank].filter(Boolean).join(' — ') })),
  );
}

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  jobTitle: string | null;
}

export function searchUsers(term: string): Promise<PickOption[]> {
  return api.get<Page<UserRow>>('/users', { query: { search: term, status: 'ACTIVE', limit: 10 } }).then((p) =>
    p.items.map((u) => ({ id: u.id, label: u.displayName, secondary: [u.username, u.jobTitle].filter(Boolean).join(' — ') })),
  );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Choix d'un marin : recherche GET /members si l'utilisateur a `members.view`,
 * sinon saisie de l'identifiant de fiche (le serveur vérifie la visibilité ADM-070).
 */
export function MemberPicker({
  value,
  onChange,
  error,
}: {
  value: PickOption | null;
  onChange: (v: PickOption | null) => void;
  error?: string;
}) {
  const { can } = useSession();
  const [raw, setRaw] = useState(value?.id ?? '');
  const id = useId();
  if (can('members.view')) {
    return (
      <SearchSelect
        label="Marin"
        required
        value={value}
        onChange={onChange}
        search={searchMembers}
        queryKey="members"
        placeholder="Nom, prénom, référence AMC…"
        error={error}
        hint="Seules les fiches visibles dans votre périmètre sont proposées."
      />
    );
  }
  return (
    <Field
      label="Identifiant de la fiche marin"
      required
      htmlFor={id}
      error={error ?? (raw && !UUID_RE.test(raw) ? 'Identifiant invalide (UUID attendu)' : undefined)}
      hint="La recherche des marins requiert le droit « Consulter les marins » : collez l'identifiant de la fiche (visible dans son URL)."
    >
      <Input
        id={id}
        value={raw}
        placeholder="00000000-0000-0000-0000-000000000000"
        onChange={(e) => {
          const v = e.target.value.trim();
          setRaw(v);
          onChange(UUID_RE.test(v) ? { id: v, label: v } : null);
        }}
      />
    </Field>
  );
}

// -----------------------------------------------------------------------------
// Principaux (utilisateurs / rôles / départements) — validateurs et destinataires
// -----------------------------------------------------------------------------

interface RoleRow {
  id: string;
  key: string;
  name: string;
}
interface DepartmentRow {
  id: string;
  code: string;
  name: string;
  status: string;
}

export function useRoles(enabled = true) {
  return useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/roles'), enabled, staleTime: 60_000, retry: false });
}

export function useDepartments(enabled = true) {
  return useQuery({ queryKey: ['departments'], queryFn: () => api.get<DepartmentRow[]>('/departments'), enabled, staleTime: 60_000, retry: false });
}

const PRINCIPAL_ICON: Record<PrincipalType, ReactNode> = {
  USER: <UserRound className="h-3.5 w-3.5" aria-hidden />,
  ROLE: <ShieldCheck className="h-3.5 w-3.5" aria-hidden />,
  DEPARTMENT: <Building2 className="h-3.5 w-3.5" aria-hidden />,
};

export function PrincipalChip({ p, onRemove }: { p: PrincipalDto; onRemove?: () => void }) {
  const label = p.label ?? 'Principal inconnu';
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-line-strong bg-white px-2 py-0.5 text-xs">
      <span className="text-teal-700">{PRINCIPAL_ICON[p.principalType]}</span>
      <span className="text-ink-muted">{PRINCIPAL_TYPE_LABELS[p.principalType]} :</span>
      <span className="truncate font-medium text-ink">{label}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} className="rounded-full p-0.5 text-ink-muted hover:bg-navy-50 hover:text-ink" aria-label={`Retirer ${label}`}>
          <X className="h-3 w-3" aria-hidden />
        </button>
      )}
    </span>
  );
}

function sourceError(e: unknown, right: string): string {
  if (e instanceof ApiError && e.status === 403) return `Liste indisponible : droit « ${right} » requis.`;
  return errorMessage(e);
}

/** Éditeur de liste de principaux USER / ROLE / DEPARTMENT. */
export function PrincipalPicker({
  value,
  onChange,
  disabled,
  emptyHint,
}: {
  value: PrincipalDto[];
  onChange: (v: PrincipalDto[]) => void;
  disabled?: boolean;
  emptyHint?: ReactNode;
}) {
  const [type, setType] = useState<PrincipalType>('ROLE');
  const [choice, setChoice] = useState('');
  const roles = useRoles(type === 'ROLE' && !disabled);
  const depts = useDepartments(type === 'DEPARTMENT' && !disabled);
  const typeId = useId();
  const choiceId = useId();

  const has = (t: PrincipalType, id: string) => value.some((p) => p.principalType === t && p.principalId === id);
  const add = (p: PrincipalDto) => {
    if (!has(p.principalType, p.principalId)) onChange([...value, p]);
    setChoice('');
  };

  const list = type === 'ROLE' ? roles : depts;
  const items: PickOption[] =
    type === 'ROLE'
      ? (roles.data ?? []).map((r) => ({ id: r.id, label: r.name }))
      : (depts.data ?? []).filter((d) => d.status === 'ACTIVE').map((d) => ({ id: d.id, label: d.name, secondary: d.code }));

  return (
    <div className="space-y-2">
      <div className="flex min-h-[28px] flex-wrap gap-1.5" aria-live="polite">
        {value.length === 0 && <p className="text-sm text-ink-muted">{emptyHint ?? 'Aucun principal.'}</p>}
        {value.map((p) => (
          <PrincipalChip
            key={`${p.principalType}:${p.principalId}`}
            p={p}
            onRemove={disabled ? undefined : () => onChange(value.filter((x) => !(x.principalType === p.principalType && x.principalId === p.principalId)))}
          />
        ))}
      </div>
      {!disabled && (
        <div className="grid gap-2 rounded-md border border-dashed border-line-strong p-2 sm:grid-cols-[160px_minmax(0,1fr)_auto] sm:items-end">
          <Field label="Type" htmlFor={typeId}>
            <Select
              id={typeId}
              value={type}
              onChange={(e) => {
                setType(e.target.value as PrincipalType);
                setChoice('');
              }}
            >
              {(Object.keys(PRINCIPAL_TYPE_LABELS) as PrincipalType[]).map((t) => (
                <option key={t} value={t}>
                  {PRINCIPAL_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          </Field>
          {type === 'USER' ? (
            <div className="sm:col-span-2">
              <SearchSelect
                label="Utilisateur"
                value={null}
                onChange={(o) => o && add({ principalType: 'USER', principalId: o.id, label: o.label })}
                search={searchUsers}
                queryKey="users"
                placeholder="Nom, identifiant…"
              />
            </div>
          ) : (
            <>
              <Field label={PRINCIPAL_TYPE_LABELS[type]} htmlFor={choiceId} error={list.error ? sourceError(list.error, type === 'ROLE' ? 'roles.view' : 'departments.view') : undefined}>
                <Select id={choiceId} value={choice} onChange={(e) => setChoice(e.target.value)} disabled={list.isLoading || !!list.error}>
                  <option value="">{list.isLoading ? 'Chargement…' : 'Choisir…'}</option>
                  {items.map((o) => (
                    <option key={o.id} value={o.id} disabled={has(type, o.id)}>
                      {o.label}
                      {o.secondary ? ` (${o.secondary})` : ''}
                    </option>
                  ))}
                </Select>
              </Field>
              <Button
                variant="secondary"
                disabled={!choice}
                onClick={() => {
                  const o = items.find((x) => x.id === choice);
                  if (o) add({ principalType: type, principalId: o.id, label: o.label });
                }}
              >
                <Plus className="h-4 w-4" aria-hidden /> Ajouter
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
