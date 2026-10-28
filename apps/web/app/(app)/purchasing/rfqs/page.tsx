'use client';

import { RFQ_STATUS_LABELS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { AlarmClock, CheckCircle2, ClipboardCheck, FilePen, FileText, Inbox, Plus, RotateCcw, Search, Send, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { useMediaQuery } from '@/components/certificates/lib';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Input } from '@/components/ui/field';
import { KpiTiles, type KpiTile } from '@/components/ui/kpi-tiles';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { RFQ_SUPPLIER_STATUS_LABELS, isPast, purKeys, useDebounced, useUrlParams } from '@/components/purchasing/lib';
import { RfqPanel } from '@/components/purchasing/rfq-panel';
import type { RfqListItem, RfqStats } from '@/components/purchasing/types';
import { FilterSelect, RfqStatusBadge, useSuppliers } from '@/components/purchasing/ui';

/** Liste maître / détail à partir de cette largeur ; en dessous, une ligne ouvre la fiche RFQ. */
const WIDE = '(min-width: 1500px)';
const OPEN_STATUSES = 'DRAFT,ISSUED,QUOTED';

export default function RfqListPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <RfqList />
    </Suspense>
  );
}

function SuppliersCell({ r }: { r: RfqListItem }) {
  if (!r.suppliers.length) return <span className="text-xs text-ink-muted">Aucun</span>;
  const counts = r.suppliers.reduce<Record<string, number>>((a, s) => ({ ...a, [s.status]: (a[s.status] ?? 0) + 1 }), {});
  return (
    <div className="flex max-w-[200px] flex-wrap gap-1" title={r.suppliers.map((s) => `${s.supplier.name} : ${RFQ_SUPPLIER_STATUS_LABELS[s.status]}`).join('\n')}>
      {Object.entries(counts).map(([st, n]) => (
        <Badge key={st} tone={st === 'SEND_FAILED' ? 'danger' : st === 'QUOTED' ? 'info' : st === 'SENT' ? 'ok' : 'neutral'}>
          {n} {RFQ_SUPPLIER_STATUS_LABELS[st].toLowerCase()}
        </Badge>
      ))}
    </div>
  );
}

function DeadlineCell({ r }: { r: RfqListItem }) {
  if (!r.deadline) return <span className="text-ink-soft">—</span>;
  const late = r.status === 'ISSUED' && isPast(r.deadline);
  return (
    <span className="flex flex-col items-start gap-0.5 whitespace-nowrap">
      <span className={cn('tabular', late && 'font-semibold text-danger')}>{fmtDate(r.deadline)}</span>
      {late && (
        <Badge tone="danger" icon={<AlarmClock className="h-3.5 w-3.5" aria-hidden />}>
          À relancer
        </Badge>
      )}
    </span>
  );
}

function RfqList() {
  const router = useRouter();
  const { get, set, sp } = useUrlParams();
  const { can, me, selectedVesselIds } = useSession();
  const wide = useMediaQuery(WIDE);
  const [term, setTerm] = useState(get('search'));
  const debounced = useDebounced(term.trim(), 300);
  useEffect(() => {
    if (debounced !== get('search')) set({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  const switcherVessel = selectedVesselIds.length === 1 ? selectedVesselIds[0] : '';
  const vesselId = get('vesselId') || switcherVessel;
  const params = useMemo(
    () => ({
      vesselId: vesselId || undefined,
      status: get('status') || undefined,
      supplierId: get('supplierId') || undefined,
      prId: get('prId') || undefined,
      search: get('search') || undefined,
      from: get('from') || undefined,
      to: get('to') || undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<RfqListItem>([...purKeys.rfqs], '/rfqs', params, can('rfq.view'));
  const stats = useQuery({
    queryKey: [...purKeys.rfqs, 'stats', vesselId],
    queryFn: () => api.get<RfqStats>('/rfqs/stats', { query: { vesselId: vesselId || undefined } }),
    enabled: can('rfq.view'),
  });
  const suppliers = useSuppliers('', false, can('suppliers.view'));

  // Sélection (grand écran) : première RFQ présentée d'emblée, comme une liste maître / détail
  const [selected, setSelected] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const firstId = list.rows?.[0]?.id ?? null;
  useEffect(() => {
    if (selected && list.rows && !list.rows.some((r) => r.id === selected)) setSelected(null);
    if (!selected && !dismissed && wide && firstId) setSelected(firstId);
  }, [firstId, list.rows, selected, dismissed, wide]);

  if (!can('rfq.view')) return <Forbidden />;
  const statusValue = get('status');
  const panelOpen = wide && !!selected;
  const selectedRow = list.rows?.find((r) => r.id === selected);
  const s = stats.data;
  const n = (k: keyof NonNullable<RfqStats['byStatus']>) => s?.byStatus[k] ?? 0;
  const statusTile = (status: string) => ({ active: statusValue === status, onClick: () => set({ status: statusValue === status ? null : status }) });

  const tiles: KpiTile[] = s
    ? [
        { key: 'all', icon: FileText, tone: 'navy', value: s.total, label: 'RFQ', sub: `${n('DRAFT') + n('ISSUED') + n('QUOTED')} en cours`, ...statusTile(OPEN_STATUSES) },
        { key: 'draft', icon: FilePen, tone: 'neutral', value: n('DRAFT'), label: 'Brouillons', sub: 'À compléter et émettre', ...statusTile('DRAFT') },
        {
          key: 'issued',
          icon: Send,
          tone: 'info',
          value: n('ISSUED'),
          label: 'En attente de devis',
          sub: s.toFollowUp ? <span className="font-medium text-danger">{s.toFollowUp} à relancer (date dépassée)</span> : 'Fournisseurs consultés',
          ...statusTile('ISSUED'),
        },
        { key: 'quoted', icon: Inbox, tone: 'warn', value: n('QUOTED'), label: 'Devis reçus', sub: 'À comparer', ...statusTile('QUOTED') },
        { key: 'evaluated', icon: ClipboardCheck, tone: 'ok', value: n('EVALUATED'), label: 'Évaluées', sub: 'Sélection justifiée', ...statusTile('EVALUATED') },
        { key: 'po', icon: ShoppingCart, tone: 'teal', value: s.withPurchaseOrder, label: 'Converties en BC', sub: 'Au moins un BC actif', href: '/purchasing/orders' },
      ]
    : [];

  const full: Column<RfqListItem>[] = [
    {
      key: 'number',
      header: 'RFQ / objet',
      cell: (r) => (
        <div className="min-w-[170px] max-w-[260px]">
          <Link href={`/purchasing/rfqs/${r.id}`} className="ref font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.number}
          </Link>
          <p className="truncate text-xs text-ink-muted" title={r.title}>
            {r.title}
          </p>
        </div>
      ),
    },
    { key: 'date', header: 'Créée le', cell: (r) => <span className="tabular whitespace-nowrap">{fmtDate(r.createdAt)}</span>, hideBelow: 'lg' },
    { key: 'vessel', header: 'Navire', cell: (r) => <span className="whitespace-nowrap font-medium text-navy">{r.vessel.name}</span>, hideBelow: 'md' },
    { key: 'by', header: 'Créée par', cell: (r) => <span className="block max-w-[140px] truncate">{r.createdByName ?? '—'}</span>, hideBelow: '2xl' },
    {
      key: 'pr',
      header: 'PR source',
      cell: (r) =>
        r.prs.length ? (
          <span className="flex flex-col">
            {r.prs.slice(0, 2).map((p) => (
              <Link key={p.id} href={`/purchasing/requests/${p.id}`} className="ref whitespace-nowrap text-xs text-action hover:underline" onClick={(e) => e.stopPropagation()}>
                {p.number}
              </Link>
            ))}
            {r.prs.length > 2 && <span className="text-xs text-ink-muted">+{r.prs.length - 2}</span>}
          </span>
        ) : (
          <span className="text-ink-soft">—</span>
        ),
      hideBelow: '2xl',
    },
    { key: 'suppliers', header: 'Fournisseurs', cell: (r) => <SuppliersCell r={r} />, hideBelow: 'lg' },
    {
      key: 'quotes',
      header: 'Devis',
      align: 'right',
      cell: (r) => (
        <span className="tabular whitespace-nowrap" title={`${r.quotationsReceived} devis reçu(s) pour ${r.suppliers.length} fournisseur(s) consulté(s)`}>
          {r.quotationsReceived} / {r.suppliers.length}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Statut',
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <RfqStatusBadge status={r.status} />
          {r.hasPurchaseOrder && (
            <Badge tone="ok" icon={<CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}>
              BC créé
            </Badge>
          )}
        </span>
      ),
    },
    { key: 'deadline', header: 'Date limite', cell: (r) => <DeadlineCell r={r} /> },
  ];
  // Panneau ouvert : colonnes essentielles pour garder la liste lisible sans défilement
  const columns = panelOpen ? full.filter((c) => ['number', 'vessel', 'quotes', 'status', 'deadline'].includes(c.key)) : full;
  const filtersActive = ['status', 'supplierId', 'search', 'vesselId', 'prId', 'from', 'to'].some((k) => !!get(k));

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'RFQ & devis' }]}
        title="Demandes de prix (RFQ)"
        description="Consultation des fournisseurs à partir des lignes PR, réception et comparaison des devis (sans conversion de devise), sélection justifiée puis bon de commande."
        actions={
          can('rfq.manage') && (
            <Button onClick={() => router.push('/purchasing/rfqs/new')}>
              <Plus className="h-4 w-4" aria-hidden /> Nouvelle RFQ
            </Button>
          )
        }
      />

      <KpiTiles tiles={tiles} loading={stats.isLoading} label="Indicateurs des RFQ" className="min-[1500px]:grid-cols-6" />

      <FilterBar className="mb-4">
        <div className="min-w-[200px] flex-1">
          <label htmlFor="rfq-search" className="mb-1 block text-xs font-medium text-ink-muted">
            Recherche
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
            <Input id="rfq-search" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="N° RFQ, objet…" className="h-8 pl-8 text-sm" />
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
        <FilterSelect label="Statut" value={statusValue} onChange={(v) => set({ status: v || null })} className="w-48">
          <option value="">Tous</option>
          <option value={OPEN_STATUSES}>En cours (brouillon, émise, devis reçus)</option>
          {Object.entries(RFQ_STATUS_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </FilterSelect>
        {can('suppliers.view') && (
          <FilterSelect label="Fournisseur" value={get('supplierId')} onChange={(v) => set({ supplierId: v || null })} className="w-48">
            <option value="">Tous</option>
            {(suppliers.data?.items ?? []).map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </FilterSelect>
        )}
        <div className="w-36">
          <label htmlFor="rfq-from" className="mb-1 block text-xs font-medium text-ink-muted">
            Créée du
          </label>
          <Input id="rfq-from" type="date" value={get('from')} onChange={(e) => set({ from: e.target.value || null })} className="h-8 text-sm" />
        </div>
        <div className="w-36">
          <label htmlFor="rfq-to" className="mb-1 block text-xs font-medium text-ink-muted">
            au
          </label>
          <Input id="rfq-to" type="date" value={get('to')} min={get('from') || undefined} onChange={(e) => set({ to: e.target.value || null })} className="h-8 text-sm" />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            className="text-action"
            onClick={() => {
              setTerm('');
              router.replace('/purchasing/rfqs');
            }}
          >
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>

      <div className={cn('grid items-start gap-4', panelOpen && 'grid-cols-[minmax(0,1fr)_minmax(0,600px)]')}>
        <DataTable
          caption="Liste des RFQ"
          columns={columns}
          rows={list.rows}
          loading={list.loading}
          error={list.error}
          onRetry={() => list.refetch()}
          selectedId={panelOpen ? selected : null}
          onRowClick={(r) => {
            if (wide) {
              setSelected(r.id);
              setDismissed(false);
            } else router.push(`/purchasing/rfqs/${r.id}`);
          }}
          hasMore={list.hasMore}
          onLoadMore={list.loadMore}
          loadingMore={list.loadingMore}
          total={list.total}
          empty={
            <EmptyState
              title={filtersActive ? 'Aucune RFQ ne correspond aux filtres' : 'Aucune RFQ pour l’instant'}
              description={
                filtersActive
                  ? 'Modifiez ou réinitialisez les filtres.'
                  : 'Une RFQ se crée à partir des lignes d’une ou plusieurs PR d’un même navire, puis les fournisseurs choisis sont contactés hors plateforme et leurs devis saisis.'
              }
              action={
                !filtersActive &&
                can('rfq.manage') && (
                  <Button onClick={() => router.push('/purchasing/rfqs/new')}>
                    <Plus className="h-4 w-4" aria-hidden /> Créer une RFQ
                  </Button>
                )
              }
            />
          }
        />
        {panelOpen && selected && (
          <RfqPanel
            rfqId={selected}
            hasPurchaseOrder={!!selectedRow?.hasPurchaseOrder}
            onClose={() => {
              setSelected(null);
              setDismissed(true);
            }}
          />
        )}
      </div>
    </>
  );
}
