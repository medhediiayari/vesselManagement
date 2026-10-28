'use client';

import { useQuery } from '@tanstack/react-query';
import { Ban, Loader2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ImportMappingStep } from '@/components/members/import-mapping';
import { ImportPreviewStep } from '@/components/members/import-preview';
import { ImportResultStep, ReportButton } from '@/components/members/import-result';
import { ImportStepper, JobStatusBadge, type ImportStep } from '@/components/members/import-shared';
import { IMPORT_PHASE_LABELS, type ImportJob } from '@/components/members/types';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { api } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';

function defaultStep(job: ImportJob): ImportStep {
  if (job.phase === 'COMMITTED' || job.phase === 'COMMITTING') return 'result';
  if (job.phase === 'PREVIEW_READY') return 'preview';
  return 'mapping';
}

export default function MembersImportJobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { can } = useSession();
  const enabled = can('members.import');
  const q = useQuery({
    queryKey: ['import-job', jobId],
    queryFn: () => api.get<ImportJob>(`/members/import-jobs/${jobId}`),
    enabled,
    // Validation en cours : suivi périodique jusqu'à la fin du commit
    refetchInterval: (query) => (query.state.data?.phase === 'COMMITTING' ? 2_000 : false),
  });
  const [step, setStep] = useState<ImportStep | null>(null);
  const job = q.data;

  // Étape par défaut déduite de la phase ; suit les transitions (mapping -> preview, commit -> résultat)
  const phase = job?.phase;
  useEffect(() => {
    if (job) setStep(defaultStep(job));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (!enabled) return <Forbidden message="L'import Excel des fiches est réservé aux utilisateurs disposant de la permission d'import Members." />;
  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !job) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const current = step ?? defaultStep(job);
  const applied = (job.counts.byStatus.APPLIED ?? 0) > 0;
  const reachable = {
    mapping: job.phase === 'MAPPING' || (job.phase === 'PREVIEW_READY' && !applied) || job.status === 'CANCELLED',
    preview: job.phase !== 'MAPPING' && job.phase !== 'UPLOADED',
    result: job.phase === 'COMMITTED' || job.phase === 'COMMITTING',
  };

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'Marins & personnel', href: '/members' },
          { label: 'Import Excel', href: '/members/import' },
          { label: job.sourceFile?.originalName ?? 'Import' },
        ]}
        title={job.sourceFile?.originalName ?? 'Import Excel'}
        description={`Créé par ${job.createdBy?.displayName ?? '—'} le ${fmtDateTime(job.createdAt)}${job.sourceFile ? ` — ${fmtBytes(job.sourceFile.sizeBytes)}, SHA-256 ${job.sourceFile.sha256.slice(0, 12)}…` : ''}`}
        meta={
          <>
            <JobStatusBadge status={job.status} />
            <Badge tone="neutral" icon={false}>
              {IMPORT_PHASE_LABELS[job.phase] ?? job.phase}
            </Badge>
            <Badge tone="neutral" icon={false}>
              {job.sheets.length} feuille(s)
            </Badge>
          </>
        }
        actions={<ReportButton jobId={job.id} variant="secondary" />}
      />
      <ImportStepper current={current} reachable={reachable} onSelect={setStep} />

      {job.status === 'CANCELLED' && (
        <p className="mb-4 flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink-muted" role="status">
          <Ban className="h-4 w-4" aria-hidden /> Import annulé{job.finishedAt ? ` le ${fmtDateTime(job.finishedAt)}` : ''} : consultation seule.
        </p>
      )}
      {job.phase === 'COMMITTING' && (
        <p className="mb-4 flex items-center gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn" role="status">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Validation en cours : les lignes sont appliquées une à une.
        </p>
      )}

      {current === 'mapping' && <ImportMappingStep key={`${job.id}-${job.phase}`} job={job} onApplied={() => setStep('preview')} />}
      {current === 'preview' && <ImportPreviewStep job={job} onCommitted={() => setStep('result')} />}
      {current === 'result' && <ImportResultStep job={job} onShowRows={() => setStep('preview')} />}
    </>
  );
}
