'use client';

import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { ActionLink, AssignmentStatusBadge, DepartmentLabel, MemberAvatar, MemberStatusBadge } from './member-ui';
import { memberName, type MemberDetail } from './types';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1.5 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 truncate text-right">{children}</dd>
    </div>
  );
}

/** Panneau latéral (zone 3) : aperçu d'une fiche sélectionnée dans la liste. */
export function MemberQuickView({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['member', memberId], queryFn: () => api.get<MemberDetail>(`/members/${memberId}`) });
  return (
    <aside className="panel sticky top-4 overflow-hidden" aria-label="Aperçu de la fiche">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-sm font-semibold">Aperçu</h2>
        <IconButton label="Fermer l'aperçu" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {q.isLoading && <LoadingBlock rows={5} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && <QuickViewBody m={q.data} />}
    </aside>
  );
}

function QuickViewBody({ m }: { m: MemberDetail }) {
  const name = memberName(m);
  const current = m.currentAssignments.find((a) => a.status === 'ONBOARD') ?? m.currentAssignments[0];
  const certs = m.certificates ?? [];
  const expired = certs.filter((c) => c.validity === 'EXPIRED').length;
  const soon = certs.filter((c) => c.validity === 'EXPIRING_SOON').length;
  const missing = certs.filter((c) => c.documentMissing).length;
  return (
    <div className="p-4">
      <div className="flex items-center gap-3">
        <MemberAvatar photoFileId={m.photoFileId} name={name} size="md" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-navy">{name}</p>
          <p className="truncate text-xs text-ink-muted">{m.rank ?? 'Fonction non renseignée'}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        <MemberStatusBadge status={m.status} />
      </div>
      <dl className="mt-3 divide-y divide-line">
        <Row label="Matricule">{m.amcRef ?? '—'}</Row>
        <Row label="Service">
          <DepartmentLabel value={m.crewDepartment} />
        </Row>
        {m.birthDate !== undefined && <Row label="Naissance">{fmtDate(m.birthDate)}</Row>}
        <Row label="Téléphone">{m.phone ?? '—'}</Row>
        <Row label="E-mail">{m.email ?? '—'}</Row>
      </dl>
      <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2">
        <p className="text-xs font-medium text-ink-muted">Affectation</p>
        {current ? (
          <div className="mt-1 text-sm">
            <p className="font-medium">{current.vessel.name}</p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <AssignmentStatusBadge status={current.status} />
              {current.rank} — {current.actualJoinDate ? `depuis le ${fmtDate(current.actualJoinDate)}` : `prévu le ${fmtDate(current.plannedJoinDate)}`}
            </p>
          </div>
        ) : (
          <p className="mt-1 text-sm text-ink-muted">Aucune affectation en cours</p>
        )}
      </div>
      {m.certificates !== undefined && (
        <div className="mt-3 grid grid-cols-3 gap-2 text-center">
          <div className="rounded-md border border-line px-2 py-1.5">
            <p className={`text-md font-semibold tabular ${expired ? 'text-danger' : 'text-navy'}`}>{expired}</p>
            <p className="text-xs text-ink-muted">Expiré(s)</p>
          </div>
          <div className="rounded-md border border-line px-2 py-1.5">
            <p className={`text-md font-semibold tabular ${soon ? 'text-warn' : 'text-navy'}`}>{soon}</p>
            <p className="text-xs text-ink-muted">Bientôt</p>
          </div>
          <div className="rounded-md border border-line px-2 py-1.5">
            <p className={`text-md font-semibold tabular ${missing ? 'text-warn' : 'text-navy'}`}>{missing}</p>
            <p className="text-xs text-ink-muted">Sans scan</p>
          </div>
        </div>
      )}
      <ActionLink href={`/members/${m.id}`} variant="primary" className="mt-4 w-full">
        Ouvrir la fiche
      </ActionLink>
    </div>
  );
}
