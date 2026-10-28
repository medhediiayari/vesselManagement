'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderOpen, KeyRound, Share2 } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { AclEditorDialog, AclInlineView } from '@/components/cso/acl-editor';
import { CustomFieldsView } from '@/components/cso/custom-fields';
import { DocumentActions, DocumentStatusNotices, VersionsList } from '@/components/cso/document-actions';
import { DocumentMetadata, DocumentPreviewBlock } from '@/components/cso/document-panel';
import { CsoHistory } from '@/components/cso/history';
import { has, libraryLabel, useDocument, useDocumentAccess } from '@/components/cso/lib';
import { ShareDialog, SharesList } from '@/components/cso/share-dialog';
import type { CsoReferenceChange } from '@/components/cso/types';
import { DocStatusBadge, EffectiveRights, Notice, Reference, userName } from '@/components/cso/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const REF_STATUS: Record<string, string> = { PENDING_APPROVAL: 'En attente', APPROVED: 'Approuvé', REJECTED: 'Refusé', CANCELLED: 'Annulé' };

function DocumentView() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = sp.get('tab') ?? 'details';
  const q = useDocument(id);
  const access = useDocumentAccess(id);
  const refChanges = useQuery({
    queryKey: ['cso', 'reference-changes', id],
    queryFn: () => api.get<CsoReferenceChange[]>(`/cso/documents/${id}/reference-changes`),
    enabled: !!q.data && tab === 'details',
  });
  const [share, setShare] = useState(false);
  const [acl, setAcl] = useState(false);

  if (!can('cso.view')) return <Forbidden />;
  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const doc = q.data;
  const actions = access.data?.actions ?? doc.actions;
  const viaShare = access.data?.viaShare ?? doc.viaShare;
  const canSeeShares = (can('cso.share') && has(actions, 'share')) || can('cso.revoke');
  const canShare = can('cso.share') && has(actions, 'share') && doc.status === 'PUBLISHED';
  const canAcl = can('cso.folder.acl_manage') && has(actions, 'acl_manage');
  const setTab = (t: string) => router.replace(`${pathname}?tab=${t}`, { scroll: false });
  const folderHref = `/cso?folderId=${doc.folderId}&doc=${doc.id}`;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'Documents CSO', href: '/cso' },
          { label: libraryLabel(doc.library), href: `/cso?libraryId=${doc.libraryId}` },
          ...(doc.breadcrumb.truncated ? [{ label: '…' }] : []),
          ...doc.breadcrumb.items.map((b) => ({ label: b.name, href: `/cso?folderId=${b.id}` })),
          { label: doc.title },
        ]}
        title={doc.title}
        meta={
          <>
            <DocStatusBadge status={doc.status} />
            {doc.reference && <Reference value={doc.reference} />}
            {doc.category && <Badge tone="navy" icon={false}>{doc.category.name}</Badge>}
            {doc.currentVersion && <Badge tone="navy" icon={false}>Version officielle v{doc.currentVersion.versionNo}</Badge>}
            {doc.folder.name && (
              <Link href={folderHref} className="inline-flex items-center gap-1 text-sm text-action hover:underline">
                <FolderOpen className="h-3.5 w-3.5" aria-hidden /> Afficher dans le dossier
              </Link>
            )}
          </>
        }
        actions={<DocumentActions doc={doc} actions={actions} variant="page" onOpenHistory={() => setTab('history')} />}
      />
      <div className="mb-4 space-y-2">
        <EffectiveRights actions={actions} scope="document" viaShare={viaShare} label="Vos droits effectifs sur ce document" />
        <DocumentStatusNotices doc={doc} />
      </div>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="details">Détails</TabsTrigger>
          <TabsTrigger value="versions" count={doc.versions.length}>
            Versions
          </TabsTrigger>
          {canSeeShares && <TabsTrigger value="shares">Partages</TabsTrigger>}
          {can('cso.audit.view') && <TabsTrigger value="history">Historique</TabsTrigger>}
          <TabsTrigger value="rights">Droits</TabsTrigger>
        </TabsList>

        <TabsContent value="details" className="mt-4">
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
            <Panel title="Aperçu de la version officielle">
              <DocumentPreviewBlock doc={doc} actions={actions} tall />
            </Panel>
            <div className="space-y-5">
              <Panel title="Informations">
                {doc.description && <p className="mb-4 whitespace-pre-line text-sm">{doc.description}</p>}
                <DocumentMetadata doc={doc} />
              </Panel>
              {doc.customFields.length > 0 && (
                <Panel title="Champs de la catégorie">
                  <CustomFieldsView fields={doc.customFields} />
                </Panel>
              )}
              {(refChanges.data?.length ?? 0) > 0 && (
                <Panel title="Historique des références">
                  <ul className="space-y-2 text-sm">
                    {refChanges.data!.map((r) => (
                      <li key={r.id} className="rounded-md border border-line px-3 py-2">
                        <p>
                          <Reference value={r.oldReference} /> → <Reference value={r.newReference} />{' '}
                          <span className="text-xs text-ink-muted">({REF_STATUS[r.status] ?? r.status})</span>
                        </p>
                        <p className="text-xs text-ink-muted">
                          Demandé par {userName(r.requestedBy)} le {fmtDateTime(r.createdAt)}
                          {r.decidedAt && ` — décidé par ${userName(r.decidedBy)} le ${fmtDateTime(r.decidedAt)}`}
                        </p>
                        {r.reason && <p className="text-xs">Motif : {r.reason}</p>}
                        {r.decisionComment && <p className="text-xs">Commentaire : {r.decisionComment}</p>}
                      </li>
                    ))}
                  </ul>
                </Panel>
              )}
            </div>
          </div>
        </TabsContent>

        <TabsContent value="versions" className="mt-4">
          <Panel title="Versions" bodyClassName="p-3">
            <p className="mb-3 text-sm text-ink-muted">
              Versions immuables : une nouvelle version est approuvée par un validateur autre que le déposant ; l&apos;ancienne version officielle reste en vigueur pendant
              la validation puis est archivée (remplacée).
            </p>
            <VersionsList doc={doc} actions={actions} />
          </Panel>
        </TabsContent>

        {canSeeShares && (
          <TabsContent value="shares" className="mt-4">
            <Panel
              title="Partages internes"
              actions={
                canShare && (
                  <Button size="sm" onClick={() => setShare(true)}>
                    <Share2 className="h-4 w-4" aria-hidden /> Partager
                  </Button>
                )
              }
            >
              <SharesList documentId={doc.id} canRevoke={can('cso.revoke')} />
            </Panel>
            {canShare && <ShareDialog open={share} onOpenChange={setShare} doc={doc} canDownload={has(actions, 'download')} />}
          </TabsContent>
        )}

        {can('cso.audit.view') && (
          <TabsContent value="history" className="mt-4">
            <Panel title="Activité du document">
              <CsoHistory documentId={doc.id} />
            </Panel>
          </TabsContent>
        )}

        <TabsContent value="rights" className="mt-4">
          <Panel
            title="Droits d'accès"
            actions={
              canAcl && (
                <Button size="sm" variant="secondary" onClick={() => setAcl(true)}>
                  <KeyRound className="h-4 w-4" aria-hidden /> Gérer les accès
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <EffectiveRights actions={actions} scope="document" viaShare={viaShare} label="Vos droits effectifs" />
              <Notice tone="info">
                Vos droits résultent de vos permissions de module, de votre périmètre navire et des règles d&apos;accès du document
                {doc.inheritAcl ? ' (héritées de son dossier)' : ' (héritage du dossier rompu pour ce document)'}. Une règle de refus explicite prévaut toujours.
              </Notice>
              {canAcl ? (
                <AclInlineView kind="document" id={doc.id} />
              ) : (
                <p className="text-sm text-ink-muted">La consultation détaillée des règles d&apos;accès est réservée aux gestionnaires des accès du dossier.</p>
              )}
            </div>
          </Panel>
          {canAcl && acl && <AclEditorDialog open onOpenChange={setAcl} kind="document" id={doc.id} name={doc.title} canEdit />}
        </TabsContent>
      </Tabs>
    </>
  );
}

/** /cso/documents/[id] — fiche document CSO (détails, versions, partages, historique, droits). */
export default function CsoDocumentPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <DocumentView />
    </Suspense>
  );
}
