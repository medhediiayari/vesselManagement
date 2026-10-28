'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { Plus, Save, Send } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { api, type Page } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, fmtDecimal, fmtMoney } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { LoadingBlock } from '@/components/ui/states';
import { COMMON_CURRENCIES, COMMON_UNITS, commandError, dec, decimalError, overAllocationLines, purKeys, toApiDecimal, useCommand } from './lib';
import type { OverAllocationLine, PoDetail, PrDetail, PrListItem, PurchasingConfig, Supplier } from './types';
import { SupplierFormDialog } from './supplier-panel';
import { Callout, DecimalInput, FormField, PrStatusBadge, SupplierSelect, VesselSelect } from './ui';

const ORDERABLE = 'APPROVED,SOURCING,PARTIALLY_ORDERED,ORDERED,PARTIALLY_RECEIVED';

interface DraftLine {
  prLineId: string;
  include: boolean;
  designation: string;
  reference: string;
  unit: string;
  quantity: string;
  allocation: string;
  unitPrice: string;
  remarks: string;
}

/** Tableau des dépassements renvoyés par l'API (aucune sur-allocation silencieuse — CDC §6.4, V1 §9.3). */
export function OverAllocationTable({ lines }: { lines: OverAllocationLine[] }) {
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col">PR / ligne</th>
            <th scope="col" className="text-right">
              Approuvé
            </th>
            <th scope="col" className="text-right">
              Déjà alloué
            </th>
            <th scope="col" className="text-right">
              Demandé ici
            </th>
            <th scope="col" className="text-right">
              Disponible
            </th>
            <th scope="col" className="text-right">
              Excédent
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.prLineId}>
              <td>
                {l.prNumber} — ligne {l.lineNo}
              </td>
              <td className="text-right tabular">{fmtDecimal(l.effective)}</td>
              <td className="text-right tabular">{fmtDecimal(l.alreadyAllocated)}</td>
              <td className="text-right tabular">{fmtDecimal(l.requested)}</td>
              <td className="text-right tabular">{fmtDecimal(l.capacity)}</td>
              <td className="text-right font-semibold tabular text-danger">+{fmtDecimal(l.excess)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Bon de commande depuis des lignes PR validées (allocations explicites ligne BC → ligne PR). « Créer et émettre »
 * émet le BC en un clic (sauf second regard requis par un seuil) : le créateur de la PR le reçoit avec le PDF,
 * la date et le port de livraison. Le serveur refuse toute sur-allocation (sauf paramétrage + motif).
 */
export function ManualPoDialog({
  open,
  onOpenChange,
  initialPrId,
  initialVesselId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  initialPrId?: string;
  initialVesselId?: string;
}) {
  const router = useRouter();
  const run = useCommand();
  const { can } = useSession();
  const [newSupplier, setNewSupplier] = useState(false);
  // Ouvert depuis une PR : le BC porte uniquement sur cette PR (pas de choix d'autres PR du navire)
  const lockedToPr = !!initialPrId;
  const [vesselId, setVesselId] = useState(initialVesselId ?? '');
  const [prIds, setPrIds] = useState<string[]>(initialPrId ? [initialPrId] : []);
  const [drafts, setDrafts] = useState<Record<string, DraftLine>>({});
  const [supplierId, setSupplierId] = useState('');
  const [currency, setCurrency] = useState('');
  const [header, setHeader] = useState({ expectedDeliveryDate: '', deliveryPort: '', deliveryTerms: '', paymentTerms: '', notes: '', taxAmount: '', freightAmount: '', overAllocationReason: '' });
  const [busy, setBusy] = useState<null | 'draft' | 'issue'>(null);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<OverAllocationLine[] | null>(null);

  useEffect(() => {
    if (open) {
      setVesselId(initialVesselId ?? '');
      setPrIds(initialPrId ? [initialPrId] : []);
      setDrafts({});
      setError(null);
      setOver(null);
    }
  }, [open, initialPrId, initialVesselId]);

  const config = useQuery({ queryKey: purKeys.config, queryFn: () => api.get<PurchasingConfig>('/purchasing/config'), enabled: open, staleTime: 60_000 });
  const prs = useQuery({
    queryKey: [...purKeys.prs, 'orderable', vesselId],
    queryFn: () => api.get<Page<PrListItem>>('/purchase-requests', { query: { vesselId, status: ORDERABLE, limit: 100 } }),
    enabled: open && !!vesselId && !lockedToPr,
  });
  const details = useQueries({
    queries: prIds.map((id) => ({ queryKey: [...purKeys.pr(id)], queryFn: () => api.get<PrDetail>(`/purchase-requests/${id}`), enabled: open })),
  });
  const loadedPrs = details.map((d) => d.data).filter((d): d is PrDetail => !!d);

  // Vessel déduit de la PR initiale
  useEffect(() => {
    if (!vesselId && loadedPrs[0]) setVesselId(loadedPrs[0].vesselId);
  }, [vesselId, loadedPrs]);

  // Lignes candidates : reste à commander > 0, pré-remplies
  useEffect(() => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const pr of loadedPrs) {
        for (const l of pr.lines) {
          if (next[l.id] || l.status === 'CANCELLED') continue;
          const toOrder = l.progress?.toOrder ?? '0';
          next[l.id] = {
            prLineId: l.id,
            include: dec.gt0(toOrder),
            designation: l.designation,
            reference: l.reference ?? '',
            unit: l.unit,
            quantity: dec.gt0(toOrder) ? toOrder : '',
            allocation: dec.gt0(toOrder) ? toOrder : '',
            unitPrice: '',
            remarks: '',
          };
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadedPrs.map((p) => `${p.id}:${p.lockVersion}`).join('|')]);

  const allLines = loadedPrs.flatMap((pr) => pr.lines.filter((l) => l.status !== 'CANCELLED').map((l) => ({ pr, line: l })));
  const included = allLines.filter(({ line }) => drafts[line.id]?.include);

  // Σ allocations PR = quantité de la ligne (règle serveur) ; un écart n'est admis que par le parcours
  // explicite de sur-allocation (paramètre purchasing.allowOverAllocation + motif).
  const allowOver = !!config.data?.allowOverAllocation;
  const lineError = (d: DraftLine): string | null => {
    if (!d.designation.trim()) return 'Désignation obligatoire';
    if (!d.unit.trim()) return 'Unité obligatoire';
    const base =
      decimalError(d.quantity, { required: true, positive: true, scale: 3 }) ??
      (decimalError(d.allocation, { required: true, positive: true, scale: 3 }) ? `Allocation PR : ${decimalError(d.allocation, { required: true, positive: true, scale: 3 })}` : null) ??
      (decimalError(d.unitPrice, { required: true, scale: 4 }) ? `Prix unitaire : ${decimalError(d.unitPrice, { required: true, scale: 4 })}` : null);
    if (base) return base;
    const cmp = dec.cmp(toApiDecimal(d.allocation), toApiDecimal(d.quantity));
    if (cmp > 0) return 'Allocation PR supérieure à la quantité du BC';
    if (cmp < 0 && !allowOver) return 'La quantité du BC doit égaler la quantité allouée à la PR';
    if (cmp < 0 && header.overAllocationReason.trim().length < 3) return 'Quantité non allouée : motif de dépassement obligatoire';
    return null;
  };
  const errors = included.map(({ line }) => lineError(drafts[line.id]));
  const subtotal = dec.add(...included.map(({ line }) => dec.mul(toApiDecimal(drafts[line.id].quantity), toApiDecimal(drafts[line.id].unitPrice))));
  const canSubmit = !!supplierId && !!currency && included.length > 0 && errors.every((e) => !e) && !decimalError(header.taxAmount, { scale: 2 }) && !decimalError(header.freightAmount, { scale: 2 });

  const patch = (id: string, p: Partial<DraftLine>) => setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));

  const submit = async (issueNow: boolean) => {
    setBusy(issueNow ? 'issue' : 'draft');
    setError(null);
    setOver(null);
    try {
      const po = await run(
        () =>
          api.post<PoDetail & { issued?: boolean }>('/orders', {
            issueNow,
            supplierId,
            currency,
            expectedDeliveryDate: header.expectedDeliveryDate || null,
            deliveryPort: header.deliveryPort.trim() || null,
            deliveryTerms: header.deliveryTerms.trim() || null,
            paymentTerms: header.paymentTerms.trim() || null,
            notes: header.notes.trim() || null,
            taxAmount: header.taxAmount ? toApiDecimal(header.taxAmount) : undefined,
            freightAmount: header.freightAmount ? toApiDecimal(header.freightAmount) : undefined,
            overAllocationReason: header.overAllocationReason.trim() || undefined,
            lines: included.map(({ line }) => {
              const d = drafts[line.id];
              return {
                designation: d.designation.trim(),
                reference: d.reference.trim() || null,
                unit: d.unit.trim(),
                quantity: toApiDecimal(d.quantity),
                unitPrice: toApiDecimal(d.unitPrice),
                remarks: d.remarks.trim() || null,
                allocations: [{ prLineId: line.id, quantity: toApiDecimal(d.allocation) }],
              };
            }),
          }),
        (p) =>
          !issueNow
            ? `BC ${p.number} enregistré en brouillon`
            : p.issued
              ? `BC ${p.number} émis : le demandeur l’a reçu (notification et e-mail avec le PDF)`
              : `BC ${p.number} créé : second regard requis (seuil), il sera émis à son approbation`,
      );
      onOpenChange(false);
      router.push(`/purchasing/orders/${po.id}`);
    } catch (e) {
      setOver(overAllocationLines(e));
      setError(commandError(e));
    } finally {
      setBusy(null);
    }
  };

  const orderablePrs = (prs.data?.items ?? []).filter((p) => p.lines.some((l) => l.badge === 'NOT_ORDERED' || l.badge === 'PARTIALLY_ORDERED') || prIds.includes(p.id));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="xl"
      title={lockedToPr && loadedPrs[0] ? `Bon de commande — PR ${loadedPrs[0].number}` : 'Bon de commande'}
      description="Le BC émis est transmis au créateur de la PR (notification et e-mail avec le PDF : fournisseur, articles, date et port de livraison). Contactez le fournisseur de votre côté."
      footer={
        <>
          <span className="mr-auto self-center text-sm text-ink-muted">
            {included.length} ligne(s) · sous-total estimé{' '}
            <span className="font-semibold tabular text-ink">{currency ? fmtMoney(subtotal, currency) : fmtDecimal(subtotal, 2)}</span> (hors taxes et fret)
          </span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button variant="secondary" onClick={() => submit(false)} disabled={!canSubmit || !!busy} loading={busy === 'draft'}>
            <Save className="h-4 w-4" aria-hidden /> Brouillon
          </Button>
          <Button onClick={() => submit(true)} disabled={!canSubmit || !!busy} loading={busy === 'issue'}>
            <Send className="h-4 w-4" aria-hidden /> Créer et émettre
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-3">
          <VesselSelect
            value={vesselId}
            onChange={(v) => {
              setVesselId(v);
              setPrIds([]);
              setDrafts({});
            }}
            required
            disabled={!!initialPrId}
          />
          <div className="flex items-end gap-2 md:col-span-2">
            <SupplierSelect
              value={supplierId}
              onChange={(id, s?: Supplier) => {
                setSupplierId(id);
                if (s?.currency) setCurrency(s.currency);
              }}
              required
              className="min-w-0 flex-1"
            />
            {can('suppliers.manage') && (
              <Button variant="secondary" className="shrink-0" onClick={() => setNewSupplier(true)} title="Créer un fournisseur absent de la liste">
                <Plus className="h-4 w-4" aria-hidden /> Nouveau fournisseur
              </Button>
            )}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-4">
          <FormField label="Devise" required hint="Aucune conversion de devise.">
            <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} list="po-currencies" placeholder="EUR" />
          </FormField>
          <FormField label="Livraison attendue" hint="Transmise au demandeur.">
            <Input type="date" value={header.expectedDeliveryDate} onChange={(e) => setHeader((h) => ({ ...h, expectedDeliveryDate: e.target.value }))} />
          </FormField>
          <FormField label="Port de livraison" hint="Transmis au demandeur.">
            <Input value={header.deliveryPort} onChange={(e) => setHeader((h) => ({ ...h, deliveryPort: e.target.value }))} maxLength={120} />
          </FormField>
          <FormField label="Conditions de livraison">
            <Input value={header.deliveryTerms} onChange={(e) => setHeader((h) => ({ ...h, deliveryTerms: e.target.value }))} maxLength={500} placeholder="ex. DAP navire" />
          </FormField>
        </div>
        <datalist id="po-currencies">
          {COMMON_CURRENCIES.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>

        {lockedToPr && loadedPrs[0] && (
          <p className="rounded-md border border-line bg-surface-sunken px-3 py-2 text-sm">
            BC pour la PR <span className="ref font-medium">{loadedPrs[0].number}</span> — {loadedPrs[0].subject}{' '}
            <span className="ml-1 align-middle">
              <PrStatusBadge status={loadedPrs[0].status} />
            </span>
          </p>
        )}
        {vesselId && !lockedToPr && (
          <div>
            <p className="field-label">PR validées du navire</p>
            {prs.isLoading ? (
              <LoadingBlock rows={2} />
            ) : orderablePrs.length ? (
              <ul className="flex flex-wrap gap-2">
                {orderablePrs.map((p) => {
                  const active = prIds.includes(p.id);
                  return (
                    <li key={p.id}>
                      <label className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm', active ? 'border-action bg-action-50' : 'border-line hover:bg-navy-50')}>
                        <input type="checkbox" className="h-4 w-4" checked={active} onChange={() => setPrIds((prev) => (active ? prev.filter((x) => x !== p.id) : [...prev, p.id]))} />
                        <span className="font-medium">{p.number}</span>
                        <span className="max-w-[220px] truncate text-ink-muted">{p.subject}</span>
                        <PrStatusBadge status={p.status} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Aucune PR validée avec un reste à commander sur ce navire.</p>
            )}
          </div>
        )}

        {details.some((d) => d.isLoading) && <LoadingBlock rows={3} />}

        {allLines.length > 0 && (
          <div className="overflow-x-auto rounded-md border border-line">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Inclure</span>
                  </th>
                  <th scope="col">PR / ligne</th>
                  <th scope="col" className="text-right">
                    Reste à commander
                  </th>
                  <th scope="col">Désignation BC</th>
                  <th scope="col" className="text-right">
                    Qté BC
                  </th>
                  <th scope="col">Unité BC</th>
                  <th scope="col" className="text-right">
                    PU ({currency || 'devise'})
                  </th>
                  <th scope="col" className="text-right">
                    Allouée PR
                  </th>
                  <th scope="col" className="text-right">
                    Total
                  </th>
                </tr>
              </thead>
              <tbody>
                {allLines.map(({ pr, line }) => {
                  const d = drafts[line.id];
                  if (!d) return null;
                  const toOrder = line.progress?.toOrder ?? '0';
                  const err = d.include ? lineError(d) : null;
                  const exceeds = d.include && dec.valid(toApiDecimal(d.allocation)) && dec.cmp(toApiDecimal(d.allocation), toOrder) > 0;
                  return (
                    <tr key={line.id} className={cn(!d.include && 'opacity-60')}>
                      <td>
                        <input type="checkbox" className="h-4 w-4" checked={d.include} onChange={(e) => patch(line.id, { include: e.target.checked })} aria-label={`Inclure ${pr.number} ligne ${line.lineNo}`} />
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        <span className="font-medium text-ink">{pr.number}</span> · L{line.lineNo}
                        <span className="block max-w-[180px] truncate text-ink-muted" title={line.designation}>
                          {line.designation}
                        </span>
                      </td>
                      <td className={cn('text-right tabular', dec.gt0(toOrder) ? 'font-medium text-warn' : 'text-ink-muted')}>
                        {fmtDecimal(toOrder)} {line.unit}
                      </td>
                      <td className="min-w-[180px]">
                        <Input value={d.designation} onChange={(e) => patch(line.id, { designation: e.target.value })} className="h-8 text-sm" disabled={!d.include} aria-label="Désignation BC" maxLength={500} />
                        {d.include && err && <span className="text-xs text-danger">{err}</span>}
                      </td>
                      <td className="w-24">
                        <DecimalInput
                          value={d.quantity}
                          onChange={(v) => patch(line.id, !allowOver || d.quantity === d.allocation ? { quantity: v, allocation: v } : { quantity: v })}
                          className="h-8"
                          disabled={!d.include}
                          ariaLabel="Quantité BC"
                        />
                      </td>
                      <td className="w-24">
                        <Input value={d.unit} onChange={(e) => patch(line.id, { unit: e.target.value })} list="po-units" className="h-8 text-sm" disabled={!d.include} aria-label="Unité BC" maxLength={32} />
                      </td>
                      <td className="w-28">
                        <DecimalInput value={d.unitPrice} onChange={(v) => patch(line.id, { unitPrice: v })} className="h-8" disabled={!d.include} ariaLabel="Prix unitaire" placeholder="0,00" />
                      </td>
                      <td className="w-28">
                        {allowOver ? (
                          <DecimalInput value={d.allocation} onChange={(v) => patch(line.id, { allocation: v })} className="h-8" disabled={!d.include} ariaLabel={`Quantité allouée à la PR (${line.unit})`} invalid={exceeds} />
                        ) : (
                          <span className="block text-right text-sm tabular" title="Σ allocations PR = quantité du BC">
                            {d.include ? fmtDecimal(toApiDecimal(d.allocation || '0')) : '—'}
                          </span>
                        )}
                        {exceeds && <span className="text-xs text-warn">Dépasse le reste ({fmtDecimal(toOrder)})</span>}
                      </td>
                      <td className="text-right tabular">{d.include && !err ? fmtDecimal(dec.mul(toApiDecimal(d.quantity), toApiDecimal(d.unitPrice)), 2) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <datalist id="po-units">
              {COMMON_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-4">
          <FormField label="Taxes" error={decimalError(header.taxAmount, { scale: 2 }) ?? undefined}>
            <DecimalInput value={header.taxAmount} onChange={(v) => setHeader((h) => ({ ...h, taxAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Fret" error={decimalError(header.freightAmount, { scale: 2 }) ?? undefined}>
            <DecimalInput value={header.freightAmount} onChange={(v) => setHeader((h) => ({ ...h, freightAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Conditions de paiement" className="md:col-span-2">
            <Input value={header.paymentTerms} onChange={(e) => setHeader((h) => ({ ...h, paymentTerms: e.target.value }))} maxLength={250} />
          </FormField>
          <FormField label="Notes" className="md:col-span-4">
            <Textarea rows={2} value={header.notes} onChange={(e) => setHeader((h) => ({ ...h, notes: e.target.value }))} maxLength={5000} className="min-h-[56px]" />
          </FormField>
          {config.data?.allowOverAllocation && (
            <FormField label="Motif de dépassement (sur-allocation)" className="md:col-span-4" hint="Le paramétrage autorise un dépassement motivé ; le BC exigera alors un second regard.">
              <Input value={header.overAllocationReason} onChange={(e) => setHeader((h) => ({ ...h, overAllocationReason: e.target.value }))} maxLength={500} />
            </FormField>
          )}
        </div>

        {error && (
          <Callout tone="danger" title={over ? 'Sur-allocation refusée' : 'Création refusée'}>
            <p>{error}</p>
            {over && <OverAllocationTable lines={over} />}
            {over && (
              <p className="mt-2 text-xs">
                Réduisez les quantités allouées au reste à commander, ou faites d’abord réviser la PR (Counter-PR) pour augmenter la quantité approuvée.
              </p>
            )}
          </Callout>
        )}
      </div>
      {newSupplier && (
        <SupplierFormDialog
          onClose={() => setNewSupplier(false)}
          onSaved={(s) => {
            setSupplierId(s.id);
            if (s.currency) setCurrency(s.currency);
          }}
        />
      )}
    </Dialog>
  );
}

export { CurrencyInput } from './ui';

