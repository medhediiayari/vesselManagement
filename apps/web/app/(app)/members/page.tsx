'use client';

import { CREW_CATEGORIES, CREW_CATEGORY_KEYS, MEMBER_STATUS_LABELS } from '@amc/types';
import * as DM from '@radix-ui/react-dropdown-menu';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Grid3x3, ListChecks, MoreHorizontal, Rows3, RotateCcw, Search, Ship } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { CertificateMatrix } from '@/components/members/certificate-matrix';
import { MemberCreateDialog } from '@/components/members/member-create-dialog';
import { MemberKpis } from '@/components/members/member-kpis';
import { CertificateRatio, countryName, documentState } from '@/components/members/member-overview-lib';
import { MemberSummary } from '@/components/members/member-summary';
import { MembersHeader } from '@/components/members/members-header';
import { DepartmentLabel, MemberAvatar, MemberStatusBadge } from '@/components/members/member-ui';
import { CREW_DEPARTMENT_LABELS, memberName, type MemberListItem, type MemberMatrixMeta, type MemberStats } from '@/components/members/types';
import { useDebounced } from '@/components/members/use-debounced';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { FilterBar } from '@/components/ui/page';
import { Forbidden, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { cn, daysUntil, fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';

/** Synthèse sous la liste à partir de cette largeur ; en dessous, un clic ouvre la fiche complète. */
const WIDE = '(min-width: 1280px)';

function CurrentVessel({ m }: { m: MemberListItem }) {
  const onboard = m.currentAssignments.find((a) => a.status === 'ONBOARD');
  const planned = m.currentAssignments.find((a) => a.status === 'PLANNED');
  const a = onboard ?? planned;
  if (!a) return <span className="text-ink-soft">—</span>;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <span className="hidden h-7 w-9 shrink-0 items-center justify-center rounded border border-line bg-navy-50 text-navy-600 2xl:flex" aria-hidden>
        <Ship className="h-3.5 w-3.5" />
      </span>
      <span className="min-w-0">
        <Link href={`/vessels/${a.vessel.id}`} className="block truncate font-medium text-action hover:underline" onClick={(e) => e.stopPropagation()}>
          {a.vessel.name}
        </Link>
        <span className="block whitespace-nowrap text-xs text-ink-muted">
          {onboard ? `Depuis le ${fmtDate(onboard.actualJoinDate)}` : `Prévu ${a.plannedJoinDate ? `le ${fmtDate(a.plannedJoinDate)}` : '(date à fixer)'}`}
        </span>
      </span>
    </span>
  );
}

/** Seaman book : numéro et expiration, qualifiée avec le seuil « expire bientôt » des certificats. */
function SeamanBook({ m, soonDays }: { m: MemberListItem; soonDays: number }) {
  if (!m.seamanBookNumber && !m.seamanBookExpiry) return <span className="text-ink-soft">—</span>;
  const state = documentState(m.seamanBookNumber, m.seamanBookExpiry, soonDays);
  return (
    <span className="whitespace-nowrap">
      <span className="ref block text-sm">{m.seamanBookNumber ?? 'N° non renseigné'}</span>
      {m.seamanBookExpiry && (
        <span className={cn('block text-xs', state === 'EXPIRED' ? 'font-medium text-danger' : state === 'EXPIRING_SOON' ? 'text-warn' : 'text-ink-muted')}>
          {state === 'EXPIRED' ? 'Expiré le ' : 'Exp. '}
          {fmtDate(m.seamanBookExpiry)}
        </span>
      )}
    </span>
  );
}

/** Fin de contrat = débarquement prévu de l'affectation à bord ; dépassement signalé en texte. */
function ContractEnd({ m }: { m: MemberListItem }) {
  const onboard = m.currentAssignments.find((a) => a.status === 'ONBOARD');
  const end = onboard?.plannedSignOffDate;
  if (!end) return <span className="text-ink-soft">{onboard ? 'Non planifiée' : '—'}</span>;
  const left = daysUntil(end)!;
  return (
    <span className="whitespace-nowrap">
      <span className={cn('tabular block text-sm', left < 0 && 'font-semibold text-danger')}>{fmtDate(end)}</span>
      <span className={cn('block text-xs', left < 0 ? 'font-medium text-danger' : 'text-ink-muted')}>
        {left < 0 ? `Dépassée de ${-left} j` : left === 0 ? 'Aujourd’hui' : left < 60 ? `Dans ${left} j` : `Dans ${Math.round(left / 30.44)} mois`}
      </span>
    </span>
  );
}

function RowActions({ m, onPreview, canCertificates }: { m: MemberListItem; onPreview: () => void; canCertificates: boolean }) {
  const item = 'flex cursor-pointer items-center rounded-md px-3 py-2 text-sm outline-none data-[highlighted]:bg-navy-50';
  return (
    <DM.Root>
      <DM.Trigger
        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-navy-50 hover:text-ink"
        aria-label={`Actions pour ${memberName(m)}`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden />
      </DM.Trigger>
      <DM.Portal>
        <DM.Content align="end" sideOffset={4} className="z-50 min-w-[210px] rounded-lg bg-white p-1 shadow-pop" onClick={(e) => e.stopPropagation()}>
          <DM.Item className={cn(item, 'hidden xl:flex')} onSelect={onPreview}>
            Afficher la synthèse
          </DM.Item>
          <DM.Item asChild>
            <Link href={`/members/${m.id}`} className={item}>
              Ouvrir la fiche
            </Link>
          </DM.Item>
          {canCertificates && (
            <DM.Item asChild>
              <Link href={`/members/${m.id}?tab=certificates`} className={item}>
                Certificats
              </Link>
            </DM.Item>
          )}
          <DM.Item asChild>
            <Link href={`/members/${m.id}?tab=sea`} className={item}>
              Embarquements
            </Link>
          </DM.Item>
        </DM.Content>
      </DM.Portal>
    </DM.Root>
  );
}

function MembersList() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const qc = useQueryClient();
  const { can, me, currentVessel, vesselById } = useSession();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [rank, setRank] = useState('');
  const [dept, setDept] = useState('');
  const [archived, setArchived] = useState(false);
  const [sort, setSort] = useState('lastName');
  const [selected, setSelected] = useState<string | null>(null);
  // Fermeture explicite de la synthèse : on ne la rouvre plus automatiquement
  const [dismissed, setDismissed] = useState(false);
  const [creating, setCreating] = useState(false);

  // Navire : ?vesselId= (lien depuis le workspace navire), sinon navire unique du Vessel Switcher ; « all » = aucun filtre
  const vesselParam = params.get('vesselId');
  const vesselId = vesselParam === 'all' ? '' : vesselParam ?? currentVessel?.id ?? '';
  const setParam = (key: string, v: string | null) => {
    const sp = new URLSearchParams(params.toString());
    if (v) sp.set(key, v);
    else sp.delete(key);
    router.replace(sp.size ? `${pathname}?${sp.toString()}` : pathname);
  };
  const setVessel = (v: string) => setParam('vesselId', v || 'all');
  const categoryParam = params.get('category');
  const category = categoryParam && (CREW_CATEGORY_KEYS as string[]).includes(categoryParam) ? categoryParam : '';
  // Vue matrice : seulement avec la consultation des certificats Members
  const matrix = params.get('view') === 'matrix' && can('members.certificates.view');

  const q = useDebounced(search.trim(), 300);
  const r = useDebounced(rank.trim(), 300);
  const enabled = can('members.view');
  const list = useCursorList<MemberListItem, MemberMatrixMeta>(
    ['members', 'list'],
    '/members',
    {
      search: q || undefined,
      status: status || undefined,
      rank: r || undefined,
      crewDepartment: dept || undefined,
      vesselId: vesselId || undefined,
      category: category || undefined,
      archived: archived || undefined,
      withCertificates: matrix ? 'true' : undefined,
      sort,
      order: sort === 'updatedAt' ? 'desc' : 'asc',
    },
    enabled,
  );
  const stats = useQuery({
    queryKey: ['members', 'stats', vesselId],
    queryFn: () => api.get<MemberStats>('/members/stats', { query: { vesselId: vesselId || undefined } }),
    enabled,
  });

  // Grand écran : la première fiche est présentée d'emblée (comme une liste maître / détail)
  const firstId = list.rows?.[0]?.id ?? null;
  useEffect(() => {
    if (selected && list.rows && !list.rows.some((m) => m.id === selected)) setSelected(null);
    if (!selected && !dismissed && !matrix && firstId && window.matchMedia(WIDE).matches) setSelected(firstId);
  }, [firstId, list.rows, selected, dismissed, matrix]);

  if (!enabled) {
    return me.memberId ? (
      <Forbidden message="Vous n'avez pas accès à la liste des fiches. Votre propre fiche reste consultable depuis « Ma fiche »." />
    ) : (
      <Forbidden />
    );
  }

  const vessel = vesselId ? vesselById(vesselId) : undefined;
  const canCertificates = can('members.certificates.view');
  const select = (id: string) => {
    setSelected(id);
    setDismissed(false);
  };
  const openRow = (m: MemberListItem) => {
    if (window.matchMedia(WIDE).matches) select(m.id);
    else router.push(`/members/${m.id}`);
  };
  const filtersActive = !!(search || status || rank || dept || archived || vesselParam || category || sort !== 'lastName');
  const resetFilters = () => {
    setSearch('');
    setStatus('');
    setRank('');
    setDept('');
    setArchived(false);
    setSort('lastName');
    // La vue (liste / matrice) est conservée
    router.replace(matrix ? `${pathname}?view=matrix` : pathname);
  };
  const soonDays = stats.data?.expiringSoonDays;

  const columns: Column<MemberListItem>[] = [
    {
      key: 'member',
      header: 'Marin / matricule',
      cell: (m) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <MemberAvatar photoFileId={m.photoFileId} name={memberName(m)} />
          <span className="min-w-0">
            <Link href={`/members/${m.id}`} className="block truncate font-semibold text-navy hover:text-action hover:underline" onClick={(e) => e.stopPropagation()}>
              {memberName(m)}
            </Link>
            {m.amcRef && <span className="ref block whitespace-nowrap text-xs text-ink-muted">{m.amcRef}</span>}
          </span>
        </span>
      ),
    },
    {
      key: 'rank',
      header: 'Fonction / service',
      cell: (m) => (
        <span className="block max-w-[170px]">
          <span className="block truncate" title={m.rank ?? undefined}>
            {m.rank ?? '—'}
          </span>
          {m.crewDepartment && (
            <span className="block text-xs text-ink-muted">
              <DepartmentLabel value={m.crewDepartment} />
            </span>
          )}
        </span>
      ),
      hideBelow: 'md',
    },
    { key: 'vessel', header: 'Navire actuel', cell: (m) => <CurrentVessel m={m} />, hideBelow: 'md' },
    {
      key: 'nationality',
      header: 'Nationalité',
      cell: (m) =>
        m.nationality ? (
          <span className="whitespace-nowrap">
            {countryName(m.nationality)} <span className="ref text-xs text-ink-muted">{m.nationality}</span>
          </span>
        ) : (
          <span className="text-ink-soft">—</span>
        ),
      // Sous 1536 px la nationalité reste lisible dans la synthèse : priorité aux certificats et au contrat
      hideBelow: '2xl',
    },
    { key: 'status', header: 'Statut', cell: (m) => <MemberStatusBadge status={m.status} /> },
    ...(canCertificates
      ? [{ key: 'certs', header: 'Certificats', cell: (m: MemberListItem) => (m.certificateSummary ? <CertificateRatio c={m.certificateSummary} /> : '—'), hideBelow: 'lg' as const }]
      : []),
    ...(soonDays !== undefined
      ? [{ key: 'sb', header: 'Seaman book', cell: (m: MemberListItem) => <SeamanBook m={m} soonDays={soonDays} />, hideBelow: 'xl' as const }]
      : []),
    { key: 'contract', header: 'Fin de contrat', cell: (m) => <ContractEnd m={m} />, hideBelow: 'lg' },
    {
      key: 'actions',
      header: <span className="sr-only">Actions</span>,
      className: 'w-10',
      cell: (m) => <RowActions m={m} onPreview={() => select(m.id)} canCertificates={canCertificates} />,
    },
  ];

  return (
    <>
      <MembersHeader
        vesselId={vesselId}
        onCreate={() => setCreating(true)}
        description={
          vessel
            ? `Fiches affectées (planifiées ou à bord) au navire ${vessel.name} : affectations, certificats et pièces d’identité maritimes.`
            : 'Marins et personnel de votre périmètre : affectations, certificats et pièces d’identité maritimes.'
        }
      />

      <MemberKpis stats={stats.data} loading={stats.isLoading} status={status} onStatus={setStatus} />

      <FilterBar className="mb-4">
        <div className="relative w-full lg:w-72">
          <label className="sr-only" htmlFor="mb-search">
            Recherche
          </label>
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-ink-soft" aria-hidden />
          <Input id="mb-search" className="pl-8" placeholder="Nom, matricule, passeport ou seaman book" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="w-full sm:w-48">
          <label className="field-label" htmlFor="mb-category">
            Catégorie
          </label>
          <Select id="mb-category" value={category} onChange={(e) => setParam('category', e.target.value || null)}>
            <option value="">Toutes</option>
            {CREW_CATEGORY_KEYS.map((k) => (
              <option key={k} value={k}>
                {CREW_CATEGORIES[k].label}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-4px)] sm:w-40">
          <label className="field-label" htmlFor="mb-rank">
            Fonction
          </label>
          <Input id="mb-rank" placeholder="Ex. Master, AB" value={rank} onChange={(e) => setRank(e.target.value)} />
        </div>
        <div className="w-[calc(50%-4px)] sm:w-36">
          <label className="field-label" htmlFor="mb-dept">
            Service
          </label>
          <Select id="mb-dept" value={dept} onChange={(e) => setDept(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(CREW_DEPARTMENT_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-4px)] sm:w-44">
          <label className="field-label" htmlFor="mb-status">
            Statut
          </label>
          <Select id="mb-status" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tous</option>
            {Object.entries(MEMBER_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-4px)] sm:w-52">
          <label className="field-label" htmlFor="mb-vessel">
            Navire (affectation en cours)
          </label>
          <Select id="mb-vessel" value={vesselId} onChange={(e) => setVessel(e.target.value)}>
            <option value="">Tous les navires</option>
            {me.accessibleVessels.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} ({v.code})
              </option>
            ))}
          </Select>
        </div>
        <div className="w-[calc(50%-4px)] sm:w-44">
          <label className="field-label" htmlFor="mb-sort">
            Tri
          </label>
          <Select id="mb-sort" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="lastName">Nom</option>
            <option value="amcRef">Matricule</option>
            <option value="updatedAt">Dernière mise à jour</option>
            <option value="createdAt">Date de création</option>
          </Select>
        </div>
        <Checkbox className="mb-2" label="Fiches archivées" checked={archived} onChange={(e) => setArchived(e.target.checked)} />
        {filtersActive && (
          <Button variant="ghost" size="sm" className="mb-0.5 ml-auto text-action" onClick={resetFilters}>
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser les filtres
          </Button>
        )}
      </FilterBar>

      {canCertificates && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex rounded-md bg-white p-0.5 shadow-panel" role="group" aria-label="Affichage">
            {[
              { key: 'list', label: 'Liste', icon: Rows3 },
              { key: 'matrix', label: 'Matrice des certificats', icon: Grid3x3 },
            ].map((v) => {
              const active = (v.key === 'matrix') === matrix;
              return (
                <button
                  key={v.key}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setParam('view', v.key === 'matrix' ? 'matrix' : null)}
                  className={cn(
                    'inline-flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium transition-colors',
                    active ? 'bg-navy text-white' : 'text-ink-muted hover:bg-navy-50 hover:text-ink',
                  )}
                >
                  <v.icon className="h-4 w-4" aria-hidden /> {v.label}
                </button>
              );
            })}
          </div>
          {matrix && <p className="text-xs text-ink-muted">Échéance du certificat courant de chaque type ; une case ouvre le certificat.</p>}
        </div>
      )}

      {matrix && soonDays !== undefined ? (
        <CertificateMatrix
          rows={list.rows}
          meta={list.firstPage}
          loading={list.loading}
          error={list.error}
          onRetry={() => list.refetch()}
          hasMore={list.hasMore}
          onLoadMore={list.loadMore}
          loadingMore={list.loadingMore}
          total={list.total}
          soonDays={soonDays}
        />
      ) : (
      <DataTable
        caption="Liste des fiches Members"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        total={list.total}
        selectedId={selected}
        onRowClick={openRow}
        empty={
          <div className="px-6 py-10 text-center">
            <ListChecks className="mx-auto mb-2 h-5 w-5 text-navy-600" aria-hidden />
            <p className="font-semibold text-navy">Aucune fiche</p>
            <p className="mt-1 text-sm text-ink-muted">
              {archived ? 'Aucune fiche archivée ne correspond.' : 'Modifiez les filtres, ou créez / importez des fiches.'}
            </p>
          </div>
        }
        columns={columns}
      />
      )}

      {/* Le seuil « expire bientôt » vient des paramètres (stats) : pas de valeur supposée en attendant */}
      {selected && stats.data && !matrix && (
        <div className="hidden xl:block">
          <MemberSummary
            memberId={selected}
            soonDays={stats.data.expiringSoonDays}
            onClose={() => {
              setSelected(null);
              setDismissed(true);
            }}
          />
        </div>
      )}

      {creating && (
        <MemberCreateDialog
          open={creating}
          onOpenChange={setCreating}
          onCreated={(created) => {
            // Liste et compteurs partagent la clé « members »
            qc.invalidateQueries({ queryKey: ['members'] });
            if (created.forcedDuplicateOf.length) toast.warning('Fiche créée malgré un doublon potentiel : le motif est journalisé.');
            if (created.visible) {
              toast.success(`Fiche ${created.lastName.toUpperCase()} ${created.firstName} créée`);
              router.push(`/members/${created.id}`);
            } else {
              toast.success(
                `Fiche ${created.lastName.toUpperCase()} ${created.firstName} créée. Sans affectation sur un navire de votre périmètre, elle n'est visible que des profils Crew/HR.`,
                { duration: 10_000 },
              );
            }
          }}
        />
      )}
    </>
  );
}

export default function MembersPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <MembersList />
    </Suspense>
  );
}
