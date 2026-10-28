'use client';

import { useQueryClient } from '@tanstack/react-query';
import { Download, FileSpreadsheet, ListChecks, RotateCcw } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Panel } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/states';
import { api, errorMessage, type FileLink } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { JobStatusBadge } from './import-shared';
import { ActionLink } from './member-ui';
import type { CommitRun, ImportJob, ImportRow } from './types';

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="gauge">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={cn('text-lg font-semibold tabular', tone === 'ok' ? 'text-ok' : tone === 'warn' ? 'text-warn' : tone === 'danger' ? 'text-danger' : 'text-navy')}>
        {value}
      </p>
    </div>
  );
}

/** Rapport XLSX : lien signé éphémère demandé au clic (fichier EXPORT réservé au demandeur). */
export function ReportButton({ jobId, variant = 'primary' }: { jobId: string; variant?: 'primary' | 'secondary' }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant={variant}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const link = await api.get<FileLink & { fileId: string }>(`/members/import-jobs/${jobId}/report`);
          const a = document.createElement('a');
          a.href = link.url;
          a.rel = 'noopener';
          a.download = link.fileName;
          document.body.appendChild(a);
          a.click();
          a.remove();
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <Download className="h-4 w-4" aria-hidden /> Télécharger le rapport
    </Button>
  );
}

/** Étape 4 — résultat du commit (dernier passage + historique des reprises) et rapport. */
export function ImportResultStep({ job, onShowRows }: { job: ImportJob; onShowRows: () => void }) {
  const qc = useQueryClient();
  const [retryOpen, setRetryOpen] = useState(false);
  const run: CommitRun | undefined = job.summary?.commit;
  const runs = job.summary?.commitRuns ?? [];
  const failedRows = useCursorList<ImportRow>(['import-rows', job.id, 'failed'], `/members/import-jobs/${job.id}/rows`, { status: 'FAILED' }, (job.counts.byStatus.FAILED ?? 0) > 0);
  const canRetry = job.status !== 'CANCELLED' && job.phase === 'COMMITTED' && job.counts.pendingDuplicateDecisions === 0 && ((run?.failed ?? 0) > 0 || job.status !== 'COMPLETED');

  return (
    <div className="space-y-4">
      <Panel
        title="Résultat de l'import"
        actions={
          <>
            <JobStatusBadge status={job.status} />
            {job.finishedAt && <span className="text-xs text-ink-muted">le {fmtDateTime(job.finishedAt)}</span>}
          </>
        }
      >
        {job.errorMessage && (
          <p className="mb-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
            Interruption : {job.errorMessage}
          </p>
        )}
        {run ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
            <Stat label="Fiches créées" value={run.created} tone={run.created ? 'ok' : undefined} />
            <Stat label="Fiches mises à jour" value={run.updated} tone={run.updated ? 'ok' : undefined} />
            <Stat label="Lignes ignorées" value={run.ignored} />
            <Stat label="Invalides non importées" value={run.skippedInvalid} tone={run.skippedInvalid ? 'warn' : undefined} />
            <Stat label="Échecs" value={run.failed} tone={run.failed ? 'danger' : undefined} />
            <Stat label="Déjà appliquées (reprise)" value={run.alreadyApplied} />
            <Stat label="Demandes de certificats" value={run.certificateRequests} />
            <Stat label="Certificats non importés" value={run.certificatesSkipped} tone={run.certificatesSkipped ? 'warn' : undefined} />
            <Stat label="Affectations créées" value={run.assignments} />
          </div>
        ) : (
          <EmptyState title="Aucune validation enregistrée" />
        )}
        {run && run.certificateRequests > 0 && (
          <p className="mt-3 text-sm text-ink-muted">
            Les certificats importés sont des demandes en attente d’approbation (workflow habituel) ; ils restent signalés « document manquant »
            jusqu’au dépôt du scan. Les validateurs ont été notifiés.
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          <ReportButton jobId={job.id} />
          <Button variant="secondary" onClick={onShowRows}>
            <ListChecks className="h-4 w-4" aria-hidden /> Revoir les lignes et décisions
          </Button>
          {canRetry && (
            <Button variant="secondary" onClick={() => setRetryOpen(true)}>
              <RotateCcw className="h-4 w-4" aria-hidden /> Reprendre la validation
            </Button>
          )}
          <ActionLink href="/members/import" variant="ghost">
            <FileSpreadsheet className="h-4 w-4" aria-hidden /> Nouvel import
          </ActionLink>
        </div>
      </Panel>

      {(job.counts.byStatus.FAILED ?? 0) > 0 && (
        <Panel title={`Lignes en échec (${job.counts.byStatus.FAILED})`} bodyClassName="p-0">
          <ul className="divide-y divide-line">
            {failedRows.rows?.map((r) => (
              <li key={r.id} className="px-4 py-2 text-sm">
                <span className="font-medium">
                  {r.sheetName} — ligne {r.rowNumber} : {[r.normalized.member?.lastName, r.normalized.member?.firstName].filter(Boolean).join(' ')}
                </span>
                <span className="block text-danger">{r.errorMessage}</span>
              </li>
            ))}
          </ul>
          {failedRows.hasMore && (
            <div className="border-t border-line px-4 py-2">
              <Button size="sm" variant="secondary" onClick={failedRows.loadMore} loading={failedRows.loadingMore}>
                Charger la suite
              </Button>
            </div>
          )}
        </Panel>
      )}

      {runs.length > 1 && (
        <Panel title="Historique des validations" bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="table-amc">
              <thead>
                <tr>
                  <th scope="col">Passage</th>
                  <th scope="col">Date</th>
                  <th scope="col" className="text-right">
                    Créées
                  </th>
                  <th scope="col" className="text-right">
                    Mises à jour
                  </th>
                  <th scope="col" className="text-right">
                    Échecs
                  </th>
                  <th scope="col" className="text-right">
                    Déjà appliquées
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => (
                  <tr key={i}>
                    <td>n° {i + 1}</td>
                    <td>{fmtDateTime(r.at)}</td>
                    <td className="text-right tabular">{r.created}</td>
                    <td className="text-right tabular">{r.updated}</td>
                    <td className="text-right tabular">{r.failed}</td>
                    <td className="text-right tabular">{r.alreadyApplied}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <ConfirmDialog
        open={retryOpen}
        onOpenChange={setRetryOpen}
        title="Reprendre la validation"
        description="Les lignes déjà appliquées sont ignorées ; les lignes en échec ou non traitées sont de nouveau tentées."
        confirmLabel="Reprendre"
        onConfirm={async () => {
          const res = await api.post<{ job: ImportJob; run: CommitRun }>(`/members/import-jobs/${job.id}/commit`);
          qc.setQueryData(['import-job', job.id], res.job);
          await qc.invalidateQueries({ queryKey: ['import-rows', job.id] });
          toast.success('Validation relancée');
        }}
      />
    </div>
  );
}
