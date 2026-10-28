'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn } from '@/lib/format';
import { useSession } from '@/lib/session';
import { PermissionGate } from '@/components/amc/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Field, Input, Textarea } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { MODULE_LABELS, type PermissionDto, type RoleDto } from '../types';

/** Rôles prédéfinis personnalisables + matrice de permissions (ADM-020..023). */
export default function RolesPage() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleDto[]>('/roles'), enabled: can('roles.view') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<PermissionDto[]>('/permissions'), enabled: can('roles.view') });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState({ name: '', description: '' });
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ key: '', name: '', description: '' });
  const [deleting, setDeleting] = useState(false);
  const [saving, setSaving] = useState(false);

  const selected = roles.data?.find((r) => r.id === selectedId) ?? roles.data?.[0];
  useEffect(() => {
    if (!selected) return;
    setDraft(new Set(selected.isSystem ? perms.data?.map((p) => p.key) ?? [] : selected.permissions));
    setMeta({ name: selected.name, description: selected.description ?? '' });
  }, [selected, perms.data]);

  const byModule = useMemo(() => {
    const m = new Map<string, PermissionDto[]>();
    perms.data?.forEach((p) => m.set(p.module, [...(m.get(p.module) ?? []), p]));
    return [...m.entries()];
  }, [perms.data]);
  const mine = new Set(me.permissions);

  if (!can('roles.view')) return <Forbidden />;
  if (roles.isLoading || perms.isLoading) return <LoadingBlock rows={10} />;
  if (roles.error || perms.error) return <ErrorState error={roles.error ?? perms.error} />;

  const editable = !!selected && !selected.isSystem && can('roles.manage');
  const dirty =
    !!selected &&
    !selected.isSystem &&
    (meta.name !== selected.name ||
      meta.description !== (selected.description ?? '') ||
      draft.size !== selected.permissions.length ||
      selected.permissions.some((p) => !draft.has(p)));

  async function save() {
    if (!selected) return;
    setSaving(true);
    try {
      await api.patch(`/roles/${selected.id}`, { name: meta.name, description: meta.description || null, permissions: [...draft] });
      toast.success('Rôle enregistré — effet immédiat pour ses titulaires');
      await qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (e) {
      const missing = e instanceof ApiError ? (e.details as { missing?: string[] } | undefined)?.missing : undefined;
      toast.error(missing ? `${errorMessage(e)} : ${missing.join(', ')}` : errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Rôles & permissions"
        description="Un utilisateur cumule les permissions de ses rôles ; ses exceptions individuelles restent prioritaires. Modifier un rôle s'applique immédiatement à tous ses titulaires."
        actions={
          <PermissionGate allOf={['roles.manage']}>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau rôle
            </Button>
          </PermissionGate>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[280px_minmax(0,1fr)]">
        <nav aria-label="Rôles" className="panel h-fit p-1">
          <ul>
            {roles.data?.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(r.id)}
                  aria-current={selected?.id === r.id ? 'true' : undefined}
                  className={cn('flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-navy-50', selected?.id === r.id && 'bg-action-50 font-medium text-navy')}
                >
                  <span className="flex items-center gap-1.5 truncate">
                    {r.isSystem && <Lock className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-label="Rôle système" />}
                    {r.name}
                  </span>
                  <span className="text-xs tabular text-ink-muted">{r.userCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        {selected && (
          <Panel
            title={selected.name}
            actions={
              editable && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(true)} disabled={selected.userCount > 0} title={selected.userCount > 0 ? 'Rôle encore attribué : suppression impossible' : undefined}>
                    <Trash2 className="h-4 w-4" aria-hidden /> Supprimer
                  </Button>
                  <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>Enregistrer</Button>
                </>
              )
            }
          >
            {selected.isSystem ? (
              <p className="mb-4 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-muted">
                Rôle système protégé : il dispose de toutes les permissions et ne peut être ni modifié ni supprimé. Un refus individuel reste prioritaire.
              </p>
            ) : (
              <div className="mb-4 grid gap-3 sm:grid-cols-2">
                <Field label="Nom" htmlFor="r-name">
                  <Input id="r-name" value={meta.name} onChange={(e) => setMeta({ ...meta, name: e.target.value })} disabled={!editable} />
                </Field>
                <Field label="Clé" htmlFor="r-key">
                  <Input id="r-key" value={selected.key} disabled />
                </Field>
                <Field label="Description" className="sm:col-span-2" htmlFor="r-desc">
                  <Textarea id="r-desc" rows={2} value={meta.description} onChange={(e) => setMeta({ ...meta, description: e.target.value })} disabled={!editable} />
                </Field>
              </div>
            )}
            <div className="grid gap-5 md:grid-cols-2 2xl:grid-cols-3">
              {byModule.map(([mod, list]) => {
                const all = list.every((p) => draft.has(p.key));
                return (
                  <fieldset key={mod} className="rounded-md border border-line p-3">
                    <legend className="px-1 text-sm font-semibold text-navy">{MODULE_LABELS[mod] ?? mod}</legend>
                    {editable && (
                      <button
                        type="button"
                        className="mb-1 text-xs text-action hover:underline"
                        onClick={() => {
                          const n = new Set(draft);
                          list.forEach((p) => (all ? n.delete(p.key) : mine.has(p.key) && n.add(p.key)));
                          setDraft(n);
                        }}
                      >
                        {all ? 'Tout retirer' : 'Tout cocher (dans la limite de vos droits)'}
                      </button>
                    )}
                    <ul className="space-y-1">
                      {list.map((p) => {
                        const grantable = mine.has(p.key);
                        return (
                          <li key={p.key}>
                            <label className={cn('flex items-start gap-2 text-sm', !editable && 'cursor-default')}>
                              <input
                                type="checkbox"
                                className="mt-0.5 h-4 w-4 rounded border-line-strong"
                                checked={draft.has(p.key)}
                                disabled={!editable || (!grantable && !draft.has(p.key))}
                                onChange={(e) => {
                                  const n = new Set(draft);
                                  if (e.target.checked) n.add(p.key);
                                  else n.delete(p.key);
                                  setDraft(n);
                                }}
                              />
                              <span>
                                {p.label}
                                <span className="block text-xs text-ink-soft">{p.key}</span>
                              </span>
                              {p.isSensitive && <Badge tone="warn" icon={false} className="ml-auto">Sensible</Badge>}
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  </fieldset>
                );
              })}
            </div>
          </Panel>
        )}
      </div>

      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="Nouveau rôle"
        description="Les permissions se configurent ensuite dans la matrice."
        footer={
          <Button
            disabled={!newRole.key || !newRole.name}
            onClick={async () => {
              try {
                const r = await api.post<RoleDto>('/roles', { ...newRole, description: newRole.description || undefined, permissions: [] });
                await qc.invalidateQueries({ queryKey: ['roles'] });
                setSelectedId(r.id);
                setCreating(false);
                setNewRole({ key: '', name: '', description: '' });
                toast.success('Rôle créé');
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
          >
            Créer
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label="Clé" required hint="Majuscules, chiffres, _ (ex. SECOND_CAPTAIN)" htmlFor="nr-key">
            <Input id="nr-key" value={newRole.key} onChange={(e) => setNewRole({ ...newRole, key: e.target.value.toUpperCase() })} />
          </Field>
          <Field label="Nom" required htmlFor="nr-name">
            <Input id="nr-name" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} />
          </Field>
          <Field label="Description" htmlFor="nr-desc">
            <Textarea id="nr-desc" rows={2} value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
          </Field>
        </div>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Supprimer le rôle ${selected?.name} ?`}
        confirmLabel="Supprimer"
        tone="danger"
        onConfirm={async () => {
          await api.delete(`/roles/${selected!.id}`);
          setSelectedId(null);
          await qc.invalidateQueries({ queryKey: ['roles'] });
        }}
      />
    </>
  );
}
