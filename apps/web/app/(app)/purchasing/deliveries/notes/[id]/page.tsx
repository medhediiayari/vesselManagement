'use client';

import { useQuery } from '@tanstack/react-query';
import { Ban, ClipboardCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { DN_STATUS_LABELS, DN_STATUS_TONES, RECEIPT_STATUS_LABELS, RECEIPT_STATUS_TONES, dec, purKeys, useCommand } from '@/components/purchasing/lib';
import type { DeliveryNoteDetail } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, PoStatusBadge, StatusPill, TextActionDialog } from '@/components/purchasing/ui';

export default function DeliveryNotePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { can, canAny } = useSession();
  const run = useCommand();
  const [cancelOpen, setCancelOpen] = useState(false);
  const q = useQuery({ queryKey: purKeys.note(id), queryFn: () => api.get<DeliveryNoteDetail>(`/delivery-notes/${id}`) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const dn = q.data;
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Livraisons & réceptions', href: '/purchasing/deliveries' }, { label: `BL ${dn.number}` }]}
        title={<>Bon de livraison <span className="ref">{dn.number}</span></>}
        description={`${dn.supplier.name} — livré le ${fmtDate(dn.deliveryDate)}`}
        meta={
          <>
            <StatusPill status={dn.status} labels={DN_STATUS_LABELS} tones={DN_STATUS_TONES} />
            <Badge tone="navy" icon={false}>
              BC {dn.po.number}
            </Badge>
          </>
        }
        actions={
          <>
            {can('receiving.record') && dn.status !== 'CANCELLED' && (
              <Button onClick={() => router.push(`/purchasing/deliveries/receive?poId=${dn.poId}&deliveryNoteId=${dn.id}`)}>
                <ClipboardCheck className="h-4 w-4" aria-hidden /> {dn.status === 'RECORDED' ? 'Réceptionner ce BL' : 'Nouvelle réception sur ce BL'}
              </Button>
            )}
            {can('receiving.record') && dn.status !== 'CANCELLED' && !dn.receipts.length && (
              <Button variant="ghost" onClick={() => setCancelOpen(true)}>
                <Ban className="h-4 w-4" aria-hidden /> Annuler le BL
              </Button>
            )}
          </>
        }
      />
      <Callout tone="info" className="mb-4" title="Un BL n’est pas une preuve de réception">
        Ces quantités sont celles déclarées par le fournisseur. Seule la réception physique à bord (reçu / accepté / rejeté) solde la commande.
      </Callout>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="Lignes déclarées sur le BL">
          <div className="overflow-x-auto">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Ligne BC</th>
                  <th scope="col" className="text-right">
                    Commandé (BC)
                  </th>
                  <th scope="col" className="text-right">
                    Sur ce BL
                  </th>
                  <th scope="col" className="text-right">
                    Écart BC − BL
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...dn.lines]
                  .sort((a, b) => a.poLine.lineNo - b.poLine.lineNo)
                  .map((l) => {
                    const ordered = dec.sub(l.poLine.quantityOrdered, l.poLine.quantityCancelled);
                    const delta = dec.sub(ordered, l.quantityOnNote);
                    return (
                      <tr key={l.id}>
                        <td>
                          {l.poLine.lineNo}. {l.poLine.designation}
                        </td>
                        <td className="text-right tabular">
                          {fmtDecimal(ordered)} {l.poLine.unit}
                        </td>
                        <td className="text-right font-semibold tabular">
                          {fmtDecimal(l.quantityOnNote)} {l.unit}
                        </td>
                        <td className={`text-right tabular ${dec.gt0(delta) ? 'text-warn' : 'text-ink-muted'}`}>{dec.gt0(delta) ? `manque ${fmtDecimal(delta)}` : fmtDecimal(delta)}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-muted">L’écart BC − BL cumulé sur tous les BL du BC est suivi au rapprochement (manquant au BL / short-shipped).</p>
        </Panel>
        <div className="space-y-4">
          <Panel>
            <DefinitionGrid
              columns={2}
              items={[
                ['Fournisseur', dn.supplier.name],
                [
                  'Bon de commande',
                  <span key="po" className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={`/purchasing/orders/${dn.poId}?tab=reconciliation`} className="whitespace-nowrap text-action hover:underline">
                      {dn.po.number}
                    </Link>
                    <PoStatusBadge status={dn.po.status} />
                  </span>,
                ],
                ['Date de livraison', fmtDate(dn.deliveryDate)],
                ['Enregistré le', fmtDateTime(dn.createdAt)],
                ['Notes', dn.notes],
              ]}
            />
          </Panel>
          <Panel title="Réceptions liées">
            {dn.receipts.length ? (
              <ul className="divide-y divide-line">
                {dn.receipts.map((r) => (
                  <li key={r.id}>
                    <Link href={`/purchasing/deliveries/receipts/${r.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-action-50/40">
                      <span>
                        <span className="font-medium text-action">{r.number}</span>
                        <span className="block text-xs text-ink-muted">{fmtDateTime(r.receivedAt)}</span>
                      </span>
                      <StatusPill status={r.status} labels={RECEIPT_STATUS_LABELS} tones={RECEIPT_STATUS_TONES} />
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Pas encore réceptionné à bord.</p>
            )}
          </Panel>
          <Panel title="Scan du BL et pièces">
            <AttachmentsPanel
              path={`/delivery-notes/${dn.id}/attachments`}
              vesselId={dn.vesselId}
              attachments={dn.attachments}
              canManage={canAny('receiving.record')}
              onChanged={() => q.refetch()}
              emptyText="Aucun scan du BL."
            />
          </Panel>
        </div>
      </div>
      <TextActionDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Annuler le BL ${dn.number}`}
        description="Impossible si une réception y est rattachée. Les écarts BC / BL sont recalculés."
        label="Motif"
        required
        tone="danger"
        confirmLabel="Annuler le BL"
        onConfirm={(reason) => run(() => api.post(`/delivery-notes/${dn.id}/cancel`, { reason }), 'BL annulé')}
      />
    </>
  );
}
