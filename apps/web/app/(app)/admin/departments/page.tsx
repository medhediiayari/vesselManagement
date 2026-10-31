'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PermissionGate } from '@/components/amc/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Select } from '@/components/ui/field';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import type { DepartmentDto, UserListItem } from '../types';

interface DeptMember {
  id: string;
  displayName: string;
  username: string;
  status: string;
  jobTitle: string | null;
  isPrimary: boolean;
}

/** Départements (ADM-024..029) : responsable principal, adjoints, désactivation sans perte. */
export default function DepartmentsPage() {
  const { canAny, can } = useSession();
  const qc = useQueryClient();
  const allowed = canAny('departments.view', 'departments.manage', 'users.view');
  const list = useQuery({ queryKey: ['departments'], queryFn: () => api.get<DepartmentDto[]>('/departments'), enabled: allowed });
  const users = useQuery({
    queryKey: ['users', 'all-active'],
    queryFn: () => api.get<{ items: UserListItem[] }>('/users', { query: { status: 'ACTIVE', limit: 200 } }),
    enabled: can('users.view') && can('departments.manage'),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const members = useQuery({
    queryKey: ['department-members', selected],
    queryFn: () => api.get<DeptMember[]>(`/departments/${selected}/members`),
    enabled: !!selected,
  });
  const [editing, setEditing] = useState<DepartmentDto | 'new' | null>(null);
  const [form, setForm] = useState({ code: '', name: '', primaryManagerId: '', deputyIds: [] as string[] });
  const [toggle, setToggle] = useState<DepartmentDto | null>(null);

  if (!allowed) return <Forbidden />;
  if (list.isLoading) return <LoadingBlock rows={6} />;
  if (list.error) return <ErrorState error={list.error} />;
  const current = list.data?.find((d) => d.id === selected);

  function openEdit(d: DepartmentDto | 'new') {
    setEditing(d);
    setForm(
      d === 'new'
        ? { code: '', name: '', primaryManagerId: '', deputyIds: [] }
        : { code: d.code, name: d.name, primaryManagerId: d.primaryManager?.id ?? '', deputyIds: d.deputies.map((x) => x.id) },
    );
  }

  async function save() {
    try {
      if (editing === 'new') {
        await api.post('/departments', { code: form.code, name: form.name, primaryManagerId: form.primaryManagerId || null, deputyIds: form.deputyIds });
      } else if (editing) {
        await api.patch(`/departments/${editing.id}`, { name: form.name, primaryManagerId: form.primaryManagerId || null, deputyIds: form.deputyIds });
      }
      toast.success('Département enregistré');
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['departments'] });
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  return (
    <>
      <PageHeader
        title="Départements"
        description="Un utilisateur a un département principal et des secondaires. Responsables et adjoints conservent leurs propres droits, sans héritage automatique."
        actions={
          <PermissionGate allOf={['departments.manage']}>
            <Button onClick={() => openEdit('new')}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau département
            </Button>
          </PermissionGate>
        }
      />
      {/* Détail en colonne fixe : la table absorbe la largeur disponible, le panneau reste lisible et visible au défilement. */}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="overflow-x-auto rounded-lg bg-white shadow-panel">
          <table className="table-amc">
            <thead>
              <tr><th>Département</th><th>Responsable</th><th className="hidden md:table-cell">Adjoints</th><th>Membres</th><th>Statut</th></tr>
            </thead>
            <tbody>
              {list.data?.map((d) => (
                <tr key={d.id} className="cursor-pointer" data-selected={selected === d.id || undefined} onClick={() => setSelected(d.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSelected(d.id)}>
                  <td><span className="font-medium text-navy">{d.name}</span><span className="block text-xs text-ink-muted">{d.code}</span></td>
                  <td>{d.primaryManager?.displayName ?? '—'}</td>
                  <td className="hidden md:table-cell">{d.deputies.map((x) => x.displayName).join(', ') || '—'}</td>
                  <td className="tabular">{d.memberCount}</td>
                  <td>{d.status === 'ACTIVE' ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {current ? (
          <Panel
            className="xl:sticky xl:top-20"
            title={current.name}
            actions={
              <PermissionGate allOf={['departments.manage']}>
                <Button size="sm" variant="secondary" onClick={() => setToggle(current)}>
                  {current.status === 'ACTIVE' ? 'Désactiver' : 'Réactiver'}
                </Button>
                <Button size="sm" onClick={() => openEdit(current)}>Modifier</Button>
              </PermissionGate>
            }
          >
            {current.status === 'INACTIVE' && (
              <p className="mb-3 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-muted">
                Département inactif : affectations et historique conservés, aucune nouvelle affectation possible.
              </p>
            )}
            <DefinitionGrid
              items={[
                ['Code', current.code],
                ['Statut', current.status === 'ACTIVE' ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>],
                ['Responsable principal', current.primaryManager?.displayName ?? 'Non désigné'],
                ['Adjoints', current.deputies.map((x) => x.displayName).join(', ') || 'Aucun'],
              ]}
            />
            <h3 className="mb-1 mt-5 border-t border-line pt-4 text-sm font-semibold text-navy">
              Membres <span className="font-normal text-ink-muted">({current.memberCount})</span>
            </h3>
            {members.isLoading && <LoadingBlock rows={3} />}
            {members.error && <ErrorState error={members.error} onRetry={() => members.refetch()} />}
            {members.data && members.data.length === 0 && (
              <p className="py-2 text-sm text-ink-muted">Aucun utilisateur rattaché à ce département.</p>
            )}
            <ul className="divide-y divide-line">
              {members.data?.map((m) => (
                <li key={m.id} className="flex items-center justify-between py-2 text-sm">
                  <span>
                    {/* Lien vers la fiche seulement avec le droit de la consulter (ADM-30) */}
                    {can('users.view') ? (
                      <a href={`/admin/users/${m.id}`} className="font-medium text-action hover:underline">{m.displayName}</a>
                    ) : (
                      <span className="font-medium text-ink">{m.displayName}</span>
                    )}
                    <span className="block text-xs text-ink-muted">{m.jobTitle ?? m.username}</span>
                  </span>
                  {m.isPrimary ? <Badge tone="teal" icon={false}>Principal</Badge> : <Badge tone="neutral" icon={false}>Secondaire</Badge>}
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <EmptyState
            className="rounded-lg bg-white shadow-panel xl:sticky xl:top-20"
            title="Sélectionnez un département"
            description="Ses membres et responsables s’affichent ici."
          />
        )}
      </div>

      <Dialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        title={editing === 'new' ? 'Nouveau département' : 'Modifier le département'}
        footer={<Button onClick={save} disabled={!form.name || (editing === 'new' && !form.code)}>Enregistrer</Button>}
      >
        <div className="space-y-3">
          <Field label="Code" required htmlFor="d-code">
            <Input id="d-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} disabled={editing !== 'new'} />
          </Field>
          <Field label="Nom" required htmlFor="d-name">
            <Input id="d-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="Responsable principal" htmlFor="d-mgr">
            <Select id="d-mgr" value={form.primaryManagerId} onChange={(e) => setForm({ ...form, primaryManagerId: e.target.value })}>
              <option value="">Aucun</option>
              {users.data?.items.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </Select>
          </Field>
          <fieldset>
            <legend className="field-label">Adjoints</legend>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-line p-2">
              {users.data?.items.filter((u) => u.id !== form.primaryManagerId).map((u) => (
                <label key={u.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={form.deputyIds.includes(u.id)}
                    onChange={(e) => setForm({ ...form, deputyIds: e.target.checked ? [...form.deputyIds, u.id] : form.deputyIds.filter((x) => x !== u.id) })}
                  />
                  {u.displayName}
                </label>
              ))}
            </div>
          </fieldset>
        </div>
      </Dialog>
      <ConfirmDialog
        open={!!toggle}
        onOpenChange={(o) => !o && setToggle(null)}
        title={toggle?.status === 'ACTIVE' ? `Désactiver ${toggle?.name} ?` : `Réactiver ${toggle?.name} ?`}
        description={toggle?.status === 'ACTIVE' ? 'Les affectations existantes sont conservées ; aucune nouvelle affectation ne sera possible.' : undefined}
        confirmLabel={toggle?.status === 'ACTIVE' ? 'Désactiver' : 'Réactiver'}
        onConfirm={async () => {
          await api.post(`/departments/${toggle!.id}/${toggle!.status === 'ACTIVE' ? 'deactivate' : 'reactivate'}`, {});
          qc.invalidateQueries({ queryKey: ['departments'] });
        }}
      />
    </>
  );
}
