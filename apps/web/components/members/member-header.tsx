'use client';

import { Archive, UserRound } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page';
import { useSession } from '@/lib/session';
import { DepartmentLabel, MemberAvatar, MemberStatusBadge } from './member-ui';
import { memberName, type MemberDetail } from './types';

/** En-tête identité de la fiche (Member Detail, CDC §2.4) : photo, nom, matricule, fonction, statut, compte lié. */
export function MemberHeader({
  member,
  breadcrumb,
  actions,
  photoAction,
}: {
  member: MemberDetail;
  breadcrumb: { label: string; href?: string }[];
  actions?: ReactNode;
  photoAction?: ReactNode;
}) {
  const { can } = useSession();
  const name = memberName(member);
  const onboard = member.currentAssignments.find((a) => a.status === 'ONBOARD');
  const planned = member.currentAssignments.find((a) => a.status === 'PLANNED');
  return (
    <PageHeader
      breadcrumb={breadcrumb}
      title={
        <span className="flex items-center gap-3">
          <span className="relative">
            <MemberAvatar photoFileId={member.photoFileId} name={name} size="lg" />
            {photoAction}
          </span>
          <span className="min-w-0">
            <span className="block truncate">{name}</span>
            <span className="block text-sm font-normal text-ink-muted">
              {[member.rank, onboard ? `à bord de ${onboard.vessel.name}` : planned ? `embarquement prévu sur ${planned.vessel.name}` : null]
                .filter(Boolean)
                .join(' — ') || 'Fonction non renseignée'}
            </span>
          </span>
        </span>
      }
      meta={
        <>
          <MemberStatusBadge status={member.status} />
          {member.archivedAt && (
            <Badge tone="neutral" icon={<Archive className="h-3.5 w-3.5" aria-hidden />}>
              Fiche archivée
            </Badge>
          )}
          <Badge tone="navy" icon={false}>
            {member.amcRef ? `Matricule ${member.amcRef}` : 'Sans matricule'}
          </Badge>
          {member.crewDepartment && (
            <Badge tone="navy" icon={false}>
              Service <DepartmentLabel value={member.crewDepartment} />
            </Badge>
          )}
          {member.linkedUser ? (
            <Badge tone="info" icon={<UserRound className="h-3.5 w-3.5" aria-hidden />} title="Compte utilisateur lié (1:1)">
              {can('users.view') ? (
                <Link href={`/admin/users/${member.linkedUser.id}`} className="hover:underline">
                  Compte {member.linkedUser.displayName}
                  {member.linkedUser.username ? ` (${member.linkedUser.username})` : ''}
                </Link>
              ) : (
                <>
                  Compte {member.linkedUser.displayName}
                  {member.linkedUser.username ? ` (${member.linkedUser.username})` : ''}
                </>
              )}
            </Badge>
          ) : (
            <Badge tone="neutral" icon={false}>
              Aucun compte lié
            </Badge>
          )}
        </>
      }
      actions={actions}
    />
  );
}
