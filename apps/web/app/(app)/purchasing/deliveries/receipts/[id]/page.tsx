'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDate, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import {
  CONDITION_LABELS,
  CONDITION_TONES,
  RECEIPT_STATUS_LABELS,
  RECEIPT_STATUS_TONES,
  VARIANCE_STATUS_LABELS,
  VARIANCE_STATUS_TONES,
  VARIANCE_TYPE_LABELS,
  VARIANCE_TYPE_TONES,
  dec,
  purKeys,
  useCommand,
} from '@/components/purchasing/lib';
import type { ReceiptDetail } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, PdfActions, PoStatusBadge, StatusPill, TextActionDialog } from '@/components/purchasing/ui';

export default function ReceiptPage() {
  const { id } = useParams<{ id: string }>();
  const { can, canAny, me } = useSession();
  const run = useCommand();
  const [validateOpen, setValidateOpen] = useState(false);
  const q = useQuery({ queryKey: purKeys.receipt(id), queryFn: () => api.get<ReceiptDetail>(`/receipts/${id}`) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const isAuthor = r.receivedById === me.id;
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Livraisons & réceptions', href: '/purchasing/deliveries?tab=receipts' }, { label: r.number }]}
        title={<>Réception <span className="ref">{r.number}</span></>}
        description={`${r.po.supplier.name} — BC ${r.po.number}`}
        meta={<StatusPill status={r.status} labels={RECEIPT_STATUS_LABELS} tones={RECEIPT_STATUS_TONES} />}
        actions={
          <>
            <PdfActions path={`/receipts/${r.id}/pdf`} title={`Rapport de réception ${r.number}`} label="Rapport PDF" />
            {can('receiving.validate') && r.status === 'CONFIRMED' && (
              <Button onClick={() => setValidateOpen(true)} disabled={isAuthor} title={isAuthor ? 'La validation revient à une autre personne que celle qui a saisi la réception' : undefined}>
                <ShieldCheck className="h-4 w-4" aria-hidden /> Valider le rapport
              </Button>
            )}
          </>
        }
      />
      {r.status === 'CONFIRMED' && (
        <Callout tone="warn" className="mb-4" title="Rapport de réception à valider">
          Les quantités sont déjà prises en compte dans les reliquats ; la validation par une personne habilitée (receiving.validate) atteste le rapport.
        </Callout>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Panel title="BL | physiquement reçu, ligne par ligne">
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-sm">
              <thead>
                <tr>
                  <th scope="col" rowSpan={2} className="border-b border-line bg-surface-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">
                    Ligne
                  </th>
                  <th scope="colgroup" className="border-b border-line bg-teal-50 px-3 py-1.5 text-center text-xs font-semibold text-teal-700">
                    BL
                  </th>
                  <th scope="colgroup" colSpan={5} className="border-b border-line bg-ok-bg px-3 py-1.5 text-center text-xs font-semibold text-ok">
                    Physiquement reçu à bord
                  </th>
                </tr>
                <tr className="bg-surface-sunken text-xs text-ink-muted">
                  <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                    Qté BL
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                    Reçu
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                    Accepté
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                    Rejeté
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-1.5 text-left font-semibold">
                    État
                  </th>
                  <th scope="col" className="border-b border-line px-3 py-1.5 text-left font-semibold">
                    Remarques
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.lines.map((l) => {
                  const short = l.deliveryNoteLine && dec.cmp(l.qtyReceived, l.deliveryNoteLine.quantityOnNote) < 0;
                  return (
                    <tr key={l.id} className="align-top">
                      <td className="border-b border-line px-3 py-2">
                        {l.poLine.lineNo}. {l.poLine.designation} <span className="text-xs text-ink-muted">({l.poLine.unit})</span>
                      </td>
                      <td className="border-b border-line bg-teal-50/40 px-3 py-2 text-right tabular">{l.deliveryNoteLine ? fmtDecimal(l.deliveryNoteLine.quantityOnNote) : '—'}</td>
                      <td className={cn('border-b border-line bg-ok-bg/30 px-3 py-2 text-right tabular', short && 'text-danger')}>
                        {fmtDecimal(l.qtyReceived)}
                        {short && <span className="block text-[11px]">manque à bord {fmtDecimal(dec.sub(l.deliveryNoteLine!.quantityOnNote, l.qtyReceived))}</span>}
                      </td>
                      <td className="border-b border-line bg-ok-bg/30 px-3 py-2 text-right font-semibold tabular text-ok">{fmtDecimal(l.qtyAccepted)}</td>
                      <td className={cn('border-b border-line bg-ok-bg/30 px-3 py-2 text-right tabular', dec.gt0(l.qtyRejected) ? 'text-danger' : 'text-ink-muted')}>{fmtDecimal(l.qtyRejected)}</td>
                      <td className="border-b border-line bg-ok-bg/30 px-3 py-2">
                        <StatusPill status={l.condition} labels={CONDITION_LABELS} tones={CONDITION_TONES} />
                      </td>
                      <td className="border-b border-line bg-ok-bg/30 px-3 py-2 text-xs text-ink-muted">{l.remarks ?? '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-ink-muted">
            Les quantités commandées et le reste à recevoir figurent au{' '}
            <Link href={`/purchasing/orders/${r.poId}?tab=reconciliation`} className="whitespace-nowrap text-action hover:underline">
              rapprochement du BC
            </Link>
            .
          </p>
        </Panel>
        <div className="space-y-4">
          <Panel>
            <DefinitionGrid
              columns={2}
              items={[
                [
                  'Bon de commande',
                  <span key="po" className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link href={`/purchasing/orders/${r.poId}`} className="whitespace-nowrap text-action hover:underline">
                      {r.po.number}
                    </Link>
                    <PoStatusBadge status={r.po.status} />
                  </span>,
                ],
                [
                  'BL',
                  r.deliveryNote ? (
                    <Link key="bl" href={`/purchasing/deliveries/notes/${r.deliveryNote.id}`} className="text-action hover:underline">
                      {r.deliveryNote.number} ({fmtDate(r.deliveryNote.deliveryDate)})
                    </Link>
                  ) : (
                    'Sans BL'
                  ),
                ],
                ['Reçu le', fmtDateTime(r.receivedAt)],
                ['Saisi par', r.receivedByName],
                ['Responsable', r.responsibleName],
                ['Validé', r.validatedAt ? `${r.validatedByName ?? '—'} le ${fmtDateTime(r.validatedAt)}` : null],
                ['Observations', r.notes],
              ]}
            />
          </Panel>
          <Panel title={`Écarts signalés (${r.variances.length})`}>
            {r.variances.length ? (
              <ul className="space-y-2">
                {r.variances.map((v) => (
                  <li key={v.id}>
                    <Link href={`/purchasing/deliveries/variances/${v.id}`} className="block rounded-md border border-line px-3 py-2 hover:bg-action-50/40">
                      <span className="flex flex-wrap items-center gap-2">
                        <StatusPill status={v.type} labels={VARIANCE_TYPE_LABELS} tones={VARIANCE_TYPE_TONES} />
                        <span className="text-sm tabular">{fmtDecimal(v.quantity)}</span>
                        <StatusPill status={v.status} labels={VARIANCE_STATUS_LABELS} tones={VARIANCE_STATUS_TONES} />
                      </span>
                      <span className="mt-1 block text-xs text-ink-muted">{v.description}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Aucun écart propre à cette réception.</p>
            )}
          </Panel>
          <Panel title="Preuves">
            <AttachmentsPanel
              path={`/receipts/${r.id}/attachments`}
              vesselId={r.vesselId}
              attachments={r.attachments}
              canManage={canAny('receiving.record', 'receiving.validate')}
              onChanged={() => q.refetch()}
              emptyText="Aucune preuve jointe."
            />
          </Panel>
        </div>
      </div>
      <TextActionDialog
        open={validateOpen}
        onOpenChange={setValidateOpen}
        title={`Valider le rapport ${r.number}`}
        confirmLabel="Valider"
        onConfirm={(comment) => run(() => api.post(`/receipts/${r.id}/validate`, { comment: comment || null }), 'Rapport de réception validé')}
      />
    </>
  );
}
