'use client';

import { Lock, Plus, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { CpFormDialog } from '@/components/voyages/cp-form';
import { CP_STATUS_LABELS, CP_TYPE_LABELS, CP_VERSION_KIND_LABELS, fmtLaycan } from '@/components/voyages/lib';
import { CpStatusBadge } from '@/components/voyages/status';
import type { CpListItem } from '@/components/voyages/types';
import { CreatedBy } from '@/components/amc/created-by';

function CharterPartiesList() {
  const router = useRouter();
  const sp = useSearchParams();
  const { can, me, currentVessel } = useSession();
  const [vesselId, setVesselId] = useState(sp.get('vesselId') ?? currentVessel?.id ?? '');
  const [status, setStatus] = useState(sp.get('status') ?? '');
  const [search, setSearch] = useState(sp.get('search') ?? '');
  const [searchQ, setSearchQ] = useState(search);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setSearchQ(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => {
    if (!sp.get('vesselId')) setVesselId(currentVessel?.id ?? '');
  }, [currentVessel?.id, sp]);

  const list = useCursorList<CpListItem>(
    ['charter-parties'],
    '/charter-parties',
    { vesselId: vesselId || undefined, status: status || undefined, search: searchQ || undefined },
    can('charter_party.view'),
  );
  const filtered = !!(vesselId || status || searchQ);

  if (!can('charter_party.view')) return <Forbidden message="Les Charter Parties sont confidentielles : permission charter_party.view requise." />;
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            Charter Parties
            <Lock className="h-5 w-5 text-ink-muted" aria-label="Confidentiel" />
          </span>
        }
        description="Contrats confidentiels : clauses stockées en texte contrôlé, versions officielles approuvées par un autre utilisateur habilité, accusés de lecture du Master."
        actions={
          can('charter_party.manage') && (
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nouvelle Charter Party
            </Button>
          )
        }
      />
      <FilterBar>
        <div className="w-full sm:w-56">
          <label className="field-label" htmlFor="cp-vessel">
            Navire
          </label>
          <Select id="cp-vessel" value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
            <option value="">{me.vesselScope === 'ALL_FLEET' ? 'Toute la flotte' : 'Tous mes navires'}</option>
            {me.accessibleVessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-52">
          <label className="field-label" htmlFor="cp-status">
            Statut
          </label>
          <Select id="cp-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(CP_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-full sm:w-64">
          <label className="field-label" htmlFor="cp-search">
            Recherche
          </label>
          <Input id="cp-search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Référence, charterer, owner" />
        </div>
        {filtered && (
          <Button
            variant="ghost"
            onClick={() => {
              setVesselId('');
              setStatus('');
              setSearch('');
            }}
          >
            <X className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>
      <DataTable
        caption="Charter Parties"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        onRowClick={(cp) => router.push(`/charter-parties/${cp.id}`)}
        empty={<EmptyState title={filtered ? 'Aucune Charter Party ne correspond aux filtres' : 'Aucune Charter Party'} />}
        columns={[
          {
            key: 'ref',
            header: 'Référence',
            cell: (cp) => (
              <span>
                <span className="ref font-medium text-navy">{cp.reference}</span>
                <span className="block text-xs text-ink-muted">{CP_TYPE_LABELS[cp.cpType] ?? cp.cpType}</span>
              </span>
            ),
          },
          { key: 'vessel', header: 'Navire', cell: (cp) => cp.vessel?.name ?? '—', hideBelow: 'md' },
          { key: 'charterer', header: 'Charterer', cell: (cp) => cp.charterer ?? '—', hideBelow: 'sm' },
          { key: 'laycan', header: 'Laycan', cell: (cp) => <span className="whitespace-nowrap tabular">{fmtLaycan(cp.laycanFrom, cp.laycanTo, fmtDate)}</span>, hideBelow: 'lg' },
          { key: 'status', header: 'Statut', cell: (cp) => <CpStatusBadge status={cp.status} /> },
          {
            key: 'version',
            header: 'Version en vigueur',
            cell: (cp) => (cp.currentVersion ? `v${cp.currentVersion.versionNo} — ${CP_VERSION_KIND_LABELS[cp.currentVersion.kind]}` : '—'),
            hideBelow: 'md',
          },
          { key: 'voyages', header: 'Voyages', cell: (cp) => (cp.voyages.length ? cp.voyages.map((v) => v.reference).join(', ') : '—'), hideBelow: 'lg' },
          { key: 'createdBy', header: 'Créée par', cell: (cp) => <CreatedBy by={cp.createdBy} at={cp.createdAt} compact />, hideBelow: 'md' },
        ]}
      />
      <CpFormDialog
        open={creating}
        onOpenChange={setCreating}
        prefill={{ vesselId: vesselId || currentVessel?.id || null, cpType: 'VOYAGE' }}
        onSaved={(cp) => router.push(`/charter-parties/${cp.id}`)}
      />
    </>
  );
}

export default function CharterPartiesPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <CharterPartiesList />
    </Suspense>
  );
}
