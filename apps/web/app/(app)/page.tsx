'use client';

import { useQueries, useQuery } from '@tanstack/react-query';
import { FileCheck2, Navigation, ShieldCheck, Ship, ShoppingCart, UsersRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { ActionQueue, buildActions, buildAdminActions, isReadOnlyProfile, sortActions } from '@/components/dashboard/action-queue';
import { ExpiringCertificates, OngoingVoyages, RecentCsoDocuments, RecentPurchaseRequests } from '@/components/dashboard/activity-tables';
import { AdminConsole } from '@/components/dashboard/admin-console';
import { useAdminOverview } from '@/components/dashboard/admin-overview';
import { DashboardCard } from '@/components/dashboard/dashboard-card';
import { DonutCard, STAGE, STATE } from '@/components/dashboard/donut-card';
import { FleetHero, type HeroKpi } from '@/components/dashboard/fleet-hero';
import { FleetOverview } from '@/components/dashboard/fleet-overview';
import type { DashboardData, VesselWorkspace } from '@/components/dashboard/types';
import { homeHref } from '@/components/shell/nav';
import { ErrorState, LoadingBlock, Skeleton } from '@/components/ui/states';

/** Synthèses navire chargées (au-delà, l'indicateur « marins à bord » n'est pas affiché plutôt qu'estimé). */
const FLEET_BOARD_MAX = 20;
const FLEET_ROWS = 6;

/** Circuit PR non clôturé, regroupé en étapes ordonnées (couleurs du clair au foncé). */
const PR_STAGES = [
  { key: 'draft', label: 'Brouillons', statuses: ['DRAFT'] },
  { key: 'review', label: 'En revue', statuses: ['SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'ON_HOLD'] },
  { key: 'approved', label: 'Approuvées / consultation', statuses: ['APPROVED', 'SOURCING'] },
  { key: 'ordering', label: 'Commande / réception', statuses: ['PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED'] },
];

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Heure locale du navigateur, signalée comme telle (l'horloge de l'en-tête affiche UTC et l'heure bord, UI-04)
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });

/** Grille des répartitions : nombre de colonnes selon les blocs autorisés. */
function donutGrid(n: number) {
  if (n >= 4) return 'sm:grid-cols-2 min-[1400px]:grid-cols-4';
  if (n === 3) return 'sm:grid-cols-2 xl:grid-cols-3';
  if (n === 2) return 'sm:grid-cols-2';
  // Bloc unique : demi-largeur sur grand écran (un anneau étiré sur toute la largeur n'apporte rien)
  return 'xl:grid-cols-2';
}

export default function DashboardPage() {
  const { can, canAny, selectedVesselIds, currentVessel, me } = useSession();
  const router = useRouter();
  // Sans tableau de bord (ex. Crewing) : première page autorisée plutôt qu'« Accès non autorisé » (ADM-09)
  const home = can('dashboard.view') ? '/' : homeHref(canAny);
  useEffect(() => {
    if (home !== '/') router.replace(home);
  }, [home, router]);
  const q = useQuery({
    queryKey: ['dashboard', selectedVesselIds],
    queryFn: () => api.get<DashboardData>('/dashboard', { query: { vesselIds: selectedVesselIds.join(',') || undefined } }),
    enabled: can('dashboard.view'),
    refetchInterval: 120_000,
  });

  const boardVessels = (selectedVesselIds.length ? me.accessibleVessels.filter((v) => selectedVesselIds.includes(v.id)) : me.accessibleVessels)
    .slice()
    .sort((x, y) => Number(y.status === 'ACTIVE') - Number(x.status === 'ACTIVE') || x.name.localeCompare(y.name, 'fr'));
  const boardEnabled = can('dashboard.view') && can('vessels.view');
  // Synthèses par navire (partagées avec la fiche navire via la même clé de cache)
  const workspaces = useQueries({
    queries: boardVessels.slice(0, FLEET_BOARD_MAX).map((v) => ({
      queryKey: ['vessel-workspace', v.id],
      queryFn: () => api.get<VesselWorkspace>(`/vessels/${v.id}/workspace`),
      enabled: boardEnabled,
      staleTime: 60_000,
    })),
  });
  const admin = useAdminOverview();

  if (!can('dashboard.view')) return <LoadingBlock rows={4} label="Redirection vers votre page d’accueil…" />;

  const d = q.data;
  const scopeLabel = currentVessel ? currentVessel.name : selectedVesselIds.length ? `${selectedVesselIds.length} navires sélectionnés` : me.vesselScope === 'ALL_FLEET' ? 'toute la flotte' : 'vos navires';
  // Navire seul : certificats du navire ET de son équipage affecté, comme les compteurs ci-dessous (ADM-06)
  const vq = selectedVesselIds.length === 1 ? `vesselIds=${selectedVesselIds[0]}` : '';
  const withVessel = (path: string) => (vq ? `${path}${path.includes('?') ? '&' : '?'}${vq}` : path);

  const actions = d ? sortActions([...buildActions(d, vq ? `&${vq}` : ''), ...buildAdminActions(admin)]) : [];
  const openActions = actions.filter((a) => a.count > 0).length;
  const critical = actions.filter((a) => a.priority === 'critical').reduce((s, a) => s + a.count, 0);
  // Profil en lecture seule (Direction) : signaler sans inviter à agir (UI-06)
  const readOnly = isReadOnlyProfile(me.permissions);

  // Agrégats affichés : uniquement des valeurs réellement chargées (aucune estimation)
  const crews = workspaces.map((w) => w.data?.sections.crew).filter((c): c is { onboard: number; planned: number } => !!c);
  const crewComplete = boardEnabled && boardVessels.length <= FLEET_BOARD_MAX && crews.length > 0 && crews.length === boardVessels.length;
  const cv = d?.certificates?.validity;
  const prByStatus = d?.purchasing?.purchaseRequestsByStatus ?? {};
  const prStages = PR_STAGES.map((s, i) => ({ ...s, value: s.statuses.reduce((n, k) => n + (prByStatus[k] ?? 0), 0), color: STAGE[i] }));
  const prActive = prStages.reduce((n, s) => n + s.value, 0);
  const prDone = (prByStatus.RECEIVED ?? 0) + (prByStatus.CLOSED ?? 0);
  const prDropped = (prByStatus.CANCELLED ?? 0) + (prByStatus.REJECTED ?? 0);
  const showPr = !!d?.purchasing && can('pr.view');
  const cso = d?.cso;

  const kpis: HeroKpi[] = [];
  if (d) {
    kpis.push({
      key: 'vessels',
      icon: Ship,
      value: boardVessels.length,
      label: boardVessels.length > 1 ? 'Navires' : 'Navire',
      sub: `${boardVessels.filter((v) => v.status === 'ACTIVE').length} en service`,
      href: can('vessels.view') ? '/vessels' : undefined,
    });
    if (crewComplete) {
      const planned = crews.reduce((s, c) => s + c.planned, 0);
      kpis.push({
        key: 'crew',
        icon: UsersRound,
        value: crews.reduce((s, c) => s + c.onboard, 0),
        label: 'Marins à bord',
        sub: planned ? `+${plural(planned, 'embarquement prévu', 'embarquements prévus')}` : 'Aucun embarquement prévu',
        href: can('members.view') ? '/members/crew' : undefined,
      });
    }
    if (cv) {
      // Même total que le centre de l'anneau « État des certificats »
      kpis.push({
        key: 'certificates',
        icon: FileCheck2,
        value: cv.valid + cv.expiringSoon + cv.unlimited + cv.expired + cv.expiryUnknown,
        label: 'Certificats suivis',
        sub: cv.expired ? plural(cv.expired, 'certificat expiré', 'certificats expirés') : 'Aucun certificat expiré',
        tone: cv.expired ? 'danger' : undefined,
        href: withVessel('/certificates'),
      });
    }
    if (showPr) {
      const toReview = d.approvals.purchaseRequests;
      const overdue = d.purchasing!.overduePurchaseRequests;
      kpis.push({
        key: 'pr',
        icon: ShoppingCart,
        value: prActive,
        label: 'PR en cours',
        // « À revoir » seulement pour qui peut approuver (approvals.purchaseRequests absent sinon)
        sub: toReview
          ? `${toReview} à revoir`
          : overdue
            ? `${overdue} besoin${overdue > 1 ? 's' : ''} dépassé${overdue > 1 ? 's' : ''}`
            : toReview === 0
              ? 'Aucune PR à revoir'
              : 'Aucun besoin dépassé',
        tone: toReview ? 'warn' : overdue ? 'danger' : undefined,
        href: '/purchasing/requests',
      });
    }
    if (d.voyages) {
      const late = d.voyages.noonReportsMissing;
      kpis.push({
        key: 'voyages',
        icon: Navigation,
        value: d.voyages.active.length,
        label: 'Voyages en cours',
        sub: late ? `${plural(late, 'Noon Report', 'Noon Reports')} en retard` : plural(d.voyages.planned, 'voyage planifié', 'voyages planifiés'),
        tone: late ? 'warn' : undefined,
        href: '/voyages',
      });
    }
    if (cso) {
      kpis.push({
        key: 'cso',
        icon: ShieldCheck,
        value: cso.published + cso.pendingApproval + cso.draft,
        label: 'Documents CSO',
        sub: cso.pendingApproval ? `${cso.pendingApproval} à approuver` : 'Aucune approbation en attente',
        tone: cso.pendingApproval ? 'warn' : undefined,
        href: '/cso',
      });
    }
  }

  const donutCount = [cv, showPr, d?.voyages, cso].filter(Boolean).length;
  const recentCount = [showPr, d?.certificates, cso].filter(Boolean).length;
  // Le tableau de flotte n'a de contenu qu'avec les synthèses voyages ou certificats
  const showFleet = can('vessels.view') && boardVessels.length > 0 && (can('voyages.view') || can('certificates.view'));
  const generatedAt = d ? new Date(d.generatedAt) : null;

  return (
    <div className="space-y-5">
      <FleetHero
        greeting={`Bonjour, ${me.displayName}`}
        loading={q.isLoading}
        context={
          <>
            Situation de <span className="font-semibold text-white">{scopeLabel}</span>
            {d &&
              (openActions === 0 ? (
                <> · {readOnly ? 'aucun point de vigilance.' : 'aucune action en attente.'}</>
              ) : (
                <>
                  {' · '}
                  <a href="#actions-requises" className="underline decoration-white/40 underline-offset-2 hover:decoration-white">
                    {readOnly ? plural(openActions, 'point de vigilance', 'points de vigilance') : plural(openActions, 'rubrique à traiter', 'rubriques à traiter')}
                  </a>
                  {critical > 0 && <span className="font-semibold text-[#FFA197]"> dont {plural(critical, 'alerte critique', 'alertes critiques')}</span>}.
                </>
              ))}
          </>
        }
        meta={
          generatedAt && (
            <>
              {capitalize(dayFmt.format(generatedAt))} · <span className="tabular">données de {timeFmt.format(generatedAt)} (heure locale)</span>, actualisées toutes les 2 min
              {me.roles.length > 0 && <> · vue {me.roles.map((r) => r.name).join(', ')}</>}
            </>
          )
        }
        kpis={kpis}
      />

      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}

      {q.isLoading && (
        <div className="grid gap-5 sm:grid-cols-2 min-[1400px]:grid-cols-4" role="status">
          <span className="sr-only">Chargement du tableau de bord…</span>
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="panel space-y-3 p-4">
              <Skeleton className="h-5 w-40" />
              <div className="flex items-center gap-5">
                <Skeleton className="h-[124px] w-[124px] rounded-full" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-3/4" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {d && (
        <>
          {donutCount > 0 && (
            <div className={cn('grid gap-5', donutGrid(donutCount))}>
              {cv && (
                <DonutCard
                  title="État des certificats"
                  href={withVessel('/certificates')}
                  linkLabel="Voir tous les certificats"
                  centerLabel="certificats suivis"
                  segments={[
                    { key: 'valid', label: 'Valides', value: cv.valid, color: STATE.ok, href: withVessel('/certificates?validity=VALID') },
                    { key: 'unlimited', label: 'Validité illimitée', value: cv.unlimited, color: STATE.info, href: withVessel('/certificates?validity=UNLIMITED') },
                    { key: 'soon', label: `Expirent sous ${d.certificates!.expiringSoonDays} j`, value: cv.expiringSoon, color: STATE.warn, href: withVessel('/certificates?validity=EXPIRING_SOON') },
                    { key: 'expired', label: 'Expirés', value: cv.expired, color: STATE.danger, href: withVessel('/certificates?validity=EXPIRED') },
                    { key: 'unknown', label: 'Échéance inconnue', value: cv.expiryUnknown, color: STATE.none, href: withVessel('/certificates?validity=EXPIRY_UNKNOWN') },
                  ]}
                  emptyLabel="Aucun certificat courant dans votre périmètre."
                  footnote={
                    <>
                      {plural(d.certificates!.documentMissing, 'justificatif manquant', 'justificatifs manquants')} ·{' '}
                      {plural(d.certificates!.pendingApprovals, 'demande en validation', 'demandes en validation')}
                    </>
                  }
                />
              )}
              {showPr && (
                <DonutCard
                  title="Purchase Requests"
                  href="/purchasing/requests"
                  linkLabel="Voir toutes les Purchase Requests"
                  centerLabel="PR en cours"
                  segments={prStages.map((s) => ({ key: s.key, label: s.label, value: s.value, color: s.color, href: `/purchasing/requests?status=${s.statuses.join(',')}` }))}
                  emptyLabel="Aucune PR en cours dans votre périmètre."
                  footnote={
                    <>
                      {plural(prDone, 'reçue ou clôturée', 'reçues ou clôturées')} · {plural(prDropped, 'annulée ou rejetée', 'annulées ou rejetées')}
                    </>
                  }
                />
              )}
              {d.voyages && (
                <DonutCard
                  title="Voyages"
                  href="/voyages"
                  linkLabel="Voir tous les voyages"
                  centerLabel="voyages"
                  segments={[
                    { key: 'planned', label: 'Planifiés', value: d.voyages.planned, color: STAGE[0], href: '/voyages?status=PLANNED' },
                    { key: 'active', label: 'En cours', value: d.voyages.active.length, color: STAGE[2], href: '/voyages?status=ACTIVE' },
                    { key: 'completed', label: 'Terminés (90 j)', value: d.voyages.completedLast90Days, color: STAGE[3], href: '/voyages?status=COMPLETED' },
                  ]}
                  emptyLabel="Aucun voyage planifié, en cours ou terminé récemment."
                  footnote={
                    d.voyages.noonReportsMissing > 0 ? (
                      <span className="font-medium text-warn">{plural(d.voyages.noonReportsMissing, 'voyage', 'voyages')} sans Noon Report depuis plus de 30 h</span>
                    ) : (
                      'Noon Reports à jour sur les voyages en cours'
                    )
                  }
                />
              )}
              {cso && (
                <DonutCard
                  title="Documents CSO"
                  href="/cso"
                  linkLabel="Ouvrir la bibliothèque CSO"
                  centerLabel="documents"
                  segments={[
                    { key: 'published', label: 'Publiés', value: cso.published, color: STATE.ok, href: '/cso/search?status=PUBLISHED' },
                    { key: 'pending', label: 'En attente d’approbation', value: cso.pendingApproval, color: STATE.warn, href: '/cso?pending=true' },
                    { key: 'draft', label: 'Brouillons', value: cso.draft, color: STATE.none, href: '/cso/search?status=DRAFT' },
                  ]}
                  emptyLabel="Aucun document CSO accessible dans votre périmètre."
                  footnote={
                    <>
                      {plural(cso.reviewDue, 'révision due', 'révisions dues')} sous 30 j · {plural(cso.expired, 'document expiré', 'documents expirés')}
                      {cso.truncated && ' · comptage partiel'}
                    </>
                  }
                />
              )}
            </div>
          )}

          <div id="actions-requises" className="scroll-mt-20">
            <DashboardCard
              title={
                <>
                  {readOnly ? 'Points de vigilance' : 'Actions requises'}
                  {openActions > 0 && <span className="tabular ml-2 rounded bg-navy px-1.5 py-px align-middle text-xs font-semibold text-white">{openActions}</span>}
                </>
              }
              meta={readOnly ? 'Classés par priorité, dans votre périmètre — consultation seule' : 'Classées par priorité, dans votre périmètre et selon vos droits'}
              bodyClassName="px-0 pb-0"
            >
              <ActionQueue items={actions} readOnly={readOnly} />
              {!readOnly && (
                <p className="px-4 py-2 text-xs text-ink-muted">Vos propres soumissions sont exclues des validations : un demandeur ne valide jamais sa propre demande.</p>
              )}
            </DashboardCard>
          </div>

          {(showFleet || d.voyages) && (
            // Côte à côte seulement quand le tableau de flotte tient sans défilement
            <div className={cn('grid gap-5', showFleet && d.voyages && 'min-[1700px]:grid-cols-[minmax(0,7fr)_minmax(0,6fr)]')}>
              {showFleet && (
                <DashboardCard
                  title="Aperçu de la flotte"
                  meta={
                    boardVessels.length > FLEET_ROWS
                      ? `${FLEET_ROWS} navires affichés sur ${boardVessels.length} — navires en service en premier`
                      : 'Situation, dernière position déclarée et certificats'
                  }
                  href="/vessels"
                  linkLabel="Voir tous les navires"
                >
                  <FleetOverview vessels={boardVessels.slice(0, FLEET_ROWS)} results={workspaces.slice(0, FLEET_ROWS)} activeVoyages={d.voyages?.active ?? []} />
                </DashboardCard>
              )}
              {d.voyages && (
                <DashboardCard
                  title="Voyages en cours"
                  meta="Itinéraire déclaré et situation à l’escale"
                  href="/voyages?status=ACTIVE"
                  linkLabel="Voir tous les voyages en cours"
                >
                  <OngoingVoyages voyages={d.voyages.active} />
                </DashboardCard>
              )}
            </div>
          )}

          {recentCount > 0 && (
            <div className={cn('grid gap-5', recentCount > 1 && 'min-[1440px]:grid-cols-2', recentCount > 2 && 'min-[1800px]:grid-cols-3')}>
              {showPr && (
                <DashboardCard title="Purchase Requests récentes" meta="Dernières créées dans votre périmètre" href="/purchasing/requests" linkLabel="Voir toutes les Purchase Requests">
                  <RecentPurchaseRequests items={d.purchasing!.recentPurchaseRequests} />
                </DashboardCard>
              )}
              {d.certificates && (
                <DashboardCard
                  title="Échéances de certificats"
                  meta="Expirés depuis moins de 30 j et à échéance sous 30 j"
                  href={withVessel('/certificates?expiringWithinDays=30')}
                  linkLabel="Voir les certificats à échéance sous 30 jours"
                >
                  <ExpiringCertificates items={d.certificates.horizon} />
                </DashboardCard>
              )}
              {cso && (
                <DashboardCard
                  title="Documents CSO récents"
                  meta="Derniers modifiés parmi les documents qui vous sont accessibles"
                  href="/cso"
                  linkLabel="Ouvrir la bibliothèque CSO"
                  // Troisième bloc sur deux colonnes : pleine largeur plutôt qu'une demi-carte orpheline
                  className={cn(showPr && d.certificates && 'min-[1440px]:col-span-2 min-[1800px]:col-span-1')}
                >
                  <RecentCsoDocuments items={cso.recent} />
                </DashboardCard>
              )}
            </div>
          )}

          {admin.permissions.any && <AdminConsole admin={admin} />}

          <p className="text-xs text-ink-muted">
            Données au {fmtDate(d.generatedAt)} — indicateurs de suivi interne, sans valeur d’attestation réglementaire.
          </p>
        </>
      )}
    </div>
  );
}
