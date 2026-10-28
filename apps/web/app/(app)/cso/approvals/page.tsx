'use client';

import { useSession } from '@/lib/session';
import { ApprovalsList } from '@/components/cso/approvals-list';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import { Forbidden } from '@/components/ui/states';

/** /cso/approvals — boîte de validation CSO (versions + changements de référence). */
export default function CsoApprovalsPage() {
  const { can } = useSession();
  if (!can('cso.view')) return <Forbidden />;
  return (
    <>
      <CsoPageHeader
        section="approvals"
        title="Documents CSO à valider"
        description="Versions et changements de référence qui attendent votre décision. Vous ne pouvez jamais décider sur vos propres dépôts."
        breadcrumb={[{ label: 'Documents CSO', href: '/cso' }, { label: 'À valider' }]}
      />
      <ApprovalsList />
    </>
  );
}
