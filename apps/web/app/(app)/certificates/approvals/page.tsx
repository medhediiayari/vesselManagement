'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Gavel, Paperclip, Siren, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useId, useState, type ReactNode } from 'react';
import { api, type Page } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { certKeys, fmtExpiry, useMediaQuery, useRefreshCertificates } from '@/components/certificates/lib';
import { RequestCard } from '@/components/certificates/request-card';
import { RequestKindBadge, RequestStatusBadge, SubjectLink } from '@/components/certificates/status';
import { REQUEST_KIND_LABELS, type CertificateDetail, type RequestKind, type RequestListItem } from '@/components/certificates/types';

type View = 'toApprove' | 'mine' | 'all';

const STATUS_OPTIONS: Record<string, string> = {
  'DRAFT,PENDING_APPROVAL,RETURNED': 'Ouvertes',
  PENDING_APPROVAL: "En attente d'approbation",
  'DRAFT,RETURNED': 'À compléter (brouillons et retours)',
  RETURNED: 'Retournées pour correction',
  DRAFT: 'Brouillons',
  APPROVED: 'Approuvées',
  REJECTED: 'Refusées',
  CANCELLED: 'Annulées',
};

function FilterSelect({ label, value, onChange, children }: { label: string; value: string; onChange: (v: string) => void; children: ReactNode }) {
  const id = useId();
  return (
    <div className="w-56">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-muted">
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm">
        {children}
      </Select>
    </div>
  );
}

export default function CertificateApprovalsPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <ApprovalsInbox />
    </Suspense>
  );
}

/** Panneau rapide : la demande sélectionnée avec son panneau de décision (même composant que la fiche). */
function RequestQuickPanel({ item, onClose }: { item: RequestListItem; onClose: () => void }) {
  const refresh = useRefreshCertificates();
  const [conflict, setConflict] = useState<string | null>(null);
  const q = useQuery({
    queryKey: certKeys.detail(item.certificate.id),
    queryFn: () => api.get<CertificateDetail>(`/certificates/${item.certificate.id}`),
  });
  const request = q.data?.requests.find((r) => r.id === item.id);
  return (
    <aside aria-label="Demande sélectionnée" className="panel flex max-h-[calc(100vh-5rem)] flex-col overflow-hidden xl:sticky xl:top-[4.5rem]">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-ink-muted">Demande de {REQUEST_KIND_LABELS[item.kind].toLowerCase()}</p>
          <h2 className="truncate text-md font-semibold">{item.certificate.type.name}</h2>
          <SubjectLink subject={item.certificate.subject} subjectKind={item.certificate.subjectKind} className="mt-1 text-sm" />
        </div>
        <IconButton label="Fermer le panneau" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto bg-canvas/50 p-3">
        {conflict && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{conflict}</span>
          </div>
        )}
        {q.isLoading && <LoadingBlock rows={5} />}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {q.data && !request && <EmptyState title="Demande introuvable" description="Elle a peut-être été annulée ou n’est plus visible." />}
        {q.data && request && (
          <RequestCard
            certificate={q.data}
            request={request}
            onChanged={async () => {
              setConflict(null);
              await refresh(item.certificate.id);
            }}
            onConflict={async (msg) => {
              setConflict(msg);
              await refresh(item.certificate.id);
            }}
          />
        )}
      </div>
      <div className="border-t border-line px-4 py-3">
        <Link
          href={`/certificates/${item.certificate.id}?tab=requests&request=${item.id}`}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-white px-4 text-base font-medium text-ink hover:bg-canvas"
        >
          Ouvrir la fiche du certificat <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </aside>
  );
}

function RequestsView({ view, status, kind, selected, onSelect }: { view: View; status: string; kind: string; selected: RequestListItem | null; onSelect: (r: RequestListItem | null) => void }) {
  const router = useRouter();
  const wide = useMediaQuery('(min-width: 1280px)');
  const params = {
    toApprove: view === 'toApprove' ? 'true' : undefined,
    mine: view === 'mine' ? 'true' : undefined,
    status: status || undefined,
    kind: kind || undefined,
  };
  const list = useCursorList<RequestListItem>(certKeys.requests, '/certificate-requests', params);

  const columns: Column<RequestListItem>[] = [
    {
      key: 'certificate',
      header: 'Certificat',
      className: 'min-w-[180px]',
      cell: (r) => (
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-ink">{r.certificate.type.name}</p>
          <SubjectLink subject={r.certificate.subject} subjectKind={r.certificate.subjectKind} className="text-sm" />
        </div>
      ),
    },
    {
      key: 'kind',
      header: 'Demande',
      cell: (r) => (
        <div className="flex flex-col items-start gap-1">
          <RequestKindBadge kind={r.kind} />
          <span className="text-xs tabular text-ink-muted">Version {r.version}</span>
        </div>
      ),
    },
    {
      key: 'proposed',
      header: 'Proposé',
      hideBelow: 'md',
      cell: (r) =>
        r.proposed && r.kind !== 'ATTACHMENT' ? (
          <div className="text-sm">
            <p className="tabular">{r.proposed.certificateNumber ?? '—'}</p>
            <p className="text-xs tabular text-ink-muted">Échéance : {fmtExpiry(r.proposed.expiryKind, r.proposed.expiryOn)}</p>
            {r.proposed.hasFile && (
              <p className="inline-flex items-center gap-1 text-xs text-ink-muted">
                <Paperclip className="h-3 w-3" aria-hidden /> Pièce jointe
              </p>
            )}
          </div>
        ) : r.kind === 'ATTACHMENT' ? (
          <span className="inline-flex items-center gap-1 text-sm text-ink-muted">
            <Paperclip className="h-3.5 w-3.5" aria-hidden /> Nouveau document
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'requester',
      header: 'Demandeur',
      hideBelow: 'lg',
      cell: (r) => (
        <div className="text-sm">
          <p>{r.requestedBy.displayName ?? '—'}</p>
          <p className="text-xs tabular text-ink-muted">{r.submittedAt ? `Soumise le ${fmtDateTime(r.submittedAt)}` : `Créée le ${fmtDateTime(r.createdAt)}`}</p>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Statut',
      cell: (r) => (
        <div className="flex flex-wrap gap-1">
          <RequestStatusBadge status={r.status} />
          {r.escalatedAt && (
            <Badge tone="danger" icon={<Siren className="h-3.5 w-3.5" aria-hidden />}>
              Escaladée
            </Badge>
          )}
          {r.canDecide && (
            <Badge tone="info" icon={<Gavel className="h-3.5 w-3.5" aria-hidden />}>
              À décider
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Ouvrir</span>,
      align: 'right',
      cell: (r) => (
        <Link
          href={`/certificates/${r.certificate.id}?tab=requests&request=${r.id}`}
          onClick={(e) => e.stopPropagation()}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-sm font-medium text-action hover:bg-action-50"
          aria-label={`${r.canDecide ? 'Décider' : 'Ouvrir'} : ${r.certificate.type.name} — ${r.certificate.subject.label}`}
        >
          {r.canDecide ? 'Décider' : 'Ouvrir'} <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      ),
    },
  ];

  const emptyTitle = view === 'toApprove' ? 'Aucune demande à valider' : view === 'mine' ? 'Aucune demande' : 'Aucune demande visible';
  const emptyDescription =
    view === 'toApprove'
      ? 'Vous ne pouvez jamais valider vos propres demandes ; seules celles des types dont vous êtes validateur apparaissent ici.'
      : 'Modifiez les filtres pour élargir la recherche.';

  return (
    <div className={selected && wide ? 'grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_460px]' : undefined}>
      <DataTable
        caption="Demandes de certificats"
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        selectedId={selected?.id}
        onRowClick={(r) => {
          if (wide) onSelect(selected?.id === r.id ? null : r);
          else router.push(`/certificates/${r.certificate.id}?tab=requests&request=${r.id}`);
        }}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        empty={<EmptyState title={emptyTitle} description={emptyDescription} />}
      />
      {selected && wide && <RequestQuickPanel key={selected.id} item={selected} onClose={() => onSelect(null)} />}
    </div>
  );
}

function ApprovalsInbox() {
  const router = useRouter();
  const sp = useSearchParams();
  const { can, canAny } = useSession();
  const [selected, setSelected] = useState<RequestListItem | null>(null);
  const isValidator = canAny('certificates.approve', 'certificates.attachments.approve');
  const viewParam = sp.get('view') as View | null;
  const view: View = viewParam && ['toApprove', 'mine', 'all'].includes(viewParam) ? viewParam : isValidator ? 'toApprove' : 'mine';
  const status = sp.get('status') ?? '';
  const kind = sp.get('kind') ?? '';

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setSelected(null);
    router.replace(`/certificates/approvals${next.toString() ? `?${next}` : ''}`, { scroll: false });
  };

  const toApproveCount = useQuery({
    queryKey: [...certKeys.requests, 'count-to-approve'],
    queryFn: () => api.get<Page<RequestListItem>>('/certificate-requests', { query: { toApprove: true, limit: 1 } }),
    enabled: isValidator,
  });
  const toCompleteCount = useQuery({
    queryKey: [...certKeys.requests, 'count-to-complete'],
    queryFn: () => api.get<Page<RequestListItem>>('/certificate-requests', { query: { mine: true, status: 'DRAFT,RETURNED', limit: 1 } }),
    enabled: can('certificates.view'),
  });

  if (!can('certificates.view')) return <Forbidden />;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Certificats', href: '/certificates' }, { label: 'Validations' }]}
        title="Validations et demandes"
        description="Demandes de création, renouvellement, correction et pièces jointes. Un demandeur ne peut jamais approuver sa propre demande ; une seule approbation suffit."
      />
      <Tabs value={view} onValueChange={(v) => setParams({ view: v, status: null })}>
        <TabsList className="mb-3">
          {isValidator && (
            <TabsTrigger value="toApprove" count={toApproveCount.data?.total ?? null}>
              À valider
            </TabsTrigger>
          )}
          <TabsTrigger value="mine" count={toCompleteCount.data?.total || null}>
            Mes demandes
          </TabsTrigger>
          <TabsTrigger value="all">Toutes les demandes</TabsTrigger>
        </TabsList>

        <FilterBar>
          <FilterSelect label="Statut" value={status} onChange={(v) => setParams({ status: v })}>
            <option value="">Tous les statuts</option>
            {Object.entries(STATUS_OPTIONS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
            {status && !STATUS_OPTIONS[status] && <option value={status}>{status}</option>}
          </FilterSelect>
          <FilterSelect label="Nature" value={kind} onChange={(v) => setParams({ kind: v })}>
            <option value="">Toutes</option>
            {(Object.keys(REQUEST_KIND_LABELS) as RequestKind[]).map((k) => (
              <option key={k} value={k}>
                {REQUEST_KIND_LABELS[k]}
              </option>
            ))}
          </FilterSelect>
          {view === 'mine' && (toCompleteCount.data?.total ?? 0) > 0 && status !== 'DRAFT,RETURNED' && (
            <button type="button" className="mb-1.5 text-sm font-medium text-action hover:underline" onClick={() => setParams({ status: 'DRAFT,RETURNED' })}>
              {toCompleteCount.data?.total} demande(s) à compléter
            </button>
          )}
        </FilterBar>

        {(['toApprove', 'mine', 'all'] as View[]).map((v) => (
          <TabsContent key={v} value={v}>
            {view === v && <RequestsView view={v} status={status} kind={kind} selected={selected} onSelect={setSelected} />}
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
