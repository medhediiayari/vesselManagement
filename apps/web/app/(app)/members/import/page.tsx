'use client';

import { ScanSearch } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { FileUploader } from '@/components/amc/file-uploader';
import { ImportStepper, JobStatusBadge } from '@/components/members/import-shared';
import { IMPORT_PHASE_LABELS, type ImportJob, type ImportJobListItem } from '@/components/members/types';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { Field, Select } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { Forbidden } from '@/components/ui/states';
import { api, errorMessage, type StoredFileDto } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';

function resumeLabel(j: ImportJobListItem): string {
  if (j.status === 'CANCELLED') return 'Consulter';
  if (j.phase === 'MAPPING' || j.phase === 'UPLOADED') return 'Reprendre le mapping';
  if (j.phase === 'PREVIEW_READY') return 'Reprendre les décisions';
  return 'Voir le résultat';
}

export default function MembersImportPage() {
  const router = useRouter();
  const { can, me } = useSession();
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [vesselId, setVesselId] = useState('');
  const [busy, setBusy] = useState(false);
  const enabled = can('members.import');
  const jobs = useCursorList<ImportJobListItem>(['import-jobs'], '/members/import-jobs', {}, enabled);

  if (!enabled) return <Forbidden message="L'import Excel des fiches est réservé aux utilisateurs disposant de la permission d'import Members." />;

  const start = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const job = await api.post<ImportJob>('/members/import-jobs', { sourceFileId: file.id, ...(vesselId ? { vesselId } : {}) });
      toast.success(`${job.sheets.length} feuille(s) détectée(s) : vérifiez le mapping proposé`);
      router.push(`/members/import/${job.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Marins & personnel', href: '/members' }, { label: 'Import Excel' }]}
        title="Import Excel des fiches"
        description="Découverte des feuilles, mapping des colonnes vers les champs Member et les certificats, prévisualisation avec détection des doublons, décision explicite par ligne puis validation. Rien n'est écrit avant la validation."
      />
      <ImportStepper current="upload" reachable={{}} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Panel title="1. Déposer le classeur">
          <div className="space-y-3">
            <FileUploader
              context="IMPORT_SOURCE"
              label="Déposer un classeur Excel ou CSV"
              hint=".xlsx, .xls ou .csv"
              onUploaded={setFile}
              disabled={busy}
            />
            <Field
              label="Navire par défaut (facultatif)"
              htmlFor="imp-vessel"
              hint="Utilisé pour les dates d'embarquement quand le classeur ne précise pas le navire."
            >
              <Select id="imp-vessel" value={vesselId} onChange={(e) => setVesselId(e.target.value)}>
                <option value="">Aucun</option>
                {me.accessibleVessels.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} ({v.code})
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end">
              <Button onClick={start} loading={busy} disabled={!file}>
                <ScanSearch className="h-4 w-4" aria-hidden /> Analyser le classeur
              </Button>
            </div>
          </div>
        </Panel>

        <section aria-labelledby="imp-jobs-title">
          <h2 id="imp-jobs-title" className="mb-2 text-md font-semibold">
            Imports récents
          </h2>
          <DataTable
            caption="Imports Excel Members"
            rows={jobs.rows}
            loading={jobs.loading}
            error={jobs.error}
            onRetry={() => jobs.refetch()}
            hasMore={jobs.hasMore}
            onLoadMore={jobs.loadMore}
            loadingMore={jobs.loadingMore}
            onRowClick={(j) => router.push(`/members/import/${j.id}`)}
            empty={<p className="px-4 py-8 text-center text-sm text-ink-muted">Aucun import pour le moment.</p>}
            columns={[
              {
                key: 'file',
                header: 'Fichier',
                cell: (j) => (
                  <span className="min-w-0">
                    <span className="block max-w-[260px] truncate font-medium text-navy" title={j.sourceFile?.originalName}>
                      {j.sourceFile?.originalName ?? '—'}
                    </span>
                    <span className="block text-xs text-ink-muted">
                      {j.createdBy?.displayName ?? '—'} — {fmtDateTime(j.createdAt)}
                    </span>
                  </span>
                ),
              },
              {
                key: 'state',
                header: 'État',
                cell: (j) => (
                  <span className="flex flex-col items-start gap-0.5">
                    <JobStatusBadge status={j.status} />
                    <span className="text-xs text-ink-muted">{IMPORT_PHASE_LABELS[j.phase] ?? j.phase}</span>
                  </span>
                ),
              },
              {
                key: 'rows',
                header: 'Lignes',
                hideBelow: 'md',
                cell: (j) => {
                  const p = j.summary?.preview;
                  const c = j.summary?.commit;
                  if (c) return <span className="text-xs">{c.created} créée(s), {c.updated} mise(s) à jour, {c.failed} échec(s)</span>;
                  if (p) return <span className="text-xs">{p.totalRows} ligne(s), {p.duplicateSuspected} doublon(s) suspecté(s)</span>;
                  return <span className="text-xs text-ink-soft">—</span>;
                },
              },
              {
                key: 'action',
                header: <span className="sr-only">Action</span>,
                align: 'right',
                cell: (j) => <span className="text-sm font-medium text-action">{resumeLabel(j)}</span>,
              },
            ]}
          />
        </section>
      </div>
    </>
  );
}
