'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api, type Page } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';

export interface AuditEvent {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  module: string;
  entityType: string;
  entityId: string | null;
  result: 'SUCCESS' | 'DENIED' | 'FAILURE';
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

function summarize(e: AuditEvent): string[] {
  if (!e.before || !e.after || typeof e.before !== 'object' || typeof e.after !== 'object') return [];
  return Object.keys(e.after)
    .slice(0, 6)
    .map((k) => `${k} : ${fmt((e.before as Record<string, unknown>)[k])} → ${fmt((e.after as Record<string, unknown>)[k])}`);
}

function fmt(v: unknown): string {
  if (v === null || v === undefined || v === '') return '∅';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 60);
}

/**
 * Historique d'une entité (Audit Log append-only). L'API filtre par permission
 * `audit.view.<module>` et scope navire : un 403 est affiché proprement.
 */
export function AuditTimeline({ entityType, entityId, module }: { entityType: string; entityId: string; module?: string }) {
  const q = useQuery({
    queryKey: ['audit', entityType, entityId, module],
    queryFn: () => api.get<Page<AuditEvent>>('/audit', { query: { entityType, entityId, module, limit: 100 } }),
  });
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data?.items ?? [];
  if (!items.length) return <EmptyState title="Aucun événement" description="Les actions sur cet élément apparaîtront ici." />;
  return (
    <ol className="relative ml-2 border-l border-line">
      {items.map((e) => {
        const changes = summarize(e);
        return (
          <li key={e.id} className="mb-4 ml-4">
            <span
              className={`absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full ${e.result === 'SUCCESS' ? 'bg-teal' : 'bg-danger'}`}
              aria-hidden
            />
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-ink">{e.action}</span>
              {e.result !== 'SUCCESS' && (
                <span className="inline-flex items-center gap-1 text-xs font-medium text-danger">
                  <ShieldAlert className="h-3 w-3" aria-hidden /> {e.result === 'DENIED' ? 'refusé' : 'échec'}
                </span>
              )}
            </div>
            <p className="text-xs text-ink-muted">
              {fmtDateTime(e.occurredAt)} par {e.actorLabel ?? 'système'}
            </p>
            {changes.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                {changes.map((c) => (
                  <li key={c} className="break-all">
                    {c}
                  </li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ol>
  );
}
