'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, type ReactNode } from 'react';
import { MEMBER_STATUS_LABELS, PO_STATUS_LABELS, PR_STATUS_LABELS, VESSEL_STATUS_LABELS, VOYAGE_STATUS_LABELS } from '@amc/types';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { StatusBadge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';

interface SearchResult {
  vessels?: { id: string; code: string; name: string; imoNumber: string | null; status: string }[];
  members?: { id: string; amcRef: string | null; firstName: string; lastName: string; rank: string | null; status: string }[];
  certificates?: { id: string; currentNumber: string | null; currentExpiryOn: string | null; type: { code: string; name: string }; vessel: { name: string } | null; member: { firstName: string; lastName: string } | null }[];
  purchaseRequests?: { id: string; number: string; subject: string; status: string; vessel: { code: string } }[];
  purchaseOrders?: { id: string; number: string; status: string; supplier: { name: string }; vessel: { code: string } }[];
  voyages?: { id: string; reference: string; status: string; charterer: string | null; vessel: { code: string; name: string } }[];
  suppliers?: { id: string; code: string; name: string; isActive: boolean }[];
}

function Group({ title, children, count }: { title: string; children: ReactNode; count: number }) {
  if (!count) return null;
  return (
    <section className="panel">
      <h2 className="border-b border-line px-4 py-2.5 text-md font-semibold">{title} <span className="text-sm font-normal text-ink-muted">({count})</span></h2>
      <ul className="divide-y divide-line">{children}</ul>
    </section>
  );
}

function Row({ href, children }: { href: string; children: ReactNode }) {
  return (
    <li>
      <Link href={href} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm hover:bg-canvas">{children}</Link>
    </li>
  );
}

function Results() {
  const q = useSearchParams().get('q') ?? '';
  const { can } = useSession();
  const res = useQuery({ queryKey: ['search', q], queryFn: () => api.get<SearchResult>('/search', { query: { q } }), enabled: q.length >= 2 });
  if (q.length < 2) return <EmptyState title="Saisissez au moins 2 caractères" />;
  if (res.isLoading) return <LoadingBlock rows={6} />;
  if (res.error || !res.data) return <ErrorState error={res.error} />;
  const r = res.data;
  const total = Object.values(r).reduce((s, v) => s + (v?.length ?? 0), 0);
  return (
    <div className="space-y-4">
      {total === 0 && <EmptyState title="Aucun résultat dans votre périmètre" description="Seuls les éléments que vos droits permettent de voir sont recherchés." />}
      <Group title="Navires" count={r.vessels?.length ?? 0}>
        {r.vessels?.map((v) => (
          <Row key={v.id} href={`/vessels/${v.id}`}><span className="font-medium text-navy">{v.name}</span><span className="text-ink-muted">{v.code}{v.imoNumber ? ` — IMO ${v.imoNumber}` : ''}</span><StatusBadge status={v.status} labels={VESSEL_STATUS_LABELS} /></Row>
        ))}
      </Group>
      <Group title="Marins & personnel" count={r.members?.length ?? 0}>
        {r.members?.map((m) => (
          <Row key={m.id} href={`/members/${m.id}`}><span className="font-medium text-navy">{m.lastName} {m.firstName}</span><span className="text-ink-muted">{m.amcRef ?? ''} {m.rank ?? ''}</span><StatusBadge status={m.status} labels={MEMBER_STATUS_LABELS} /></Row>
        ))}
      </Group>
      <Group title="Certificats" count={r.certificates?.length ?? 0}>
        {r.certificates?.map((c) => (
          <Row key={c.id} href={`/certificates/${c.id}`}>
            <span className="font-medium text-navy">{c.type.code} — {c.type.name}</span>
            <span className="text-ink-muted">{c.vessel?.name ?? (c.member ? `${c.member.lastName} ${c.member.firstName}` : '')}</span>
            <span className="tabular text-ink-muted">{c.currentNumber ?? ''} {c.currentExpiryOn ? `— échéance ${fmtDate(c.currentExpiryOn)}` : ''}</span>
          </Row>
        ))}
      </Group>
      <Group title="Purchase Requests" count={r.purchaseRequests?.length ?? 0}>
        {r.purchaseRequests?.map((p) => (
          <Row key={p.id} href={`/purchasing/requests/${p.id}`}><span className="font-medium text-navy">{p.number}</span><span className="text-ink-muted">{p.subject}</span><StatusBadge status={p.status} labels={PR_STATUS_LABELS} /></Row>
        ))}
      </Group>
      <Group title="Bons de commande" count={r.purchaseOrders?.length ?? 0}>
        {r.purchaseOrders?.map((p) => (
          <Row key={p.id} href={`/purchasing/orders/${p.id}`}><span className="font-medium text-navy">{p.number}</span><span className="text-ink-muted">{p.supplier.name}</span><StatusBadge status={p.status} labels={PO_STATUS_LABELS} /></Row>
        ))}
      </Group>
      <Group title="Voyages" count={r.voyages?.length ?? 0}>
        {r.voyages?.map((v) => (
          <Row key={v.id} href={`/voyages/${v.id}`}><span className="font-medium text-navy">{v.reference}</span><span className="text-ink-muted">{v.vessel.name} {v.charterer ? `— ${v.charterer}` : ''}</span><StatusBadge status={v.status} labels={VOYAGE_STATUS_LABELS} /></Row>
        ))}
      </Group>
      <Group title="Fournisseurs" count={r.suppliers?.length ?? 0}>
        {r.suppliers?.map((s) => (
          <Row key={s.id} href={`/purchasing/suppliers?selected=${s.id}`}><span className="font-medium text-navy">{s.name}</span><span className="text-ink-muted">{s.code}</span></Row>
        ))}
      </Group>
      {can('cso.view') && (
        <p className="text-sm text-ink-muted">
          Les documents CSO disposent d’une recherche dédiée filtrée par dossier :{' '}
          <Link className="text-action hover:underline" href={`/cso?q=${encodeURIComponent(q)}`}>rechercher « {q} » dans la bibliothèque CSO</Link>.
        </p>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <>
      <PageHeader title="Recherche" description="Résultats limités à votre périmètre et à vos droits." />
      <Suspense fallback={<LoadingBlock />}>
        <Results />
      </Suspense>
    </>
  );
}
