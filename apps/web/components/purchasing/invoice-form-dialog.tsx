'use client';

import { useQuery } from '@tanstack/react-query';
import { Receipt } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type Page, type StoredFileDto } from '@/lib/api';
import { cn, fmtDecimal, fmtMoney } from '@/lib/format';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { LoadingBlock } from '@/components/ui/states';
import { commandError, dec, decimalError, purKeys, toApiDecimal, todayInput, useCommand } from './lib';
import { CurrencyInput } from './manual-po-dialog';
import type { InvoiceDetail, PoListItem } from './types';
import { Callout, DecimalInput, FormField, Money, PoStatusBadge, SupplierSelect } from './ui';

const INVOICEABLE = 'APPROVED,SENT,PARTIALLY_RECEIVED,RECEIVED,CLOSED';

/**
 * Enregistrement d'une facture fournisseur (fichier original, montants, devise, BC liés d'un même navire).
 * Une facture ne modifie jamais le statut de réception d'un BC (PUR-07).
 */
export function InvoiceFormDialog({ open, onOpenChange, initialSupplierId, initialPoId }: { open: boolean; onOpenChange: (o: boolean) => void; initialSupplierId?: string; initialPoId?: string }) {
  const router = useRouter();
  const run = useCommand();
  const [supplierId, setSupplierId] = useState(initialSupplierId ?? '');
  const [selected, setSelected] = useState<string[]>(initialPoId ? [initialPoId] : []);
  const [imputed, setImputed] = useState<Record<string, string>>({});
  const [h, setH] = useState({ number: '', invoiceDate: todayInput(), dueDate: '', currency: '', amount: '', taxAmount: '', reviewNotes: '' });
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setSupplierId(initialSupplierId ?? '');
      setSelected(initialPoId ? [initialPoId] : []);
      setImputed({});
      setFile(null);
      setError(null);
    }
  }, [open, initialSupplierId, initialPoId]);

  const orders = useQuery({
    queryKey: [...purKeys.orders, 'invoiceable', supplierId],
    queryFn: () => api.get<Page<PoListItem>>('/orders', { query: { supplierId, status: INVOICEABLE, limit: 100 } }),
    enabled: open && !!supplierId,
  });
  const list = orders.data?.items ?? [];
  const chosen = list.filter((p) => selected.includes(p.id));
  const vesselId = chosen[0]?.vesselId ?? null;

  useEffect(() => {
    if (!h.currency && chosen[0]) setH((x) => ({ ...x, currency: chosen[0].currency }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen.map((c) => c.id).join(',')]);

  const gross = dec.add(toApiDecimal(h.amount || '0'), toApiDecimal(h.taxAmount || '0'));
  const multi = chosen.length > 1;
  const imputedSum = dec.add(...chosen.map((p) => toApiDecimal(imputed[p.id] || '0')));
  const errors = {
    amount: decimalError(h.amount, { required: true, scale: 2 }),
    tax: decimalError(h.taxAmount, { scale: 2 }),
    imputed: multi
      ? chosen.some((p) => decimalError(imputed[p.id] ?? '', { required: true, scale: 2 }))
        ? 'Montant imputé obligatoire pour chaque BC'
        : dec.cmp(imputedSum, gross) !== 0
          ? `Somme imputée (${fmtDecimal(imputedSum, 2)}) ≠ montant TTC (${fmtDecimal(gross, 2)})`
          : null
      : null,
  };
  const currencyMismatch = chosen.some((p) => h.currency && p.currency !== h.currency);
  const valid = !!supplierId && chosen.length > 0 && h.number.trim() && h.invoiceDate && /^[A-Z]{3}$/.test(h.currency) && !errors.amount && !errors.tax && !errors.imputed;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const inv = await run(
        () =>
          api.post<InvoiceDetail>('/invoices', {
            supplierId,
            number: h.number.trim(),
            invoiceDate: h.invoiceDate,
            dueDate: h.dueDate || null,
            currency: h.currency,
            amount: toApiDecimal(h.amount),
            taxAmount: toApiDecimal(h.taxAmount || '0'),
            fileId: file?.id ?? null,
            reviewNotes: h.reviewNotes.trim() || null,
            orders: chosen.map((p) => ({ poId: p.id, amount: multi ? toApiDecimal(imputed[p.id]) : undefined })),
          }),
        (i) => `Facture ${i.number} enregistrée — rapprochement : ${i.matching.suggestion === 'MATCHED' ? 'conforme' : 'écart à examiner'}`,
      );
      onOpenChange(false);
      router.push(`/purchasing/invoices/${inv.id}`);
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
      title="Enregistrer une facture fournisseur"
      description="Fichier original, montants et devise tels que facturés ; rattachement à un ou plusieurs BC d’un même navire. Aucune conversion de devise."
      footer={
        <>
          <span className="mr-auto self-center text-sm text-ink-muted">
            TTC <span className="font-semibold tabular text-ink">{h.currency ? fmtMoney(gross, h.currency) : fmtDecimal(gross, 2)}</span>
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} disabled={!valid} loading={busy}>
            <Receipt className="h-4 w-4" aria-hidden /> Enregistrer
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <SupplierSelect
          value={supplierId}
          onChange={(id) => {
            setSupplierId(id);
            setSelected([]);
          }}
          required
        />
        {supplierId && (
          <div>
            <p className="field-label">Bons de commande facturés</p>
            {orders.isLoading ? (
              <LoadingBlock rows={2} />
            ) : list.length ? (
              <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-line p-1">
                {list.map((p) => {
                  const active = selected.includes(p.id);
                  const otherVessel = !!vesselId && p.vesselId !== vesselId && !active;
                  return (
                    <li key={p.id}>
                      <label className={cn('flex cursor-pointer flex-wrap items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-navy-50', otherVessel && 'cursor-not-allowed opacity-50')}>
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={active}
                          disabled={otherVessel}
                          onChange={() => setSelected((prev) => (active ? prev.filter((x) => x !== p.id) : [...prev, p.id]))}
                        />
                        <span className="font-medium">{p.number}</span>
                        <span className="text-ink-muted">{p.vessel.name}</span>
                        <Money value={p.totalAmount} currency={p.currency} />
                        <PoStatusBadge status={p.status} />
                        {multi && active && (
                          <span className="ml-auto w-32">
                            <DecimalInput value={imputed[p.id] ?? ''} onChange={(v) => setImputed((x) => ({ ...x, [p.id]: v }))} placeholder="Montant imputé" className="h-7 text-xs" ariaLabel={`Montant imputé ${p.number}`} />
                          </span>
                        )}
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-sm text-ink-muted">Aucun BC approuvé ou transmis pour ce fournisseur.</p>
            )}
            <p className="mt-1 text-xs text-ink-muted">Une facture se rattache à des BC d’un même navire ; montant imputé obligatoire par BC s’il y en a plusieurs (somme = TTC).</p>
            {errors.imputed && <p className="mt-1 text-xs text-danger">{errors.imputed}</p>}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="N° de facture" required>
            <Input value={h.number} onChange={(e) => setH((x) => ({ ...x, number: e.target.value }))} maxLength={80} />
          </FormField>
          <FormField label="Date de facture" required>
            <Input type="date" value={h.invoiceDate} onChange={(e) => setH((x) => ({ ...x, invoiceDate: e.target.value }))} />
          </FormField>
          <FormField label="Échéance">
            <Input type="date" value={h.dueDate} onChange={(e) => setH((x) => ({ ...x, dueDate: e.target.value }))} />
          </FormField>
          <FormField label="Devise" required hint={currencyMismatch ? 'Différente de la devise d’un BC : le rapprochement le signalera.' : undefined}>
            <CurrencyInput value={h.currency} onChange={(v) => setH((x) => ({ ...x, currency: v }))} />
          </FormField>
          <FormField label="Montant HT" required error={h.amount ? errors.amount ?? undefined : undefined}>
            <DecimalInput value={h.amount} onChange={(v) => setH((x) => ({ ...x, amount: v }))} placeholder="0,00" />
          </FormField>
          <FormField label="Taxes" error={errors.tax ?? undefined}>
            <DecimalInput value={h.taxAmount} onChange={(v) => setH((x) => ({ ...x, taxAmount: v }))} placeholder="0,00" />
          </FormField>
        </div>
        <FormField label="Facture originale" hint="PDF ou scan reçu du fournisseur.">
          <FileUploader context="PURCHASING" vesselId={vesselId} onUploaded={setFile} label="Déposer la facture" disabled={!vesselId} />
        </FormField>
        {!vesselId && <p className="-mt-2 text-xs text-ink-muted">Sélectionnez d’abord un BC (le fichier est rattaché au navire).</p>}
        <FormField label="Notes de revue">
          <Textarea rows={2} value={h.reviewNotes} onChange={(e) => setH((x) => ({ ...x, reviewNotes: e.target.value }))} maxLength={5000} />
        </FormField>
        <Callout tone="info" title="Une facture ne clôt jamais un BC partiellement reçu">
          Le statut de réception d’un BC dépend uniquement des quantités acceptées à bord (PUR-07).
        </Callout>
        {error && <Callout tone="danger" title="Facture refusée">{error}</Callout>}
      </div>
    </Dialog>
  );
}
