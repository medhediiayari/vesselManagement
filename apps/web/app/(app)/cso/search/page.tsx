'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { toQuery } from '@/lib/api';
import { useSession } from '@/lib/session';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import { CsoSearch, readSearchParams } from '@/components/cso/search-panel';
import { Forbidden, LoadingBlock } from '@/components/ui/states';

function SearchView() {
  const { can } = useSession();
  const sp = useSearchParams();
  const router = useRouter();
  if (!can('cso.view')) return <Forbidden />;
  return (
    <>
      <CsoPageHeader
        section="search"
        title="Recherche CSO"
        description="Recherche par nom, référence, description et métadonnées, strictement filtrée par vos droits documentaires et de champ."
        breadcrumb={[{ label: 'Documents CSO', href: '/cso' }, { label: 'Recherche' }]}
      />
      <CsoSearch
        params={readSearchParams(new URLSearchParams(sp.toString()))}
        onChange={(p) => router.replace(`/cso/search${toQuery({ ...p })}`, { scroll: false })}
      />
    </>
  );
}

/** /cso/search — recherche plein texte + filtres, pagination serveur par curseur. */
export default function CsoSearchPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <SearchView />
    </Suspense>
  );
}
