'use client';

import { Plus, RotateCcw, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Input } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { purKeys, useDebounced, useUrlParams } from '@/components/purchasing/lib';
import { SupplierFormDialog, SupplierPanel } from '@/components/purchasing/supplier-panel';
import type { Supplier } from '@/components/purchasing/types';
import { FilterSelect, FilterText } from '@/components/purchasing/ui';

export default function SuppliersPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <Suppliers />
    </Suspense>
  );
}

function Suppliers() {
  const router = useRouter();
  const { get, set, sp } = useUrlParams();
  const { can } = useSession();
  const [term, setTerm] = useState(get('search'));
  const [createOpen, setCreateOpen] = useState(false);
  const debounced = useDebounced(term.trim(), 300);
  useEffect(() => {
    if (debounced !== get('search')) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const params = useMemo(
    () => ({
      search: get('search') || undefined,
      active: get('active') || undefined,
      country: get('country').length === 2 ? get('country') : undefined,
      currency: get('currency').length === 3 ? get('currency') : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString()],
  );
  const list = useCursorList<Supplier>([...purKeys.suppliers], '/suppliers', params, can('suppliers.view'));
  const selected = get('selected');

  if (!can('suppliers.view')) return <Forbidden />;

  const columns: Column<Supplier>[] = [
    {
      key: 'name',
      header: 'Fournisseur',
      cell: (r) => (
        <div className="min-w-[180px]">
          <p className="font-medium text-ink">{r.name}</p>
          <p className="text-xs text-ink-muted">{r.code}</p>
        </div>
      ),
    },
    { key: 'email', header: 'E-mail', cell: (r) => r.email ?? <span className="text-xs text-warn">Aucun e-mail</span>, hideBelow: 'md' },
    { key: 'country', header: 'Pays', cell: (r) => r.country ?? '—', hideBelow: 'lg' },
    { key: 'currency', header: 'Devise', cell: (r) => r.currency ?? '—' },
    { key: 'contacts', header: 'Contacts', align: 'right', cell: (r) => r.contacts.length, hideBelow: 'lg' },
    { key: 'active', header: 'Statut', cell: (r) => (r.isActive ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>) },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Fournisseurs' }]}
        title="Fournisseurs"
        description="Référentiel fournisseurs : coordonnées d’envoi des RFQ et BC, contacts, devise habituelle. Un fournisseur n’est jamais supprimé (historique des commandes) : il est désactivé."
        actions={
          can('suppliers.manage') && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau fournisseur
            </Button>
          )
        }
      />
      <FilterBar>
        <div className="min-w-[220px] flex-1">
          <label htmlFor="sup-search" className="mb-1 block text-xs font-medium text-ink-muted">
            Recherche
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
            <Input id="sup-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Nom, code, e-mail…" className="h-8 pl-8 text-sm" />
          </div>
        </div>
        <FilterSelect label="Statut" value={get('active')} onChange={(v) => set({ active: v || null })} className="w-36">
          <option value="">Tous</option>
          <option value="true">Actifs</option>
          <option value="false">Inactifs</option>
        </FilterSelect>
        <FilterText label="Pays" value={get('country')} onChange={(v) => set({ country: v.toUpperCase().slice(0, 2) || null })} placeholder="TN" className="w-20" />
        <FilterText label="Devise" value={get('currency')} onChange={(v) => set({ currency: v.toUpperCase().slice(0, 3) || null })} placeholder="EUR" className="w-24" />
        {(get('search') || get('active') || get('country') || get('currency')) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTerm('');
              router.replace(`/purchasing/suppliers${selected ? `?selected=${selected}` : ''}`);
            }}
          >
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>
      <div className={selected ? 'grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(340px,2fr)]' : ''}>
        <DataTable
          caption="Fournisseurs"
          columns={columns}
          rows={list.rows}
          loading={list.loading}
          error={list.error}
          onRetry={() => list.refetch()}
          onRowClick={(r) => set({ selected: r.id })}
          selectedId={selected}
          hasMore={list.hasMore}
          onLoadMore={list.loadMore}
          loadingMore={list.loadingMore}
          total={list.total}
          empty={<EmptyState title="Aucun fournisseur" />}
        />
        {selected && (
          <aside className="panel h-fit p-4 lg:sticky lg:top-4" aria-label="Fiche fournisseur">
            <SupplierPanel key={selected} id={selected} onClose={() => set({ selected: null })} />
          </aside>
        )}
      </div>
      {createOpen && <SupplierFormDialog onClose={() => setCreateOpen(false)} onSaved={(s) => set({ selected: s.id })} />}
    </>
  );
}
