'use client';

import { useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { toast } from 'sonner';
import { api, errorMessage } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, defaultTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';

interface SystemStatus {
  checks: Record<string, string>;
  configuration: Record<string, unknown> & { buckets: Record<string, string> };
  scheduledJobs: { name: string; lastRun: { status: string; started_at: string; finished_at: string | null; detail: unknown } | null }[];
  emails: Record<string, number>;
  failedEmails: { id: string; toAddress: string; subject: string; attempts: number; lastError: string | null; createdAt: string }[];
  fileScans: Record<string, number>;
  filesByKind: { kind: string; count: number; bytes: number }[];
  migrations: { migration_name: string; finished_at: string | null }[];
}

const JOB_LABELS: Record<string, string> = {
  'certificate-reminders': 'Rappels certificats',
  'cso-reminders': 'Rappels documents CSO',
  'purchasing-followup': 'Suivi achats',
  'voyage-notices': 'Notices de voyage',
  'orphan-files-cleanup': 'Purge des dépôts non rattachés',
  'outbox-dispatch': 'Diffusion des événements',
};

/** Exploitation : dépendances, jobs planifiés, e-mails, antivirus, stockage MinIO. */
export default function SystemPage() {
  const { can } = useSession();
  const q = useQuery({ queryKey: ['system-status'], queryFn: () => api.get<SystemStatus>('/system/status'), enabled: can('settings.manage'), refetchInterval: 30_000 });
  if (!can('settings.manage')) return <Forbidden />;
  if (q.isLoading) return <LoadingBlock rows={8} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title="État du système" description="Contrôle d'exploitation : aucune donnée métier ni secret n'est affiché." />
      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Dépendances et configuration">
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(d.checks).map(([k, v]) => (
              <Badge key={k} tone={v === 'up' ? 'ok' : 'danger'}>{k === 'database' ? 'PostgreSQL' : k === 'objectStorage' ? 'MinIO' : k} : {v === 'up' ? 'disponible' : 'indisponible'}</Badge>
            ))}
          </div>
          <DefinitionGrid
            items={[
              ['Antivirus', d.configuration.antivirus === 'clamav' ? 'ClamAV actif' : 'Désactivé — fichiers marqués « non analysé »'],
              ['E-mails', d.configuration.email === 'smtp' ? 'SMTP' : 'Désactivés (non envoyés, tracés)'],
              ['Remise des fichiers', d.configuration.fileDelivery === 'presigned' ? `URL signées (${d.configuration.signedUrlTtlSeconds} s)` : 'Flux via l’API'],
              ['Workers', d.configuration.workersEnabled ? 'Actifs dans ce processus' : 'Externes'],
              ['Buckets', Object.values(d.configuration.buckets).join(', ')],
              ['Migrations', `${d.migrations.length} appliquée(s) — dernière : ${d.migrations.at(-1)?.migration_name ?? '—'}`],
            ]}
          />
        </Panel>
        <Panel title="Tâches planifiées" bodyClassName="p-0">
          <table className="table-amc">
            <thead><tr><th>Tâche</th><th>Dernière exécution</th><th>Statut</th><th /></tr></thead>
            <tbody>
              {d.scheduledJobs.map((j) => (
                <tr key={j.name}>
                  <td>{JOB_LABELS[j.name] ?? j.name}</td>
                  <td className="tabular">{fmtDateTime(j.lastRun?.started_at)}</td>
                  <td>{j.lastRun ? <Badge tone={defaultTone(j.lastRun.status)}>{j.lastRun.status}</Badge> : <Badge tone="neutral">Jamais</Badge>}</td>
                  <td className="text-right">
                    {j.name !== 'orphan-files-cleanup' && j.name !== 'outbox-dispatch' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          try {
                            await api.post(`/system/jobs/${j.name}/run`);
                            toast.success('Tâche mise en file');
                            setTimeout(() => q.refetch(), 3000);
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      >
                        <Play className="h-3.5 w-3.5" aria-hidden /> Lancer
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
        <Panel title="E-mails">
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(d.emails).map(([k, v]) => <Badge key={k} tone={defaultTone(k)}>{k} : {v}</Badge>)}
            {!Object.keys(d.emails).length && <span className="text-sm text-ink-muted">Aucun envoi.</span>}
          </div>
          {d.failedEmails.length > 0 && (
            <ul className="space-y-1 text-xs">
              {d.failedEmails.map((e) => (
                <li key={e.id} className="rounded border border-danger-line bg-danger-bg px-2 py-1">
                  {fmtDateTime(e.createdAt)} — {e.toAddress} — {e.subject} ({e.attempts} tentative(s)) : {e.lastError}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Fichiers (MinIO)">
          <div className="mb-3 flex flex-wrap gap-2">
            {Object.entries(d.fileScans).map(([k, v]) => <Badge key={k} tone={defaultTone(k)}>{k} : {v}</Badge>)}
          </div>
          <table className="table-amc">
            <thead><tr><th>Type</th><th className="text-right">Fichiers</th><th className="text-right">Volume</th></tr></thead>
            <tbody>
              {d.filesByKind.map((f) => (
                <tr key={f.kind}><td>{f.kind}</td><td className="text-right tabular">{f.count}</td><td className="text-right tabular">{fmtBytes(f.bytes)}</td></tr>
              ))}
            </tbody>
          </table>
        </Panel>
      </div>
    </>
  );
}
