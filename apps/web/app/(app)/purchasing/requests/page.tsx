'use client';

import { PR_STATUS_LABELS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, Filter, Plus, RotateCcw, Search, UserRound } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Checkbox, Input } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { PRLineMiniProgress } from '@/components/purchasing/pr-line-progress';
import { LINE_BADGE_LABELS, PRIORITY_LABELS, purKeys, useDebounced, useUrlParams } from '@/components/purchasing/lib';
import type { PrListItem } from '@/components/purchasing/types';
import { ExportButton, FilterSelect, FilterText, PriorityBadge, PrStatusBadge } from '@/components/purchasing/ui';

const STATUS_PRESETS: Record<string, string> = {
  'SUBMITTED,UNDER_REVIEW,REVISED': 'À traiter (soumises, en revue, Counter-PR)',
  'APPROVED,SOURCING,PARTIALLY_ORDERED': 'À commander',
  'ORDERED,PARTIALLY_RECEIVED': 'En attente de livraison',
  'RECEIVED,CLOSED': 'Terminées',
};

const BADGE_ORDER = ['NOT_ORDERED', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'] as const;

export default function PurchaseRequestsPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <RequestsList />
    </Suspense>
  );
}

function RequestsList() {
  const router = useRouter();
  const { get, set, sp } = useUrlParams();
  const { can, me, selectedVesselIds } = useSession();
  const [term, setTerm] = useState(get('search'));
  const debounced = useDebounced(term.trim(), 300);
  const [category, setCategory] = useState(get('category'));
  const debouncedCategory = useDebounced(category.trim(), 400);

  useEffect(() => {
    if (debounced !== get('search')) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    if (debouncedCategory !== get('category')) set({ category: debouncedCategory || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedCategory]);

  // Navire : filtre explicite (URL, liens du dashboard) sinon navire unique du Vessel Switcher
  const switcherVessel = selectedVesselIds.length === 1 ? selectedVesselIds[0] : '';
  const vesselId = get('vesselId') || switcherVessel;
  const params = useMemo(
    () => ({
      vesselId: vesselId || undefined,
      status: get('status') || undefined,
      priority: get('priority') || undefined,
      departmentId: get('departmentId') || undefined,
      category: get('category') || undefined,
      requesterId: get('requesterId') || undefined,
      mine: get('mine') === 'true' ? 'true' : undefined,
      overdue: get('overdue') === 'true' ? 'true' : undefined,
      search: get('search') || undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<PrListItem>([...purKeys.prs], '/purchase-requests', params, can('pr.view'));

  const departments = useQuery({
    queryKey: ['departments', 'options'],
    queryFn: () => api.get<{ id: string; code: string; name: string }[]>('/departments'),
    enabled: can('departments.view') || can('users.view'),
    staleTime: 300_000,
  });
  const deptOptions = departments.data ?? me.departments;
  const categories = useMemo(() => [...new Set((list.rows ?? []).map((r) => r.category))].sort(), [list.rows]);

  if (!can('pr.view')) return <Forbidden />;

  const statusValue = get('status');
  const filtersActive = ['status', 'priority', 'departmentId', 'category', 'requesterId', 'mine', 'overdue', 'search', 'vesselId'].some((k) => !!get(k));

  const columns: Column<PrListItem>[] = [
    {
      key: 'number',
      header: 'PR',
      cell: (r) => (
        <div className="min-w-[160px] max-w-[240px]">
          <Link href={`/purchasing/requests/${r.id}`} className="ref whitespace-nowrap font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.number}
          </Link>
          <p className="truncate text-xs text-ink-muted" title={r.subject}>
            {r.subject}
          </p>
          {r.parent && <p className="truncate text-xs text-ink-soft">Sous-PR de {r.parent.number}</p>}
          {r.childCount > 0 && <p className="truncate text-xs text-ink-soft">Divisée en {r.childCount} sous-PR</p>}
          <p className="truncate text-xs text-ink-soft 2xl:hidden">{r.vessel.name}</p>
        </div>
      ),
    },
    { key: 'vessel', header: 'Navire', cell: (r) => <span className="whitespace-nowrap">{r.vessel.name}</span>, className: 'hidden 2xl:table-cell' },
    {
      key: 'requester',
      header: 'Demandeur',
      hideBelow: 'lg',
      cell: (r) => (
        <button
          type="button"
          className="inline-flex max-w-[150px] items-center gap-1 text-left text-sm hover:text-action hover:underline"
          title="Filtrer sur ce demandeur"
          onClick={(e) => {
            e.stopPropagation();
            set({ requesterId: r.requesterId, mine: null });
          }}
        >
          <UserRound className="h-3.5 w-3.5 shrink-0 text-ink-muted" aria-hidden />
          <span className="truncate" title={r.requesterName ?? undefined}>
            {r.requesterName ?? '—'}
          </span>
        </button>
      ),
    },
    { key: 'category', header: 'Catégorie', cell: (r) => <span className="line-clamp-2 max-w-[140px]">{r.category}</span>, className: 'hidden 2xl:table-cell' },
    { key: 'priority', header: 'Priorité', cell: (r) => <PriorityBadge priority={r.priority} />, hideBelow: 'lg' },
    {
      key: 'neededBy',
      header: 'Besoin',
      cell: (r) => (
        <div className="whitespace-nowrap">
          <span className="tabular">{fmtDate(r.neededBy)}</span>
          {r.overdue && (
            <span className="mt-0.5 block">
              <Badge tone="danger" icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
                En retard
              </Badge>
            </span>
          )}
        </div>
      ),
    },
    { key: 'status', header: 'Statut', cell: (r) => <PrStatusBadge status={r.status} /> },
    {
      key: 'progress',
      header: 'Avancement par ligne',
      cell: (r) => <ProgressCell row={r} />,
    },
  ];

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Purchase Requests' }]}
        title="Purchase Requests"
        description="Demandes d'achat des navires : chaque ligne a son propre avancement (commandé, sur BL, reçu, reste). Les manquants restent visibles jusqu'à réception ou clôture documentée."
        actions={
          <>
            {can('reports.export') && <ExportButton path="/purchasing/exports/purchase-requests.xlsx" query={params as Record<string, string | undefined>} />}
            {can('pr.create') && (
              <Button onClick={() => router.push('/purchasing/requests/new')}>
                <Plus className="h-4 w-4" aria-hidden /> Nouvelle PR
              </Button>
            )}
          </>
        }
      />

      <FilterBar>
        <div className="min-w-[220px] flex-1">
          <label htmlFor="pr-search" className="mb-1 block text-xs font-medium text-ink-muted">
            Recherche
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
            <Input id="pr-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="N° PR, objet, désignation, référence…" className="h-8 pl-8 text-sm" />
          </div>
        </div>
        <FilterSelect label="Navire" value={get('vesselId')} onChange={(v) => set({ vesselId: v || null })} className="w-44">
          <option value="">{switcherVessel ? 'Navire du sélecteur' : 'Tous mes navires'}</option>
          {me.accessibleVessels.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Statut" value={statusValue} onChange={(v) => set({ status: v || null })} className="w-52">
          <option value="">Tous</option>
          <optgroup label="Regroupements">
            {Object.entries(STATUS_PRESETS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </optgroup>
          <optgroup label="Statut">
            {Object.entries(PR_STATUS_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </optgroup>
          {statusValue && !STATUS_PRESETS[statusValue] && !PR_STATUS_LABELS[statusValue] && (
            <option value={statusValue}>{statusValue.split(',').map((s) => PR_STATUS_LABELS[s] ?? s).join(', ')}</option>
          )}
        </FilterSelect>
        <FilterSelect label="Priorité" value={get('priority')} onChange={(v) => set({ priority: v || null })} className="w-32">
          <option value="">Toutes</option>
          {Object.entries(PRIORITY_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
          <option value="HIGH,URGENT">Haute ou urgente</option>
        </FilterSelect>
        <FilterSelect label="Département" value={get('departmentId')} onChange={(v) => set({ departmentId: v || null })} className="w-44">
          <option value="">Tous</option>
          {deptOptions.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </FilterSelect>
        <FilterText label="Catégorie" value={category} onChange={setCategory} placeholder="ex. Consommable machine" className="w-44" list="pr-categories" />
        <datalist id="pr-categories">
          {categories.map((c) => (
            <option key={c} value={c} />
          ))}
        </datalist>
        <div className="flex flex-col gap-1.5 pb-1">
          <Checkbox label="Mes PR" checked={get('mine') === 'true'} onChange={(e) => set({ mine: e.target.checked ? 'true' : null, requesterId: null })} />
          <Checkbox label="En retard" checked={get('overdue') === 'true'} onChange={(e) => set({ overdue: e.target.checked ? 'true' : null })} />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setTerm('');
              setCategory('');
              router.replace('/purchasing/requests');
            }}
          >
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>

      {get('requesterId') && (
        <p className="mb-2 flex items-center gap-2 text-sm text-ink-muted">
          <Filter className="h-4 w-4" aria-hidden /> Filtré sur un demandeur.
          <button type="button" className="text-action hover:underline" onClick={() => set({ requesterId: null })}>
            Retirer ce filtre
          </button>
        </p>
      )}

      <DataTable
        caption="Liste des Purchase Requests"
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        onRowClick={(r) => router.push(`/purchasing/requests/${r.id}`)}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        empty={
          <EmptyState
            title="Aucune PR"
            description={filtersActive ? 'Aucune PR ne correspond aux filtres.' : 'Les demandes d’achat de vos navires apparaîtront ici.'}
            action={
              can('pr.create') ? (
                <Button onClick={() => router.push('/purchasing/requests/new')}>
                  <Plus className="h-4 w-4" aria-hidden /> Nouvelle PR
                </Button>
              ) : undefined
            }
          />
        }
      />
    </>
  );
}

const SHORT: Record<string, [string, string]> = {
  RECEIVED: ['reçue(s)', 'text-ok'],
  PARTIALLY_RECEIVED: ['part. reçue(s)', 'text-warn'],
  ORDERED: ['commandée(s)', 'text-info'],
  PARTIALLY_ORDERED: ['part. commandée(s)', 'text-warn'],
  NOT_ORDERED: ['non commandée(s)', 'text-ink-muted'],
  CANCELLED: ['annulée(s)', 'text-ink-soft'],
};

function ProgressCell({ row }: { row: PrListItem }) {
  if (!row.lineCount) return <span className="text-xs text-ink-muted">Aucune ligne</span>;
  const shown = row.lines.slice(0, 8);
  const active = !['DRAFT', 'CANCELLED', 'REJECTED'].includes(row.status);
  return (
    <div className="w-[200px] space-y-1">
      <div className="grid grid-cols-8 gap-0.5">
        {shown.map((l) => (
          <div key={l.id} title={`L${l.lineNo} ${l.designation} — ${LINE_BADGE_LABELS[l.badge]} : commandé ${l.ordered}/${l.effective} ${l.unit}, reçu ${l.accepted}`}>
            <PRLineMiniProgress line={l} />
          </div>
        ))}
      </div>
      <p className="text-[11px] leading-4">
        <span className="text-ink-muted">{row.lineCount} ligne(s){active ? ' : ' : ''}</span>
        {active &&
          BADGE_ORDER.filter((b) => row.badges[b]).map((b, i) => (
            <span key={b} className={SHORT[b][1]}>
              {i > 0 && <span className="text-ink-soft"> · </span>}
              {row.badges[b]} {SHORT[b][0]}
            </span>
          ))}
      </p>
    </div>
  );
}
