'use client';

import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { PermissionGate } from '@/components/amc/permission-gate';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { Forbidden, LoadingBlock } from '@/components/ui/states';
import type { DepartmentDto, RoleDto, UserListItem } from '../types';
import { TemporaryPasswordNotice, UserStatusBadges } from './user-widgets';

function CreateUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; onCreated: () => void }) {
  const { me } = useSession();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleDto[]>('/roles') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get<DepartmentDto[]>('/departments') });
  const [form, setForm] = useState({ username: '', email: '', emailVerified: false, displayName: '', jobTitle: '' });
  const [roleIds, setRoleIds] = useState<string[]>([]);
  const [scope, setScope] = useState<'ALL_FLEET' | 'SELECTED'>('SELECTED');
  const [vesselIds, setVesselIds] = useState<string[]>([]);
  const [primaryDept, setPrimaryDept] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setErrors({});
    setFormError(null);
    try {
      const res = await api.post<{ temporaryPassword: string }>('/users', {
        username: form.username,
        email: form.email || undefined,
        emailVerified: form.emailVerified,
        displayName: form.displayName,
        jobTitle: form.jobTitle || undefined,
        roleIds,
        vesselScope: { mode: scope, vesselIds: scope === 'SELECTED' ? vesselIds : [] },
        departments: primaryDept ? { primaryId: primaryDept, secondaryIds: [] } : undefined,
      });
      setTemp(res.temporaryPassword);
      onCreated();
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        const missing = (e.details as { missing?: string[] } | undefined)?.missing;
        setFormError(missing ? `${e.message} (${missing.slice(0, 6).join(', ')}${missing.length > 6 ? '…' : ''})` : e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setTemp(null);
        onOpenChange(o);
      }}
      title="Nouveau compte"
      description="Le compte est créé avec un mot de passe temporaire à changer à la première connexion."
      size="lg"
      footer={
        temp ? (
          <Button onClick={() => onOpenChange(false)}>Terminer</Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>Annuler</Button>
            <Button onClick={submit} loading={busy} disabled={!form.username || !form.displayName}>Créer le compte</Button>
          </>
        )
      }
    >
      {temp ? (
        <TemporaryPasswordNotice password={temp} />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Identifiant" required error={errors.username} htmlFor="u-username" hint="a-z, 0-9, . _ -">
              <Input id="u-username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} invalid={!!errors.username} />
            </Field>
            <Field label="Nom affiché" required error={errors.displayName} htmlFor="u-name">
              <Input id="u-name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} />
            </Field>
            <Field label="E-mail" error={errors.email} htmlFor="u-email">
              <Input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="Fonction" htmlFor="u-job">
              <Input id="u-job" value={form.jobTitle} onChange={(e) => setForm({ ...form, jobTitle: e.target.value })} />
            </Field>
          </div>
          <Checkbox
            label="Adresse e-mail vérifiée"
            description="Autorise la récupération du mot de passe par lien à usage unique (ADM-009)."
            checked={form.emailVerified}
            onChange={(e) => setForm({ ...form, emailVerified: e.target.checked })}
          />
          <fieldset>
            <legend className="field-label">Rôles (cumulables)</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {roles.data?.map((r) => (
                <Checkbox
                  key={r.id}
                  label={r.name}
                  description={r.description ?? undefined}
                  checked={roleIds.includes(r.id)}
                  onChange={(e) => setRoleIds(e.target.checked ? [...roleIds, r.id] : roleIds.filter((x) => x !== r.id))}
                />
              ))}
            </div>
            <p className="field-hint">Vous ne pouvez attribuer que des droits que vous possédez vous-même.</p>
          </fieldset>
          <fieldset>
            <legend className="field-label">Périmètre navires</legend>
            <div className="flex gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={scope === 'ALL_FLEET'} onChange={() => setScope('ALL_FLEET')} disabled={me.vesselScope !== 'ALL_FLEET'} />
                Toute la flotte (y compris futurs navires)
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={scope === 'SELECTED'} onChange={() => setScope('SELECTED')} /> Navires sélectionnés
              </label>
            </div>
            {scope === 'SELECTED' && (
              <div className="mt-2 grid gap-1 sm:grid-cols-2">
                {me.accessibleVessels.map((v) => (
                  <Checkbox
                    key={v.id}
                    label={v.name}
                    description={v.code}
                    checked={vesselIds.includes(v.id)}
                    onChange={(e) => setVesselIds(e.target.checked ? [...vesselIds, v.id] : vesselIds.filter((x) => x !== v.id))}
                  />
                ))}
              </div>
            )}
          </fieldset>
          <Field label="Département principal" htmlFor="u-dept">
            <Select id="u-dept" value={primaryDept} onChange={(e) => setPrimaryDept(e.target.value)}>
              <option value="">Aucun</option>
              {depts.data?.filter((d) => d.status === 'ACTIVE').map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </Select>
          </Field>
          {formError && <p className="rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">{formError}</p>}
        </div>
      )}
    </Dialog>
  );
}

export default function UsersPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <UsersList />
    </Suspense>
  );
}

/** `?status=LOCKED` (lien du tableau de bord) pré-filtre la liste. */
function UsersList() {
  const router = useRouter();
  const params = useSearchParams();
  const { can } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState(() => params.get('status') ?? '');
  const [creating, setCreating] = useState(false);
  const list = useCursorList<UserListItem>(['users'], '/users', { search: search || undefined, status: status || undefined }, can('users.view'));
  if (!can('users.view')) return <Forbidden />;
  return (
    <>
      <PageHeader
        title="Utilisateurs"
        description="Comptes de connexion, rôles cumulables, exceptions individuelles et périmètre navires. Les changements s'appliquent dès la requête suivante."
        actions={
          <PermissionGate allOf={['users.create']}>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau compte
            </Button>
          </PermissionGate>
        }
      />
      <FilterBar>
        <div className="w-full max-w-xs">
          <label className="field-label" htmlFor="us-search">Recherche</label>
          <Input id="us-search" placeholder="Nom, identifiant, e-mail" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="w-44">
          <label className="field-label" htmlFor="us-status">Statut</label>
          <Select id="us-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>
            <option value="ACTIVE">Actifs</option>
            <option value="LOCKED">Verrouillés</option>
            <option value="DEACTIVATED">Désactivés</option>
          </Select>
        </div>
      </FilterBar>
      <DataTable
        caption="Utilisateurs"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        onRowClick={(u) => router.push(`/admin/users/${u.id}`)}
        columns={[
          {
            key: 'name',
            header: 'Utilisateur',
            cell: (u) => (
              <div>
                <p className="font-medium text-navy">{u.displayName}</p>
                <p className="text-xs text-ink-muted">{u.username}{u.email ? ` — ${u.email}` : ''}</p>
              </div>
            ),
          },
          { key: 'roles', header: 'Rôles', cell: (u) => u.roles.map((r) => r.name).join(', ') || '—', hideBelow: 'md' },
          { key: 'scope', header: 'Navires', cell: (u) => (u.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : 'Sélection'), hideBelow: 'lg' },
          { key: 'dept', header: 'Département', cell: (u) => u.departments.find((d) => d.isPrimary)?.name ?? '—', hideBelow: 'lg' },
          { key: 'last', header: 'Dernière connexion', cell: (u) => <span className="tabular">{fmtDateTime(u.lastLoginAt)}</span>, hideBelow: 'md' },
          { key: 'status', header: 'Statut', cell: (u) => <UserStatusBadges u={u} /> },
        ]}
      />
      {creating && <CreateUserDialog open={creating} onOpenChange={setCreating} onCreated={() => list.refetch()} />}
    </>
  );
}
