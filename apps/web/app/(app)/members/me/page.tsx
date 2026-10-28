'use client';

import { useQuery } from '@tanstack/react-query';
import { UserRoundX } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { MemberAssignments } from '@/components/members/member-assignments';
import { MemberCertificates } from '@/components/members/member-certificates';
import { MemberDocuments } from '@/components/members/member-documents';
import { MemberHeader } from '@/components/members/member-header';
import { MemberProfile } from '@/components/members/member-profile';
import type { MemberSelfDetail } from '@/components/members/types';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError, api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function MyMemberPage() {
  const { can, me } = useSession();
  const [tab, setTab] = useState('profile');
  const q = useQuery({
    queryKey: ['member-self'],
    queryFn: () => api.get<MemberSelfDetail>('/members/me'),
    retry: false,
  });

  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error instanceof ApiError && q.error.status === 404) {
    return (
      <EmptyState
        icon={<UserRoundX className="h-5 w-5" aria-hidden />}
        title="Aucune fiche liée à votre compte"
        description="Votre compte utilisateur n'est rattaché à aucune fiche Member. Un administrateur peut effectuer ce lien depuis la gestion des utilisateurs."
        action={
          <Link href="/account" className="text-sm font-medium text-action hover:underline">
            Retour à mon compte
          </Link>
        }
      />
    );
  }
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const m = q.data;
  const reload = async () => (await q.refetch()).data;
  // Les documents relèvent de l'API Members (members.view) : onglet proposé seulement avec ce droit
  const showDocuments = can('members.view');

  return (
    <>
      <MemberHeader
        member={m}
        breadcrumb={[{ label: me.displayName, href: '/account' }, { label: 'Ma fiche' }]}
        actions={
          can('members.view') ? (
            <Link href={`/members/${m.id}`} className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-action hover:bg-navy-50">
              Vue complète de la fiche
            </Link>
          ) : undefined
        }
      />
      <p className="mb-4 max-w-3xl text-sm text-ink-muted">
        Votre fiche Members est la source de vos données personnelles communes. Vous pouvez mettre à jour les coordonnées ouvertes au
        libre-service ; vos identifiants officiels, certificats et embarquements sont tenus par l’équipe Crewing.
      </p>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="profile">Profil</TabsTrigger>
          {m.certificates !== undefined && (
            <TabsTrigger value="certificates" count={m.certificates.length}>
              Certificats
            </TabsTrigger>
          )}
          <TabsTrigger value="sea" count={m.currentAssignments.length + m.assignmentHistory.length}>
            Embarquements
          </TabsTrigger>
          {showDocuments && (
            <TabsTrigger value="documents" count={m.documentsCount}>
              Documents
            </TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="profile">
          <MemberProfile member={m} mode="self" selfEditableFields={m.selfEditableFields} reload={reload} />
        </TabsContent>
        {m.certificates !== undefined && (
          <TabsContent value="certificates">
            <MemberCertificates member={m} summaryOnly />
          </TabsContent>
        )}
        <TabsContent value="sea">
          <MemberAssignments member={m} readOnly />
        </TabsContent>
        {showDocuments && (
          <TabsContent value="documents">
            <MemberDocuments member={m} readOnly />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
