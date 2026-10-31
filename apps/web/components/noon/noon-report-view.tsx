'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ClipboardCheck, History, Lock, PencilLine, RefreshCw, RotateCcw, Send, Ship, Trash2, Undo2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { PageHeader, Panel } from '@/components/ui/page';
import { FormError, Notice, TextAreaField } from '@/components/voyages/common';
import { NoonStatusBadge } from '@/components/voyages/status';
import { FIELD_DEFS, NOON_SECTIONS, REPORT_TYPE_LABELS, displayValue, localLabel, noonKeys, submissionIssues } from './lib';
import { OpsActions } from './noon-actions';
import { NoonForm, NoonSummary, SaveIndicator, focusNoonField, useSectionState } from './noon-form';
import { AttachmentsPanel, NoonPdfButton, RevisionsPanel } from './noon-panels';
import type { NoonIssue, NoonReportDetail } from './types';
import { useNoonDraft } from './use-noon-draft';

function IssueList({ issues, onGo }: { issues: NoonIssue[]; onGo: (field: string) => void }) {
  if (!issues.length) return null;
  return (
    <ul className="space-y-1">
      {issues.map((is, i) => {
        const def = FIELD_DEFS[is.path];
        const section = NOON_SECTIONS.find((s) => s.fields.some((f) => f.key === is.path));
        return (
          <li key={`${is.path}-${i}`} className="flex items-start gap-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 flex-1">
              {is.message}
              {section && <span className="block text-xs text-ink-muted">Section {section.index} — {def?.label ?? is.path}</span>}
            </span>
            {def && (
              <Button size="sm" variant="ghost" onClick={() => onGo(is.path)}>
                Aller au champ
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function issuesFromError(e: unknown): NoonIssue[] {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return [];
  return (e.details as { path?: string; message?: string }[])
    .filter((d) => d?.message)
    .map((d) => ({ path: d.path ?? '', message: d.message! }));
}

/**
 * Noon Report : formulaire AMC en 7 sections repliables, autosave sécurisé (DRAFT / correction
 * demandée), soumission figée (révision + PDF), correction tracée en nouvelle révision, revue Ops.
 */
export function NoonReportView({ report, refetch }: { report: NoonReportDetail; refetch: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const { can } = useSession();
  // Audit FLT-12 : sans voyages.view, le voyage est cité sans lien (évite « Accès refusé »)
  const canVoyages = can('voyages.view');
  const warnings = report.submissionWarnings ?? [];
  const canDiscard = report.permissions.discard ?? (report.status === 'DRAFT' && report.currentRevisionNo === 0 && report.permissions.edit);
  const [correcting, setCorrecting] = useState(false);
  const canCorrectSubmitted = report.permissions.correct && report.status !== 'CORRECTION_REQUESTED';
  const mode = report.permissions.edit ? 'autosave' : correcting && canCorrectSubmitted ? 'local' : 'readonly';
  const draft = useNoonDraft(report, mode, (res) => {
    qc.setQueryData<NoonReportDetail>(noonKeys.detail(report.id), (old) => (old ? { ...old, ...res, submissionCheck: old.submissionCheck } : old));
  });
  const sections = useSectionState(
    Object.fromEntries(NOON_SECTIONS.map((s) => [s.key, mode === 'readonly' ? true : ['general', 'positionWeather', 'navigation', 'engineFuel'].includes(s.key)])),
  );
  const [showMissing, setShowMissing] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const router = useRouter();
  const [correctOpen, setCorrectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<unknown>(null);
  const [serverIssues, setServerIssues] = useState<NoonIssue[]>([]);

  const clientIssues = useMemo(() => (mode === 'readonly' ? [] : submissionIssues(draft.values)), [draft.values, mode]);
  const refreshAll = async () => {
    await Promise.all([
      refetch(),
      qc.invalidateQueries({ queryKey: noonKeys.list }),
      qc.invalidateQueries({ queryKey: ['voyage', report.voyageId] }),
      qc.invalidateQueries({ queryKey: noonKeys.revisions(report.id) }),
    ]);
  };
  const goTo = (field: string) => {
    setSubmitOpen(false);
    setCorrectOpen(false);
    setShowMissing(true);
    focusNoonField(field, sections.openOne);
  };

  // --- Soumission (DRAFT)
  async function openSubmit() {
    setDialogError(null);
    setServerIssues([]);
    await draft.flush();
    setSubmitOpen(true);
  }
  async function submit() {
    setBusy(true);
    setDialogError(null);
    setServerIssues([]);
    try {
      const v = await draft.flush();
      const res = await api.post<NoonReportDetail & { revision: { revisionNo: number } }>(`/noon-reports/${report.id}/submit`, { expectedVersion: v ?? draft.version });
      toast.success(`Noon Report soumis — révision ${res.revision.revisionNo} figée, PDF généré, Ops notifiés`);
      setSubmitOpen(false);
      setShowMissing(false);
      await refreshAll();
    } catch (e) {
      setDialogError(e);
      setServerIssues(issuesFromError(e));
      setShowMissing(true);
    } finally {
      setBusy(false);
    }
  }

  // --- Correction (nouvelle révision)
  async function openCorrect() {
    setDialogError(null);
    setServerIssues([]);
    setReason('');
    if (mode === 'autosave') await draft.flush();
    setCorrectOpen(true);
  }
  async function correct() {
    setBusy(true);
    setDialogError(null);
    setServerIssues([]);
    try {
      let expectedVersion = draft.version;
      let changes: Record<string, unknown> | undefined;
      if (mode === 'autosave') {
        const v = await draft.flush();
        if (v === null) throw new Error('Des saisies ne sont pas enregistrées (champs invalides ou conflit) : corrigez-les avant de soumettre la correction.');
        expectedVersion = v;
      } else {
        changes = draft.changes();
      }
      const res = await api.post<{ revision: { revisionNo: number }; changes: unknown[] }>(`/noon-reports/${report.id}/correct`, {
        expectedVersion,
        reason: reason.trim(),
        ...(changes ? { changes } : {}),
      });
      toast.success(`Correction enregistrée — révision ${res.revision.revisionNo} (${res.changes.length} champ(s) modifié(s)), PDF généré`);
      setCorrectOpen(false);
      setCorrecting(false);
      await refreshAll();
    } catch (e) {
      setDialogError(e);
      setServerIssues(issuesFromError(e));
    } finally {
      setBusy(false);
    }
  }

  const readOnlyValues = report as unknown as Record<string, string | number | null>;
  const localChanges = mode === 'local' ? Object.keys(draft.changes()) : [];
  const general = (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="inline-flex items-center gap-1">
        <Ship className="h-4 w-4 text-teal-700" aria-hidden />
        <Link href={`/vessels/${report.vessel.id}`} className="font-medium text-action hover:underline">
          {report.vessel.name}
        </Link>
        {report.vessel.imoNumber && <span className="text-ink-muted"> · IMO {report.vessel.imoNumber}</span>}
      </span>
      <span>
        Voyage{' '}
        {canVoyages ? (
          <Link href={`/voyages/${report.voyage.id}?tab=noon`} className="ref font-medium text-action hover:underline">
            {report.voyage.reference}
          </Link>
        ) : (
          <span className="ref font-medium">{report.voyage.reference}</span>
        )}
      </span>
      <span className="tabular text-ink-muted">Heure locale : {mode === 'readonly' ? report.reportDateLocal : localLabel(draft.apiValues.reportDateUtc as string | null, Number(draft.values.utcOffsetMinutes || 0))}</span>
    </span>
  );

  return (
    <>
      <PageHeader
        breadcrumb={[
          { label: 'Noon Reports', href: '/noon-reports' },
          { label: report.voyage.reference, href: canVoyages ? `/voyages/${report.voyage.id}?tab=noon` : undefined },
          { label: `${REPORT_TYPE_LABELS[report.reportType]} ${report.reportDateUtc.slice(0, 10)}` },
        ]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>
              {REPORT_TYPE_LABELS[report.reportType]} Report — <span className="tabular">{report.reportDateUtc.slice(0, 16).replace('T', ' ')} UTC</span>
            </span>
            <NoonStatusBadge status={report.status} />
            {report.currentRevisionNo > 0 && (
              <Badge tone="navy" icon={<History className="h-3.5 w-3.5" aria-hidden />}>
                Révision {report.currentRevisionNo}
              </Badge>
            )}
          </span>
        }
        description={`${report.vessel.name} — ${report.reportDateLocal}`}
        actions={
          <>
            {report.permissions.export && report.currentRevisionNo > 0 && <NoonPdfButton reportId={report.id} revisionNo={report.currentRevisionNo} label="Aperçu PDF" size="md" />}
            {report.status === 'DRAFT' && report.currentRevisionNo === 0 && canDiscard && (
              <Button variant="ghost" onClick={() => setDiscardOpen(true)}>
                <Trash2 className="h-4 w-4" aria-hidden /> Supprimer le brouillon
              </Button>
            )}
            {report.status === 'DRAFT' && report.permissions.submit && (
              <Button onClick={openSubmit}>
                <ClipboardCheck className="h-4 w-4" aria-hidden /> Vérifier et soumettre
              </Button>
            )}
            {report.status === 'CORRECTION_REQUESTED' && report.permissions.correct && (
              <Button onClick={openCorrect}>
                <Send className="h-4 w-4" aria-hidden /> Soumettre la correction
              </Button>
            )}
            {canCorrectSubmitted && !correcting && (
              <Button variant="secondary" onClick={() => setCorrecting(true)}>
                <PencilLine className="h-4 w-4" aria-hidden /> Corriger (nouvelle révision)
              </Button>
            )}
            {correcting && (
              <>
                <Button variant="ghost" onClick={() => setCorrecting(false)}>
                  <Undo2 className="h-4 w-4" aria-hidden /> Abandonner
                </Button>
                <Button onClick={openCorrect} disabled={localChanges.length === 0}>
                  <Send className="h-4 w-4" aria-hidden /> Soumettre la correction ({localChanges.length})
                </Button>
              </>
            )}
            <OpsActions report={report} />
          </>
        }
      />

      <div className="mb-4 space-y-2">
        {report.status === 'CORRECTION_REQUESTED' && (
          <Notice tone="warn" title="Correction demandée par les opérations">
            <p className="whitespace-pre-wrap">{report.correctionRequest ?? '—'}</p>
            <p className="mt-1 text-xs text-ink-muted">
              {report.permissions.edit
                ? 'Modifiez les valeurs (enregistrement automatique) puis « Soumettre la correction » avec un motif : une nouvelle révision et son PDF seront créés, la révision d’origine reste intacte.'
                : `En attente de la correction par le bord. La révision ${report.currentRevisionNo} reste consultable et intacte.`}
            </p>
          </Notice>
        )}
        {report.status === 'DRAFT' && report.voyageOpen === false && (
          <Notice tone="warn" title="Voyage clôturé ou annulé">
            Ce brouillon ne peut plus être modifié ni soumis. {canDiscard ? 'Supprimez-le s’il n’a plus d’utilité.' : 'Seul son auteur ou un correcteur habilité peut le supprimer.'}
          </Notice>
        )}
        {report.status === 'DRAFT' && !report.permissions.submit && report.permissions.edit && (
          <Notice title="Saisie déléguée">La soumission est réservée au Master (permission noon.submit). Vos saisies sont enregistrées automatiquement.</Notice>
        )}
        {mode === 'readonly' && report.currentRevisionNo > 0 && report.status !== 'CORRECTION_REQUESTED' && (
          <Notice title={`Rapport figé — révision ${report.currentRevisionNo}`}>
            Les valeurs soumises sont immuables. Toute modification passe par une correction tracée (nouvelle révision, ancienne conservée).
          </Notice>
        )}
        {mode === 'local' && (
          <Notice tone="warn" title="Mode correction">
            Vos modifications ne sont pas enregistrées tant que la correction n’est pas soumise avec un motif. Champs modifiés : {localChanges.length}.
          </Notice>
        )}
        {draft.status === 'conflict' && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
            <AlertTriangle className="h-4 w-4" aria-hidden />
            <span className="min-w-0 flex-1 font-medium">Ce rapport a été modifié ailleurs (autre poste ou utilisateur). L’enregistrement automatique est suspendu.</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={async () => {
                const r = await qc.fetchQuery({ queryKey: noonKeys.detail(report.id), queryFn: () => api.get<NoonReportDetail>(`/noon-reports/${report.id}`), staleTime: 0 });
                draft.resetFrom(r);
              }}
            >
              <RefreshCw className="h-4 w-4" aria-hidden /> Recharger la version serveur
            </Button>
            <Button
              size="sm"
              onClick={async () => {
                const r = await qc.fetchQuery({ queryKey: noonKeys.detail(report.id), queryFn: () => api.get<NoonReportDetail>(`/noon-reports/${report.id}`), staleTime: 0 });
                draft.rebase(r);
                draft.retry();
              }}
            >
              <RotateCcw className="h-4 w-4" aria-hidden /> Conserver mes saisies et réessayer
            </Button>
          </div>
        )}
        {draft.status === 'locked' && (
          <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
            <Lock className="h-4 w-4" aria-hidden />
            <span className="min-w-0 flex-1 font-medium">Le statut du rapport a changé (soumis ou traité ailleurs) : il n’est plus modifiable ici.</span>
            <Button size="sm" variant="secondary" onClick={() => void refreshAll()}>
              <RefreshCw className="h-4 w-4" aria-hidden /> Recharger
            </Button>
          </div>
        )}
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0">
          {mode !== 'readonly' && (
            <div className="sticky top-14 z-20 -mx-1 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-white/95 px-3 py-2 shadow-panel backdrop-blur">
              {mode === 'autosave' ? (
                <SaveIndicator status={draft.status} lastSavedAt={draft.lastSavedAt} onRetry={draft.retry} />
              ) : (
                <span className="text-sm font-medium text-warn">Correction en cours — {localChanges.length} champ(s) modifié(s)</span>
              )}
              <span className="text-xs text-ink-muted">
                {clientIssues.length ? `${clientIssues.length} point(s) à compléter avant soumission` : 'Prêt pour la soumission'}
              </span>
            </div>
          )}
          <NoonForm
            values={draft.values}
            onChange={draft.setField}
            errors={draft.fieldErrors}
            missing={draft.missing}
            readOnly={mode === 'readonly'}
            readOnlyValues={readOnlyValues}
            open={sections.open}
            onToggle={sections.toggle}
            onToggleAll={sections.setAll}
            general={general}
            showMissing={showMissing}
          />
        </div>
        <aside className="space-y-4" aria-label="Suivi du rapport">
          <Panel title="Cycle du rapport">
            <ol className="space-y-2 text-sm">
              {[
                { label: 'Brouillon créé', at: report.createdAt, by: report.createdBy, done: true },
                { label: 'Soumis (révision figée)', at: report.submittedAt, by: report.submittedBy, done: !!report.submittedAt },
                { label: 'Accusé de réception Ops', at: report.acknowledgedAt, by: report.acknowledgedBy, done: !!report.acknowledgedAt },
              ].map((s) => (
                <li key={s.label} className="flex items-start gap-2">
                  {s.done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden /> : <span className="mt-1 h-3 w-3 shrink-0 rounded-full border-2 border-line-strong" aria-hidden />}
                  <span>
                    <span className={s.done ? 'font-medium text-ink' : 'text-ink-muted'}>{s.label}</span>
                    {s.done && s.at && (
                      <span className="block text-xs text-ink-muted">
                        {fmtDateTime(s.at)}
                        {s.by ? ` — ${s.by}` : ''}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </Panel>
          {mode !== 'readonly' && (
            <Panel title="Contrôle avant soumission">
              {clientIssues.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-ok">
                  <CheckCircle2 className="h-4 w-4" aria-hidden /> Champs minimaux renseignés, valeurs dans les plages.
                </p>
              ) : (
                <IssueList issues={clientIssues} onGo={goTo} />
              )}
              {warnings.length > 0 && (
                <div className="mt-3 border-t border-line pt-2">
                  <p className="mb-1 text-xs font-medium text-ink-muted">À vérifier (non bloquant)</p>
                  <IssueList issues={warnings} onGo={goTo} />
                </div>
              )}
              <p className="mt-2 text-xs text-ink-muted">Pré-contrôle indicatif : la validation définitive est faite par le serveur à la soumission.</p>
            </Panel>
          )}
          <RevisionsPanel report={report} />
          <AttachmentsPanel report={report} />
        </aside>
      </div>

      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="Supprimer ce brouillon ?"
        description="Le brouillon n'a jamais été soumis : il sera supprimé (action journalisée). Un rapport soumis ne peut être qu'archivé."
        confirmLabel="Supprimer le brouillon"
        tone="danger"
        onConfirm={async () => {
          await api.delete(`/noon-reports/${report.id}`);
          toast.success('Brouillon supprimé');
          await qc.invalidateQueries({ queryKey: noonKeys.list });
          qc.removeQueries({ queryKey: noonKeys.detail(report.id) });
          router.push(canVoyages ? `/voyages/${report.voyage.id}?tab=noon` : '/noon-reports');
        }}
      />

      {/* Vérification et soumission */}
      <Dialog
        open={submitOpen}
        onOpenChange={setSubmitOpen}
        size="lg"
        title="Vérifier et soumettre le Noon Report"
        description="Après soumission, les valeurs sont figées en révision 1 avec un PDF ; les opérations à terre sont notifiées."
        footer={
          <>
            <Button variant="secondary" onClick={() => setSubmitOpen(false)}>
              Continuer la saisie
            </Button>
            <Button onClick={submit} loading={busy} disabled={draft.status === 'conflict' || draft.status === 'locked'}>
              <Send className="h-4 w-4" aria-hidden /> Soumettre
            </Button>
          </>
        }
      >
        {serverIssues.length > 0 ? (
          <div className="mb-4 rounded-md border border-danger-line bg-danger-bg px-3 py-2">
            <p className="mb-2 text-sm font-medium text-danger">{dialogError instanceof Error ? dialogError.message : 'Soumission refusée'}</p>
            <IssueList issues={serverIssues} onGo={goTo} />
          </div>
        ) : (
          <FormError error={dialogError} onReload={() => void refreshAll()} />
        )}
        {serverIssues.length === 0 && clientIssues.length > 0 && (
          <div className="mb-4 rounded-md border border-warn-line bg-warn-bg px-3 py-2">
            <p className="mb-2 text-sm font-medium text-warn">Pré-contrôle : {clientIssues.length} point(s) à compléter</p>
            <IssueList issues={clientIssues} onGo={goTo} />
          </div>
        )}
        {serverIssues.length === 0 && warnings.length > 0 && (
          <div className="mb-4 rounded-md border border-line bg-surface-sunken px-3 py-2">
            <p className="mb-2 text-sm font-medium text-ink">À vérifier avant soumission (non bloquant)</p>
            <IssueList issues={warnings} onGo={goTo} />
          </div>
        )}
        {draft.status === 'invalid' && (
          <Notice tone="warn" className="mb-4">
            Certains champs invalides n’ont pas été enregistrés : la soumission porte sur les dernières valeurs enregistrées.
          </Notice>
        )}
        <NoonSummary values={draft.apiValues} />
      </Dialog>

      {/* Correction */}
      <Dialog
        open={correctOpen}
        onOpenChange={setCorrectOpen}
        size="lg"
        title={`Soumettre la correction — révision ${report.currentRevisionNo + 1}`}
        description="La révision précédente reste intacte ; le diff ancien / nouveau est conservé dans l’historique et l’audit."
        footer={
          <>
            <Button variant="secondary" onClick={() => setCorrectOpen(false)}>
              Annuler
            </Button>
            <Button onClick={correct} loading={busy} disabled={reason.trim().length < 3}>
              <Send className="h-4 w-4" aria-hidden /> Créer la révision {report.currentRevisionNo + 1}
            </Button>
          </>
        }
      >
        {serverIssues.length > 0 ? (
          <div className="mb-4 rounded-md border border-danger-line bg-danger-bg px-3 py-2">
            <p className="mb-2 text-sm font-medium text-danger">{dialogError instanceof Error ? dialogError.message : 'Correction refusée'}</p>
            <IssueList issues={serverIssues} onGo={goTo} />
          </div>
        ) : (
          <FormError error={dialogError} onReload={() => void refreshAll()} />
        )}
        {clientIssues.length > 0 && serverIssues.length === 0 && (
          <div className="mb-4 rounded-md border border-warn-line bg-warn-bg px-3 py-2">
            <p className="mb-2 text-sm font-medium text-warn">Pré-contrôle : {clientIssues.length} point(s) bloquant(s) probables</p>
            <IssueList issues={clientIssues} onGo={goTo} />
          </div>
        )}
        {mode === 'local' && (
          <div className="mb-4 overflow-x-auto rounded-md border border-line">
            <table className="table-amc">
              <caption className="sr-only">Modifications proposées</caption>
              <thead>
                <tr>
                  <th scope="col">Champ</th>
                  <th scope="col">Révision {report.currentRevisionNo}</th>
                  <th scope="col">Nouvelle valeur</th>
                </tr>
              </thead>
              <tbody>
                {localChanges.map((k) => (
                  <tr key={k}>
                    <td className="font-medium">{FIELD_DEFS[k]?.label ?? k}</td>
                    <td className="tabular text-ink-muted">{displayValue(k, readOnlyValues[k])}</td>
                    <td className="tabular font-medium">{displayValue(k, draft.apiValues[k])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {mode === 'autosave' && (
          <p className="mb-3 text-sm text-ink-muted">Les valeurs enregistrées du formulaire seront figées dans la nouvelle révision (seuls les champs réellement modifiés apparaissent dans le diff).</p>
        )}
        <TextAreaField label="Motif de la correction" required value={reason} onChange={setReason} rows={3} maxLength={1000} hint="Obligatoire — repris dans la révision, le PDF et l’audit." />
      </Dialog>
    </>
  );
}
