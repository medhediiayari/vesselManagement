'use client';

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, FilePlus2, Lock, Navigation, Pencil, Plus, Ship } from 'lucide-react';
import Link from 'next/link';
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LinkButton, Notice } from '@/components/voyages/common';
import { fmtLaycan, fmtUtc, voyageKeys } from '@/components/voyages/lib';
import { VoyageStatusBadge } from '@/components/voyages/status';
import { CargoTab } from '@/components/voyages/tab-cargo';
import { CharterPartyTab } from '@/components/voyages/tab-charter-party';
import { ChecklistTab } from '@/components/voyages/tab-checklist';
import { FilesTab } from '@/components/voyages/tab-files';
import { InstructionsTab } from '@/components/voyages/tab-instructions';
import { NoonTab } from '@/components/voyages/tab-noon';
import { NoticesTab } from '@/components/voyages/tab-notices';
import { OverviewTab } from '@/components/voyages/tab-overview';
import { PortsTab } from '@/components/voyages/tab-ports';
import { TimelineTab } from '@/components/voyages/tab-timeline';
import type { VoyageWorkspace } from '@/components/voyages/types';
import { VoyageCommands } from '@/components/voyages/voyage-commands';
import { VoyageFormDialog } from '@/components/voyages/voyage-form';

const TABS = ['overview', 'ports', 'cargo', 'notices', 'cp', 'instructions', 'checklist', 'noon', 'files', 'timeline'] as const;
type Tab = (typeof TABS)[number];

function HeaderFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="truncate text-sm font-medium text-ink">{children}</dd>
    </div>
  );
}

function Workspace() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const { can } = useSession();
  const [edit, setEdit] = useState<null | 'full' | 'schedule'>(null);
  const q = useQuery({ queryKey: voyageKeys.ws(id), queryFn: () => api.get<VoyageWorkspace>(`/voyages/${id}`) });

  const requested = sp.get('tab');
  const tab: Tab = (TABS as readonly string[]).includes(requested ?? '') ? (requested as Tab) : 'overview';
  const setTab = (t: string) => {
    const next = new URLSearchParams(sp.toString());
    if (t === 'overview') next.delete('tab');
    else next.set('tab', t);
    const qs = next.toString();
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
  };

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const ws = q.data;
  const v = ws.overview;
  const closed = v.status === 'COMPLETED' || v.status === 'CANCELLED';
  const reportable = v.status === 'PLANNED' || v.status === 'ACTIVE';
  const showCp = can('charter_party.view');
  const showNoon = ws.noonReports !== null;
  const pendingNotices = ws.notices.filter((n) => ['PLANNED', 'DRAFTED', 'VALIDATED'].includes(n.status)).length;
  const openTasks = ws.tasks.filter((t) => t.status === 'OPEN').length;

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Voyages', href: '/voyages' }, { label: v.reference }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <Navigation className="h-6 w-6 text-teal-700" aria-hidden />
            <span className="ref">{v.reference}</span>
            <VoyageStatusBadge status={v.status} />
          </span>
        }
        actions={
          <>
            {can('noon.create') && reportable && showNoon && (
              <LinkButton href={`/noon-reports/new?voyageId=${v.id}`} size="md">
                <Plus className="h-4 w-4" aria-hidden /> Nouveau Noon Report
              </LinkButton>
            )}
            {ws.permissions.edit && (
              <>
                <Button variant="secondary" onClick={() => setEdit('schedule')}>
                  <CalendarClock className="h-4 w-4" aria-hidden /> Mettre à jour l’ETA
                </Button>
                <Button variant="secondary" onClick={() => setEdit('full')}>
                  <Pencil className="h-4 w-4" aria-hidden /> Modifier
                </Button>
              </>
            )}
            {showCp && can('charter_party.manage') && !closed && (
              <Button variant="secondary" onClick={() => setTab('cp')}>
                <FilePlus2 className="h-4 w-4" aria-hidden /> Contrat (CP)
              </Button>
            )}
            <VoyageCommands ws={ws} />
          </>
        }
      />

      <dl className="mb-5 grid grid-cols-2 gap-x-6 gap-y-3 rounded-lg bg-white p-4 shadow-panel sm:grid-cols-3 lg:grid-cols-6">
        <HeaderFact label="Navire">
          <Link href={`/vessels/${v.vessel.id}`} className="inline-flex items-center gap-1 text-action hover:underline">
            <Ship className="h-3.5 w-3.5" aria-hidden /> {v.vessel.name}
          </Link>
        </HeaderFact>
        <HeaderFact label="Charterer">{v.charterer ?? '—'}</HeaderFact>
        <HeaderFact label="Laycan">
          <span className="tabular">{fmtLaycan(v.laycanFrom, v.laycanTo, fmtDate)}</span>
        </HeaderFact>
        <HeaderFact label="Route">{v.route ?? '—'}</HeaderFact>
        <HeaderFact label={v.ata ? 'ATA' : 'ETA'}>
          <span className="tabular">{fmtUtc(v.ata ?? v.eta)}</span>
        </HeaderFact>
        <HeaderFact label="Charter Party">
          {v.charterPartyRestricted ? (
            <Badge tone="navy" icon={<Lock className="h-3.5 w-3.5" aria-hidden />}>
              Confidentielle
            </Badge>
          ) : ws.charterParty && ws.charterParty.linked ? (
            <Link href={`/charter-parties/${ws.charterParty.id}`} className="text-action hover:underline">
              {ws.charterParty.reference}
            </Link>
          ) : showCp ? (
            <span className="text-ink-muted">Non rattachée</span>
          ) : (
            '—'
          )}
        </HeaderFact>
      </dl>

      {closed && (
        <Notice tone="info" className="mb-4" title={v.status === 'COMPLETED' ? 'Voyage clôturé — lecture seule' : 'Voyage annulé — lecture seule'}>
          Les escales, cargaisons, notices et tâches ne sont plus modifiables.{v.status === 'COMPLETED' ? ' Des fichiers peuvent encore être ajoutés au dossier de fin de voyage.' : ''}
        </Notice>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Vue d’ensemble</TabsTrigger>
          <TabsTrigger value="ports" count={ws.ports.length}>
            Escales & agents
          </TabsTrigger>
          <TabsTrigger value="cargo" count={ws.cargo.length}>
            Cargaison
          </TabsTrigger>
          <TabsTrigger value="notices" count={pendingNotices}>
            Notices & NOR
          </TabsTrigger>
          {showCp && <TabsTrigger value="cp">Charter Party</TabsTrigger>}
          <TabsTrigger value="instructions" count={ws.instructions.length}>
            Instructions
          </TabsTrigger>
          <TabsTrigger value="checklist" count={openTasks}>
            Checklist
          </TabsTrigger>
          {showNoon && (
            <TabsTrigger value="noon" count={ws.noonReports?.total}>
              Noon Reports
            </TabsTrigger>
          )}
          <TabsTrigger value="files" count={ws.files.length}>
            Fichiers
          </TabsTrigger>
          <TabsTrigger value="timeline">Chronologie</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab ws={ws} />
        </TabsContent>
        <TabsContent value="ports">
          <PortsTab ws={ws} />
        </TabsContent>
        <TabsContent value="cargo">
          <CargoTab ws={ws} />
        </TabsContent>
        <TabsContent value="notices">
          <NoticesTab ws={ws} />
        </TabsContent>
        {showCp && (
          <TabsContent value="cp">
            <CharterPartyTab ws={ws} />
          </TabsContent>
        )}
        <TabsContent value="instructions">
          <InstructionsTab ws={ws} />
        </TabsContent>
        <TabsContent value="checklist">
          <ChecklistTab ws={ws} />
        </TabsContent>
        {showNoon && (
          <TabsContent value="noon">
            <NoonTab ws={ws} />
          </TabsContent>
        )}
        <TabsContent value="files">
          <FilesTab ws={ws} />
        </TabsContent>
        <TabsContent value="timeline">
          <TimelineTab ws={ws} />
        </TabsContent>
      </Tabs>

      {edit && (
        <VoyageFormDialog
          open={!!edit}
          onOpenChange={(o) => !o && setEdit(null)}
          voyage={v}
          focus={edit === 'schedule' ? 'schedule' : undefined}
          onSaved={() => void q.refetch()}
        />
      )}
    </>
  );
}

export default function VoyageWorkspacePage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <Workspace />
    </Suspense>
  );
}
