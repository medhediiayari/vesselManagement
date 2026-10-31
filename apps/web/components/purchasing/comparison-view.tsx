'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Award, CheckSquare, ShoppingCart, Sparkles, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import { api, type Page } from '@/lib/api';
import { cn, fmtDate, fmtDateTime, fmtDecimal, fmtMoney } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { COMPLIANCE_LABELS, COMPLIANCE_TONES, QUOTATION_STATUS_LABELS, QUOTATION_STATUS_TONES, commandError, dec, decimalError, purKeys, toApiDecimal, useCommand } from './lib';
import type { Comparison, ComparisonOffer, PoDetail, PoListItem, RfqDetail, Selection } from './types';
import { Callout, DecimalInput, FormField, Money, PoStatusBadge, StatusPill, TextActionDialog } from './ui';

/** Comparaison d'unités insensible à la casse, aux accents et aux espaces (même règle que l'API). */
function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  const n = (u: string | null | undefined) => (u ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
  return n(a) === n(b);
}

function OfferCell({ offer, unit, selecting, value, onChange }: { offer: ComparisonOffer | undefined; unit: string; selecting: boolean; value: string; onChange: (v: string) => void }) {
  if (!offer) return <span className="text-xs italic text-ink-soft">Non chiffré</span>;
  if (!offer.isAvailable)
    return (
      <span className="text-xs text-ink-muted">
        Indisponible{offer.remarks ? <span className="block italic">{offer.remarks}</span> : null}
      </span>
    );
  if (offer.unitPrice === null) return <span className="text-xs italic text-ink-soft">Sans prix</span>;
  return (
    <div className="space-y-0.5">
      <p className="font-semibold tabular">
        {fmtMoney(offer.unitPrice, offer.currency)}
        <span className="text-xs font-normal text-ink-muted"> / {offer.unit ?? unit}</span>
      </p>
      <p className="text-xs tabular text-ink-muted">
        {offer.quantityOffered !== null ? `${fmtDecimal(offer.quantityOffered)} ${offer.unit ?? unit} offert(s)` : 'Qté non précisée'}
        {offer.lineTotal ? ` · ${fmtMoney(offer.lineTotal, offer.currency)}` : ''}
      </p>
      {offer.leadTimeDays !== null && <p className="text-xs text-ink-muted">Délai {offer.leadTimeDays} j</p>}
      <div className="flex flex-wrap gap-1">
        {offer.cheapestInCurrency && (
          <Badge tone="ok" icon={<Award className="h-3.5 w-3.5" aria-hidden />}>
            Moins cher ({offer.currency})
          </Badge>
        )}
        {offer.compliance !== 'COMPLIANT' && <StatusPill status={offer.compliance} labels={COMPLIANCE_LABELS} tones={COMPLIANCE_TONES} />}
        {offer.unit && !sameUnit(offer.unit, unit) && (
          <Badge tone="warn" icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}>
            Unité {offer.unit} ≠ {unit}
          </Badge>
        )}
        {dec.gt0(offer.selectedQuantity) && (
          <Badge tone="info" icon={<CheckSquare className="h-3.5 w-3.5" aria-hidden />}>
            Retenu {fmtDecimal(offer.selectedQuantity)}
          </Badge>
        )}
      </div>
      {offer.remarks && <p className="text-xs italic text-ink-muted">{offer.remarks}</p>}
      {selecting && (
        <DecimalInput value={value} onChange={onChange} placeholder="Qté à retenir" ariaLabel={`Quantité à retenir chez ${offer.supplierName}`} className="mt-1 h-7 text-xs" />
      )}
    </div>
  );
}

/** Comparateur multi-fournisseurs (GET /rfqs/:id/comparison) : prix, délais, quantités, conditions ; sélection justifiée. */
export function ComparisonTab({ rfq }: { rfq: RfqDetail }) {
  const { can } = useSession();
  const run = useCommand();
  const q = useQuery({ queryKey: [...purKeys.rfq(rfq.id), 'comparison'], queryFn: () => api.get<Comparison>(`/rfqs/${rfq.id}/comparison`) });
  const canEvaluate = can('quotation.evaluate') && (rfq.status === 'QUOTED' || rfq.status === 'EVALUATED');
  // Sélection ouverte d'emblée tant que rien n'est retenu : les champs « Qté à retenir » sont visibles sans clic
  const [selecting, setSelecting] = useState(canEvaluate && rfq.status === 'QUOTED');
  const [picks, setPicks] = useState<Record<string, string>>({});
  const [justification, setJustification] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data;
  if (!c.quotations.length) return <EmptyState title="Aucun devis à comparer" description="Saisissez au moins un devis fournisseur pour alimenter le comparateur." />;

  const unitMismatch = c.lines.some((l) => l.offers.some((o) => o.unit && !sameUnit(o.unit, l.unit)));
  const chosen = Object.entries(picks).filter(([, v]) => v.trim());
  const pickErrors = chosen.map(([, v]) => decimalError(v, { positive: true, scale: 3 })).filter(Boolean);

  const prefill = (currency: string) => {
    const next: Record<string, string> = {};
    for (const line of c.lines) {
      const remaining = dec.max0(dec.sub(line.quantity, line.selectedQuantity));
      if (!dec.gt0(remaining)) continue;
      const best = line.offers.find((o) => o.currency === currency && o.cheapestInCurrency && o.isAvailable && o.unitPrice !== null);
      if (!best) continue;
      next[best.quotationLineId] = best.quantityOffered !== null ? dec.min(remaining, best.quantityOffered) : remaining;
    }
    setPicks(next);
    setSelecting(true);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await run(
        () =>
          api.post<{ warnings: string[]; rfqStatus: string }>(`/rfqs/${rfq.id}/selections`, {
            justification: justification.trim(),
            selections: chosen.map(([quotationLineId, quantity]) => ({ quotationLineId, quantity: toApiDecimal(quantity) })),
          }),
        'Sélection enregistrée',
      );
      res.warnings?.forEach((w) => toast.warning(w));
      setPicks({});
      setJustification('');
      setSelecting(false);
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {c.fxNote && <Callout tone="info" title="Plusieurs devises">{c.fxNote}</Callout>}
      {unitMismatch && (
        <Callout tone="warn" title="Unités différentes de la RFQ">
          Certaines offres sont exprimées dans une autre unité que la ligne consultée (ex. boîte au lieu de pièces) : leurs prix unitaires ne sont pas directement
          comparables, et le BC est établi dans l’unité de la RFQ. Vérifiez quantités et prix avant de retenir ou de commander ces offres.
        </Callout>
      )}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Object.entries(c.totalsByCurrency).map(([cur, rows]) => (
          <div key={cur} className="rounded-lg border border-line bg-white p-3">
            <p className="mb-2 text-sm font-semibold text-navy">Totaux en {cur}</p>
            <ul className="space-y-1">
              {rows.map((r) => (
                <li key={r.quotationId} className="text-sm">
                  <p className="truncate font-medium" title={r.supplierName}>
                    {r.supplierName}
                  </p>
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-muted">couverture {r.coveragePercent} %</span>
                    <Money value={r.totalAmount} currency={cur} strong />
                    {r.lowestTotal && <Badge tone="ok">Total le plus bas</Badge>}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {!can('quotation.evaluate') && (
        <Callout tone="info" title="Sélection réservée">
          Retenir des offres requiert le droit « Comparer et sélectionner les devis » (quotation.evaluate) : demandez-le à l’administrateur si vous traitez les achats.
        </Callout>
      )}
      {canEvaluate && (
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={selecting ? 'secondary' : 'primary'} onClick={() => setSelecting((s) => !s)}>
            <CheckSquare className="h-4 w-4" aria-hidden /> {selecting ? 'Quitter la sélection' : 'Sélectionner des offres'}
          </Button>
          {c.currencies.map((cur) => (
            <Button key={cur} variant="ghost" onClick={() => prefill(cur)}>
              <Sparkles className="h-4 w-4" aria-hidden /> Pré-remplir : moins cher par ligne ({cur})
            </Button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg bg-white shadow-panel">
        <table className="table-amc">
          <thead>
            <tr>
              <th scope="col" className="min-w-[200px]">
                Ligne
              </th>
              {c.quotations.map((qt) => (
                <th key={qt.quotationId} scope="col" className="min-w-[190px] align-top">
                  <span className="block text-sm font-semibold text-navy">{qt.supplier.name}</span>
                  <span className="block font-normal">
                    {qt.currency}
                    {qt.reference ? ` · ${qt.reference}` : ''}
                  </span>
                  <span className="mt-1 inline-block">
                    <StatusPill status={qt.status} labels={QUOTATION_STATUS_LABELS} tones={QUOTATION_STATUS_TONES} />
                  </span>
                  {qt.expired && (
                    <span className="ml-1 inline-block">
                      <Badge tone="danger">Devis expiré</Badge>
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {c.lines.map((line) => (
              <tr key={line.rfqLineId}>
                <td className="align-top">
                  <p className="font-medium">
                    <span className="text-xs tabular text-ink-muted">{line.lineNo}. </span>
                    {line.designation}
                  </p>
                  {line.reference && <p className="text-xs text-ink-muted">Réf. {line.reference}</p>}
                  <p className="text-xs tabular text-ink-muted">
                    Demandé {fmtDecimal(line.quantity)} {line.unit}
                    {dec.gt0(line.selectedQuantity) ? ` · retenu ${fmtDecimal(line.selectedQuantity)}` : ''}
                  </p>
                  {dec.gt0(dec.sub(line.quantity, line.selectedQuantity)) && dec.gt0(line.selectedQuantity) && (
                    <p className="text-xs text-warn">Reste à retenir {fmtDecimal(dec.sub(line.quantity, line.selectedQuantity))}</p>
                  )}
                </td>
                {c.quotations.map((qt) => {
                  const offer = line.offers.find((o) => o.quotationId === qt.quotationId);
                  return (
                    <td key={qt.quotationId} className={cn('align-top', offer?.cheapestInCurrency && 'bg-ok-bg/40')}>
                      <OfferCell
                        offer={offer}
                        unit={line.unit}
                        selecting={selecting && !!offer && offer.isAvailable && offer.unitPrice !== null}
                        value={offer ? picks[offer.quotationLineId] ?? '' : ''}
                        onChange={(v) => offer && setPicks((p) => ({ ...p, [offer.quotationLineId]: v }))}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot className="text-sm">
            {(
              [
                ['Sous-total', (qt) => <Money value={qt.subtotal} currency={qt.currency} />],
                ['Fret', (qt) => (qt.freightAmount ? <Money value={qt.freightAmount} currency={qt.currency} /> : '—')],
                ['Taxes', (qt) => (qt.taxAmount ? <Money value={qt.taxAmount} currency={qt.currency} /> : '—')],
                ['Remise', (qt) => (qt.discountAmount ? <Money value={qt.discountAmount} currency={qt.currency} /> : '—')],
                ['Total', (qt) => <Money value={qt.totalAmount} currency={qt.currency} strong />],
                ['Couverture', (qt) => `${qt.coverage.quotedLines}/${qt.coverage.totalLines} lignes (${qt.coverage.percent} %) · complètes ${qt.coverage.fullPercent} %`],
                ['Délai', (qt) => (qt.leadTimeDays !== null ? `${qt.leadTimeDays} j` : qt.maxLineLeadTimeDays !== null ? `≤ ${qt.maxLineLeadTimeDays} j` : '—')],
                ['Validité', (qt) => (qt.validUntil ? `${fmtDate(qt.validUntil)}${qt.expired ? ' (expiré)' : ''}` : '—')],
                ['Incoterm / paiement', (qt) => [qt.incoterm, qt.paymentTerms].filter(Boolean).join(' · ') || '—'],
                ['Conformité', (qt) => `${qt.compliance.compliant} conforme(s), ${qt.compliance.alternative} alternative(s), ${qt.compliance.nonCompliant} non conforme(s)`],
                ['Lignes les moins chères', (qt) => `${qt.cheapestLineCount} (dans sa devise)`],
              ] as [string, (qt: Comparison['quotations'][number]) => ReactNode][]
            ).map(([label, render]) => (
              <tr key={label} className="border-t border-line">
                <th scope="row" className="border-b border-line bg-surface-sunken px-3 py-1.5 text-left text-xs font-semibold text-ink-muted">
                  {label}
                </th>
                {c.quotations.map((qt) => (
                  <td key={qt.quotationId} className="border-b border-line px-3 py-1.5 text-right text-xs tabular">
                    {render(qt)}
                  </td>
                ))}
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
      <p className="text-xs text-ink-muted">« Moins cher » : prix unitaire le plus bas parmi les offres disponibles et non « non conformes », comparé uniquement au sein d’une même devise.</p>

      {selecting && (
        <Panel title={`Sélection (${chosen.length} offre${chosen.length > 1 ? 's' : ''})`}>
          <p className="mb-2 text-sm text-ink-muted">
            La sélection est distincte de la saisie et tracée avec sa justification. La somme retenue par ligne ne peut pas dépasser la quantité consultée.
          </p>
          <FormField label="Justification du choix" required hint="ex. meilleur prix EUR et délai 7 j ; fusibles chez un second fournisseur.">
            <Textarea rows={3} value={justification} onChange={(e) => setJustification(e.target.value)} maxLength={5000} />
          </FormField>
          {pickErrors.length > 0 && <p className="mt-2 text-sm text-danger">Quantités invalides : {pickErrors.join(', ')}</p>}
          {error && <Callout tone="danger" className="mt-2" title="Sélection refusée">{error}</Callout>}
          <div className="mt-3 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPicks({})}>
              Effacer
            </Button>
            {(!chosen.length || justification.trim().length < 3) && (
              <span className="mr-auto self-center text-xs text-ink-muted">
                {!chosen.length ? 'Saisissez une « Qté à retenir » dans au moins une offre chiffrée (ou pré-remplissez le moins cher).' : 'Indiquez la justification du choix (3 caractères minimum).'}
              </span>
            )}
            <Button onClick={submit} disabled={!chosen.length || pickErrors.length > 0 || justification.trim().length < 3} loading={busy}>
              <CheckSquare className="h-4 w-4" aria-hidden /> Enregistrer la sélection
            </Button>
          </div>
        </Panel>
      )}
    </div>
  );
}

// =============================================================================
// Sélections retenues -> création des BC (un BC par devis / fournisseur)
// =============================================================================

interface Group {
  quotationId: string;
  supplier: { id: string; name: string };
  currency: string;
  selections: Selection[];
}

function CreatePoDialog({
  open,
  onOpenChange,
  rfq,
  group,
  firstOrder,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  rfq: RfqDetail;
  group: Group;
  /** Premier BC issu de ce devis : fret et taxes du devis sont proposés (pas sur un BC suivant, pour ne pas les compter deux fois) */
  firstOrder: boolean;
}) {
  const router = useRouter();
  const run = useCommand();
  const lineById = new Map(rfq.lines.map((l) => [l.id, l]));
  const quote = (rfq.quotations ?? []).find((x) => x.id === group.quotationId);
  const discount = quote?.discountAmount && dec.gt0(quote.discountAmount) ? quote.discountAmount : null;
  const [qty, setQty] = useState<Record<string, string>>(() => Object.fromEntries(group.selections.map((s) => [s.quotationLineId, s.quantity])));
  const [h, setH] = useState({
    expectedDeliveryDate: '',
    deliveryPort: rfq.deliveryPort ?? '',
    deliveryTerms: rfq.deliveryTerms ?? '',
    paymentTerms: '',
    notes: '',
    // Repris du devis (ACH-10) ; modifiables si le BC ne reprend qu'une partie du devis
    taxAmount: firstOrder && quote?.taxAmount && dec.gt0(quote.taxAmount) ? quote.taxAmount : '',
    freightAmount: firstOrder && quote?.freightAmount && dec.gt0(quote.freightAmount) ? quote.freightAmount : '',
  });
  const unitWarnings = group.selections
    .map((s) => ({ s, l: lineById.get(s.quotationLine.rfqLineId) }))
    .filter(({ s, l }) => l && s.quotationLine.unit && !sameUnit(s.quotationLine.unit, l.unit));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errs = group.selections.map((s) => decimalError(qty[s.quotationLineId] ?? '', { required: true, positive: true, scale: 3 }));
  const subtotal = dec.add(...group.selections.map((s) => dec.mul(toApiDecimal(qty[s.quotationLineId] ?? '0'), s.quotationLine.unitPrice ?? '0')));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const po = await run(
        () =>
          api.post<PoDetail>('/orders', {
            supplierId: group.supplier.id,
            quotationId: group.quotationId,
            expectedDeliveryDate: h.expectedDeliveryDate || null,
            deliveryPort: h.deliveryPort.trim() || null,
            deliveryTerms: h.deliveryTerms.trim() || null,
            paymentTerms: h.paymentTerms.trim() || null,
            notes: h.notes.trim() || null,
            taxAmount: h.taxAmount ? toApiDecimal(h.taxAmount) : undefined,
            freightAmount: h.freightAmount ? toApiDecimal(h.freightAmount) : undefined,
            lines: group.selections.map((s) => ({ quotationLineId: s.quotationLineId, quantity: toApiDecimal(qty[s.quotationLineId]) })),
          }),
        (p) => `BC ${p.number} créé (brouillon)`,
      );
      onOpenChange(false);
      router.push(`/purchasing/orders/${po.id}`);
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={`Créer le BC — ${group.supplier.name}`}
      description={`Depuis les lignes retenues du devis (${group.currency}). Désignation, unité, prix et allocations PR sont repris de la RFQ et du devis.`}
      footer={
        <>
          <span className="mr-auto self-center text-sm text-ink-muted">
            Sous-total <span className="font-semibold tabular text-ink">{fmtMoney(subtotal, group.currency)}</span>
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} disabled={errs.some(Boolean)} loading={busy}>
            <ShoppingCart className="h-4 w-4" aria-hidden /> Créer le BC (brouillon)
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <table className="table-amc">
          <thead>
            <tr>
              <th scope="col">Ligne</th>
              <th scope="col" className="text-right">
                Retenu
              </th>
              <th scope="col" className="text-right">
                PU
              </th>
              <th scope="col" className="text-right">
                Qté commandée
              </th>
            </tr>
          </thead>
          <tbody>
            {group.selections.map((s, i) => {
              const l = lineById.get(s.quotationLine.rfqLineId);
              return (
                <tr key={s.id}>
                  <td>
                    {l ? `${l.lineNo}. ${l.designation}` : '—'}
                    {errs[i] && <span className="block text-xs text-danger">{errs[i]}</span>}
                  </td>
                  <td className="text-right tabular">
                    {fmtDecimal(s.quantity)} {l?.unit}
                  </td>
                  <td className="text-right">
                    <Money value={s.quotationLine.unitPrice} currency={group.currency} />
                  </td>
                  <td className="w-32">
                    <DecimalInput value={qty[s.quotationLineId] ?? ''} onChange={(v) => setQty((p) => ({ ...p, [s.quotationLineId]: v }))} className="h-8" ariaLabel="Quantité commandée" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {unitWarnings.length > 0 && (
          <Callout tone="warn" title="Unité du devis différente de la RFQ">
            {unitWarnings.map(({ s, l }) => `Ligne ${l!.lineNo} : devis en « ${s.quotationLine.unit} », BC en « ${l!.unit} »`).join(' ; ')}. Le BC est établi dans l’unité de la RFQ au prix
            unitaire du devis : vérifiez la quantité et le prix avant de créer le BC.
          </Callout>
        )}
        {discount && (
          <Callout tone="warn" title="Remise du devis non reportée">
            Le devis comporte une remise de {fmtMoney(discount, group.currency)} que le BC ne sait pas porter : intégrez-la dans les prix unitaires ou ajustez fret et taxes, sinon le
            total du BC dépassera celui du devis.
          </Callout>
        )}
        <div className="grid gap-3 md:grid-cols-3">
          <FormField label="Livraison attendue">
            <Input type="date" value={h.expectedDeliveryDate} onChange={(e) => setH((x) => ({ ...x, expectedDeliveryDate: e.target.value }))} />
          </FormField>
          <FormField label="Taxes" error={decimalError(h.taxAmount, { scale: 2 }) ?? undefined} hint={firstOrder && quote?.taxAmount && dec.gt0(quote.taxAmount) ? 'Repris du devis' : undefined}>
            <DecimalInput value={h.taxAmount} onChange={(v) => setH((x) => ({ ...x, taxAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Fret" error={decimalError(h.freightAmount, { scale: 2 }) ?? undefined} hint={firstOrder && quote?.freightAmount && dec.gt0(quote.freightAmount) ? 'Repris du devis' : undefined}>
            <DecimalInput value={h.freightAmount} onChange={(v) => setH((x) => ({ ...x, freightAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Port de livraison">
            <Input value={h.deliveryPort} onChange={(e) => setH((x) => ({ ...x, deliveryPort: e.target.value }))} maxLength={120} />
          </FormField>
          <FormField label="Conditions de livraison">
            <Input value={h.deliveryTerms} onChange={(e) => setH((x) => ({ ...x, deliveryTerms: e.target.value }))} maxLength={500} />
          </FormField>
          <FormField label="Conditions de paiement">
            <Input value={h.paymentTerms} onChange={(e) => setH((x) => ({ ...x, paymentTerms: e.target.value }))} maxLength={250} />
          </FormField>
          <FormField label="Notes" className="md:col-span-3">
            <Textarea rows={2} value={h.notes} onChange={(e) => setH((x) => ({ ...x, notes: e.target.value }))} maxLength={5000} className="min-h-[56px]" />
          </FormField>
        </div>
        {error && <Callout tone="danger" title="Création refusée">{error}</Callout>}
      </div>
    </Dialog>
  );
}

export function SelectionsTab({ rfq }: { rfq: RfqDetail }) {
  const { can } = useSession();
  const run = useCommand();
  const [withdrawing, setWithdrawing] = useState<Selection | null>(null);
  const [creating, setCreating] = useState<Group | null>(null);
  const q = useQuery({ queryKey: [...purKeys.rfq(rfq.id), 'selections'], queryFn: () => api.get<Selection[]>(`/rfqs/${rfq.id}/selections`) });
  const supplierIds = useMemo(() => [...new Set((rfq.quotations ?? []).map((x) => x.supplierId))], [rfq.quotations]);
  const orders = useQuery({
    queryKey: [...purKeys.orders, 'by-rfq', rfq.id, supplierIds.join(',')],
    queryFn: async () => {
      const pages = await Promise.all(supplierIds.map((sid) => api.get<Page<PoListItem>>('/orders', { query: { supplierId: sid, vesselId: rfq.vesselId, limit: 100 } })));
      const quotationIds = new Set((rfq.quotations ?? []).map((x) => x.id));
      return pages.flatMap((p) => p.items).filter((o) => o.quotationId && quotationIds.has(o.quotationId));
    },
    enabled: can('bc.view') && supplierIds.length > 0,
  });
  const lineById = new Map(rfq.lines.map((l) => [l.id, l]));

  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const active = (q.data ?? []).filter((s) => !s.withdrawnAt);
  const withdrawn = (q.data ?? []).filter((s) => s.withdrawnAt);
  const groups: Group[] = [];
  for (const s of active) {
    const qid = s.quotationLine.quotation.id;
    let g = groups.find((x) => x.quotationId === qid);
    if (!g) {
      g = { quotationId: qid, supplier: { id: s.quotationLine.quotation.supplier.id, name: s.quotationLine.quotation.supplier.name }, currency: s.quotationLine.quotation.currency, selections: [] };
      groups.push(g);
    }
    g.selections.push(s);
  }

  return (
    <div className="space-y-4">
      {!active.length && <EmptyState title="Aucune offre retenue" description="Retenez des offres depuis l’onglet Comparaison (permission quotation.evaluate), avec justification." />}
      {groups.map((g) => {
        const linkedPos = (orders.data ?? []).filter((o) => o.quotationId === g.quotationId && o.status !== 'CANCELLED');
        return (
          <Panel
            key={g.quotationId}
            title={`${g.supplier.name} — ${g.currency}`}
            actions={
              can('bc.create') && (
                <Button size="sm" onClick={() => setCreating(g)}>
                  <ShoppingCart className="h-4 w-4" aria-hidden /> {linkedPos.length ? 'Créer un autre BC' : 'Créer le BC'}
                </Button>
              )
            }
          >
            {linkedPos.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-muted">BC issus de ce devis :</span>
                {linkedPos.map((o) => (
                  <Link key={o.id} href={`/purchasing/orders/${o.id}`} className="inline-flex items-center gap-1.5 rounded border border-line px-2 py-0.5 font-medium text-action hover:underline">
                    {o.number} <PoStatusBadge status={o.status} />
                  </Link>
                ))}
              </div>
            )}
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Ligne</th>
                  <th scope="col" className="text-right">
                    Qté retenue
                  </th>
                  <th scope="col" className="text-right">
                    PU
                  </th>
                  <th scope="col">Justification</th>
                  <th scope="col">Par</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {g.selections.map((s) => {
                  const l = lineById.get(s.quotationLine.rfqLineId);
                  return (
                    <tr key={s.id}>
                      <td>{l ? `${l.lineNo}. ${l.designation}` : '—'}</td>
                      <td className="text-right tabular">
                        {fmtDecimal(s.quantity)} {l?.unit}
                      </td>
                      <td className="text-right">
                        <Money value={s.quotationLine.unitPrice} currency={g.currency} />
                      </td>
                      <td className="max-w-[280px] text-xs text-ink-muted">{s.justification}</td>
                      <td className="whitespace-nowrap text-xs text-ink-muted">
                        {s.selectedByName ?? '—'}
                        <br />
                        {fmtDateTime(s.selectedAt)}
                      </td>
                      <td className="text-right">
                        {can('quotation.evaluate') && (
                          <Button size="sm" variant="ghost" onClick={() => setWithdrawing(s)}>
                            <Undo2 className="h-4 w-4" aria-hidden /> Retirer
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        );
      })}
      {withdrawn.length > 0 && (
        <details className="rounded-lg border border-line bg-white px-4 py-2 text-sm">
          <summary className="cursor-pointer text-ink-muted">{withdrawn.length} sélection(s) retirée(s)</summary>
          <ul className="mt-2 space-y-1 text-xs text-ink-muted">
            {withdrawn.map((s) => (
              <li key={s.id}>
                {s.quotationLine.quotation.supplier.name} · {fmtDecimal(s.quantity)} · retirée le {fmtDateTime(s.withdrawnAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
      <TextActionDialog
        open={!!withdrawing}
        onOpenChange={(o) => !o && setWithdrawing(null)}
        title="Retirer la sélection"
        label="Motif"
        required
        confirmLabel="Retirer"
        onConfirm={(reason) => run(() => api.post(`/rfqs/${rfq.id}/selections/${withdrawing!.id}/withdraw`, { reason }), 'Sélection retirée')}
      />
      {creating && (
        <CreatePoDialog
          open={!!creating}
          onOpenChange={(o) => !o && setCreating(null)}
          rfq={rfq}
          group={creating}
          firstOrder={!(orders.data ?? []).some((o) => o.quotationId === creating.quotationId && o.status !== 'CANCELLED')}
        />
      )}
    </div>
  );
}
