'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Anchor,
  BookOpenCheck,
  CalendarClock,
  CheckCircle2,
  CircleDot,
  FilePen,
  FileSignature,
  Flag,
  Navigation,
  Send,
  ShieldCheck,
  Ship,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { fmtUtc, voyageKeys } from './lib';
import type { TimelineEvent, VoyageWorkspace } from './types';

const ICONS: Record<string, { icon: LucideIcon; tone: string }> = {
  'voyage.created': { icon: FilePen, tone: 'bg-navy-50 text-navy' },
  'voyage.planned': { icon: CalendarClock, tone: 'bg-info-bg text-info' },
  'voyage.activated': { icon: Navigation, tone: 'bg-teal-50 text-teal-700' },
  'voyage.completed': { icon: Flag, tone: 'bg-ok-bg text-ok' },
  'voyage.cancelled': { icon: XCircle, tone: 'bg-danger-bg text-danger' },
  'voyage.schedule_updated': { icon: CalendarClock, tone: 'bg-navy-50 text-navy' },
  'voyage.charter_party_linked': { icon: FileSignature, tone: 'bg-navy-50 text-navy' },
  'instruction.issued': { icon: Send, tone: 'bg-info-bg text-info' },
  'instruction.acknowledged': { icon: BookOpenCheck, tone: 'bg-ok-bg text-ok' },
  'charter_party.approved': { icon: FileSignature, tone: 'bg-ok-bg text-ok' },
  'notice.validated': { icon: ShieldCheck, tone: 'bg-warn-bg text-warn' },
  'notice.sent': { icon: Send, tone: 'bg-ok-bg text-ok' },
  'port.arrival': { icon: Anchor, tone: 'bg-teal-50 text-teal-700' },
  'port.departure': { icon: Ship, tone: 'bg-teal-50 text-teal-700' },
  'nor.tendered': { icon: Flag, tone: 'bg-info-bg text-info' },
  'nor.accepted': { icon: CheckCircle2, tone: 'bg-ok-bg text-ok' },
  'task.done': { icon: CheckCircle2, tone: 'bg-ok-bg text-ok' },
  'noon.submitted': { icon: Navigation, tone: 'bg-info-bg text-info' },
  'noon.acknowledged': { icon: CheckCircle2, tone: 'bg-ok-bg text-ok' },
};

/** Chronologie maritime (voyage créé → instructions/CP → notices/escales → Noon Reports → clôture). */
export function TimelineTab({ ws }: { ws: VoyageWorkspace }) {
  const id = ws.overview.id;
  const q = useQuery({
    queryKey: voyageKeys.sub(id, 'timeline'),
    queryFn: () => api.get<TimelineEvent[]>(`/voyages/${id}/timeline`),
    initialData: ws.timeline,
    staleTime: 0,
  });
  return (
    <Panel title="Chronologie du voyage">
      {q.isLoading && <LoadingBlock rows={5} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && q.data.length === 0 && <EmptyState title="Aucun événement" />}
      {q.data && q.data.length > 0 && (
        <ol className="relative ml-3 border-l border-line">
          {q.data.map((e, i) => {
            const def = ICONS[e.kind] ?? { icon: CircleDot, tone: 'bg-neutral-bg text-neutral' };
            const Icon = def.icon;
            const comment = typeof e.details?.comment === 'string' ? e.details.comment : null;
            const isPort = e.kind.startsWith('port.') || e.kind.startsWith('nor.');
            const label =
              e.entityType === 'noon_report' && e.entityId ? (
                <Link href={`/noon-reports/${e.entityId}`} className="text-action hover:underline">
                  {e.label}
                </Link>
              ) : (
                e.label
              );
            return (
              <li key={`${e.kind}-${e.entityId ?? ''}-${i}`} className="mb-4 ml-5">
                <span className={`absolute -left-3 flex h-6 w-6 items-center justify-center rounded-full ring-4 ring-white ${def.tone}`} aria-hidden>
                  <Icon className="h-3.5 w-3.5" />
                </span>
                <p className="text-sm font-medium text-ink">{label}</p>
                <p className="text-xs text-ink-muted">
                  <time dateTime={e.at} className="tabular">
                    {isPort ? fmtUtc(e.at) : fmtDateTime(e.at)}
                  </time>
                  {e.actor ? ` — ${e.actor}` : ''}
                </p>
                {comment && <p className="mt-1 rounded-md bg-canvas px-2 py-1 text-xs text-ink">{comment}</p>}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}
