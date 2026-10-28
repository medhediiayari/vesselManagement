'use client';

import { Download, Eye, Inbox } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { DownloadButton } from '@/components/amc/file-preview';
import { CsoPreviewDialog } from '@/components/cso/preview';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import type { SharedWithMeItem } from '@/components/cso/types';
import { Reference } from '@/components/cso/ui';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { EmptyState, Forbidden } from '@/components/ui/states';

/** /cso/shared-with-me — documents partagés en interne avec moi ou mon département (CSO-015). */
export default function SharedWithMePage() {
  const { can, vesselById } = useSession();
  const list = useCursorList<SharedWithMeItem>(['cso', 'shared-with-me'], '/cso/shared-with-me', {}, can('cso.view'));
  const [preview, setPreview] = useState<SharedWithMeItem | null>(null);
  if (!can('cso.view')) return <Forbidden />;
  return (
    <>
      <CsoPageHeader
        section="shared"
        title="Partagés avec moi"
        description="Documents CSO publiés partagés avec vous ou votre département. Le partage ne contourne jamais votre périmètre navire ni vos permissions."
        breadcrumb={[{ label: 'Documents CSO', href: '/cso' }, { label: 'Partagés avec moi' }]}
      />
      <DataTable
        caption="Documents partagés avec moi"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={() => list.loadMore()}
        loadingMore={list.loadingMore}
        empty={<EmptyState icon={<Inbox className="h-5 w-5" aria-hidden />} title="Aucun partage" description="Les documents partagés avec vous apparaîtront ici." />}
        columns={[
          {
            key: 'doc',
            header: 'Document',
            cell: (r) => (
              <div className="max-w-[360px]">
                <Link href={`/cso/documents/${r.document.id}`} className="font-medium text-navy hover:text-action hover:underline">
                  {r.document.title}
                </Link>
                <div>
                  <Reference value={r.document.reference} />
                </div>
              </div>
            ),
          },
          { key: 'vessel', header: 'Navire', hideBelow: 'md', cell: (r) => (r.document.vesselId ? vesselById(r.document.vesselId)?.name ?? '—' : 'Flotte') },
          {
            key: 'by',
            header: 'Partagé par',
            hideBelow: 'sm',
            cell: (r) => (
              <>
                <span className="block">{r.sharedBy?.displayName ?? '—'}</span>
                <span className="text-xs text-ink-muted">{fmtDateTime(r.createdAt)}</span>
              </>
            ),
          },
          {
            key: 'msg',
            header: 'Message',
            hideBelow: 'lg',
            cell: (r) => (r.message ? <span className="line-clamp-2 max-w-xs text-sm">« {r.message} »</span> : <span className="text-ink-soft">—</span>),
          },
          {
            key: 'rights',
            header: 'Droits',
            cell: (r) =>
              r.canDownload ? (
                <Badge tone="info" icon={<Download className="h-3.5 w-3.5" aria-hidden />}>Consultation + téléchargement</Badge>
              ) : (
                <Badge tone="neutral" icon={<Eye className="h-3.5 w-3.5" aria-hidden />}>Consultation</Badge>
              ),
          },
          {
            key: 'actions',
            header: <span className="sr-only">Actions</span>,
            cell: (r) => (
              <div className="flex justify-end gap-1">
                {can('cso.preview') && (
                  <Button variant="ghost" size="sm" onClick={() => setPreview(r)}>
                    <Eye className="h-4 w-4" aria-hidden /> Aperçu
                  </Button>
                )}
                {r.canDownload && <DownloadButton size="sm" path={`/cso/documents/${r.document.id}/download`} />}
              </div>
            ),
          },
        ]}
      />
      {preview && (
        <CsoPreviewDialog
          open={!!preview}
          onOpenChange={(o) => !o && setPreview(null)}
          title={preview.document.title}
          previewPath={`/cso/documents/${preview.document.id}/preview`}
          downloadPath={`/cso/documents/${preview.document.id}/download`}
          canDownload={preview.canDownload}
        />
      )}
    </>
  );
}
