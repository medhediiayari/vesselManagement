'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { FileSearch } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type Page } from '@/lib/api';
import { cn, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { Forbidden, LoadingBlock } from '@/components/ui/states';
import { commandError, dec, decimalError, purKeys, toApiDecimal, todayInput, usePurRefresh } from '@/components/purchasing/lib';
import type { PrDetail, PrListItem, RfqDetail } from '@/components/purchasing/types';
import { Callout, DecimalInput, FormField, PrStatusBadge, SupplierMultiPicker, VesselSelect } from '@/components/purchasing/ui';

const SOURCEABLE = 'SUBMITTED,UNDER_REVIEW,APPROVED,SOURCING,PARTIALLY_ORDERED';

interface LineChoice {
  include: boolean;
  quantity: string;
  remarks: string;
}

export default function NewRfqPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <NewRfq />
    </Suspense>
  );
}

function NewRfq() {
  const router = useRouter();
  const sp = useSearchParams();
  const { can, selectedVesselIds } = useSession();
  const refresh = usePurRefresh();
  const initialPr = sp.get('prId') ?? '';
  const [vesselId, setVesselId] = useState(sp.get('vesselId') ?? (selectedVesselIds.length === 1 ? selectedVesselIds[0] : ''));
  const [prIds, setPrIds] = useState<string[]>(initialPr ? [initialPr] : []);
  const [choices, setChoices] = useState<Record<string, LineChoice>>({});
  const [title, setTitle] = useState('');
  const [deadline, setDeadline] = useState('');
  const [deliveryPort, setDeliveryPort] = useState('');
  const [deliveryTerms, setDeliveryTerms] = useState('');
  const [notes, setNotes] = useState('');
  const [supplierIds, setSupplierIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prs = useQuery({
    queryKey: [...purKeys.prs, 'sourceable', vesselId],
    queryFn: () => api.get<Page<PrListItem>>('/purchase-requests', { query: { vesselId, status: SOURCEABLE, limit: 100 } }),
    enabled: !!vesselId && can('pr.view'),
  });
  const details = useQueries({ queries: prIds.map((id) => ({ queryKey: [...purKeys.pr(id)], queryFn: () => api.get<PrDetail>(`/purchase-requests/${id}`) })) });
  const loaded = details.map((d) => d.data).filter((d): d is PrDetail => !!d);

  useEffect(() => {
    if (!vesselId && loaded[0]) setVesselId(loaded[0].vesselId);
    if (!title && loaded[0]) setTitle(loaded[0].subject.slice(0, 300));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.length]);

  useEffect(() => {
    setChoices((prev) => {
      const next = { ...prev };
      for (const pr of loaded) {
        for (const l of pr.lines) {
          if (next[l.id] || l.status === 'CANCELLED') continue;
          next[l.id] = { include: dec.gt0(l.progress?.toOrder ?? '0'), quantity: '', remarks: '' };
        }
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded.map((p) => p.id).join('|')]);

  const lines = useMemo(() => loaded.flatMap((pr) => pr.lines.filter((l) => l.status !== 'CANCELLED').map((l) => ({ pr, l }))), [loaded]);
  const selected = lines.filter(({ l }) => choices[l.id]?.include);
  const qtyErrors = selected.map(({ l }) => (choices[l.id].quantity ? decimalError(choices[l.id].quantity, { positive: true, scale: 3 }) : !dec.gt0(l.progress?.toOrder ?? '0') ? 'Plus rien à commander : précisez une quantité' : null));
  const canSubmit = title.trim().length >= 2 && selected.length > 0 && qtyErrors.every((e) => !e);

  if (!can('rfq.manage')) return <Forbidden message="La création de RFQ requiert la permission rfq.manage." />;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const rfq = await api.post<RfqDetail>('/rfqs', {
        title: title.trim(),
        lines: selected.map(({ l }) => ({
          prLineId: l.id,
          quantity: choices[l.id].quantity ? toApiDecimal(choices[l.id].quantity) : undefined,
          remarks: choices[l.id].remarks.trim() || undefined,
        })),
        supplierIds,
        deadline: deadline || null,
        deliveryPort: deliveryPort.trim() || null,
        deliveryTerms: deliveryTerms.trim() || null,
        notes: notes.trim() || null,
      });
      toast.success(`RFQ ${rfq.number} créée (brouillon) — vérifiez puis émettez-la`);
      await refresh();
      router.replace(`/purchasing/rfqs/${rfq.id}`);
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  const available = prs.data?.items ?? [];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'RFQ & devis', href: '/purchasing/rfqs' }, { label: 'Nouvelle RFQ' }]}
        title="Nouvelle demande de prix (RFQ)"
        description="Sélectionnez une ou plusieurs PR d’un même navire puis les lignes à consulter. La quantité par défaut est le reste à commander de chaque ligne."
        actions={
          <Button onClick={submit} disabled={!canSubmit} loading={busy}>
            <FileSearch className="h-4 w-4" aria-hidden /> Créer la RFQ
          </Button>
        }
      />
      <div className="space-y-5">
        <Panel title="1. Navire et PR">
          <div className="grid gap-3 md:grid-cols-3">
            <VesselSelect
              value={vesselId}
              onChange={(v) => {
                setVesselId(v);
                setPrIds([]);
                setChoices({});
              }}
              required
            />
          </div>
          {vesselId && (
            <div className="mt-3">
              {prs.isLoading ? (
                <LoadingBlock rows={2} />
              ) : available.length ? (
                <ul className="flex flex-wrap gap-2">
                  {available.map((p) => {
                    const active = prIds.includes(p.id);
                    return (
                      <li key={p.id}>
                        <label className={cn('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm', active ? 'border-action bg-action-50' : 'border-line hover:bg-navy-50')}>
                          <input type="checkbox" className="h-4 w-4" checked={active} onChange={() => setPrIds((prev) => (active ? prev.filter((x) => x !== p.id) : [...prev, p.id]))} />
                          <span className="font-medium">{p.number}</span>
                          <span className="max-w-[240px] truncate text-ink-muted">{p.subject}</span>
                          <PrStatusBadge status={p.status} />
                        </label>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-sm text-ink-muted">Aucune PR soumise, en revue ou approuvée sur ce navire.</p>
              )}
              <p className="mt-2 text-xs text-ink-muted">Une RFQ peut être lancée dès la soumission (consultation pendant la revue Achats).</p>
            </div>
          )}
        </Panel>

        <Panel title={`2. Lignes à consulter (${selected.length})`}>
          {details.some((d) => d.isLoading) && <LoadingBlock rows={3} />}
          {!lines.length && !details.some((d) => d.isLoading) && <p className="text-sm text-ink-muted">Sélectionnez au moins une PR.</p>}
          {lines.length > 0 && (
            <div className="overflow-x-auto rounded-md border border-line">
              <table className="table-amc">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">Inclure</span>
                    </th>
                    <th scope="col">PR / ligne</th>
                    <th scope="col">Désignation</th>
                    <th scope="col" className="text-right">
                      Effectif
                    </th>
                    <th scope="col" className="text-right">
                      Déjà alloué
                    </th>
                    <th scope="col" className="text-right">
                      Reste à commander
                    </th>
                    <th scope="col" className="text-right">
                      Qté consultée
                    </th>
                    <th scope="col">Remarque fournisseur</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map(({ pr, l }) => {
                    const c = choices[l.id];
                    if (!c) return null;
                    const idx = selected.findIndex((x) => x.l.id === l.id);
                    const err = idx >= 0 ? qtyErrors[idx] : null;
                    return (
                      <tr key={l.id} className={cn(!c.include && 'opacity-60')}>
                        <td>
                          <input
                            type="checkbox"
                            className="h-4 w-4"
                            checked={c.include}
                            aria-label={`Consulter ${pr.number} ligne ${l.lineNo}`}
                            onChange={(e) => setChoices((p) => ({ ...p, [l.id]: { ...c, include: e.target.checked } }))}
                          />
                        </td>
                        <td className="whitespace-nowrap text-xs">
                          {pr.number} · L{l.lineNo}
                        </td>
                        <td className="min-w-[200px]">
                          {l.designation}
                          {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                        </td>
                        <td className="text-right tabular">
                          {fmtDecimal(l.progress?.effective)} {l.unit}
                        </td>
                        <td className="text-right tabular">{fmtDecimal(l.progress?.allocated)}</td>
                        <td className={cn('text-right tabular', dec.gt0(l.progress?.toOrder) ? 'font-medium text-warn' : 'text-ink-muted')}>{fmtDecimal(l.progress?.toOrder)}</td>
                        <td className="w-32">
                          <DecimalInput
                            value={c.quantity}
                            onChange={(v) => setChoices((p) => ({ ...p, [l.id]: { ...c, quantity: v } }))}
                            placeholder={fmtDecimal(l.progress?.toOrder)}
                            disabled={!c.include}
                            invalid={!!err}
                            ariaLabel={`Quantité consultée ${pr.number} ligne ${l.lineNo}`}
                            className="h-8"
                          />
                          {err && <span className="text-xs text-danger">{err}</span>}
                        </td>
                        <td className="min-w-[160px]">
                          <Input
                            value={c.remarks}
                            onChange={(e) => setChoices((p) => ({ ...p, [l.id]: { ...c, remarks: e.target.value } }))}
                            disabled={!c.include}
                            className="h-8 text-sm"
                            placeholder={l.remarks ?? ''}
                            aria-label="Remarque"
                            maxLength={1000}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <div className="grid gap-5 xl:grid-cols-2">
          <Panel title="3. Conditions">
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Titre" required className="sm:col-span-2">
                <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} />
              </FormField>
              <FormField label="Date limite de réponse">
                <Input type="date" value={deadline} min={todayInput()} onChange={(e) => setDeadline(e.target.value)} />
              </FormField>
              <FormField label="Port de livraison">
                <Input value={deliveryPort} onChange={(e) => setDeliveryPort(e.target.value)} maxLength={120} />
              </FormField>
              <FormField label="Conditions de livraison" className="sm:col-span-2">
                <Input value={deliveryTerms} onChange={(e) => setDeliveryTerms(e.target.value)} maxLength={500} placeholder="ex. Livraison à bord, DAP Gabès" />
              </FormField>
              <FormField label="Notes aux fournisseurs" className="sm:col-span-2">
                <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} />
              </FormField>
            </div>
          </Panel>
          <Panel title={`4. Fournisseurs consultés (${supplierIds.length})`}>
            <SupplierMultiPicker value={supplierIds} onChange={setSupplierIds} />
            <p className="mt-2 text-xs text-ink-muted">Facultatif à ce stade : les fournisseurs peuvent être ajoutés ensuite depuis la fiche RFQ.</p>
          </Panel>
        </div>

        {error && <Callout tone="danger" title="Création refusée">{error}</Callout>}
        <div className="flex justify-end">
          <Button onClick={submit} disabled={!canSubmit} loading={busy}>
            <FileSearch className="h-4 w-4" aria-hidden /> Créer la RFQ
          </Button>
        </div>
      </div>
    </>
  );
}
