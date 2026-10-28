'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { api } from '@/lib/api';
import { cn, fmtDecimal } from '@/lib/format';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { VARIANCE_TYPE_LABELS, VARIANCE_TYPE_TONES, dec, purKeys } from './lib';
import type { Reconciliation } from './types';
import { Callout, StatusPill } from './ui';

function Num({ v, tone, strong }: { v: string; tone?: 'warn' | 'danger' | 'ok' | 'muted'; strong?: boolean }) {
  const color = tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : tone === 'ok' ? 'text-ok' : tone === 'muted' ? 'text-ink-muted' : '';
  return <span className={cn('tabular', color, strong && 'font-semibold')}>{fmtDecimal(v)}</span>;
}

/**
 * Rapprochement BC | BL | reçu physique (PUR-04) : trois colonnes distinctes — un BL (déclaration du
 * fournisseur) n'est jamais une preuve de réception ; seule la quantité acceptée à bord solde le reliquat.
 */
export function ReconciliationTable({ poId }: { poId: string }) {
  const q = useQuery({ queryKey: [...purKeys.order(poId), 'reconciliation'], queryFn: () => api.get<Reconciliation>(`/orders/${poId}/reconciliation`) });
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data;
  const groupTh = 'border-b border-line px-3 py-1.5 text-center text-xs font-semibold';
  // Totaux affichés seulement si toutes les lignes partagent la même unité (jamais d'addition pcs + L)
  const units = new Set(r.lines.map((l) => l.unit.trim().toLowerCase()));
  const sameUnit = units.size === 1 ? r.lines[0]?.unit : null;
  return (
    <div className="space-y-3">
      <Callout tone="info" title="BL ≠ réception physique">
        {r.note}
      </Callout>
      <div className="overflow-x-auto rounded-lg bg-white shadow-panel">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className="sticky left-0 z-[1] border-b border-line bg-surface-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">
                Ligne
              </th>
              <th scope="colgroup" colSpan={2} className={cn(groupTh, 'bg-action-50 text-action')}>
                Commandé (BC)
              </th>
              <th scope="colgroup" colSpan={1} className={cn(groupTh, 'bg-teal-50 text-teal-700')}>
                BL (déclaré fournisseur)
              </th>
              <th scope="colgroup" colSpan={3} className={cn(groupTh, 'bg-ok-bg text-ok')}>
                Physiquement reçu à bord
              </th>
              <th scope="colgroup" colSpan={2} className={cn(groupTh, 'bg-warn-bg text-warn')}>
                Écarts
              </th>
              <th scope="col" rowSpan={2} className="border-b border-line bg-surface-sunken px-3 py-2 text-left text-xs font-semibold text-ink-muted">
                PR d’origine
              </th>
            </tr>
            <tr className="bg-surface-sunken text-xs text-ink-muted">
              <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                Commandé
              </th>
              <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                Annulé
              </th>
              <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                Sur BL
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
              <th scope="col" className="border-b border-line px-3 py-1.5 text-right font-semibold">
                Reste à recevoir
              </th>
              <th scope="col" className="border-b border-line px-3 py-1.5 text-left font-semibold">
                Écarts ouverts
              </th>
            </tr>
          </thead>
          <tbody>
            {r.lines.map((l) => (
              <tr key={l.poLineId} className={cn('align-top', l.status === 'CANCELLED' && 'text-ink-muted line-through')}>
                <td className="sticky left-0 border-b border-line bg-white px-3 py-2">
                  <span className="text-xs tabular text-ink-muted">{l.lineNo}. </span>
                  <span className="font-medium">{l.designation}</span>
                  <span className="ml-1 text-xs text-ink-muted">({l.unit})</span>
                </td>
                <td className="border-b border-line bg-action-50/30 px-3 py-2 text-right">
                  <Num v={l.ordered} strong />
                </td>
                <td className="border-b border-line bg-action-50/30 px-3 py-2 text-right">
                  <Num v={l.cancelled} tone="muted" />
                </td>
                <td className="border-b border-line bg-teal-50/40 px-3 py-2 text-right">
                  <Num v={l.onDeliveryNotes} />
                  {dec.gt0(l.shortShipped) && <span className="block text-[11px] text-warn">manque au BL {fmtDecimal(l.shortShipped)}</span>}
                </td>
                <td className="border-b border-line bg-ok-bg/30 px-3 py-2 text-right">
                  <Num v={l.physicallyReceived} />
                  {dec.gt0(l.shortReceived) && <span className="block text-[11px] text-danger">BL − reçu : {fmtDecimal(l.shortReceived)}</span>}
                  {dec.gt0(l.surplus) && <span className="block text-[11px] text-info">excédent {fmtDecimal(l.surplus)}</span>}
                </td>
                <td className="border-b border-line bg-ok-bg/30 px-3 py-2 text-right">
                  <Num v={l.accepted} tone={dec.gt0(l.accepted) ? 'ok' : undefined} strong />
                </td>
                <td className="border-b border-line bg-ok-bg/30 px-3 py-2 text-right">
                  <Num v={l.rejected} tone={dec.gt0(l.rejected) ? 'danger' : 'muted'} />
                </td>
                <td className="border-b border-line bg-warn-bg/30 px-3 py-2 text-right">
                  <Num v={l.remaining} tone={dec.gt0(l.remaining) ? 'warn' : 'muted'} strong={dec.gt0(l.remaining)} />
                </td>
                <td className="border-b border-line bg-warn-bg/30 px-3 py-2">
                  {l.openVariances.length ? (
                    <ul className="space-y-1">
                      {l.openVariances.map((v) => (
                        <li key={v.id}>
                          <Link href={`/purchasing/deliveries/variances/${v.id}`} className="inline-flex items-center gap-1 hover:underline">
                            <StatusPill status={v.type} labels={VARIANCE_TYPE_LABELS} tones={VARIANCE_TYPE_TONES} />
                            <span className="text-xs tabular">{fmtDecimal(v.quantity)}</span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="text-xs text-ink-muted">Aucun</span>
                  )}
                </td>
                <td className="border-b border-line px-3 py-2 text-xs">
                  {l.prAllocations.map((a) => (
                    <Link key={`${a.prId}-${a.prLineNo}`} href={`/purchasing/requests/${a.prId}`} className="block text-action hover:underline">
                      {a.prNumber} L{a.prLineNo} · {fmtDecimal(a.quantity)}
                    </Link>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
          {sameUnit && (
          <tfoot>
            <tr className="bg-surface-sunken text-sm font-semibold">
              <th scope="row" className="sticky left-0 bg-surface-sunken px-3 py-2 text-left">
                Totaux ({sameUnit})
              </th>
              <td className="px-3 py-2 text-right tabular">{fmtDecimal(r.totals.ordered)}</td>
              <td className="px-3 py-2" />
              <td className="px-3 py-2 text-right tabular">{fmtDecimal(r.totals.onDeliveryNotes)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtDecimal(r.totals.physicallyReceived)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtDecimal(r.totals.accepted)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtDecimal(r.totals.rejected)}</td>
              <td className="px-3 py-2 text-right tabular">{fmtDecimal(r.totals.remaining)}</td>
              <td className="px-3 py-2" colSpan={2} />
            </tr>
          </tfoot>
          )}
        </table>
      </div>
      <p className="text-xs text-ink-muted">
        Reste à recevoir = commandé − annulé − accepté. Un reliquat reste visible jusqu’à réception, annulation (avenant) ou clôture documentée du BC.
      </p>
    </div>
  );
}
