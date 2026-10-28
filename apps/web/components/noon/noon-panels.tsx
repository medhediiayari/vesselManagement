'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRight, Eye, FileText, History, Paperclip } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { DownloadButton, FilePreviewDialog, FileRow } from '@/components/amc/file-preview';
import { FileUploader } from '@/components/amc/file-uploader';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { notifyError } from '@/components/voyages/lib';
import { FIELD_DEFS, displayValue, noonKeys } from './lib';
import type { NoonReportDetail, NoonRevisionFull } from './types';

/** Aperçu intégré du PDF figé d'une révision (GET /noon-reports/:id/pdf?revision=n). */
export function NoonPdfButton({ reportId, revisionNo, label, size = 'sm', variant = 'secondary' }: { reportId: string; revisionNo: number; label?: string; size?: 'sm' | 'md'; variant?: 'secondary' | 'primary' | 'ghost' }) {
  const [open, setOpen] = useState(false);
  const base = `/noon-reports/${reportId}/pdf?revision=${revisionNo}`;
  return (
    <>
      <Button size={size} variant={variant} onClick={() => setOpen(true)}>
        <Eye className="h-4 w-4" aria-hidden /> {label ?? `PDF rév. ${revisionNo}`}
      </Button>
      <FilePreviewDialog
        open={open}
        onOpenChange={setOpen}
        title={`Noon Report — révision ${revisionNo} (PDF figé)`}
        previewPath={`${base}&mode=preview`}
        downloadPath={`${base}&mode=download`}
        canDownload
        kind="PDF"
      />
    </>
  );
}

/** Historique des révisions figées avec diff ancien / nouveau (audit old/new, CDC §8.3). */
export function RevisionsPanel({ report }: { report: NoonReportDetail }) {
  const q = useQuery({
    queryKey: [...noonKeys.revisions(report.id), report.currentRevisionNo],
    queryFn: () => api.get<NoonRevisionFull[]>(`/noon-reports/${report.id}/revisions`),
    enabled: report.currentRevisionNo > 0,
  });
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <History className="h-4 w-4 text-teal-700" aria-hidden /> Révisions
        </span>
      }
      bodyClassName="p-0"
    >
      {report.currentRevisionNo === 0 && <p className="px-4 py-3 text-sm text-ink-muted">Aucune révision : le rapport sera figé (révision 1 + PDF) à la soumission.</p>}
      {q.isLoading && <LoadingBlock rows={2} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && (
        <ol className="divide-y divide-line">
          {[...q.data].reverse().map((r) => {
            const open = expanded === r.revisionNo || (expanded === null && r.revisionNo === report.currentRevisionNo);
            return (
              <li key={r.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-navy-50 px-1.5 py-0.5 text-xs font-semibold tabular text-navy">Rév. {r.revisionNo}</span>
                  {r.revisionNo === report.currentRevisionNo && <Badge tone="ok">Courante</Badge>}
                  <span className="text-xs text-ink-muted">
                    {fmtDateTime(r.createdAt)} — {r.createdBy ?? '—'}
                  </span>
                </div>
                <p className="mt-1 text-sm">{r.revisionNo === 1 ? 'Soumission initiale (révision originale conservée).' : <>Motif : {r.reason ?? '—'}</>}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {report.permissions.export && <NoonPdfButton reportId={report.id} revisionNo={r.revisionNo} label="Aperçu PDF" />}
                  {report.permissions.export && (
                    <DownloadButton path={`/noon-reports/${report.id}/pdf?revision=${r.revisionNo}&mode=download`} size="sm" label="Télécharger" />
                  )}
                  {r.changes.length > 0 && (
                    <Button size="sm" variant="ghost" aria-expanded={open} onClick={() => setExpanded(open ? -1 : r.revisionNo)}>
                      {open ? 'Masquer' : 'Voir'} les {r.changes.length} modification(s)
                    </Button>
                  )}
                </div>
                {open && r.changes.length > 0 && (
                  <div className="mt-2 overflow-x-auto rounded-md border border-line">
                    <table className="table-amc">
                      <caption className="sr-only">Modifications de la révision {r.revisionNo}</caption>
                      <thead>
                        <tr>
                          <th scope="col">Champ</th>
                          <th scope="col">Ancienne valeur</th>
                          <th scope="col" className="w-6">
                            <span className="sr-only">vers</span>
                          </th>
                          <th scope="col">Nouvelle valeur</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.changes.map((c) => (
                          <tr key={c.field}>
                            <td>
                              <span className="font-medium">{FIELD_DEFS[c.field]?.label ?? c.label}</span>
                              <span className="block text-xs text-ink-muted">{c.sectionTitle}</span>
                            </td>
                            <td className="tabular text-danger line-through decoration-danger/50">{displayValue(c.field, c.before)}</td>
                            <td aria-hidden>
                              <ArrowRight className="h-3.5 w-3.5 text-ink-muted" />
                            </td>
                            <td className="tabular font-medium text-ok">{displayValue(c.field, c.after)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Panel>
  );
}

/** Pièces jointes (contexte NOON_REPORT). */
export function AttachmentsPanel({ report }: { report: NoonReportDetail }) {
  const { can, canAny } = useSession();
  const qc = useQueryClient();
  const editable = report.status === 'DRAFT' || report.status === 'CORRECTION_REQUESTED';
  const canAdd = report.status !== 'ARCHIVED' && ((editable && canAny('noon.create', 'noon.correct')) || can('noon.correct'));
  const [adding, setAdding] = useState(false);
  return (
    <Panel
      title={
        <span className="flex items-center gap-2">
          <Paperclip className="h-4 w-4 text-teal-700" aria-hidden /> Pièces jointes
        </span>
      }
      actions={
        canAdd && (
          <Button size="sm" variant="secondary" onClick={() => setAdding((a) => !a)} aria-expanded={adding}>
            {adding ? 'Fermer' : 'Ajouter'}
          </Button>
        )
      }
    >
      {adding && (
        <div className="mb-3">
          <FileUploader
            context="NOON_REPORT"
            vesselId={report.vesselId}
            multiple
            label="Déposer photos ou documents"
            onUploaded={async (f) => {
              try {
                await api.post(`/noon-reports/${report.id}/attachments`, { fileId: f.id });
                await qc.invalidateQueries({ queryKey: noonKeys.detail(report.id) });
              } catch (e) {
                notifyError(e);
              }
            }}
          />
        </div>
      )}
      {report.attachments.length === 0 ? (
        <EmptyState icon={<FileText className="h-5 w-5" aria-hidden />} title="Aucune pièce jointe" className="py-6" />
      ) : (
        <div className="space-y-2">
          {report.attachments.map((a) =>
            a.file ? (
              <FileRow
                key={a.id}
                fileId={a.file.id}
                name={a.file.originalName}
                kind={a.file.kind}
                sizeBytes={a.file.sizeBytes}
                extra={<span className="hidden text-xs text-ink-muted xl:inline">{a.uploadedBy ?? ''}</span>}
              />
            ) : null,
          )}
        </div>
      )}
    </Panel>
  );
}
