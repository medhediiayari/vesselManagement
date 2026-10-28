'use client';

import { AlertTriangle, FilePenLine, Hourglass, PackagePlus, ShoppingCart } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { commandError, dec, decimalError, toApiDecimal, useCommand } from './lib';
import { GapTable } from './onboard-bl-form';
import { RevisePoDialog } from './po-dialogs';
import type { PoDetail, Supplier } from './types';
import { Callout, CurrencyInput, DecimalInput, FormField, SupplierSelect, TextActionDialog } from './ui';

/** Lignes du BC dont le reçu cumulé diffère du commandé (manque ou surplus). */
export function orderGaps(po: PoDetail) {
  return po.lines
    .filter((l) => l.status !== 'CANCELLED' && l.balance)
    .map((l) => {
      const ordered = dec.sub(l.balance!.ordered, l.balance!.cancelled);
      const received = l.balance!.accepted;
      const c = dec.cmp(received, ordered);
      return { line: l, ordered, received, missing: c < 0 ? dec.sub(ordered, received) : '0', surplus: c > 0 ? dec.sub(received, ordered) : '0' };
    })
    .filter((g) => dec.gt0(g.missing) || dec.gt0(g.surplus));
}

/**
 * Alerte « écart de réception » en tête du BC (refonte du 22/10/2026) : comparaison commandé / reçu cumulé, remarques
 * et articles hors BC notés par le bord, puis décisions des Achats — attendre le reliquat, ou correction auprès du
 * fournisseur (révision du BC ou BC complémentaire). Le BC se clôture automatiquement quand tout correspond.
 */
export function DiscrepancyPanel({ po }: { po: PoDetail }) {
  const { can } = useSession();
  const run = useCommand();
  const [dialog, setDialog] = useState<null | 'await' | 'correction' | 'complementary'>(null);
  const open = (po.variances ?? []).filter((v) => v.status === 'OPEN' || v.status === 'IN_PROGRESS');
  const gaps = orderGaps(po);
  const hasDelivery = (po.deliveryNotes ?? []).some((d) => d.status !== 'CANCELLED');
  if (!open.length || !hasDelivery || !gaps.length) return null;
  const awaiting = open.every((v) => v.status === 'IN_PROGRESS');
  const canDecide = can('variances.manage');
  const canCorrect = canDecide && can('bc.create');
  const notes = (po.deliveryNotes ?? []).filter((d) => d.status !== 'CANCELLED');
  const remarks = notes.filter((d) => d.notes).map((d) => `BL ${d.number} : ${d.notes}`);
  const extras = notes.flatMap((d) => d.extraItems ?? []);
  const missingLines = gaps.filter((g) => dec.gt0(g.missing));

  return (
    <section aria-labelledby="gap-title" className="mb-5 overflow-hidden rounded-lg border border-danger-line bg-white shadow-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-danger-line bg-danger-bg px-4 py-2.5">
        <h2 id="gap-title" className="flex items-center gap-2 text-sm font-semibold text-danger">
          <AlertTriangle className="h-4 w-4" aria-hidden />
          {awaiting ? 'Reliquat attendu — écart entre reçu et commandé' : 'Écart de réception à traiter'}
        </h2>
        <span className="text-xs text-ink-muted">
          {gaps.length} article(s) · le BC se clôture dès que le reçu correspond au BC
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <GapTable
          rows={gaps.map((g) => ({
            key: g.line.id,
            designation: g.line.designation,
            unit: g.line.unit,
            ordered: g.ordered,
            received: g.received,
            missing: g.missing,
            surplus: g.surplus,
            remarks:
              (po.receipts ?? [])
                .flatMap((r) => (r.lines ?? []).filter((x) => x.poLineId === g.line.id && x.remarks).map((x) => x.remarks as string))
                .join(' · ') || null,
          }))}
        />
        {remarks.length > 0 && (
          <ul className="space-y-0.5 text-sm">
            {remarks.map((r) => (
              <li key={r} className="whitespace-pre-line text-ink-muted">
                « {r} »
              </li>
            ))}
          </ul>
        )}
        {extras.length > 0 && (
          <p className="text-sm text-ink-muted">
            Articles reçus hors BC (information) : {extras.map((x) => `${x.designation} — ${fmtDecimal(x.quantity)} ${x.unit}`).join(' ; ')}.
          </p>
        )}
        {canDecide ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <span className="mr-auto text-sm font-medium text-navy">Décision :</span>
            {!awaiting && (
              <Button size="sm" variant="secondary" onClick={() => setDialog('await')}>
                <Hourglass className="h-4 w-4" aria-hidden /> Attendre le reliquat
              </Button>
            )}
            {canCorrect && (
              <Button size="sm" variant="secondary" onClick={() => setDialog('correction')}>
                <FilePenLine className="h-4 w-4" aria-hidden /> Correction : réviser le BC
              </Button>
            )}
            {canCorrect && missingLines.length > 0 && (
              <Button size="sm" onClick={() => setDialog('complementary')}>
                <ShoppingCart className="h-4 w-4" aria-hidden /> Correction : BC complémentaire
              </Button>
            )}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Les Achats ont été alertés et décident de la suite ; à la prochaine livraison, envoyez un nouveau BL sur ce BC.</p>
        )}
        {awaiting && <p className="text-xs text-ink-muted">Le prochain BL du bord refera la comparaison ; les écarts comblés se résolvent automatiquement.</p>}
      </div>

      <TextActionDialog
        open={dialog === 'await'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Attendre le reliquat"
        description="Le BC reste ouvert : le bord enverra un nouveau BL à la livraison du reliquat. Le demandeur est prévenu."
        label="Message au bord"
        confirmLabel="Attendre le reliquat"
        onConfirm={(comment) => run(() => api.post(`/orders/${po.id}/await-remainder`, { comment: comment || undefined }), 'Reliquat attendu : le demandeur est prévenu')}
      />
      {dialog === 'correction' && <RevisePoDialog po={po} correction onClose={() => setDialog(null)} />}
      {dialog === 'complementary' && <ComplementaryDialog po={po} onClose={() => setDialog(null)} />}
    </section>
  );
}

/**
 * Correction fournisseur par BC complémentaire : les reliquats choisis sont annulés sur ce BC (avenant) et reportés
 * sur UN nouveau BC — même fournisseur ou un autre — lié aux mêmes lignes PR, émis immédiatement si demandé.
 */
export function ComplementaryDialog({ po, onClose }: { po: PoDetail; onClose: () => void }) {
  const run = useCommand();
  const candidates = po.lines.filter((l) => l.status !== 'CANCELLED' && dec.gt0(l.balance?.remaining));
  const [rows, setRows] = useState<Record<string, { include: boolean; quantity: string; unitPrice: string }>>(() =>
    Object.fromEntries(candidates.map((l) => [l.id, { include: true, quantity: dec.norm(l.balance!.remaining), unitPrice: dec.norm(l.unitPrice) }])),
  );
  const [supplierId, setSupplierId] = useState(po.supplierId);
  const [currency, setCurrency] = useState(po.currency);
  const [expected, setExpected] = useState('');
  const [port, setPort] = useState(po.deliveryPort ?? '');
  const [reason, setReason] = useState('');
  const [issueNow, setIssueNow] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const included = candidates.filter((l) => rows[l.id]?.include);
  const errors = Object.fromEntries(
    included.map((l) => {
      const r = rows[l.id];
      const e = decimalError(r.quantity, { required: true, positive: true, scale: 3 }) ?? decimalError(r.unitPrice, { required: true, scale: 4 });
      if (e) return [l.id, e];
      if (dec.cmp(toApiDecimal(r.quantity), l.balance!.remaining) > 0) return [l.id, `≤ ${fmtDecimal(l.balance!.remaining)} (reliquat)`];
      return [l.id, null];
    }),
  );
  const valid = included.length > 0 && Object.values(errors).every((e) => !e) && reason.trim().length >= 3 && currency.length === 3;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="xl"
      title={`BC complémentaire — reliquat du BC ${po.number}`}
      description="Les quantités reportées sont retirées de ce BC (avenant, version précédente conservée) puis commandées sur un nouveau BC lié aux mêmes lignes PR. Le demandeur reçoit le nouveau BC s’il est émis."
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
              try {
                await run(
                  () =>
                    api.post<{ complementaryOrder: { number: string }; issued: boolean }>(`/orders/${po.id}/complementary`, {
                      reason: reason.trim(),
                      originalOrderVersion: po.lockVersion,
                      supplierId: supplierId || undefined,
                      currency,
                      expectedDeliveryDate: expected || null,
                      deliveryPort: port.trim() || null,
                      issueNow,
                      lines: included.map((l) => ({ poLineId: l.id, quantity: toApiDecimal(rows[l.id].quantity), unitPrice: toApiDecimal(rows[l.id].unitPrice) })),
                    }),
                  (r) => `BC complémentaire ${r.complementaryOrder.number} ${r.issued ? 'émis' : 'créé (à émettre)'}`,
                );
                onClose();
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <PackagePlus className="h-4 w-4" aria-hidden /> {issueNow ? 'Créer et émettre' : 'Créer en brouillon'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 md:grid-cols-4">
          <SupplierSelect
            value={supplierId}
            onChange={(id, s?: Supplier) => {
              setSupplierId(id);
              if (s?.currency) setCurrency(s.currency);
            }}
            required
            className="md:col-span-2"
            hint="Même fournisseur (correction) ou un autre."
          />
          <FormField label="Devise" required>
            <CurrencyInput value={currency} onChange={setCurrency} />
          </FormField>
          <FormField label="Livraison attendue">
            <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </FormField>
          <FormField label="Port de livraison" className="md:col-span-2">
            <Input value={port} onChange={(e) => setPort(e.target.value)} maxLength={120} />
          </FormField>
        </div>
        <div className="overflow-x-auto rounded-md border border-line">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">
                  <span className="sr-only">Reporter</span>
                </th>
                <th scope="col">Article</th>
                <th scope="col" className="text-right">
                  Reliquat
                </th>
                <th scope="col" className="text-right">
                  Qté reportée
                </th>
                <th scope="col" className="text-right">
                  PU ({currency || 'devise'})
                </th>
              </tr>
            </thead>
            <tbody>
              {candidates.map((l) => {
                const r = rows[l.id];
                return (
                  <tr key={l.id} className={r.include ? '' : 'text-ink-muted'}>
                    <td>
                      <input type="checkbox" className="h-4 w-4" checked={r.include} onChange={(e) => setRows((p) => ({ ...p, [l.id]: { ...r, include: e.target.checked } }))} aria-label={`Reporter ${l.designation}`} />
                    </td>
                    <td className="min-w-[180px]">
                      {l.designation}
                      {errors[l.id] && <span className="block text-xs text-danger">{errors[l.id]}</span>}
                    </td>
                    <td className="text-right tabular">
                      {fmtDecimal(l.balance!.remaining)} {l.unit}
                    </td>
                    <td className="w-28">
                      <DecimalInput value={r.quantity} onChange={(v) => setRows((p) => ({ ...p, [l.id]: { ...r, quantity: v } }))} disabled={!r.include} ariaLabel={`Quantité reportée : ${l.designation}`} className="h-8" />
                    </td>
                    <td className="w-28">
                      <DecimalInput value={r.unitPrice} onChange={(v) => setRows((p) => ({ ...p, [l.id]: { ...r, unitPrice: v } }))} disabled={!r.include} ariaLabel={`Prix unitaire : ${l.designation}`} className="h-8" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <FormField label="Motif" required hint="ex. rupture chez le fournisseur, complément chez un autre fournisseur.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className="min-h-[56px]" />
        </FormField>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="h-4 w-4" checked={issueNow} onChange={(e) => setIssueNow(e.target.checked)} />
          Émettre le BC complémentaire immédiatement (transmis au demandeur{expected ? `, livraison le ${fmtDate(expected)}` : ''})
        </label>
        {error && <Callout tone="danger" title="BC complémentaire refusé">{error}</Callout>}
      </div>
    </Dialog>
  );
}
