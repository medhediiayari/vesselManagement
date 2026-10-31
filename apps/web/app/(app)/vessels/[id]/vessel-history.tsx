'use client';

import { VESSEL_STATUS_LABELS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { VESSEL_FIELD_LABELS } from '../vessel-form';

interface VesselHistoryEvent {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

const ACTION_LABELS: Record<string, string> = {
  'vessel.created': 'Fiche navire créée',
  'vessel.updated': 'Informations modifiées',
  'vessel.status_changed': 'Statut modifié',
  'vessel.photo_changed': 'Photo modifiée',
};

const FIELD_LABELS: Record<string, string> = { ...VESSEL_FIELD_LABELS, status: 'Statut', photoFileId: 'Photo' };
// Champs techniques jamais affichés (horodatages, identifiants internes)
const HIDDEN = new Set(['id', 'updatedAt', 'createdAt', 'createdById', 'companyId', 'lockVersion']);

function value(key: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return 'non renseigné';
  if (key === 'status') return VESSEL_STATUS_LABELS[String(v)] ?? String(v);
  if (key === 'photoFileId') return 'photo';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60);
  return String(v).slice(0, 80);
}

function changes(e: VesselHistoryEvent): string[] {
  // La création journalise la fiche complète : le libellé suffit
  if (e.action === 'vessel.created' || !e.before || !e.after) return [];
  return Object.keys(e.after)
    .filter((k) => !HIDDEN.has(k))
    .map((k) => `${FIELD_LABELS[k] ?? k} : ${value(k, e.before?.[k])} → ${value(k, e.after?.[k])}`);
}

/**
 * Historique des informations officielles du navire (audit FLT-10) : `/vessels/{id}/history`
 * ne demande que `vessels.view`, contrairement au journal d'audit général.
 */
export function VesselHistory({ vesselId }: { vesselId: string }) {
  const q = useQuery({
    queryKey: ['vessel-history', vesselId],
    queryFn: () => api.get<VesselHistoryEvent[]>(`/vessels/${vesselId}/history`),
  });
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = (q.data ?? []).filter((e) => e.action !== 'vessel.updated' || changes(e).length > 0);
  if (!items.length) return <EmptyState title="Aucun événement" description="Les modifications de la fiche apparaîtront ici." />;
  return (
    <ol className="relative ml-2 border-l border-line">
      {items.map((e) => {
        const lines = changes(e);
        const reason = typeof e.metadata?.reason === 'string' && e.metadata.reason ? e.metadata.reason : null;
        return (
          <li key={e.id} className="mb-4 ml-4">
            <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-teal" aria-hidden />
            <p className="text-sm font-medium text-ink">{ACTION_LABELS[e.action] ?? e.action}</p>
            <p className="text-xs text-ink-muted">
              <span className="tabular">{fmtDateTime(e.occurredAt)}</span> par {e.actorLabel ?? 'système'}
            </p>
            {lines.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
                {lines.map((c) => (
                  <li key={c} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>
            )}
            {reason && <p className="mt-1 text-xs text-ink-muted">Motif : {reason}</p>}
          </li>
        );
      })}
    </ol>
  );
}
