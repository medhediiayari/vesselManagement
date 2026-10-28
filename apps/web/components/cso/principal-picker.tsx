'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, Plus, Shield, User } from 'lucide-react';
import { useId, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { PRINCIPAL_TYPE_LABELS, type PrincipalType } from './types';

export interface PickedPrincipal {
  principalType: PrincipalType;
  principalId: string;
  label: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function PrincipalIcon({ type }: { type: PrincipalType }) {
  if (type === 'USER') return <User className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-label="Utilisateur" />;
  if (type === 'ROLE') return <Shield className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-label="Rôle" />;
  return <Building2 className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-label="Département" />;
}

export function PrincipalName({ type, id, label }: { type: PrincipalType; id: string; label?: string | null }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <PrincipalIcon type={type} />
      <span className="truncate">{label ?? <span className="font-mono text-xs text-ink-muted">{id}</span>}</span>
      <span className="sr-only">({PRINCIPAL_TYPE_LABELS[type]})</span>
    </span>
  );
}

/**
 * Choix d'un principal (utilisateur / rôle / département). Les annuaires ne sont interrogés que
 * si l'utilisateur dispose des droits de lecture correspondants ; à défaut (ou sur 403), un
 * identifiant peut être collé — le serveur vérifie son existence.
 */
export function PrincipalPicker({
  types = ['USER', 'ROLE', 'DEPARTMENT'],
  onAdd,
  exclude = [],
  addLabel = 'Ajouter',
}: {
  types?: PrincipalType[];
  onAdd: (p: PickedPrincipal) => void;
  exclude?: string[];
  addLabel?: string;
}) {
  const { canAny } = useSession();
  const ids = { type: useId(), search: useId(), pick: useId(), paste: useId() };
  const [type, setType] = useState<PrincipalType>(types[0]);
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState('');
  const [pasted, setPasted] = useState('');

  // Annuaire minimal /reference/directory (libellés seulement) : accessible aux profils qui partagent / gèrent des ACL
  const canDirectory = canAny(
    'users.view',
    'roles.view',
    'departments.view',
    'cso.share',
    'cso.folder.acl_manage',
    'cso.categories.manage',
    'certificates.types.manage',
    'notifications.rules.manage',
  );
  const directory = useQuery({
    queryKey: ['reference', 'directory', type, type === 'USER' ? search : ''],
    queryFn: () =>
      api.get<{ id: string; label: string }[]>('/reference/directory', { query: { type, search: type === 'USER' ? search : undefined } }),
    enabled: canDirectory && (type !== 'USER' || search.trim().length >= 2),
    retry: false,
    staleTime: type === 'USER' ? 15_000 : 300_000,
  });

  const forbidden = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 401);
  const directoryAvailable = canDirectory && !forbidden(directory.error);

  const options: { id: string; label: string }[] = directory.data ?? [];
  const available = options.filter((o) => !exclude.includes(`${type}:${o.id}`));

  const pastedValid = UUID_RE.test(pasted.trim());

  function add(id: string, label: string | null) {
    onAdd({ principalType: type, principalId: id, label });
    setPicked('');
    setPasted('');
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      {types.length > 1 && (
        <Field label="Type" htmlFor={ids.type} className="w-40">
          <Select
            id={ids.type}
            value={type}
            onChange={(e) => {
              setType(e.target.value as PrincipalType);
              setPicked('');
            }}
          >
            {types.map((t) => (
              <option key={t} value={t}>
                {PRINCIPAL_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {directoryAvailable ? (
        <>
          {type === 'USER' && (
            <Field label="Rechercher" htmlFor={ids.search} className="min-w-[160px] flex-1">
              <Input id={ids.search} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Nom, identifiant, e-mail…" />
            </Field>
          )}
          <Field label={PRINCIPAL_TYPE_LABELS[type]} htmlFor={ids.pick} className="min-w-[200px] flex-1">
            <Select id={ids.pick} value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">
                {type === 'USER' && search.trim().length < 2 ? 'Saisir 2 caractères…' : available.length ? 'Choisir…' : 'Aucun résultat'}
              </option>
              {available.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button variant="secondary" disabled={!picked} onClick={() => add(picked, options.find((o) => o.id === picked)?.label ?? null)}>
            <Plus className="h-4 w-4" aria-hidden /> {addLabel}
          </Button>
        </>
      ) : (
        <>
          <Field
            label={`Identifiant ${PRINCIPAL_TYPE_LABELS[type].toLowerCase()}`}
            htmlFor={ids.paste}
            className="min-w-[260px] flex-1"
            error={pasted && !pastedValid ? 'Identifiant invalide (UUID attendu)' : undefined}
          >
            <Input id={ids.paste} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="font-mono text-sm" />
          </Field>
          <Button variant="secondary" disabled={!pastedValid} onClick={() => add(pasted.trim().toLowerCase(), null)}>
            <Plus className="h-4 w-4" aria-hidden /> {addLabel}
          </Button>
          <p className="field-hint mt-0 w-full">Annuaire non consultable avec vos droits : collez l&apos;identifiant (UUID) fourni par un administrateur.</p>
        </>
      )}
    </div>
  );
}
