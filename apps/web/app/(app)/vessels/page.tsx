'use client';

import { VESSEL_STATUS_LABELS } from '@amc/types';
import { Plus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { PermissionGate } from '@/components/amc/permission-gate';
import { StatusBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { Forbidden } from '@/components/ui/states';
import { VesselFormDialog, type VesselDto } from './vessel-form';

export default function VesselsPage() {
  const router = useRouter();
  const { can, refresh } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [creating, setCreating] = useState(false);
  const list = useCursorList<VesselDto>(['vessels'], '/vessels', { search: search || undefined, status: status || undefined }, can('vessels.view'));

  if (!can('vessels.view')) return <Forbidden />;
  return (
    <>
      <PageHeader
        title="Navires"
        description="Navires de votre périmètre. Un navire désactivé reste consultable dans l'historique."
        actions={
          <PermissionGate allOf={['vessels.create']}>
            <Button onClick={() => setCreating(true)}>
              <Plus className="h-4 w-4" aria-hidden /> Nouveau navire
            </Button>
          </PermissionGate>
        }
      />
      <FilterBar>
        <div className="w-full max-w-xs">
          <label className="field-label" htmlFor="vs-search">Recherche</label>
          <Input id="vs-search" placeholder="Nom, code, IMO" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="w-44">
          <label className="field-label" htmlFor="vs-status">Statut</label>
          <Select id="vs-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(VESSEL_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>
      <DataTable
        caption="Liste des navires"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        onRowClick={(v) => router.push(`/vessels/${v.id}`)}
        columns={[
          { key: 'name', header: 'Navire', cell: (v) => <span className="font-semibold text-navy">{v.name}</span> },
          { key: 'code', header: 'Code', cell: (v) => <span className="ref">{v.code}</span> },
          { key: 'imo', header: 'IMO', cell: (v) => <span className="ref">{v.imoNumber ?? '—'}</span> },
          { key: 'type', header: 'Type', cell: (v) => v.vesselType ?? '—', hideBelow: 'md' },
          { key: 'flag', header: 'Pavillon', cell: (v) => v.flag ?? '—', hideBelow: 'md' },
          { key: 'class', header: 'Classe', cell: (v) => v.classSociety ?? '—', hideBelow: 'lg' },
          { key: 'status', header: 'Statut', cell: (v) => <StatusBadge status={v.status} labels={VESSEL_STATUS_LABELS} /> },
        ]}
      />
      {creating && (
        <VesselFormDialog
          open={creating}
          onOpenChange={setCreating}
          onSaved={async (v) => {
            await refresh();
            list.refetch();
            if (v.accessible === false) {
              toast.success(`${v.name} créé. Il n'est pas dans votre périmètre : un administrateur doit vous y donner accès.`);
            } else {
              toast.success(`${v.name} créé`);
              router.push(`/vessels/${v.id}`);
            }
          }}
        />
      )}
    </>
  );
}
