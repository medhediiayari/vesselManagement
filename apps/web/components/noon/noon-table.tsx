'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { fmtDecimal } from '@/lib/format';
import { DataTable, type Column } from '@/components/ui/data-table';
import { NoonStatusBadge } from '@/components/voyages/status';
import { REPORT_TYPE_LABELS, formatPosition, localLabel } from './lib';
import type { NoonListItem } from './types';

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** Ancienneté d'un brouillon depuis sa dernière modification (audit FLT-25). */
function draftAge(updatedAt: string): string {
  const days = Math.floor((Date.now() - Date.parse(updatedAt)) / 86_400_000);
  return days <= 0 ? "modifié aujourd'hui" : `inchangé depuis ${days} j`;
}

/** Liste dense des Noon Reports (pagination serveur par curseur). */
export function NoonTable({
  rows,
  loading,
  error,
  onRetry,
  hasMore,
  onLoadMore,
  loadingMore,
  total,
  showVessel = true,
  showVoyage = true,
  empty,
}: {
  rows: NoonListItem[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  total?: number;
  showVessel?: boolean;
  showVoyage?: boolean;
  empty?: ReactNode;
}) {
  const router = useRouter();
  const columns: Column<NoonListItem>[] = [
    {
      key: 'date',
      header: 'Date du rapport',
      cell: (r) => (
        <span className="tabular">
          <span className="font-medium text-navy">{utc(r.reportDateUtc)}</span>
          <span className="block text-xs text-ink-muted">Local {localLabel(r.reportDateUtc, r.utcOffsetMinutes)}</span>
        </span>
      ),
    },
    { key: 'type', header: 'Type', cell: (r) => REPORT_TYPE_LABELS[r.reportType] ?? r.reportType },
    ...(showVessel ? [{ key: 'vessel', header: 'Navire', cell: (r: NoonListItem) => r.vessel.name, hideBelow: 'md' as const }] : []),
    ...(showVoyage ? [{ key: 'voyage', header: 'Voyage', cell: (r: NoonListItem) => <span className="ref">{r.voyage.reference}</span>, hideBelow: 'md' as const }] : []),
    { key: 'pos', header: 'Position', cell: (r) => <span className="whitespace-nowrap text-xs tabular">{formatPosition(r.latitude, r.longitude)}</span>, hideBelow: 'lg' },
    {
      key: 'speed',
      header: 'Vitesse / cap',
      cell: (r) => (
        <span className="tabular">
          {r.speedKnots !== null ? `${fmtDecimal(r.speedKnots, 2)} kn` : '—'}
          {r.courseDeg !== null ? ` · ${fmtDecimal(r.courseDeg, 1)}°` : ''}
        </span>
      ),
      hideBelow: 'sm',
    },
    {
      key: 'status',
      header: 'Statut',
      cell: (r) => (
        <span>
          <NoonStatusBadge status={r.status} />
          {r.status === 'DRAFT' && (
            <span className="mt-0.5 block whitespace-nowrap text-xs text-ink-muted">
              {draftAge(r.updatedAt)}
              {r.pendingIssues ? <span className="text-warn"> · {r.pendingIssues} point(s) à compléter</span> : null}
            </span>
          )}
        </span>
      ),
    },
    { key: 'rev', header: 'Rév.', cell: (r) => <span className="tabular">{r.currentRevisionNo || '—'}</span>, align: 'right', hideBelow: 'sm' },
  ];
  return (
    <DataTable
      caption="Noon Reports"
      rows={rows}
      loading={loading}
      error={error}
      onRetry={onRetry}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      loadingMore={loadingMore}
      total={total}
      onRowClick={(r) => router.push(`/noon-reports/${r.id}`)}
      columns={columns}
      empty={empty}
    />
  );
}
