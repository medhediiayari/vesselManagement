'use client';

import { MailCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDateTime, fmtDecimal, fmtMoney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/field';
import { Dialog } from '@/components/ui/dialog';
import {
  APPROVAL_REASON_LABELS,
  DISPATCH_CHANNEL_LABELS,
  DISPATCH_KIND_LABELS,
  DISPATCH_STATUS_LABELS,
  DISPATCH_STATUS_TONES,
  commandError,
  dec,
  decimalError,
  overAllocationLines,
  toApiDecimal,
  toDateInput,
  useCommand,
} from './lib';
import { OverAllocationTable } from './manual-po-dialog';
import type { OverAllocationLine, PoDetail, PoDispatch } from './types';
import { Callout, DecimalInput, FormField, StatusPill } from './ui';

export function DispatchTable({ dispatches }: { dispatches: PoDispatch[] }) {
  if (!dispatches.length) return <p className="text-sm text-ink-muted">Aucune transmission.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col">Destinataire</th>
            <th scope="col">Type</th>
            <th scope="col">Canal</th>
            <th scope="col">Statut</th>
            <th scope="col">Date</th>
            <th scope="col">Erreur / note</th>
          </tr>
        </thead>
        <tbody>
          {dispatches.map((d) => (
            <tr key={d.id}>
              <td className="break-all">{d.recipient}</td>
              <td>{DISPATCH_KIND_LABELS[d.recipientKind] ?? d.recipientKind}</td>
              <td>{DISPATCH_CHANNEL_LABELS[d.channel] ?? d.channel}</td>
              <td>
                <StatusPill status={d.status} labels={DISPATCH_STATUS_LABELS} tones={DISPATCH_STATUS_TONES} />
              </td>
              <td className="whitespace-nowrap text-xs">{fmtDateTime(d.sentAt ?? d.createdAt)}</td>
              <td className={cn('text-xs', d.status === 'FAILED' ? 'text-danger' : 'text-ink-muted')}>{d.error ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Transmission constatée hors plateforme (canal MANUAL) — attribuée et auditée, jamais présumée. */
export function MarkPoSentDialog({ po, onClose }: { po: PoDetail; onClose: () => void }) {
  const run = useCommand();
  const [recipient, setRecipient] = useState(po.supplier.email ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Noter l’envoi de ${po.number} au fournisseur`}
      description="La plateforme n’envoie aucun e-mail aux fournisseurs : notez ici comment le BC a été transmis (e-mail personnel, téléphone, remise en main propre). La déclaration vous est attribuée et tracée."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={recipient.trim().length < 2}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await run(() => api.post(`/orders/${po.id}/mark-sent`, { expectedVersion: po.lockVersion, channel: 'MANUAL', recipient: recipient.trim(), note: note.trim() || null }), 'Envoi au fournisseur noté');
                onClose();
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <MailCheck className="h-4 w-4" aria-hidden /> Noter l’envoi
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Destinataire / moyen" required>
          <Input value={recipient} onChange={(e) => setRecipient(e.target.value)} maxLength={300} placeholder="ex. Remis au représentant, M. Ben Ali" />
        </FormField>
        <FormField label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
        </FormField>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}

interface ReviseLine {
  quantityOrdered: string;
  unitPrice: string;
  cancelRemaining: boolean;
  remarks: string;
  /** Allocations PR (remplacées si la quantité change : somme = nouvelle quantité) */
  allocations: { prLineId: string; label: string; unit: string; quantity: string }[];
}

/** Avenant / révision d'un BC transmis : snapshot des quantités précédentes + nouveau PDF (jamais silencieux). */
/**
 * Avenant au BC. En mode `correction` (écart de réception, « correction auprès du fournisseur ») : ouvert à
 * l'acheteur qui traite les écarts (POST /orders/:id/correction) ; la comparaison BC ↔ BL est refaite et le BC
 * se clôture automatiquement s'il correspond au reçu.
 */
export function RevisePoDialog({ po, onClose, correction = false }: { po: PoDetail; onClose: () => void; correction?: boolean }) {
  const run = useCommand();
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<Record<string, ReviseLine>>(() =>
    Object.fromEntries(
      po.lines.map((l) => [
        l.id,
        {
          quantityOrdered: l.quantityOrdered,
          unitPrice: l.unitPrice,
          cancelRemaining: false,
          remarks: '',
          allocations: l.allocations.map((a) => ({ prLineId: a.prLineId, label: `${a.prLine.pr.number} L${a.prLine.lineNo}`, unit: a.prLine.unit, quantity: a.quantity })),
        },
      ]),
    ),
  );
  const [tax, setTax] = useState(po.taxAmount);
  const [freight, setFreight] = useState(po.freightAmount);
  const [expected, setExpected] = useState(toDateInput(po.expectedDeliveryDate));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<OverAllocationLine[] | null>(null);

  const changed = po.lines
    .map((l) => {
      const x = lines[l.id];
      const qtyChanged = !x.cancelRemaining && dec.cmp(toApiDecimal(x.quantityOrdered), l.quantityOrdered) !== 0;
      const priceChanged = dec.cmp(toApiDecimal(x.unitPrice), l.unitPrice) !== 0;
      if (!qtyChanged && !priceChanged && !x.cancelRemaining && !x.remarks.trim()) return null;
      return {
        poLineId: l.id,
        quantityOrdered: qtyChanged ? toApiDecimal(x.quantityOrdered) : undefined,
        unitPrice: priceChanged ? toApiDecimal(x.unitPrice) : undefined,
        cancelRemaining: x.cancelRemaining || undefined,
        remarks: x.remarks.trim() || undefined,
        // Nouvelle quantité contractuelle : allocations PR remplacées (somme = quantité, capacité contrôlée par le serveur)
        allocations: qtyChanged && x.allocations.length ? x.allocations.map((a) => ({ prLineId: a.prLineId, quantity: toApiDecimal(a.quantity) })) : undefined,
      };
    })
    .filter((x): x is NonNullable<typeof x> => !!x);
  const taxChanged = dec.cmp(toApiDecimal(tax), po.taxAmount) !== 0;
  const freightChanged = dec.cmp(toApiDecimal(freight), po.freightAmount) !== 0;
  const dateChanged = expected !== toDateInput(po.expectedDeliveryDate);
  const errors = po.lines.map((l) => {
    const x = lines[l.id];
    const e = decimalError(x.quantityOrdered, { required: true, positive: true, scale: 3 }) ?? decimalError(x.unitPrice, { required: true, scale: 4 });
    if (e) return e;
    const accepted = l.balance?.accepted ?? '0';
    if (!x.cancelRemaining && dec.cmp(toApiDecimal(x.quantityOrdered), accepted) < 0) return `≥ ${fmtDecimal(accepted)} (déjà accepté)`;
    const qtyChanged = !x.cancelRemaining && dec.cmp(toApiDecimal(x.quantityOrdered), l.quantityOrdered) !== 0;
    if (qtyChanged && x.allocations.length) {
      if (x.allocations.some((a) => decimalError(a.quantity, { required: true, positive: true, scale: 3 }))) return 'Allocation PR invalide';
      const sum = dec.add(...x.allocations.map((a) => toApiDecimal(a.quantity)));
      if (dec.cmp(sum, toApiDecimal(x.quantityOrdered)) !== 0) return `Σ allocations PR (${fmtDecimal(sum)}) ≠ nouvelle quantité`;
    }
    return null;
  });
  const valid = reason.trim().length >= 3 && (changed.length > 0 || taxChanged || freightChanged || dateChanged) && errors.every((e) => !e) && !decimalError(tax, { required: true, scale: 2 }) && !decimalError(freight, { required: true, scale: 2 });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={correction ? `Correction fournisseur — BC ${po.number}` : `Avenant au BC ${po.number}`}
      description={
        correction
          ? 'Ajustez le BC à ce que le fournisseur livre réellement (quantité réduite, reliquat annulé, prix…). La version précédente est conservée et un nouveau PDF est généré ; la comparaison avec les BL déjà reçus est refaite et le BC se clôture s’il correspond au reçu.'
          : 'Les quantités contractuelles précédentes sont conservées (snapshot) et un nouveau PDF est généré. Un avenant à la hausse (quantité, prix, montant) qui franchit la règle d’approbation repasse en second regard avant tout renvoi ; une hausse de quantité réalloue la ligne PR (somme des allocations = quantité).'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setOver(null);
              try {
                const res = await run(
                  () =>
                    api.post<{ note: string; order: { revisionNo: number }; reapprovalRequired?: boolean; approvalDecision?: { reason: string } }>(`/orders/${po.id}/${correction ? 'correction' : 'revisions'}`, {
                      expectedVersion: po.lockVersion,
                      reason: reason.trim(),
                      lines: changed,
                      taxAmount: taxChanged ? toApiDecimal(tax) : undefined,
                      freightAmount: freightChanged ? toApiDecimal(freight) : undefined,
                      expectedDeliveryDate: dateChanged ? expected || null : undefined,
                    }),
                  (r) =>
                    correction && !r.reapprovalRequired
                      ? `Correction enregistrée (révision n°${r.order.revisionNo}) : comparaison BC ↔ BL refaite`
                      : r.reapprovalRequired
                      ? `Révision n°${r.order.revisionNo} enregistrée : avenant à la hausse soumis à second regard (${APPROVAL_REASON_LABELS[r.approvalDecision?.reason ?? ''] ?? r.approvalDecision?.reason ?? ''}). Renvoi au fournisseur bloqué jusqu’à l’approbation.`
                      : `Révision n°${r.order.revisionNo} enregistrée — ${r.note}`,
                );
                void res;
                onClose();
              } catch (e) {
                setOver(overAllocationLines(e));
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            {correction ? 'Enregistrer la correction' : 'Enregistrer l’avenant'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">Ligne</th>
                <th scope="col" className="text-right">
                  Commandé
                </th>
                <th scope="col" className="text-right">
                  Accepté
                </th>
                <th scope="col" className="text-right">
                  Reste
                </th>
                <th scope="col" className="text-right">
                  Nouvelle qté
                </th>
                <th scope="col" className="text-right">
                  Nouveau PU ({po.currency})
                </th>
                <th scope="col">Annuler le reste</th>
                <th scope="col">Remarque</th>
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l, i) => {
                const x = lines[l.id];
                const patch = (p: Partial<ReviseLine>) => setLines((prev) => ({ ...prev, [l.id]: { ...prev[l.id], ...p } }));
                return (
                  <tr key={l.id} className={cn(l.status === 'CANCELLED' && 'opacity-50')}>
                    <td className="min-w-[180px]">
                      {l.lineNo}. {l.designation}
                      {errors[i] && <span className="block text-xs text-danger">{errors[i]}</span>}
                    </td>
                    <td className="text-right tabular">
                      {fmtDecimal(l.quantityOrdered)} {l.unit}
                    </td>
                    <td className="text-right tabular">{fmtDecimal(l.balance?.accepted)}</td>
                    <td className={cn('text-right tabular', dec.gt0(l.balance?.remaining) && 'text-warn')}>{fmtDecimal(l.balance?.remaining)}</td>
                    <td className="w-28">
                      <DecimalInput
                        value={x.quantityOrdered}
                        onChange={(v) => patch(x.allocations.length === 1 ? { quantityOrdered: v, allocations: [{ ...x.allocations[0], quantity: v }] } : { quantityOrdered: v })}
                        disabled={x.cancelRemaining || l.status === 'CANCELLED'}
                        className="h-8"
                        ariaLabel="Nouvelle quantité"
                      />
                      {x.allocations.length > 1 && !x.cancelRemaining && dec.cmp(toApiDecimal(x.quantityOrdered), l.quantityOrdered) !== 0 && (
                        <div className="mt-1 space-y-1">
                          {x.allocations.map((a, k) => (
                            <div key={a.prLineId} className="flex items-center gap-1">
                              <span className="w-20 truncate text-[11px] text-ink-muted" title={a.label}>
                                {a.label}
                              </span>
                              <DecimalInput
                                value={a.quantity}
                                onChange={(v2) => patch({ allocations: x.allocations.map((y, m) => (m === k ? { ...y, quantity: v2 } : y)) })}
                                className="h-7 text-xs"
                                ariaLabel={`Allocation ${a.label}`}
                              />
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="w-28">
                      <DecimalInput value={x.unitPrice} onChange={(v) => patch({ unitPrice: v })} disabled={l.status === 'CANCELLED'} className="h-8" ariaLabel="Nouveau prix unitaire" />
                    </td>
                    <td>
                      <Checkbox label="Annuler" checked={x.cancelRemaining} disabled={!dec.gt0(l.balance?.remaining) || l.status === 'CANCELLED'} onChange={(e) => patch({ cancelRemaining: e.target.checked })} />
                    </td>
                    <td className="min-w-[140px]">
                      <Input value={x.remarks} onChange={(e) => patch({ remarks: e.target.value })} className="h-8 text-sm" aria-label="Remarque" maxLength={1000} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <FormField label="Taxes">
            <DecimalInput value={tax} onChange={setTax} />
          </FormField>
          <FormField label="Fret">
            <DecimalInput value={freight} onChange={setFreight} />
          </FormField>
          <FormField label="Livraison attendue">
            <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Motif de l’avenant" required hint="Conservé avec la révision et dans le journal d’audit.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </FormField>
        {error && (
          <Callout tone="danger" title={over ? 'Sur-allocation refusée' : 'Avenant refusé'}>
            <p>{error}</p>
            {over && <OverAllocationTable lines={over} />}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}

interface EditLine {
  id: string;
  quotationLineId: string | null;
  designation: string;
  reference: string;
  unit: string;
  quantity: string;
  unitPrice: string;
  remarks: string;
  allocations: { prLineId: string; label: string; unit: string; quantity: string }[];
}

/** Modification d'un BC brouillon (PUT /orders/:id, remplacement complet avec expectedVersion). */
export function EditDraftPoDialog({ po, onClose }: { po: PoDetail; onClose: () => void }) {
  const run = useCommand();
  const [lines, setLines] = useState<EditLine[]>(() =>
    po.lines
      .filter((l) => l.status !== 'CANCELLED')
      .map((l) => ({
        id: l.id,
        quotationLineId: l.quotationLineId,
        designation: l.designation,
        reference: l.reference ?? '',
        unit: l.unit,
        quantity: l.quantityOrdered,
        unitPrice: l.unitPrice,
        remarks: l.remarks ?? '',
        allocations: l.allocations.map((a) => ({ prLineId: a.prLineId, label: `${a.prLine.pr.number} L${a.prLine.lineNo}`, unit: a.prLine.unit, quantity: a.quantity })),
      })),
  );
  const [h, setH] = useState({
    expectedDeliveryDate: toDateInput(po.expectedDeliveryDate),
    deliveryPort: po.deliveryPort ?? '',
    deliveryTerms: po.deliveryTerms ?? '',
    paymentTerms: po.paymentTerms ?? '',
    notes: po.notes ?? '',
    taxAmount: po.taxAmount,
    freightAmount: po.freightAmount,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [over, setOver] = useState<OverAllocationLine[] | null>(null);
  const patch = (i: number, p: Partial<EditLine>) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...p } : l)));
  const errors = lines.map(
    (l) =>
      decimalError(l.quantity, { required: true, positive: true, scale: 3 }) ??
      decimalError(l.unitPrice, { required: true, scale: 4 }) ??
      (l.allocations.some((a) => decimalError(a.quantity, { required: true, positive: true, scale: 3 })) ? 'Allocation PR invalide' : null) ??
      (!l.designation.trim() || !l.unit.trim() ? 'Désignation et unité obligatoires' : null) ??
      (dec.cmp(dec.add(...l.allocations.map((a) => toApiDecimal(a.quantity))), toApiDecimal(l.quantity)) !== 0
        ? `Σ allocations PR (${fmtDecimal(dec.add(...l.allocations.map((a) => toApiDecimal(a.quantity))))}) ≠ quantité (${fmtDecimal(toApiDecimal(l.quantity))})`
        : null),
  );
  const subtotal = dec.add(...lines.map((l) => dec.mul(toApiDecimal(l.quantity), toApiDecimal(l.unitPrice))));
  const valid = lines.length > 0 && errors.every((e) => !e) && !decimalError(h.taxAmount, { scale: 2 }) && !decimalError(h.freightAmount, { scale: 2 });

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={`Modifier le brouillon ${po.number}`}
      footer={
        <>
          <span className="mr-auto self-center text-sm text-ink-muted">
            Sous-total <span className="font-semibold tabular text-ink">{fmtMoney(subtotal, po.currency)}</span>
          </span>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={!valid}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setOver(null);
              try {
                await run(
                  () =>
                    api.put(`/orders/${po.id}`, {
                      expectedVersion: po.lockVersion,
                      supplierId: po.supplierId,
                      currency: po.currency,
                      quotationId: po.quotationId ?? undefined,
                      expectedDeliveryDate: h.expectedDeliveryDate || null,
                      deliveryPort: h.deliveryPort.trim() || null,
                      deliveryTerms: h.deliveryTerms.trim() || null,
                      paymentTerms: h.paymentTerms.trim() || null,
                      notes: h.notes.trim() || null,
                      taxAmount: toApiDecimal(h.taxAmount || '0'),
                      freightAmount: toApiDecimal(h.freightAmount || '0'),
                      lines: lines.map((l) => ({
                        ...(l.quotationLineId ? { quotationLineId: l.quotationLineId } : {}),
                        designation: l.designation.trim(),
                        reference: l.reference.trim() || null,
                        unit: l.unit.trim(),
                        quantity: toApiDecimal(l.quantity),
                        unitPrice: toApiDecimal(l.unitPrice),
                        remarks: l.remarks.trim() || null,
                        allocations: l.allocations.map((a) => ({ prLineId: a.prLineId, quantity: toApiDecimal(a.quantity) })),
                      })),
                    }),
                  'Brouillon de BC enregistré',
                );
                onClose();
              } catch (e) {
                setOver(overAllocationLines(e));
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Enregistrer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">Désignation</th>
                <th scope="col" className="text-right">
                  Qté
                </th>
                <th scope="col">Unité</th>
                <th scope="col" className="text-right">
                  PU ({po.currency})
                </th>
                <th scope="col">Allocations PR (unité PR)</th>
                <th scope="col">Remarques</th>
                <th scope="col">
                  <span className="sr-only">Retirer</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.id}>
                  <td className="min-w-[180px]">
                    <Input value={l.designation} onChange={(e) => patch(i, { designation: e.target.value })} className="h-8 text-sm" aria-label="Désignation" maxLength={500} />
                    {l.quotationLineId && <Badge tone="info" className="mt-1">Issue d’un devis</Badge>}
                    {errors[i] && <span className="block text-xs text-danger">{errors[i]}</span>}
                  </td>
                  <td className="w-24">
                    <DecimalInput
                      value={l.quantity}
                      onChange={(v) => patch(i, l.allocations.length === 1 ? { quantity: v, allocations: [{ ...l.allocations[0], quantity: v }] } : { quantity: v })}
                      className="h-8"
                      ariaLabel="Quantité"
                    />
                  </td>
                  <td className="w-20">
                    <Input value={l.unit} onChange={(e) => patch(i, { unit: e.target.value })} className="h-8 text-sm" aria-label="Unité" maxLength={32} />
                  </td>
                  <td className="w-28">
                    <DecimalInput value={l.unitPrice} onChange={(v) => patch(i, { unitPrice: v })} className="h-8" ariaLabel="Prix unitaire" />
                  </td>
                  <td className="min-w-[200px]">
                    {l.allocations.map((a, k) => (
                      <div key={a.prLineId} className="mb-1 flex items-center gap-1">
                        <span className="w-28 truncate text-xs text-ink-muted" title={a.label}>
                          {a.label}
                        </span>
                        <DecimalInput
                          value={a.quantity}
                          onChange={(v) => patch(i, { allocations: l.allocations.map((x, m) => (m === k ? { ...x, quantity: v } : x)) })}
                          className="h-7 w-20 text-xs"
                          ariaLabel={`Allocation ${a.label}`}
                        />
                        <span className="text-xs text-ink-muted">{a.unit}</span>
                      </div>
                    ))}
                  </td>
                  <td className="min-w-[140px]">
                    <Input value={l.remarks} onChange={(e) => patch(i, { remarks: e.target.value })} className="h-8 text-sm" aria-label="Remarques" maxLength={1000} />
                  </td>
                  <td>
                    <IconButton label="Retirer la ligne" onClick={() => setLines((prev) => prev.filter((_, j) => j !== i))} disabled={lines.length === 1}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          <FormField label="Livraison attendue">
            <Input type="date" value={h.expectedDeliveryDate} onChange={(e) => setH((x) => ({ ...x, expectedDeliveryDate: e.target.value }))} />
          </FormField>
          <FormField label="Taxes">
            <DecimalInput value={h.taxAmount} onChange={(v) => setH((x) => ({ ...x, taxAmount: v }))} />
          </FormField>
          <FormField label="Fret">
            <DecimalInput value={h.freightAmount} onChange={(v) => setH((x) => ({ ...x, freightAmount: v }))} />
          </FormField>
          <FormField label="Port de livraison">
            <Input value={h.deliveryPort} onChange={(e) => setH((x) => ({ ...x, deliveryPort: e.target.value }))} maxLength={120} />
          </FormField>
          <FormField label="Conditions de livraison" className="md:col-span-2">
            <Input value={h.deliveryTerms} onChange={(e) => setH((x) => ({ ...x, deliveryTerms: e.target.value }))} maxLength={500} />
          </FormField>
          <FormField label="Conditions de paiement" className="md:col-span-2">
            <Input value={h.paymentTerms} onChange={(e) => setH((x) => ({ ...x, paymentTerms: e.target.value }))} maxLength={250} />
          </FormField>
          <FormField label="Notes" className="md:col-span-4">
            <Textarea rows={2} value={h.notes} onChange={(e) => setH((x) => ({ ...x, notes: e.target.value }))} maxLength={5000} className="min-h-[56px]" />
          </FormField>
        </div>
        {error && (
          <Callout tone="danger" title={over ? 'Sur-allocation refusée' : 'Enregistrement refusé'}>
            <p>{error}</p>
            {over && <OverAllocationTable lines={over} />}
          </Callout>
        )}
      </div>
    </Dialog>
  );
}
