'use client';

import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, Truck } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, type Page, type StoredFileDto } from '@/lib/api';
import { cn, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { LoadingBlock } from '@/components/ui/states';
import { VARIANCE_TYPE_LABELS, commandError, dec, decimalError, isPoReceivable, purKeys, toApiDecimal, todayInput, useCommand } from './lib';
import type { DeliveryNote, PoDetail, PoListItem, VarianceType } from './types';
import { Callout, DecimalInput, FormField } from './ui';

interface CreatedNote extends DeliveryNote {
  variances?: { created?: { type: VarianceType; quantity: string; poLineId: string }[] };
}

/** Sélection d'un BC réceptionnable (envoyé / partiellement reçu / reçu) dans le périmètre navire. */
export function ReceivablePoSelect({ value, onChange, label = 'Bon de commande', vesselId }: { value: string; onChange: (id: string) => void; label?: string; vesselId?: string }) {
  const q = useQuery({
    queryKey: [...purKeys.orders, 'receivable', vesselId ?? 'all'],
    queryFn: () => api.get<Page<PoListItem>>('/orders', { query: { status: 'SENT,PARTIALLY_RECEIVED,RECEIVED,APPROVAL_PENDING,APPROVED', vesselId, limit: 100 } }),
  });
  // Un BC déjà transmis puis repassé en approbation (avenant) reste réceptionnable
  const items = (q.data?.items ?? []).filter((p) => isPoReceivable(p));
  return (
    <FormField label={label} required hint="BC émis, en attente de livraison ou partiellement reçu.">
      <Select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{q.isLoading ? 'Chargement…' : '— Choisir —'}</option>
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.number} — {p.supplier.name} — {p.vessel.name}
          </option>
        ))}
      </Select>
    </FormField>
  );
}

/**
 * Enregistrement d'un BL (bon de livraison) : ce que le fournisseur DÉCLARE livrer. Ce n'est jamais une
 * preuve de réception physique — la réception à bord se saisit séparément.
 */
export function DeliveryNoteDialog({ open, onOpenChange, poId: initialPoId }: { open: boolean; onOpenChange: (o: boolean) => void; poId?: string }) {
  const router = useRouter();
  const run = useCommand();
  const { selectedVesselIds } = useSession();
  const [poId, setPoId] = useState(initialPoId ?? '');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(todayInput());
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedNote | null>(null);

  useEffect(() => {
    if (open) {
      setPoId(initialPoId ?? '');
      setNumber('');
      setDate(todayInput());
      setNotes('');
      setFile(null);
      setQty({});
      setError(null);
      setCreated(null);
    }
  }, [open, initialPoId]);

  const po = useQuery({ queryKey: purKeys.order(poId), queryFn: () => api.get<PoDetail>(`/orders/${poId}`), enabled: open && !!poId });
  const lines = (po.data?.lines ?? []).filter((l) => l.status !== 'CANCELLED');
  const filled = lines.filter((l) => (qty[l.id] ?? '').trim());
  const errors = lines.map((l) => ((qty[l.id] ?? '').trim() ? decimalError(qty[l.id], { scale: 3 }) : null));
  const canSubmit = !!poId && number.trim().length > 0 && !!date && filled.length > 0 && errors.every((e) => !e);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const dn = await run(
        () =>
          api.post<CreatedNote>('/delivery-notes', {
            poId,
            number: number.trim(),
            deliveryDate: date,
            fileId: file?.id ?? null,
            notes: notes.trim() || null,
            lines: filled.map((l) => ({ poLineId: l.id, quantityOnNote: toApiDecimal(qty[l.id]) })),
          }),
        (d) => `BL ${d.number} enregistré`,
      );
      setCreated(dn);
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  const lineById = new Map(lines.map((l) => [l.id, l]));

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={created ? `BL ${created.number} enregistré` : 'Enregistrer un bon de livraison (BL)'}
      description={created ? undefined : 'Saisissez les quantités telles qu’indiquées sur le BL du fournisseur. La réception physique (reçu / accepté / rejeté) se fait ensuite, séparément.'}
      footer={
        created ? (
          <>
            <Button variant="secondary" onClick={() => router.push(`/purchasing/deliveries/notes/${created.id}`)}>
              Voir le BL
            </Button>
            <Button onClick={() => router.push(`/purchasing/deliveries/receive?poId=${created.poId}&deliveryNoteId=${created.id}`)}>
              <ClipboardCheck className="h-4 w-4" aria-hidden /> Réceptionner maintenant
            </Button>
          </>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Annuler
            </Button>
            <Button onClick={submit} disabled={!canSubmit} loading={busy}>
              <Truck className="h-4 w-4" aria-hidden /> Enregistrer le BL
            </Button>
          </>
        )
      }
    >
      {created ? (
        <div className="space-y-3">
          {created.variances?.created?.length ? (
            <Callout tone="warn" title="Écart(s) détecté(s) entre BC et BL">
              <ul className="list-inside list-disc">
                {created.variances.created.map((v, i) => (
                  <li key={i}>
                    {VARIANCE_TYPE_LABELS[v.type] ?? v.type} : {fmtDecimal(v.quantity)} {lineById.get(v.poLineId)?.unit ?? ''} — ligne {lineById.get(v.poLineId)?.lineNo ?? '?'}{' '}
                    {lineById.get(v.poLineId)?.designation ?? ''}
                  </li>
                ))}
              </ul>
            </Callout>
          ) : (
            <Callout tone="info" title="Aucun écart BC / BL détecté à ce stade">
              Les écarts entre BL et réception physique seront calculés lors de la réception à bord.
            </Callout>
          )}
          <p className="text-sm text-ink-muted">Rappel : le BL n’est pas une preuve de réception. Réceptionnez la marchandise à bord pour solder les quantités.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {!initialPoId && <ReceivablePoSelect value={poId} onChange={setPoId} vesselId={selectedVesselIds.length === 1 ? selectedVesselIds[0] : undefined} />}
          {po.isLoading && <LoadingBlock rows={3} />}
          {po.data && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <FormField label="N° du BL" required hint={`Unique par fournisseur (${po.data.supplier.name})`}>
                  <Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={80} />
                </FormField>
                <FormField label="Date de livraison" required>
                  <Input type="date" value={date} max={todayInput()} onChange={(e) => setDate(e.target.value)} />
                </FormField>
              </div>
              <div className="overflow-x-auto rounded-md border border-line">
                <table className="table-amc">
                  <thead>
                    <tr>
                      <th scope="col">Ligne BC</th>
                      <th scope="col" className="text-right">
                        Commandé (BC)
                      </th>
                      <th scope="col" className="text-right">
                        Déjà sur BL
                      </th>
                      <th scope="col" className="text-right">
                        Qté sur ce BL
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => {
                      const effective = dec.sub(l.quantityOrdered, l.quantityCancelled);
                      return (
                        <tr key={l.id}>
                          <td>
                            {l.lineNo}. {l.designation}
                            {errors[i] && <span className="block text-xs text-danger">{errors[i]}</span>}
                          </td>
                          <td className="text-right tabular">
                            {fmtDecimal(effective)} {l.unit}
                          </td>
                          <td className={cn('text-right tabular', dec.gt0(l.balance?.onDeliveryNotes) ? '' : 'text-ink-muted')}>{fmtDecimal(l.balance?.onDeliveryNotes ?? '0')}</td>
                          <td className="w-32">
                            <DecimalInput value={qty[l.id] ?? ''} onChange={(v) => setQty((p) => ({ ...p, [l.id]: v }))} className="h-8" ariaLabel={`Quantité sur le BL ligne ${l.lineNo}`} placeholder="—" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-ink-muted">Laissez vide une ligne absente du BL ; saisissez 0 si le BL la mentionne sans quantité.</p>
              <FormField label="Scan du BL" hint="PDF ou photo du document fournisseur.">
                <FileUploader context="PURCHASING" vesselId={po.data.vesselId} onUploaded={setFile} label="Déposer le scan du BL" />
              </FormField>
              <FormField label="Notes">
                <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
              </FormField>
            </>
          )}
          {error && <Callout tone="danger" title="BL refusé">{error}</Callout>}
        </div>
      )}
    </Dialog>
  );
}
