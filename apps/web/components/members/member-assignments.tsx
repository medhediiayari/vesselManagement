'use client';

import { Anchor, Ban, CalendarPlus, Info, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { CreatedBy } from '@/components/amc/created-by';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/states';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import {
  CancelAssignmentDialog,
  JoinAssignmentDialog,
  PlanAssignmentDialog,
  SignOffAssignmentDialog,
  type AssignmentRef,
} from './assignment-dialogs';
import { AssignmentStatusBadge, missingSignOff, servedDays } from './member-ui';
import { memberName, type MemberAssignment, type MemberDetail } from './types';

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="gauge">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className="text-lg font-semibold tabular text-navy">{value}</p>
    </div>
  );
}

function DateCell({ actual, planned }: { actual: string | null; planned: string | null }) {
  if (actual) return <span className="tabular">{fmtDate(actual)}</span>;
  if (planned)
    return (
      <span className="tabular text-ink-muted" title="Date prévue">
        {fmtDate(planned)} <span className="text-xs">(prévu)</span>
      </span>
    );
  return <span className="text-ink-soft">—</span>;
}

/**
 * Onglet Embarquements / sea service : affectations en cours (PLANNED / ONBOARD) et historique
 * (COMPLETED / CANCELLED), actions plan / join / sign-off / cancel pour vessel_crew.assign.
 */
export function MemberAssignments({ member, readOnly }: { member: MemberDetail; readOnly?: boolean }) {
  const { vesselById, can } = useSession();
  const name = memberName(member);
  const canAssign = !readOnly && member.permissions.canAssign && can('vessel_crew.assign');
  const [planOpen, setPlanOpen] = useState(false);
  const [join, setJoin] = useState<AssignmentRef | null>(null);
  const [signOff, setSignOff] = useState<AssignmentRef | null>(null);
  const [cancel, setCancel] = useState<AssignmentRef | null>(null);

  const ref = (a: MemberAssignment): AssignmentRef => ({
    id: a.id,
    memberName: name,
    vesselName: a.vessel.name,
    rank: a.rank,
    plannedJoinDate: a.plannedJoinDate,
    plannedSignOffDate: a.plannedSignOffDate,
    joinPort: a.joinPort,
    relievesAssignmentId: a.relievesAssignmentId,
    actualJoinDate: a.actualJoinDate,
    memberId: member.id,
    vesselId: a.vessel.id,
    voyageId: a.voyage?.id ?? null,
    createdBy: a.createdBy,
    createdAt: a.createdAt,
  });

  const all = [...member.currentAssignments, ...member.assignmentHistory];
  const seaDays = all
    .filter((a) => a.status === 'ONBOARD' || a.status === 'COMPLETED')
    .reduce((s, a) => s + (servedDays(a) ?? 0), 0);
  const completed = member.assignmentHistory.filter((a) => a.status === 'COMPLETED');
  const lastSignOff = completed.map((a) => a.actualSignOffDate).filter(Boolean).sort().pop() ?? null;
  const canPlan = canAssign && !member.archivedAt && member.status !== 'INACTIVE';

  const table = (rows: MemberAssignment[], withActions: boolean) => (
    <div className="overflow-x-auto">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col">Navire</th>
            <th scope="col">Fonction</th>
            <th scope="col">Statut</th>
            <th scope="col">Embarquement</th>
            <th scope="col">Débarquement</th>
            <th scope="col" className="text-right">
              Jours
            </th>
            <th scope="col" className="hidden lg:table-cell">
              Ports
            </th>
            <th scope="col" className="hidden lg:table-cell">
              Voyage
            </th>
            <th scope="col" className="hidden md:table-cell">
              Planifié par
            </th>
            {withActions && canAssign && (
              <th scope="col" className="text-right">
                Actions
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((a) => {
            const accessible = !!vesselById(a.vessel.id);
            const days = a.status === 'ONBOARD' || a.status === 'COMPLETED' ? servedDays(a) : null;
            return (
              <tr key={a.id}>
                <td>
                  {accessible ? (
                    <Link href={`/vessels/${a.vessel.id}`} className="font-medium text-action hover:underline">
                      {a.vessel.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{a.vessel.name}</span>
                  )}
                  <span className="block text-xs text-ink-muted">{a.vessel.code}</span>
                </td>
                <td>
                  {a.rank}
                  {a.position && <span className="block text-xs text-ink-muted">{a.position}</span>}
                </td>
                <td>
                  <AssignmentStatusBadge status={a.status} />
                </td>
                <td>
                  <DateCell actual={a.actualJoinDate} planned={a.plannedJoinDate} />
                </td>
                <td>
                  <DateCell actual={a.actualSignOffDate} planned={a.status === 'CANCELLED' ? null : a.plannedSignOffDate} />
                </td>
                <td className="text-right tabular">
                  {days ?? (missingSignOff(a) ? <span className="text-xs text-ink-soft">débarquement manquant</span> : '—')}
                </td>
                <td className="hidden text-xs lg:table-cell">{[a.joinPort, a.signOffPort].filter(Boolean).join(' → ') || '—'}</td>
                <td className="hidden lg:table-cell">
                  {a.voyage ? (
                    <Link href={`/voyages/${a.voyage.id}`} className="text-action hover:underline">
                      {a.voyage.reference}
                    </Link>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="hidden md:table-cell">
                  {a.createdBy ? <CreatedBy by={a.createdBy} at={a.createdAt} verb="Planifié" compact /> : <span className="text-ink-soft">—</span>}
                </td>
                {withActions && canAssign && (
                  <td>
                    <div className="flex flex-wrap justify-end gap-1">
                      {accessible && a.status === 'PLANNED' && (
                        <>
                          <Button size="sm" variant="secondary" onClick={() => setJoin(ref(a))}>
                            <Anchor className="h-4 w-4" aria-hidden /> Embarquer
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setCancel(ref(a))}>
                            <Ban className="h-4 w-4" aria-hidden /> Annuler
                          </Button>
                        </>
                      )}
                      {accessible && a.status === 'ONBOARD' && (
                        <Button size="sm" variant="secondary" onClick={() => setSignOff(ref(a))}>
                          <LogOut className="h-4 w-4" aria-hidden /> Débarquer
                        </Button>
                      )}
                      {!accessible && <span className="text-xs text-ink-muted">Navire hors périmètre</span>}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat label="Jours de mer (affichés)" value={seaDays} />
        <Stat label="Embarquements terminés" value={completed.length} />
        <Stat label="Affectations en cours ou prévues" value={member.currentAssignments.length} />
        <Stat label="Dernier débarquement" value={lastSignOff ? fmtDate(lastSignOff) : '—'} />
      </div>
      {member.assignmentScope === 'ACCESSIBLE_VESSELS' && (
        <p className="flex items-start gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Parcours limité aux navires de votre périmètre : les embarquements sur d’autres navires ne sont pas affichés.
        </p>
      )}
      <Panel
        title="Affectations en cours et planifiées"
        bodyClassName="p-0"
        actions={
          canPlan ? (
            <Button size="sm" onClick={() => setPlanOpen(true)}>
              <CalendarPlus className="h-4 w-4" aria-hidden /> Planifier un embarquement
            </Button>
          ) : undefined
        }
      >
        {member.currentAssignments.length ? (
          table(member.currentAssignments, true)
        ) : (
          <EmptyState title="Aucune affectation en cours" description="Les embarquements planifiés et en cours apparaîtront ici." />
        )}
      </Panel>
      <Panel title="Historique d'embarquement" bodyClassName="p-0">
        {member.assignmentHistory.length ? (
          table(member.assignmentHistory, false)
        ) : (
          <EmptyState title="Aucun embarquement terminé" description="Les débarquements et annulations sont conservés ici." />
        )}
      </Panel>

      {canAssign && (
        <>
          <PlanAssignmentDialog open={planOpen} onOpenChange={setPlanOpen} member={{ id: member.id, name, rank: member.rank }} />
          <JoinAssignmentDialog assignment={join} onOpenChange={(o) => !o && setJoin(null)} />
          <SignOffAssignmentDialog assignment={signOff} onOpenChange={(o) => !o && setSignOff(null)} />
          <CancelAssignmentDialog assignment={cancel} onOpenChange={(o) => !o && setCancel(null)} />
        </>
      )}
    </div>
  );
}
