'use client';

import { VOYAGE_STATUS_LABELS } from '@amc/types';
import { Plus, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { PermissionGate } from '@/components/amc/permission-gate';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { fmtLaycan, fmtUtc } from '@/components/voyages/lib';
import { VoyageStatusBadge } from '@/components/voyages/status';
import type { VoyageListItem } from '@/components/voyages/types';
import { VoyageFormDialog } from '@/components/voyages/voyage-form';

/** Recherche texte différée (évite une requête par frappe). */
function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function VoyagesList() {
  const router = useRouter();
  const sp = useSearchParams();
  const { can, me, currentVessel, selectedVesselIds } = useSession();
  const [vesselId, setVesselId] = useState(sp.get('vesselId') ?? currentVessel?.id ?? '');
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [charterer, setCharterer] = useState(sp.get('charterer') ?? '');
  const [search, setSearch] = useState(sp.get('search') ?? '');
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');
  const [creating, setCreating] = useState(false);

  // Le Vessel Switcher (un seul navire) pilote le filtre tant que l'URL n'impose rien
  useEffect(() => {
    if (!sp.get('vesselId')) setVesselId(currentVessel?.id ?? '');
  }, [currentVessel?.id, sp]);

  const chartererQ = useDebounced(charterer.trim());
  const searchQ = useDebounced(search.trim());
  const params = {
    vesselId: vesselId || undefined,
    status: status || undefined,
    charterer: chartererQ || undefined,
    search: searchQ || undefined,
    from: from || undefined,
    to: to || undefined,
  };
  const list = useCursorList<VoyageListItem>(['voyages'], '/voyages', params, can('voyages.view'));
  const filtered = !!(vesselId || status || charterer || search || from || to);

  if (!can('voyages.view')) return <Forbidden />;
  return (
    <>
      <PageHeader
        title="Voyages"
        description="Voyages de votre périmètre : escales, cargaison, notices & NOR, Charter Party, instructions et Noon Reports."
        actions={
          <PermissionGate allOf={['voyages.create']}>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau voyage
            </Button>
          </PermissionGate>
        }
      />
      <FilterBar>
        <div className="w-full sm:w-56">
          <label className="field-label" htmlFor="voy-vessel">
            Navire
          </label>
          <Select id="voy-vessel" value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
            <option value="">{me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : 'Tous mes navires'}</option>
            {me.accessibleVessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-40">
          <label className="field-label" htmlFor="voy-status">
            Statut
          </label>
          <Select id="voy-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(VOYAGE_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-48">
          <label className="field-label" htmlFor="voy-charterer">
            Charterer
          </label>
          <Input id="voy-charterer" value={charterer} onChange={(e) => setCharterer(e.target.value)} placeholder="Ex. SEMBODJA" />
        </div>
        <div className="w-full sm:w-56">
          <label className="field-label" htmlFor="voy-search">
            Recherche
          </label>
          <Input id="voy-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Référence, port, description" />
        </div>
        <div className="w-[calc(50%-4px)] sm:w-40">
          <label className="field-label" htmlFor="voy-from">
            Période du
          </label>
          <Input id="voy-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="tabular" />
        </div>
        <div className="w-[calc(50%-4px)] sm:w-40">
          <label className="field-label" htmlFor="voy-to">
            au
          </label>
          <Input id="voy-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} className="tabular" />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setVesselId('');
              setStatus('');
              setCharterer('');
              setSearch('');
              setFrom('');
              setTo('');
            }}
          >
            <X className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>
      {selectedVesselIds.length > 1 && !vesselId && (
        <p className="mb-2 text-xs text-ink-muted">Plusieurs navires sont sélectionnés dans le Vessel Switcher : choisissez-en un ci-dessus pour filtrer.</p>
      )}
      <DataTable
        caption="Liste des voyages"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        onRowClick={(v) => router.push(`/voyages/${v.id}`)}
        empty={
          <EmptyState
            title={filtered ? 'Aucun voyage ne correspond aux filtres' : 'Aucun voyage'}
            description={filtered ? 'Modifiez ou réinitialisez les filtres.' : 'Créez un voyage pour suivre escales, cargaison, notices et Noon Reports.'}
          />
        }
        columns={[
          {
            key: 'ref',
            header: 'Voyage',
            cell: (v) => (
              <span>
                <span className="ref font-medium text-navy">{v.reference}</span>
                {v.description && <span className="block max-w-xs truncate text-xs text-ink-muted">{v.description}</span>}
              </span>
            ),
          },
          { key: 'vessel', header: 'Navire', cell: (v) => v.vessel.name, hideBelow: 'md' },
          { key: 'status', header: 'Statut', cell: (v) => <VoyageStatusBadge status={v.status} /> },
          { key: 'charterer', header: 'Charterer', cell: (v) => v.charterer ?? '—', hideBelow: 'lg' },
          {
            key: 'route',
            header: 'Route',
            cell: (v) =>
              v.ports.length ? (
                <span className="text-sm">
                  {v.ports[0].portName} → {v.ports[v.ports.length - 1].portName}
                  {v.ports.length > 2 && <span className="text-xs text-ink-muted"> ({v.ports.length} escales)</span>}
                </span>
              ) : (
                '—'
              ),
            hideBelow: 'sm',
          },
          { key: 'laycan', header: 'Laycan', cell: (v) => <span className="whitespace-nowrap tabular">{fmtLaycan(v.laycanFrom, v.laycanTo, fmtDate)}</span>, hideBelow: 'lg' },
          { key: 'eta', header: 'ETA', cell: (v) => <span className="whitespace-nowrap tabular">{v.ata ? `ATA ${fmtUtc(v.ata)}` : fmtUtc(v.eta)}</span>, hideBelow: 'md' },
          { key: 'noon', header: 'Noon', cell: (v) => <span className="tabular">{v._count.noonReports}</span>, align: 'right', hideBelow: 'lg' },
        ]}
      />
      {creating && (
        <VoyageFormDialog
          open={creating}
          onOpenChange={setCreating}
          defaultVesselId={vesselId || currentVessel?.id}
          onSaved={(v) => router.push(`/voyages/${v.id}`)}
        />
      )}
    </>
  );
}

export default function VoyagesPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <VoyagesList />
    </Suspense>
  );
}
