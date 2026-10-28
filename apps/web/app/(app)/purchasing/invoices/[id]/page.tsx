'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileRow } from '@/components/amc/file-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { INVOICE_NEXT, INVOICE_STATUS_LABELS, INVOICE_STATUS_TONES, MATCH_REASON_LABELS, dec, purKeys, useCommand } from '@/components/purchasing/lib';
import type { InvoiceDetail } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, Money, PoStatusBadge, StatusPill, TextActionDialog } from '@/components/purchasing/ui';

const ACTION_LABELS: Record<string, string> = {
  UNDER_REVIEW: 'Mettre en revue',
  MATCHED: 'Marquer rapprochée',
  DISPUTED: 'Signaler un litige',
  APPROVED: 'Approuver',
  CANCELLED: 'Annuler',
};

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { can, me } = useSession();
  const run = useCommand();
  const [target, setTarget] = useState<string | null>(null);
  const q = useQuery({ queryKey: purKeys.invoice(id), queryFn: () => api.get<InvoiceDetail>(`/invoices/${id}`) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const inv = q.data;
  const m = inv.matching;
  const gross = dec.add(inv.amount, inv.taxAmount);
  const isCreator = inv.createdById === me.id;
  const next = INVOICE_NEXT[inv.status] ?? [];
  const notesRequired = target === 'CANCELLED' || target === 'DISPUTED' || (target === 'MATCHED' && m.suggestion === 'DISPUTED');

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Factures', href: '/purchasing/invoices' }, { label: inv.number }]}
        title={<>Facture <span className="ref">{inv.number}</span></>}
        description={inv.supplier.name}
        meta={
          <>
            <StatusPill status={inv.status} labels={INVOICE_STATUS_LABELS} tones={INVOICE_STATUS_TONES} />
            <Badge tone={m.suggestion === 'MATCHED' ? 'ok' : 'danger'}>Rapprochement : {m.suggestion === 'MATCHED' ? 'conforme' : 'écart'}</Badge>
          </>
        }
        actions={
          can('invoice.manage') &&
          next.map((st) => (
            <Button
              key={st}
              variant={st === 'APPROVED' || st === 'MATCHED' ? 'primary' : st === 'CANCELLED' ? 'ghost' : 'secondary'}
              onClick={() => setTarget(st)}
              disabled={st === 'APPROVED' && isCreator}
              title={st === 'APPROVED' && isCreator ? 'Séparation des rôles : la personne qui a enregistré la facture ne peut pas l’approuver' : undefined}
            >
              {ACTION_LABELS[st] ?? st}
            </Button>
          ))
        }
      />
      <Callout tone="info" className="mb-4" title="Une facture ne clôt jamais un BC partiellement reçu">
        {m.note}
      </Callout>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title="Rapprochement commandé / reçu / facturé (par devise)">
            {m.reasons.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {m.reasons.map((r) => (
                  <Badge key={r} tone="danger">
                    {MATCH_REASON_LABELS[r] ?? r}
                  </Badge>
                ))}
              </div>
            ) : (
              <p className="mb-3 text-sm text-ok">Facturé ≤ commandé et ≤ reçu / accepté dans chaque devise.</p>
            )}
            <div className="overflow-x-auto">
              <table className="table-amc">
                <thead>
                  <tr>
                    <th scope="col">Devise</th>
                    <th scope="col" className="text-right">
                      Commandé
                    </th>
                    <th scope="col" className="text-right">
                      Reçu / accepté (valeur)
                    </th>
                    <th scope="col" className="text-right">
                      Facturé (cumul)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(m.byCurrency).map(([cur, v]) => (
                    <tr key={cur}>
                      <td className="font-medium">{cur}</td>
                      <td className="text-right">
                        <Money value={v.ordered} currency={cur} />
                      </td>
                      <td className="text-right">
                        <Money value={v.received} currency={cur} />
                      </td>
                      <td className={`text-right ${dec.cmp(v.invoiced, v.received) > 0 ? 'font-semibold text-danger' : ''}`}>
                        <Money value={v.invoiced} currency={cur} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <h3 className="mb-1 mt-4 text-sm font-semibold text-navy">Par bon de commande</h3>
            <div className="overflow-x-auto">
              <table className="table-amc">
                <thead>
                  <tr>
                    <th scope="col">BC</th>
                    <th scope="col">Statut de réception</th>
                    <th scope="col" className="text-right">
                      Commandé
                    </th>
                    <th scope="col" className="text-right">
                      Reçu (valeur)
                    </th>
                    <th scope="col" className="text-right">
                      Facturé (cumul)
                    </th>
                    <th scope="col" className="text-right">
                      Cette facture
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {m.orders.map((o) => (
                    <tr key={o.poId}>
                      <td>
                        <Link href={`/purchasing/orders/${o.poId}?tab=reconciliation`} className="font-medium text-action hover:underline">
                          {o.number}
                        </Link>
                      </td>
                      <td>
                        <PoStatusBadge status={o.poStatus} />
                      </td>
                      <td className="text-right">
                        <Money value={o.orderedTotal} currency={o.currency} />
                      </td>
                      <td className="text-right">
                        <Money value={o.receivedValue} currency={o.currency} />
                      </td>
                      <td className="text-right">
                        <Money value={o.invoicedCumulative} currency={o.currency} />
                      </td>
                      <td className="text-right">
                        <Money value={o.thisInvoice} currency={inv.currency} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-ink-muted">Valeur reçue = biens acceptés à bord × prix unitaire, frais au prorata. Aucune conversion de devise.</p>
          </Panel>
          {inv.reviewNotes && (
            <Panel title="Notes de revue">
              <p className="whitespace-pre-line text-sm">{inv.reviewNotes}</p>
            </Panel>
          )}
        </div>
        <div className="space-y-4">
          <Panel title={`Montants (${inv.currency})`}>
            <DefinitionGrid
              columns={2}
              items={[
                ['Montant HT', <Money key="ht" value={inv.amount} currency={inv.currency} />],
                ['Taxes', <Money key="tx" value={inv.taxAmount} currency={inv.currency} />],
                ['Total TTC', <Money key="ttc" value={gross} currency={inv.currency} strong />],
                ['Date de facture', fmtDate(inv.invoiceDate)],
                ['Échéance', inv.dueDate ? fmtDate(inv.dueDate) : null],
                ['Enregistrée', `${inv.createdByName ?? '—'} le ${fmtDateTime(inv.createdAt)}`],
              ]}
            />
          </Panel>
          <Panel title="Facture originale et pièces">
            {inv.fileId ? <FileRow fileId={inv.fileId} name={`Facture ${inv.number} (original)`} kind="PDF" /> : <p className="mb-2 text-sm text-warn">Fichier original non déposé.</p>}
            <div className="mt-2">
              <AttachmentsPanel
                path={`/invoices/${inv.id}/attachments`}
                vesselId={inv.vesselId ?? ''}
                attachments={inv.attachments.filter((a) => a.fileId !== inv.fileId)}
                canManage={can('invoice.manage') && !!inv.vesselId}
                onChanged={() => q.refetch()}
                emptyText="Aucune autre pièce."
              />
            </div>
          </Panel>
        </div>
      </div>
      <TextActionDialog
        open={!!target}
        onOpenChange={(o) => !o && setTarget(null)}
        title={`${ACTION_LABELS[target ?? ''] ?? ''} — ${inv.number}`}
        description={
          target === 'MATCHED' && m.suggestion === 'DISPUTED'
            ? `Le rapprochement présente un écart (${m.reasons.map((r) => MATCH_REASON_LABELS[r] ?? r).join(', ')}) : justification obligatoire.`
            : target === 'APPROVED'
              ? 'L’approbation revient à une autre personne que celle qui a enregistré la facture et que celle qui l’a rapprochée. Paiement et comptabilité hors V1.'
              : undefined
        }
        label="Notes"
        required={notesRequired}
        tone={target === 'CANCELLED' || target === 'DISPUTED' ? 'danger' : 'primary'}
        confirmLabel={ACTION_LABELS[target ?? ''] ?? 'Confirmer'}
        maxLength={5000}
        onConfirm={(notes) => run(() => api.post(`/invoices/${inv.id}/status`, { status: target, notes: notes || null }), `Facture : ${INVOICE_STATUS_LABELS[target ?? ''] ?? target}`)}
      />
    </>
  );
}
