'use client';

import { AlarmClock, AlertTriangle, Plus, RotateCcw, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Input } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { InvoiceFormDialog } from '@/components/purchasing/invoice-form-dialog';
import { INVOICE_STATUS_LABELS, INVOICE_STATUS_TONES, MATCH_REASON_LABELS, dec, isPast, purKeys, totalsByCurrency, useDebounced, useUrlParams } from '@/components/purchasing/lib';
import type { InvoiceListItem } from '@/components/purchasing/types';
import { Callout, FilterSelect, Money, StatusPill, useSuppliers } from '@/components/purchasing/ui';

export default function InvoicesPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <Invoices />
    </Suspense>
  );
}

function Invoices() {
  const router = useRouter();
  const { get, set, sp } = useUrlParams();
  const { can, me, selectedVesselIds } = useSession();
  const [term, setTerm] = useState(get('search'));
  const debounced = useDebounced(term.trim(), 300);
  useEffect(() => {
    if (debounced !== get('search')) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const switcherVessel = selectedVesselIds.length === 1 ? selectedVesselIds[0] : '';
  const vesselId = get('vesselId') || switcherVessel;
  const params = useMemo(
    () => ({ vesselId: vesselId || undefined, status: get('status') || undefined, supplierId: get('supplierId') || undefined, poId: get('poId') || undefined, search: get('search') || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<InvoiceListItem>([...purKeys.invoices], '/invoices', params, can('invoice.view'));
  const suppliers = useSuppliers('', false, can('suppliers.view'));
  const createOpen = get('new') === '1';
  const totals = useMemo(() => totalsByCurrency((list.rows ?? []).filter((r) => r.status !== 'CANCELLED'), (r) => r.currency, (r) => dec.add(r.amount, r.taxAmount)), [list.rows]);

  if (!can('invoice.view')) return <Forbidden />;
  const statusValue = get('status');
  const filtersActive = ['status', 'supplierId', 'search', 'vesselId', 'poId'].some((k) => !!get(k));

  const columns: Column<InvoiceListItem>[] = [
    {
      key: 'number',
      header: 'Facture',
      cell: (r) => (
        <Link href={`/purchasing/invoices/${r.id}`} className="ref font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.number}
        </Link>
      ),
    },
    { key: 'supplier', header: 'Fournisseur', cell: (r) => r.supplier.name },
    { key: 'date', header: 'Date', cell: (r) => fmtDate(r.invoiceDate) },
    {
      key: 'due',
      header: 'Échéance',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {fmtDate(r.dueDate)}
          {r.dueDate && isPast(r.dueDate) && !['APPROVED', 'CANCELLED'].includes(r.status) && (
            <Badge tone="warn" className="ml-1" icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
              Échue
            </Badge>
          )}
        </span>
      ),
      hideBelow: 'md',
    },
    { key: 'ht', header: 'HT', align: 'right', cell: (r) => <Money value={r.amount} currency={r.currency} />, hideBelow: 'lg' },
    { key: 'ttc', header: 'TTC', align: 'right', cell: (r) => <Money value={dec.add(r.amount, r.taxAmount)} currency={r.currency} strong /> },
    {
      key: 'pos',
      header: 'BC',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          {r.orders.map((o) => (
            <Link key={o.poId} href={`/purchasing/orders/${o.poId}`} className="text-xs text-action hover:underline" onClick={(e) => e.stopPropagation()}>
              {o.po.number}
            </Link>
          ))}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Statut',
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1">
          <StatusPill status={r.status} labels={INVOICE_STATUS_LABELS} tones={INVOICE_STATUS_TONES} />
          {/* Écart de rapprochement : la facture garde son statut tant qu'elle n'est pas examinée (ACH-13) */}
          {r.reconciliation?.suggestion === 'DISPUTED' && (
            <Badge tone="danger" title={r.reconciliation.reasons.map((x) => MATCH_REASON_LABELS[x] ?? x).join(', ')} icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}>
              Écart de rapprochement
            </Badge>
          )}
        </span>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Factures' }]}
        title="Factures fournisseurs"
        description="Factures conservées avec leur fichier original et rapprochées par devise (commandé / reçu / facturé). Le paiement et la comptabilité sont hors périmètre V1."
        actions={
          can('invoice.manage') && (
            <Button onClick={() => set({ new: '1' })}>
              <Plus className="h-4 w-4" aria-hidden /> Enregistrer une facture
            </Button>
          )
        }
      />
      <Callout tone="info" className="mb-3" title="Une facture ne clôt jamais un BC partiellement reçu">
        Le statut de réception des bons de commande ne dépend que des quantités acceptées à bord (PUR-07).
      </Callout>
      <FilterBar>
        <div className="min-w-[200px] flex-1">
          <label htmlFor="inv-search" className="mb-1 block text-xs font-medium text-ink-muted">
            Recherche
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
            <Input id="inv-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="N° de facture…" className="h-8 pl-8 text-sm" />
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
        <FilterSelect label="Statut" value={statusValue} onChange={(v) => set({ status: v || null })} className="w-44">
          <option value="">Tous</option>
          <option value="RECEIVED,UNDER_REVIEW">À examiner</option>
          {Object.entries(INVOICE_STATUS_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
          {statusValue && statusValue !== 'RECEIVED,UNDER_REVIEW' && !INVOICE_STATUS_LABELS[statusValue] && <option value={statusValue}>{statusValue}</option>}
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
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTerm('');
              router.replace('/purchasing/invoices');
            }}
          >
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>
      {totals.length > 0 && (
        <p className="mb-2 text-xs text-ink-muted">
          Total TTC affiché (hors annulées), par devise — sans conversion :{' '}
          {totals.map(([cur, amount], i) => (
            <span key={cur}>
              {i > 0 && ' · '}
              <Money value={amount} currency={cur} strong className="text-ink" />
            </span>
          ))}
        </p>
      )}
      <DataTable
        caption="Factures"
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        onRowClick={(r) => router.push(`/purchasing/invoices/${r.id}`)}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        empty={<EmptyState title="Aucune facture" />}
      />
      {createOpen && can('invoice.manage') && (
        <InvoiceFormDialog
          open
          onOpenChange={(o) => !o && set({ new: null })}
          initialSupplierId={get('supplierId') || undefined}
          initialPoId={get('poId') || undefined}
        />
      )}
    </>
  );
}
