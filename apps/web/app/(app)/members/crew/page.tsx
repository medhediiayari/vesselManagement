'use client';

import { useQuery } from '@tanstack/react-query';
import { Anchor, Ban, CalendarPlus, ExternalLink, LogOut, Repeat2, Ship } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import {
  CancelAssignmentDialog,
  JoinAssignmentDialog,
  PlanAssignmentDialog,
  SignOffAssignmentDialog,
  type AssignmentRef,
} from '@/components/members/assignment-dialogs';
import { AssignmentStatusBadge, daysBetween, DepartmentLabel, MemberAvatar } from '@/components/members/member-ui';
import { CREW_DEPARTMENT_LABELS, memberName, todayYmd, type CrewAssignmentDto, type CrewDepartment, type Roster } from '@/components/members/types';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';

function MemberCell({ a }: { a: CrewAssignmentDto }) {
  const name = memberName(a.member);
  return (
    <span className="flex items-center gap-2">
      <MemberAvatar photoFileId={a.memberAccessible ? a.member.photoFileId : null} name={name} />
      <span className="min-w-0">
        {a.memberAccessible ? (
          <Link href={`/members/${a.member.id}`} className="block truncate font-medium text-navy hover:text-action hover:underline">
            {name}
          </Link>
        ) : (
          <span className="block truncate font-medium" title="Fiche hors de votre périmètre (ADM-070)">
            {name}
          </span>
        )}
        <span className="block text-xs text-ink-muted">{a.member.amcRef ?? 'Sans matricule'}</span>
      </span>
    </span>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'warn' }) {
  return (
    <div className="gauge">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={cn('text-lg font-semibold tabular', tone === 'warn' ? 'text-warn' : 'text-navy')}>{value}</p>
    </div>
  );
}

function CrewRoster() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { me, can, currentVessel } = useSession();
  const vessels = me.accessibleVessels;
  const vesselId = params.get('vesselId') ?? currentVessel?.id ?? vessels[0]?.id ?? '';
  const date = params.get('date') ?? '';
  const canAssign = can('vessel_crew.assign');

  const [planOpen, setPlanOpen] = useState(false);
  const [relief, setRelief] = useState<{ id: string; name: string; rank: string } | null>(null);
  const [join, setJoin] = useState<AssignmentRef | null>(null);
  const [signOff, setSignOff] = useState<AssignmentRef | null>(null);
  const [cancel, setCancel] = useState<AssignmentRef | null>(null);

  const setParam = (k: string, v: string) => {
    const sp = new URLSearchParams(params.toString());
    if (v) sp.set(k, v);
    else sp.delete(k);
    if (k === 'vesselId' && !sp.get('vesselId')) sp.delete('vesselId');
    router.replace(`${pathname}?${sp.toString()}`);
  };

  const roster = useQuery({
    queryKey: ['vessel-roster', vesselId, date || null],
    queryFn: () => api.get<Roster>(`/vessels/${vesselId}/crew`, { query: { date: date || undefined } }),
    enabled: !!vesselId,
  });

  const vessel = vessels.find((v) => v.id === vesselId);
  const vesselOpen = vessel && vessel.status !== 'SOLD' && vessel.status !== 'INACTIVE';
  const data = roster.data;
  const names = new Map<string, string>();
  [...(data?.onboard ?? []), ...(data?.planned ?? [])].forEach((a) => names.set(a.id, memberName(a.member)));

  const ref = (a: CrewAssignmentDto): AssignmentRef => ({
    id: a.id,
    memberName: memberName(a.member),
    vesselName: a.vessel.name,
    rank: a.rank,
    plannedJoinDate: a.plannedJoinDate,
    plannedSignOffDate: a.plannedSignOffDate,
    joinPort: a.joinPort,
    relievesAssignmentId: a.relievesAssignmentId,
    relievesName: a.relievesAssignmentId ? names.get(a.relievesAssignmentId) ?? null : null,
    actualJoinDate: a.actualJoinDate,
  });

  const today = todayYmd();
  const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const onboardNow = data?.onboard.filter((a) => a.status === 'ONBOARD') ?? [];
  const dueSoon = onboardNow.filter((a) => a.plannedSignOffDate && a.plannedSignOffDate <= in30).length;
  const byDept = new Map<string, number>();
  (data?.onboard ?? []).forEach((a) => {
    const k = a.member.crewDepartment ?? 'OTHER';
    byDept.set(k, (byDept.get(k) ?? 0) + 1);
  });
  const historical = !!date && date < today;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Marins & personnel', href: '/members' }, { label: 'Équipage par navire' }]}
        title="Équipage par navire"
        description="Personnes effectivement à bord (affectations confirmées) et embarquements planifiés, à la date choisie. La liste historique des marins n'est pas l'équipage embarqué."
        actions={
          canAssign && vesselOpen ? (
            <Button
              onClick={() => {
                setRelief(null);
                setPlanOpen(true);
              }}
            >
              <CalendarPlus className="h-4 w-4" aria-hidden /> Planifier un embarquement
            </Button>
          ) : undefined
        }
      />

      <FilterBar>
        <div className="w-full sm:w-72">
          <label className="field-label" htmlFor="crew-vessel">
            Navire
          </label>
          <Select id="crew-vessel" value={vesselId} onChange={(e) => setParam('vesselId', e.target.value)}>
            {!vessels.length && <option value="">Aucun navire dans votre périmètre</option>}
            {vessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.code}){v.status !== 'ACTIVE' ? ` — ${v.status.toLowerCase()}` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <label className="field-label" htmlFor="crew-date">
            Date
          </label>
          <Input id="crew-date" type="date" value={date} onChange={(e) => setParam('date', e.target.value)} />
        </div>
        <Button variant="secondary" onClick={() => setParam('date', '')} disabled={!date}>
          Situation actuelle
        </Button>
        <p className="mb-2 max-w-md text-xs text-ink-muted">
          {date
            ? historical
              ? `À bord le ${fmtDate(date)} (embarquements confirmés couvrant cette date).`
              : `Situation au ${fmtDate(date)} : à bord et arrivées planifiées couvrant la date.`
            : 'Sans date : équipage actuellement à bord et tous les embarquements planifiés.'}
        </p>
      </FilterBar>

      {!vesselId && <EmptyState icon={<Ship className="h-5 w-5" aria-hidden />} title="Aucun navire accessible" description="Votre périmètre ne comprend aucun navire." />}
      {vesselId && roster.isLoading && <LoadingBlock rows={8} />}
      {vesselId && roster.error && <ErrorState error={roster.error} onRetry={() => roster.refetch()} />}

      {data && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
          <div className="space-y-4">
            <Panel title={`À bord${date ? ` le ${fmtDate(date)}` : ''} (${data.counts.onboard})`} bodyClassName="p-0">
              {data.onboard.length ? (
                <div className="overflow-x-auto">
                  <table className="table-amc">
                    <caption className="sr-only">Équipage à bord</caption>
                    <thead>
                      <tr>
                        <th scope="col">Marin</th>
                        <th scope="col">Fonction</th>
                        <th scope="col" className="hidden lg:table-cell">
                          Service
                        </th>
                        <th scope="col">Embarqué le</th>
                        <th scope="col">Débarquement</th>
                        <th scope="col" className="text-right">
                          Jours
                        </th>
                        {canAssign && !historical && (
                          <th scope="col" className="text-right">
                            Actions
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.onboard.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <MemberCell a={a} />
                          </td>
                          <td>
                            {a.rank}
                            {a.position && <span className="block text-xs text-ink-muted">{a.position}</span>}
                          </td>
                          <td className="hidden lg:table-cell">
                            <DepartmentLabel value={a.member.crewDepartment} />
                          </td>
                          <td className="tabular">
                            {fmtDate(a.actualJoinDate)}
                            {a.joinPort && <span className="block text-xs text-ink-muted">{a.joinPort}</span>}
                          </td>
                          <td className="tabular">
                            {a.status === 'COMPLETED' ? (
                              <span className="flex flex-col items-start gap-0.5">
                                {fmtDate(a.actualSignOffDate)}
                                <AssignmentStatusBadge status={a.status} />
                              </span>
                            ) : a.plannedSignOffDate ? (
                              <span className={cn(a.plannedSignOffDate <= in30 && 'font-medium text-warn')}>
                                {fmtDate(a.plannedSignOffDate)} <span className="text-xs text-ink-muted">(prévu)</span>
                              </span>
                            ) : (
                              <span className="text-ink-soft">Non planifié</span>
                            )}
                          </td>
                          <td className="text-right tabular">{daysBetween(a.actualJoinDate, a.actualSignOffDate ?? (date || null)) ?? '—'}</td>
                          {canAssign && !historical && (
                            <td>
                              {a.status === 'ONBOARD' && (
                                <div className="flex flex-wrap justify-end gap-1">
                                  <Button size="sm" variant="secondary" onClick={() => setSignOff(ref(a))}>
                                    <LogOut className="h-4 w-4" aria-hidden /> Débarquer
                                  </Button>
                                  {vesselOpen && (
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      onClick={() => {
                                        setRelief({ id: a.id, name: memberName(a.member), rank: a.rank });
                                        setPlanOpen(true);
                                      }}
                                    >
                                      <Repeat2 className="h-4 w-4" aria-hidden /> Relève
                                    </Button>
                                  )}
                                </div>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="Personne à bord" description={date ? 'Aucun embarquement confirmé ne couvre cette date.' : 'Aucun marin embarqué sur ce navire.'} />
              )}
            </Panel>

            <Panel title={`Embarquements prévus (${data.counts.planned})`} bodyClassName="p-0">
              {historical ? (
                <p className="px-4 py-3 text-sm text-ink-muted">Les embarquements planifiés ne s’affichent que pour aujourd’hui ou une date future.</p>
              ) : data.planned.length ? (
                <div className="overflow-x-auto">
                  <table className="table-amc">
                    <caption className="sr-only">Embarquements planifiés</caption>
                    <thead>
                      <tr>
                        <th scope="col">Marin</th>
                        <th scope="col">Fonction</th>
                        <th scope="col">Embarquement prévu</th>
                        <th scope="col">Débarquement prévu</th>
                        <th scope="col" className="hidden lg:table-cell">
                          Relève de
                        </th>
                        {canAssign && (
                          <th scope="col" className="text-right">
                            Actions
                          </th>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {data.planned.map((a) => (
                        <tr key={a.id}>
                          <td>
                            <MemberCell a={a} />
                          </td>
                          <td>
                            {a.rank}
                            {a.position && <span className="block text-xs text-ink-muted">{a.position}</span>}
                          </td>
                          <td className="tabular">
                            {a.plannedJoinDate ? fmtDate(a.plannedJoinDate) : <span className="text-ink-soft">À fixer</span>}
                            {a.joinPort && <span className="block text-xs text-ink-muted">{a.joinPort}</span>}
                          </td>
                          <td className="tabular">{fmtDate(a.plannedSignOffDate)}</td>
                          <td className="hidden lg:table-cell">{a.relievesAssignmentId ? names.get(a.relievesAssignmentId) ?? 'Affectation hors liste' : '—'}</td>
                          {canAssign && (
                            <td>
                              <div className="flex flex-wrap justify-end gap-1">
                                <Button size="sm" variant="secondary" onClick={() => setJoin(ref(a))}>
                                  <Anchor className="h-4 w-4" aria-hidden /> Embarquer
                                </Button>
                                <Button size="sm" variant="ghost" onClick={() => setCancel(ref(a))}>
                                  <Ban className="h-4 w-4" aria-hidden /> Annuler
                                </Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyState title="Aucun embarquement prévu" description="Planifiez une affectation ou une relève pour la voir ici." />
              )}
            </Panel>
          </div>

          <aside className="space-y-4" aria-label="Synthèse de l'équipage">
            <Panel title={data.vessel.name}>
              <div className="grid grid-cols-2 gap-2">
                <Stat label="À bord" value={data.counts.onboard} />
                <Stat label="Prévus" value={data.counts.planned} />
                <Stat label="Débarquements sous 30 j" value={dueSoon} tone={dueSoon ? 'warn' : undefined} />
                <Stat label="Sans date de fin" value={onboardNow.filter((a) => !a.plannedSignOffDate).length} />
              </div>
              {byDept.size > 0 && (
                <dl className="mt-3 divide-y divide-line text-sm">
                  {[...byDept.entries()].map(([k, n]) => (
                    <div key={k} className="flex justify-between py-1.5">
                      <dt className="text-ink-muted">{CREW_DEPARTMENT_LABELS[k as CrewDepartment] ?? k}</dt>
                      <dd className="tabular">{n}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm">
                <Link href={`/vessels/${data.vessel.id}`} className="flex items-center gap-1 font-medium text-action hover:underline">
                  Workspace du navire <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
                <Link href={`/members?vesselId=${data.vessel.id}`} className="flex items-center gap-1 font-medium text-action hover:underline">
                  Fiches de l’équipage <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                </Link>
                {can('certificates.view') && (
                  <Link
                    href={`/certificates?crewVesselId=${data.vessel.id}&subjectKind=MEMBER`}
                    className="flex items-center gap-1 font-medium text-action hover:underline"
                  >
                    Certificats de l’équipage <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </Link>
                )}
              </div>
            </Panel>
          </aside>
        </div>
      )}

      {canAssign && (
        <>
          <PlanAssignmentDialog
            open={planOpen}
            onOpenChange={(o) => {
              setPlanOpen(o);
              if (!o) setRelief(null);
            }}
            vesselId={vesselId}
            relieves={relief}
          />
          <JoinAssignmentDialog assignment={join} onOpenChange={(o) => !o && setJoin(null)} />
          <SignOffAssignmentDialog assignment={signOff} onOpenChange={(o) => !o && setSignOff(null)} />
          <CancelAssignmentDialog assignment={cancel} onOpenChange={(o) => !o && setCancel(null)} />
        </>
      )}
    </>
  );
}

export default function CrewRosterPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <CrewRoster />
    </Suspense>
  );
}
