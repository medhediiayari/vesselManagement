'use client';

import { useQuery } from '@tanstack/react-query';
import { Trash2, UserCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { useCsoRun } from './lib';
import { PrincipalName, PrincipalPicker } from './principal-picker';
import type { PrincipalType, ValidatorsView } from './types';
import { Notice } from './ui';

interface Draft {
  principalType: PrincipalType;
  principalId: string;
  label: string | null;
}

/**
 * Validateurs par dossier (CSO-006) : le dossier le plus proche qui en définit s'applique.
 * Seuls les titulaires de « Approuver CSO » avec droits documentaires et accès navire sont
 * éligibles ; l'auto-approbation reste interdite (contrôlé à chaque décision par l'API).
 */
export function ValidatorsDialog({
  open,
  onOpenChange,
  folderId,
  folderName,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  folderId: string;
  folderName: string;
  canEdit: boolean;
}) {
  const run = useCsoRun();
  const q = useQuery({
    queryKey: ['cso', 'validators', folderId],
    queryFn: () => api.get<ValidatorsView>(`/cso/folders/${folderId}/validators`),
    enabled: open,
  });
  const [draft, setDraft] = useState<Draft[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (q.data && open) {
      setDraft(q.data.validators.map((v) => ({ principalType: v.principalType, principalId: v.principalId, label: v.label })));
      setWarnings([]);
    }
  }, [q.data, open]);

  const dirty =
    !!q.data &&
    JSON.stringify(draft.map((d) => `${d.principalType}:${d.principalId}`).sort()) !==
      JSON.stringify(q.data.validators.map((d) => `${d.principalType}:${d.principalId}`).sort());

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={`Validateurs — ${folderName}`}
        description="Personnes habilitées à approuver les versions déposées dans ce dossier et ses sous-dossiers."
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              {canEdit ? 'Annuler' : 'Fermer'}
            </Button>
            {canEdit && (
              <Button disabled={!dirty} onClick={() => setConfirm(true)}>
                Enregistrer
              </Button>
            )}
          </>
        }
      >
        {q.isLoading && <LoadingBlock rows={4} />}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data && (
          <div className="space-y-4">
            <section>
              <h3 className="mb-1 text-sm font-semibold">Validateurs applicables</h3>
              {q.data.fallbackToApprovePermission ? (
                <Notice tone="warn">
                  Aucun validateur désigné dans la hiérarchie : tout titulaire de la permission « Approuver CSO » ayant les droits du dossier et l&apos;accès
                  navire peut décider (jamais le déposant).
                </Notice>
              ) : (
                <>
                  {q.data.effective?.inherited && <p className="mb-1 text-xs text-ink-muted">Hérités d&apos;un dossier parent.</p>}
                  <ul className="flex flex-wrap gap-2">
                    {q.data.effective?.validators.map((v) => (
                      <li key={`${v.principalType}:${v.principalId}`} className="rounded-full border border-line bg-canvas px-2.5 py-1 text-sm">
                        <PrincipalName type={v.principalType} id={v.principalId} label={v.label} />
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </section>
            <section>
              <h3 className="mb-1 text-sm font-semibold">Désignés sur ce dossier ({draft.length})</h3>
              {draft.length === 0 && <p className="text-sm text-ink-muted">Aucun : le dossier hérite des validateurs de ses parents.</p>}
              <ul className="divide-y divide-line rounded-md border border-line empty:hidden">
                {draft.map((d, i) => (
                  <li key={`${d.principalType}:${d.principalId}`} className="flex items-center gap-2 px-3 py-2 text-sm">
                    <UserCheck className="h-4 w-4 text-teal-700" aria-hidden />
                    <span className="min-w-0 flex-1">
                      <PrincipalName type={d.principalType} id={d.principalId} label={d.label} />
                    </span>
                    {canEdit && (
                      <IconButton label="Retirer ce validateur" onClick={() => setDraft((p) => p.filter((_, j) => j !== i))}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    )}
                  </li>
                ))}
              </ul>
              {canEdit && (
                <div className="mt-3">
                  <PrincipalPicker
                    exclude={draft.map((d) => `${d.principalType}:${d.principalId}`)}
                    onAdd={(p) => setDraft((prev) => [...prev, p])}
                    addLabel="Désigner"
                  />
                </div>
              )}
            </section>
            {warnings.length > 0 && (
              <Notice tone="warn">
                <ul className="list-disc pl-4">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </Notice>
            )}
          </div>
        )}
      </Dialog>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Modifier les validateurs ?"
        description="Les décisions en attente seront soumises aux nouveaux validateurs. Le changement est journalisé."
        confirmLabel="Enregistrer"
        onConfirm={async () => {
          const res = await run(
            () => api.put<{ warnings: string[] }>(`/cso/folders/${folderId}/validators`, { validators: draft.map((d) => ({ principalType: d.principalType, principalId: d.principalId })) }),
            'Validateurs mis à jour',
          );
          if (res.warnings?.length) setWarnings(res.warnings);
          else onOpenChange(false);
        }}
      />
    </>
  );
}
