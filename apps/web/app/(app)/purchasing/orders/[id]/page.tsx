'use client';

import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Ban, CheckCircle2, CircleDashed, FilePenLine, Lock, MailCheck, PackageCheck, Pencil, Receipt, Send, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileRow } from '@/components/amc/file-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  APPROVAL_REASON_LABELS,
  DN_STATUS_LABELS,
  DN_STATUS_TONES,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_TONES,
  RECEIPT_STATUS_LABELS,
  RECEIPT_STATUS_TONES,
  VARIANCE_STATUS_LABELS,
  VARIANCE_STATUS_TONES,
  VARIANCE_TYPE_LABELS,
  VARIANCE_TYPE_TONES,
  dec,
  isPast,
  isPoReceivable,
  purKeys,
  useCommand,
  useUrlParams,
} from '@/components/purchasing/lib';
import { DispatchTable, EditDraftPoDialog, MarkPoSentDialog, RevisePoDialog } from '@/components/purchasing/po-dialogs';
import { DiscrepancyPanel } from '@/components/purchasing/po-discrepancy';
import { ReconciliationTable } from '@/components/purchasing/reconciliation-table';
import type { HistoryEvent, IssueOrderResult, PoDetail, PoRevisionFull } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, HistoryList, Money, PdfActions, PoStatusBadge, StatusPill, TextActionDialog } from '@/components/purchasing/ui';

const RECEIVABLE = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'];

type DialogKind = 'edit' | 'issue' | 'approve' | 'reject' | 'markSent' | 'revise' | 'cancel' | 'close';

export default function PurchaseOrderPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <PoView />
    </Suspense>
  );
}

function PoView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { get, set } = useUrlParams();
  const { can, canAny, me } = useSession();
  const run = useCommand();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const q = useQuery({ queryKey: purKeys.order(id), queryFn: () => api.get<PoDetail>(`/orders/${id}`) });

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const po = q.data;
  const s = po.status;
  const v = po.lockVersion;
  const tab = get('tab') || 'lines';
  const late = ['SENT', 'PARTIALLY_RECEIVED'].includes(s) && isPast(po.expectedDeliveryDate);
  const remaining = po.lines.some((l) => l.status !== 'CANCELLED' && dec.gt0(l.balance?.remaining));
  const openVariances = (po.variances ?? []).filter((x) => x.status === 'OPEN' || x.status === 'IN_PROGRESS');
  const isCreator = po.createdById === me.id;
  // Approbation : ni le créateur, ni celui qui a soumis / émis l'avenant (approvedById) — séparation des rôles
  const cannotApprove = isCreator || po.approvedById === me.id;
  const receivable = isPoReceivable(po);
  const amendmentPending = s === 'APPROVAL_PENDING' && !!po.sentAt;
  // Avenant approuvé d'un BC déjà transmis (avant correctif ACH-04) : noter l'envoi rétablit le statut de réception
  const amendmentToSend = s === 'APPROVED' && !!po.sentAt;
  const canIssue = can('bc.create') && (s === 'DRAFT' || (s === 'APPROVED' && !po.sentAt));

  const actions = (
    <>
      <PdfActions path={`/orders/${po.id}/pdf`} title={`BC ${po.number}${po.revisionNo ? ` — révision ${po.revisionNo}` : ''}`} label={po.pdfFileId ? 'PDF officiel' : 'PDF'} />
      {s === 'DRAFT' && can('bc.create') && (
        <Button variant="secondary" onClick={() => setDialog('edit')}>
          <Pencil className="h-4 w-4" aria-hidden /> Modifier
        </Button>
      )}
      {canIssue && (
        <Button onClick={() => setDialog('issue')}>
          <Send className="h-4 w-4" aria-hidden /> Émettre le BC
        </Button>
      )}
      {s === 'APPROVAL_PENDING' && can('bc.approve') && (
        <>
          <Button
            onClick={() => setDialog('approve')}
            disabled={cannotApprove}
            title={cannotApprove ? 'Second regard : l’approbation revient à une autre personne que le créateur du BC et l’auteur de la soumission / de l’avenant' : undefined}
          >
            <CheckCircle2 className="h-4 w-4" aria-hidden /> {amendmentPending ? 'Approuver l’avenant' : 'Approuver (second regard)'}
          </Button>
          {!po.sentAt && (
            <Button variant="danger" onClick={() => setDialog('reject')} disabled={cannotApprove}>
              <XCircle className="h-4 w-4" aria-hidden /> Refuser
            </Button>
          )}
        </>
      )}
      {receivable && can('receiving.record') && (
        <Button onClick={() => router.push(`/purchasing/deliveries/receive?poId=${po.id}`)}>
          <PackageCheck className="h-4 w-4" aria-hidden /> Répondre par un BL
        </Button>
      )}
      {(RECEIVABLE.includes(s) || amendmentToSend) && can('bc.send') && (
        <Button variant={amendmentToSend ? 'secondary' : 'ghost'} onClick={() => setDialog('markSent')}>
          <MailCheck className="h-4 w-4" aria-hidden /> Noter l’envoi au fournisseur
        </Button>
      )}
      {receivable && can('bc.cancel') && (
        <Button variant="secondary" onClick={() => setDialog('revise')}>
          <FilePenLine className="h-4 w-4" aria-hidden /> Avenant
        </Button>
      )}
      {RECEIVABLE.includes(s) && canAny('bc.create', 'bc.cancel') && (
        <Button variant="ghost" onClick={() => setDialog('close')}>
          <Lock className="h-4 w-4" aria-hidden /> Clôturer
        </Button>
      )}
      {['DRAFT', 'APPROVAL_PENDING', 'APPROVED', 'SENT'].includes(s) && (can('bc.cancel') || (s === 'DRAFT' && isCreator && can('bc.create'))) && (
        <Button variant="ghost" onClick={() => setDialog('cancel')}>
          <Ban className="h-4 w-4" aria-hidden /> {s === 'DRAFT' ? 'Abandonner' : 'Annuler'}
        </Button>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Bons de commande', href: '/purchasing/orders' }, { label: po.number }]}
        title={<>Bon de commande <span className="ref">{po.number}</span></>}
        description={`${po.supplier.name} — ${po.vessel.name}`}
        meta={
          <>
            <PoStatusBadge status={s} />
            {po.revisionNo > 0 && <Badge tone="info">Révision n°{po.revisionNo}</Badge>}
            {po.requiresSecondApproval && <Badge tone="warn">Second regard requis</Badge>}
            {late && (
              <Badge tone="danger" icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
                Livraison en retard ({fmtDate(po.expectedDeliveryDate)})
              </Badge>
            )}
            {openVariances.length > 0 && <Badge tone="danger">{openVariances.length} écart(s) ouvert(s)</Badge>}
          </>
        }
        actions={actions}
      />

      <DiscrepancyPanel po={po} />
      {s === 'DRAFT' && (
        <Callout tone="info" className="mb-4" title="Brouillon — prochaine étape : émettre le BC">
          À l’émission, le BC est transmis au créateur de la PR (notification et e-mail avec le PDF : fournisseur, articles, date et port de livraison).
        </Callout>
      )}
      {RECEIVABLE.includes(s) && s !== 'RECEIVED' && !openVariances.length && (
        <Callout tone="info" className="mb-4" title={`BC émis${po.sentAt ? ` le ${fmtDateTime(po.sentAt)}` : ''} — en attente du BL du bord`}>
          {can('receiving.record')
            ? `Livraison prévue ${po.expectedDeliveryDate ? `le ${fmtDate(po.expectedDeliveryDate)}` : 'à une date à confirmer'}${po.deliveryPort ? ` à ${po.deliveryPort}` : ''} : à la réception, cliquez « Répondre par un BL » (saisie des quantités ou BL joint). Les écarts sont signalés aux Achats.`
            : `Le bord répond par un BL à la livraison${po.expectedDeliveryDate ? ` (prévue le ${fmtDate(po.expectedDeliveryDate)}${po.deliveryPort ? `, ${po.deliveryPort}` : ''})` : ''}. Tout écart avec le BC vous sera signalé ; le BC se clôture automatiquement quand tout est reçu.`}
        </Callout>
      )}
      {s === 'APPROVAL_PENDING' && !amendmentPending && (
        <Callout tone="warn" className="mb-4" title="Second regard en attente">
          Le montant franchit le seuil configuré : une personne disposant de bc.approve, différente du créateur ({po.createdByName ?? '—'}), doit l’approuver. Le BC sera alors émis
          automatiquement et transmis au demandeur.
        </Callout>
      )}
      {amendmentPending && (
        <Callout tone="warn" className="mb-4" title={`Avenant n°${po.revisionNo} en attente de second regard`}>
          Cet avenant à la hausse d’un BC déjà émis doit être approuvé (bc.approve) par une autre personne que son auteur et que le créateur du BC ; il ne peut pas
          être renvoyé en brouillon. Les BL et réceptions restent possibles.
        </Callout>
      )}
      {amendmentToSend && (
        <Callout tone="warn" className="mb-4" title={`Avenant n°${po.revisionNo} approuvé — envoi au fournisseur à noter`}>
          Transmettez la nouvelle version au fournisseur puis cliquez « Noter l’envoi au fournisseur » : le BC reprend son statut de réception et se clôture
          automatiquement si tout a été reçu.
        </Callout>
      )}
      {s === 'CANCELLED' && (
        <Callout tone="danger" className="mb-4" title={`BC annulé le ${fmtDateTime(po.cancelledAt)}`}>
          {po.cancelReason}
        </Callout>
      )}

      <div className="mb-5 grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,1fr)]">
        <Panel>
          <DefinitionGrid
            columns={4}
            items={[
              ['Fournisseur', <Link key="s" href={`/purchasing/suppliers?selected=${po.supplierId}`} className="text-action hover:underline">{po.supplier.name}</Link>],
              ['Navire', po.vessel.name],
              ['Date de commande', fmtDate(po.orderDate)],
              ['Livraison attendue', po.expectedDeliveryDate ? fmtDate(po.expectedDeliveryDate) : null],
              ['Port de livraison', po.deliveryPort],
              ['Conditions de livraison', po.deliveryTerms],
              ['Conditions de paiement', po.paymentTerms ?? po.supplier.paymentTerms],
              [
                'Devis d’origine',
                po.quotation ? (
                  <Link key="q" href={`/purchasing/rfqs/${po.quotation.rfqId}?tab=quotations`} className="text-action hover:underline">
                    {po.quotation.reference ?? 'Devis'} (RFQ)
                  </Link>
                ) : (
                  'BC manuel (depuis PR)'
                ),
              ],
              ['Créé par', `${po.createdByName ?? '—'} le ${fmtDateTime(po.createdAt)}`],
              ['Émis', po.sentAt ? `${fmtDateTime(po.sentAt)} par ${po.sentByName ?? '—'}` : null],
              ['Notes', po.notes ? <span key="n" className="whitespace-pre-line">{po.notes}</span> : null],
            ]}
          />
        </Panel>
        <Panel title={`Montants (${po.currency})`}>
          <dl className="space-y-1 text-sm">
            <AmountRow label="Sous-total" value={<Money value={po.subtotal} currency={po.currency} />} />
            <AmountRow label="Taxes" value={<Money value={po.taxAmount} currency={po.currency} />} />
            <AmountRow label="Fret" value={<Money value={po.freightAmount} currency={po.currency} />} />
            <div className="border-t border-line pt-1">
              <AmountRow label="Total" value={<Money value={po.totalAmount} currency={po.currency} strong />} />
            </div>
          </dl>
          <p className="mt-2 text-xs text-ink-muted">Montants dans la devise du BC ; aucune conversion.</p>
        </Panel>
      </div>

      <Tabs value={tab} onValueChange={(t) => set({ tab: t === 'lines' ? null : t })}>
        <TabsList className="mb-4">
          <TabsTrigger value="lines" count={po.lines.length}>
            Lignes & allocations
          </TabsTrigger>
          {canAny('bc.view', 'receiving.view') && <TabsTrigger value="reconciliation">Rapprochement BC | BL | reçu</TabsTrigger>}
          <TabsTrigger value="approval">Approbation & envois</TabsTrigger>
          {po.deliveryNotes && (
            <TabsTrigger value="deliveries" count={(po.deliveryNotes?.length ?? 0) + (po.receipts?.length ?? 0)}>
              Livraisons & réceptions
            </TabsTrigger>
          )}
          {po.variances && (
            <TabsTrigger value="variances" count={openVariances.length}>
              Écarts
            </TabsTrigger>
          )}
          {po.invoices && (
            <TabsTrigger value="invoices" count={po.invoices.length}>
              Factures
            </TabsTrigger>
          )}
          <TabsTrigger value="revisions" count={po.revisions.length}>
            Révisions
          </TabsTrigger>
          <TabsTrigger value="files" count={po.attachments.length}>
            Pièces jointes
          </TabsTrigger>
          <TabsTrigger value="history">Historique</TabsTrigger>
        </TabsList>

        <TabsContent value="lines">
          <LinesPanel po={po} />
        </TabsContent>
        <TabsContent value="reconciliation">{tab === 'reconciliation' && <ReconciliationTable poId={po.id} />}</TabsContent>
        <TabsContent value="approval">
          <ApprovalPanel po={po} />
        </TabsContent>
        <TabsContent value="deliveries">
          <DeliveriesPanel po={po} />
        </TabsContent>
        <TabsContent value="variances">
          <Panel title="Écarts de livraison / réception">
            {(po.variances ?? []).length ? (
              <ul className="divide-y divide-line">
                {(po.variances ?? []).map((x) => {
                  const line = po.lines.find((l) => l.id === x.poLineId);
                  return (
                    <li key={x.id}>
                      <Link href={`/purchasing/deliveries/variances/${x.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 hover:bg-action-50/40">
                        <span className="min-w-0">
                          <span className="mr-2 inline-block align-middle">
                            <StatusPill status={x.type} labels={VARIANCE_TYPE_LABELS} tones={VARIANCE_TYPE_TONES} />
                          </span>
                          <span className="text-sm">
                            {fmtDecimal(x.quantity)} {line?.unit} — {x.description}
                          </span>
                        </span>
                        <StatusPill status={x.status} labels={VARIANCE_STATUS_LABELS} tones={VARIANCE_STATUS_TONES} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Aucun écart enregistré.</p>
            )}
          </Panel>
        </TabsContent>
        <TabsContent value="invoices">
          <Panel
            title="Factures liées"
            actions={
              can('invoice.manage') && (receivable || ['APPROVED', 'CLOSED'].includes(s)) ? (
                <Link href={`/purchasing/invoices?new=1&supplierId=${po.supplierId}&poId=${po.id}`} className="text-sm font-medium text-action hover:underline">
                  Enregistrer une facture
                </Link>
              ) : undefined
            }
          >
            <Callout tone="info" className="mb-3" title="Une facture ne clôt jamais un BC">
              Le statut de réception d’un BC (partiellement reçu, reçu) ne dépend que des quantités acceptées à bord, jamais des factures (PUR-07).
            </Callout>
            {(po.invoices ?? []).length ? (
              <ul className="divide-y divide-line">
                {(po.invoices ?? []).map((i) => (
                  <li key={i.id}>
                    <Link href={`/purchasing/invoices/${i.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-action-50/40">
                      <span className="font-medium text-action">{i.number}</span>
                      <span className="flex items-center gap-2">
                        <Money value={dec.add(i.amount, i.taxAmount)} currency={i.currency} />
                        <StatusPill status={i.status} labels={INVOICE_STATUS_LABELS} tones={INVOICE_STATUS_TONES} />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Aucune facture rattachée.</p>
            )}
          </Panel>
        </TabsContent>
        <TabsContent value="revisions">{tab === 'revisions' && <RevisionsPanel po={po} />}</TabsContent>
        <TabsContent value="files">
          <Panel title="Pièces jointes">
            <AttachmentsPanel path={`/orders/${po.id}/attachments`} vesselId={po.vesselId} attachments={po.attachments} canManage={canAny('bc.create', 'bc.send')} onChanged={() => q.refetch()} />
          </Panel>
        </TabsContent>
        <TabsContent value="history">
          <Panel title="Chronologie">
            <HistoryList path={`/orders/${po.id}/history`} queryKey={purKeys.order(po.id)} />
          </Panel>
        </TabsContent>
      </Tabs>

      {dialog === 'edit' && <EditDraftPoDialog po={po} onClose={() => setDialog(null)} />}
      {dialog === 'markSent' && <MarkPoSentDialog po={po} onClose={() => setDialog(null)} />}
      {dialog === 'revise' && <RevisePoDialog po={po} onClose={() => setDialog(null)} />}
      <TextActionDialog
        open={dialog === 'issue'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Émettre le BC ${po.number}`}
        description={`Le BC est transmis au créateur de la PR (notification et e-mail avec le PDF) : ${po.supplier.name}, livraison ${po.expectedDeliveryDate ? `le ${fmtDate(po.expectedDeliveryDate)}` : 'à confirmer'}${po.deliveryPort ? ` à ${po.deliveryPort}` : ''}. Un second regard n’intervient que si un seuil configuré l’exige.`}
        label="Commentaire (journal d’audit)"
        confirmLabel="Émettre"
        onConfirm={(comment) =>
          run(
            () => api.post<IssueOrderResult & { approvalDecision?: { reason: string; threshold: string | null } | null }>(`/orders/${po.id}/issue`, { expectedVersion: v, comment: comment || undefined }),
            (r) =>
              r.issued
                ? r.message
                : `${r.message}${r.approvalDecision ? ` (${APPROVAL_REASON_LABELS[r.approvalDecision.reason] ?? r.approvalDecision.reason}${r.approvalDecision.threshold ? ` : seuil ${r.approvalDecision.threshold} ${po.currency}` : ''})` : ''}`,
          )
        }
      />
      <TextActionDialog
        open={dialog === 'approve'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Approuver le BC ${po.number}`}
        description={`Second regard sur un montant de ${po.totalAmount} ${po.currency}.${po.sentAt ? '' : ' Le BC sera émis et transmis au demandeur dès l’approbation.'}`}
        confirmLabel="Approuver"
        onConfirm={(comment) => run(() => api.post(`/orders/${po.id}/approve`, { expectedVersion: v, comment: comment || undefined }), 'BC approuvé')}
      />
      <TextActionDialog
        open={dialog === 'reject'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Refuser le BC ${po.number}`}
        description="Le BC revient en brouillon pour correction."
        label="Motif du refus"
        required
        tone="danger"
        confirmLabel="Refuser"
        onConfirm={(comment) => run(() => api.post(`/orders/${po.id}/reject`, { expectedVersion: v, comment }), 'BC refusé (retour en brouillon)')}
      />
      <TextActionDialog
        open={dialog === 'cancel'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={s === 'DRAFT' ? `Abandonner le brouillon ${po.number}` : `Annuler le BC ${po.number}`}
        description={
          s === 'SENT'
            ? 'Impossible si un BL ou une réception est enregistré (passez par un avenant puis la clôture). Le fournisseur n’est pas prévenu automatiquement.'
            : 'Les quantités allouées aux lignes PR sont libérées.'
        }
        label="Motif"
        required
        tone="danger"
        confirmLabel={s === 'DRAFT' ? 'Abandonner' : 'Annuler le BC'}
        onConfirm={(reason) => run(() => api.post<{ note?: string }>(`/orders/${po.id}/cancel`, { expectedVersion: v, reason }), (r) => r.note ?? 'BC annulé')}
      />
      <TextActionDialog
        open={dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Clôturer le BC ${po.number}`}
        description={
          openVariances.length
            ? `${openVariances.length} écart(s) ouvert(s) : ils doivent être résolus avant la clôture.`
            : remaining
              ? 'Un reliquat n’est pas reçu : la clôture est une décision documentée (bc.cancel + motif) qui annule le reliquat par une révision.'
              : 'Toutes les quantités sont reçues et acceptées.'
        }
        label="Motif / décision"
        required={remaining}
        confirmLabel="Clôturer"
        onConfirm={(reason) => run(() => api.post(`/orders/${po.id}/close`, { expectedVersion: v, reason: reason || undefined }), 'BC clôturé')}
      />
    </>
  );
}

function AmountRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}

function LinesPanel({ po }: { po: PoDetail }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-white shadow-panel">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col">N°</th>
            <th scope="col">Désignation</th>
            <th scope="col" className="text-right">
              Commandé
            </th>
            <th scope="col" className="text-right">
              PU
            </th>
            <th scope="col" className="text-right">
              Total ligne
            </th>
            <th scope="col">Allocation aux lignes PR</th>
            <th scope="col" className="text-right">
              Accepté / reste
            </th>
          </tr>
        </thead>
        <tbody>
          {po.lines.map((l) => (
            <tr key={l.id} className={l.status === 'CANCELLED' ? 'text-ink-muted' : ''}>
              <td className="tabular">{l.lineNo}</td>
              <td className="min-w-[200px]">
                <span className={l.status === 'CANCELLED' ? 'line-through' : ''}>{l.designation}</span>
                {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                {l.remarks && <span className="block text-xs italic text-ink-muted">{l.remarks}</span>}
                {l.status === 'CANCELLED' && (
                  <Badge tone="neutral" icon={<CircleDashed className="h-3.5 w-3.5" aria-hidden />}>
                    Ligne annulée
                  </Badge>
                )}
              </td>
              <td className="text-right tabular">
                {fmtDecimal(l.quantityOrdered)} {l.unit}
                {dec.gt0(l.quantityCancelled) && <span className="block text-xs text-ink-muted">dont annulé {fmtDecimal(l.quantityCancelled)}</span>}
              </td>
              <td className="text-right">
                <Money value={l.unitPrice} currency={po.currency} />
              </td>
              <td className="text-right">
                <Money value={l.lineTotal} currency={po.currency} />
              </td>
              <td className="text-xs">
                {l.allocations.map((a) => (
                  <Link key={a.id} href={`/purchasing/requests/${a.prLine.pr.id}`} className="block text-action hover:underline">
                    {a.prLine.pr.number} L{a.prLine.lineNo} · {fmtDecimal(a.quantity)} {a.prLine.unit}
                    {a.overAllocationReason && <span className="ml-1 text-warn">(dépassement : {a.overAllocationReason})</span>}
                  </Link>
                ))}
              </td>
              <td className="text-right text-xs tabular">
                {l.balance ? (
                  <>
                    <span className="text-ok">{fmtDecimal(l.balance.accepted)}</span> accepté
                    <span className={`block ${dec.gt0(l.balance.remaining) ? 'font-medium text-warn' : 'text-ink-muted'}`}>reste {fmtDecimal(l.balance.remaining)}</span>
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Step({ done, title, children }: { done: boolean | null; title: string; children?: ReactNode }) {
  return (
    <li className="flex items-start gap-3 rounded-md border border-line px-3 py-2">
      {done === null ? (
        <CircleDashed className="mt-0.5 h-5 w-5 text-ink-soft" aria-hidden />
      ) : done ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 text-ok" aria-hidden />
      ) : (
        <CircleDashed className="mt-0.5 h-5 w-5 text-warn" aria-hidden />
      )}
      <div className="min-w-0">
        <p className="text-sm font-medium">
          {title}{' '}
          <span className={done ? 'text-ok' : done === null ? 'text-ink-muted' : 'text-warn'}>({done ? 'fait' : done === null ? 'non requis' : 'en attente'})</span>
        </p>
        {children && <div className="text-xs text-ink-muted">{children}</div>}
      </div>
    </li>
  );
}

function ApprovalPanel({ po }: { po: PoDetail }) {
  const hist = useQuery({ queryKey: [...purKeys.order(po.id), 'history'], queryFn: () => api.get<HistoryEvent[]>(`/orders/${po.id}/history`) });
  const submitted = [...(hist.data ?? [])].reverse().find((e) => e.action === 'po.submitted');
  const decision = submitted?.metadata?.decision as { reason?: string; threshold?: string | null } | undefined;
  const rejected = (hist.data ?? []).filter((e) => e.action === 'po.rejected');
  const reapprovals = (hist.data ?? []).filter((e) => e.action === 'po.revised' && e.metadata?.reapproval === true);
  const s = po.status;
  const submittedDone = !['DRAFT'].includes(s) || !!submitted;
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel title="Circuit d’approbation">
        <ol className="space-y-2">
          <Step done title="Création">
            {po.createdByName ?? '—'} le {fmtDateTime(po.createdAt)}
          </Step>
          <Step done={s !== 'DRAFT' && s !== 'CANCELLED' ? true : submittedDone && s !== 'DRAFT'} title="Soumission et règle de seuil">
            {submitted ? (
              <>
                {fmtDateTime(submitted.occurredAt)} — {submitted.actorLabel}
                {decision?.reason && (
                  <span className="block">
                    Décision : {APPROVAL_REASON_LABELS[decision.reason] ?? decision.reason}
                    {decision.threshold ? ` (seuil ${decision.threshold} ${po.currency})` : ''}
                  </span>
                )}
              </>
            ) : (
              'Le seuil de la devise (s’il existe) est évalué à la soumission.'
            )}
          </Step>
          <Step done={po.approvedAt ? true : s === 'DRAFT' || s === 'APPROVAL_PENDING' ? false : null} title="Approbation">
            {po.approvedAt ? `${po.approvedByName ?? '—'} le ${fmtDateTime(po.approvedAt)}` : 'En attente'}
          </Step>
          <Step done={po.requiresSecondApproval ? !!po.secondApprovedAt : null} title="Second regard (bc.approve, personne différente)">
            {po.secondApprovedAt ? `${po.secondApprovedByName ?? '—'} le ${fmtDateTime(po.secondApprovedAt)}` : po.requiresSecondApproval ? 'Requis par la règle de seuil / la politique' : 'Non requis pour ce BC'}
          </Step>
          <Step done={po.sentAt ? true : ['DRAFT', 'APPROVAL_PENDING', 'APPROVED'].includes(s) ? false : null} title="Émission (transmis au demandeur)">
            {po.sentAt ? `${fmtDateTime(po.sentAt)} par ${po.sentByName ?? '—'}` : 'Non émis'}
          </Step>
        </ol>
        {reapprovals.length > 0 && (
          <div className="mt-3 space-y-1">
            {reapprovals.map((e) => {
              const d = e.metadata?.approvalDecision as { reason?: string } | undefined;
              return (
                <p key={e.id} className="text-xs text-warn">
                  Avenant du {fmtDateTime(e.occurredAt)} ({e.actorLabel}) repassé en second regard : {APPROVAL_REASON_LABELS[d?.reason ?? ''] ?? d?.reason ?? '—'}
                </p>
              );
            })}
          </div>
        )}
        {rejected.length > 0 && (
          <div className="mt-3 space-y-1">
            {rejected.map((e) => (
              <p key={e.id} className="text-xs text-danger">
                Refusé le {fmtDateTime(e.occurredAt)} par {e.actorLabel} : {(e.metadata?.comment as string) ?? '—'}
              </p>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Transmissions">
        <DispatchTable dispatches={po.dispatches} />
        <p className="mt-2 text-xs text-ink-muted">
          Le BC émis est transmis au demandeur (plateforme et e-mail). La plateforme n’envoie aucun e-mail au fournisseur : « Déclaré manuellement » = envoi noté par
          l’acheteur.
        </p>
      </Panel>
    </div>
  );
}

function DeliveriesPanel({ po }: { po: PoDetail }) {
  const { can } = useSession();
  const router = useRouter();
  const receivable = isPoReceivable(po);
  const lineById = new Map(po.lines.map((l) => [l.id, l]));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Panel
        title="Bons de livraison (BL)"
        actions={
          can('receiving.record') &&
          receivable && (
            <Button size="sm" variant="secondary" onClick={() => router.push(`/purchasing/deliveries/receive?poId=${po.id}`)}>
              <PackageCheck className="h-4 w-4" aria-hidden /> Répondre par un BL
            </Button>
          )
        }
      >
        {(po.deliveryNotes ?? []).length ? (
          <ul className="space-y-2">
            {(po.deliveryNotes ?? []).map((d) => (
              <li key={d.id} className="rounded-md border border-line px-3 py-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Link href={`/purchasing/deliveries/notes/${d.id}`} className="font-medium text-action hover:underline">
                    BL {d.number}
                  </Link>
                  <StatusPill status={d.status} labels={DN_STATUS_LABELS} tones={DN_STATUS_TONES} />
                </div>
                <p className="text-xs text-ink-muted">Livré le {fmtDate(d.deliveryDate)}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {d.lines.map((l) => `L${lineById.get(l.poLineId)?.lineNo ?? '?'} : ${fmtDecimal(l.quantityOnNote)} ${l.unit}`).join(' · ') || 'Aucun article du BC'}
                </p>
                {(d.extraItems ?? []).length > 0 && (
                  <p className="mt-1 text-xs text-info">Hors BC : {d.extraItems.map((x) => `${x.designation} (${fmtDecimal(x.quantity)} ${x.unit})`).join(', ')}</p>
                )}
                {d.notes && <p className="mt-1 whitespace-pre-line text-xs italic text-ink-muted">{d.notes}</p>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Aucun BL enregistré.</p>
        )}
      </Panel>
      <Panel
        title="Réceptions à bord">
        {(po.receipts ?? []).length ? (
          <ul className="divide-y divide-line">
            {(po.receipts ?? []).map((r) => (
              <li key={r.id}>
                <Link href={`/purchasing/deliveries/receipts/${r.id}`} className="flex items-center justify-between gap-2 py-2 hover:bg-action-50/40">
                  <span>
                    <span className="font-medium text-action">{r.number}</span>
                    <span className="block text-xs text-ink-muted">
                      {fmtDateTime(r.receivedAt)}
                      {r.deliveryNoteId ? ` · BL ${(po.deliveryNotes ?? []).find((d) => d.id === r.deliveryNoteId)?.number ?? ''}` : ' · sans BL'}
                    </span>
                  </span>
                  <StatusPill status={r.status} labels={RECEIPT_STATUS_LABELS} tones={RECEIPT_STATUS_TONES} />
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="Aucune réception" description="Les quantités physiquement reçues à bord soldent le BC — pas le BL." />
        )}
      </Panel>
    </div>
  );
}

function RevisionsPanel({ po }: { po: PoDetail }) {
  const q = useQuery({ queryKey: [...purKeys.order(po.id), 'revisions'], queryFn: () => api.get<PoRevisionFull[]>(`/orders/${po.id}/revisions`) });
  if (q.isLoading) return <LoadingBlock rows={3} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const revs = q.data ?? [];
  return (
    <div className="space-y-3">
      <Panel title="Version en vigueur">
        <p className="text-sm">
          Révision n°{po.revisionNo} — total <Money value={po.totalAmount} currency={po.currency} strong />
        </p>
        {po.pdfFileId ? (
          <div className="mt-2">
            <FileRow fileId={po.pdfFileId} name={`${po.number}${po.revisionNo ? `-REV${po.revisionNo}` : ''}.pdf (officiel)`} kind="PDF" />
          </div>
        ) : (
          <p className="mt-1 text-xs text-ink-muted">Le PDF officiel est généré à l’envoi (ou à la déclaration de transmission).</p>
        )}
      </Panel>
      {!revs.length && <EmptyState title="Aucun avenant" description="Une révision conserve les quantités contractuelles précédentes et génère un nouveau PDF ; la version transmise n’est jamais perdue." />}
      {revs.map((r) => (
        <Panel key={r.id} title={`Révision n°${r.revisionNo} — ${fmtDateTime(r.createdAt)} par ${r.createdByName ?? '—'}`}>
          <p className="mb-2 text-sm">
            <span className="font-medium">Motif : </span>
            {r.reason}
          </p>
          <p className="mb-1 text-xs text-ink-muted">
            Version précédente (n°{r.snapshot.revisionNo}) : total <Money value={r.snapshot.totalAmount} currency={r.snapshot.currency} />
          </p>
          <div className="overflow-x-auto">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Ligne</th>
                  <th scope="col" className="text-right">
                    Qté avant
                  </th>
                  <th scope="col" className="text-right">
                    Annulé avant
                  </th>
                  <th scope="col" className="text-right">
                    PU avant
                  </th>
                  <th scope="col" className="text-right">
                    Qté actuelle
                  </th>
                  <th scope="col" className="text-right">
                    PU actuel
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.snapshot.lines.map((l) => {
                  const cur = po.lines.find((x) => x.id === l.id);
                  const changed = cur && (dec.cmp(cur.quantityOrdered, l.quantityOrdered) !== 0 || dec.cmp(cur.quantityCancelled, l.quantityCancelled) !== 0 || dec.cmp(cur.unitPrice, l.unitPrice) !== 0);
                  return (
                    <tr key={l.id} className={changed ? 'bg-warn-bg/40' : ''}>
                      <td>
                        {l.lineNo}. {l.designation}
                      </td>
                      <td className="text-right tabular">
                        {fmtDecimal(l.quantityOrdered)} {l.unit}
                      </td>
                      <td className="text-right tabular">{fmtDecimal(l.quantityCancelled)}</td>
                      <td className="text-right">
                        <Money value={l.unitPrice} currency={r.snapshot.currency} />
                      </td>
                      <td className="text-right tabular">{cur ? `${fmtDecimal(cur.quantityOrdered)}${dec.gt0(cur.quantityCancelled) ? ` (−${fmtDecimal(cur.quantityCancelled)})` : ''}` : '—'}</td>
                      <td className="text-right">{cur ? <Money value={cur.unitPrice} currency={po.currency} /> : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="mt-2 space-y-1.5">
            {r.snapshot.pdfFileId && <FileRow fileId={r.snapshot.pdfFileId} name={`PDF transmis avant l’avenant (version n°${r.snapshot.revisionNo})`} kind="PDF" />}
            {r.pdfFileId && <FileRow fileId={r.pdfFileId} name={`PDF de la révision n°${r.revisionNo}`} kind="PDF" />}
          </div>
        </Panel>
      ))}
      <p className="flex items-center gap-1 text-xs text-ink-muted">
        <Receipt className="h-3.5 w-3.5" aria-hidden /> Chaque PDF transmis reste consultable ; la version transmise à bord n’est jamais perdue.
      </p>
    </div>
  );
}
