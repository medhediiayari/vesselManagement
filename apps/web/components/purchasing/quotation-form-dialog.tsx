'use client';

import { FileCheck2 } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { cn, fmtDecimal, fmtMoney } from '@/lib/format';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { COMPLIANCE_LABELS, INCOTERMS, commandError, dec, decimalError, toApiDecimal, useCommand } from './lib';
import { CurrencyInput } from './manual-po-dialog';
import type { ComplianceStatus, Quotation, RfqDetail } from './types';
import { Callout, DecimalInput, FormField } from './ui';

type Mode = 'QUOTED' | 'UNAVAILABLE' | 'NONE';

interface LineInput {
  mode: Mode;
  quantityOffered: string;
  unit: string;
  unitPrice: string;
  leadTimeDays: string;
  compliance: ComplianceStatus;
  remarks: string;
}

const intOk = (v: string) => !v.trim() || /^\d{1,4}$/.test(v.trim());

/**
 * Saisie d'un devis fournisseur (quotation.record) — jamais d'écrasement : une correction se fait par
 * retrait motivé puis nouvelle saisie. Le PDF original du devis est conservé.
 */
export function QuotationFormDialog({ open, onOpenChange, rfq }: { open: boolean; onOpenChange: (o: boolean) => void; rfq: RfqDetail }) {
  const run = useCommand();
  const ids = { sup: useId(), ref: useId(), cur: useId(), inc: useId() };
  const activeSuppliers = new Set((rfq.quotations ?? []).filter((q) => q.status !== 'WITHDRAWN').map((q) => q.supplierId));
  const candidates = rfq.suppliers.filter((s) => !activeSuppliers.has(s.supplierId));
  const [supplierId, setSupplierId] = useState('');
  const [h, setH] = useState({
    reference: '',
    receivedAt: '',
    currency: '',
    validUntil: '',
    leadTimeDays: '',
    incoterm: '',
    deliveryTerms: '',
    paymentTerms: '',
    freightAmount: '',
    taxAmount: '',
    discountAmount: '',
    comments: '',
  });
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [lines, setLines] = useState<Record<string, LineInput>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSupplierId('');
    setFile(null);
    setError(null);
    setH((x) => ({ ...x, reference: '', receivedAt: '', currency: '', validUntil: '', leadTimeDays: '', incoterm: '', freightAmount: '', taxAmount: '', discountAmount: '', comments: '', deliveryTerms: '', paymentTerms: '' }));
    setLines(Object.fromEntries(rfq.lines.map((l) => [l.id, { mode: 'QUOTED', quantityOffered: l.quantity, unit: l.unit, unitPrice: '', leadTimeDays: '', compliance: 'COMPLIANT', remarks: '' } satisfies LineInput])));
  }, [open, rfq.lines]);

  const patchLine = (id: string, p: Partial<LineInput>) => setLines((prev) => ({ ...prev, [id]: { ...prev[id], ...p } }));
  const lineErr = (l: LineInput): string | null => {
    if (l.mode !== 'QUOTED') return null;
    return (
      decimalError(l.unitPrice, { required: true, scale: 4 }) ??
      decimalError(l.quantityOffered, { scale: 3 }) ??
      (intOk(l.leadTimeDays) ? null : 'Délai : nombre de jours entier')
    );
  };
  const quoted = rfq.lines.filter((l) => lines[l.id]?.mode === 'QUOTED');
  const included = rfq.lines.filter((l) => lines[l.id] && lines[l.id].mode !== 'NONE');
  const errors = rfq.lines.map((l) => (lines[l.id] ? lineErr(lines[l.id]) : null));
  const subtotal = dec.add(...quoted.map((l) => dec.mul(toApiDecimal(lines[l.id].quantityOffered || '0'), toApiDecimal(lines[l.id].unitPrice || '0'))));
  const total = dec.sub(dec.add(subtotal, toApiDecimal(h.freightAmount || '0'), toApiDecimal(h.taxAmount || '0')), toApiDecimal(h.discountAmount || '0'));
  const headerErr =
    decimalError(h.freightAmount, { scale: 2 }) ?? decimalError(h.taxAmount, { scale: 2 }) ?? decimalError(h.discountAmount, { scale: 2 }) ?? (intOk(h.leadTimeDays) ? null : 'Délai global : nombre de jours entier');
  const canSubmit = !!supplierId && /^[A-Z]{3}$/.test(h.currency) && included.length > 0 && errors.every((e) => !e) && !headerErr;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await run(
        () =>
          api.post<Quotation>(`/rfqs/${rfq.id}/quotations`, {
            supplierId,
            reference: h.reference.trim() || null,
            receivedAt: h.receivedAt ? new Date(h.receivedAt).toISOString() : undefined,
            currency: h.currency,
            validUntil: h.validUntil || null,
            leadTimeDays: h.leadTimeDays.trim() ? Number(h.leadTimeDays) : null,
            incoterm: h.incoterm.trim() || null,
            deliveryTerms: h.deliveryTerms.trim() || null,
            paymentTerms: h.paymentTerms.trim() || null,
            freightAmount: h.freightAmount ? toApiDecimal(h.freightAmount) : null,
            taxAmount: h.taxAmount ? toApiDecimal(h.taxAmount) : null,
            discountAmount: h.discountAmount ? toApiDecimal(h.discountAmount) : null,
            comments: h.comments.trim() || null,
            fileId: file?.id ?? null,
            lines: included.map((l) => {
              const x = lines[l.id];
              return x.mode === 'UNAVAILABLE'
                ? { rfqLineId: l.id, isAvailable: false, remarks: x.remarks.trim() || null }
                : {
                    rfqLineId: l.id,
                    isAvailable: true,
                    quantityOffered: x.quantityOffered ? toApiDecimal(x.quantityOffered) : null,
                    unit: x.unit.trim() || null,
                    unitPrice: toApiDecimal(x.unitPrice),
                    leadTimeDays: x.leadTimeDays.trim() ? Number(x.leadTimeDays) : null,
                    compliance: x.compliance,
                    remarks: x.remarks.trim() || null,
                  };
            }),
          }),
        (q) => `Devis enregistré — total ${fmtMoney(q.totalAmount, q.currency)}`,
      );
      onOpenChange(false);
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
      size="xl"
      title={`Saisir un devis — ${rfq.number}`}
      description="Prix unitaires, quantités offertes, disponibilité, délais et conformité par ligne ; frais, validité et Incoterm. Aucune conversion de devise."
      footer={
        <>
          <span className="mr-auto self-center text-sm text-ink-muted">
            Sous-total <span className="font-semibold tabular text-ink">{h.currency ? fmtMoney(subtotal, h.currency) : fmtDecimal(subtotal, 2)}</span> · Total{' '}
            <span className="font-semibold tabular text-ink">{h.currency ? fmtMoney(total, h.currency) : fmtDecimal(total, 2)}</span>
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} disabled={!canSubmit} loading={busy}>
            <FileCheck2 className="h-4 w-4" aria-hidden /> Enregistrer le devis
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!candidates.length && (
          <Callout tone="warn" title="Aucun fournisseur disponible">
            Chaque fournisseur consulté a déjà un devis actif. Pour corriger un devis, retirez-le (motif) puis saisissez-en un nouveau.
          </Callout>
        )}
        <div className="grid gap-3 md:grid-cols-4">
          <FormField label="Fournisseur" required htmlFor={ids.sup} className="md:col-span-2">
            <Select
              id={ids.sup}
              value={supplierId}
              onChange={(e) => {
                setSupplierId(e.target.value);
                const s = rfq.suppliers.find((x) => x.supplierId === e.target.value);
                if (s?.supplier.currency && !h.currency) setH((x) => ({ ...x, currency: s.supplier.currency! }));
              }}
            >
              <option value="">— Choisir parmi les fournisseurs consultés —</option>
              {candidates.map((s) => (
                <option key={s.supplierId} value={s.supplierId}>
                  {s.supplier.name} ({s.supplier.code})
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Référence du devis" htmlFor={ids.ref}>
            <Input id={ids.ref} value={h.reference} onChange={(e) => setH((x) => ({ ...x, reference: e.target.value }))} maxLength={120} />
          </FormField>
          <FormField label="Devise" required htmlFor={ids.cur} hint="Code ISO 4217">
            <CurrencyInput id={ids.cur} value={h.currency} onChange={(v) => setH((x) => ({ ...x, currency: v }))} />
          </FormField>
          <FormField label="Reçu le">
            <Input type="datetime-local" value={h.receivedAt} onChange={(e) => setH((x) => ({ ...x, receivedAt: e.target.value }))} />
          </FormField>
          <FormField label="Valide jusqu’au">
            <Input type="date" value={h.validUntil} onChange={(e) => setH((x) => ({ ...x, validUntil: e.target.value }))} />
          </FormField>
          <FormField label="Délai global (jours)">
            <Input inputMode="numeric" value={h.leadTimeDays} onChange={(e) => setH((x) => ({ ...x, leadTimeDays: e.target.value }))} className="text-right tabular" />
          </FormField>
          <FormField label="Incoterm" htmlFor={ids.inc}>
            <Input id={ids.inc} value={h.incoterm} onChange={(e) => setH((x) => ({ ...x, incoterm: e.target.value.toUpperCase() }))} list="incoterms" maxLength={16} />
            <datalist id="incoterms">
              {INCOTERMS.map((i) => (
                <option key={i} value={i} />
              ))}
            </datalist>
          </FormField>
        </div>

        <div className="overflow-x-auto rounded-md border border-line">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">Ligne RFQ</th>
                <th scope="col" className="text-right">
                  Qté demandée
                </th>
                <th scope="col">Offre</th>
                <th scope="col" className="text-right">
                  Qté offerte
                </th>
                <th scope="col">Unité</th>
                <th scope="col" className="text-right">
                  PU
                </th>
                <th scope="col" className="text-right">
                  Délai (j)
                </th>
                <th scope="col">Conformité</th>
                <th scope="col">Remarques</th>
              </tr>
            </thead>
            <tbody>
              {rfq.lines.map((l, i) => {
                const x = lines[l.id];
                if (!x) return null;
                const off = x.mode !== 'QUOTED';
                return (
                  <tr key={l.id} className={cn(x.mode === 'NONE' && 'opacity-60')}>
                    <td className="min-w-[180px]">
                      <span className="text-xs tabular text-ink-muted">{l.lineNo}. </span>
                      {l.designation}
                      {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                      {errors[i] && x.unitPrice.trim() !== '' && <span className="block text-xs text-danger">{errors[i]}</span>}
                    </td>
                    <td className="text-right tabular">
                      {fmtDecimal(l.quantity)} {l.unit}
                    </td>
                    <td>
                      <Select value={x.mode} onChange={(e) => patchLine(l.id, { mode: e.target.value as Mode })} className="h-8 w-36 text-sm" aria-label={`Offre ligne ${l.lineNo}`}>
                        <option value="QUOTED">Chiffrée</option>
                        <option value="UNAVAILABLE">Indisponible</option>
                        <option value="NONE">Sans réponse</option>
                      </Select>
                    </td>
                    <td className="w-24">
                      <DecimalInput value={x.quantityOffered} onChange={(v) => patchLine(l.id, { quantityOffered: v })} disabled={off} className="h-8" ariaLabel="Quantité offerte" />
                    </td>
                    <td className="w-20">
                      <Input value={x.unit} onChange={(e) => patchLine(l.id, { unit: e.target.value })} disabled={off} className="h-8 text-sm" aria-label="Unité offerte" maxLength={32} />
                    </td>
                    <td className="w-28">
                      <DecimalInput value={x.unitPrice} onChange={(v) => patchLine(l.id, { unitPrice: v })} disabled={off} className="h-8" ariaLabel="Prix unitaire" invalid={x.mode === 'QUOTED' && !!errors[i] && x.unitPrice.trim() !== ''} />
                    </td>
                    <td className="w-20">
                      <Input inputMode="numeric" value={x.leadTimeDays} onChange={(e) => patchLine(l.id, { leadTimeDays: e.target.value })} disabled={off} className="h-8 text-right text-sm tabular" aria-label="Délai en jours" />
                    </td>
                    <td>
                      <Select value={x.compliance} onChange={(e) => patchLine(l.id, { compliance: e.target.value as ComplianceStatus })} disabled={off} className="h-8 w-36 text-sm" aria-label="Conformité">
                        {Object.entries(COMPLIANCE_LABELS).map(([k, v]) => (
                          <option key={k} value={k}>
                            {v}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="min-w-[140px]">
                      <Input value={x.remarks} onChange={(e) => patchLine(l.id, { remarks: e.target.value })} disabled={x.mode === 'NONE'} className="h-8 text-sm" aria-label="Remarques" maxLength={1000} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          <FormField label="Fret" error={decimalError(h.freightAmount, { scale: 2 }) ?? undefined}>
            <DecimalInput value={h.freightAmount} onChange={(v) => setH((x) => ({ ...x, freightAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Taxes" error={decimalError(h.taxAmount, { scale: 2 }) ?? undefined}>
            <DecimalInput value={h.taxAmount} onChange={(v) => setH((x) => ({ ...x, taxAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Remise" error={decimalError(h.discountAmount, { scale: 2 }) ?? undefined}>
            <DecimalInput value={h.discountAmount} onChange={(v) => setH((x) => ({ ...x, discountAmount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Conditions de livraison">
            <Input value={h.deliveryTerms} onChange={(e) => setH((x) => ({ ...x, deliveryTerms: e.target.value }))} maxLength={500} />
          </FormField>
          <FormField label="Conditions de paiement">
            <Input value={h.paymentTerms} onChange={(e) => setH((x) => ({ ...x, paymentTerms: e.target.value }))} maxLength={250} />
          </FormField>
          <FormField label="Commentaires">
            <Textarea rows={1} value={h.comments} onChange={(e) => setH((x) => ({ ...x, comments: e.target.value }))} maxLength={5000} className="min-h-[36px]" />
          </FormField>
        </div>

        <FormField label="PDF original du devis" hint="Conservé tel que reçu du fournisseur (preuve).">
          <FileUploader context="PURCHASING" vesselId={rfq.vesselId} onUploaded={setFile} label="Déposer le devis original" />
        </FormField>
        {headerErr && <p className="text-sm text-danger">{headerErr}</p>}
        {error && <Callout tone="danger" title="Devis refusé">{error}</Callout>}
      </div>
    </Dialog>
  );
}
