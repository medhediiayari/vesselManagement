'use client';

import { ClipboardCheck, RotateCcw, Truck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { fmtDate, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DeliveryNoteDialog } from '@/components/purchasing/delivery-note-dialog';
import {
  DN_STATUS_LABELS,
  DN_STATUS_TONES,
  RECEIPT_STATUS_LABELS,
  RECEIPT_STATUS_TONES,
  VARIANCE_STATUS_LABELS,
  VARIANCE_STATUS_TONES,
  VARIANCE_TYPE_LABELS,
  VARIANCE_TYPE_TONES,
  purKeys,
  useUrlParams,
} from '@/components/purchasing/lib';
import type { DeliveryNoteListItem, ReceiptListItem, VarianceListItem } from '@/components/purchasing/types';
import { Callout, FilterSelect, StatusPill } from '@/components/purchasing/ui';

export default function DeliveriesPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <Deliveries />
    </Suspense>
  );
}

function Deliveries() {
  const router = useRouter();
  const { get, set } = useUrlParams();
  const { can, canAny, me, selectedVesselIds } = useSession();
  const [blOpen, setBlOpen] = useState(false);
  const tab = get('tab') || 'notes';
  const switcherVessel = selectedVesselIds.length === 1 ? selectedVesselIds[0] : '';
  const vesselId = get('vesselId') || switcherVessel;

  if (!canAny('receiving.view', 'variances.manage')) return <Forbidden />;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Livraisons & réceptions' }]}
        title="Livraisons & réceptions"
        description="Bons de livraison (déclaration fournisseur), réceptions physiques à bord et écarts. Un BL n’est jamais une preuve de réception : seules les quantités acceptées à bord soldent les commandes."
        actions={
          can('receiving.record') && (
            <>
              <Button variant="secondary" onClick={() => setBlOpen(true)}>
                <Truck className="h-4 w-4" aria-hidden /> Enregistrer un BL
              </Button>
              <Button onClick={() => router.push('/purchasing/deliveries/receive')}>
                <ClipboardCheck className="h-4 w-4" aria-hidden /> Nouvelle réception
              </Button>
            </>
          )
        }
      />
      <FilterBar>
        <FilterSelect label="Navire" value={get('vesselId')} onChange={(v) => set({ vesselId: v || null })} className="w-48">
          <option value="">{switcherVessel ? 'Navire du sélecteur' : 'Tous mes navires'}</option>
          {me.accessibleVessels.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </FilterSelect>
        {tab === 'notes' && (
          <FilterSelect label="Statut du BL" value={get('status')} onChange={(v) => set({ status: v || null })} className="w-56">
            <option value="">Tous</option>
            {Object.entries(DN_STATUS_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </FilterSelect>
        )}
        {tab === 'receipts' && (
          <FilterSelect label="Statut de la réception" value={get('status')} onChange={(v) => set({ status: v || null })} className="w-48">
            <option value="">Toutes</option>
            {Object.entries(RECEIPT_STATUS_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </FilterSelect>
        )}
        {tab === 'variances' && (
          <>
            <FilterSelect label="Statut de l’écart" value={get('status')} onChange={(v) => set({ status: v || null })} className="w-48">
              <option value="">Tous</option>
              <option value="OPEN,IN_PROGRESS">Ouverts (à traiter)</option>
              {Object.entries(VARIANCE_STATUS_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect label="Type" value={get('type')} onChange={(v) => set({ type: v || null })} className="w-56">
              <option value="">Tous</option>
              {Object.entries(VARIANCE_TYPE_LABELS).map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </FilterSelect>
            <div className="pb-1.5">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="h-4 w-4" checked={get('assignedToId') === me.id} onChange={(e) => set({ assignedToId: e.target.checked ? me.id : null })} />
                Qui me sont attribués
              </label>
            </div>
          </>
        )}
        {(get('status') || get('type') || get('vesselId') || get('assignedToId') || get('poId')) && (
          <Button variant="ghost" size="sm" onClick={() => router.replace(`/purchasing/deliveries${tab !== 'notes' ? `?tab=${tab}` : ''}`)}>
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser
          </Button>
        )}
      </FilterBar>

      <Tabs value={tab} onValueChange={(t) => set({ tab: t === 'notes' ? null : t, status: null, type: null, assignedToId: null })}>
        <TabsList className="mb-4">
          {can('receiving.view') && <TabsTrigger value="notes">Bons de livraison (BL)</TabsTrigger>}
          {can('receiving.view') && <TabsTrigger value="receipts">Réceptions à bord</TabsTrigger>}
          <TabsTrigger value="variances">Écarts & manquants</TabsTrigger>
        </TabsList>
        <TabsContent value="notes">{tab === 'notes' && <NotesList vesselId={vesselId} />}</TabsContent>
        <TabsContent value="receipts">{tab === 'receipts' && <ReceiptsList vesselId={vesselId} />}</TabsContent>
        <TabsContent value="variances">{tab === 'variances' && <VariancesList vesselId={vesselId} />}</TabsContent>
      </Tabs>
      {blOpen && <DeliveryNoteDialog open={blOpen} onOpenChange={setBlOpen} />}
    </>
  );
}

function NotesList({ vesselId }: { vesselId: string }) {
  const router = useRouter();
  const { get, sp } = useUrlParams();
  const params = useMemo(
    () => ({ vesselId: vesselId || undefined, status: get('status') || undefined, poId: get('poId') || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<DeliveryNoteListItem>([...purKeys.notes], '/delivery-notes', params);
  const columns: Column<DeliveryNoteListItem>[] = [
    {
      key: 'number',
      header: 'BL',
      cell: (r) => (
        <Link href={`/purchasing/deliveries/notes/${r.id}`} className="ref whitespace-nowrap font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.number}
        </Link>
      ),
    },
    {
      key: 'po',
      header: 'BC',
      cell: (r) => (
        <Link href={`/purchasing/orders/${r.po.id}`} className="whitespace-nowrap text-action hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.po.number}
        </Link>
      ),
    },
    { key: 'supplier', header: 'Fournisseur', cell: (r) => r.supplier.name },
    { key: 'date', header: 'Livré le', cell: (r) => fmtDate(r.deliveryDate) },
    { key: 'status', header: 'Statut', cell: (r) => <StatusPill status={r.status} labels={DN_STATUS_LABELS} tones={DN_STATUS_TONES} /> },
    { key: 'lines', header: 'Lignes', align: 'right', cell: (r) => r._count.lines, hideBelow: 'md' },
    { key: 'receipts', header: 'Réceptions', align: 'right', cell: (r) => r._count.receipts },
  ];
  return (
    <>
      <Callout tone="info" className="mb-3" title="BL = déclaration du fournisseur">
        Un BL « enregistré » n’a pas encore été vérifié à bord : réceptionnez-le pour saisir les quantités physiquement reçues.
      </Callout>
      <DataTable
        caption="Bons de livraison"
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        onRowClick={(r) => router.push(`/purchasing/deliveries/notes/${r.id}`)}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        empty={<EmptyState title="Aucun BL" description="Enregistrez les bons de livraison reçus avec la marchandise." />}
      />
    </>
  );
}

function ReceiptsList({ vesselId }: { vesselId: string }) {
  const router = useRouter();
  const { get, sp } = useUrlParams();
  const params = useMemo(
    () => ({ vesselId: vesselId || undefined, status: get('status') || undefined, poId: get('poId') || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<ReceiptListItem>([...purKeys.receipts], '/receipts', params);
  const columns: Column<ReceiptListItem>[] = [
    {
      key: 'number',
      header: 'Réception',
      cell: (r) => (
        <Link href={`/purchasing/deliveries/receipts/${r.id}`} className="ref whitespace-nowrap font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.number}
        </Link>
      ),
    },
    {
      key: 'po',
      header: 'BC',
      cell: (r) => (
        <span>
          <Link href={`/purchasing/orders/${r.po.id}`} className="whitespace-nowrap text-action hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.po.number}
          </Link>
          <span className="block text-xs text-ink-muted">{r.po.supplier.name}</span>
        </span>
      ),
    },
    { key: 'bl', header: 'BL', cell: (r) => (r.deliveryNote ? r.deliveryNote.number : <span className="text-xs text-ink-muted">Sans BL</span>) },
    { key: 'date', header: 'Reçu le', cell: (r) => fmtDateTime(r.receivedAt) },
    { key: 'resp', header: 'Responsable', cell: (r) => r.responsibleName ?? '—', hideBelow: 'lg' },
    { key: 'status', header: 'Statut', cell: (r) => <StatusPill status={r.status} labels={RECEIPT_STATUS_LABELS} tones={RECEIPT_STATUS_TONES} /> },
    {
      key: 'variances',
      header: 'Écarts',
      align: 'right',
      cell: (r) => (r._count.variances ? <Badge tone="danger">{r._count.variances}</Badge> : <span className="text-ink-muted">0</span>),
    },
  ];
  return (
    <DataTable
      caption="Réceptions"
      columns={columns}
      rows={list.rows}
      loading={list.loading}
      error={list.error}
      onRetry={() => list.refetch()}
      onRowClick={(r) => router.push(`/purchasing/deliveries/receipts/${r.id}`)}
      hasMore={list.hasMore}
      onLoadMore={list.loadMore}
      loadingMore={list.loadingMore}
      total={list.total}
      empty={<EmptyState title="Aucune réception" />}
    />
  );
}

function VariancesList({ vesselId }: { vesselId: string }) {
  const router = useRouter();
  const { get, sp } = useUrlParams();
  const params = useMemo(
    () => ({ vesselId: vesselId || undefined, status: get('status') || undefined, type: get('type') || undefined, assignedToId: get('assignedToId') || undefined, poId: get('poId') || undefined }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId],
  );
  const list = useCursorList<VarianceListItem>([...purKeys.variances], '/variances', params);
  const columns: Column<VarianceListItem>[] = [
    { key: 'type', header: 'Type', cell: (r) => <StatusPill status={r.type} labels={VARIANCE_TYPE_LABELS} tones={VARIANCE_TYPE_TONES} /> },
    {
      key: 'qty',
      header: 'Quantité',
      align: 'right',
      cell: (r) => (
        <span className="whitespace-nowrap">
          {fmtDecimal(r.quantity)} <span className="text-xs text-ink-muted">{r.poLine.unit}</span>
        </span>
      ),
    },
    {
      key: 'line',
      header: 'Article',
      cell: (r) => (
        <span className="min-w-[180px]">
          L{r.poLine.lineNo} {r.poLine.designation}
          <span className="block line-clamp-1 text-xs text-ink-muted" title={r.description}>
            {r.description}
          </span>
        </span>
      ),
    },
    {
      key: 'po',
      header: 'BC',
      cell: (r) => (
        <span>
          <Link href={`/purchasing/orders/${r.po.id}`} className="whitespace-nowrap text-action hover:underline" onClick={(e) => e.stopPropagation()}>
            {r.po.number}
          </Link>
          <span className="block text-xs text-ink-muted">{r.po.supplier.name}</span>
        </span>
      ),
    },
    { key: 'receipt', header: 'Réception', cell: (r) => <span className="whitespace-nowrap">{r.receipt?.number ?? '—'}</span>, hideBelow: 'lg' },
    { key: 'status', header: 'Statut', cell: (r) => <StatusPill status={r.status} labels={VARIANCE_STATUS_LABELS} tones={VARIANCE_STATUS_TONES} /> },
    { key: 'date', header: 'Signalé le', cell: (r) => fmtDate(r.createdAt), hideBelow: 'md' },
  ];
  return (
    <DataTable
      caption="Écarts"
      columns={columns}
      rows={list.rows}
      loading={list.loading}
      error={list.error}
      onRetry={() => list.refetch()}
      onRowClick={(r) => router.push(`/purchasing/deliveries/variances/${r.id}`)}
      hasMore={list.hasMore}
      onLoadMore={list.loadMore}
      loadingMore={list.loadingMore}
      total={list.total}
      empty={<EmptyState title="Aucun écart" description="Manquants au BL, manquants à bord, excédents, avaries et rejets apparaissent ici." />}
    />
  );
}
