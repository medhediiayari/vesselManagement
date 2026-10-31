'use client';

import { useQueries } from '@tanstack/react-query';
import { CheckCircle2, Gavel } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { ReferenceDecisionDialog, VersionDecisionDialog } from './decision-panel';
import { has, useApprovals } from './lib';
import type { ApprovalsInbox, CsoDocumentDetail } from './types';
import { Reference, userName, VersionStatusBadge } from './ui';

type VersionItem = ApprovalsInbox['versions'][number];
type RefItem = ApprovalsInbox['referenceChanges'][number];

/**
 * Boîte de validation CSO : versions et changements de référence que l'utilisateur peut
 * effectivement décider (validateur désigné, droits documentaires, scope ; jamais le déposant).
 */
export function ApprovalsList() {
  const { can } = useSession();
  const inbox = useApprovals(can('cso.approve'));
  const [deciding, setDeciding] = useState<VersionItem | null>(null);
  const [refDeciding, setRefDeciding] = useState<RefItem | null>(null);
  const refDocs = useQueries({
    queries: (inbox.data?.referenceChanges ?? []).map((r) => ({
      queryKey: ['cso', 'document', r.documentId],
      queryFn: () => api.get<CsoDocumentDetail>(`/cso/documents/${r.documentId}`),
      staleTime: 30_000,
    })),
  });

  if (!can('cso.approve')) return <Forbidden message="La validation des documents CSO requiert la permission « Approuver les documents CSO »." />;
  if (inbox.isLoading) return <LoadingBlock rows={6} />;
  if (inbox.error || !inbox.data) return <ErrorState error={inbox.error} onRetry={() => inbox.refetch()} />;
  const { versions, referenceChanges } = inbox.data;

  return (
    <div className="space-y-5">
      <Panel title={`Versions à valider (${versions.length})`} bodyClassName="p-0">
        {versions.length === 0 ? (
          <EmptyState icon={<CheckCircle2 className="h-5 w-5 text-ok" aria-hidden />} title="Aucune version en attente" description="Vous êtes à jour : aucune version ne requiert votre décision." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Document</th>
                  <th scope="col">Version</th>
                  <th scope="col" className="hidden md:table-cell">Déposée par</th>
                  <th scope="col" className="hidden sm:table-cell">En attente depuis</th>
                  <th scope="col" className="hidden lg:table-cell">Note</th>
                  <th scope="col">
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {versions.map((item) => (
                  <tr key={item.version.id}>
                    <td className="max-w-[320px]">
                      <Link href={`/cso/documents/${item.document.id}`} className="font-medium text-navy hover:text-action hover:underline">
                        {item.document.title}
                      </Link>
                      <div>
                        <Reference value={item.document.reference} />
                      </div>
                    </td>
                    <td>
                      <span className="mr-2 font-semibold tabular">v{item.version.versionNo}</span>
                      <VersionStatusBadge status={item.version.status} />
                      {item.version.isRestoration && <span className="block text-xs text-ink-muted">Restauration</span>}
                    </td>
                    <td className="hidden md:table-cell">{userName(item.version.submittedBy)}</td>
                    <td className="hidden sm:table-cell" title={fmtDateTime(item.version.submittedAt)}>
                      {fmtRelative(item.version.submittedAt)}
                    </td>
                    <td className="hidden max-w-[260px] truncate lg:table-cell" title={item.version.changeNote ?? undefined}>
                      {item.version.changeNote ?? <span className="text-ink-soft">—</span>}
                    </td>
                    <td className="text-right">
                      <Button size="sm" onClick={() => setDeciding(item)}>
                        <Gavel className="h-4 w-4" aria-hidden /> Décider
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title={`Changements de référence (${referenceChanges.length})`} bodyClassName="p-0">
        {referenceChanges.length === 0 ? (
          <EmptyState title="Aucune demande" description="Aucun changement de référence officielle en attente." />
        ) : (
          <ul className="divide-y divide-line">
            {referenceChanges.map((r, i) => {
              const d = refDocs[i]?.data;
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <div className="min-w-0 flex-1">
                    <Link href={`/cso/documents/${r.documentId}`} className="font-medium text-navy hover:text-action hover:underline">
                      {d?.title ?? 'Document'}
                    </Link>
                    <p className="mt-0.5">
                      <Reference value={r.oldReference} /> → <Reference value={r.newReference} />
                    </p>
                    {r.reason && <p className="text-xs text-ink-muted">Motif : {r.reason}</p>}
                    <p className="text-xs text-ink-muted">Demandé {fmtRelative(r.createdAt)}</p>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => setRefDeciding(r)}>
                    <Gavel className="h-4 w-4" aria-hidden /> Décider
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
      {deciding && (
        <VersionDecisionDialog
          open={!!deciding}
          onOpenChange={(o) => !o && setDeciding(null)}
          doc={deciding.document}
          version={deciding.version}
          canPreview={has(deciding.document.actions, 'preview')}
        />
      )}
      {refDeciding && (
        <ReferenceDecisionDialog
          open={!!refDeciding}
          onOpenChange={(o) => !o && setRefDeciding(null)}
          request={{ ...refDeciding, documentTitle: refDocs[referenceChanges.indexOf(refDeciding)]?.data?.title }}
        />
      )}
    </div>
  );
}
