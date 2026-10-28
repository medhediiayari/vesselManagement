'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, ClipboardList, FileText, MessagesSquare, PackageCheck, Plus, Receipt, Settings2, ShoppingCart, Truck } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { purKeys } from '@/components/purchasing/lib';
import type { PurchasingBoard } from '@/components/purchasing/types';
import { CounterTile } from '@/components/purchasing/ui';

function Section({ title, icon, href, linkLabel, children }: { title: string; icon: ReactNode; href: string; linkLabel: string; children: ReactNode }) {
  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-md font-semibold">
          <span className="text-teal-700" aria-hidden>
            {icon}
          </span>
          {title}
        </h2>
        <Link href={href} className="text-sm font-medium text-action hover:underline">
          {linkLabel}
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>
    </section>
  );
}

interface ActionItem {
  key: string;
  count: number;
  label: string;
  href: string;
  tone: 'danger' | 'warn' | 'info';
  icon: ReactNode;
}

/**
 * « À faire maintenant » : les étapes du flux PR simplifié qui attendent l'utilisateur (écarts de réception à
 * décider, PR à mettre en discussion ou à décider, BC à émettre, BL à saisir à bord), selon ses droits.
 */
function ActionQueue({ items }: { items: ActionItem[] }) {
  const visible = items.filter((i) => i.count > 0);
  if (!visible.length) return null;
  const tones = { danger: 'border-l-danger bg-danger-bg/60', warn: 'border-l-warn bg-warn-bg/50', info: 'border-l-action bg-action-50' } as const;
  const text = { danger: 'text-danger', warn: 'text-warn', info: 'text-action' } as const;
  return (
    <section aria-labelledby="todo-title" className="mb-4 rounded-lg bg-white shadow-panel">
      <h2 id="todo-title" className="border-b border-line px-4 py-2.5 text-sm font-semibold text-navy">
        À faire maintenant
      </h2>
      <ul className="divide-y divide-line">
        {visible.map((i) => (
          <li key={i.key}>
            <Link href={i.href} className={`flex items-center gap-3 border-l-[3px] px-4 py-2.5 hover:brightness-[0.98] ${tones[i.tone]}`}>
              <span className={text[i.tone]} aria-hidden>
                {i.icon}
              </span>
              <span className="min-w-0 flex-1 text-sm">
                <span className={`mr-1.5 font-semibold tabular ${text[i.tone]}`}>{i.count}</span>
                {i.label}
              </span>
              <ChevronRight className="h-4 w-4 text-ink-soft" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Purchasing board (V1 §9.2) : boîte de réception Achats, compteurs liés aux listes filtrées. */
export default function PurchasingBoardPage() {
  const { can, canAny, selectedVesselIds, currentVessel } = useSession();
  const vesselId = selectedVesselIds.length === 1 ? selectedVesselIds[0] : undefined;
  const q = useQuery({
    queryKey: purKeys.board(vesselId),
    queryFn: () => api.get<PurchasingBoard>('/purchasing/board', { query: { vesselId } }),
    enabled: canAny('pr.view', 'rfq.view', 'quotation.view', 'bc.view', 'receiving.view', 'invoice.view'),
    refetchInterval: 60_000,
  });
  const vq = vesselId ? `&vesselId=${vesselId}` : '';
  const d = q.data;

  return (
    <>
      <PageHeader
        title="Achats"
        description={`Achats${currentVessel ? ` — ${currentVessel.name}` : ' — tous vos navires'} : PR en discussion, bons de commande à émettre, BL attendus du bord et écarts de réception à traiter.`}
        actions={
          <>
            {can('settings.manage') && (
              <Link href="/purchasing/settings" className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-white px-4 text-base font-medium text-ink hover:bg-canvas">
                <Settings2 className="h-4 w-4" aria-hidden /> Paramétrage
              </Link>
            )}
            {can('pr.create') && (
              <Link href="/purchasing/requests/new" className="inline-flex h-9 items-center gap-2 rounded-md bg-action px-4 text-base font-medium text-white hover:bg-action-700">
                <Plus className="h-4 w-4" aria-hidden /> Nouvelle PR
              </Link>
            )}
          </>
        }
      />
      {q.isLoading && <LoadingBlock rows={8} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {d && !Object.keys(d).length && <EmptyState title="Aucun indicateur" description="Vos droits ne donnent accès à aucun compteur Achats." />}
      {d && (
        <ActionQueue
          items={[
            ...(can('variances.manage') && d.orders
              ? [{ key: 'gaps', count: d.orders.discrepanciesToDecide, label: 'BC avec un écart de réception à décider (manque ou surplus signalé par le bord)', href: `/purchasing/orders?discrepancy=true${vq}`, tone: 'danger' as const, icon: <AlertTriangle className="h-4 w-4" /> }]
              : []),
            ...(can('pr.approve') && d.purchaseRequests
              ? [
                  { key: 'inbox', count: d.purchaseRequests.inbox, label: 'nouvelle(s) PR à mettre en discussion', href: `/purchasing/requests?status=SUBMITTED${vq}`, tone: 'warn' as const, icon: <ClipboardList className="h-4 w-4" /> },
                  { key: 'discuss', count: d.purchaseRequests.underReview, label: 'PR en discussion : continuer, Counter-PR ou diviser', href: `/purchasing/requests?status=UNDER_REVIEW${vq}`, tone: 'warn' as const, icon: <MessagesSquare className="h-4 w-4" /> },
                ]
              : []),
            ...(can('bc.create') && d.purchaseRequests
              ? [{ key: 'order', count: d.purchaseRequests.toOrder, label: 'PR validée(s) à commander (BC à créer et émettre)', href: `/purchasing/requests?status=APPROVED,SOURCING,PARTIALLY_ORDERED${vq}`, tone: 'info' as const, icon: <ShoppingCart className="h-4 w-4" /> }]
              : []),
            ...(can('bc.create') && d.orders
              ? [{ key: 'drafts', count: d.orders.drafts + d.orders.approvedNotSent, label: 'BC à émettre', href: `/purchasing/orders?status=DRAFT,APPROVED${vq}`, tone: 'info' as const, icon: <ShoppingCart className="h-4 w-4" /> }]
              : []),
            ...(can('receiving.record') && d.orders
              ? [{ key: 'receive', count: d.orders.toReceive, label: 'BC émis en attente de BL (à saisir à la livraison)', href: `/purchasing/orders?status=SENT,PARTIALLY_RECEIVED${vq}`, tone: 'info' as const, icon: <PackageCheck className="h-4 w-4" /> }]
              : []),
          ]}
        />
      )}
      {d && (
        <div className="grid gap-4 xl:grid-cols-2">
          {d.purchaseRequests && (
            <Section title="Purchase Requests" icon={<ClipboardList className="h-4 w-4" />} href={`/purchasing/requests${vesselId ? `?vesselId=${vesselId}` : ''}`} linkLabel="Toutes les PR">
              <CounterTile label="Nouvelles PR (soumises)" value={d.purchaseRequests.inbox} tone="warn" href={`/purchasing/requests?status=SUBMITTED${vq}`} />
              <CounterTile label="En discussion" value={d.purchaseRequests.underReview} href={`/purchasing/requests?status=UNDER_REVIEW${vq}`} />
              <CounterTile label="Counter-PR à décider" value={d.purchaseRequests.counterPrPending} tone="warn" href={`/purchasing/requests?status=REVISED${vq}`} />
              <CounterTile label="À commander" value={d.purchaseRequests.toOrder} tone="warn" href={`/purchasing/requests?status=APPROVED,SOURCING,PARTIALLY_ORDERED${vq}`} />
              <CounterTile label="En attente (on hold)" value={d.purchaseRequests.onHold} href={`/purchasing/requests?status=ON_HOLD${vq}`} />
              <CounterTile label="Besoin dépassé, non commandées" value={d.purchaseRequests.overdueNotOrdered} tone="danger" href={`/purchasing/requests?overdue=true${vq}`} />
            </Section>
          )}
          {(d.rfqs || d.quotations) && (
            <Section title="RFQ & devis" icon={<FileText className="h-4 w-4" />} href="/purchasing/rfqs" linkLabel="Toutes les RFQ">
              {d.rfqs && <CounterTile label="RFQ en brouillon" value={d.rfqs.drafts} href={`/purchasing/rfqs?status=DRAFT${vq}`} />}
              {d.rfqs && <CounterTile label="À relancer (échéance passée)" value={d.rfqs.toFollowUp} tone="warn" href={`/purchasing/rfqs?status=ISSUED${vq}`} />}
              {d.quotations && <CounterTile label="Devis à comparer" value={d.quotations.toCompare} tone="warn" href={`/purchasing/rfqs?status=QUOTED${vq}`} />}
            </Section>
          )}
          {d.orders && (
            <Section title="Bons de commande" icon={<ShoppingCart className="h-4 w-4" />} href="/purchasing/orders" linkLabel="Tous les BC">
              <CounterTile label="Brouillons à émettre" value={d.orders.drafts} href={`/purchasing/orders?status=DRAFT${vq}`} />
              <CounterTile label="Second regard en attente" value={d.orders.approvalPending} tone="warn" href={`/purchasing/orders?status=APPROVAL_PENDING${vq}`} />
              <CounterTile label="En attente de BL" value={d.orders.toReceive} href={`/purchasing/orders?status=SENT,PARTIALLY_RECEIVED${vq}`} />
              <CounterTile label="Écart de réception à décider" value={d.orders.discrepanciesToDecide} tone="danger" href={`/purchasing/orders?discrepancy=true${vq}`} />
              <CounterTile label="Livraison en retard" value={d.orders.lateDelivery} tone="danger" href={`/purchasing/orders?late=true${vq}`} />
              <CounterTile label="Partiellement reçus" value={d.orders.partiallyReceived} tone="warn" href={`/purchasing/orders?status=PARTIALLY_RECEIVED${vq}`} />
            </Section>
          )}
          {(d.variances || d.invoices) && (
            <Section title="Réceptions, manquants & factures" icon={<Truck className="h-4 w-4" />} href="/purchasing/deliveries" linkLabel="Livraisons & réceptions">
              {d.variances && <CounterTile label="Écarts / manquants ouverts" value={d.variances.open} tone="danger" href={`/purchasing/deliveries?tab=variances&status=OPEN,IN_PROGRESS${vq}`} />}
              {d.variances && <CounterTile label="Réceptions à valider" value={d.variances.receiptsToValidate} tone="warn" href={`/purchasing/deliveries?tab=receipts&status=CONFIRMED${vq}`} />}
              {d.invoices && <CounterTile label="Factures à examiner" value={d.invoices.toReview} tone="warn" href={`/purchasing/invoices?status=RECEIVED,UNDER_REVIEW${vq}`} />}
              {d.invoices && <CounterTile label="Factures en litige" value={d.invoices.disputed} tone="danger" href={`/purchasing/invoices?status=DISPUTED${vq}`} />}
            </Section>
          )}
        </div>
      )}
      {d && (
        <p className="mt-4 flex items-center gap-1.5 text-xs text-ink-muted">
          <Receipt className="h-3.5 w-3.5" aria-hidden /> Compteurs calculés selon vos permissions et votre périmètre navire ; actualisation automatique chaque minute.
        </p>
      )}
    </>
  );
}
