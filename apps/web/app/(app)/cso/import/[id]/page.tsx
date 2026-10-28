'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Copy, FileText, Loader2, Play, Save, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { cn, fmtBytes, fmtDate, fmtDateTime } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { useSession } from '@/lib/session';
import { CsoPageHeader } from '@/components/cso/cso-nav';
import { useCsoRun } from '@/components/cso/lib';
import {
  CSO_DOC_STATUS_LABELS,
  DUPLICATE_REASON_LABELS,
  IMPORT_DECISION_LABELS,
  IMPORT_PHASE_LABELS,
  IMPORT_ROW_STATUS_LABELS,
  JOB_STATUS_LABELS,
  type CsoCategory,
  type ImportDecision,
  type ImportJob,
  type ImportRow,
} from '@/components/cso/types';
import { Notice, Reference } from '@/components/cso/ui';
import { Badge, StatusBadge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, Forbidden, LoadingBlock, Skeleton } from '@/components/ui/states';

interface Draft {
  decision: ImportDecision;
  targetDocumentId?: string;
  title?: string;
  reference?: string | null;
}

const ROW_TONE: Record<string, Tone> = {
  VALID: 'ok',
  INVALID: 'danger',
  DUPLICATE_SUSPECTED: 'warn',
  APPLIED: 'ok',
  SKIPPED: 'neutral',
  FAILED: 'danger',
  PENDING: 'info',
};
const ROW_ICON: Record<string, ReactNode> = {
  DUPLICATE_SUSPECTED: <Copy className="h-3.5 w-3.5 shrink-0" aria-hidden />,
};

const PHASE_TONES: Record<string, Tone> = { UPLOADED: 'info', MAPPING: 'info', PREVIEW_READY: 'warn', COMMITTING: 'info', COMMITTED: 'ok' };

const FILTERS = ['', 'VALID', 'DUPLICATE_SUSPECTED', 'INVALID', 'APPLIED', 'SKIPPED', 'FAILED'] as const;

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: 'ok' | 'warn' | 'danger' }) {
  return (
    <div className="gauge">
      <p className="text-xs text-ink-muted">{label}</p>
      <p className={cn('text-lg font-semibold tabular', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-navy')}>{value}</p>
    </div>
  );
}

/** Comparaison élément importé / documents existants (CSO-034). */
function DuplicateComparison({ row, draft, onTarget, editable }: { row: ImportRow; draft: Draft; onTarget: (id: string) => void; editable: boolean }) {
  const n = row.normalized;
  const cands = row.duplicateCandidates ?? [];
  if (!n || !cands.length) return null;
  const choosing = draft.decision === 'SUBMIT_NEW_VERSION';
  return (
    <div className="mt-2 overflow-x-auto rounded-md border border-warn-line">
      <table className="w-full text-xs">
        <caption className="sr-only">Comparaison avec les documents existants</caption>
        <thead className="bg-warn-bg text-left">
          <tr>
            <th scope="col" className="px-2 py-1.5 font-semibold text-ink-muted">Critère</th>
            <th scope="col" className="px-2 py-1.5 font-semibold text-navy">Élément importé</th>
            {cands.map((c, i) => (
              <th key={c.documentId} scope="col" className="px-2 py-1.5 font-semibold text-navy">
                {choosing && editable ? (
                  <label className="inline-flex items-center gap-1.5">
                    <input type="radio" name={`target-${row.id}`} checked={draft.targetDocumentId === c.documentId} onChange={() => onTarget(c.documentId)} />
                    Document existant {i + 1}
                  </label>
                ) : (
                  <>Document existant {i + 1}</>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink-muted">Référence</th>
            <td className="px-2 py-1.5"><Reference value={n.reference} /></td>
            {cands.map((c) => (
              <td key={c.documentId} className={cn('px-2 py-1.5', c.reasons.includes('REFERENCE') && 'font-semibold text-warn')}>
                <Reference value={c.reference} />
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink-muted">Nom / titre</th>
            <td className="px-2 py-1.5">{n.title}<span className="block text-ink-soft">{n.fileName}</span></td>
            {cands.map((c) => (
              <td key={c.documentId} className={cn('px-2 py-1.5', c.reasons.includes('SAME_NAME_IN_FOLDER') && 'font-semibold text-warn')}>
                <Link href={`/cso/documents/${c.documentId}`} target="_blank" className="text-action hover:underline">{c.title}</Link>
                {c.folderName && <span className="block text-ink-soft">Dossier : {c.folderName}</span>}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink-muted">Contenu (SHA-256)</th>
            <td className="px-2 py-1.5 font-mono" title={n.sha256 ?? undefined}>{n.sha256 ? `${n.sha256.slice(0, 16)}…` : '—'}</td>
            {cands.map((c) => (
              <td key={c.documentId} className={cn('px-2 py-1.5', c.reasons.includes('CONTENT_HASH') && 'font-semibold text-warn')}>
                {c.reasons.includes('CONTENT_HASH') ? 'Identique à une version existante' : 'Différent'}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink-muted">Versions</th>
            <td className="px-2 py-1.5">Nouvelle</td>
            {cands.map((c) => (
              <td key={c.documentId} className="px-2 py-1.5">
                {c.versionCount} version(s){c.currentVersionNo ? ` — officielle v${c.currentVersionNo}` : ''} · {CSO_DOC_STATUS_LABELS[c.status] ?? c.status}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row" className="px-2 py-1.5 text-left font-medium text-ink-muted">Métadonnées</th>
            <td className="px-2 py-1.5">
              {n.description ? <span className="line-clamp-2">{n.description}</span> : <span className="text-ink-soft">Sans description</span>}
              <span className="block text-ink-soft">
                Révision {fmtDate(n.nextReviewOn)} · Expiration {fmtDate(n.expiryOn)}
              </span>
            </td>
            {cands.map((c) => (
              <td key={c.documentId} className="px-2 py-1.5">
                <span className="flex flex-wrap gap-1">
                  {c.reasons.map((r) => (
                    <Badge key={r} tone="warn" icon={false} className="px-1.5 py-0 text-[11px]">{DUPLICATE_REASON_LABELS[r] ?? r}</Badge>
                  ))}
                </span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function allowedDecisions(row: ImportRow): ImportDecision[] {
  if (row.status === 'INVALID') return ['IGNORE'];
  if (row.duplicateCandidates?.length) return ['IGNORE', 'CREATE_INDEPENDENT', 'SUBMIT_NEW_VERSION'];
  return ['CREATE', 'IGNORE'];
}

/** /cso/import/[id] — prévisualisation, doublons, décisions par ligne, application (commit) et résultat. */
export default function CsoImportJobPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const run = useCsoRun();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [confirm, setConfirm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const job = useQuery({
    queryKey: ['cso', 'import', id],
    queryFn: () => api.get<ImportJob>(`/cso/import-jobs/${id}`),
    enabled: can('cso.import'),
    refetchInterval: (q) => (q.state.data?.status === 'RUNNING' ? 2000 : false),
  });
  const categories = useQuery({ queryKey: ['cso', 'categories', 'all'], queryFn: () => api.get<CsoCategory[]>('/cso/categories'), staleTime: 60_000 });
  const rows = useCursorList<ImportRow>(['cso', 'import-rows', id], `/cso/import-jobs/${id}/rows`, { status: filter || undefined }, can('cso.import'));
  const j = job.data;
  const running = j?.status === 'RUNNING';
  const editable = !!j && (j.phase === 'PREVIEW_READY' || (j.phase === 'COMMITTING' && j.status !== 'RUNNING'));

  // Rafraîchir les lignes quand l'application se termine
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (running) setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      rows.refetch();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const catName = useMemo(() => new Map((categories.data ?? []).map((c) => [c.id, `${c.name} (${c.code})`])), [categories.data]);
  const draftCount = Object.keys(drafts).length;

  if (!can('cso.import')) return <Forbidden />;
  if (job.isLoading) return <LoadingBlock rows={10} />;
  if (job.error || !j) return <ErrorState error={job.error} onRetry={() => job.refetch()} />;

  const s = j.summary ?? {};
  const counts = j.rowCounts ?? {};
  const effectiveDraft = (r: ImportRow): Draft =>
    drafts[r.id] ?? { decision: r.status === 'INVALID' ? 'IGNORE' : r.decision, targetDocumentId: r.decisionTargetId ?? undefined };
  const setDraft = (r: ImportRow, patch: Partial<Draft>) =>
    setDrafts((d) => ({ ...d, [r.id]: { ...effectiveDraft(r), ...patch } }));
  const invalidDrafts = Object.entries(drafts).filter(([, d]) => d.decision === 'SUBMIT_NEW_VERSION' && !d.targetDocumentId).length;

  async function saveDrafts() {
    if (!draftCount) return;
    setSaving(true);
    setError(null);
    try {
      await run(
        () =>
          api.put(`/cso/import-jobs/${id}/decisions`, {
            items: Object.entries(drafts).map(([rowId, d]) => ({
              rowId,
              decision: d.decision,
              targetDocumentId: d.decision === 'SUBMIT_NEW_VERSION' ? d.targetDocumentId : undefined,
              title: d.title?.trim() || undefined,
              reference: d.reference === undefined ? undefined : d.reference?.trim() || null,
            })),
          }),
        `${draftCount} décision(s) enregistrée(s)`,
      );
      setDrafts({});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      throw e;
    } finally {
      setSaving(false);
    }
  }

  const committed = j.phase === 'COMMITTED';
  const commit = s.commit;

  return (
    <>
      <CsoPageHeader
        section="import"
        title={`Import du ${fmtDateTime(j.createdAt)}`}
        description="Vérifiez chaque ligne, tranchez les doublons suspectés puis appliquez. Toute création passe en attente d'approbation : rien n'est publié automatiquement."
        breadcrumb={[{ label: 'Documents CSO', href: '/cso' }, { label: 'Import en masse', href: '/cso/import' }, { label: 'Prévisualisation' }]}
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={j.phase} labels={IMPORT_PHASE_LABELS} tones={PHASE_TONES} />
        <StatusBadge status={j.status} labels={JOB_STATUS_LABELS} />
        {running && (
          <span className="inline-flex items-center gap-1 text-sm text-ink-muted" aria-live="polite">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> {j.phase === 'COMMITTING' ? 'Application en cours…' : 'Analyse en cours…'}
          </span>
        )}
      </div>
      {j.errorMessage && <Notice tone="danger" className="mb-4">{j.errorMessage}</Notice>}

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Éléments analysés" value={s.entries ?? Object.values(counts).reduce((a, b) => a + b, 0)} />
        <Stat label="Valides" value={s.valid ?? 0} tone="ok" />
        <Stat label="Doublons suspectés" value={s.duplicatesSuspected ?? 0} tone={(s.duplicatesSuspected ?? 0) > 0 ? 'warn' : undefined} />
        <Stat label="Invalides (ignorés)" value={s.invalid ?? 0} tone={(s.invalid ?? 0) > 0 ? 'danger' : undefined} />
        <Stat label="Décisions en attente" value={j.pendingDecisions ?? 0} tone={(j.pendingDecisions ?? 0) > 0 ? 'warn' : 'ok'} />
        <Stat label="Lignes Excel" value={s.metadataRows ?? 0} />
      </div>
      {!!s.unmatchedMetadataRows?.length && (
        <Notice tone="warn" className="mb-4">
          Lignes Excel sans fichier correspondant : {s.unmatchedMetadataRows.slice(0, 20).join(', ')}
          {s.unmatchedMetadataRows.length > 20 ? '…' : ''}
        </Notice>
      )}

      {commit && (
        <Panel title="Résultat de l'application" className="mb-4">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <Badge tone="ok">{commit.applied} créé(s) en attente d&apos;approbation</Badge>
            <Badge tone="neutral">{commit.skipped} ignoré(s)</Badge>
            {commit.alreadyApplied > 0 && <Badge tone="info">{commit.alreadyApplied} déjà appliqué(s)</Badge>}
            {commit.remainingFailed > 0 && <Badge tone="danger">{commit.remainingFailed} en échec</Badge>}
            <span className="text-xs text-ink-muted">le {fmtDateTime(commit.at)}</span>
          </div>
          <p className="mt-2 text-sm text-ink-muted">
            Aucun document n&apos;a été publié : chaque création ou nouvelle version attend la décision d&apos;un validateur.{' '}
            {can('cso.approve') && (
              <Link href="/cso/approvals" className="text-action hover:underline">
                Voir les documents à valider
              </Link>
            )}
          </p>
          {commit.remainingFailed > 0 && <p className="mt-1 text-sm">Corrigez ou ignorez les lignes en échec puis relancez l&apos;application : seules ces lignes seront rejouées.</p>}
        </Panel>
      )}

      <Panel
        title="Lignes de l'import"
        bodyClassName="p-0"
        actions={
          editable && (
            <>
              <Button variant="secondary" size="sm" disabled={!draftCount || invalidDrafts > 0} loading={saving} onClick={() => saveDrafts().catch(() => undefined)}>
                <Save className="h-4 w-4" aria-hidden /> Enregistrer les décisions{draftCount ? ` (${draftCount})` : ''}
              </Button>
              <Button size="sm" disabled={running || invalidDrafts > 0} onClick={() => setConfirm(true)}>
                <Play className="h-4 w-4" aria-hidden /> {j.phase === 'COMMITTING' ? "Reprendre l'application" : "Appliquer l'import"}
              </Button>
            </>
          )
        }
      >
        <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Filtrer par statut">
          {FILTERS.map((f) => (
            <button
              key={f || 'all'}
              type="button"
              role="tab"
              aria-selected={filter === f}
              onClick={() => setFilter(f)}
              className={cn('rounded-full border px-2.5 py-0.5 text-xs font-medium', filter === f ? 'border-action bg-action-50 text-navy' : 'border-line text-ink-muted hover:bg-canvas')}
            >
              {f ? IMPORT_ROW_STATUS_LABELS[f] : 'Toutes'}
              {f && counts[f] !== undefined ? ` (${counts[f]})` : ''}
            </button>
          ))}
        </div>
        {error && <Notice tone="danger" className="m-3">{error}</Notice>}
        {invalidDrafts > 0 && <Notice tone="warn" className="m-3">Choisissez le document cible pour chaque « nouvelle version ».</Notice>}
        {rows.error ? (
          <ErrorState error={rows.error} onRetry={() => rows.refetch()} />
        ) : rows.loading ? (
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : !rows.rows?.length ? (
          <EmptyState title="Aucune ligne" description={filter ? 'Aucune ligne avec ce statut.' : "L'analyse n'a produit aucune ligne."} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.rows.map((r) => {
              const n = r.normalized;
              const d = effectiveDraft(r);
              const decidable = editable && r.status !== 'APPLIED' && r.status !== 'SKIPPED';
              const options = allowedDecisions(r);
              const changed = !!drafts[r.id];
              return (
                <li key={r.id} className={cn('px-4 py-3', changed && 'bg-action-50/50')}>
                  <div className="flex flex-wrap items-start gap-3">
                    <span className="mt-0.5 w-8 text-right text-xs tabular text-ink-muted">#{r.rowNumber}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <FileText className="h-4 w-4 shrink-0 text-action" aria-hidden />
                        <span className="break-all text-sm font-medium">{n?.path ?? r.raw?.path ?? '—'}</span>
                        <Badge tone={ROW_TONE[r.status] ?? 'info'} icon={ROW_ICON[r.status]}>{IMPORT_ROW_STATUS_LABELS[r.status] ?? r.status}</Badge>
                      </div>
                      {n && (
                        <p className="mt-0.5 text-xs text-ink-muted">
                          {fmtBytes(n.sizeBytes)} · {n.categoryId ? catName.get(n.categoryId) ?? 'Catégorie' : 'Sans catégorie'}
                          {n.reference ? ` · Réf. ${n.reference}` : ''}
                          {n.nextReviewOn ? ` · Révision ${fmtDate(n.nextReviewOn)}` : ''}
                          {n.expiryOn ? ` · Expiration ${fmtDate(n.expiryOn)}` : ''}
                        </p>
                      )}
                      {r.errors?.map((e) => (
                        <p key={e} className="mt-0.5 flex items-center gap-1 text-xs font-medium text-danger">
                          <XCircle className="h-3.5 w-3.5" aria-hidden /> {e}
                        </p>
                      ))}
                      {r.warnings?.map((w) => (
                        <p key={w} className="mt-0.5 flex items-center gap-1 text-xs text-warn">
                          <AlertTriangle className="h-3.5 w-3.5" aria-hidden /> {w}
                        </p>
                      ))}
                      {r.errorMessage && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs font-medium text-danger">
                          <XCircle className="h-3.5 w-3.5" aria-hidden /> Échec : {r.errorMessage}
                        </p>
                      )}
                      {r.status === 'APPLIED' && r.appliedEntityId && (
                        <p className="mt-0.5 flex items-center gap-1 text-xs text-ok">
                          <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {r.decision === 'SUBMIT_NEW_VERSION' ? 'Nouvelle version soumise' : 'Document créé'} —{' '}
                          {/* SUBMIT_NEW_VERSION : l'entité appliquée est la version ; le document est la cible de la décision */}
                          <Link href={`/cso/documents/${r.decision === 'SUBMIT_NEW_VERSION' && r.decisionTargetId ? r.decisionTargetId : r.appliedEntityId}`} className="text-action hover:underline">
                            ouvrir le document
                          </Link>
                        </p>
                      )}
                      {decidable && r.status !== 'INVALID' && d.decision !== 'IGNORE' && n && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <label className="text-xs text-ink-muted">
                            Titre
                            <Input
                              className="mt-0.5 h-8 text-sm"
                              value={d.title ?? n.title}
                              onChange={(e) => setDraft(r, { title: e.target.value })}
                              maxLength={300}
                            />
                          </label>
                          {d.decision !== 'SUBMIT_NEW_VERSION' && (
                            <label className="text-xs text-ink-muted">
                              Référence (catégorie manuelle)
                              <Input
                                className="mt-0.5 h-8 font-mono text-sm"
                                value={d.reference === undefined ? n.reference ?? '' : d.reference ?? ''}
                                onChange={(e) => setDraft(r, { reference: e.target.value })}
                                maxLength={120}
                              />
                            </label>
                          )}
                        </div>
                      )}
                      {(r.duplicateCandidates?.length ?? 0) > 0 && (
                        <DuplicateComparison row={r} draft={d} editable={decidable} onTarget={(tid) => setDraft(r, { targetDocumentId: tid })} />
                      )}
                    </div>
                    <div className="w-full sm:w-64">
                      {decidable && options.length > 1 ? (
                        <label className="block text-xs text-ink-muted">
                          Décision
                          <Select
                            className="mt-0.5 h-8 text-sm"
                            value={d.decision}
                            invalid={d.decision === 'PENDING'}
                            onChange={(e) => {
                              const decision = e.target.value as ImportDecision;
                              setDraft(r, {
                                decision,
                                targetDocumentId:
                                  decision === 'SUBMIT_NEW_VERSION' ? d.targetDocumentId ?? (r.duplicateCandidates?.length === 1 ? r.duplicateCandidates[0].documentId : undefined) : undefined,
                              });
                            }}
                          >
                            {d.decision === 'PENDING' && <option value="PENDING">À décider…</option>}
                            {options.map((o) => (
                              <option key={o} value={o}>
                                {IMPORT_DECISION_LABELS[o]}
                              </option>
                            ))}
                          </Select>
                          {d.decision === 'SUBMIT_NEW_VERSION' && (
                            <span className="mt-1 block">
                              {d.targetDocumentId ? 'Document cible choisi dans la comparaison.' : 'Choisissez le document cible dans la comparaison.'}
                            </span>
                          )}
                        </label>
                      ) : (
                        <p className="text-xs text-ink-muted">
                          Décision : <span className="font-medium text-ink">{IMPORT_DECISION_LABELS[d.decision] ?? d.decision}</span>
                        </p>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {rows.hasMore && (
          <div className="border-t border-line px-3 py-2 text-right">
            <Button variant="secondary" size="sm" onClick={() => rows.loadMore()} loading={rows.loadingMore}>
              Charger la suite
            </Button>
          </div>
        )}
      </Panel>
      {committed && !commit && <Notice tone="ok" className="mt-4">Import appliqué.</Notice>}

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={j.phase === 'COMMITTING' ? "Reprendre l'application ?" : "Appliquer l'import ?"}
        description={
          <>
            Les lignes valides et les décisions enregistrées sont appliquées ; les lignes invalides ou ignorées sont écartées.{' '}
            <strong>Aucun document n&apos;est publié automatiquement</strong> : chaque création ou nouvelle version passe en attente d&apos;approbation.
            {draftCount > 0 && ` Vos ${draftCount} décision(s) non enregistrée(s) seront d'abord enregistrées.`}
            {(j.pendingDecisions ?? 0) > 0 && ` Attention : ${j.pendingDecisions} doublon(s) attendent encore une décision.`}
          </>
        }
        confirmLabel="Appliquer"
        onConfirm={async () => {
          if (draftCount) await saveDrafts();
          await run(() => api.post(`/cso/import-jobs/${id}/commit`), 'Application lancée — les résultats s’afficheront à la fin du traitement');
        }}
      />
    </>
  );
}
