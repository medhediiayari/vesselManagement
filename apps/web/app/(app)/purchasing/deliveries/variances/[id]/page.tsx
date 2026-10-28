'use client';

import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Lock, RotateCcw, ShoppingCart, UserPlus } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select, Textarea } from '@/components/ui/field';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { CurrencyInput } from '@/components/purchasing/manual-po-dialog';
import {
  VARIANCE_STATUS_LABELS,
  VARIANCE_STATUS_TONES,
  VARIANCE_TYPE_LABELS,
  VARIANCE_TYPE_TONES,
  commandError,
  dec,
  decimalError,
  purKeys,
  toApiDecimal,
  useCommand,
  useDebounced,
} from '@/components/purchasing/lib';
import type { PoDetail, VarianceDetail } from '@/components/purchasing/types';
import { AttachmentsPanel, Callout, DecimalInput, FormField, PoStatusBadge, StatusPill, SupplierSelect, TextActionDialog } from '@/components/purchasing/ui';

type DialogKind = 'assign' | 'resolve' | 'close' | 'reopen' | 'complementary';

export default function VariancePage() {
  const { id } = useParams<{ id: string }>();
  const { can, canAny } = useSession();
  const run = useCommand();
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const q = useQuery({ queryKey: purKeys.variance(id), queryFn: () => api.get<VarianceDetail>(`/variances/${id}`) });
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const v = q.data;
  const manage = can('variances.manage');
  const open = v.status === 'OPEN' || v.status === 'IN_PROGRESS';
  const unit = v.poLine.unit;
  const b = v.lineBalance;
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Écarts & manquants', href: '/purchasing/deliveries?tab=variances' }, { label: VARIANCE_TYPE_LABELS[v.type] ?? v.type }]}
        title={`${VARIANCE_TYPE_LABELS[v.type] ?? v.type} — ${fmtDecimal(v.quantity)} ${unit}`}
        description={v.description}
        meta={
          <>
            <StatusPill status={v.type} labels={VARIANCE_TYPE_LABELS} tones={VARIANCE_TYPE_TONES} />
            <StatusPill status={v.status} labels={VARIANCE_STATUS_LABELS} tones={VARIANCE_STATUS_TONES} />
          </>
        }
        actions={
          manage && (
            <>
              {open && (
                <Button variant="secondary" onClick={() => setDialog('assign')}>
                  <UserPlus className="h-4 w-4" aria-hidden /> {v.assignedToId ? 'Réattribuer' : 'Attribuer'}
                </Button>
              )}
              {open && can('bc.create') && (
                <Button variant="secondary" onClick={() => setDialog('complementary')}>
                  <ShoppingCart className="h-4 w-4" aria-hidden /> BC complémentaire
                </Button>
              )}
              {open && (
                <Button onClick={() => setDialog('resolve')}>
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Résoudre
                </Button>
              )}
              {v.status === 'RESOLVED' && (
                <>
                  <Button variant="secondary" onClick={() => setDialog('close')}>
                    <Lock className="h-4 w-4" aria-hidden /> Clôturer
                  </Button>
                  <Button variant="ghost" onClick={() => setDialog('reopen')}>
                    <RotateCcw className="h-4 w-4" aria-hidden /> Rouvrir
                  </Button>
                </>
              )}
            </>
          )
        }
      />
      {['SHORT_SHIPPED', 'SHORT_RECEIVED'].includes(v.type) && (
        <Callout tone="info" className="mb-4" title={v.type === 'SHORT_SHIPPED' ? 'Absent du BL (non expédié)' : 'Sur le BL mais absent à bord'}>
          {v.type === 'SHORT_SHIPPED'
            ? 'Le fournisseur n’a pas déclaré ces quantités sur ses BL : relance fournisseur ou BC complémentaire pour le reliquat.'
            : 'Le BL déclarait ces quantités mais elles n’ont pas été physiquement reçues : signalement au fournisseur avec preuves.'}{' '}
          Les écarts de solde se résolvent automatiquement si une livraison ultérieure comble le manque.
        </Callout>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Panel title={`Ligne ${v.poLine.lineNo} du BC — ${v.poLine.designation}`}>
            {b ? (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <Tile label="Commandé (BC)" value={b.ordered} unit={unit} />
                <Tile label="Sur BL" value={b.onDeliveryNotes} unit={unit} />
                <Tile label="Physiquement reçu" value={b.physicallyReceived} unit={unit} />
                <Tile label="Accepté" value={b.accepted} unit={unit} tone="ok" />
                <Tile label="Reste à recevoir" value={b.remaining} unit={unit} tone={dec.gt0(b.remaining) ? 'warn' : undefined} />
              </div>
            ) : (
              <p className="text-sm text-ink-muted">Solde indisponible.</p>
            )}
            <p className="mt-3 text-xs text-ink-muted">
              PR d’origine :{' '}
              {v.poLine.allocations.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ', '}
                  <Link href={`/purchasing/requests/${a.prLine.pr.id}`} className="text-action hover:underline">
                    {a.prLine.pr.number} L{a.prLine.lineNo}
                  </Link>{' '}
                  ({fmtDecimal(a.quantity)})
                </span>
              ))}
            </p>
          </Panel>
          {v.resolution && (
            <Panel title="Résolution">
              <p className="whitespace-pre-line text-sm">{v.resolution}</p>
              {v.resolvedAt && <p className="mt-1 text-xs text-ink-muted">Le {fmtDateTime(v.resolvedAt)}</p>}
            </Panel>
          )}
          <Panel title="Preuves et pièces">
            <AttachmentsPanel
              path={`/variances/${v.id}/attachments`}
              vesselId={v.po.vesselId}
              attachments={v.attachments}
              canManage={canAny('variances.manage', 'receiving.record')}
              onChanged={() => q.refetch()}
              emptyText="Aucune preuve jointe (photos, échanges fournisseur…)."
            />
          </Panel>
        </div>
        <Panel>
          <DefinitionGrid
            columns={2}
            items={[
              [
                'Bon de commande',
                <span key="po" className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Link href={`/purchasing/orders/${v.poId}?tab=reconciliation`} className="whitespace-nowrap text-action hover:underline">
                    {v.po.number}
                  </Link>
                  <PoStatusBadge status={v.po.status} />
                </span>,
              ],
              ['Fournisseur', v.po.supplier.name],
              [
                'Réception',
                v.receipt ? (
                  <Link key="r" href={`/purchasing/deliveries/receipts/${v.receipt.id}`} className="text-action hover:underline">
                    {v.receipt.number}
                  </Link>
                ) : (
                  'Écart de solde (BC / BL)'
                ),
              ],
              ['Signalé', `${fmtDateTime(v.createdAt)} — ${v.createdByName ?? '—'}`],
              ['Attribué à', v.assignedToName ?? 'Non attribué'],
            ]}
          />
        </Panel>
      </div>

      {dialog === 'assign' && <AssignDialog variance={v} onClose={() => setDialog(null)} />}
      {dialog === 'complementary' && <ComplementaryDialog variance={v} onClose={() => setDialog(null)} />}
      <TextActionDialog
        open={dialog === 'resolve'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Résoudre l’écart"
        label="Résolution"
        required
        maxLength={5000}
        confirmLabel="Résoudre"
        hint="ex. avoir fournisseur reçu, livraison complémentaire, perte acceptée…"
        onConfirm={(resolution) => run(() => api.post(`/variances/${v.id}/resolve`, { resolution }), 'Écart résolu')}
      />
      <TextActionDialog
        open={dialog === 'close'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Clôturer l’écart"
        confirmLabel="Clôturer"
        onConfirm={(comment) => run(() => api.post(`/variances/${v.id}/close`, { comment: comment || null }), 'Écart clôturé')}
      />
      <TextActionDialog
        open={dialog === 'reopen'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Rouvrir l’écart"
        confirmLabel="Rouvrir"
        onConfirm={(comment) => run(() => api.post(`/variances/${v.id}/reopen`, { comment: comment || null }), 'Écart rouvert')}
      />
    </>
  );
}

function Tile({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: 'ok' | 'warn' }) {
  return (
    <div className="gauge">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={`text-lg font-semibold tabular ${tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : 'text-navy'}`}>
        {fmtDecimal(value)} <span className="text-xs font-normal text-ink-muted">{unit}</span>
      </p>
    </div>
  );
}

function AssignDialog({ variance, onClose }: { variance: VarianceDetail; onClose: () => void }) {
  const { can, me } = useSession();
  const run = useCommand();
  const [term, setTerm] = useState('');
  const debounced = useDebounced(term.trim(), 250);
  const [userId, setUserId] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Annuaire minimal (/reference/directory) : ouvert aux gestionnaires d'écarts sans users.view
  const canList = can('users.view') || can('variances.manage');
  const users = useQuery({
    queryKey: ['reference', 'directory', 'USER', debounced],
    queryFn: () => api.get<{ id: string; label: string }[]>('/reference/directory', { query: { type: 'USER', search: debounced || undefined } }),
    enabled: canList,
  });
  const submit = async (assignedToId: string) => {
    setBusy(true);
    setError(null);
    try {
      await run(() => api.post(`/variances/${variance.id}/assign`, { assignedToId, comment: comment.trim() || null }), 'Écart attribué');
      onClose();
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Attribuer l’écart"
      description="Le responsable doit avoir accès aux réceptions de ce navire ; il est notifié."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="secondary" onClick={() => submit(me.id)} loading={busy}>
            M’attribuer
          </Button>
          {canList && (
            <Button onClick={() => submit(userId)} disabled={!userId} loading={busy}>
              Attribuer
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        {canList ? (
          <FormField label="Responsable">
            <Input value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Rechercher un utilisateur…" className="mb-2" aria-label="Rechercher un utilisateur" />
            <Select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">— Choisir —</option>
              {(users.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </Select>
          </FormField>
        ) : (
          <p className="text-sm text-ink-muted">Sans accès à l’annuaire des utilisateurs, vous pouvez vous attribuer l’écart.</p>
        )}
        <FormField label="Commentaire">
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
        </FormField>
        {error && <Callout tone="danger">{error}</Callout>}
      </div>
    </Dialog>
  );
}

function ComplementaryDialog({ variance, onClose }: { variance: VarianceDetail; onClose: () => void }) {
  const router = useRouter();
  const run = useCommand();
  const po = useQuery({ queryKey: purKeys.order(variance.poId), queryFn: () => api.get<PoDetail>(`/orders/${variance.poId}`) });
  const remaining = variance.lineBalance?.remaining ?? '0';
  const [reason, setReason] = useState('');
  const [supplierId, setSupplierId] = useState('');
  const [currency, setCurrency] = useState('');
  const [unitPrice, setUnitPrice] = useState(variance.poLine.unitPrice);
  const [quantity, setQuantity] = useState(remaining);
  const [expected, setExpected] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const qtyErr = decimalError(quantity, { required: true, positive: true, scale: 3 }) ?? (dec.cmp(toApiDecimal(quantity), remaining) > 0 ? `≤ reliquat (${fmtDecimal(remaining)})` : null);
  const priceErr = decimalError(unitPrice, { required: true, scale: 4 });
  const otherSupplier = !!supplierId && supplierId !== variance.po.supplier.id;
  const valid = reason.trim().length >= 3 && !qtyErr && !priceErr && !!po.data && (!otherSupplier || /^[A-Z]{3}$/.test(currency) || !currency);

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="BC complémentaire pour le reliquat"
      description={`Le reliquat de la ligne ${variance.poLine.lineNo} est annulé sur ${variance.po.number} (avenant) et reporté sur un nouveau BC brouillon, lié aux mêmes lignes PR.`}
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
                const res = await run(
                  () =>
                    api.post<{ complementaryOrder: { id: string; number: string } }>(`/variances/${variance.id}/complementary-order`, {
                      reason: reason.trim(),
                      supplierId: supplierId || undefined,
                      currency: currency || undefined,
                      unitPrice: toApiDecimal(unitPrice),
                      quantity: toApiDecimal(quantity),
                      expectedDeliveryDate: expected || null,
                      notes: notes.trim() || null,
                      originalOrderVersion: po.data!.lockVersion,
                    }),
                  (r) => `BC complémentaire ${r.complementaryOrder.number} créé (brouillon)`,
                );
                onClose();
                router.push(`/purchasing/orders/${res.complementaryOrder.id}`);
              } catch (e) {
                setError(commandError(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            <ShoppingCart className="h-4 w-4" aria-hidden /> Créer le BC complémentaire
          </Button>
        </>
      }
    >
      {po.isLoading ? (
        <LoadingBlock rows={3} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label={`Quantité (reliquat ${fmtDecimal(remaining)} ${variance.poLine.unit})`} required error={qtyErr ?? undefined}>
            <DecimalInput value={quantity} onChange={setQuantity} />
          </FormField>
          <FormField label="Prix unitaire" required error={priceErr ?? undefined}>
            <DecimalInput value={unitPrice} onChange={setUnitPrice} />
          </FormField>
          <SupplierSelect
            value={supplierId}
            onChange={(id, s) => {
              setSupplierId(id);
              if (s?.currency && id !== variance.po.supplier.id) setCurrency(s.currency);
            }}
            label="Fournisseur (par défaut : le même)"
            className="sm:col-span-2"
          />
          <FormField label="Devise" hint={otherSupplier ? 'Devise du nouveau fournisseur' : `Par défaut : devise du BC d’origine (${po.data?.currency ?? ''})`}>
            <CurrencyInput value={currency} onChange={setCurrency} />
          </FormField>
          <FormField label="Livraison attendue">
            <Input type="date" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </FormField>
          <FormField label="Motif" required className="sm:col-span-2">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
          </FormField>
          <FormField label="Notes" className="sm:col-span-2">
            <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
          </FormField>
          {error && (
            <div className="sm:col-span-2">
              <Callout tone="danger" title="BC complémentaire refusé">
                {error}
              </Callout>
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}
