'use client';

import { useQuery } from '@tanstack/react-query';
import { AlarmClock, CheckCircle2, ExternalLink, FileText, Paperclip, Ship, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { SecureImage } from '@/components/amc/secure-image';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn, daysUntil, fmtBytes, fmtDate, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { QUOTATION_STATUS_LABELS, QUOTATION_STATUS_TONES, RFQ_SUPPLIER_STATUS_LABELS, RFQ_SUPPLIER_STATUS_TONES, purKeys } from './lib';
import type { Comparison, RfqDetail } from './types';
import { Money, RfqStatusBadge, StatusPill } from './ui';

function Section({ title, link, children, className }: { title: string; link?: { href: string; label: string }; children: ReactNode; className?: string }) {
  return (
    <section className={cn('border-t border-line px-4 py-3.5', className)}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-navy">{title}</h3>
        {link && (
          <Link href={link.href} className="text-xs font-medium text-action hover:underline">
            {link.label}
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}

/** Étapes du circuit RFQ réel (CDC §6.5) ; l'étape courante pointe vers l'onglet où elle se traite. */
function nextSteps(rfq: RfqDetail, hasPo: boolean) {
  const base = `/purchasing/rfqs/${rfq.id}`;
  const steps = [
    { key: 'suppliers', label: 'Choisir les fournisseurs à consulter', href: `${base}?tab=suppliers` },
    { key: 'issue', label: 'Contacter les fournisseurs (hors plateforme) et noter le contact', href: `${base}?tab=suppliers` },
    { key: 'quotes', label: 'Saisir les devis reçus', href: `${base}?tab=quotations` },
    { key: 'compare', label: 'Comparer et sélectionner (justification)', href: `${base}?tab=comparison` },
    { key: 'po', label: 'Créer le bon de commande', href: `${base}?tab=selections` },
    { key: 'close', label: 'Clôturer la RFQ', href: base },
  ];
  const current =
    rfq.status === 'DRAFT'
      ? rfq.suppliers.length
        ? 1
        : 0
      : rfq.status === 'ISSUED'
        ? 2
        : rfq.status === 'QUOTED'
          ? 3
          : rfq.status === 'EVALUATED'
            ? hasPo
              ? 5
              : 4
            : steps.length;
  return { steps, current };
}

/** Mini-comparaison : prix unitaires par ligne et par devis ; « moins cher » uniquement au sein d'une même devise. */
function MiniComparison({ c }: { c: Comparison }) {
  const quotes = c.quotations.slice(0, 4);
  // « Moins cher » n'a de sens qu'entre au moins deux offres de la même devise
  const sameCurrency = (currency: string) => c.quotations.filter((x) => x.currency === currency).length > 1;
  return (
    <>
      {c.fxNote && <p className="mb-2 rounded border border-warn-line bg-warn-bg px-2.5 py-1.5 text-xs text-warn">{c.fxNote}</p>}
      <div className="relative -mx-4 overflow-x-auto">
        <table className="table-amc min-w-[420px] text-xs">
          <caption className="sr-only">Comparaison des devis : prix unitaire par ligne</caption>
          <thead>
            <tr>
              <th scope="col">Ligne</th>
              <th scope="col" className="text-right">
                Qté
              </th>
              {quotes.map((q) => (
                <th key={q.quotationId} scope="col" className="text-right">
                  <span className="block max-w-[110px] truncate text-ink" title={q.supplier.name}>
                    {q.supplier.name}
                  </span>
                  <span className="font-normal">{q.currency}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.lines.slice(0, 6).map((l) => (
              <tr key={l.rfqLineId}>
                <td className="max-w-[150px]">
                  <span className="block truncate" title={l.designation}>
                    {l.designation}
                  </span>
                </td>
                <td className="tabular whitespace-nowrap text-right">
                  {fmtDecimal(l.quantity)} {l.unit}
                </td>
                {quotes.map((q) => {
                  const o = l.offers.find((x) => x.quotationId === q.quotationId);
                  const best = !!o?.cheapestInCurrency && l.offers.filter((x) => x.currency === o.currency && x.isAvailable && x.unitPrice !== null).length > 1;
                  return (
                    <td key={q.quotationId} className="text-right">
                      {!o || !o.isAvailable || o.unitPrice === null ? (
                        <span className="text-ink-soft">{o && !o.isAvailable ? 'Non dispo.' : '—'}</span>
                      ) : (
                        <span className={cn('tabular inline-block rounded px-1.5 py-0.5', best && 'bg-ok-bg font-semibold text-ok')}>
                          {fmtDecimal(o.unitPrice, 2)}
                          {best && <span className="sr-only"> (moins cher en {o.currency})</span>}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" colSpan={2} className="border-t border-line-strong bg-surface-sunken px-3 py-2 text-left font-semibold">
                Total devis
              </th>
              {quotes.map((q) => {
                const best = sameCurrency(q.currency) && c.totalsByCurrency[q.currency]?.find((t) => t.quotationId === q.quotationId)?.lowestTotal;
                return (
                  <td key={q.quotationId} className="border-t border-line-strong bg-surface-sunken px-3 py-2 text-right">
                    <Money value={q.totalAmount} currency={q.currency} strong className={best ? 'text-ok' : undefined} />
                    <span className="block text-2xs text-ink-muted">couverture {fmtDecimal(q.coverage.percent, 0)} %</span>
                  </td>
                );
              })}
            </tr>
          </tfoot>
        </table>
      </div>
      {(c.lines.length > 6 || c.quotations.length > 4) && (
        <p className="mt-1.5 text-xs text-ink-muted">
          Aperçu limité à 6 lignes et 4 devis ({c.lines.length} lignes, {c.quotations.length} devis au total).
        </p>
      )}
      <p className="mt-1.5 text-2xs text-ink-muted">Prix unitaires hors frais ; vert = moins cher de la ligne dans sa devise (aucune conversion).</p>
    </>
  );
}

/**
 * Synthèse d'une RFQ (liste maître / détail) : lecture seule. Les actions (contacts, saisie de devis, sélection, BC)
 * restent sur la fiche RFQ, qui porte confirmations et contrôles ; les étapes y renvoient directement.
 */
export function RfqPanel({ rfqId, hasPurchaseOrder, onClose }: { rfqId: string; hasPurchaseOrder: boolean; onClose: () => void }) {
  const { can } = useSession();
  const q = useQuery({ queryKey: purKeys.rfq(rfqId), queryFn: () => api.get<RfqDetail>(`/rfqs/${rfqId}`) });
  const rfq = q.data;
  const hasQuotes = !!rfq?.quotations?.some((x) => x.status !== 'WITHDRAWN');
  const comparison = useQuery({
    queryKey: [...purKeys.rfq(rfqId), 'comparison'],
    queryFn: () => api.get<Comparison>(`/rfqs/${rfqId}/comparison`),
    enabled: can('quotation.view') && hasQuotes,
  });

  return (
    <aside className="panel sticky top-[72px] max-h-[calc(100vh-88px)] overflow-y-auto" aria-label="Synthèse de la RFQ sélectionnée">
      {q.isLoading && <LoadingBlock rows={8} label="Chargement de la RFQ…" />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {rfq && (
        <>
          <div className="flex items-start justify-between gap-3 px-4 pb-3 pt-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="ref text-lg font-semibold">{rfq.number}</h2>
                <RfqStatusBadge status={rfq.status} />
                {hasPurchaseOrder && (
                  <Badge tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>
                    BC créé
                  </Badge>
                )}
              </div>
              <p className="mt-0.5 text-sm text-ink-muted">{rfq.title}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Link href={`/purchasing/rfqs/${rfq.id}`} className="inline-flex h-8 items-center gap-1.5 rounded-md bg-action px-3 text-sm font-medium text-white hover:bg-action-700">
                Ouvrir <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </Link>
              <IconButton label="Fermer la synthèse" onClick={onClose}>
                <X className="h-4 w-4" />
              </IconButton>
            </div>
          </div>

          {/* Navire concerné : photo officielle si consultable */}
          <div className="mx-4 mb-3 flex items-center gap-3 rounded-lg border border-line bg-surface-sunken p-2.5">
            {rfq.vessel.photoFileId && can('vessels.view') ? (
              <SecureImage fileId={rfq.vessel.photoFileId} alt={`Photo du navire ${rfq.vessel.name}`} className="h-14 w-24 shrink-0 rounded-md border border-line" />
            ) : (
              <span className="flex h-14 w-24 shrink-0 items-center justify-center rounded-md border border-line bg-navy-50 text-navy-600" aria-hidden>
                <Ship className="h-5 w-5" />
              </span>
            )}
            <div className="min-w-0 text-sm">
              <Link href={`/vessels/${rfq.vessel.id}`} className="block truncate font-semibold text-navy hover:text-action hover:underline">
                {rfq.vessel.name}
              </Link>
              <span className="block truncate text-xs text-ink-muted">
                {[rfq.vessel.vesselType, rfq.vessel.imoNumber && `IMO ${rfq.vessel.imoNumber}`].filter(Boolean).join(' · ') || rfq.vessel.code}
              </span>
            </div>
          </div>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 px-4 pb-3.5 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
            <dt className="text-ink-muted">Créée le</dt>
            <dd className="tabular">{fmtDate(rfq.createdAt)}</dd>
            <dt className="text-ink-muted">Par</dt>
            <dd className="truncate">{rfq.createdByName ?? '—'}</dd>
            <dt className="text-ink-muted">PR source</dt>
            <dd className="truncate">
              {[...new Map(rfq.lines.filter((l) => l.prLine).map((l) => [l.prLine.prId, l.prLine])).values()].map((p, i) => (
                <span key={p.prId}>
                  {i > 0 && ', '}
                  <Link href={`/purchasing/requests/${p.prId}`} className="ref text-action hover:underline">
                    {p.pr.number}
                  </Link>
                </span>
              ))}
              {!rfq.lines.some((l) => l.prLine) && '—'}
            </dd>
            <dt className="text-ink-muted">Émise le</dt>
            <dd className="tabular">{rfq.issuedAt ? fmtDate(rfq.issuedAt) : '—'}</dd>
            <dt className="text-ink-muted">Date limite</dt>
            <dd>
              {rfq.deadline ? (
                <span className="tabular">
                  {fmtDate(rfq.deadline)}
                  {(() => {
                    const d = daysUntil(rfq.deadline);
                    if (d === null || !['DRAFT', 'ISSUED', 'QUOTED'].includes(rfq.status)) return null;
                    return (
                      <span className={cn('ml-1.5 text-xs', d < 0 ? 'font-semibold text-danger' : 'text-ok')}>
                        {d < 0 ? `(dépassée de ${-d} j)` : d === 0 ? '(aujourd’hui)' : `(${d} j restants)`}
                      </span>
                    );
                  })()}
                </span>
              ) : (
                '—'
              )}
            </dd>
            <dt className="text-ink-muted">Livraison</dt>
            <dd className="truncate">{[rfq.deliveryPort, rfq.deliveryTerms].filter(Boolean).join(' · ') || '—'}</dd>
          </dl>
          {rfq.notes && <p className="mx-4 mb-3.5 whitespace-pre-line rounded-md bg-surface-sunken px-3 py-2 text-xs text-ink">{rfq.notes}</p>}

          <Section title={`Fournisseurs consultés (${rfq.suppliers.length})`} link={{ href: `/purchasing/rfqs/${rfq.id}?tab=suppliers`, label: 'Gérer' }}>
            {rfq.suppliers.length === 0 ? (
              <p className="text-sm text-ink-muted">Aucun fournisseur ajouté pour l’instant.</p>
            ) : (
              <ul className="grid gap-2 sm:grid-cols-2">
                {rfq.suppliers.map((s) => {
                  const quote = rfq.quotations?.find((x) => x.supplierId === s.supplierId && x.status !== 'WITHDRAWN');
                  return (
                    <li key={s.id} className="rounded-md border border-line px-3 py-2">
                      <p className="truncate text-sm font-semibold text-navy">{s.supplier.name}</p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <StatusPill status={s.status} labels={RFQ_SUPPLIER_STATUS_LABELS} tones={RFQ_SUPPLIER_STATUS_TONES} />
                        {/* « Reçu » double « Devis reçu » : l'état du devis n'est montré qu'après évaluation */}
                        {quote && quote.status !== 'RECEIVED' && <StatusPill status={quote.status} labels={QUOTATION_STATUS_LABELS} tones={QUOTATION_STATUS_TONES} />}
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        {quote ? (
                          <>
                            Reçu le {fmtDate(quote.receivedAt)} · <Money value={quote.totalAmount} currency={quote.currency} />
                          </>
                        ) : s.sentAt ? (
                          `Contacté le ${fmtDate(s.sentAt)}`
                        ) : (
                          'Pas encore contacté'
                        )}
                      </p>
                    </li>
                  );
                })}
              </ul>
            )}
          </Section>

          {can('quotation.view') && hasQuotes && (
            <Section title="Comparaison des devis" link={{ href: `/purchasing/rfqs/${rfq.id}?tab=comparison`, label: 'Comparaison détaillée' }}>
              {comparison.isLoading && <LoadingBlock rows={3} />}
              {comparison.error && <ErrorState error={comparison.error} onRetry={() => comparison.refetch()} />}
              {comparison.data && <MiniComparison c={comparison.data} />}
            </Section>
          )}

          <Section title="Prochaines étapes">
            {rfq.status === 'CANCELLED' ? (
              <p className="text-sm text-ink-muted">RFQ annulée : aucune étape restante.</p>
            ) : (
              (() => {
                const { steps, current } = nextSteps(rfq, hasPurchaseOrder);
                return (
                  <ol className="space-y-1">
                    {steps.map((s, i) => {
                      const done = i < current;
                      const active = i === current;
                      return (
                        <li key={s.key}>
                          <Link
                            href={s.href}
                            aria-current={active ? 'step' : undefined}
                            className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm', active ? 'bg-action-50 font-medium text-action' : done ? 'text-ink-muted' : 'text-ink-soft', 'hover:bg-action-50/70')}
                          >
                            <span
                              className={cn(
                                'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold',
                                active ? 'bg-action text-white' : done ? 'bg-ok-bg text-ok' : 'bg-neutral-bg text-ink-muted',
                              )}
                              aria-hidden
                            >
                              {done ? <CheckCircle2 className="h-3.5 w-3.5" /> : i + 1}
                            </span>
                            <span className={cn(done && 'line-through decoration-ink-soft/60')}>{s.label}</span>
                            <span className="sr-only">{done ? ' (fait)' : active ? ' (étape en cours)' : ''}</span>
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                );
              })()
            )}
            {rfq.status === 'ISSUED' && rfq.deadline && (daysUntil(rfq.deadline) ?? 0) < 0 && (
              <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-danger">
                <AlarmClock className="h-3.5 w-3.5" aria-hidden /> Date limite dépassée sans devis : relancer les fournisseurs.
              </p>
            )}
          </Section>

          <Section title={`Documents (${rfq.attachments.length})`} link={{ href: `/purchasing/rfqs/${rfq.id}?tab=files`, label: 'Tous les documents' }}>
            {rfq.attachments.length === 0 ? (
              <p className="text-sm text-ink-muted">Aucune pièce jointe.</p>
            ) : (
              <ul className="space-y-1.5">
                {rfq.attachments.slice(0, 5).map((a) => (
                  <li key={a.id} className="flex items-center gap-2.5 text-sm">
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-navy-50 text-navy-600" aria-hidden>
                      {/pdf/i.test(a.file?.mimeType ?? '') ? <FileText className="h-3.5 w-3.5" /> : <Paperclip className="h-3.5 w-3.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{a.title ?? a.file?.originalName ?? 'Pièce jointe'}</span>
                      <span className="block text-xs text-ink-muted">
                        {fmtBytes(a.file?.sizeBytes ?? null)} · {fmtDate(a.createdAt)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
    </aside>
  );
}
