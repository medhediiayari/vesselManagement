'use client';

import { PO_STATUS_LABELS } from '@amc/types';
import { AlarmClock, AlertTriangle, Plus, RotateCcw, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/field';
import { DataTable, type Column, type RowGroup } from '@/components/ui/data-table';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { ManualPoDialog } from '@/components/purchasing/manual-po-dialog';
import { isPast, purKeys, totalsByCurrency, useDebounced, useUrlParams } from '@/components/purchasing/lib';
import type { PoListItem } from '@/components/purchasing/types';
import { ExportButton, FilterSelect, Money, PoStatusBadge, PrStatusBadge, useSuppliers } from '@/components/purchasing/ui';

const PRESETS: Record<string, string> = {
  'DRAFT,APPROVAL_PENDING,APPROVED': 'À préparer / approuver / envoyer',
  'SENT,PARTIALLY_RECEIVED': 'En attente de livraison',
};

export default function OrdersPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <OrdersList />
    </Suspense>
  );
}

function OrdersList() {
  const router = useRouter();
  const { get, set, sp } = useUrlParams();
  const { can, me, selectedVesselIds } = useSession();
  const [term, setTerm] = useState(get('search'));
  const [manualOpen, setManualOpen] = useState(false);
  const debounced = useDebounced(term.trim(), 300);
  useEffect(() => {
    if (debounced !== get('search')) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const switcherVessel = selectedVesselIds.length === 1 ? selectedVesselIds[0] : '';
  const vesselId = get('vesselId') || switcherVessel;
  // ?late=true (lien du dashboard) == filtre API overdue
  const late = get('late') === 'true' || get('overdue') === 'true';
  const params = useMemo(
    () => ({
      vesselId: vesselId || undefined,
      status: get('status') || undefined,
      supplierId: get('supplierId') || undefined,
      prId: get('prId') || undefined,
      overdue: late ? 'true' : undefined,
      discrepancy: get('discrepancy') === 'true' ? 'true' : undefined,
      search: get('search') || undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<PoListItem>([...purKeys.orders], '/orders', params, can('bc.view'));
  const suppliers = useSuppliers('', false, can('suppliers.view'));
  const totals = useMemo(() => totalsByCurrency(list.rows ?? [], (r) => r.currency, (r) => (r.status === 'CANCELLED' ? '0' : r.totalAmount)), [list.rows]);

  if (!can('bc.view')) return <Forbidden />;
  const statusValue = get('status');
  // Regroupement par Purchase Request (par défaut) ; ?group=none pour la liste simple
  const grouped = get('group') !== 'none';
  const groupByPr = (r: PoListItem, groupRows: PoListItem[]): RowGroup => {
    const prs = r.prs ?? [];
    const amounts = totalsByCurrency(groupRows, (x) => x.currency, (x) => (x.status === 'CANCELLED' ? '0' : x.totalAmount));
    return {
      key: prs.map((p) => p.id).join('+') || 'sans-pr',
      header: (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
          {prs.length ? (
            prs.map((p) => (
              <span key={p.id} className="inline-flex min-w-0 flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">PR</span>
                <Link href={`/purchasing/requests/${p.id}`} onClick={(e) => e.stopPropagation()} className="ref font-semibold text-action hover:underline">
                  {p.number}
                </Link>
                <span className="max-w-[320px] truncate text-ink" title={p.subject}>
                  {p.subject}
                </span>
                <PrStatusBadge status={p.status} />
                {p.parentNumber && <span className="text-xs text-ink-soft">sous-PR de {p.parentNumber}</span>}
              </span>
            ))
          ) : (
            <span className="text-ink-muted">BC sans PR liée</span>
          )}
          <span className="ml-auto whitespace-nowrap text-xs text-ink-muted">
            {groupRows.length} BC
            {amounts.map(([cur, amount]) => (
              <span key={cur}>
                {' · '}
                <Money value={amount} currency={cur} />
              </span>
            ))}
          </span>
        </div>
      ),
    };
  };
  const filtersActive = ['status', 'supplierId', 'search', 'vesselId', 'late', 'overdue', 'prId', 'discrepancy'].some((k) => !!get(k));

  const columns: Column<PoListItem>[] = [
    {
      key: 'number',
      header: 'BC',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <Link href={`/purchasing/orders/${r.id}`} className="ref font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.number}
          </Link>
          {r.revisionNo > 0 && <span className="ml-1 text-xs text-ink-muted">rév. {r.revisionNo}</span>}
          {r.requiresSecondApproval && <span className="block text-[11px] text-ink-muted">Second regard requis</span>}
        </div>
      ),
    },
    { key: 'vessel', header: 'Navire', cell: (r) => r.vessel.name, hideBelow: 'md' },
    { key: 'supplier', header: 'Fournisseur', cell: (r) => r.supplier.name },
    { key: 'status', header: 'Statut', cell: (r) => <PoStatusBadge status={r.status} /> },
    { key: 'total', header: 'Total', align: 'right', cell: (r) => <Money value={r.totalAmount} currency={r.currency} /> },
    {
      key: 'expected',
      header: 'Livraison attendue',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {fmtDate(r.expectedDeliveryDate)}
          {['SENT', 'PARTIALLY_RECEIVED'].includes(r.status) && isPast(r.expectedDeliveryDate) && (
            <Badge tone="danger" className="ml-1" icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
              En retard
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'lines', header: 'Lignes', align: 'right', cell: (r) => r._count.lines, hideBelow: 'lg' },
    {
      key: 'variances',
      header: 'Écarts ouverts',
      align: 'right',
      cell: (r) =>
        r._count.variances ? (
          <Badge tone="danger" icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}>
            {r._count.variances}
          </Badge>
        ) : (
          <span className="text-ink-muted">0</span>
        ),
    },
    { key: 'created', header: 'Créé le', cell: (r) => fmtDate(r.createdAt), hideBelow: 'lg' },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Bons de commande' }]}
        title="Bons de commande (BC / PO)"
        description="BC émis en un clic et transmis au demandeur ; le bord répond par un BL. Écarts de réception, reliquats et corrections fournisseur suivis ici."
        actions={
          <>
            {can('reports.export') && <ExportButton path="/purchasing/exports/orders.xlsx" query={params as Record<string, string | undefined>} />}
            {can('bc.create') && (
              <Button onClick={() => setManualOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden /> Nouveau BC
              </Button>
            )}
          </>
        }
      />
      <FilterBar>
        <div className="min-w-[200px] flex-1">
          <label htmlFor="po-search" className="mb-1 block text-xs font-medium text-ink-muted">
            Recherche
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
            <Input id="po-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="N° BC, fournisseur…" className="h-8 pl-8 text-sm" />
          </div>
        </div>
        <FilterSelect label="Navire" value={get('vesselId')} onChange={(v) => set({ vesselId: v || null })} className="w-44">
          <option value="">{switcherVessel ? 'Navire du sélecteur' : 'Tous mes navires'}</option>
          {me.accessibleVessels.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Statut" value={statusValue} onChange={(v) => set({ status: v || null })} className="w-52">
          <option value="">Tous</option>
          <optgroup label="Regroupements">
            {Object.entries(PRESETS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </optgroup>
          <optgroup label="Statut">
            {Object.entries(PO_STATUS_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </optgroup>
          {statusValue && !PRESETS[statusValue] && !PO_STATUS_LABELS[statusValue] && <option value={statusValue}>{statusValue}</option>}
        </FilterSelect>
        {can('suppliers.view') && (
          <FilterSelect label="Fournisseur" value={get('supplierId')} onChange={(v) => set({ supplierId: v || null })} className="w-52">
            <option value="">Tous</option>
            {(suppliers.data?.items ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </FilterSelect>
        )}
        <div className="pb-1.5">
          <Checkbox label="Livraison en retard" checked={late} onChange={(e) => set({ late: e.target.checked ? 'true' : null, overdue: null })} />
        </div>
        <div className="pb-1.5">
          <Checkbox label="Écart de réception à traiter" checked={get('discrepancy') === 'true'} onChange={(e) => set({ discrepancy: e.target.checked ? 'true' : null })} />
        </div>
        <div className="pb-1.5">
          <Checkbox label="Grouper par PR" checked={grouped} onChange={(e) => set({ group: e.target.checked ? null : 'none' })} />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTerm('');
              router.replace('/purchasing/orders');
            }}
          >
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>
      {totals.length > 0 && (
        <p className="mb-2 text-xs text-ink-muted">
          Montant des BC affichés (hors annulés), par devise — sans conversion :{' '}
          {totals.map(([cur, amount], i) => (
            <span key={cur}>
              {i > 0 && ' · '}
              <Money value={amount} currency={cur} strong className="text-ink" />
            </span>
          ))}
        </p>
      )}
      <DataTable
        caption="Liste des bons de commande"
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        onRowClick={(r) => router.push(`/purchasing/orders/${r.id}`)}
        groupBy={grouped ? groupByPr : undefined}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        empty={<EmptyState title="Aucun bon de commande" description={filtersActive ? 'Aucun BC ne correspond aux filtres.' : 'Les BC créés depuis les devis retenus ou les PR apparaîtront ici.'} />}
      />
      {manualOpen && <ManualPoDialog open={manualOpen} onOpenChange={setManualOpen} initialVesselId={switcherVessel || undefined} />}
    </>
  );
}
