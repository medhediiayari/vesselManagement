'use client';

import { NOON_STATUS_LABELS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { Plus, X } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, type Page } from '@/lib/api';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { REPORT_TYPE_LABELS } from '@/components/noon/lib';
import { NoonTable } from '@/components/noon/noon-table';
import type { NoonListItem } from '@/components/noon/types';
import { LinkButton } from '@/components/voyages/common';
import type { VoyageListItem } from '@/components/voyages/types';

function NoonReportsList() {
  const sp = useSearchParams();
  const { can, me, currentVessel } = useSession();
  const [vesselId, setVesselId] = useState(sp.get('vesselId') ?? currentVessel?.id ?? '');
  const [voyageId, setVoyageId] = useState(sp.get('voyageId') ?? '');
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [reportType, setReportType] = useState(sp.get('reportType') ?? '');
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');

  useEffect(() => {
    if (!sp.get('vesselId')) setVesselId(currentVessel?.id ?? '');
  }, [currentVessel?.id, sp]);

  const voyages = useQuery({
    queryKey: ['voyages', 'options', vesselId],
    queryFn: () => api.get<Page<VoyageListItem>>('/voyages', { query: { vesselId: vesselId || undefined, limit: 200 } }),
    enabled: can('voyages.view'),
  });
  const list = useCursorList<NoonListItem>(
    ['noon-reports'],
    '/noon-reports',
    {
      vesselId: vesselId || undefined,
      voyageId: voyageId || undefined,
      status: status || undefined,
      reportType: reportType || undefined,
      from: from || undefined,
      to: to || undefined,
    },
    can('noon.view'),
  );
  const filtered = !!(vesselId || voyageId || status || reportType || from || to);

  if (!can('noon.view')) return <Forbidden />;
  return (
    <>
      <PageHeader
        title="Noon Reports"
        description="Rapports de bord (formulaire AMC en 7 sections) rattachés à un navire et un voyage. Après soumission, chaque version est figée avec son PDF."
        actions={
          can('noon.create') && (
            <LinkButton href={voyageId ? `/noon-reports/new?voyageId=${voyageId}` : '/noon-reports/new'} variant="primary" size="md">
              <Plus className="h-4 w-4" aria-hidden /> Nouveau Noon Report
            </LinkButton>
          )
        }
      />
      <FilterBar>
        <div className="w-full sm:w-52">
          <label className="field-label" htmlFor="nr-vessel">
            Navire
          </label>
          <Select
            id="nr-vessel"
            value={vesselId}
            onChange={(e) => {
              setVesselId(e.target.value);
              setVoyageId('');
            }}
          >
            <option value="">{me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : 'Tous mes navires'}</option>
            {me.accessibleVessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-52">
          <label className="field-label" htmlFor="nr-voyage">
            Voyage
          </label>
          <Select id="nr-voyage" value={voyageId} onChange={(e) => setVoyageId(e.target.value)}>
            <option value="">Tous</option>
            {voyages.data?.items.map((v) => (
              <option key={v.id} value={v.id}>
                {v.reference}
                {vesselId ? '' : ` — ${v.vessel.name}`}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-44">
          <label className="field-label" htmlFor="nr-status">
            Statut
          </label>
          <Select id="nr-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(NOON_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-32">
          <label className="field-label" htmlFor="nr-type">
            Type
          </label>
          <Select id="nr-type" value={reportType} onChange={(e) => setReportType(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(REPORT_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-4px)] sm:w-40">
          <label className="field-label" htmlFor="nr-from">
            Du (UTC)
          </label>
          <Input id="nr-from" type="date" className="tabular" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="w-[calc(50%-4px)] sm:w-40">
          <label className="field-label" htmlFor="nr-to">
            au
          </label>
          <Input id="nr-to" type="date" className="tabular" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setVesselId('');
              setVoyageId('');
              setStatus('');
              setReportType('');
              setFrom('');
              setTo('');
            }}
          >
            <X className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>
      <NoonTable
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        empty={
          <EmptyState
            title={filtered ? 'Aucun Noon Report ne correspond aux filtres' : 'Aucun Noon Report'}
            description={filtered ? 'Modifiez ou réinitialisez les filtres.' : 'Les rapports Noon / Midnight / Arrival / Departure apparaîtront ici.'}
          />
        }
      />
    </>
  );
}

export default function NoonReportsPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <NoonReportsList />
    </Suspense>
  );
}
