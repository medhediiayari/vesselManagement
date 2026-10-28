'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useMemo } from 'react';
import { toQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ApprovalsList } from '@/components/cso/approvals-list';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import { DocumentExplorer, type ExplorerLocation } from '@/components/cso/document-explorer';
import { CsoSearch, readSearchParams, type CsoSearchParams } from '@/components/cso/search-panel';
import { Forbidden, LoadingBlock } from '@/components/ui/states';

function CsoHome() {
  const { can } = useSession();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const searchMode = sp.has('q');
  const pendingMode = sp.get('pending') === 'true';

  // Paramètres initiaux de l'explorateur (lus une fois au montage)
  const initial = useMemo(
    () => ({
      vesselId: sp.get('vesselId'),
      libraryId: sp.get('libraryId'),
      folderId: sp.get('folderId'),
      documentId: sp.get('doc'),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const onLocationChange = useCallback(
    (loc: ExplorerLocation) => {
      if (!loc.libraryId) return;
      const qs = toQuery({ libraryId: loc.libraryId, folderId: loc.folderId, doc: loc.documentId });
      if (typeof window !== 'undefined' && window.location.search !== qs) router.replace(`${pathname}${qs}`, { scroll: false });
    },
    [router, pathname],
  );

  if (!can('cso.view')) return <Forbidden />;

  if (searchMode) {
    const params = readSearchParams(new URLSearchParams(sp.toString()));
    return (
      <>
        <CsoPageHeader section="search" title="Recherche CSO" />
        <CsoSearch
          params={params}
          onChange={(p: CsoSearchParams) => {
            const qs = new URLSearchParams(Object.entries(p).filter(([, v]) => !!v) as [string, string][]);
            if (!qs.has('q')) qs.set('q', '');
            router.replace(`/cso?${qs.toString()}`, { scroll: false });
          }}
        />
      </>
    );
  }

  if (pendingMode) {
    return (
      <>
        <CsoPageHeader section="approvals" title="Documents CSO à valider" description="Versions et changements de référence qui attendent votre décision." />
        <ApprovalsList />
      </>
    );
  }

  return (
    <>
      <CsoPageHeader section="library" />
      <DocumentExplorer
        initialVesselId={initial.vesselId}
        initialLibraryId={initial.libraryId}
        initialFolderId={initial.folderId}
        initialDocumentId={initial.documentId}
        onLocationChange={onLocationChange}
        onSearch={(q, scope) => router.push(`/cso/search${toQuery({ q, libraryId: scope.folderId ? undefined : scope.libraryId, folderId: scope.folderId })}`)}
      />
    </>
  );
}

/** /cso — bibliothèque documentaire CSO (?vesselId=, ?q= recherche, ?pending=true validations). */
export default function CsoPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <CsoHome />
    </Suspense>
  );
}
