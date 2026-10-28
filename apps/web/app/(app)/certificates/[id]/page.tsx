'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Archive, ChevronDown, FilePlus2, Gavel, Info, PenLine, RefreshCw, X } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { AuditTimeline } from '@/components/amc/audit-timeline';
import { MissingDocumentBadge } from '@/components/amc/certificate-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AttachmentDialog } from '@/components/certificates/attachment-dialog';
import { AttachmentFileRow } from '@/components/certificates/attachment-file';
import { CertificateFormDialog } from '@/components/certificates/certificate-form';
import { InlineCertificatePreview } from '@/components/certificates/document-preview';
import { certKeys, fmtDays, fmtExpiry, useRefreshCertificates } from '@/components/certificates/lib';
import { RenewalPanel } from '@/components/certificates/renewal-panel';
import { RequestCard } from '@/components/certificates/request-card';
import {
  ArchivedBadge,
  AttachmentStatusBadge,
  DocumentBadge,
  OpenRequestBadge,
  RenewalBadge,
  RequestKindBadge,
  RequestStatusBadge,
  SubjectLink,
  ValidityBadge,
} from '@/components/certificates/status';
import {
  FREQUENCY_LABELS,
  OPEN_STATUSES,
  REQUEST_KIND_LABELS,
  SUBJECT_KIND_LABELS,
  type AttachmentDto,
  type CertificateDetail,
  type RequestDto,
  type RevisionDto,
} from '@/components/certificates/types';

const TABS = ['overview', 'requests', 'revisions', 'attachments', 'history'] as const;
type Tab = (typeof TABS)[number];

export default function CertificateDetailPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <CertificateDetailView />
    </Suspense>
  );
}

function AttachmentLine({ certificateId, a }: { certificateId: string; a: AttachmentDto }) {
  if (!a.file) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-md border border-dashed border-line-strong px-3 py-2 text-sm text-ink-muted">
        <AttachmentStatusBadge status={a.status} current={a.isCurrentOfficial} />
        <span>Pièce non accessible : réservée au demandeur, au déposant et aux validateurs éligibles.</span>
      </div>
    );
  }
  return (
    <AttachmentFileRow
      certificateId={certificateId}
      attachment={a}
      extra={<AttachmentStatusBadge status={a.status} current={a.isCurrentOfficial} />}
    />
  );
}

function RevisionBlock({ c, rev, current }: { c: CertificateDetail; rev: RevisionDto; current: boolean }) {
  const files = c.attachments.filter((a) => a.revisionId === rev.id && a.status !== 'PENDING_APPROVAL' && a.status !== 'REJECTED');
  return (
    <article className="rounded-lg border border-line bg-white p-4">
      <header className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-navy">Révision n° {rev.revisionNo}</h3>
        {current ? (
          <Badge tone="ok">Courante</Badge>
        ) : (
          <Badge tone="neutral" icon={<Archive className="h-3.5 w-3.5" aria-hidden />}>
            Archivée{rev.archivedAt ? ` le ${fmtDate(rev.archivedAt)}` : ''}
          </Badge>
        )}
        <span className="text-xs text-ink-muted">
          Approuvée le {fmtDateTime(rev.approvedAt)} par {rev.approvedBy?.displayName ?? '—'}
        </span>
      </header>
      <DefinitionGrid
        columns={4}
        items={[
          ['Numéro', <span key="n" className="tabular">{rev.certificateNumber ?? '—'}</span>],
          ["Date d'émission", fmtDate(rev.issuedOn)],
          ['Valide à partir du', fmtDate(rev.validFrom)],
          ['Échéance', fmtExpiry(rev.expiryKind, rev.expiryOn)],
          ['Émetteur', rev.issuer],
          ['Autorité', rev.authority],
          ['Pays / lieu', [rev.country, rev.placeOfIssue].filter(Boolean).join(' — ') || null],
          ['Remarques', rev.remarks],
        ]}
      />
      <div className="mt-3 space-y-2">
        {files.length === 0 ? (
          <p className="text-sm text-ink-muted">Aucune pièce officielle pour cette révision.</p>
        ) : (
          files.map((a) => <AttachmentLine key={a.id} certificateId={c.id} a={a} />)
        )}
        {!current && files.length > 0 && !c.permissions.canDownloadArchived && (
          <p className="text-xs text-ink-muted">
            Consultation possible ; le téléchargement des archives requiert le droit « Télécharger les certificats archivés », distinct du téléchargement du document courant.
          </p>
        )}
      </div>
    </article>
  );
}

function RequestAuditItem({ r }: { r: RequestDto }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left text-sm hover:bg-canvas"
      >
        <ChevronDown className={cn('h-4 w-4 text-ink-muted transition-transform', open && 'rotate-180')} aria-hidden />
        <RequestKindBadge kind={r.kind} />
        <RequestStatusBadge status={r.status} />
        <span className="text-xs text-ink-muted">
          {fmtDateTime(r.createdAt)} — {r.requestedBy?.displayName ?? '—'}
        </span>
      </button>
      {open && (
        <div className="border-t border-line p-3">
          <AuditTimeline entityType="certificate_request" entityId={r.id} module="certificates" />
        </div>
      )}
    </li>
  );
}

function CertificateDetailView() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const sp = useSearchParams();
  const { can } = useSession();
  const refresh = useRefreshCertificates();
  const [form, setForm] = useState<'renew' | 'correct' | null>(null);
  const [editing, setEditing] = useState<RequestDto | null>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [supervisoryCancel, setSupervisoryCancel] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  const q = useQuery({ queryKey: certKeys.detail(id), queryFn: () => api.get<CertificateDetail>(`/certificates/${id}`) });
  const c = q.data;

  const requestParam = sp.get('request');
  const tabParam = sp.get('tab') as Tab | null;
  const tab: Tab = tabParam && TABS.includes(tabParam) ? tabParam : requestParam ? 'requests' : 'overview';
  const setTab = (t: string) => {
    const next = new URLSearchParams(sp.toString());
    next.set('tab', t);
    if (t !== 'requests') next.delete('request');
    router.replace(`/certificates/${id}?${next.toString()}`, { scroll: false });
  };

  // Lien profond depuis une notification ou la boîte des validations : focus sur la demande
  useEffect(() => {
    if (!c || tab !== 'requests' || !requestParam) return;
    const el = document.getElementById(`request-${requestParam}`);
    el?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [c, tab, requestParam]);

  const reload = async () => {
    setConflict(null);
    await refresh(id);
  };
  const onConflict = async (msg: string) => {
    setConflict(msg);
    await refresh(id);
  };

  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !c) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;

  const p = c.permissions;
  const rev = c.currentRevision;
  const openData = c.requests.find((r) => r.id === c.openRequestId) ?? null;
  const openAttachment = c.requests.find((r) => r.id === c.pendingAttachmentRequestId) ?? null;
  // Brouillon d'un autre utilisateur : masqué (pas de données de version), seul un résumé est fourni
  const hiddenOpen = [c.openRequest, c.pendingAttachmentRequest].filter(
    (s): s is NonNullable<typeof s> => !!s && !c.requests.some((r) => r.id === s.id),
  );
  const decidable = c.requests.filter((r) => r.canDecide);
  const openCount = c.requests.filter((r) => OPEN_STATUSES.includes(r.status)).length + hiddenOpen.length;
  const revisions = [...(rev ? [rev] : []), ...c.archivedRevisions];
  const subjectHref = c.subject.vessel ? `/vessels/${c.subject.vessel.id}` : c.subject.member ? `/members/${c.subject.member.id}` : undefined;

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'Certificats', href: '/certificates' },
          { label: c.subject.label, href: subjectHref },
          { label: c.type.name },
        ]}
        title={
          <span className="flex flex-wrap items-baseline gap-x-2">
            {c.type.name}
            <span className="text-md font-normal text-ink-muted">{c.type.code}</span>
          </span>
        }
        meta={
          <>
            <SubjectLink subject={c.subject} subjectKind={c.subjectKind} showRank className="mr-2" />
            {rev?.certificateNumber && (
              <Badge tone="navy" icon={false}>
                N° <span className="ref">{rev.certificateNumber}</span>
              </Badge>
            )}
            {c.archivedAt && <ArchivedBadge />}
            <ValidityBadge validity={c.validity} expiryOn={rev?.expiryOn} />
            <RenewalBadge status={c.renewal.status} hideIdle />
            <DocumentBadge hasCurrentRevision={!!rev} documentMissing={c.documentMissing} documentRequired={c.documentRequired} pendingAttachment={!!openAttachment} />
            {openData && <OpenRequestBadge kind={openData.kind} status={openData.status} />}
          </>
        }
        actions={
          <>
            {decidable.length > 0 && (
              <Button variant="navy" onClick={() => setTab('requests')}>
                <Gavel className="h-4 w-4" aria-hidden /> Décider ({decidable.length})
              </Button>
            )}
            {p.canRenew && (
              <Button onClick={() => setForm('renew')}>
                <RefreshCw className="h-4 w-4" aria-hidden /> Renouveler
              </Button>
            )}
            {p.canCorrect && (
              <Button variant="secondary" onClick={() => setForm('correct')}>
                <PenLine className="h-4 w-4" aria-hidden /> Corriger
              </Button>
            )}
            {p.canArchive && (
              <Button
                variant="secondary"
                onClick={() => setArchiveOpen(true)}
                disabled={openCount > 0}
                title={openCount > 0 ? 'Annulez ou faites décider les demandes en cours avant d’archiver' : undefined}
              >
                <Archive className="h-4 w-4" aria-hidden /> Archiver
              </Button>
            )}
          </>
        }
      />

      {hiddenOpen.map((s) => (
        <div key={s.id} role="note" className="mb-4 flex flex-wrap items-center gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
          <span className="min-w-0 flex-1">
            Une demande en préparation ({s.kind === 'ATTACHMENT' ? 'pièce jointe' : s.kind === 'RENEWAL' ? 'renouvellement' : s.kind === 'CORRECTION' ? 'correction' : 'création'}) de{' '}
            {(s.requestedBy ?? s.requester)?.displayName ?? 'un autre utilisateur'} est en cours : elle bloque une nouvelle demande du même type
            tant qu’elle n’est pas soumise ou annulée.
          </span>
          {s.canCancel && (
            <Button size="sm" variant="secondary" onClick={() => setSupervisoryCancel(s.id)}>
              Annuler cette demande (superviseur)
            </Button>
          )}
        </div>
      ))}

      {c.archivedAt && (
        <div role="note" className="mb-4 flex items-start gap-2 rounded-md border border-neutral-line bg-neutral-bg px-3 py-2 text-sm text-neutral">
          <Archive className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            Certificat archivé le {fmtDateTime(c.archivedAt)} par {c.archivedBy?.displayName ?? '—'}
            {c.archiveReason ? ` — motif : « ${c.archiveReason} »` : ''}. Aucune modification n’est possible.
          </span>
        </div>
      )}
      {openData && !c.archivedAt && (
        <div role="note" className="mb-4 flex flex-wrap items-start gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            Demande de {REQUEST_KIND_LABELS[openData.kind].toLowerCase()} {openData.statusLabel.toLowerCase()} (version {openData.version})
            {rev ? ' : la révision courante, son document officiel et ses alertes restent en vigueur jusqu’à l’approbation.' : '.'}
          </span>
          {tab !== 'requests' && (
            <button type="button" className="font-medium underline" onClick={() => setTab('requests')}>
              Voir la demande
            </button>
          )}
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="mb-4">
          <TabsTrigger value="overview">Vue d’ensemble</TabsTrigger>
          <TabsTrigger value="requests" count={openCount || null}>
            Demandes
          </TabsTrigger>
          <TabsTrigger value="revisions" count={revisions.length}>
            Révisions et archives
          </TabsTrigger>
          <TabsTrigger value="attachments" count={c.attachments.length}>
            Pièces jointes
          </TabsTrigger>
          <TabsTrigger value="history">Historique</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="grid items-start gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <div className="space-y-5">
            <Panel title="Révision courante">
              {rev ? (
                <>
                  <DefinitionGrid
                    columns={3}
                    items={[
                      ['Numéro', <span key="n" className="tabular">{rev.certificateNumber ?? '—'}</span>],
                      ['Émetteur', rev.issuer],
                      ['Autorité', rev.authority],
                      ['Pays', rev.country],
                      ["Lieu d'émission", rev.placeOfIssue],
                      ["Date d'émission", fmtDate(rev.issuedOn)],
                      ['Valide à partir du', fmtDate(rev.validFrom)],
                      [
                        'Échéance',
                        <span key="e" className="tabular">
                          {fmtExpiry(rev.expiryKind, rev.expiryOn)}
                          {rev.expiryKind === 'DATED' && fmtDays(c.daysToExpiry) && <span className="block text-xs text-ink-muted">{fmtDays(c.daysToExpiry)}</span>}
                        </span>,
                      ],
                      ['Validité réelle', <ValidityBadge key="v" validity={c.validity} expiryOn={rev.expiryOn} compact />],
                      ['Révision', `n° ${rev.revisionNo}`],
                      ['Approuvée', `${fmtDateTime(rev.approvedAt)} par ${rev.approvedBy?.displayName ?? '—'}`],
                      ['Titulaire', `${SUBJECT_KIND_LABELS[c.subjectKind]} — ${c.subject.label}`],
                    ]}
                  />
                  {rev.remarks && <p className="mt-4 whitespace-pre-line border-t border-line pt-3 text-sm text-ink-muted">{rev.remarks}</p>}
                  {rev.expiryKind === 'UNKNOWN' && (
                    <p className="mt-3 text-xs text-ink-muted">Date d’expiration inconnue : aucune alerte d’échéance n’est émise, seulement un rappel de complétion.</p>
                  )}
                </>
              ) : (
                <EmptyState
                  title="Aucune révision approuvée"
                  description="Le certificat devient officiel à l’approbation de sa demande de création."
                  action={
                    openData ? (
                      <Button size="sm" variant="secondary" onClick={() => setTab('requests')}>
                        Voir la demande de création
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </Panel>

            <Panel
              title="Document officiel"
              actions={
                p.canAddAttachment && (
                  <Button size="sm" variant="secondary" onClick={() => setAttachOpen(true)}>
                    <FilePlus2 className="h-4 w-4" aria-hidden /> {rev?.officialAttachment ? 'Remplacer' : 'Ajouter'}
                  </Button>
                )
              }
            >
              {rev?.officialAttachment ? (
                p.canPreviewCurrent ? (
                  <InlineCertificatePreview certificateId={c.id} title={`${c.type.name} — ${c.subject.label}`} canDownload={p.canDownloadCurrent} />
                ) : (
                  <AttachmentLine certificateId={c.id} a={rev.officialAttachment} />
                )
              ) : rev ? (
                <div className="space-y-2">
                  {c.documentRequired ? <MissingDocumentBadge /> : <p className="text-sm text-ink-muted">Aucun document (facultatif pour ce type).</p>}
                  <p className="text-sm text-ink-muted">
                    {openAttachment
                      ? 'Une pièce est en attente de validation : elle ne deviendra officielle qu’après approbation par une autre personne.'
                      : 'Aucune pièce officielle pour la révision courante.'}
                  </p>
                  {openAttachment && (
                    <Button size="sm" variant="ghost" onClick={() => setTab('requests')}>
                      Voir la pièce en attente
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-ink-muted">La pièce jointe à la demande de création deviendra officielle avec son approbation.</p>
              )}
            </Panel>
          </div>

          <div className="space-y-5">
            <Panel title="Suivi du renouvellement">
              <RenewalPanel certificate={c} onChanged={reload} />
            </Panel>
            <Panel title="Type et règles">
              <DefinitionGrid
                items={[
                  ['Catégorie', c.type.category],
                  ['Document officiel', c.type.requiresDocument ? 'Requis' : 'Facultatif'],
                  ['Validité usuelle', c.type.defaultValidityMonths ? `${c.type.defaultValidityMonths} mois` : '—'],
                  ['Plusieurs certificats actifs', c.type.allowMultiple ? 'Autorisé' : 'Non'],
                  [
                    'Politique de rappel',
                    c.type.reminderPolicy
                      ? `${c.type.reminderPolicy.name} — seuils ${c.type.reminderPolicy.thresholdsDays.join(' / ')} j, ${FREQUENCY_LABELS[c.type.reminderPolicy.frequency].toLowerCase()}`
                      : 'Aucune (pas de rappel)',
                  ],
                  ['Validateurs', c.type.validatorsConfigured ? `${c.type.validatorsConfigured} principal(aux) désigné(s)` : 'Tout validateur habilité ayant accès'],
                  ['« Expire bientôt »', `${c.expiringSoonDays} jours avant échéance`],
                  ['Créé', `${fmtDateTime(c.createdAt)} par ${c.createdBy?.displayName ?? '—'}`],
                ]}
              />
            </Panel>
          </div>
        </TabsContent>

        <TabsContent value="requests" className="space-y-4">
          {conflict && (
            <div role="alert" className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span className="flex-1">{conflict}</span>
              <button type="button" className="rounded p-0.5 hover:bg-white/60" aria-label="Masquer le message" onClick={() => setConflict(null)}>
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          )}
          {c.requests.length === 0 ? (
            <EmptyState title="Aucune demande" />
          ) : (
            c.requests.map((r) => (
              <RequestCard
                key={r.id}
                certificate={c}
                request={r}
                highlighted={r.id === requestParam}
                onChanged={reload}
                onConflict={onConflict}
                onEdit={(req) => setEditing(req)}
              />
            ))
          )}
        </TabsContent>

        <TabsContent value="revisions" className="space-y-4">
          <p className="text-sm text-ink-muted">
            Chaque approbation crée une révision ; la précédente est archivée intégralement avec ses pièces (aucune suppression).
          </p>
          {revisions.length === 0 ? (
            <EmptyState title="Aucune révision" description="Aucune demande n’a encore été approuvée." />
          ) : (
            revisions.map((r) => <RevisionBlock key={r.id} c={c} rev={r} current={r.id === rev?.id} />)
          )}
        </TabsContent>

        <TabsContent value="attachments">
          <Panel
            title="Pièces jointes"
            actions={
              p.canAddAttachment && (
                <Button size="sm" onClick={() => setAttachOpen(true)}>
                  <FilePlus2 className="h-4 w-4" aria-hidden /> Ajouter une pièce
                </Button>
              )
            }
          >
            {openAttachment && (
              <p className="mb-3 flex items-start gap-1.5 rounded-md bg-info-bg px-3 py-2 text-sm text-info">
                <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                Une pièce est en attente de validation ; elle n’est pas officielle tant qu’elle n’est pas approuvée.
              </p>
            )}
            {!p.canAddAttachment && !c.archivedAt && rev && !openAttachment && !can('certificates.create') && !can('certificates.edit') && (
              <p className="mb-3 text-xs text-ink-muted">L’ajout de pièce requiert le droit de créer ou modifier un certificat.</p>
            )}
            {c.attachments.length === 0 ? (
              <EmptyState title="Aucune pièce jointe" description="Le document officiel peut être ajouté à tout moment ; il sera validé par une autre personne." />
            ) : (
              <ul className="space-y-2">
                {c.attachments.map((a) => (
                  <li key={a.id} className="space-y-1">
                    <AttachmentLine certificateId={c.id} a={a} />
                    <p className="pl-1 text-xs text-ink-muted">
                      Déposée le {fmtDateTime(a.uploadedAt)} par {a.uploadedBy?.displayName ?? '—'}
                      {a.revisionNo ? ` — révision n° ${a.revisionNo}` : ''}
                      {a.approvedAt ? ` — approuvée le ${fmtDateTime(a.approvedAt)} par ${a.approvedBy?.displayName ?? '—'}` : ''}
                      {a.archivedAt ? ` — archivée le ${fmtDateTime(a.archivedAt)}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </TabsContent>

        <TabsContent value="history" className="grid items-start gap-5 xl:grid-cols-2">
          {can('audit.view.certificates') ? (
            <>
              <Panel title="Journal du certificat">
                <AuditTimeline entityType="certificate" entityId={c.id} module="certificates" />
              </Panel>
              <Panel title="Journal des demandes">
                {c.requests.length === 0 ? (
                  <p className="text-sm text-ink-muted">Aucune demande.</p>
                ) : (
                  <ul className="space-y-2">
                    {c.requests.map((r) => (
                      <RequestAuditItem key={r.id} r={r} />
                    ))}
                  </ul>
                )}
              </Panel>
            </>
          ) : (
            <Panel title="Historique" className="xl:col-span-2">
              <p className="text-sm text-ink-muted">
                Le journal d’audit requiert le droit « Consulter l’audit des certificats ». La chronologie de chaque demande reste visible dans l’onglet{' '}
                <button type="button" className="font-medium text-action hover:underline" onClick={() => setTab('requests')}>
                  Demandes
                </button>
                .
              </p>
            </Panel>
          )}
        </TabsContent>
      </Tabs>

      {form && (
        <CertificateFormDialog
          mode={form}
          certificate={c}
          open={!!form}
          onOpenChange={(o) => !o && setForm(null)}
          onDone={async () => {
            await reload();
            setTab('requests');
          }}
        />
      )}
      {editing && (
        <CertificateFormDialog
          mode="edit"
          certificate={c}
          request={c.requests.find((r) => r.id === editing.id) ?? editing}
          open={!!editing}
          onOpenChange={(o) => !o && setEditing(null)}
          onDone={reload}
        />
      )}
      {attachOpen && <AttachmentDialog certificate={c} open={attachOpen} onOpenChange={setAttachOpen} onDone={reload} />}
      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title="Archiver le certificat"
        description="Le certificat et toutes ses révisions sont conservés en archive (aucune suppression) ; il ne génère plus de rappels. Les demandes en cours doivent d’abord être annulées ou décidées."
        confirmLabel="Archiver"
        tone="danger"
        requireReason
        reasonLabel="Motif d’archivage"
        onConfirm={async (reason) => {
          await api.post(`/certificates/${c.id}/archive`, { reason });
          toast.success('Certificat archivé');
          await reload();
        }}
      />
      <ConfirmDialog
        open={!!supervisoryCancel}
        onOpenChange={(o) => !o && setSupervisoryCancel(null)}
        title="Annuler la demande d’un autre utilisateur"
        description="Annulation de supervision : le motif est obligatoire, journalisé, et le demandeur est notifié."
        confirmLabel="Annuler la demande"
        tone="danger"
        requireReason
        reasonLabel="Motif d’annulation"
        onConfirm={async (reason) => {
          await api.post(`/certificate-requests/${supervisoryCancel}/cancel`, { reason });
          toast.success('Demande annulée');
          await reload();
        }}
      />
    </>
  );
}
