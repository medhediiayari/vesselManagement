'use client';

import { RENEWAL_STATUS_LABELS, VALIDITY_LABELS, VALIDITY_STATUSES } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, ExternalLink, Eye, FolderTree, Info, Layers, Plus, RotateCcw, Search, Settings2, ShieldCheck, Ship, UserRound, X } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { api, type Page } from '@/lib/api';
import { cn } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { EmptyState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { FilePreviewDialog } from '@/components/amc/file-preview';
import { ResourceExportButton } from '@/components/amc/resource-export';
import { CertificateFormDialog } from '@/components/certificates/certificate-form';
import { CertificateSidePanel } from '@/components/certificates/certificate-side-panel';
import { certKeys, useDebounced, useMediaQuery, useRefreshCertificates } from '@/components/certificates/lib';
import { ArchivedBadge, DocumentBadge, ExpiryCell, OpenRequestBadge, RenewalBadge, SubjectLink } from '@/components/certificates/status';
import { CategorySection, FolderSection, FolderSelect, TreeItem, useCertificateCategories, useCertificateFolders } from '@/components/certificates/tree';
import type { CertificateListItem, CertificateTypeDto, RequestListItem } from '@/components/certificates/types';

// Par défaut : échéances à venir d'abord, puis expirés récents (UI-08) — les tris explicites restent proposés
const DEFAULT_SORT = 'upcoming';
const SORTS: Record<string, string> = {
  upcoming: 'À échoir d’abord',
  'expiryOn:asc': 'Échéance croissante (expirés anciens d’abord)',
  'expiryOn:desc': 'Échéance la plus lointaine',
  'updatedAt:desc': 'Dernière mise à jour',
  'createdAt:desc': 'Création la plus récente',
};

const VALIDITY_PRESETS: Record<string, string> = {
  'EXPIRED,EXPIRING_SOON': 'Expirés ou expirant bientôt',
  ...Object.fromEntries(VALIDITY_STATUSES.map((v) => [v, VALIDITY_LABELS[v]])),
};

function FilterSelect({
  label,
  value,
  onChange,
  children,
  className,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn('min-w-0', className)}>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-muted">
        {label}
      </label>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} className="h-8 text-sm">
        {children}
      </Select>
    </div>
  );
}

export default function CertificatesExplorerPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <Explorer />
    </Suspense>
  );
}

function Explorer() {
  const router = useRouter();
  const sp = useSearchParams();
  const { can, canAny, me, selectedVesselIds, vesselById } = useSession();
  const refresh = useRefreshCertificates();
  const wide = useMediaQuery('(min-width: 1280px)');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [preview, setPreview] = useState<CertificateListItem | null>(null);

  const mine = sp.get('mine');
  // Lien dashboard « demandes retournées » : boîte « Mes demandes » filtrée
  useEffect(() => {
    if (mine === 'returned') router.replace('/certificates/approvals?view=mine&status=RETURNED');
  }, [mine, router]);

  const f = {
    search: sp.get('search') ?? '',
    subjectKind: sp.get('subjectKind') ?? '',
    typeId: sp.get('typeId') ?? '',
    category: sp.get('category') ?? '',
    folderId: sp.get('folderId') ?? '',
    validity: sp.get('validity') ?? '',
    expiringWithinDays: sp.get('expiringWithinDays') ?? '',
    renewalStatus: sp.get('renewalStatus') ?? (mine === 'renewal' ? 'IN_PROGRESS' : ''),
    documentMissing: sp.get('documentMissing') ?? '',
    pendingApproval: sp.get('pendingApproval') ?? '',
    archived: sp.get('archived') === 'true',
    vesselId: sp.get('vesselId') ?? '',
    // Liens du tableau de bord : navires + équipages affectés, mêmes chiffres que ses compteurs (ADM-06)
    vesselIds: sp.get('vesselIds') ?? '',
    sort: sp.get('sort') && SORTS[sp.get('sort')!] ? sp.get('sort')! : DEFAULT_SORT,
  };

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    router.replace(`/certificates${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  const [term, setTerm] = useState(f.search);
  const debounced = useDebounced(term.trim(), 300);
  useEffect(() => {
    if (debounced !== f.search) setParams({ search: debounced || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  // Navire : filtre explicite (URL) sinon navire unique du Vessel Switcher
  const switcherVessel = selectedVesselIds.length === 1 ? selectedVesselIds[0] : '';
  const vesselId = f.vesselId || (f.vesselIds ? '' : switcherVessel);
  const vesselOptions = selectedVesselIds.length > 1 ? me.accessibleVessels.filter((v) => selectedVesselIds.includes(v.id)) : me.accessibleVessels;
  const canMemberCerts = can('members.certificates.view');

  const [sortField, order] = f.sort.split(':');
  const params = useMemo(
    () => ({
      search: f.search || undefined,
      subjectKind: f.subjectKind || undefined,
      // Marins + navire : certificats de l'équipage affecté (PLANNED / ONBOARD)
      vesselId: vesselId && f.subjectKind !== 'MEMBER' ? vesselId : undefined,
      crewVesselId: vesselId && f.subjectKind === 'MEMBER' ? vesselId : undefined,
      // Plusieurs navires dans le Vessel Switcher : filtre serveur (navires + équipages affectés)
      vesselIds: vesselId ? undefined : f.vesselIds || (selectedVesselIds.length > 1 ? selectedVesselIds.join(',') : undefined),
      renewalOwner: mine === 'renewal' ? 'me' : undefined,
      typeId: f.typeId || undefined,
      category: f.category || undefined,
      folderId: f.folderId || undefined,
      validity: f.validity || undefined,
      expiringWithinDays: f.expiringWithinDays || undefined,
      renewalStatus: f.renewalStatus || undefined,
      documentMissing: f.documentMissing || undefined,
      pendingApproval: f.pendingApproval || undefined,
      archived: f.archived ? 'true' : undefined,
      sort: sortField,
      order,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sp.toString(), vesselId, selectedVesselIds.join(',')],
  );

  const list = useCursorList<CertificateListItem>(certKeys.list, '/certificates', params, can('certificates.view') && mine !== 'returned');
  const rows = list.rows;

  const types = useQuery({
    queryKey: [...certKeys.types, 'all'],
    queryFn: () => api.get<CertificateTypeDto[]>('/certificate-types'),
    enabled: can('certificates.view'),
    staleTime: 60_000,
  });
  // Arborescence : dossiers de classement et référentiel des catégories
  const folders = useCertificateFolders(can('certificates.view'));
  const categoryRefs = useCertificateCategories(can('certificates.view'));
  const categories = useMemo(() => {
    if (categoryRefs.data) return categoryRefs.data;
    const names = [...new Set((types.data ?? []).map((t) => t.category))].sort((a, b) => a.localeCompare(b));
    return names.map((name) => ({ id: null, name, sortOrder: 0, typeCount: 1, subjectKinds: [], certificateCount: 0 }));
  }, [categoryRefs.data, types.data]);
  const folderList = folders.data ?? [];
  const typeOptions = (types.data ?? []).filter((t) => !f.subjectKind || t.subjectKind === f.subjectKind);

  const toApprove = useQuery({
    queryKey: [...certKeys.requests, 'count-to-approve'],
    queryFn: () => api.get<Page<RequestListItem>>('/certificate-requests', { query: { toApprove: true, limit: 1 } }),
    enabled: canAny('certificates.approve', 'certificates.attachments.approve'),
    staleTime: 30_000,
  });

  if (!can('certificates.view')) return <Forbidden />;
  if (mine === 'returned') return <LoadingBlock rows={4} label="Redirection vers vos demandes…" />;

  const activeFilters =
    [f.search, f.subjectKind, f.typeId, f.category, f.folderId, f.validity, f.expiringWithinDays, f.renewalStatus, f.documentMissing, f.pendingApproval, f.vesselId, f.vesselIds, mine].filter(Boolean).length +
    (f.archived ? 1 : 0);

  const resetFilters = () => {
    setTerm('');
    router.replace('/certificates', { scroll: false });
  };

  const selectTree = (patch: Record<string, string | null>) =>
    setParams({ subjectKind: null, vesselId: null, vesselIds: null, category: null, typeId: null, folderId: null, ...patch });
  // Navire sans titulaire explicite = certificats du navire (même règle que l'API)
  const treeKind = f.subjectKind || (f.vesselId ? 'VESSEL' : '');
  const treeIs = (subjectKind: string, vessel: string, category: string) =>
    treeKind === subjectKind && f.vesselId === vessel && f.category === category && !f.typeId && !f.folderId;
  // Document officiel présent : aperçu au clic sur la ligne (le serveur revérifie les droits)
  const hasDocument = (r: CertificateListItem) => r.hasCurrentRevision && !r.documentMissing;

  const columns: Column<CertificateListItem>[] = [
    {
      key: 'subject',
      header: 'Titulaire',
      className: 'min-w-[150px]',
      cell: (r) => <SubjectLink subject={r.subject} subjectKind={r.subjectKind} showRank={!selectedId} className="max-w-[220px]" />,
    },
    {
      key: 'type',
      header: 'Type',
      className: 'min-w-[160px]',
      cell: (r) => (
        <div className="min-w-0">
          <p className="font-medium text-ink">{r.type.name}</p>
          <p className="text-xs text-ink-muted">
            {r.type.code} — {r.type.category}
            {r.folder && !f.folderId && <span className="text-ink-soft"> · {r.folder.name}</span>}
          </p>
        </div>
      ),
    },
    {
      key: 'number',
      header: 'Numéro',
      hideBelow: 'lg',
      // Panneau de détail ouvert : colonne masquée sauf sur très grand écran
      className: selectedId ? 'xl:hidden min-[1900px]:table-cell' : undefined,
      cell: (r) => <span className="tabular whitespace-nowrap">{r.currentNumber ?? '—'}</span>,
    },
    {
      key: 'expiry',
      header: 'Échéance et validité',
      cell: (r) => <ExpiryCell validity={r.validity} expiryKind={r.currentExpiryKind} expiryOn={r.currentExpiryOn} />,
    },
    {
      key: 'tracking',
      header: 'Suivi',
      hideBelow: 'sm',
      cell: (r) => (
        <div className="flex max-w-[260px] flex-wrap gap-1">
          {r.archivedAt && <ArchivedBadge />}
          <RenewalBadge status={r.renewal.status} hideIdle />
          <DocumentBadge
            hasCurrentRevision={r.hasCurrentRevision}
            documentMissing={r.documentMissing}
            documentRequired={r.documentRequired}
            pendingAttachment={!!r.pendingAttachmentRequest}
          />
          {r.openRequest && <OpenRequestBadge kind={r.openRequest.kind} status={r.openRequest.status} />}
        </div>
      ),
    },
    {
      key: 'open',
      header: <span className="sr-only">Ouvrir</span>,
      align: 'right',
      cell: (r) => (
        <div className="flex items-center justify-end">
          {hasDocument(r) && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setPreview(r);
              }}
              className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-navy-50 hover:text-action"
              aria-label={`Aperçu du document — ${r.type.name} — ${r.subject.label}`}
              title="Aperçu du document officiel"
            >
              <Eye className="h-4 w-4" aria-hidden />
            </button>
          )}
          <Link
            href={`/certificates/${r.id}`}
            onClick={(e) => e.stopPropagation()}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-ink-muted hover:bg-navy-50 hover:text-action"
            aria-label={`Ouvrir la fiche ${r.type.name} — ${r.subject.label}`}
            title="Ouvrir la fiche complète"
          >
            <ExternalLink className="h-4 w-4" aria-hidden />
          </Link>
        </div>
      ),
    },
  ];

  const showPanel = wide && !!selectedId;

  return (
    <>
      <PageHeader
        title="Certificats"
        description="Explorateur de conformité des navires et des marins : validité réelle, renouvellements, documents officiels et approbations."
        actions={
          <>
            {canAny('certificates.approve', 'certificates.attachments.approve', 'certificates.create', 'certificates.submit') && (
              <Link
                href="/certificates/approvals"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-white px-4 text-base font-medium text-ink hover:bg-canvas"
              >
                <ShieldCheck className="h-4 w-4 text-teal-700" aria-hidden /> Validations
                {!!toApprove.data?.total && (
                  <span className="rounded-full bg-warn px-1.5 text-xs font-semibold tabular text-white" aria-label={`${toApprove.data.total} demande(s) à valider`}>
                    {toApprove.data.total}
                  </span>
                )}
              </Link>
            )}
            {can('certificates.types.manage') && (
              <Link
                href="/certificates/settings"
                className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-white px-4 text-base font-medium text-ink hover:bg-canvas"
              >
                <Settings2 className="h-4 w-4" aria-hidden /> Configuration
              </Link>
            )}
            <ResourceExportButton
              resource="certificates"
              filters={{ vesselId: vesselId && f.subjectKind !== 'MEMBER' ? vesselId : undefined, subjectKind: f.subjectKind || undefined, includeArchived: f.archived ? 'true' : undefined }}
              title="Filtres appliqués à l'export : navire, titulaire et archivés ; les autres filtres de l'écran ne sont pas repris"
            />
            {can('certificates.create') && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="h-4 w-4" aria-hidden /> Nouveau certificat
              </Button>
            )}
          </>
        }
      />

      <FilterBar>
        <div className="w-full min-w-0 sm:w-64">
          <label htmlFor="cert-search" className="mb-1 block text-xs font-medium text-ink-muted">
            Recherche
          </label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-ink-soft" aria-hidden />
            <Input
              id="cert-search"
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Numéro, type, navire, marin…"
              className="h-8 pl-8 text-sm"
            />
          </div>
        </div>
        <FilterSelect label="Titulaire" value={f.subjectKind} onChange={(v) => setParams({ subjectKind: v, typeId: null })} className="w-32">
          <option value="">Tous</option>
          <option value="VESSEL">Navires</option>
          {canMemberCerts && <option value="MEMBER">Marins</option>}
        </FilterSelect>
        <FilterSelect label={f.subjectKind === 'MEMBER' ? 'Équipage du navire' : 'Navire'} value={vesselId} onChange={(v) => setParams({ vesselId: v, vesselIds: null })} className="w-44">
          <option value="">{selectedVesselIds.length > 1 ? 'Navires sélectionnés' : 'Tous les navires'}</option>
          {vesselOptions.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Type" value={f.typeId} onChange={(v) => setParams({ typeId: v })} className="w-48">
          <option value="">Tous les types</option>
          {typeOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.code})
            </option>
          ))}
        </FilterSelect>
        {folderList.length > 0 && (
          <div className="w-44 min-w-0">
            <label htmlFor="cert-folder" className="mb-1 block text-xs font-medium text-ink-muted">
              Dossier
            </label>
            <FolderSelect
              id="cert-folder"
              value={f.folderId === 'none' ? '' : f.folderId}
              onChange={(v) => setParams({ folderId: v })}
              folders={folderList}
              emptyLabel="Tous les dossiers"
              className="h-8 text-sm"
            />
          </div>
        )}
        <FilterSelect label="Catégorie" value={f.category} onChange={(v) => setParams({ category: v })} className="w-36">
          <option value="">Toutes</option>
          {categories.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Validité" value={f.validity} onChange={(v) => setParams({ validity: v })} className="w-56">
          <option value="">Toutes</option>
          {Object.entries(VALIDITY_PRESETS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
          {f.validity && !VALIDITY_PRESETS[f.validity] && <option value={f.validity}>{f.validity.split(',').map((v) => VALIDITY_LABELS[v as keyof typeof VALIDITY_LABELS] ?? v).join(' ou ')}</option>}
        </FilterSelect>
        <FilterSelect label="Échéance sous" value={f.expiringWithinDays} onChange={(v) => setParams({ expiringWithinDays: v })} className="w-28">
          <option value="">—</option>
          {['7', '30', '60', '90', '180', '365'].map((d) => (
            <option key={d} value={d}>
              {d} jours
            </option>
          ))}
          {f.expiringWithinDays && !['7', '30', '60', '90', '180', '365'].includes(f.expiringWithinDays) && (
            <option value={f.expiringWithinDays}>{f.expiringWithinDays} jours</option>
          )}
        </FilterSelect>
        <FilterSelect label="Renouvellement" value={f.renewalStatus} onChange={(v) => setParams({ renewalStatus: v, mine: null })} className="w-44">
          <option value="">Tous</option>
          {Object.entries(RENEWAL_STATUS_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </FilterSelect>
        <FilterSelect label="Document" value={f.documentMissing} onChange={(v) => setParams({ documentMissing: v })} className="w-44">
          <option value="">Tous</option>
          <option value="true">Document manquant</option>
          <option value="false">Document officiel</option>
        </FilterSelect>
        <FilterSelect label="Approbation" value={f.pendingApproval} onChange={(v) => setParams({ pendingApproval: v })} className="w-36">
          <option value="">Toutes</option>
          <option value="true">En attente</option>
          <option value="false">Sans attente</option>
        </FilterSelect>
        <FilterSelect label="Tri" value={f.sort} onChange={(v) => setParams({ sort: v === DEFAULT_SORT ? null : v })} className="w-56">
          {Object.entries(SORTS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </FilterSelect>
        <Checkbox label="Archivés" checked={f.archived} onChange={(e) => setParams({ archived: e.target.checked ? 'true' : null })} className="pb-1.5" />
        {activeFilters > 0 && (
          <Button variant="ghost" size="sm" onClick={resetFilters} className="ml-auto">
            <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser ({activeFilters})
          </Button>
        )}
      </FilterBar>

      {(mine === 'renewal' || (vesselId && !f.vesselId) || selectedVesselIds.length > 1 || (vesselId && f.subjectKind !== 'MEMBER') || (!vesselId && f.vesselIds)) && (
        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted" aria-live="polite">
          <Info className="h-3.5 w-3.5" aria-hidden />
          {mine === 'renewal' && (
            <Badge tone="info" icon={false}>
              Renouvellements qui vous sont assignés
              <button type="button" className="ml-1 rounded-full p-0.5 hover:bg-white" aria-label="Retirer ce filtre" onClick={() => setParams({ mine: null })}>
                <X className="h-3 w-3" aria-hidden />
              </button>
            </Badge>
          )}
          {vesselId && !f.vesselId && <span>Navire du sélecteur appliqué : {vesselById(vesselId)?.name ?? 'navire'}.</span>}
          {!vesselId && f.vesselIds && (
            <span>
              Certificats de {f.vesselIds.split(',').map((id) => vesselById(id)?.name ?? 'navire').join(', ')} et de l’équipage affecté.
            </span>
          )}
          {selectedVesselIds.length > 1 && !vesselId && !f.vesselIds && (
            <span>{selectedVesselIds.length} navires sélectionnés : certificats de ces navires et de leurs équipages affectés.</span>
          )}
          {vesselId && f.subjectKind !== 'MEMBER' && canMemberCerts && (
            <span>
              Certificats du navire uniquement —{' '}
              <button type="button" className="font-medium text-action hover:underline" onClick={() => setParams({ subjectKind: 'MEMBER', typeId: null })}>
                voir ceux de l’équipage affecté
              </button>
              .
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          'grid items-start gap-4',
          showPanel ? 'xl:grid-cols-[minmax(0,1fr)_400px] min-[1900px]:grid-cols-[220px_minmax(0,1fr)_440px]' : '2xl:grid-cols-[220px_minmax(0,1fr)]',
        )}
      >
        <nav aria-label="Arborescence des certificats" className={cn('panel hidden p-2', showPanel ? 'min-[1900px]:block' : '2xl:block')}>
          <p className="flex items-center gap-1.5 px-2 pb-1 pt-1 text-xs font-semibold text-ink-muted">
            <FolderTree className="h-3.5 w-3.5" aria-hidden /> Arborescence
          </p>
          <ul className="space-y-0.5">
            <TreeItem active={treeIs('', '', '')} onClick={() => selectTree({})} icon={<Layers className="h-4 w-4 text-teal-700" aria-hidden />}>
              Tous les certificats
            </TreeItem>
            <TreeItem active={treeIs('VESSEL', '', '')} onClick={() => selectTree({ subjectKind: 'VESSEL' })} icon={<Ship className="h-4 w-4 text-teal-700" aria-hidden />}>
              Navires
            </TreeItem>
            {me.accessibleVessels.map((v) => (
              <TreeItem key={v.id} depth={1} active={treeIs('VESSEL', v.id, '')} onClick={() => selectTree({ subjectKind: 'VESSEL', vesselId: v.id })}>
                {v.name}
              </TreeItem>
            ))}
            {canMemberCerts && (
              <>
                <TreeItem active={treeIs('MEMBER', '', '')} onClick={() => selectTree({ subjectKind: 'MEMBER' })} icon={<UserRound className="h-4 w-4 text-teal-700" aria-hidden />}>
                  Marins
                </TreeItem>
                {me.accessibleVessels.map((v) => (
                  <TreeItem key={v.id} depth={1} active={treeIs('MEMBER', v.id, '')} onClick={() => selectTree({ subjectKind: 'MEMBER', vesselId: v.id })}>
                    Équipage {v.name}
                  </TreeItem>
                ))}
              </>
            )}
          </ul>
          <FolderSection folders={folderList} selectedId={f.folderId} onSelect={(id) => selectTree({ folderId: id })} />
          <CategorySection categories={categories} selected={treeIs('', '', f.category) ? f.category : ''} onSelect={(name) => selectTree({ category: name })} />
        </nav>

        <div className="min-w-0">
          <DataTable
            caption="Certificats"
            columns={columns}
            rows={rows}
            loading={list.loading}
            error={list.error}
            onRetry={() => list.refetch()}
            selectedId={selectedId}
            onRowClick={(r) => {
              // Document disponible : aperçu immédiat (et détail dans le panneau latéral si l'écran le permet)
              if (hasDocument(r)) {
                setPreview(r);
                if (wide) setSelectedId(r.id);
                return;
              }
              if (wide) setSelectedId((cur) => (cur === r.id ? null : r.id));
              else router.push(`/certificates/${r.id}`);
            }}
            hasMore={list.hasMore}
            onLoadMore={list.loadMore}
            loadingMore={list.loadingMore}
            total={list.total}
            empty={
              <EmptyState
                title="Aucun certificat ne correspond"
                description={activeFilters ? 'Modifiez ou réinitialisez les filtres.' : 'Aucun certificat visible dans votre périmètre.'}
                action={
                  activeFilters ? (
                    <Button variant="secondary" size="sm" onClick={resetFilters}>
                      <RotateCcw className="h-4 w-4" aria-hidden /> Réinitialiser les filtres
                    </Button>
                  ) : can('certificates.create') ? (
                    <Button size="sm" onClick={() => setCreateOpen(true)}>
                      <Plus className="h-4 w-4" aria-hidden /> Nouveau certificat
                    </Button>
                  ) : undefined
                }
              />
            }
          />
          {wide && !selectedId && rows && rows.length > 0 && (
            <p className="mt-2 text-xs text-ink-soft">Cliquez sur une ligne (ou Entrée) : aperçu du document officiel s’il est disponible, détail dans le panneau latéral.</p>
          )}
        </div>

        {showPanel && selectedId && <CertificateSidePanel id={selectedId} onClose={() => setSelectedId(null)} />}
      </div>

      {preview && (
        <FilePreviewDialog
          open
          onOpenChange={(o) => !o && setPreview(null)}
          title={`${preview.type.name} — ${preview.subject.label}`}
          description={`${preview.type.code}${preview.currentNumber ? ` · N° ${preview.currentNumber}` : ''} · document officiel de la révision courante`}
          previewPath={`/certificates/${preview.id}/preview`}
          downloadPath={`/certificates/${preview.id}/download`}
          canDownload={can('certificates.download_current')}
          actions={
            <Link
              href={`/certificates/${preview.id}`}
              className="inline-flex h-9 items-center gap-2 rounded-md border border-line-strong bg-white px-4 text-base font-medium text-ink hover:bg-canvas"
            >
              Ouvrir la fiche <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          }
        />
      )}

      {createOpen && (
        <CertificateFormDialog
          mode="create"
          defaults={{
            subjectKind: f.subjectKind === 'MEMBER' ? 'MEMBER' : 'VESSEL',
            vesselId: f.subjectKind !== 'MEMBER' ? vesselId || null : null,
            typeId: f.typeId || null,
            folderId: f.folderId && f.folderId !== 'none' && can('certificates.folders.manage') ? f.folderId : null,
          }}
          open={createOpen}
          onOpenChange={setCreateOpen}
          onDone={async (res) => {
            await refresh(res.certificateId);
            if (res.certificateId) router.push(`/certificates/${res.certificateId}`);
          }}
        />
      )}
    </>
  );
}
