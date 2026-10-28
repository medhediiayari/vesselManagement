'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Lock, LogOut, RotateCcw, ShieldCheck, Trash2, Unlock } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/format';
import { useAction } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { AuditTimeline } from '@/components/amc/audit-timeline';
import { PermissionGate } from '@/components/amc/permission-gate';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MODULE_LABELS, type DepartmentDto, type PermissionDto, type RoleDto, type UserDetail } from '../../types';
import { TemporaryPasswordNotice, UserStatusBadges } from '../user-widgets';

interface SessionRow {
  id: string;
  deviceLabel: string | null;
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const user = useQuery({ queryKey: ['user', id], queryFn: () => api.get<UserDetail>(`/users/${id}`) });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleDto[]>('/roles'), enabled: can('roles.view') || can('users.edit') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => api.get<PermissionDto[]>('/permissions') });
  const depts = useQuery({ queryKey: ['departments'], queryFn: () => api.get<DepartmentDto[]>('/departments') });
  const sessions = useQuery({
    queryKey: ['user-sessions', id],
    queryFn: () => api.get<SessionRow[]>(`/users/${id}/sessions`),
    enabled: can('sessions.view'),
  });

  const [temp, setTemp] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<null | 'deactivate' | 'reactivate' | 'unlock' | 'reset' | 'revokeAll'>(null);
  const [roleSel, setRoleSel] = useState<string[]>([]);
  const [overrides, setOverrides] = useState<{ permissionKey: string; effect: 'ALLOW' | 'DENY'; reason?: string }[]>([]);
  const [scope, setScope] = useState<'ALL_FLEET' | 'SELECTED'>('SELECTED');
  const [vesselIds, setVesselIds] = useState<string[]>([]);
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState<string[]>([]);
  const [newOverride, setNewOverride] = useState({ permissionKey: '', effect: 'DENY' as 'ALLOW' | 'DENY', reason: '' });
  const [profile, setProfile] = useState({ displayName: '', email: '', jobTitle: '', emailVerified: false });
  const [memberOpen, setMemberOpen] = useState(false);
  const [memberId, setMemberId] = useState('');

  useEffect(() => {
    const u = user.data;
    if (!u) return;
    setRoleSel(u.roles.map((r) => r.id));
    setOverrides(u.overrides.map((o) => ({ permissionKey: o.permissionKey, effect: o.effect, reason: o.reason ?? undefined })));
    setScope(u.vesselScope);
    setVesselIds(u.vessels.map((v) => v.id));
    setPrimary(u.departments.find((d) => d.isPrimary)?.id ?? '');
    setSecondary(u.departments.filter((d) => !d.isPrimary).map((d) => d.id));
    setProfile({ displayName: u.displayName, email: u.email ?? '', jobTitle: u.jobTitle ?? '', emailVerified: !!u.emailVerifiedAt });
  }, [user.data]);

  const invalidate = [['user', id], ['users']];
  const saveProfile = useAction(
    () => api.patch(`/users/${id}`, { displayName: profile.displayName, email: profile.email || null, jobTitle: profile.jobTitle || null, emailVerified: profile.emailVerified }),
    { success: 'Profil enregistré', invalidate },
  );
  const saveRoles = useAction(() => api.put(`/users/${id}/roles`, { roleIds: roleSel }), { success: 'Rôles mis à jour — effet immédiat', invalidate });
  const saveOverrides = useAction(() => api.put(`/users/${id}/overrides`, { overrides }), { success: 'Exceptions mises à jour — effet immédiat', invalidate });
  const saveScope = useAction(() => api.put(`/users/${id}/vessel-scope`, { mode: scope, vesselIds: scope === 'SELECTED' ? vesselIds : [] }), {
    success: 'Périmètre navires mis à jour',
    invalidate,
  });
  const saveDepts = useAction(() => api.put(`/users/${id}/departments`, { primaryId: primary || null, secondaryIds: secondary.filter((d) => d !== primary) }), {
    success: 'Départements mis à jour',
    invalidate,
  });
  const linkMember = useAction((mid: string | null) => api.put(`/users/${id}/member`, { memberId: mid }), {
    success: 'Lien Member mis à jour',
    invalidate,
    onSuccess: () => setMemberOpen(false),
  });

  const permsByModule = useMemo(() => {
    const m = new Map<string, PermissionDto[]>();
    perms.data?.forEach((p) => m.set(p.module, [...(m.get(p.module) ?? []), p]));
    return [...m.entries()];
  }, [perms.data]);

  if (user.isLoading) return <LoadingBlock rows={10} />;
  if (user.error || !user.data) return <ErrorState error={user.error} onRetry={() => user.refetch()} />;
  const u = user.data;
  const isSelf = u.id === me.id;
  const effective = new Set(u.effectivePermissions);

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Utilisateurs', href: '/admin/users' }, { label: u.displayName }]}
        title={u.displayName}
        description={`${u.username}${u.email ? ` — ${u.email}` : ''}${u.jobTitle ? ` — ${u.jobTitle}` : ''}`}
        meta={<UserStatusBadges u={u} />}
        actions={
          <>
            {u.locked && (
              <PermissionGate allOf={['users.unlock']}>
                <Button onClick={() => setConfirm('unlock')}>
                  <Unlock className="h-4 w-4" aria-hidden /> Déverrouiller
                </Button>
              </PermissionGate>
            )}
            <PermissionGate allOf={['users.reset_password']}>
              <Button variant="secondary" onClick={() => setConfirm('reset')}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Mot de passe temporaire
              </Button>
            </PermissionGate>
            {!isSelf && (
              <PermissionGate allOf={['users.deactivate']}>
                {u.status === 'ACTIVE' ? (
                  <Button variant="danger" onClick={() => setConfirm('deactivate')}>
                    <Ban className="h-4 w-4" aria-hidden /> Désactiver
                  </Button>
                ) : (
                  <Button variant="secondary" onClick={() => setConfirm('reactivate')}>Réactiver</Button>
                )}
              </PermissionGate>
            )}
          </>
        }
      />
      {temp && (
        <div className="mb-4">
          <TemporaryPasswordNotice password={temp} />
        </div>
      )}

      <Tabs defaultValue="access">
        <TabsList className="mb-4">
          <TabsTrigger value="access">Rôles & droits</TabsTrigger>
          <TabsTrigger value="scope">Navires & départements</TabsTrigger>
          <TabsTrigger value="profile">Profil</TabsTrigger>
          {can('sessions.view') && <TabsTrigger value="sessions" count={u.activeSessions}>Sessions</TabsTrigger>}
          {can('audit.view.admin') && <TabsTrigger value="history">Historique</TabsTrigger>}
        </TabsList>

        <TabsContent value="access" className="grid gap-5 xl:grid-cols-2">
          <Panel
            title="Rôles cumulés"
            actions={
              <PermissionGate allOf={['users.edit']}>
                <Button size="sm" onClick={() => saveRoles.mutate(undefined)} loading={saveRoles.isPending}>Enregistrer</Button>
              </PermissionGate>
            }
          >
            <div className="space-y-2">
              {roles.data?.map((r) => (
                <Checkbox
                  key={r.id}
                  label={r.name}
                  description={r.description ?? undefined}
                  checked={roleSel.includes(r.id)}
                  disabled={!can('users.edit')}
                  onChange={(e) => setRoleSel(e.target.checked ? [...roleSel, r.id] : roleSel.filter((x) => x !== r.id))}
                />
              ))}
            </div>
          </Panel>
          <Panel
            title="Exceptions individuelles"
            actions={
              <PermissionGate allOf={['permissions.manage']}>
                <Button size="sm" onClick={() => saveOverrides.mutate(undefined)} loading={saveOverrides.isPending}>Enregistrer</Button>
              </PermissionGate>
            }
          >
            <p className="mb-3 text-sm text-ink-muted">Priorité : un refus (DENY) l’emporte sur toute autorisation, y compris celles des rôles.</p>
            <ul className="mb-3 space-y-1.5">
              {overrides.map((o, i) => (
                <li key={o.permissionKey} className="flex items-center gap-2 rounded-md border border-line px-2 py-1.5">
                  <Badge tone={o.effect === 'DENY' ? 'danger' : 'ok'}>{o.effect === 'DENY' ? 'Refusé' : 'Autorisé'}</Badge>
                  <code className="text-xs">{o.permissionKey}</code>
                  <span className="truncate text-xs text-ink-muted">{o.reason}</span>
                  <PermissionGate allOf={['permissions.manage']}>
                    <IconButton label="Retirer l'exception" className="ml-auto" onClick={() => setOverrides(overrides.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </PermissionGate>
                </li>
              ))}
              {!overrides.length && <li className="text-sm text-ink-muted">Aucune exception.</li>}
            </ul>
            <PermissionGate allOf={['permissions.manage']}>
              <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                <Select aria-label="Permission" value={newOverride.permissionKey} onChange={(e) => setNewOverride({ ...newOverride, permissionKey: e.target.value })}>
                  <option value="">Choisir une permission…</option>
                  {permsByModule.map(([mod, list]) => (
                    <optgroup key={mod} label={MODULE_LABELS[mod] ?? mod}>
                      {list.filter((p) => !overrides.some((o) => o.permissionKey === p.key)).map((p) => (
                        <option key={p.key} value={p.key}>{p.key} — {p.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
                <Select aria-label="Effet" value={newOverride.effect} onChange={(e) => setNewOverride({ ...newOverride, effect: e.target.value as 'ALLOW' | 'DENY' })}>
                  <option value="DENY">Refuser</option>
                  <option value="ALLOW">Autoriser</option>
                </Select>
                <Input placeholder="Motif (recommandé)" value={newOverride.reason} onChange={(e) => setNewOverride({ ...newOverride, reason: e.target.value })} aria-label="Motif" />
                <Button
                  variant="secondary"
                  disabled={!newOverride.permissionKey}
                  onClick={() => {
                    setOverrides([...overrides, { permissionKey: newOverride.permissionKey, effect: newOverride.effect, reason: newOverride.reason || undefined }]);
                    setNewOverride({ permissionKey: '', effect: 'DENY', reason: '' });
                  }}
                >
                  Ajouter
                </Button>
              </div>
            </PermissionGate>
          </Panel>
          <Panel title={`Permissions effectives (${effective.size})`} className="xl:col-span-2">
            <p className="mb-3 text-sm text-ink-muted">Résultat calculé par le serveur : union des rôles + exceptions, DENY prioritaire.</p>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {permsByModule.map(([mod, list]) => (
                <div key={mod}>
                  <p className="mb-1 text-sm font-semibold text-navy">{MODULE_LABELS[mod] ?? mod}</p>
                  <ul className="space-y-0.5">
                    {list.map((p) => (
                      <li key={p.key} className={cn('flex items-start gap-1.5 text-xs', effective.has(p.key) ? 'text-ink' : 'text-ink-soft line-through')}>
                        {effective.has(p.key) ? <ShieldCheck className="mt-0.5 h-3 w-3 shrink-0 text-ok" aria-label="accordée" /> : <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-label="non accordée" />}
                        <span title={p.key}>{p.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="scope" className="grid gap-5 xl:grid-cols-2">
          <Panel
            title="Périmètre navires"
            actions={
              <PermissionGate allOf={['users.edit']}>
                <Button size="sm" onClick={() => saveScope.mutate(undefined)} loading={saveScope.isPending}>Enregistrer</Button>
              </PermissionGate>
            }
          >
            <div className="mb-3 flex flex-col gap-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={scope === 'ALL_FLEET'} onChange={() => setScope('ALL_FLEET')} disabled={!can('users.edit') || me.vesselScope !== 'ALL_FLEET'} />
                Toute la flotte — inclut automatiquement les navires créés plus tard
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" checked={scope === 'SELECTED'} onChange={() => setScope('SELECTED')} disabled={!can('users.edit')} />
                Navires sélectionnés uniquement
              </label>
            </div>
            {scope === 'SELECTED' && (
              <div className="grid gap-1 sm:grid-cols-2">
                {me.accessibleVessels.map((v) => (
                  <Checkbox
                    key={v.id}
                    label={v.name}
                    description={v.code}
                    checked={vesselIds.includes(v.id)}
                    disabled={!can('users.edit')}
                    onChange={(e) => setVesselIds(e.target.checked ? [...vesselIds, v.id] : vesselIds.filter((x) => x !== v.id))}
                  />
                ))}
                {u.vessels.filter((v) => !me.accessibleVessels.some((a) => a.id === v.id)).map((v) => (
                  <p key={v.id} className="text-xs text-ink-muted">{v.name} (hors de votre propre périmètre)</p>
                ))}
              </div>
            )}
          </Panel>
          <Panel
            title="Départements"
            actions={
              <PermissionGate allOf={['users.edit']}>
                <Button size="sm" onClick={() => saveDepts.mutate(undefined)} loading={saveDepts.isPending}>Enregistrer</Button>
              </PermissionGate>
            }
          >
            <Field label="Département principal" htmlFor="d-primary">
              <Select id="d-primary" value={primary} onChange={(e) => setPrimary(e.target.value)} disabled={!can('users.edit')}>
                <option value="">Aucun</option>
                {depts.data?.map((d) => (
                  <option key={d.id} value={d.id} disabled={d.status !== 'ACTIVE' && d.id !== primary}>
                    {d.name}{d.status !== 'ACTIVE' ? ' (inactif)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <p className="field-label mt-3">Départements secondaires</p>
            <div className="grid gap-1 sm:grid-cols-2">
              {depts.data?.filter((d) => d.id !== primary).map((d) => (
                <Checkbox
                  key={d.id}
                  label={d.name}
                  description={d.status !== 'ACTIVE' ? 'Inactif : aucune nouvelle affectation' : undefined}
                  checked={secondary.includes(d.id)}
                  disabled={!can('users.edit') || (d.status !== 'ACTIVE' && !secondary.includes(d.id))}
                  onChange={(e) => setSecondary(e.target.checked ? [...secondary, d.id] : secondary.filter((x) => x !== d.id))}
                />
              ))}
            </div>
          </Panel>
          <Panel
            title="Fiche Member liée"
            actions={
              <PermissionGate allOf={['members.link_user']}>
                <Button size="sm" variant="secondary" onClick={() => setMemberOpen(true)}>{u.member ? 'Changer' : 'Lier'}</Button>
              </PermissionGate>
            }
          >
            {u.member ? (
              <p className="text-sm">
                <a className="font-medium text-action hover:underline" href={`/members/${u.member.id}`}>
                  {u.member.lastName} {u.member.firstName}
                </a>{' '}
                {u.member.amcRef && <span className="text-ink-muted">({u.member.amcRef})</span>}
              </p>
            ) : (
              <p className="text-sm text-ink-muted">Compte indépendant (lien 1:1 facultatif).</p>
            )}
            {u.member && (
              <PermissionGate allOf={['members.link_user']}>
                <Button size="sm" variant="ghost" className="mt-2" onClick={() => linkMember.mutate(null)}>Délier</Button>
              </PermissionGate>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="profile">
          <Panel
            title="Informations du compte"
            actions={
              <PermissionGate allOf={['users.edit']}>
                <Button size="sm" onClick={() => saveProfile.mutate(undefined)} loading={saveProfile.isPending}>Enregistrer</Button>
              </PermissionGate>
            }
          >
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <Field label="Nom affiché" htmlFor="p-name">
                <Input id="p-name" value={profile.displayName} onChange={(e) => setProfile({ ...profile, displayName: e.target.value })} disabled={!can('users.edit')} />
              </Field>
              <Field label="Fonction" htmlFor="p-job">
                <Input id="p-job" value={profile.jobTitle} onChange={(e) => setProfile({ ...profile, jobTitle: e.target.value })} disabled={!can('users.edit')} />
              </Field>
              <Field label="E-mail" htmlFor="p-email">
                <Input id="p-email" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} disabled={!can('users.edit')} />
              </Field>
              <div className="pt-6">
                <Checkbox label="E-mail vérifié" checked={profile.emailVerified} onChange={(e) => setProfile({ ...profile, emailVerified: e.target.checked })} disabled={!can('users.edit')} />
              </div>
            </div>
            <div className="mt-5 border-t border-line pt-4">
              <DefinitionGrid
                columns={4}
                items={[
                  ['Identifiant', u.username],
                  ['Créé le', fmtDateTime(u.createdAt)],
                  ['Dernière connexion', fmtDateTime(u.lastLoginAt)],
                  ['Échecs de connexion', String(u.failedLogins)],
                ]}
              />
            </div>
          </Panel>
        </TabsContent>

        {can('sessions.view') && (
          <TabsContent value="sessions">
            <Panel
              title="Sessions"
              actions={
                <PermissionGate allOf={['sessions.revoke']}>
                  <Button size="sm" variant="secondary" onClick={() => setConfirm('revokeAll')}>
                    <LogOut className="h-4 w-4" aria-hidden /> Révoquer toutes
                  </Button>
                </PermissionGate>
              }
              bodyClassName="p-0"
            >
              <table className="table-amc">
                <thead>
                  <tr><th>Appareil</th><th>Adresse IP</th><th>Ouverte</th><th>Dernière activité</th><th>État</th><th /></tr>
                </thead>
                <tbody>
                  {sessions.data?.map((s) => (
                    <tr key={s.id}>
                      <td>{s.deviceLabel ?? '—'}</td>
                      <td className="tabular">{s.ip ?? '—'}</td>
                      <td className="tabular">{fmtDateTime(s.createdAt)}</td>
                      <td className="tabular">{fmtDateTime(s.lastSeenAt)}</td>
                      <td>{s.revokedAt ? <Badge tone="neutral">Fermée ({s.revokedReason})</Badge> : new Date(s.expiresAt) < new Date() ? <Badge tone="neutral">Expirée</Badge> : <Badge tone="ok">Active</Badge>}</td>
                      <td className="text-right">
                        {!s.revokedAt && can('sessions.revoke') && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={async () => {
                              try {
                                await api.delete(`/users/${id}/sessions/${s.id}`);
                                toast.success('Session révoquée');
                                qc.invalidateQueries({ queryKey: ['user-sessions', id] });
                              } catch (e) {
                                toast.error(errorMessage(e));
                              }
                            }}
                          >
                            Révoquer
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Panel>
          </TabsContent>
        )}
        {can('audit.view.admin') && (
          <TabsContent value="history">
            <Panel title="Historique du compte">
              <AuditTimeline entityType="user" entityId={u.id} module="admin" />
            </Panel>
          </TabsContent>
        )}
      </Tabs>

      <Dialog
        open={memberOpen}
        onOpenChange={setMemberOpen}
        title="Lier une fiche Member"
        description="Identifiant de la fiche (visible dans l'URL de la fiche). Une fiche ne peut être liée qu'à un seul compte."
        footer={<Button onClick={() => linkMember.mutate(memberId)} disabled={!/^[0-9a-f-]{36}$/.test(memberId)} loading={linkMember.isPending}>Lier</Button>}
      >
        <Field label="Identifiant de fiche Member" htmlFor="m-id">
          <Input id="m-id" value={memberId} onChange={(e) => setMemberId(e.target.value.trim())} placeholder="xxxxxxxx-xxxx-…" />
        </Field>
      </Dialog>

      <ConfirmDialog
        open={confirm === 'deactivate'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Désactiver ${u.displayName} ?`}
        description="Toutes ses sessions sont fermées immédiatement. Fiche Member, documents et historique sont conservés."
        confirmLabel="Désactiver"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          await api.post(`/users/${id}/deactivate`, { reason });
          qc.invalidateQueries({ queryKey: ['user', id] });
        }}
      />
      <ConfirmDialog
        open={confirm === 'reactivate'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Réactiver ${u.displayName} ?`}
        confirmLabel="Réactiver"
        onConfirm={async () => {
          await api.post(`/users/${id}/reactivate`, {});
          qc.invalidateQueries({ queryKey: ['user', id] });
        }}
      />
      <ConfirmDialog
        open={confirm === 'unlock' || confirm === 'reset'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm === 'unlock' ? 'Déverrouiller avec un mot de passe temporaire' : 'Générer un mot de passe temporaire'}
        description="Le déverrouillage impose un nouveau mot de passe temporaire ; toutes les sessions de l'utilisateur sont fermées."
        confirmLabel="Générer"
        onConfirm={async () => {
          const res = await api.post<{ temporaryPassword: string }>(`/users/${id}/${confirm === 'unlock' ? 'unlock' : 'reset-password'}`, {});
          setTemp(res.temporaryPassword);
          qc.invalidateQueries({ queryKey: ['user', id] });
        }}
      />
      <ConfirmDialog
        open={confirm === 'revokeAll'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Révoquer toutes les sessions ?"
        confirmLabel="Révoquer"
        tone="danger"
        onConfirm={async () => {
          await api.delete(`/users/${id}/sessions/all`);
          qc.invalidateQueries({ queryKey: ['user-sessions', id] });
        }}
      />
    </>
  );
}
