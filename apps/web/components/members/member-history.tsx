'use client';

import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { formatPlainValue } from './member-ui';
import { MEMBER_FIELD_LABELS, MEMBER_HISTORY_ACTION_LABELS, type MemberHistoryEvent } from './types';

const HIDDEN_KEYS = new Set(['id', 'companyId', 'createdAt', 'updatedAt', 'createdById']);

function changes(e: MemberHistoryEvent): { label: string; before: string; after: string }[] {
  const before = (e.before ?? {}) as Record<string, unknown>;
  const after = (e.after ?? {}) as Record<string, unknown>;
  const out: { label: string; before: string; after: string }[] = [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => !HIDDEN_KEYS.has(k));
  for (const k of keys) {
    if (k === 'customFields') {
      const b = (before.customFields ?? {}) as Record<string, unknown>;
      const a = (after.customFields ?? {}) as Record<string, unknown>;
      for (const ck of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
        out.push({ label: `Champ « ${ck} »`, before: formatPlainValue(ck, b[ck]), after: formatPlainValue(ck, a[ck]) });
      }
      continue;
    }
    // Création : seules les valeurs renseignées sont utiles
    if (e.action === 'member.created' && (after[k] === null || after[k] === undefined)) continue;
    out.push({ label: MEMBER_FIELD_LABELS[k] ?? k, before: formatPlainValue(k, before[k]), after: formatPlainValue(k, after[k]) });
  }
  return out;
}

/** Onglet Historique : événements d'audit de la fiche (before / after), lecture seule. */
export function MemberHistory({ memberId }: { memberId: string }) {
  const q = useQuery({ queryKey: ['member-history', memberId], queryFn: () => api.get<MemberHistoryEvent[]>(`/members/${memberId}/history`) });
  if (q.isLoading) return <LoadingBlock rows={4} />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const items = q.data ?? [];
  if (!items.length) return <EmptyState title="Aucun événement" description="Les modifications de la fiche apparaîtront ici." />;
  return (
    <ol className="relative ml-2 border-l border-line" aria-label="Historique de la fiche">
      {items.map((e) => {
        const list = changes(e);
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        const reason = typeof meta.reason === 'string' ? meta.reason : null;
        const created = e.action === 'member.created';
        return (
          <li key={e.id} className="mb-5 ml-4">
            <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-teal" aria-hidden />
            <p className="text-sm font-medium text-ink">{MEMBER_HISTORY_ACTION_LABELS[e.action] ?? e.action}</p>
            <p className="text-xs text-ink-muted">
              {fmtDateTime(e.occurredAt)} par {e.actorLabel ?? 'système'}
            </p>
            {meta.forcedDuplicate === true && (
              <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-warn">
                <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Enregistré malgré un doublon potentiel
              </p>
            )}
            {reason && <p className="mt-1 text-xs text-ink">Motif : {reason}</p>}
            {list.length > 0 && (
              <dl className="mt-1.5 grid max-w-3xl grid-cols-[minmax(0,180px)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
                {list.map((c) => (
                  <div key={c.label} className="contents">
                    <dt className="truncate text-ink-muted" title={c.label}>
                      {c.label}
                    </dt>
                    <dd className="break-words text-ink">
                      {created ? (
                        c.after
                      ) : (
                        <>
                          <span className="text-ink-muted line-through decoration-ink-soft">{c.before}</span>
                          <span aria-hidden> → </span>
                          <span className="sr-only"> devient </span>
                          {c.after}
                        </>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        );
      })}
    </ol>
  );
}
