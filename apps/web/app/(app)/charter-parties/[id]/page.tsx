'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, Check, ChevronDown, ChevronRight, Eye, FilePlus2, Lock, Pencil, ShieldAlert, Undo2, Users, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { DownloadButton, FilePreviewDialog } from '@/components/amc/file-preview';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { DefinitionGrid, PageHeader, Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { FormError, Notice, StoredText, TextAreaField } from '@/components/voyages/common';
import { CpFormDialog } from '@/components/voyages/cp-form';
import { CpVersionDialog } from '@/components/voyages/cp-version-dialog';
import { CP_CLAUSE_FIELDS, CP_CONTRACT_FIELDS, type AcknowledgementList, type CpDetail, type CpVersionRow } from '@/components/voyages/types';
import { CP_FIELD_LABELS, CP_TYPE_LABELS, CP_VERSION_KIND_LABELS, cpKeys, fmtLaycan, notifyError } from '@/components/voyages/lib';
import { CpStatusBadge, CpVersionStatusBadge, VoyageStatusBadge } from '@/components/voyages/status';

function clauseValue(field: string, v: string | null | undefined): string {
  if (!v) return '—';
  if (field === 'cpType') return CP_TYPE_LABELS[v] ?? v;
  if (field === 'cpDate' || field === 'laycanFrom' || field === 'laycanTo') return fmtDate(v);
  return v;
}

/** Accusés de lecture des Masters pour la version en vigueur. */
function Acknowledgements({ cpId, version }: { cpId: string; version: CpVersionRow }) {
  const q = useQuery({
    queryKey: [...cpKeys.detail(cpId), 'acks', version.id, version.acknowledgementCount],
    queryFn: () => api.get<AcknowledgementList>(`/charter-parties/${cpId}/versions/${version.id}/acknowledgements`),
  });
  if (q.isLoading) return <LoadingBlock rows={1} />;
  if (q.error) return <ErrorState error={q.error} />;
  const d = q.data!;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {d.acknowledgements.map((a) => (
        <li key={a.userId}>
          <Badge tone="ok">
            {a.displayName ?? a.userId} — lu le {fmtDateTime(a.acknowledgedAt ?? a.ackAt)}
          </Badge>
        </li>
      ))}
      {d.pendingMasters.map((m) => (
        <li key={m.userId}>
          <Badge tone="warn">{m.displayName ?? m.userId} — lecture attendue</Badge>
        </li>
      ))}
      {!d.acknowledgements.length && !d.pendingMasters.length && <li className="text-sm text-ink-muted">Aucun Master attendu ni accusé enregistré.</li>}
    </ul>
  );
}

/** Clauses modifiées par une version par rapport à la précédente (diff texte, aucune interprétation). */
function VersionClauses({ version, previous }: { version: CpVersionRow; previous: CpVersionRow | null }) {
  const cur = version.clauses ?? {};
  const prev = previous?.clauses ?? null;
  const fields = CP_CONTRACT_FIELDS.filter((f) => (prev ? (prev[f] ?? null) !== (cur[f] ?? null) : !!cur[f]));
  if (!fields.length) return <p className="text-sm text-ink-muted">Aucune clause modifiée par rapport à la version précédente.</p>;
  return (
    <dl className="space-y-2">
      {fields.map((f) => (
        <div key={f} className="rounded-md border border-line bg-white px-3 py-2">
          <dt className="text-xs font-medium text-ink-muted">{CP_FIELD_LABELS[f] ?? f}</dt>
          {prev && (
            <dd className="mt-1 whitespace-pre-wrap text-sm text-danger line-through decoration-danger/40">
              <span className="sr-only">Avant : </span>
              {clauseValue(f, prev[f])}
            </dd>
          )}
          <dd className="mt-1 whitespace-pre-wrap text-sm text-ink">
            {prev && <span className="sr-only">Après : </span>}
            {clauseValue(f, cur[f])}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function CharterPartyDetail() {
  const { id } = useParams<{ id: string }>();
  const sp = useSearchParams();
  const router = useRouter();
  const { can, me } = useSession();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: cpKeys.detail(id), queryFn: () => api.get<CpDetail>(`/charter-parties/${id}`), enabled: can('charter_party.view') });
  const [versionOpen, setVersionOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [preview, setPreview] = useState<CpVersionRow | null>(null);
  const [decision, setDecision] = useState<{ v: CpVersionRow; action: 'approve' | 'reject' } | null>(null);
  const [comment, setComment] = useState('');
  const [decisionError, setDecisionError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [withdraw, setWithdraw] = useState<CpVersionRow | null>(null);

  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: cpKeys.detail(id) }), qc.invalidateQueries({ queryKey: cpKeys.list })]);

  // ?action=version (depuis le workspace voyage) : ouvre directement le dépôt d'une version
  useEffect(() => {
    if (sp.get('action') === 'version' && q.data?.permissions.manage && q.data.status !== 'CANCELLED') {
      setVersionOpen(true);
      router.replace(`/charter-parties/${id}`, { scroll: false });
    }
  }, [sp, q.data, id, router]);

  if (!can('charter_party.view')) return <Forbidden message="Les Charter Parties sont confidentielles : permission charter_party.view requise." />;
  if (q.isLoading) return <LoadingBlock rows={10} />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const cp = q.data;
  const canDownload = cp.permissions.manage || cp.permissions.approve;
  const cancelled = cp.status === 'CANCELLED';
  const clauses = CP_CLAUSE_FIELDS.filter((f) => !!cp[f]);
  const sorted = [...cp.versions].sort((a, b) => b.versionNo - a.versionNo);

  async function decide() {
    if (!decision) return;
    setBusy(true);
    setDecisionError(null);
    try {
      await api.post(`/charter-parties/${id}/versions/${decision.v.id}/${decision.action}`, { comment: comment.trim() || undefined });
      toast.success(decision.action === 'approve' ? `Version v${decision.v.versionNo} approuvée — elle devient opposable` : `Version v${decision.v.versionNo} refusée`);
      setDecision(null);
      await refresh();
    } catch (e) {
      setDecisionError(e);
    } finally {
      setBusy(false);
    }
  }

  const ack = async (v: CpVersionRow) => {
    try {
      await api.post(`/charter-parties/${id}/versions/${v.id}/acknowledge`);
      toast.success('Accusé de lecture enregistré');
      await refresh();
    } catch (e) {
      notifyError(e, () => void refresh());
    }
  };

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Charter Parties', href: '/charter-parties' }, { label: cp.reference }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span className="ref">{cp.reference}</span>
            <CpStatusBadge status={cp.status} />
            <Badge tone="navy" icon={<Lock className="h-3.5 w-3.5" aria-hidden />}>
              Confidentiel
            </Badge>
          </span>
        }
        description={`${CP_TYPE_LABELS[cp.cpType] ?? cp.cpType}${cp.vessel ? ` — ${cp.vessel.name}` : ''}`}
        actions={
          <>
            {cp.permissions.editDraft && !cp.versions.length && (
              <Button variant="secondary" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" aria-hidden /> Modifier le brouillon
              </Button>
            )}
            {cp.permissions.manage && !cancelled && (
              <Button onClick={() => setVersionOpen(true)} disabled={!!cp.pendingVersion}>
                <FilePlus2 className="h-4 w-4" aria-hidden /> {cp.versions.some((v) => v.status === 'APPROVED') ? 'Avenant / révision' : 'Soumettre la version officielle'}
              </Button>
            )}
            {cp.permissions.manage && !cancelled && (
              <Button variant="ghost" onClick={() => setCancelOpen(true)}>
                <XCircle className="h-4 w-4" aria-hidden /> Annuler la CP
              </Button>
            )}
          </>
        }
      />

      {cp.pendingVersion && (
        <Notice tone="warn" className="mb-4" title={`Version v${cp.pendingVersion.versionNo} (${CP_VERSION_KIND_LABELS[cp.pendingVersion.kind]}) en attente d’approbation`}>
          {cp.opposableVersion
            ? `La version v${cp.opposableVersion.versionNo} reste opposable jusqu’à la décision.`
            : 'Aucune version n’est encore opposable.'}{' '}
          Soumise par {cp.pendingVersion.submittedBy ?? '—'} le {fmtDateTime(cp.pendingVersion.submittedAt)}.
        </Notice>
      )}

      <div className="grid gap-5 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-5">
          <Panel title="Parties, dates et ports">
            <DefinitionGrid
              columns={3}
              items={[
                ['Type', CP_TYPE_LABELS[cp.cpType] ?? cp.cpType],
                ['Date de la CP', fmtDate(cp.cpDate)],
                ['Navire', cp.vessel ? <Link key="v" href={`/vessels/${cp.vessel.id}`} className="text-action hover:underline">{cp.vessel.name}</Link> : '—'],
                ['Charterer', cp.charterer ?? '—'],
                ['Owner', cp.owner ?? '—'],
                ['Broker', cp.broker ?? '—'],
                ['Signataires', cp.signatories ?? '—'],
                ['Laycan', <span key="l" className="tabular">{fmtLaycan(cp.laycanFrom, cp.laycanTo, fmtDate)}</span>],
                ['Version en vigueur', cp.opposableVersion ? `v${cp.opposableVersion.versionNo} — ${CP_VERSION_KIND_LABELS[cp.opposableVersion.kind]}` : 'Aucune'],
                ['Load port(s)', cp.loadPorts ?? '—'],
                ['Discharge port(s)', cp.dischargePorts ?? '—'],
              ]}
            />
            {cp.cargoDescription && (
              <div className="mt-4 border-t border-line pt-3">
                <p className="mb-1 text-xs text-ink-muted">Cargaison</p>
                <StoredText>{cp.cargoDescription}</StoredText>
              </div>
            )}
          </Panel>

          <Panel title="Clauses (texte contractuel)">
            <Notice className="mb-3">
              Clauses reproduites telles que stockées. Aucune règle de laytime ni valeur financière n’est déduite ou calculée par la plateforme.
            </Notice>
            {clauses.length === 0 ? (
              <p className="text-sm text-ink-muted">Aucune clause NOR / laytime / freight / demurrage renseignée.</p>
            ) : (
              <dl className="space-y-3">
                {clauses.map((f) => (
                  <div key={f} className="rounded-md border border-line px-3 py-2">
                    <dt className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{CP_FIELD_LABELS[f]}</dt>
                    <dd className="mt-1">
                      <StoredText>{cp[f]}</StoredText>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Panel>

          <Panel title="Versions" bodyClassName="p-0">
            {sorted.length === 0 ? (
              <EmptyState title="Aucune version soumise" description="Soumettez la version officielle (ORIGINAL) avec le PDF signé : elle devra être approuvée par un autre utilisateur." />
            ) : (
              <ol className="divide-y divide-line">
                {sorted.map((v) => {
                  const previous = cp.versions.filter((x) => x.versionNo < v.versionNo).sort((a, b) => b.versionNo - a.versionNo)[0] ?? null;
                  const open = expanded === v.id;
                  const mine = v.submittedById === me.id;
                  const pending = v.status === 'PENDING_APPROVAL';
                  return (
                    <li key={v.id} className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="flex items-center gap-2 text-left" aria-expanded={open} onClick={() => setExpanded(open ? null : v.id)}>
                          {open ? <ChevronDown className="h-4 w-4 text-ink-muted" aria-hidden /> : <ChevronRight className="h-4 w-4 text-ink-muted" aria-hidden />}
                          <span className="rounded bg-navy-50 px-1.5 py-0.5 text-xs font-semibold tabular text-navy">v{v.versionNo}</span>
                          <span className="font-medium text-navy">{CP_VERSION_KIND_LABELS[v.kind]}</span>
                        </button>
                        <CpVersionStatusBadge status={v.status} opposable={v.opposable} superseded={!!v.supersededAt} />
                        {v.opposable && (
                          <span className="text-xs text-ink-muted">
                            <Users className="mr-0.5 inline h-3.5 w-3.5" aria-hidden />
                            {v.acknowledgementCount} accusé(s)
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        Soumise par {v.submittedBy ?? '—'} le {fmtDateTime(v.submittedAt)}
                        {v.decidedAt && ` · ${v.status === 'CANCELLED' ? 'retirée' : v.status === 'REJECTED' ? 'refusée' : 'décidée'} par ${v.decidedBy ?? '—'} le ${fmtDateTime(v.decidedAt)}`}
                      </p>
                      {v.summary && <p className="mt-1 text-sm">{v.summary}</p>}
                      {v.decisionComment && <p className="mt-1 rounded-md bg-canvas px-2 py-1 text-sm">Commentaire de décision : {v.decisionComment}</p>}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        {v.file && (
                          <Button size="sm" variant="secondary" onClick={() => setPreview(v)}>
                            <Eye className="h-4 w-4" aria-hidden /> PDF
                          </Button>
                        )}
                        {v.file && canDownload && <DownloadButton path={`/charter-parties/${id}/versions/${v.id}/file?mode=download`} size="sm" />}
                        {pending && cp.permissions.approve && (
                          <>
                            <Button
                              size="sm"
                              disabled={mine}
                              title={mine ? 'Auto-approbation interdite' : undefined}
                              onClick={() => {
                                setComment('');
                                setDecisionError(null);
                                setDecision({ v, action: 'approve' });
                              }}
                            >
                              <Check className="h-4 w-4" aria-hidden /> Approuver
                            </Button>
                            <Button
                              size="sm"
                              variant="danger"
                              disabled={mine}
                              onClick={() => {
                                setComment('');
                                setDecisionError(null);
                                setDecision({ v, action: 'reject' });
                              }}
                            >
                              <XCircle className="h-4 w-4" aria-hidden /> Refuser
                            </Button>
                          </>
                        )}
                        {pending && cp.permissions.manage && (
                          <Button size="sm" variant="ghost" onClick={() => setWithdraw(v)}>
                            <Undo2 className="h-4 w-4" aria-hidden /> Retirer
                          </Button>
                        )}
                        {v.opposable &&
                          (v.acknowledgedByMe ? (
                            <Badge tone="ok">Lu par vous le {fmtDateTime(v.acknowledgedByMe)}</Badge>
                          ) : (
                            can('noon.submit') && (
                              <Button size="sm" onClick={() => void ack(v)}>
                                <BookOpenCheck className="h-4 w-4" aria-hidden /> Accuser lecture
                              </Button>
                            )
                          ))}
                      </div>
                      {pending && cp.permissions.approve && mine && (
                        <p className="mt-2 flex items-center gap-1 text-xs font-medium text-warn">
                          <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> Vous avez soumis cette version : l’approbation doit être faite par un autre utilisateur habilité.
                        </p>
                      )}
                      {open && (
                        <div className="mt-3 space-y-3 rounded-md bg-canvas/60 p-3">
                          <p className="text-xs font-semibold text-ink-muted">{previous ? `Clauses modifiées par rapport à v${previous.versionNo}` : 'Clauses de la version'}</p>
                          <VersionClauses version={v} previous={previous} />
                          {v.opposable && (
                            <div>
                              <p className="mb-1 text-xs font-semibold text-ink-muted">Accusés de lecture des Masters</p>
                              <Acknowledgements cpId={id} version={v} />
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </Panel>
        </div>

        <div className="space-y-5">
          {cp.opposableVersion && (
            <Panel title="Lecture par les Masters">
              <p className="mb-2 text-sm text-ink-muted">Version en vigueur v{cp.opposableVersion.versionNo}</p>
              <Acknowledgements cpId={id} version={cp.opposableVersion} />
            </Panel>
          )}
          <Panel title="Voyages rattachés">
            {cp.voyages.length === 0 ? (
              <p className="text-sm text-ink-muted">Aucun voyage rattaché (le rattachement se fait depuis le workspace du voyage).</p>
            ) : (
              <ul className="space-y-2">
                {cp.voyages.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-2">
                    <Link href={`/voyages/${v.id}?tab=cp`} className="font-medium tabular text-action hover:underline">
                      {v.reference}
                    </Link>
                    <VoyageStatusBadge status={v.status} />
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Règles">
            <ul className="list-disc space-y-1 pl-5 text-sm text-ink-muted">
              <li>Chaque version officielle est approuvée par un autre utilisateur habilité (auto-approbation interdite).</li>
              <li>La version approuvée précédente reste opposable jusqu’à l’approbation de la suivante.</li>
              <li>Le PDF est consultable par les détenteurs de charter_party.view ; le téléchargement est réservé aux gestionnaires / approbateurs.</li>
            </ul>
          </Panel>
        </div>
      </div>

      <CpVersionDialog open={versionOpen} onOpenChange={setVersionOpen} cp={cp} />
      <CpFormDialog open={editOpen} onOpenChange={setEditOpen} cp={cp} onSaved={() => void refresh()} />
      {preview && (
        <FilePreviewDialog
          open={!!preview}
          onOpenChange={(o) => !o && setPreview(null)}
          title={`${cp.reference} — v${preview.versionNo} (${CP_VERSION_KIND_LABELS[preview.kind]})`}
          previewPath={`/charter-parties/${id}/versions/${preview.id}/file?mode=preview`}
          downloadPath={`/charter-parties/${id}/versions/${preview.id}/file?mode=download`}
          canDownload={canDownload}
          kind={preview.file?.kind}
        />
      )}
      <Dialog
        open={!!decision}
        onOpenChange={(o) => !o && setDecision(null)}
        title={decision?.action === 'approve' ? `Approuver la version v${decision?.v.versionNo}` : `Refuser la version v${decision?.v.versionNo ?? ''}`}
        description={
          decision?.action === 'approve'
            ? 'La version devient opposable ; la précédente est marquée remplacée. Les Masters sont invités à accuser lecture.'
            : 'La version en vigueur (le cas échéant) reste opposable.'
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setDecision(null)}>
              Annuler
            </Button>
            <Button
              variant={decision?.action === 'reject' ? 'danger' : 'primary'}
              onClick={decide}
              loading={busy}
              disabled={decision?.action === 'reject' && comment.trim().length < 3}
            >
              {decision?.action === 'approve' ? 'Approuver' : 'Refuser'}
            </Button>
          </>
        }
      >
        <FormError error={decisionError} onReload={() => void refresh()} />
        <TextAreaField
          label="Commentaire"
          required={decision?.action === 'reject'}
          value={comment}
          onChange={setComment}
          rows={3}
          maxLength={2000}
          hint={decision?.action === 'reject' ? 'Obligatoire — transmis au demandeur.' : 'Facultatif.'}
        />
      </Dialog>
      <ConfirmDialog
        open={!!withdraw}
        onOpenChange={(o) => !o && setWithdraw(null)}
        title={`Retirer la version v${withdraw?.versionNo ?? ''}`}
        description="La version en attente est retirée avant décision."
        confirmLabel="Retirer"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          if (!withdraw) return;
          await api.post(`/charter-parties/${id}/versions/${withdraw.id}/withdraw`, { reason });
          toast.success('Version retirée');
          await refresh();
        }}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Annuler la Charter Party ${cp.reference}`}
        description="Une CP annulée ne peut plus être rattachée ni versionnée. Les voyages rattachés devront être rattachés à la CP en vigueur."
        confirmLabel="Annuler la CP"
        tone="danger"
        requireReason
        onConfirm={async (reason) => {
          await api.post(`/charter-parties/${id}/cancel`, { reason });
          toast.success('Charter Party annulée');
          await refresh();
        }}
      />
    </>
  );
}

export default function CharterPartyPage() {
  return (
    <Suspense fallback={<LoadingBlock rows={10} />}>
      <CharterPartyDetail />
    </Suspense>
  );
}
