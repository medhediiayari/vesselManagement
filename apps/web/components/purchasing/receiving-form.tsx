'use client';

import { useQuery } from '@tanstack/react-query';
import { ClipboardCheck, ClipboardCopy, FileCheck2, KeyRound, RotateCcw, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, type StoredFileDto } from '@/lib/api';
import { cn, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import {
  CONDITION_LABELS,
  DN_STATUS_LABELS,
  VARIANCE_TYPE_LABELS,
  VARIANCE_TYPE_TONES,
  commandError,
  dec,
  decimalError,
  isPoReceivable,
  newIdempotencyKey,
  purKeys,
  toApiDecimal,
  useCommand,
} from './lib';
import type { ItemCondition, PoDetail, ReceiptDetail } from './types';
import { Callout, DecimalInput, FormField, PoStatusBadge, StatusPill } from './ui';

interface RowInput {
  received: string;
  rejected: string;
  condition: ItemCondition;
  remarks: string;
}

const emptyRow = (): RowInput => ({ received: '', rejected: '', condition: 'GOOD', remarks: '' });

function nowLocal(): string {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/**
 * Écran de réception à bord (CDC V1 §9.2) : côte à côte BC | BL | quantité réellement reçue, état, remarques,
 * preuves. POST /receipts avec en-tête Idempotency-Key généré une fois par formulaire et conservé entre les
 * tentatives : un double clic ou un rejeu réseau ne compte jamais deux fois (PUR-05).
 */
export function ReceivingForm({ poId, initialDeliveryNoteId }: { poId: string; initialDeliveryNoteId?: string }) {
  const { me } = useSession();
  const run = useCommand();
  const po = useQuery({ queryKey: purKeys.order(poId), queryFn: () => api.get<PoDetail>(`/orders/${poId}`) });
  const [noteId, setNoteId] = useState(initialDeliveryNoteId ?? '');
  const [rows, setRows] = useState<Record<string, RowInput>>({});
  const [receivedAt, setReceivedAt] = useState(nowLocal());
  const [responsible, setResponsible] = useState(me.displayName);
  const [notes, setNotes] = useState('');
  const [evidence, setEvidence] = useState<StoredFileDto[]>([]);
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [result, setResult] = useState<ReceiptDetail | null>(null);
  const [showErrors, setShowErrors] = useState(false);

  useEffect(() => {
    if (initialDeliveryNoteId) setNoteId(initialDeliveryNoteId);
  }, [initialDeliveryNoteId]);

  const data = po.data;
  const lines = useMemo(() => (data?.lines ?? []).filter((l) => l.status !== 'CANCELLED'), [data]);
  const notesList = (data?.deliveryNotes ?? []).filter((d) => d.status !== 'CANCELLED');
  const note = notesList.find((d) => d.id === noteId);
  const noteQty = (poLineId: string) => note?.lines.find((l) => l.poLineId === poLineId);

  if (po.isLoading) return <LoadingBlock rows={6} />;
  if (po.error || !data) return <ErrorState error={po.error} onRetry={() => po.refetch()} />;
  if (!isPoReceivable(data)) {
    return (
      <Callout tone="warn" title={`BC ${data.number} non réceptionnable`}>
        Seuls les BC transmis au fournisseur (envoyés, partiellement reçus) peuvent faire l’objet d’une réception. Statut actuel : <PoStatusBadge status={data.status} />
      </Callout>
    );
  }

  const row = (id: string) => rows[id] ?? emptyRow();
  const patch = (id: string, p: Partial<RowInput>) => setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? emptyRow()), ...p } }));

  const lineErrors = lines.map((l) => {
    const r = row(l.id);
    const onNote = noteQty(l.id);
    if (!r.received.trim()) return onNote ? 'Quantité reçue obligatoire pour une ligne du BL (0 si absente à bord)' : null;
    const e = decimalError(r.received, { required: true, scale: 3 }) ?? decimalError(r.rejected, { scale: 3 });
    if (e) return e;
    if (dec.cmp(toApiDecimal(r.rejected || '0'), toApiDecimal(r.received)) > 0) return 'Rejeté > reçu';
    return null;
  });
  const included = lines.filter((l) => row(l.id).received.trim());
  const valid = included.length > 0 && lineErrors.every((e) => !e) && evidence.length <= 20;

  const accepted = (id: string) => dec.max0(dec.sub(toApiDecimal(row(id).received || '0'), toApiDecimal(row(id).rejected || '0')));

  const body = () => ({
    poId,
    deliveryNoteId: noteId || null,
    receivedAt: receivedAt ? new Date(receivedAt).toISOString() : undefined,
    responsibleName: responsible.trim() || null,
    notes: notes.trim() || null,
    evidenceFileIds: evidence.map((f) => f.id),
    lines: included.map((l) => {
      const r = row(l.id);
      return {
        poLineId: l.id,
        deliveryNoteLineId: noteQty(l.id)?.id ?? null,
        qtyReceived: toApiDecimal(r.received),
        qtyAccepted: accepted(l.id),
        qtyRejected: toApiDecimal(r.rejected || '0'),
        condition: r.condition,
        remarks: r.remarks.trim() || null,
      };
    }),
  });

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Même clé à chaque tentative de CETTE réception : un rejeu renvoie la réception d'origine (200, replay)
      const res = await run(() => api.post<ReceiptDetail>('/receipts', body(), { headers: { 'Idempotency-Key': idemKey } }));
      setResult(res);
      setConfirmOpen(false);
    } catch (e) {
      const conflict = e instanceof ApiError && e.code === 'IDEMPOTENCY_CONFLICT';
      setError({ message: commandError(e), conflict });
      setConfirmOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    setRows({});
    setNotes('');
    setEvidence([]);
    setResult(null);
    setError(null);
    setShowErrors(false);
    setReceivedAt(nowLocal());
    setIdemKey(newIdempotencyKey());
  };

  if (result) {
    return (
      <Panel title={`Réception ${result.number} enregistrée`}>
        <div className="space-y-3">
          {result.replay ? (
            <Callout tone="info" title="Réception déjà enregistrée">
              Cette soumission avait déjà été reçue par le serveur : la réception d’origine est renvoyée, sans double comptabilisation des quantités.
            </Callout>
          ) : (
            <Callout tone="info" title="Quantités physiquement reçues enregistrées">
              Statut « À valider » : une personne habilitée (receiving.validate) valide le rapport de réception.
            </Callout>
          )}
          {result.variances.length > 0 ? (
            <div>
              <p className="mb-1 text-sm font-medium">Écarts signalés</p>
              <ul className="space-y-1">
                {result.variances.map((v) => (
                  <li key={v.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <StatusPill status={v.type} labels={VARIANCE_TYPE_LABELS} tones={VARIANCE_TYPE_TONES} />
                    <span className="tabular">{fmtDecimal(v.quantity)}</span>
                    <span className="text-ink-muted">{v.description}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-ink-muted">Aucun écart propre à cette réception (les manquants cumulés restent visibles au rapprochement du BC).</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Link href={`/purchasing/deliveries/receipts/${result.id}`} className="inline-flex h-9 items-center gap-2 rounded-md bg-action px-4 text-base font-medium text-white hover:bg-action-700">
              <FileCheck2 className="h-4 w-4" aria-hidden /> Voir la réception
            </Link>
            <Link href={`/purchasing/orders/${poId}?tab=reconciliation`} className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-white px-4 text-base font-medium hover:bg-canvas">
              Rapprochement du BC
            </Link>
            <Button variant="ghost" onClick={reset}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Nouvelle réception
            </Button>
          </div>
        </div>
      </Panel>
    );
  }

  const thGroup = 'border-b border-line px-2 py-1.5 text-center text-xs font-semibold';
  const th = 'border-b border-line px-2 py-1.5 text-xs font-semibold text-ink-muted';

  return (
    <div className="space-y-4">
      <Panel>
        <div className="grid gap-3 md:grid-cols-4">
          <FormField label="Bon de commande">
            <p className="flex h-9 items-center gap-2 text-sm">
              <Link href={`/purchasing/orders/${data.id}`} className="font-medium text-action hover:underline">
                {data.number}
              </Link>
              <PoStatusBadge status={data.status} />
            </p>
            <p className="text-xs text-ink-muted">
              {data.supplier.name} — {data.vessel.name}
            </p>
          </FormField>
          <FormField label="Bon de livraison (BL)" hint="Le BL n’est pas une preuve de réception : saisissez ce qui est physiquement à bord.">
            <Select value={noteId} onChange={(e) => setNoteId(e.target.value)}>
              <option value="">Sans BL (réception sans document fournisseur)</option>
              {notesList.map((d) => (
                <option key={d.id} value={d.id}>
                  BL {d.number} — {DN_STATUS_LABELS[d.status]}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Reçu le">
            <Input type="datetime-local" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} />
          </FormField>
          <FormField label="Responsable de la réception">
            <Input value={responsible} onChange={(e) => setResponsible(e.target.value)} maxLength={200} />
          </FormField>
        </div>
      </Panel>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">Saisissez la quantité réellement comptée à bord et la quantité rejetée ; l’acceptée est calculée (reçu − rejeté).</p>
        {note && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              for (const l of note.lines) if (!row(l.poLineId).received.trim()) patch(l.poLineId, { received: l.quantityOnNote });
            }}
          >
            <ClipboardCopy className="h-4 w-4" aria-hidden /> Reprendre les quantités du BL (à vérifier physiquement)
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg bg-white shadow-panel">
        <table className="w-full border-separate border-spacing-0 text-sm">
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={cn(th, 'bg-surface-sunken text-left')}>
                Ligne
              </th>
              <th scope="colgroup" colSpan={3} className={cn(thGroup, 'bg-action-50 text-action')}>
                BC (commandé)
              </th>
              <th scope="colgroup" colSpan={1} className={cn(thGroup, 'bg-teal-50 text-teal-700')}>
                BL
              </th>
              <th scope="colgroup" colSpan={5} className={cn(thGroup, 'bg-ok-bg text-ok')}>
                Physiquement reçu à bord
              </th>
            </tr>
            <tr className="bg-surface-sunken">
              <th scope="col" className={cn(th, 'text-right')}>
                Commandé
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                Déjà accepté
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                Reste
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                Qté BL
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                Reçu *
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                Rejeté
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                Accepté
              </th>
              <th scope="col" className={cn(th, 'text-left')}>
                État
              </th>
              <th scope="col" className={cn(th, 'text-left')}>
                Remarques
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => {
              const r = row(l.id);
              const bl = noteQty(l.id);
              const effective = dec.sub(l.quantityOrdered, l.quantityCancelled);
              const err = showErrors || r.received.trim() ? lineErrors[i] : null;
              const diffBl = bl && r.received.trim() && !lineErrors[i] ? dec.sub(bl.quantityOnNote, toApiDecimal(r.received)) : null;
              return (
                <tr key={l.id} className="align-top">
                  <td className="border-b border-line px-2 py-2">
                    <span className="text-xs tabular text-ink-muted">{l.lineNo}. </span>
                    <span className="font-medium">{l.designation}</span>
                    {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                    {err && <span className="block text-xs text-danger">{err}</span>}
                  </td>
                  <td className="border-b border-line bg-action-50/30 px-2 py-2 text-right tabular">
                    {fmtDecimal(effective)} <span className="text-xs text-ink-muted">{l.unit}</span>
                  </td>
                  <td className="border-b border-line bg-action-50/30 px-2 py-2 text-right tabular">{fmtDecimal(l.balance?.accepted ?? '0')}</td>
                  <td className={cn('border-b border-line bg-action-50/30 px-2 py-2 text-right tabular', dec.gt0(l.balance?.remaining) ? 'font-medium text-warn' : 'text-ink-muted')}>
                    {fmtDecimal(l.balance?.remaining ?? '0')}
                  </td>
                  <td className="border-b border-line bg-teal-50/40 px-2 py-2 text-right tabular">
                    {bl ? fmtDecimal(bl.quantityOnNote) : <span className="text-xs text-ink-muted">{note ? 'absent du BL' : '—'}</span>}
                    {diffBl && dec.gt0(diffBl) && <span className="block text-[11px] text-danger">manque à bord {fmtDecimal(diffBl)}</span>}
                    {diffBl && dec.cmp(diffBl, '0') < 0 && <span className="block text-[11px] text-info">reçu au-delà du BL {fmtDecimal(dec.sub('0', diffBl))}</span>}
                  </td>
                  <td className="w-24 border-b border-line bg-ok-bg/30 px-2 py-2">
                    <DecimalInput value={r.received} onChange={(v) => patch(l.id, { received: v })} invalid={!!err} className="h-8" ariaLabel={`Quantité reçue ligne ${l.lineNo}`} placeholder={bl ? '' : '—'} />
                  </td>
                  <td className="w-24 border-b border-line bg-ok-bg/30 px-2 py-2">
                    <DecimalInput value={r.rejected} onChange={(v) => patch(l.id, { rejected: v })} className="h-8" ariaLabel={`Quantité rejetée ligne ${l.lineNo}`} placeholder="0" />
                  </td>
                  <td className="border-b border-line bg-ok-bg/30 px-2 py-2 text-right font-semibold tabular text-ok">{r.received.trim() && !lineErrors[i] ? fmtDecimal(accepted(l.id)) : '—'}</td>
                  <td className="border-b border-line bg-ok-bg/30 px-2 py-2">
                    <Select value={r.condition} onChange={(e) => patch(l.id, { condition: e.target.value as ItemCondition })} className="h-8 w-36 text-sm" aria-label={`État ligne ${l.lineNo}`}>
                      {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="min-w-[160px] border-b border-line bg-ok-bg/30 px-2 py-2">
                    <Input value={r.remarks} onChange={(e) => patch(l.id, { remarks: e.target.value })} className="h-8 text-sm" aria-label={`Remarques ligne ${l.lineNo}`} maxLength={1000} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title={`Preuves (${evidence.length})`}>
          <FileUploader context="PURCHASING" vesselId={data.vesselId} multiple label="Photos, PV de réception, BL annoté…" onUploaded={(f) => setEvidence((p) => [...p, f])} />
          {evidence.length > 0 && (
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {evidence.map((f) => (
                <li key={f.id}>
                  <Badge tone="navy" icon={false}>
                    {f.originalName}
                    <button type="button" className="ml-1 text-ink-muted hover:text-danger" aria-label={`Retirer ${f.originalName}`} onClick={() => setEvidence((p) => p.filter((x) => x.id !== f.id))}>
                      ×
                    </button>
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Observations">
          <Textarea rows={4} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} placeholder="Conditions de livraison, colis endommagés, réserves émises…" aria-label="Observations" />
        </Panel>
      </div>

      {error && (
        <Callout tone="danger" title={error.conflict ? 'Cette soumission a déjà été utilisée avec un contenu différent' : 'Réception refusée'}>
          <p>{error.message}</p>
          {error.conflict ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Link href={`/purchasing/orders/${poId}?tab=deliveries`} className="font-medium text-action hover:underline">
                Vérifier les réceptions du BC
              </Link>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setIdemKey(newIdempotencyKey());
                  setError(null);
                }}
              >
                Il s’agit d’une nouvelle réception (nouvelle clé)
              </Button>
            </div>
          ) : (
            <p className="mt-1 text-xs">Vous pouvez corriger puis renvoyer : la même clé de soumission est conservée, sans risque de double comptage.</p>
          )}
        </Callout>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs text-ink-muted" title={idemKey}>
          <KeyRound className="h-3.5 w-3.5" aria-hidden /> Clé de soumission {idemKey.slice(0, 8)}… — conservée en cas de nouvelle tentative (aucun double comptage).
        </p>
        <Button
          onClick={() => {
            setShowErrors(true);
            if (valid) setConfirmOpen(true);
          }}
        >
          <ClipboardCheck className="h-4 w-4" aria-hidden /> Vérifier et enregistrer
        </Button>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        size="lg"
        title="Confirmer la réception"
        description={`${included.length} ligne(s) — ${note ? `BL ${note.number}` : 'sans BL'} — ${evidence.length} preuve(s).`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Corriger
            </Button>
            <Button onClick={submit} loading={busy}>
              <ShieldCheck className="h-4 w-4" aria-hidden /> Confirmer la réception
            </Button>
          </>
        }
      >
        <table className="table-amc">
          <thead>
            <tr>
              <th scope="col">Ligne</th>
              <th scope="col" className="text-right">
                BL
              </th>
              <th scope="col" className="text-right">
                Reçu
              </th>
              <th scope="col" className="text-right">
                Accepté
              </th>
              <th scope="col" className="text-right">
                Rejeté
              </th>
              <th scope="col">État</th>
            </tr>
          </thead>
          <tbody>
            {included.map((l) => {
              const r = row(l.id);
              const bl = noteQty(l.id);
              const short = bl && dec.cmp(toApiDecimal(r.received), bl.quantityOnNote) < 0;
              return (
                <tr key={l.id} className={short || dec.gt0(toApiDecimal(r.rejected || '0')) || r.condition !== 'GOOD' ? 'bg-warn-bg/40' : ''}>
                  <td>
                    {l.lineNo}. {l.designation}
                  </td>
                  <td className="text-right tabular">{bl ? fmtDecimal(bl.quantityOnNote) : '—'}</td>
                  <td className="text-right tabular">
                    {fmtDecimal(toApiDecimal(r.received))} {l.unit}
                  </td>
                  <td className="text-right font-semibold tabular text-ok">{fmtDecimal(accepted(l.id))}</td>
                  <td className="text-right tabular">{fmtDecimal(toApiDecimal(r.rejected || '0'))}</td>
                  <td>{CONDITION_LABELS[r.condition]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <ul className="mt-3 space-y-1 text-sm text-ink-muted">
          {included.some((l) => noteQty(l.id) && dec.cmp(toApiDecimal(row(l.id).received), noteQty(l.id)!.quantityOnNote) < 0) && (
            <li>• Reçu inférieur au BL : un écart « manquant à bord » sera signalé séparément d’un manquant au BL.</li>
          )}
          {included.some((l) => dec.gt0(toApiDecimal(row(l.id).rejected || '0')) || row(l.id).condition !== 'GOOD') && !evidence.length && (
            <li className="text-warn">• Rejet ou avarie sans preuve jointe : ajoutez une photo si possible.</li>
          )}
          <li>• Seule la quantité acceptée solde le reliquat du BC.</li>
        </ul>
      </Dialog>
    </div>
  );
}
