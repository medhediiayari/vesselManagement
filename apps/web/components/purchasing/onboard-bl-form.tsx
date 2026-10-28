'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCheck, CheckCircle2, FileUp, ListChecks, PackagePlus, Send, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, type ReactNode } from 'react';
import { api, type StoredFileDto } from '@/lib/api';
import { cn, fmtDate, fmtDecimal } from '@/lib/format';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { COMMON_UNITS, commandError, dec, decimalError, isPoReceivable, newIdempotencyKey, purKeys, toApiDecimal, todayInput, useCommand } from './lib';
import type { OnboardDeliveryResult, PoDetail } from './types';
import { Callout, DecimalInput, FormField, PoStatusBadge } from './ui';

type Mode = 'lines' | 'file';

interface Row {
  checked: boolean;
  quantity: string;
  remarks: string;
}

interface Extra {
  key: string;
  designation: string;
  reference: string;
  quantity: string;
  unit: string;
  remarks: string;
}

/**
 * Réponse du bord à un BC émis : BL et réception en une seule étape (refonte du 22/10/2026).
 *  - « Saisir les quantités » : cocher les articles reçus (quantité préremplie = reste à recevoir), corriger les
 *    écarts, noter les articles reçus hors BC ;
 *  - « Joindre le BL » : déposer le BL (PDF, Excel, photo), puis répondre à « Le BL correspond-il exactement au
 *    BC ? » — oui : tout est déclaré reçu ; non : saisie des différences.
 * Tout écart de quantité alerte les Achats ; un article hors BC est simplement noté. Idempotency-Key conservée
 * entre les tentatives : un renvoi ne compte jamais deux fois.
 */
export function OnboardBlForm({ poId }: { poId: string }) {
  const run = useCommand();
  const router = useRouter();
  const q = useQuery({ queryKey: purKeys.order(poId), queryFn: () => api.get<PoDetail>(`/orders/${poId}`) });
  const [mode, setMode] = useState<Mode>('lines');
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [extras, setExtras] = useState<Extra[]>([]);
  const [files, setFiles] = useState<StoredFileDto[]>([]);
  const [number, setNumber] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(todayInput());
  const [notes, setNotes] = useState('');
  const [askConform, setAskConform] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [idemKey, setIdemKey] = useState(() => newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<OnboardDeliveryResult | null>(null);

  const po = q.data;
  const lines = useMemo(() => (po?.lines ?? []).filter((l) => l.status !== 'CANCELLED'), [po]);
  const remainingOf = (id: string) => lines.find((l) => l.id === id)?.balance?.remaining ?? '0';
  const row = (id: string): Row => rows[id] ?? { checked: false, quantity: '', remarks: '' };
  const patch = (id: string, p: Partial<Row>) => setRows((prev) => ({ ...prev, [id]: { ...row(id), ...p } }));

  if (q.isLoading) return <LoadingBlock rows={6} />;
  if (q.error || !po) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!isPoReceivable(po)) {
    return (
      <Callout tone="warn" title={`BC ${po.number} : pas de livraison attendue`}>
        Un BL ne peut être saisi que sur un BC émis non clôturé. Statut actuel : <PoStatusBadge status={po.status} />
      </Callout>
    );
  }

  const fillAll = () => setRows(Object.fromEntries(lines.map((l) => [l.id, { ...row(l.id), checked: true, quantity: dec.max0(l.balance?.remaining ?? '0') }])));
  const checkedLines = lines.filter((l) => row(l.id).checked);
  const lineErrors = Object.fromEntries(checkedLines.map((l) => [l.id, decimalError(row(l.id).quantity, { required: true, scale: 3 })]));
  const extraErrors = extras.map((x) => (!x.designation.trim() ? 'Désignation obligatoire' : !x.unit.trim() ? 'Unité obligatoire' : decimalError(x.quantity, { required: true, positive: true, scale: 3 })));
  const received = checkedLines.filter((l) => !lineErrors[l.id] && dec.gt0(toApiDecimal(row(l.id).quantity)));
  // Aperçu des écarts (le serveur refait la comparaison sur le cumul du BC)
  const preview = lines.map((l) => {
    const rem = dec.max0(l.balance?.remaining ?? '0');
    const qty = row(l.id).checked ? toApiDecimal(row(l.id).quantity || '0') : '0';
    const c = dec.cmp(qty, rem);
    return { line: l, rem, qty, missing: c < 0 ? dec.sub(rem, qty) : '0', surplus: c > 0 ? dec.sub(qty, rem) : '0' };
  });
  const gaps = preview.filter((p) => dec.gt0(p.missing) || dec.gt0(p.surplus));
  const linesValid = Object.values(lineErrors).every((e) => !e) && extraErrors.every((e) => !e) && (received.length > 0 || extras.length > 0);
  const fileValid = files.length > 0;

  const send = async (allReceived: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const res = await run(
        () =>
          api.post<OnboardDeliveryResult>(
            '/delivery-notes/onboard',
            {
              poId,
              number: number.trim() || undefined,
              deliveryDate: deliveryDate || undefined,
              allReceived,
              lines: allReceived
                ? []
                : checkedLines.map((l) => ({ poLineId: l.id, quantity: toApiDecimal(row(l.id).quantity || '0'), remarks: row(l.id).remarks.trim() || undefined })),
              extraItems: allReceived
                ? []
                : extras.map((x) => ({ designation: x.designation.trim(), reference: x.reference.trim() || undefined, quantity: toApiDecimal(x.quantity), unit: x.unit.trim(), remarks: x.remarks.trim() || undefined })),
              fileIds: files.map((f) => f.id),
              notes: notes.trim() || undefined,
            },
            { headers: { 'Idempotency-Key': idemKey } },
          ),
        (r) => (r.discrepancies.length ? `BL ${r.deliveryNote.number} enregistré : les Achats sont alertés de l’écart` : `BL ${r.deliveryNote.number} enregistré : conforme au BC`),
      );
      setResult(res);
      setAskConform(false);
      setConfirmOpen(false);
      setIdemKey(newIdempotencyKey());
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const closed = result.order.status === 'CLOSED';
    return (
      <Panel title={`BL ${result.deliveryNote.number} enregistré`}>
        {result.discrepancies.length ? (
          <Callout tone="warn" title="Écart signalé aux Achats">
            Les Achats ont reçu une alerte et décideront : attendre le reliquat ou corriger auprès du fournisseur. À la prochaine livraison, envoyez un nouveau BL sur ce BC.
          </Callout>
        ) : (
          <Callout tone="info" title={closed ? 'Conforme — BC clôturé' : 'Conforme au BC'}>
            {closed ? 'Tout ce qui figure sur le BC a été reçu : le BC (et la PR si tout est reçu) est clôturé automatiquement.' : 'Les quantités reçues correspondent au BC.'}
          </Callout>
        )}
        {result.discrepancies.length > 0 && <GapTable rows={result.discrepancies.map((d) => ({ key: d.poLineId, designation: d.designation, unit: d.unit, ordered: d.ordered, received: d.received, missing: d.missing, surplus: d.surplus, remarks: d.remarks }))} />}
        {result.deliveryNote.extraItems.length > 0 && (
          <p className="mt-3 text-sm text-ink-muted">
            Articles hors BC notés : {result.deliveryNote.extraItems.map((x) => `${x.designation} (${fmtDecimal(x.quantity)} ${x.unit})`).join(', ')}.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => router.push(`/purchasing/orders/${poId}`)}>
            Retour au BC {po.number}
          </Button>
          <Button variant="ghost" onClick={() => router.push(`/purchasing/deliveries/notes/${result.deliveryNote.id}`)}>
            Voir le BL
          </Button>
          {!closed && (
            <Button
              variant="ghost"
              onClick={() => {
                setResult(null);
                setRows({});
                setExtras([]);
                setFiles([]);
                setNumber('');
                setNotes('');
                void q.refetch();
              }}
            >
              Saisir un autre BL
            </Button>
          )}
        </div>
      </Panel>
    );
  }

  return (
    <div className="space-y-4">
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm text-ink-muted">Réponse au bon de commande</p>
            <p className="text-md font-semibold text-navy">
              BC <span className="ref">{po.number}</span> — {po.supplier.name}
            </p>
            <p className="text-sm text-ink-muted">
              {po.vessel.name} · livraison prévue {po.expectedDeliveryDate ? fmtDate(po.expectedDeliveryDate) : 'à confirmer'}
              {po.deliveryPort ? ` · ${po.deliveryPort}` : ''}
            </p>
          </div>
          <PoStatusBadge status={po.status} />
        </div>
        <div role="tablist" aria-label="Mode de saisie du BL" className="mt-4 grid gap-2 sm:grid-cols-2">
          <ModeButton active={mode === 'lines'} onClick={() => setMode('lines')} icon={<ListChecks className="h-5 w-5" aria-hidden />} title="Saisir les quantités reçues" text="Cochez les articles reçus ; seuls les écarts sont à corriger." />
          <ModeButton active={mode === 'file'} onClick={() => setMode('file')} icon={<FileUp className="h-5 w-5" aria-hidden />} title="Joindre le BL (fichier)" text="PDF, Excel ou photo du BL ; une question confirme s’il est conforme." />
        </div>
      </Panel>

      <Panel>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <FormField label="N° du BL fournisseur" hint="Facultatif : une référence est attribuée sinon.">
            <Input value={number} onChange={(e) => setNumber(e.target.value)} maxLength={80} />
          </FormField>
          <FormField label="Date de livraison">
            <Input type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} max={todayInput()} />
          </FormField>
          <FormField label="Remarque générale" className="sm:col-span-2 lg:col-span-1" hint="Transmise aux Achats.">
            <Textarea rows={1} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} className="min-h-[38px]" />
          </FormField>
        </div>
      </Panel>

      {mode === 'lines' && (
        <Panel
          title="Articles du BC"
          actions={
            <Button size="sm" variant="secondary" onClick={fillAll}>
              <CheckCheck className="h-4 w-4" aria-hidden /> Tout reçu
            </Button>
          }
        >
          {/* Mobile (à bord, téléphone) : une carte par article, sans défilement horizontal */}
          <ul className="space-y-2 sm:hidden">
            {preview.map(({ line: l, rem, missing, surplus }) => {
              const r = row(l.id);
              return (
                <li key={l.id} className={cn('rounded-md border px-3 py-2', r.checked ? 'border-line' : 'border-dashed border-line text-ink-muted')}>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={r.checked}
                      onChange={(e) => patch(l.id, { checked: e.target.checked, quantity: e.target.checked && !r.quantity ? rem : r.quantity })}
                    />
                    <span className="min-w-0">
                      <span className="block font-medium text-ink">{l.designation}</span>
                      <span className="block text-xs text-ink-muted">
                        Commandé {fmtDecimal(dec.sub(l.quantityOrdered, l.quantityCancelled))} {l.unit} · reste {fmtDecimal(rem)}
                      </span>
                    </span>
                  </label>
                  {r.checked && (
                    <div className="mt-2 grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-2">
                      <DecimalInput value={r.quantity} onChange={(v) => patch(l.id, { quantity: v })} invalid={!!lineErrors[l.id]} ariaLabel={`Quantité reçue (mobile) : ${l.designation}`} className="h-9" />
                      <span className="text-sm">
                        {dec.gt0(missing) ? (
                          <span className="font-medium text-warn">manque {fmtDecimal(missing)}</span>
                        ) : dec.gt0(surplus) ? (
                          <span className="font-medium text-warn">surplus {fmtDecimal(surplus)}</span>
                        ) : (
                          <span className="text-ok">conforme</span>
                        )}
                      </span>
                      <Input value={r.remarks} onChange={(e) => patch(l.id, { remarks: e.target.value })} placeholder="Remarque" className="col-span-2 h-9 text-sm" aria-label={`Remarque (mobile) : ${l.designation}`} maxLength={1000} />
                      {lineErrors[l.id] && <span className="col-span-2 text-xs text-danger">{lineErrors[l.id]}</span>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="hidden overflow-x-auto sm:block">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Reçu</span>
                  </th>
                  <th scope="col">Article</th>
                  <th scope="col" className="text-right">
                    Commandé
                  </th>
                  <th scope="col" className="text-right">
                    Reste à recevoir
                  </th>
                  <th scope="col" className="text-right">
                    Reçu ce jour
                  </th>
                  <th scope="col">Écart</th>
                  <th scope="col">Remarque</th>
                </tr>
              </thead>
              <tbody>
                {preview.map(({ line: l, rem, missing, surplus }) => {
                  const r = row(l.id);
                  return (
                    <tr key={l.id} className={cn(!r.checked && 'text-ink-muted')}>
                      <td>
                        <input
                          type="checkbox"
                          className="h-4 w-4"
                          checked={r.checked}
                          aria-label={`Reçu : ${l.designation}`}
                          onChange={(e) => patch(l.id, { checked: e.target.checked, quantity: e.target.checked && !r.quantity ? rem : r.quantity })}
                        />
                      </td>
                      <td className="min-w-[180px]">
                        <span className="text-ink">{l.designation}</span>
                        {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                      </td>
                      <td className="text-right tabular">
                        {fmtDecimal(dec.sub(l.quantityOrdered, l.quantityCancelled))} {l.unit}
                      </td>
                      <td className="text-right tabular">{fmtDecimal(rem)}</td>
                      <td className="w-28">
                        {r.checked ? (
                          <>
                            <DecimalInput value={r.quantity} onChange={(v) => patch(l.id, { quantity: v })} invalid={!!lineErrors[l.id]} ariaLabel={`Quantité reçue : ${l.designation}`} className="h-8" />
                            {lineErrors[l.id] && <span className="text-xs text-danger">{lineErrors[l.id]}</span>}
                          </>
                        ) : (
                          <span className="block text-right text-xs">non reçu</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap text-xs">
                        {dec.gt0(missing) ? (
                          <span className="font-medium text-warn">manque {fmtDecimal(missing)}</span>
                        ) : dec.gt0(surplus) ? (
                          <span className="font-medium text-warn">surplus {fmtDecimal(surplus)}</span>
                        ) : (
                          <span className="text-ok">conforme</span>
                        )}
                      </td>
                      <td className="min-w-[160px]">
                        <Input value={r.remarks} onChange={(e) => patch(l.id, { remarks: e.target.value })} placeholder={dec.gt0(missing) ? 'ex. carton manquant' : ''} className="h-8 text-sm" aria-label={`Remarque : ${l.designation}`} maxLength={1000} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-4 border-t border-line pt-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-navy">Articles reçus hors BC</p>
              <Button size="sm" variant="ghost" onClick={() => setExtras((x) => [...x, { key: `${Date.now()}-${x.length}`, designation: '', reference: '', quantity: '', unit: 'pcs', remarks: '' }])}>
                <PackagePlus className="h-4 w-4" aria-hidden /> Ajouter un article
              </Button>
            </div>
            {extras.length === 0 ? (
              <p className="text-xs text-ink-muted">Article livré qui ne figure pas sur le BC : notez-le ici (information transmise, sans alerte).</p>
            ) : (
              <ul className="space-y-2">
                {extras.map((x, i) => (
                  <li key={x.key} className="grid gap-2 rounded-md border border-line bg-info-bg/30 p-2 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_6rem_6rem_minmax(0,3fr)_auto]">
                    <Input value={x.designation} onChange={(e) => setExtras((p) => p.map((y, j) => (j === i ? { ...y, designation: e.target.value } : y)))} placeholder="Désignation" aria-label="Désignation de l’article hors BC" className="h-8 text-sm" maxLength={500} />
                    <Input value={x.reference} onChange={(e) => setExtras((p) => p.map((y, j) => (j === i ? { ...y, reference: e.target.value } : y)))} placeholder="Référence" aria-label="Référence de l’article hors BC" className="h-8 text-sm" maxLength={200} />
                    <DecimalInput value={x.quantity} onChange={(v) => setExtras((p) => p.map((y, j) => (j === i ? { ...y, quantity: v } : y)))} placeholder="Qté" ariaLabel="Quantité de l’article hors BC" className="h-8" invalid={!!extraErrors[i] && !!x.quantity} />
                    <Input value={x.unit} list="bl-units" onChange={(e) => setExtras((p) => p.map((y, j) => (j === i ? { ...y, unit: e.target.value } : y)))} aria-label="Unité de l’article hors BC" className="h-8 text-sm" maxLength={32} />
                    <Input value={x.remarks} onChange={(e) => setExtras((p) => p.map((y, j) => (j === i ? { ...y, remarks: e.target.value } : y)))} placeholder="Remarque" aria-label="Remarque sur l’article hors BC" className="h-8 text-sm" maxLength={1000} />
                    <IconButton label="Retirer cet article" onClick={() => setExtras((p) => p.filter((_, j) => j !== i))}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                    {extraErrors[i] && (x.designation || x.quantity) && <span className="text-xs text-danger sm:col-span-6">{extraErrors[i]}</span>}
                  </li>
                ))}
              </ul>
            )}
            <datalist id="bl-units">
              {COMMON_UNITS.map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
          </div>
        </Panel>
      )}

      <Panel title={mode === 'file' ? 'BL du fournisseur' : `Fichiers joints (${files.length})`}>
        <FileUploader
          context="PURCHASING"
          vesselId={po.vesselId}
          multiple
          label={mode === 'file' ? 'Déposer le BL (PDF, Excel ou photo)' : 'BL scanné, photos (facultatif)'}
          onUploaded={(f) => setFiles((p) => [...p, f])}
        />
        {files.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {files.map((f) => (
              <li key={f.id}>
                <Badge tone="navy" icon={false}>
                  {f.originalName}
                  <button type="button" className="ml-1 text-ink-muted hover:text-danger" aria-label={`Retirer ${f.originalName}`} onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>
                    ×
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {error && (
        <Callout tone="danger" title="BL non enregistré">
          {error}
        </Callout>
      )}

      <div className="flex flex-wrap items-center justify-end gap-3">
        {mode === 'lines' && gaps.length > 0 && received.length + extras.length > 0 && (
          <span className="flex items-center gap-1 text-sm text-warn">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {gaps.length} écart(s) : les Achats seront alertés
          </span>
        )}
        {mode === 'lines' ? (
          <Button onClick={() => setConfirmOpen(true)} disabled={!linesValid}>
            <Send className="h-4 w-4" aria-hidden /> Envoyer le BL
          </Button>
        ) : (
          <Button onClick={() => setAskConform(true)} disabled={!fileValid}>
            <Send className="h-4 w-4" aria-hidden /> Envoyer le BL
          </Button>
        )}
      </div>

      {/* Après un fichier : le BL est-il conforme au BC ? */}
      <Dialog
        open={askConform}
        onOpenChange={setAskConform}
        title="Le BL correspond-il exactement au BC ?"
        description="Mêmes articles et mêmes quantités que le reste à recevoir du BC."
        size="sm"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setAskConform(false);
                fillAll();
                setMode('lines');
              }}
            >
              Non, il y a des différences
            </Button>
            <Button onClick={() => send(true)} loading={busy}>
              <CheckCircle2 className="h-4 w-4" aria-hidden /> Oui, tout est conforme
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          « Non » ouvre la saisie préremplie : corrigez les quantités reçues et ajoutez les articles reçus hors BC. Le fichier joint est conservé.
        </p>
        {error && (
          <p className="mt-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </Dialog>

      {/* Récapitulatif avant envoi (saisie par ligne) */}
      <Dialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Envoyer le BL du BC ${po.number}`}
        description={gaps.length ? 'Les écarts ci-dessous seront signalés aux Achats.' : 'Reçu conforme au BC.'}
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              Corriger
            </Button>
            <Button onClick={() => send(false)} loading={busy}>
              <Send className="h-4 w-4" aria-hidden /> Envoyer
            </Button>
          </>
        }
      >
        {gaps.length > 0 ? (
          <GapTable
            rows={gaps.map((g) => ({
              key: g.line.id,
              designation: g.line.designation,
              unit: g.line.unit,
              ordered: g.rem,
              received: g.qty,
              missing: g.missing,
              surplus: g.surplus,
              remarks: row(g.line.id).remarks || null,
            }))}
            orderedLabel="Reste à recevoir"
          />
        ) : (
          <p className="text-sm text-ok">Tous les articles du BC sont reçus dans les quantités attendues.</p>
        )}
        {extras.length > 0 && <p className="mt-3 text-sm text-ink-muted">{extras.length} article(s) hors BC noté(s) — information, sans alerte.</p>}
        {error && (
          <p className="mt-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
      </Dialog>
    </div>
  );
}

function ModeButton({ active, onClick, icon, title, text }: { active: boolean; onClick: () => void; icon: ReactNode; title: string; text: string }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex items-start gap-3 rounded-md border px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-action',
        active ? 'border-action bg-action-50' : 'border-line bg-white hover:border-navy-600',
      )}
    >
      <span className={cn('mt-0.5', active ? 'text-action' : 'text-ink-muted')}>{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-navy">{title}</span>
        <span className="block text-xs text-ink-muted">{text}</span>
      </span>
    </button>
  );
}

/** Tableau des écarts reçu / commandé (aperçu du bord, alerte côté Achats). */
export function GapTable({
  rows,
  orderedLabel = 'Commandé',
}: {
  rows: { key: string; designation: string; unit: string; ordered: string; received: string; missing: string; surplus: string; remarks: string | null }[];
  orderedLabel?: string;
}) {
  return (
    <>
      <ul className="divide-y divide-line rounded-md border border-line sm:hidden">
        {rows.map((r) => (
          <li key={r.key} className="px-3 py-2 text-sm">
            <span className="block font-medium text-ink">{r.designation}</span>
            <span className="block text-ink-muted">
              {orderedLabel} {fmtDecimal(r.ordered)} {r.unit} · reçu {fmtDecimal(r.received)} ·{' '}
              <span className="font-semibold text-warn">{dec.gt0(r.missing) ? `manque ${fmtDecimal(r.missing)}` : `surplus ${fmtDecimal(r.surplus)}`}</span>
            </span>
            {r.remarks && <span className="block italic text-ink-muted">« {r.remarks} »</span>}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-md border border-line sm:block">
        <table className="table-amc">
          <thead>
            <tr>
              <th scope="col">Article</th>
              <th scope="col" className="text-right">
                {orderedLabel}
              </th>
              <th scope="col" className="text-right">
                Reçu
              </th>
              <th scope="col" className="text-right">
                Écart
              </th>
              <th scope="col">Remarque du bord</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="min-w-[160px]">{r.designation}</td>
                <td className="text-right tabular">
                  {fmtDecimal(r.ordered)} {r.unit}
                </td>
                <td className="text-right tabular">{fmtDecimal(r.received)}</td>
                <td className="text-right font-semibold tabular text-warn">{dec.gt0(r.missing) ? `manque ${fmtDecimal(r.missing)}` : `surplus ${fmtDecimal(r.surplus)}`}</td>
                <td className="text-sm italic text-ink-muted">{r.remarks ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
