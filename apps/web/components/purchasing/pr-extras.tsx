'use client';

import { useQuery } from '@tanstack/react-query';
import { MessageSquare, Send } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime, initials } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import {
  DN_STATUS_LABELS,
  DN_STATUS_TONES,
  INVOICE_STATUS_LABELS,
  INVOICE_STATUS_TONES,
  QUOTATION_STATUS_LABELS,
  QUOTATION_STATUS_TONES,
  RECEIPT_STATUS_LABELS,
  RECEIPT_STATUS_TONES,
  commandError,
  purKeys,
} from './lib';
import type { PrComment, PrDetail } from './types';
import { Money, PoStatusBadge, RfqStatusBadge, StatusPill } from './ui';

/** Fil de discussion d'une PR (commentaires liés éventuellement à une Counter-PR). */
export function PrCommentsThread({ pr }: { pr: PrDetail }) {
  const { canAny, me } = useSession();
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: [...purKeys.pr(pr.id), 'comments'], queryFn: () => api.get<PrComment[]>(`/purchase-requests/${pr.id}/comments`) });
  const revNo = new Map(pr.revisions.map((r) => [r.id, r.revisionNo]));
  const canPost = canAny('pr.create', 'pr.edit', 'pr.submit', 'pr.revise', 'pr.approve');

  const post = async () => {
    setBusy(true);
    try {
      await api.post(`/purchase-requests/${pr.id}/comments`, { body: body.trim() });
      setBody('');
      await q.refetch();
    } catch (e) {
      toast.error(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.length && <EmptyState icon={<MessageSquare className="h-5 w-5" aria-hidden />} title="Aucun échange" description="Questions, précisions et décisions motivées apparaissent ici." />}
      <ol className="space-y-3">
        {q.data?.map((c) => {
          const mine = c.authorId === me.id;
          return (
            <li key={c.id} className="flex gap-3">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${mine ? 'bg-action text-white' : 'bg-navy-50 text-navy'}`} aria-hidden>
                {initials(c.authorName ?? '?')}
              </span>
              <div className="min-w-0 flex-1 rounded-lg border border-line bg-white px-3 py-2">
                <p className="text-xs text-ink-muted">
                  <span className="font-medium text-ink">{c.authorName ?? '—'}</span> · {fmtDateTime(c.createdAt)}
                  {c.revisionId && revNo.has(c.revisionId) ? ` · Counter-PR n°${revNo.get(c.revisionId)}` : ''}
                </p>
                <p className="mt-1 whitespace-pre-line break-words text-sm">{c.body}</p>
              </div>
            </li>
          );
        })}
      </ol>
      {canPost && (
        <div className="rounded-lg border border-line bg-white p-3">
          <label htmlFor="pr-comment" className="field-label">
            Nouveau message
          </label>
          <Textarea id="pr-comment" rows={3} value={body} onChange={(e) => setBody(e.target.value)} maxLength={5000} placeholder="Précision sur un article, question au demandeur…" />
          <div className="mt-2 flex justify-end">
            <Button onClick={post} disabled={!body.trim()} loading={busy}>
              <Send className="h-4 w-4" aria-hidden /> Envoyer
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function LinkSection({ title, count, children, empty }: { title: string; count: number; children: ReactNode; empty: string }) {
  return (
    <section className="rounded-lg border border-line bg-white">
      <h3 className="flex items-center justify-between border-b border-line px-4 py-2 text-sm font-semibold text-navy">
        {title}
        <span className="rounded-full bg-navy-50 px-2 text-xs tabular text-ink-muted">{count}</span>
      </h3>
      {count ? <ul className="divide-y divide-line">{children}</ul> : <p className="px-4 py-3 text-sm text-ink-muted">{empty}</p>}
    </section>
  );
}

function Row({ href, primary, secondary, right }: { href?: string; primary: ReactNode; secondary?: ReactNode; right?: ReactNode }) {
  const body = (
    <div className="flex items-center justify-between gap-3 px-4 py-2">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium text-action">{primary}</p>
        {secondary && <p className="truncate text-xs text-ink-muted">{secondary}</p>}
      </div>
      <div className="flex shrink-0 items-center gap-2">{right}</div>
    </div>
  );
  return <li>{href ? <Link href={href} className="block hover:bg-action-50/50">{body}</Link> : body}</li>;
}

/** Documents liés à une PR : RFQ, devis, BC, BL, réceptions, factures (chacun selon sa permission). */
export function PrLinkedDocuments({ pr }: { pr: PrDetail }) {
  const l = pr.links;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {l.rfqs && (
        <LinkSection title="Demandes de prix (RFQ)" count={l.rfqs.length} empty="Aucune RFQ.">
          {l.rfqs.map((r) => (
            <Row key={r.id} href={`/purchasing/rfqs/${r.id}`} primary={r.number} secondary={`${r.title}${r.deadline ? ` · échéance ${fmtDate(r.deadline)}` : ''}`} right={<RfqStatusBadge status={r.status} />} />
          ))}
        </LinkSection>
      )}
      {l.quotations && (
        <LinkSection title="Devis fournisseurs" count={l.quotations.length} empty="Aucun devis.">
          {l.quotations.map((q) => (
            <Row
              key={q.id}
              href={`/purchasing/rfqs/${q.rfqId}?tab=quotations`}
              primary={`${q.supplier.name}${q.reference ? ` — ${q.reference}` : ''}`}
              right={
                <>
                  <Money value={q.totalAmount} currency={q.currency} />
                  <StatusPill status={q.status} labels={QUOTATION_STATUS_LABELS} tones={QUOTATION_STATUS_TONES} />
                </>
              }
            />
          ))}
        </LinkSection>
      )}
      {l.orders && (
        <LinkSection title="Bons de commande (BC)" count={l.orders.length} empty="Aucun BC.">
          {l.orders.map((o) => (
            <Row
              key={o.id}
              href={`/purchasing/orders/${o.id}`}
              primary={o.number}
              secondary={`${o.supplier.name}${o.expectedDeliveryDate ? ` · livraison attendue ${fmtDate(o.expectedDeliveryDate)}` : ''}`}
              right={
                <>
                  <Money value={o.totalAmount} currency={o.currency} />
                  <PoStatusBadge status={o.status} />
                </>
              }
            />
          ))}
        </LinkSection>
      )}
      {l.deliveryNotes && (
        <LinkSection title="Bons de livraison (BL)" count={l.deliveryNotes.length} empty="Aucun BL.">
          {l.deliveryNotes.map((d) => (
            <Row
              key={d.id}
              href={`/purchasing/deliveries/notes/${d.id}`}
              primary={d.number}
              secondary={`Livré le ${fmtDate(d.deliveryDate)} — déclaration fournisseur, pas une preuve de réception`}
              right={<StatusPill status={d.status} labels={DN_STATUS_LABELS} tones={DN_STATUS_TONES} />}
            />
          ))}
        </LinkSection>
      )}
      {l.receipts && (
        <LinkSection title="Réceptions à bord" count={l.receipts.length} empty="Aucune réception.">
          {l.receipts.map((r) => (
            <Row key={r.id} href={`/purchasing/deliveries/receipts/${r.id}`} primary={r.number} secondary={`Reçu le ${fmtDateTime(r.receivedAt)}`} right={<StatusPill status={r.status} labels={RECEIPT_STATUS_LABELS} tones={RECEIPT_STATUS_TONES} />} />
          ))}
        </LinkSection>
      )}
      {l.invoices && (
        <LinkSection title="Factures" count={l.invoices.length} empty="Aucune facture.">
          {l.invoices.map((i) => (
            <Row
              key={i.id}
              href={`/purchasing/invoices/${i.id}`}
              primary={i.number}
              secondary={i.supplier.name}
              right={
                <>
                  <Money value={i.amount} currency={i.currency} />
                  <StatusPill status={i.status} labels={INVOICE_STATUS_LABELS} tones={INVOICE_STATUS_TONES} />
                </>
              }
            />
          ))}
        </LinkSection>
      )}
    </div>
  );
}
