'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Gavel, X } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { MissingDocumentBadge } from '@/components/amc/certificate-badge';
import { IconButton } from '@/components/ui/button';
import { DefinitionGrid } from '@/components/ui/page';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { InlineCertificatePreview } from './document-preview';
import { certKeys, fmtDays, fmtExpiry } from './lib';
import { ArchivedBadge, DocumentBadge, OpenRequestBadge, RenewalBadge, SubjectLink, ValidityBadge } from './status';
import { REQUEST_KIND_LABELS, type CertificateDetail } from './types';

/** Panneau de détail à droite de l'explorateur : résumé + aperçu du document officiel. */
export function CertificateSidePanel({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useQuery({ queryKey: certKeys.detail(id), queryFn: () => api.get<CertificateDetail>(`/certificates/${id}`) });
  const c = q.data;

  return (
    <aside aria-label="Détail du certificat sélectionné" className="panel flex max-h-[calc(100vh-5rem)] flex-col overflow-hidden xl:sticky xl:top-[4.5rem]">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-ink-muted">{c ? `${c.type.code} — ${c.type.category}` : 'Certificat'}</p>
          <h2 className="truncate text-md font-semibold">{c?.type.name ?? 'Chargement…'}</h2>
        </div>
        <IconButton label="Fermer le panneau de détail" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {q.isLoading && <LoadingBlock rows={6} />}
        {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
        {c && (
          <>
            <SubjectLink subject={c.subject} subjectKind={c.subjectKind} showRank />
            <div className="flex flex-wrap gap-1.5">
              {c.archivedAt && <ArchivedBadge />}
              <ValidityBadge validity={c.validity} expiryOn={c.currentRevision?.expiryOn} />
              <RenewalBadge status={c.renewal.status} hideIdle />
              <DocumentBadge
                hasCurrentRevision={!!c.currentRevision}
                documentMissing={c.documentMissing}
                documentRequired={c.documentRequired}
                pendingAttachment={!!c.pendingAttachmentRequestId}
              />
            </div>

            {c.currentRevision ? (
              <DefinitionGrid
                items={[
                  ['Numéro', <span key="n" className="tabular">{c.currentRevision.certificateNumber ?? '—'}</span>],
                  ['Échéance', <span key="e" className="tabular">{fmtExpiry(c.currentRevision.expiryKind, c.currentRevision.expiryOn)}{c.currentRevision.expiryKind === 'DATED' && fmtDays(c.daysToExpiry) ? ` — ${fmtDays(c.daysToExpiry)?.toLowerCase()}` : ''}</span>],
                  ['Émetteur', c.currentRevision.issuer],
                  ['Autorité', c.currentRevision.authority],
                  ["Date d'émission", fmtDate(c.currentRevision.issuedOn)],
                  ['Valide à partir du', fmtDate(c.currentRevision.validFrom)],
                  ['Révision', `n° ${c.currentRevision.revisionNo} — approuvée le ${fmtDateTime(c.currentRevision.approvedAt)}`],
                  ['Renouvellement', c.renewal.status === 'IN_PROGRESS' ? `${c.renewal.owner?.displayName ?? 'Sans responsable'}${c.renewal.dueOn ? ` — avant le ${fmtDate(c.renewal.dueOn)}` : ''}` : '—'],
                ]}
              />
            ) : (
              <p className="rounded-md bg-canvas px-3 py-2 text-sm text-ink-muted">Aucune révision approuvée : la demande de création est en cours de traitement.</p>
            )}

            {c.requests
              .filter((r) => ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'].includes(r.status))
              .map((r) => (
                <div key={r.id} className="rounded-md border border-line px-3 py-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <OpenRequestBadge kind={r.kind} status={r.status} />
                    <span className="text-xs text-ink-muted">v{r.version}</span>
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    {REQUEST_KIND_LABELS[r.kind]} demandé(e) par {r.requestedBy?.displayName ?? '—'} le {fmtDateTime(r.createdAt)}
                    {r.kind === 'RENEWAL' ? ' — l’ancien certificat reste courant jusqu’à approbation.' : ''}
                  </p>
                  <Link
                    href={`/certificates/${c.id}?tab=requests&request=${r.id}`}
                    className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-action hover:underline"
                  >
                    {r.canDecide ? (
                      <>
                        <Gavel className="h-4 w-4" aria-hidden /> Décider
                      </>
                    ) : (
                      'Voir la demande'
                    )}
                  </Link>
                </div>
              ))}

            <section aria-label="Document officiel">
              <h3 className="mb-2 text-sm font-semibold text-navy">Document officiel</h3>
              {c.currentRevision?.officialAttachment ? (
                c.permissions.canPreviewCurrent ? (
                  <InlineCertificatePreview
                    certificateId={c.id}
                    title={`${c.type.name} — ${c.subject.label}`}
                    canDownload={c.permissions.canDownloadCurrent}
                    frameClassName="h-[360px]"
                  />
                ) : (
                  <p className="text-sm text-ink-muted">Aperçu indisponible pour ce format sans droit de téléchargement.</p>
                )
              ) : c.currentRevision ? (
                <div className="space-y-1">
                  {c.documentRequired ? <MissingDocumentBadge /> : <p className="text-sm text-ink-muted">Aucun document (facultatif pour ce type).</p>}
                  {c.pendingAttachmentRequestId && (
                    <p className="text-xs text-ink-muted">Une pièce est en attente de validation : elle ne devient officielle qu’après approbation.</p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-ink-muted">Le document deviendra officiel avec l’approbation de la demande.</p>
              )}
            </section>
          </>
        )}
      </div>
      <div className="border-t border-line px-4 py-3">
        <Link
          href={`/certificates/${id}`}
          className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md bg-action px-4 text-base font-medium text-white hover:bg-action-700"
        >
          Ouvrir la fiche complète <ArrowRight className="h-4 w-4" aria-hidden />
        </Link>
      </div>
    </aside>
  );
}
