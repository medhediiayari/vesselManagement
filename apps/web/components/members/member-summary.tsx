'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, BookUser, CheckCircle2, ExternalLink, FileText, Info, Ship, X } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { DashboardCard } from '@/components/dashboard/dashboard-card';
import { DonutCard, STATE } from '@/components/dashboard/donut-card';
import { SecureImage } from '@/components/amc/secure-image';
import { Badge } from '@/components/ui/badge';
import { IconButton } from '@/components/ui/button';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn, daysUntil, fmtDate, initials } from '@/lib/format';
import { countryName, DelayBadge, DocStateBadge, documentState, type DocState } from './member-overview-lib';
import { AssignmentStatusBadge, DepartmentLabel, MemberStatusBadge, missingSignOff, servedDays } from './member-ui';
import { memberName, type MemberAssignment, type MemberDetail } from './types';

const none = <span className="text-ink-soft">Non renseigné</span>;

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="whitespace-nowrap text-ink-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v === null || v === undefined || v === false || v === '' ? none : v}</dd>
        </div>
      ))}
    </dl>
  );
}

function age(birth: string | null): number | null {
  if (!birth) return null;
  const b = new Date(`${birth}T00:00:00Z`);
  const n = new Date();
  let a = n.getUTCFullYear() - b.getUTCFullYear();
  if (n.getUTCMonth() < b.getUTCMonth() || (n.getUTCMonth() === b.getUTCMonth() && n.getUTCDate() < b.getUTCDate())) a -= 1;
  return a;
}

function duration(days: number | null): string {
  if (days === null) return '—';
  if (days < 60) return `${days} j`;
  return `${Math.round(days / 30.44)} mois`;
}

/** Contrat en cours : embarquement → débarquement prévu, avec le temps restant ou le dépassement. */
function ContractPeriod({ a }: { a: MemberAssignment | undefined }) {
  if (!a) return none;
  const from = a.actualJoinDate ?? a.plannedJoinDate;
  const left = daysUntil(a.plannedSignOffDate);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className="tabular">
        {fmtDate(from)} → {a.plannedSignOffDate ? fmtDate(a.plannedSignOffDate) : 'fin non planifiée'}
      </span>
      {left !== null && a.status === 'ONBOARD' && (
        <Badge tone={left < 0 ? 'danger' : 'teal'} icon={false} className="text-2xs">
          {left < 0 ? `Dépassé de ${-left} j` : `${duration(left)} restant${left > 1 ? 's' : ''}`}
        </Badge>
      )}
    </span>
  );
}

// -----------------------------------------------------------------------------
// Points d'attention : dérivés des données de la fiche, aucun seuil inventé
// -----------------------------------------------------------------------------

type Severity = 'danger' | 'warn' | 'info';
interface Alert {
  key: string;
  severity: Severity;
  title: string;
  detail: string;
  href?: string;
}
const SEVERITY: Record<Severity, { icon: typeof Info; rule: string; text: string; rank: number }> = {
  danger: { icon: AlertOctagon, rule: 'bg-danger', text: 'text-danger', rank: 0 },
  warn: { icon: AlertTriangle, rule: 'bg-warn', text: 'text-warn', rank: 1 },
  info: { icon: Info, rule: 'bg-info', text: 'text-info', rank: 2 },
};

function buildAlerts(m: MemberDetail, soonDays: number, docs: { label: string; state: DocState; expiry: string | null }[]): Alert[] {
  const out: Alert[] = [];
  for (const c of m.certificates ?? []) {
    const href = `/certificates/${c.id}`;
    if (c.validity === 'EXPIRED') out.push({ key: `exp-${c.id}`, severity: 'danger', title: `${c.type.name} expiré`, detail: `Échéance dépassée depuis le ${fmtDate(c.expiryOn)}`, href });
    if (c.validity === 'EXPIRING_SOON') out.push({ key: `soon-${c.id}`, severity: 'warn', title: `${c.type.name} expire bientôt`, detail: `Échéance le ${fmtDate(c.expiryOn)} (seuil ${soonDays} j)`, href });
    if (c.validity === 'EXPIRY_UNKNOWN') out.push({ key: `unk-${c.id}`, severity: 'info', title: `Échéance inconnue : ${c.type.name}`, detail: 'Date à compléter, aucune alerte d’expiration possible', href });
    if (c.validity === 'NOT_APPROVED') out.push({ key: `na-${c.id}`, severity: 'info', title: `${c.type.name} non approuvé`, detail: 'Aucune révision validée à ce jour', href });
    if (c.documentMissing) out.push({ key: `doc-${c.id}`, severity: 'warn', title: `Justificatif manquant : ${c.type.name}`, detail: 'Révision courante sans document officiel déposé', href });
    for (const r of c.openRequests) {
      if (r.status === 'RETURNED') out.push({ key: `ret-${r.id}`, severity: 'warn', title: `Demande retournée : ${c.type.name}`, detail: 'Correction attendue avant nouvelle soumission', href });
      if (r.status === 'PENDING_APPROVAL') out.push({ key: `pend-${r.id}`, severity: 'info', title: `Nouvelle version en validation : ${c.type.name}`, detail: 'L’ancienne version reste courante jusqu’à approbation', href });
    }
  }
  for (const d of docs) {
    if (d.state === 'EXPIRED') out.push({ key: `id-${d.label}`, severity: 'danger', title: `${d.label} expiré`, detail: `Expiré depuis le ${fmtDate(d.expiry)}` });
    if (d.state === 'EXPIRING_SOON') out.push({ key: `id-${d.label}`, severity: 'warn', title: `${d.label} expire bientôt`, detail: `Expiration le ${fmtDate(d.expiry)}` });
    if (d.state === 'MISSING') out.push({ key: `id-${d.label}`, severity: 'info', title: `${d.label} non renseigné`, detail: 'Numéro et date d’expiration absents de la fiche' });
  }
  const onboard = m.currentAssignments.find((a) => a.status === 'ONBOARD');
  const left = daysUntil(onboard?.plannedSignOffDate);
  if (onboard && left !== null && left < 0) {
    out.push({ key: 'signoff', severity: 'warn', title: 'Débarquement prévu dépassé', detail: `Prévu le ${fmtDate(onboard.plannedSignOffDate)} sur ${onboard.vessel.name}` });
  }
  return out.sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);
}

function AlertList({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) {
    return (
      <p className="flex items-center gap-2 border-t border-line py-5 text-sm text-ok">
        <CheckCircle2 className="h-4 w-4" aria-hidden /> Aucun point d’attention sur cette fiche.
      </p>
    );
  }
  const shown = alerts.slice(0, 6);
  return (
    <>
      <ul className="space-y-1.5">
        {shown.map((a) => {
          const s = SEVERITY[a.severity];
          const body = (
            <>
              <span className={cn('absolute inset-y-1.5 left-0 w-[3px] rounded-r', s.rule)} aria-hidden />
              <s.icon className={cn('mt-0.5 h-4 w-4 shrink-0', s.text)} aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium text-ink">{a.title}</span>
                <span className="block truncate text-xs text-ink-muted">{a.detail}</span>
              </span>
            </>
          );
          const cls = 'relative flex gap-2.5 rounded-md bg-surface-sunken py-2 pl-3.5 pr-3';
          return (
            <li key={a.key}>
              {a.href ? (
                <Link href={a.href} className={cn(cls, 'hover:bg-action-50/70')}>
                  {body}
                </Link>
              ) : (
                <div className={cls}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      {alerts.length > shown.length && <p className="mt-2 text-xs text-ink-muted">+ {alerts.length - shown.length} autre(s) point(s) sur la fiche complète.</p>}
    </>
  );
}

// -----------------------------------------------------------------------------
// Panneau
// -----------------------------------------------------------------------------

/**
 * Synthèse du marin sélectionné (grand écran) : lecture seule, issue de GET /members/:id.
 * `side` : présentation en une colonne pour le panneau latéral fixe de la liste (audit UI-05).
 * Les certificats n'apparaissent qu'avec members.certificates.view ; les actions restent dans la fiche complète.
 */
export function MemberSummary({ memberId, soonDays, onClose, side = false }: { memberId: string; soonDays: number; onClose: () => void; side?: boolean }) {
  const q = useQuery({ queryKey: ['member', memberId], queryFn: () => api.get<MemberDetail>(`/members/${memberId}`) });
  if (q.isLoading) {
    return (
      <div className={side ? 'panel' : 'panel mt-5'}>
        <LoadingBlock rows={6} label="Chargement de la fiche…" />
      </div>
    );
  }
  if (q.error || !q.data) {
    return (
      <div className={side ? 'panel' : 'panel mt-5'}>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  }
  return <SummaryBody m={q.data} soonDays={soonDays} onClose={onClose} side={side} />;
}

function SummaryBody({ m, soonDays, onClose, side }: { m: MemberDetail; soonDays: number; onClose: () => void; side: boolean }) {
  const name = memberName(m);
  const base = `/members/${m.id}`;
  const current = m.currentAssignments.find((a) => a.status === 'ONBOARD') ?? m.currentAssignments[0];
  const years = age(m.birthDate);
  const passport = { label: 'Passeport', state: documentState(m.passportNumber, m.passportExpiry, soonDays), expiry: m.passportExpiry };
  const seamanBook = { label: 'Seaman book', state: documentState(m.seamanBookNumber, m.seamanBookExpiry, soonDays), expiry: m.seamanBookExpiry };
  const certs = m.certificates;
  const alerts = buildAlerts(m, soonDays, [passport, seamanBook]);

  // Conformité : en validité = valides + illimités + expirant bientôt (encore valides)
  const count = (v: string) => (certs ?? []).filter((c) => c.validity === v).length;
  const total = certs?.length ?? 0;
  const ok = count('VALID') + count('UNLIMITED') + count('EXPIRING_SOON');

  const deadlines = [
    ...(certs ?? [])
      .filter((c) => c.expiryKind === 'DATED' && c.expiryOn)
      .map((c) => ({ key: c.id, label: c.type.name, code: c.type.code, date: c.expiryOn!, href: `/certificates/${c.id}` })),
    ...[
      { ...passport, date: m.passportExpiry, code: 'Identité' },
      { ...seamanBook, date: m.seamanBookExpiry, code: 'Identité' },
    ]
      .filter((d) => d.date)
      .map((d) => ({ key: d.label, label: d.label, code: d.code, date: d.date!, href: undefined as string | undefined })),
  ]
    .map((d) => ({ ...d, days: daysUntil(d.date)! }))
    .sort((a, b) => a.days - b.days);

  const assignments = [...m.currentAssignments, ...m.assignmentHistory]
    .sort((x, y) => (y.actualJoinDate ?? y.plannedJoinDate ?? '').localeCompare(x.actualJoinDate ?? x.plannedJoinDate ?? ''))
    .slice(0, 4);

  return (
    <section aria-label={`Synthèse de la fiche ${name}`} className={side ? 'space-y-4' : 'mt-5 space-y-5'}>
      <div className={side ? 'grid gap-4' : 'grid gap-5 xl:grid-cols-2 min-[1600px]:grid-cols-[minmax(0,2.3fr)_minmax(0,1fr)_minmax(0,1fr)]'}>
        {/* Identité, affectation, pièces maritimes */}
        <div className={cn('panel relative p-4', !side && 'xl:col-span-2 min-[1600px]:col-span-1')}>
          <div className={side ? '-mt-1 mb-3 flex items-center justify-end gap-1' : 'absolute right-3 top-3 flex items-center gap-1'}>
            <Link href={base} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-action hover:bg-action-50">
              Fiche complète <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            </Link>
            <IconButton label="Fermer la synthèse" onClick={onClose}>
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          <div className={side ? 'flex flex-col gap-4' : 'flex flex-col gap-5 sm:flex-row'}>
            {m.photoFileId ? (
              <SecureImage fileId={m.photoFileId} alt={`Photo de ${name}`} className={cn('shrink-0 rounded-lg border border-line', side ? 'h-24 w-20' : 'h-36 w-28')} />
            ) : (
              <span
                className={cn('flex shrink-0 items-center justify-center rounded-lg bg-navy-50 font-semibold text-navy-600', side ? 'h-24 w-20 text-xl' : 'h-36 w-28 text-2xl')}
                aria-hidden
              >
                {initials(name)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className={cn('flex flex-wrap items-center gap-2', !side && 'sm:pr-48')}>
                <h2 className="text-xl font-semibold">{name}</h2>
                <MemberStatusBadge status={m.status} />
              </div>
              <div className={side ? 'mt-3 grid gap-y-4' : 'mt-3 grid gap-x-8 gap-y-4 lg:grid-cols-3'}>
                <Facts
                  items={[
                    ['Matricule', m.amcRef && <span className="ref">{m.amcRef}</span>],
                    ['Fonction', m.rank],
                    ['Service', m.crewDepartment && <DepartmentLabel value={m.crewDepartment} />],
                    ['Nationalité', m.nationality && `${countryName(m.nationality)} (${m.nationality})`],
                    ['Naissance', m.birthDate && `${fmtDate(m.birthDate)}${years !== null ? ` (${years} ans)` : ''}`],
                  ]}
                />
                <Facts
                  items={[
                    [
                      'Navire',
                      current && (
                        <Link href={`/vessels/${current.vessel.id}`} className="inline-flex items-center gap-1.5 font-medium text-action hover:underline">
                          <Ship className="h-3.5 w-3.5" aria-hidden /> {current.vessel.name}
                        </Link>
                      ),
                    ],
                    ['Contrat', <ContractPeriod key="c" a={current} />],
                    ['Téléphone', m.phone && <a href={`tel:${m.phone}`} className="hover:text-action hover:underline">{m.phone}</a>],
                    ['E-mail', m.email && <a href={`mailto:${m.email}`} className="text-action hover:underline">{m.email}</a>],
                    ['Urgence', (m.emergencyContactName || m.emergencyContactPhone) && [m.emergencyContactName, m.emergencyContactPhone].filter(Boolean).join(' · ')],
                  ]}
                />
                <Facts
                  items={[
                    ['Seaman book', m.seamanBookNumber && <span className="ref">{m.seamanBookNumber}</span>],
                    ['Expiration', m.seamanBookExpiry && fmtDate(m.seamanBookExpiry)],
                    ['Passeport', m.passportNumber && <span className="ref">{m.passportNumber}</span>],
                    ['Délivré par', m.passportCountry && `${countryName(m.passportCountry)} (${m.passportCountry})`],
                    ['Expiration', m.passportExpiry && fmtDate(m.passportExpiry)],
                  ]}
                />
              </div>
            </div>
          </div>
          <nav aria-label="Sections de la fiche complète" className="mt-4 flex flex-wrap gap-x-5 gap-y-1 border-t border-line pt-3 text-sm">
            {[
              ['Profil', `${base}?tab=profile`],
              ...(certs !== undefined ? [[`Certificats (${total})`, `${base}?tab=certificates`]] : []),
              [`Embarquements (${m.currentAssignments.length + m.assignmentHistory.length})`, `${base}?tab=sea`],
              [`Documents (${m.documentsCount})`, `${base}?tab=documents`],
            ].map(([label, href]) => (
              <Link key={href} href={href} className="font-medium text-action hover:underline">
                {label}
              </Link>
            ))}
          </nav>
        </div>

        {certs !== undefined ? (
          <DonutCard
            title="Conformité des certificats"
            href={`${base}?tab=certificates`}
            linkLabel={`Voir les certificats de ${name}`}
            centerValue={total ? `${Math.round((ok / total) * 100)} %` : '—'}
            centerLabel="en validité"
            segments={[
              { key: 'valid', label: 'Valides', value: count('VALID'), color: STATE.ok },
              { key: 'unlimited', label: 'Validité illimitée', value: count('UNLIMITED'), color: STATE.info },
              { key: 'soon', label: `Expirent sous ${soonDays} j`, value: count('EXPIRING_SOON'), color: STATE.warn },
              { key: 'expired', label: 'Expirés', value: count('EXPIRED'), color: STATE.danger },
              { key: 'unknown', label: 'Inconnue ou non approuvée', value: count('EXPIRY_UNKNOWN') + count('NOT_APPROVED'), color: STATE.none },
            ]}
            emptyLabel="Aucun certificat enregistré pour ce marin."
            footnote={
              total > 0 && (
                <>
                  {ok} sur {total} en validité
                  {certs.some((c) => c.documentMissing) && ` · ${certs.filter((c) => c.documentMissing).length} justificatif(s) manquant(s)`}
                </>
              )
            }
          />
        ) : (
          <DashboardCard title="Conformité des certificats">
            <p className="border-t border-line py-6 text-center text-sm text-ink-muted">La consultation des certificats Members n’est pas ouverte à votre profil.</p>
          </DashboardCard>
        )}

        <DashboardCard title="Pièces d’identité maritimes" href={`${base}?tab=documents`} linkLabel={`Voir les documents de ${name}`}>
          <ul className="divide-y divide-line border-t border-line">
            {[
              { ...passport, number: m.passportNumber, icon: BookUser },
              { ...seamanBook, number: m.seamanBookNumber, icon: BookUser },
            ].map((d) => (
              <li key={d.label} className="flex items-center gap-3 py-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-navy-50 text-navy-600" aria-hidden>
                  <d.icon className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-ink">{d.label}</span>
                  <span className="block truncate text-xs text-ink-muted">
                    {d.number ? <span className="ref">{d.number}</span> : 'Numéro non renseigné'}
                    {d.expiry && ` · exp. ${fmtDate(d.expiry)}`}
                  </span>
                </span>
                <DocStateBadge state={d.state} />
              </li>
            ))}
            <li className="flex items-center gap-3 py-2.5">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-navy-50 text-navy-600" aria-hidden>
                <FileText className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1 text-sm">
                <span className="block font-medium text-ink">Documents déposés</span>
                <span className="block text-xs text-ink-muted">Pièces jointes à la fiche (hors certificats)</span>
              </span>
              <span className="tabular text-[15px] font-semibold text-navy">{m.documentsCount}</span>
            </li>
          </ul>
        </DashboardCard>
      </div>

      <div className={side ? 'grid gap-4' : 'grid gap-5 lg:grid-cols-2 min-[1600px]:grid-cols-3'}>
        <DashboardCard title="Prochaines échéances" meta="Certificats datés, passeport et seaman book" href={`${base}?tab=certificates`} linkLabel={`Toutes les échéances de ${name}`}>
          {deadlines.length === 0 ? (
            <p className="border-t border-line py-6 text-center text-sm text-ink-muted">Aucune échéance datée sur cette fiche.</p>
          ) : (
            <div className="relative -mx-4 overflow-x-auto">
              <table className="table-amc min-w-[380px]">
                <caption className="sr-only">Prochaines échéances de {name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">Échéance</th>
                    <th scope="col">Délai</th>
                  </tr>
                </thead>
                <tbody>
                  {deadlines.slice(0, 5).map((d) => (
                    <tr key={d.key}>
                      <td className="max-w-[200px]">
                        {d.href ? (
                          <Link href={d.href} className="block truncate text-sm font-medium text-navy hover:text-action hover:underline" title={d.label}>
                            {d.label}
                          </Link>
                        ) : (
                          <span className="block truncate text-sm font-medium text-navy">{d.label}</span>
                        )}
                        <span className="ref block text-xs text-ink-muted">{d.code}</span>
                      </td>
                      <td className="tabular whitespace-nowrap text-sm">{fmtDate(d.date)}</td>
                      <td>
                        <DelayBadge days={d.days} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DashboardCard>

        <DashboardCard
          title="Affectations récentes"
          meta={m.assignmentScope === 'FULL' ? 'Carrière complète' : 'Limitées aux navires de votre périmètre'}
          href={`${base}?tab=sea`}
          linkLabel={`Toutes les affectations de ${name}`}
        >
          {assignments.length === 0 ? (
            <p className="border-t border-line py-6 text-center text-sm text-ink-muted">Aucune affectation enregistrée.</p>
          ) : (
            <div className="relative -mx-4 overflow-x-auto">
              <table className="table-amc min-w-[420px]">
                <caption className="sr-only">Dernières affectations de {name}</caption>
                <thead>
                  <tr>
                    <th scope="col">Navire</th>
                    <th scope="col">Embarquement</th>
                    <th scope="col">Débarquement</th>
                    <th scope="col" className="text-right">
                      Durée
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => {
                    const from = a.actualJoinDate ?? a.plannedJoinDate;
                    const to = a.actualSignOffDate ?? a.plannedSignOffDate;
                    const days = servedDays(a);
                    return (
                      <tr key={a.id}>
                        <td className="max-w-[170px]">
                          <span className="block truncate text-sm font-medium text-navy">{a.vessel.name}</span>
                          <span className="flex items-center gap-1.5 text-xs text-ink-muted">
                            <span className="truncate">{a.rank}</span>
                            {(a.status === 'ONBOARD' || a.status === 'PLANNED') && <AssignmentStatusBadge status={a.status} />}
                          </span>
                        </td>
                        <td className="tabular whitespace-nowrap text-sm">
                          {fmtDate(from)}
                          {!a.actualJoinDate && from && <span className="block text-xs text-ink-muted">prévu</span>}
                        </td>
                        <td className="tabular whitespace-nowrap text-sm">
                          {to ? fmtDate(to) : <span className="text-ink-soft">—</span>}
                          {!a.actualSignOffDate && to && <span className="block text-xs text-ink-muted">prévu</span>}
                        </td>
                        <td className="tabular whitespace-nowrap text-right text-sm">
                          {days !== null ? (
                            duration(days)
                          ) : missingSignOff(a) ? (
                            <span className="text-xs text-ink-soft">débarquement manquant</span>
                          ) : (
                            <span className="text-ink-soft">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </DashboardCard>

        <DashboardCard title="Points d’attention" meta="Déduits des certificats, pièces et affectations de la fiche" className={side ? undefined : 'lg:col-span-2 min-[1600px]:col-span-1'}>
          <AlertList alerts={alerts} />
        </DashboardCard>
      </div>
    </section>
  );
}
