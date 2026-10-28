'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import type { AuditEvent } from '@/components/amc/audit-timeline';
import { Badge } from '@/components/ui/badge';
import { DataTable } from '@/components/ui/data-table';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { FilterBar, PageHeader } from '@/components/ui/page';
import { Forbidden, LoadingBlock } from '@/components/ui/states';
import { MODULE_LABELS } from '../types';

const MODULE_PERMS: Record<string, string> = {
  admin: 'audit.view.admin',
  auth: 'audit.view.admin',
  fleet: 'audit.view.fleet',
  members: 'audit.view.members',
  certificates: 'audit.view.certificates',
  cso: 'cso.audit.view',
  purchasing: 'audit.view.purchasing',
  voyages: 'audit.view.voyages',
  noon: 'audit.view.voyages',
  platform: 'audit.view.platform',
};

/** Journal d'audit append-only, lu par module et dans le scope navire (ADM-011/012). */
export default function AuditPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={8} />}>
      <AuditList />
    </Suspense>
  );
}

/** `?module=`, `?action=`, `?result=`, `?from=AAAA-MM-JJ` (liens du tableau de bord) pré-filtrent le journal. */
function AuditList() {
  const params = useSearchParams();
  const { can, me, selectedVesselIds } = useSession();
  const modules = Object.entries(MODULE_PERMS).filter(([, p]) => can(p)).map(([m]) => m);
  const [module, setModule] = useState(() => params.get('module') ?? '');
  const [action, setAction] = useState(() => params.get('action') ?? '');
  const [result, setResult] = useState(() => params.get('result') ?? '');
  const [from, setFrom] = useState(() => params.get('from') ?? '');
  const [to, setTo] = useState('');
  const [detail, setDetail] = useState<AuditEvent | null>(null);
  const vesselId = selectedVesselIds.length === 1 ? selectedVesselIds[0] : undefined;
  const list = useCursorList<AuditEvent & { vesselId: string | null; ip: string | null }>(
    ['audit-list'],
    '/audit',
    {
      module: module || undefined,
      action: action || undefined,
      result: result || undefined,
      from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
      to: to ? new Date(`${to}T23:59:59`).toISOString() : undefined,
      vesselId,
    },
    modules.length > 0,
  );
  if (!modules.length) return <Forbidden />;
  return (
    <>
      <PageHeader
        title="Journal d'audit"
        description="Événements en écriture seule : modifications, approbations, consultations et téléchargements sensibles, refus d'accès. Filtré selon vos droits par module et votre périmètre navire."
      />
      <FilterBar>
        <div className="w-48">
          <label className="field-label" htmlFor="a-mod">Module</label>
          <Select id="a-mod" value={module} onChange={(e) => setModule(e.target.value)}>
            <option value="">Tous mes modules</option>
            {modules.map((m) => <option key={m} value={m}>{MODULE_LABELS[m] ?? (m === 'auth' ? 'Connexions' : m)}</option>)}
          </Select>
        </div>
        <div className="w-56">
          <label className="field-label" htmlFor="a-act">Action (préfixe)</label>
          <Input id="a-act" placeholder="ex. certificate., file.download" value={action} onChange={(e) => setAction(e.target.value)} />
        </div>
        <div className="w-40">
          <label className="field-label" htmlFor="a-res">Résultat</label>
          <Select id="a-res" value={result} onChange={(e) => setResult(e.target.value)}>
            <option value="">Tous</option>
            <option value="SUCCESS">Succès</option>
            <option value="DENIED">Refusé</option>
            <option value="FAILURE">Échec</option>
          </Select>
        </div>
        <div className="w-40">
          <label className="field-label" htmlFor="a-from">Du</label>
          <Input id="a-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="w-40">
          <label className="field-label" htmlFor="a-to">Au</label>
          <Input id="a-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </FilterBar>
      <DataTable
        caption="Événements d'audit"
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => list.refetch()}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        loadingMore={list.loadingMore}
        onRowClick={setDetail}
        columns={[
          { key: 'at', header: 'Date', cell: (e) => <span className="whitespace-nowrap tabular">{fmtDateTime(e.occurredAt)}</span> },
          { key: 'actor', header: 'Acteur', cell: (e) => e.actorLabel ?? 'système' },
          { key: 'action', header: 'Action', cell: (e) => <code className="text-xs">{e.action}</code> },
          { key: 'entity', header: 'Objet', cell: (e) => <span className="text-xs text-ink-muted">{e.entityType}{e.entityId ? ` ${e.entityId.slice(0, 8)}…` : ''}</span>, hideBelow: 'md' },
          { key: 'vessel', header: 'Navire', cell: (e) => me.accessibleVessels.find((v) => v.id === e.vesselId)?.code ?? '—', hideBelow: 'lg' },
          {
            key: 'result',
            header: 'Résultat',
            cell: (e) => (e.result === 'SUCCESS' ? <Badge tone="ok">Succès</Badge> : e.result === 'DENIED' ? <Badge tone="danger">Refusé</Badge> : <Badge tone="warn">Échec</Badge>),
          },
        ]}
      />
      <Dialog open={!!detail} onOpenChange={(o) => !o && setDetail(null)} title={detail?.action ?? ''} description={detail ? `${fmtDateTime(detail.occurredAt)} — ${detail.actorLabel ?? 'système'}` : undefined} size="lg">
        {detail && (
          <div className="grid gap-3 md:grid-cols-2">
            {(['before', 'after', 'metadata'] as const).map((k) => (
              <div key={k} className={k === 'metadata' ? 'md:col-span-2' : undefined}>
                <p className="field-label">{k === 'before' ? 'Avant' : k === 'after' ? 'Après' : 'Contexte'}</p>
                <pre className="max-h-72 overflow-auto rounded-md bg-canvas p-3 text-xs">{detail[k] ? JSON.stringify(detail[k], null, 2) : '—'}</pre>
              </div>
            ))}
          </div>
        )}
      </Dialog>
    </>
  );
}
