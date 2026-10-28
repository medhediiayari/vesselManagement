'use client';

import { NOON_STATUS_LABELS } from '@amc/types';
import { Plus } from 'lucide-react';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Panel } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/states';
import { NoonTable } from '@/components/noon/noon-table';
import type { NoonListItem } from '@/components/noon/types';
import { LinkButton } from './common';
import type { VoyageWorkspace } from './types';

export function NoonTab({ ws }: { ws: VoyageWorkspace }) {
  const { can } = useSession();
  const id = ws.overview.id;
  const list = useCursorList<NoonListItem>(['noon-reports', 'voyage', id], '/noon-reports', { voyageId: id });
  const reportable = ws.overview.status === 'PLANNED' || ws.overview.status === 'ACTIVE';
  const byStatus = ws.noonReports?.byStatus ?? {};
  return (
    <Panel
      title="Noon Reports du voyage"
      actions={
        can('noon.create') &&
        reportable && (
          <LinkButton href={`/noon-reports/new?voyageId=${id}`} variant="primary">
            <Plus className="h-4 w-4" aria-hidden /> Nouveau Noon Report
          </LinkButton>
        )
      }
      bodyClassName="space-y-3"
    >
      {Object.keys(byStatus).length > 0 && (
        <p className="text-sm text-ink-muted">
          {Object.entries(byStatus)
            .map(([s, n]) => `${n} ${(NOON_STATUS_LABELS[s] ?? s).toLowerCase()}`)
            .join(' · ')}
        </p>
      )}
      {!reportable && <p className="text-sm text-ink-muted">Un Noon Report ne peut être saisi que sur un voyage planifié ou en cours.</p>}
      <NoonTable
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        showVessel={false}
        showVoyage={false}
        empty={<EmptyState title="Aucun Noon Report" description="Les rapports Noon / Midnight / Arrival / Departure de ce voyage apparaîtront ici." />}
      />
    </Panel>
  );
}
