'use client';

import { useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, Eye, FilePlus2, FileSignature, Link2, Lock, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FilePreviewDialog } from '@/components/amc/file-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DefinitionGrid, Panel } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/states';
import { FormError, LinkButton, Notice } from './common';
import { CpFormDialog } from './cp-form';
import { CP_STATUS_LABELS, CP_TYPE_LABELS, CP_VERSION_KIND_LABELS, cpKeys, fmtLaycan, useOp, voyageKeys } from './lib';
import { CpStatusBadge } from './status';
import { useLinkableCps } from './voyage-form';
import type { VoyageBase, VoyageWorkspace } from './types';

/** Rattachement d'une CP au voyage (PATCH charterPartyId avec verrou optimiste). */
function LinkCpDialog({ open, onOpenChange, ws }: { open: boolean; onOpenChange: (o: boolean) => void; ws: VoyageWorkspace }) {
  const qc = useQueryClient();
  const v = ws.overview;
  const linkable = useLinkableCps(v.vesselId, v.id, open);
  const [cpId, setCpId] = useState('');
  const [error, setError] = useState<unknown>(null);
  const link = useOp(() => api.patch<VoyageBase>(`/voyages/${v.id}`, { charterPartyId: cpId, expectedVersion: v.lockVersion }), {
    success: 'Charter Party rattachée au voyage',
    invalidate: [voyageKeys.ws(v.id), voyageKeys.list, cpKeys.list],
    onSuccess: () => onOpenChange(false),
    onError: (e) => {
      setError(e);
      return true;
    },
  });
  const options = linkable.items.filter((c) => c.id !== v.charterPartyId);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Rattacher une Charter Party"
      description="Seules les CP actives du même navire, non rattachées à un autre voyage, sont proposées."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => link.mutate(undefined)} loading={link.isPending} disabled={!cpId}>
            <Link2 className="h-4 w-4" aria-hidden /> Rattacher
          </Button>
        </>
      }
    >
      <FormError
        error={error}
        onReload={() => {
          void qc.invalidateQueries({ queryKey: voyageKeys.ws(v.id) });
          onOpenChange(false);
        }}
      />
      {linkable.isLoading && <p className="text-sm text-ink-muted">Chargement…</p>}
      {!linkable.isLoading && options.length === 0 && <p className="text-sm text-ink-muted">Aucune Charter Party rattachable pour ce navire.</p>}
      <div className="space-y-1.5">
        {options.map((c) => (
          <label key={c.id} className="flex cursor-pointer items-start gap-2 rounded-md border border-line px-3 py-2 text-sm hover:bg-canvas">
            <input type="radio" name="link-cp" className="mt-1" checked={cpId === c.id} onChange={() => setCpId(c.id)} />
            <span>
              <span className="font-medium text-navy">{c.reference}</span> — {CP_STATUS_LABELS[c.status]}
              <span className="block text-xs text-ink-muted">
                {CP_TYPE_LABELS[c.cpType]} · {c.charterer ?? 'charterer non renseigné'} · laycan {fmtLaycan(c.laycanFrom, c.laycanTo, fmtDate)}
              </span>
            </span>
          </label>
        ))}
      </div>
    </Dialog>
  );
}

export function CharterPartyTab({ ws }: { ws: VoyageWorkspace }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const v = ws.overview;
  const cp = ws.charterParty;
  const [linkOpen, setLinkOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const canLink = ws.permissions.edit && can('charter_party.view');
  const ack = useOp(
    () => (cp && cp.linked && cp.currentVersion ? api.post(`/charter-parties/${cp.id}/versions/${cp.currentVersion.id}/acknowledge`) : Promise.resolve()),
    { success: 'Accusé de lecture enregistré', invalidate: [voyageKeys.ws(v.id)] },
  );

  if (!can('charter_party.view') || cp === null) {
    return (
      <Panel title="Charter Party">
        <EmptyState icon={<Lock className="h-5 w-5" aria-hidden />} title="Contenu confidentiel" description="La consultation des Charter Parties requiert la permission charter_party.view." />
      </Panel>
    );
  }

  if (!cp.linked) {
    return (
      <Panel title="Charter Party">
        <EmptyState
          icon={<FileSignature className="h-5 w-5" aria-hidden />}
          title="Aucune Charter Party rattachée"
          description="Facultatif en brouillon. Lorsqu’une CP existe pour ce voyage (même navire, charterer ou laycan), son rattachement est exigé pour planifier / activer."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {canLink && (
                <Button onClick={() => setLinkOpen(true)}>
                  <Link2 className="h-4 w-4" aria-hidden /> Rattacher une CP existante
                </Button>
              )}
              {can('charter_party.manage') && (
                <Button variant="secondary" onClick={() => setCreateOpen(true)}>
                  <Plus className="h-4 w-4" aria-hidden /> Créer la Charter Party
                </Button>
              )}
            </div>
          }
        />
        <LinkCpDialog open={linkOpen} onOpenChange={setLinkOpen} ws={ws} />
        <CpFormDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          prefill={{ vesselId: v.vesselId, charterer: v.charterer, laycanFrom: v.laycanFrom, laycanTo: v.laycanTo, cpType: 'VOYAGE' }}
          onSaved={async (created) => {
            if (canLink) {
              try {
                await api.patch(`/voyages/${v.id}`, { charterPartyId: created.id, expectedVersion: v.lockVersion });
              } catch {
                /* rattachement manuel possible ensuite */
              }
            }
            await qc.invalidateQueries({ queryKey: voyageKeys.ws(v.id) });
          }}
        />
      </Panel>
    );
  }

  const canDownload = can('charter_party.manage') || can('charter_party.approve');
  const filePath = cp.currentVersion?.fileId ? `/charter-parties/${cp.id}/versions/${cp.currentVersion.id}/file` : null;
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <FileSignature className="h-4 w-4 text-teal-700" aria-hidden /> Charter Party {cp.reference}
        </span>
      }
      actions={
        <>
          <Link href={`/charter-parties/${cp.id}`} className="text-sm font-medium text-action hover:underline">
            Ouvrir la fiche
          </Link>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <CpStatusBadge status={cp.status} />
          <Badge tone="navy" icon={<Lock className="h-3.5 w-3.5" aria-hidden />}>
            Confidentiel
          </Badge>
        </div>
        <DefinitionGrid
          columns={3}
          items={[
            ['Type', CP_TYPE_LABELS[cp.cpType] ?? cp.cpType],
            ['Date de la CP', fmtDate(cp.cpDate)],
            ['Charterer', cp.charterer ?? '—'],
            ['Owner', cp.owner ?? '—'],
            ['Laycan (CP)', <span key="l" className="tabular">{fmtLaycan(cp.laycanFrom, cp.laycanTo, fmtDate)}</span>],
            [
              'Version en vigueur',
              cp.currentVersion ? `v${cp.currentVersion.versionNo} — ${CP_VERSION_KIND_LABELS[cp.currentVersion.kind]} (approuvée ${fmtDateTime(cp.currentVersion.decidedAt)})` : 'Aucune version approuvée',
            ],
          ]}
        />
        {cp.pendingVersion && (
          <Notice tone="warn" title={`Version v${cp.pendingVersion.versionNo} (${CP_VERSION_KIND_LABELS[cp.pendingVersion.kind]}) en attente d’approbation`}>
            {cp.currentVersion
              ? `La version v${cp.currentVersion.versionNo} reste opposable jusqu’à son approbation par un autre utilisateur habilité.`
              : 'Aucune version n’est encore opposable : l’approbation doit être faite par un autre utilisateur habilité.'}
          </Notice>
        )}
        {cp.currentVersion && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            {filePath && (
              <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(true)}>
                <Eye className="h-4 w-4" aria-hidden /> Contrat (PDF) v{cp.currentVersion.versionNo}
              </Button>
            )}
            {cp.acknowledgedByMe ? (
              <Badge tone="ok">Lu par vous le {fmtDateTime(cp.acknowledgedByMe)}</Badge>
            ) : (
              can('noon.submit') && (
                <Button size="sm" onClick={() => ack.mutate(undefined)} loading={ack.isPending}>
                  <BookOpenCheck className="h-4 w-4" aria-hidden /> Accuser lecture (Master)
                </Button>
              )
            )}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {can('charter_party.manage') && (
            <LinkButton href={`/charter-parties/${cp.id}?action=version`}>
              <FilePlus2 className="h-4 w-4" aria-hidden /> Déposer le contrat / un avenant
            </LinkButton>
          )}
          {canLink && (
            <Button variant="ghost" size="sm" onClick={() => setLinkOpen(true)}>
              <Link2 className="h-4 w-4" aria-hidden /> Changer de Charter Party
            </Button>
          )}
        </div>
        <p className="text-xs text-ink-muted">
          Les clauses NOR / laytime / freight / demurrage sont consultables sur la fiche, telles que stockées : aucune interprétation ni calcul.
        </p>
      </div>
      <LinkCpDialog open={linkOpen} onOpenChange={setLinkOpen} ws={ws} />
      {filePath && (
        <FilePreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          title={`Charter Party ${cp.reference} — v${cp.currentVersion?.versionNo}`}
          previewPath={`${filePath}?mode=preview`}
          downloadPath={`${filePath}?mode=download`}
          canDownload={canDownload}
        />
      )}
    </Panel>
  );
}
