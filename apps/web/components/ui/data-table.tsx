'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/format';
import { Button } from './button';
import { EmptyState, ErrorState, Skeleton } from './states';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  className?: string;
  /** Colonne masquée sous ce point de rupture (tablette / mobile) */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl' | '2xl';
  align?: 'left' | 'right' | 'center';
}

/** Regroupement facultatif des lignes (ex. BC par Purchase Request) : clé + en-tête de groupe. */
export interface RowGroup {
  key: string;
  header: ReactNode;
}

/**
 * Tableau dense paginé côté serveur (curseur). Ligne cliquable -> détail / panneau latéral.
 * Avec `groupBy`, les lignes chargées sont regroupées (ordre des groupes = première apparition) sous un en-tête.
 */
export function DataTable<T extends { id: string }>({
  columns,
  rows,
  loading,
  error,
  onRetry,
  onRowClick,
  selectedId,
  empty,
  hasMore,
  onLoadMore,
  loadingMore,
  total,
  caption,
  groupBy,
}: {
  columns: Column<T>[];
  rows: T[] | undefined;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  onRowClick?: (row: T) => void;
  selectedId?: string | null;
  empty?: ReactNode;
  hasMore?: boolean;
  onLoadMore?: () => void;
  loadingMore?: boolean;
  total?: number;
  caption?: string;
  groupBy?: (row: T, rowsOfGroup: T[]) => RowGroup;
}) {
  const hide = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell', xl: 'hidden xl:table-cell', '2xl': 'hidden 2xl:table-cell' };
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  // Groupes dans l'ordre de première apparition (la liste reste triée par le serveur à l'intérieur de chaque groupe)
  const groups: { key: string; rows: T[] }[] = [];
  if (groupBy && rows) {
    const index = new Map<string, { key: string; rows: T[] }>();
    for (const row of rows) {
      const key = groupBy(row, []).key;
      let g = index.get(key);
      if (!g) {
        g = { key, rows: [] };
        index.set(key, g);
        groups.push(g);
      }
      g.rows.push(row);
    }
  }
  const renderRow = (row: T) => (
    <tr
      key={row.id}
      data-selected={selectedId === row.id || undefined}
      className={cn(onRowClick && 'cursor-pointer')}
      onClick={onRowClick ? () => onRowClick(row) : undefined}
      onKeyDown={
        onRowClick
          ? (e) => {
              if (e.key === 'Enter') onRowClick(row);
            }
          : undefined
      }
      tabIndex={onRowClick ? 0 : undefined}
    >
      {columns.map((c) => (
        <td
          key={c.key}
          className={cn(c.hideBelow && hide[c.hideBelow], c.align === 'right' && 'text-right tabular', c.align === 'center' && 'text-center', c.className)}
        >
          {c.cell(row)}
        </td>
      ))}
    </tr>
  );
  return (
    <div className="overflow-hidden rounded-lg bg-white shadow-panel">
      {/* relative : les éléments sr-only (position absolue) restent dans la zone de défilement au lieu d'élargir la page */}
      <div className="relative overflow-x-auto">
        <table className="table-amc">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cn(c.hideBelow && hide[c.hideBelow], c.align === 'right' && 'text-right', c.className)}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading &&
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={`sk-${i}`}>
                  {columns.map((c) => (
                    <td key={c.key} className={cn(c.hideBelow && hide[c.hideBelow])}>
                      <Skeleton className="h-4 w-full max-w-[160px]" />
                    </td>
                  ))}
                </tr>
              ))}
            {!loading && !groupBy && rows?.map(renderRow)}
            {!loading &&
              groupBy &&
              groups.map((g) => (
                <GroupRows key={g.key} header={groupBy(g.rows[0], g.rows).header} colSpan={columns.length}>
                  {g.rows.map(renderRow)}
                </GroupRows>
              ))}
          </tbody>
        </table>
      </div>
      {!loading && rows && rows.length === 0 && (empty ?? <EmptyState title="Aucun résultat" description="Modifiez les filtres ou créez un nouvel élément." />)}
      {(hasMore || typeof total === 'number') && rows && rows.length > 0 && (
        <div className="flex items-center justify-between border-t border-line px-3 py-2 text-xs text-ink-muted">
          <span className="tabular">
            {rows.length}
            {typeof total === 'number' ? ` sur ${total}` : ''} élément(s)
          </span>
          {hasMore && onLoadMore && (
            <Button variant="secondary" size="sm" onClick={onLoadMore} loading={loadingMore}>
              Charger la suite
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function GroupRows({ header, colSpan, children }: { header: ReactNode; colSpan: number; children: ReactNode }) {
  return (
    <>
      <tr className="border-t-2 border-line-strong">
        <th scope="rowgroup" colSpan={colSpan} className="bg-surface-sunken px-3 py-2 text-left font-normal">
          {header}
        </th>
      </tr>
      {children}
    </>
  );
}
