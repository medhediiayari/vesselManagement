'use client';

import { ChevronRight, Lock, ServerCog, ShieldAlert, UsersRound, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { cn, fmtBytes, fmtDateTime } from '@/lib/format';
import { Register, RegisterRow } from '@/components/amc/register';
import { Panel } from '@/components/ui/page';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { boundedCount, JOB_LABELS, type AdminOverview } from './admin-overview';

type State = 'ok' | 'attention' | 'down';
const STATE: Record<State, { label: string; cls: string; dot: string }> = {
  ok: { label: 'Opérationnel', cls: 'border-ok-line bg-ok-bg text-ok', dot: 'bg-ok' },
  attention: { label: 'À surveiller', cls: 'border-warn-line bg-warn-bg text-warn', dot: 'bg-warn' },
  down: { label: 'Action requise', cls: 'border-danger-line bg-danger-bg text-danger', dot: 'bg-danger' },
};

/** État d'un volet : point + libellé (jamais la couleur seule). */
export function StateTag({ state, label }: { state: State; label?: string }) {
  const s = STATE[state];
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded border px-1.5 py-px text-2xs font-semibold', s.cls)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', s.dot)} aria-hidden />
      {label ?? s.label}
    </span>
  );
}

function Section({ icon: Icon, title, state, stateLabel, link, children }: { icon: LucideIcon; title: string; state?: State | null; stateLabel?: string; link: { href: string; label: string }; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col px-4 py-4 md:px-5" aria-label={title}>
      <div className="mb-3 flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded bg-navy text-white" aria-hidden>
          <Icon className="h-4 w-4" />
        </span>
        <h3 className="min-w-0 flex-1 text-sm font-semibold text-navy">{title}</h3>
        {state && <StateTag state={state} label={stateLabel} />}
      </div>
      <div className="flex-1">{children}</div>
      <Link href={link.href} className="mt-3 inline-flex items-center gap-1 self-start text-sm font-medium text-action hover:underline">
        {link.label} <ChevronRight className="h-4 w-4" aria-hidden />
      </Link>
    </section>
  );
}

function Loading() {
  return (
    <div className="space-y-2" role="status">
      <span className="sr-only">Chargement…</span>
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-full" />
      <Skeleton className="h-6 w-3/4" />
    </div>
  );
}

const SECURITY_LABELS: Record<string, string> = {
  'auth.login_failed': 'Échec de connexion',
  'auth.password_change_failed': 'Échec de changement de mot de passe',
};

/** Date locale AAAA-MM-JJ attendue par le filtre « Du » du journal d'audit. */
function isoDay(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Console d'administration du tableau de bord : comptes, signaux de sécurité 24 h, état de la plateforme.
 * Chaque volet n'apparaît qu'avec la permission correspondante ; les actions (déverrouillage, relance de tâche)
 * restent dans les écrans dédiés, qui appliquent leurs propres contrôles et confirmations.
 */
export function AdminConsole({ admin }: { admin: AdminOverview }) {
  const { permissions: p, users, security, system } = admin;
  const sections = [p.canUsers, p.canAuthAudit, p.canSystem].filter(Boolean).length;
  const day = isoDay(admin.since);

  const recentSecurity = [...(security.loginFailures?.items ?? []), ...(security.denied?.items ?? [])]
    .filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i)
    .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
    .slice(0, 5);
  const securityCount =
    (security.loginFailures?.items.length ?? 0) + (security.denied?.items.length ?? 0);

  const filesTotal = system.data?.filesByKind.reduce((s, f) => s + f.count, 0) ?? 0;
  const bytesTotal = system.data?.filesByKind.reduce((s, f) => s + f.bytes, 0) ?? 0;
  const jobsOk = system.data ? system.data.scheduledJobs.filter((j) => j.lastRun && !/FAIL|ERROR/.test(j.lastRun.status)).length : 0;

  return (
    <Panel title="Administration de la plateforme" bodyClassName="p-0">
      <div className={cn('grid divide-y divide-line md:divide-x md:divide-y-0', sections === 3 ? 'md:grid-cols-3' : sections === 2 ? 'md:grid-cols-2' : '')}>
        {p.canUsers && (
          <Section
            icon={UsersRound}
            title="Comptes utilisateurs"
            state={users.locked === undefined ? null : users.locked > 0 ? 'attention' : 'ok'}
            stateLabel={users.locked ? `${users.locked} verrouillé${users.locked > 1 ? 's' : ''}` : 'Aucun verrou'}
            link={{ href: '/admin/users', label: 'Gérer les utilisateurs' }}
          >
            {users.loading ? (
              <Loading />
            ) : users.error ? (
              <ErrorState error={users.error} />
            ) : (
              <>
                <Register>
                  <RegisterRow label="Comptes actifs" value={users.active} href="/admin/users?status=ACTIVE" />
                  <RegisterRow label="Comptes verrouillés" hint={users.maxFailedLogins ? `Après ${users.maxFailedLogins} échecs de connexion` : 'Après plusieurs échecs de connexion'} value={users.locked} tone="danger" href="/admin/users?status=LOCKED" />
                  <RegisterRow label="Comptes désactivés" value={users.deactivated} href="/admin/users?status=DEACTIVATED" />
                </Register>
                {users.lockedList.length > 0 && (
                  <ul className="mt-3 space-y-1.5">
                    {users.lockedList.map((u) => (
                      <li key={u.id}>
                        <Link href={`/admin/users/${u.id}`} className="group flex items-center gap-2 text-sm">
                          <Lock className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden />
                          <span className="min-w-0 flex-1 truncate font-medium text-navy group-hover:text-action group-hover:underline">{u.displayName}</span>
                          <span className="shrink-0 text-xs tabular text-ink-muted">{fmtDateTime(u.lockedAt)}</span>
                        </Link>
                      </li>
                    ))}
                    <li className="pt-1 text-xs text-ink-muted">Déverrouillage depuis la fiche, avec mot de passe temporaire.</li>
                  </ul>
                )}
              </>
            )}
          </Section>
        )}

        {p.canAuthAudit && (
          <Section
            icon={ShieldAlert}
            title="Sécurité · 24 dernières heures"
            state={security.loading || security.error ? null : securityCount > 0 ? 'attention' : 'ok'}
            stateLabel={securityCount > 0 ? 'À surveiller' : 'Aucun incident'}
            link={{ href: `/admin/audit?result=DENIED&from=${day}`, label: 'Journal d’audit' }}
          >
            {security.loading ? (
              <Loading />
            ) : security.error ? (
              <ErrorState error={security.error} />
            ) : (
              <>
                <Register>
                  <RegisterRow
                    label="Échecs de connexion"
                    value={boundedCount(security.loginFailures)}
                    tone="warn"
                    href={`/admin/audit?module=auth&action=auth.login_failed&from=${day}`}
                  />
                  <RegisterRow label="Accès refusés" hint="Requêtes rejetées par les contrôles de droits" value={boundedCount(security.denied)} tone="warn" href={`/admin/audit?result=DENIED&from=${day}`} />
                </Register>
                {recentSecurity.length === 0 ? (
                  <p className="mt-3 text-sm text-ok">Aucun événement de sécurité sur la période.</p>
                ) : (
                  <ol className="mt-3 space-y-2" aria-label="Derniers événements de sécurité">
                    {recentSecurity.map((e) => (
                      <li key={e.id} className="flex gap-2.5 text-sm">
                        <span className="w-11 shrink-0 pt-px text-xs tabular text-ink-muted">
                          {new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' }).format(new Date(e.occurredAt))}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-navy">
                            {SECURITY_LABELS[e.action] ?? (e.result === 'DENIED' ? 'Accès refusé' : e.action)}
                          </span>
                          <span className="block truncate text-xs text-ink-muted">
                            {e.actorLabel ?? 'Acteur inconnu'} · <span className="ref">{e.action}</span>
                          </span>
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
          </Section>
        )}

        {p.canSystem && (
          <Section icon={ServerCog} title="État du système" state={system.state} link={{ href: '/admin/system', label: 'Détail d’exploitation' }}>
            {system.loading ? (
              <Loading />
            ) : system.error || !system.data ? (
              <ErrorState error={system.error} />
            ) : (
              <ul className="divide-y divide-line border-y border-line text-sm">
                {Object.entries(system.data.checks).map(([k, v]) => (
                  <li key={k} className="flex items-center justify-between gap-3 py-2">
                    <span>{k === 'database' ? 'Base PostgreSQL' : k === 'objectStorage' ? 'Stockage MinIO' : k}</span>
                    <StateTag state={v === 'up' ? 'ok' : 'down'} label={v === 'up' ? 'Disponible' : 'Indisponible'} />
                  </li>
                ))}
                <li className="flex items-center justify-between gap-3 py-2">
                  <span>Antivirus des dépôts</span>
                  {system.antivirusOff ? <StateTag state="attention" label="Désactivé" /> : <StateTag state="ok" label="ClamAV actif" />}
                </li>
                <li className="flex items-center justify-between gap-3 py-2">
                  <span>Tâches planifiées</span>
                  {system.failedJobs.length ? (
                    <StateTag state="down" label={`${system.failedJobs.length} en échec`} />
                  ) : (
                    <span className="tabular text-ink-muted">
                      {jobsOk} / {system.data.scheduledJobs.length} exécutées
                    </span>
                  )}
                </li>
                <li className="flex items-center justify-between gap-3 py-2">
                  <span>E-mails en échec</span>
                  <span className={cn('tabular font-semibold', system.failedEmails ? 'text-warn' : 'text-ink-soft')}>{system.failedEmails}</span>
                </li>
                <li className="flex items-center justify-between gap-3 py-2">
                  <span>Fichiers stockés</span>
                  <span className="tabular text-ink-muted">
                    {filesTotal} · {fmtBytes(bytesTotal)}
                    {system.infectedFiles > 0 && <span className="ml-2 font-semibold text-danger">{system.infectedFiles} en quarantaine</span>}
                  </span>
                </li>
                {system.failedJobs.map((j) => (
                  <li key={j.name} className="py-2 text-xs text-danger">
                    Échec : {JOB_LABELS[j.name] ?? j.name} — {fmtDateTime(j.lastRun?.started_at)}
                  </li>
                ))}
              </ul>
            )}
          </Section>
        )}
      </div>
    </Panel>
  );
}
