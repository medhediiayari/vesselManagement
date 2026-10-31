'use client';

import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Checkbox, Select } from '@/components/ui/field';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { useCsoRun } from './lib';
import { PrincipalName, PrincipalPicker } from './principal-picker';
import { CSO_ACTION_LABELS, CSO_ACTIONS, type AclEntry, type AclView, type CsoAction } from './types';
import { Notice } from './ui';

const DOC_ACTIONS: CsoAction[] = ['view', 'preview', 'download', 'view_archived', 'download_archived', 'edit', 'folder_move', 'acl_manage', 'approve', 'restore', 'share'];

function EffectBadge({ effect }: { effect: 'ALLOW' | 'DENY' }) {
  return effect === 'DENY' ? (
    <Badge tone="danger" icon={<Ban className="h-3.5 w-3.5" aria-hidden />}>
      Refuser
    </Badge>
  ) : (
    <Badge tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>
      Autoriser
    </Badge>
  );
}

function ActionsList({ actions }: { actions: string[] }) {
  return <span className="text-xs text-ink-muted">{actions.map((a) => CSO_ACTION_LABELS[a as CsoAction] ?? a).join(' · ')}</span>;
}

/**
 * Consultation / édition des ACL d'un dossier ou d'un document (CSO-003/004) : héritage du parent,
 * exceptions par utilisateur / rôle / département, DENY prioritaire. Chaque modification est
 * auditée ; l'API refuse une modification qui retirerait au gestionnaire son propre droit.
 */
export function AclEditorDialog({
  open,
  onOpenChange,
  kind,
  id,
  name,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  kind: 'folder' | 'document';
  id: string;
  name: string;
  canEdit: boolean;
}) {
  const run = useCsoRun();
  const path = kind === 'folder' ? `/cso/folders/${id}/acl` : `/cso/documents/${id}/acl`;
  const acl = useQuery({ queryKey: ['cso', 'acl', kind, id], queryFn: () => api.get<AclView>(path), enabled: open });
  const [inherit, setInherit] = useState(true);
  const [entries, setEntries] = useState<AclEntry[]>([]);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (acl.data && open) {
      setInherit(acl.data.inheritAcl);
      setEntries(acl.data.entries.map((e) => ({ ...e, actions: [...e.actions] })));
    }
  }, [acl.data, open]);

  const actionsCatalog = kind === 'folder' ? CSO_ACTIONS : DOC_ACTIONS;
  const dirty =
    !!acl.data &&
    (inherit !== acl.data.inheritAcl ||
      JSON.stringify(entries.map((e) => [e.principalType, e.principalId, e.effect, [...e.actions].sort()])) !==
        JSON.stringify(acl.data.entries.map((e) => [e.principalType, e.principalId, e.effect, [...e.actions].sort()])));
  // Rupture d'héritage sans « Autoriser · Consulter » : refusée par l'API (CSO-02)
  const breakWithoutView = !inherit && !entries.some((e) => e.effect === 'ALLOW' && e.actions.includes('view'));
  const invalid = entries.some((e) => e.actions.length === 0) || breakWithoutView;

  function update(i: number, patch: Partial<AclEntry>) {
    setEntries((prev) => prev.map((e, j) => (j === i ? { ...e, ...patch } : e)));
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Accès — ${name}`}
        description={kind === 'folder' ? 'Droits du dossier, hérités par ses sous-dossiers et documents.' : 'Exceptions propres à ce document.'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {canEdit ? 'Annuler' : 'Fermer'}
            </Button>
            {canEdit && (
              <Button disabled={!dirty || invalid} onClick={() => setConfirm(true)}>
                Enregistrer les droits
              </Button>
            )}
          </>
        }
      >
        {acl.isLoading && <LoadingBlock rows={5} />}
        {acl.error && <ErrorState error={acl.error} onRetry={() => acl.refetch()} />}
        {acl.data && (
          <div className="space-y-5">
            <Notice tone="info">
              Une règle <strong>Refuser</strong> prévaut toujours. Dès qu&apos;une règle <strong>Autoriser</strong> mentionne une action, seuls les
              principaux listés l&apos;obtiennent. Les ACL n&apos;accordent jamais plus que la permission du module et le périmètre navire.
            </Notice>

            <Checkbox
              label={kind === 'folder' ? 'Hériter des droits du dossier parent' : 'Hériter des droits du dossier'}
              description={`Décocher pour rompre l'héritage : les règles des dossiers parents ne s'appliquent plus. Une action non citée ci-dessous reste ouverte aux titulaires de la permission du module ; une règle « Autoriser · ${CSO_ACTION_LABELS.view} » est donc exigée.`}
              checked={inherit}
              disabled={!canEdit}
              onChange={(e) => setInherit(e.target.checked)}
            />
            {canEdit && breakWithoutView && (
              <Notice tone="warn">
                Héritage rompu : ajoutez au moins une règle <strong>Autoriser</strong> cochant « {CSO_ACTION_LABELS.view} » pour désigner qui peut voir cet
                élément.
              </Notice>
            )}

            <section aria-labelledby="acl-own">
              <h3 id="acl-own" className="mb-2 text-sm font-semibold">
                Règles propres ({entries.length})
              </h3>
              {entries.length === 0 && <p className="text-sm text-ink-muted">Aucune exception : les droits hérités et la permission du module s&apos;appliquent.</p>}
              <ul className="space-y-2">
                {entries.map((e, i) => (
                  <li key={`${e.principalType}:${e.principalId}:${i}`} className={cn('rounded-md border p-3', e.effect === 'DENY' ? 'border-danger-line' : 'border-line')}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="min-w-0 flex-1 text-sm font-medium">
                        <PrincipalName type={e.principalType} id={e.principalId} label={e.principalLabel} />
                      </span>
                      {canEdit ? (
                        <Select
                          aria-label="Effet de la règle"
                          className="h-8 w-36"
                          value={e.effect}
                          onChange={(ev) => update(i, { effect: ev.target.value as 'ALLOW' | 'DENY' })}
                        >
                          <option value="ALLOW">Autoriser</option>
                          <option value="DENY">Refuser</option>
                        </Select>
                      ) : (
                        <EffectBadge effect={e.effect} />
                      )}
                      {canEdit && (
                        <IconButton label="Retirer cette règle" onClick={() => setEntries((prev) => prev.filter((_, j) => j !== i))}>
                          <Trash2 className="h-4 w-4" />
                        </IconButton>
                      )}
                    </div>
                    {canEdit ? (
                      <fieldset className="mt-2">
                        <legend className="sr-only">Actions concernées</legend>
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {actionsCatalog.map((a) => (
                            <label key={a} className="inline-flex items-center gap-1.5 text-sm">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-line-strong"
                                checked={e.actions.includes(a)}
                                onChange={(ev) =>
                                  update(i, { actions: ev.target.checked ? [...e.actions, a] : e.actions.filter((x) => x !== a) })
                                }
                              />
                              {CSO_ACTION_LABELS[a]}
                            </label>
                          ))}
                        </div>
                        {e.actions.length === 0 && <p className="field-error">Cochez au moins une action.</p>}
                      </fieldset>
                    ) : (
                      <div className="mt-1">
                        <ActionsList actions={e.actions} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && (
                <div className="mt-3 rounded-md border border-dashed border-line-strong p-3">
                  <p className="mb-2 text-sm font-medium">Ajouter une exception</p>
                  <PrincipalPicker
                    exclude={entries.map((e) => `${e.principalType}:${e.principalId}`)}
                    onAdd={(p) => setEntries((prev) => [...prev, { principalType: p.principalType, principalId: p.principalId, principalLabel: p.label, effect: 'ALLOW', actions: ['view', 'preview'] }])}
                  />
                </div>
              )}
            </section>

            <section aria-labelledby="acl-inherited">
              <h3 id="acl-inherited" className="mb-2 text-sm font-semibold">
                Règles héritées
              </h3>
              {!inherit && <p className="text-sm text-ink-muted">Héritage rompu : les règles des dossiers parents ne s&apos;appliquent pas.</p>}
              {inherit && acl.data.inherited.every((g) => g.entries.length === 0) && (
                <p className="text-sm text-ink-muted">Aucune règle définie sur les dossiers parents.</p>
              )}
              {inherit &&
                acl.data.inherited
                  .filter((g) => g.entries.length > 0)
                  .map((g) => (
                    <div key={g.folderId} className="mb-3">
                      <p className="mb-1 text-xs font-medium text-ink-muted">
                        Depuis « {g.folderName ?? 'dossier parent'} »{!g.inheritAcl && ' (rupture d’héritage)'}
                      </p>
                      <ul className="divide-y divide-line rounded-md border border-line">
                        {g.entries.map((e, i) => (
                          <li key={e.id ?? i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                            <span className="min-w-0 flex-1">
                              <PrincipalName type={e.principalType} id={e.principalId} label={e.principalLabel} />
                            </span>
                            <EffectBadge effect={e.effect} />
                            <span className="w-full">
                              <ActionsList actions={e.actions} />
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
            </section>
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Modifier les droits d'accès ?"
        description={`Les nouveaux droits s'appliquent immédiatement à « ${name} »${kind === 'folder' ? ' et à son contenu hérité' : ''}. Le changement est journalisé.`}
        confirmLabel="Appliquer"
        onConfirm={async () => {
          await run(
            () =>
              api.put(path, {
                inheritAcl: inherit,
                entries: entries.map((e) => ({ principalType: e.principalType, principalId: e.principalId, actions: e.actions, effect: e.effect })),
              }),
            'Droits mis à jour',
          );
          onOpenChange(false);
        }}
      />
    </>
  );
}

/** Vue en lecture des règles d'accès (propres + héritées) — réservée aux gestionnaires des accès. */
export function AclInlineView({ kind, id }: { kind: 'folder' | 'document'; id: string }) {
  const path = kind === 'folder' ? `/cso/folders/${id}/acl` : `/cso/documents/${id}/acl`;
  const acl = useQuery({ queryKey: ['cso', 'acl', kind, id], queryFn: () => api.get<AclView>(path) });
  if (acl.isLoading) return <LoadingBlock rows={3} />;
  if (acl.error || !acl.data) return <ErrorState error={acl.error} onRetry={() => acl.refetch()} />;
  const groups = [
    { key: 'own', title: kind === 'folder' ? 'Règles propres au dossier' : 'Règles propres au document', entries: acl.data.entries },
    ...(acl.data.inheritAcl
      ? acl.data.inherited.filter((g) => g.entries.length).map((g) => ({ key: g.folderId, title: `Héritées de « ${g.folderName ?? 'dossier parent'} »`, entries: g.entries }))
      : []),
  ];
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Héritage : <strong>{acl.data.inheritAcl ? 'actif' : 'rompu'}</strong>
      </p>
      {acl.data.inheritAcl && groups.length === 1 && (
        <p className="text-sm text-ink-muted">Aucune règle sur les dossiers parents : la permission du module et le périmètre navire s&apos;appliquent.</p>
      )}
      {groups.map((g) => (
        <div key={g.key}>
          <p className="mb-1 text-xs font-medium text-ink-muted">{g.title}</p>
          {g.entries.length === 0 ? (
            <p className="text-sm text-ink-muted">Aucune règle.</p>
          ) : (
            <ul className="divide-y divide-line rounded-md border border-line">
              {g.entries.map((e, i) => (
                <li key={e.id ?? i} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <PrincipalName type={e.principalType} id={e.principalId} label={e.principalLabel} />
                  </span>
                  <EffectBadge effect={e.effect} />
                  <span className="w-full">
                    <ActionsList actions={e.actions} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
