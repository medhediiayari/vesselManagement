'use client';

import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCheck } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DataTable } from '@/components/ui/data-table';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/field';
import { FilterBar, Panel } from '@/components/ui/page';
import { api, errorMessage } from '@/lib/api';
import { cn, fmtDate } from '@/lib/format';
import { useCursorList } from '@/lib/hooks';
import { DecisionBadge, RowStatusBadge } from './import-shared';
import { ImportRowPanel } from './import-row-panel';
import {
  IMPORT_DECISION_LABELS,
  IMPORT_ROW_STATUS_LABELS,
  type CommitRun,
  type ImportJob,
  type ImportRow,
  type ImportRowStatus,
} from './types';

function Counter({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: ReactNode;
  tone?: 'danger' | 'warn' | 'ok';
  active?: boolean;
  onClick?: () => void;
}) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : tone === 'ok' ? 'text-ok' : 'text-navy';
  const body = (
    <>
      <span className="block text-xs text-ink-muted">{label}</span>
      <span className={cn('block text-lg font-semibold tabular', color)}>{value}</span>
    </>
  );
  if (!onClick) return <div className="gauge">{body}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn('gauge text-left', active && 'border-action bg-action-50')}
    >
      {body}
    </button>
  );
}

/**
 * Étape 3 — prévisualisation : compteurs par statut, lignes paginées avec erreurs / avertissements,
 * détail et décision explicite par ligne ; validation bloquée tant qu'un doublon suspecté reste sans décision.
 */
export function ImportPreviewStep({ job, onCommitted }: { job: ImportJob; onCommitted: (job: ImportJob, run: CommitRun) => void }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<ImportRowStatus | ''>(job.counts.pendingDuplicateDecisions ? 'DUPLICATE_SUSPECTED' : '');
  const [decision, setDecision] = useState('');
  const [sheet, setSheet] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);

  const rows = useCursorList<ImportRow>(['import-rows', job.id], `/members/import-jobs/${job.id}/rows`, {
    status: status || undefined,
    decision: decision || undefined,
    sheet: sheet || undefined,
  });

  const preview = job.summary?.preview;
  const s = job.counts.byStatus;
  const d = job.counts.byDecision;
  const pending = job.counts.pendingDuplicateDecisions;
  const cancelled = job.status === 'CANCELLED';
  const committing = job.phase === 'COMMITTING';
  const toggleStatus = (v: ImportRowStatus) => setStatus((cur) => (cur === v ? '' : v));
  const selectedRow = rows.rows?.find((r) => r.id === selected);

  const commit = async () => {
    setCommitError(null);
    try {
      const res = await api.post<{ job: ImportJob; run: CommitRun }>(`/members/import-jobs/${job.id}/commit`);
      qc.setQueryData(['import-job', job.id], res.job);
      await qc.invalidateQueries({ queryKey: ['import-rows', job.id] });
      await qc.invalidateQueries({ queryKey: ['import-jobs'] });
      await qc.invalidateQueries({ queryKey: ['members'] });
      onCommitted(res.job, res.run);
    } catch (e) {
      setCommitError(errorMessage(e));
      await qc.invalidateQueries({ queryKey: ['import-job', job.id] });
      throw e;
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        <Counter label="Lignes" value={preview?.totalRows ?? Object.values(s).reduce((a, b) => a + (b ?? 0), 0)} onClick={() => setStatus('')} active={!status} />
        <Counter label="Valides" value={s.VALID ?? 0} tone="ok" onClick={() => toggleStatus('VALID')} active={status === 'VALID'} />
        <Counter label="Invalides" value={s.INVALID ?? 0} tone={s.INVALID ? 'danger' : undefined} onClick={() => toggleStatus('INVALID')} active={status === 'INVALID'} />
        <Counter
          label="Doublons suspectés"
          value={s.DUPLICATE_SUSPECTED ?? 0}
          tone={s.DUPLICATE_SUSPECTED ? 'warn' : undefined}
          onClick={() => toggleStatus('DUPLICATE_SUSPECTED')}
          active={status === 'DUPLICATE_SUSPECTED'}
        />
        <Counter label="Doublons sans décision" value={pending} tone={pending ? 'danger' : 'ok'} />
        <Counter label="Appliquées" value={s.APPLIED ?? 0} onClick={() => toggleStatus('APPLIED')} active={status === 'APPLIED'} />
        <Counter label="Non importées" value={s.SKIPPED ?? 0} onClick={() => toggleStatus('SKIPPED')} active={status === 'SKIPPED'} />
        <Counter label="Échecs" value={s.FAILED ?? 0} tone={s.FAILED ? 'danger' : undefined} onClick={() => toggleStatus('FAILED')} active={status === 'FAILED'} />
      </div>

      {preview && (
        <Panel title="Synthèse de la prévisualisation" bodyClassName="grid gap-4 p-4 lg:grid-cols-3">
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Par feuille</p>
            <ul className="space-y-0.5 text-sm">
              {preview.sheets.map((sh) => (
                <li key={sh.name} className="flex justify-between gap-2">
                  <span className="truncate">{sh.name}</span>
                  <span className="shrink-0 tabular text-ink-muted">
                    {sh.rows} l. — {sh.valid} ok, {sh.invalid} inv., {sh.duplicateSuspected} doubl.
                  </span>
                </li>
              ))}
            </ul>
            {preview.blankRowsIgnored > 0 && <p className="mt-1 text-xs text-ink-muted">{preview.blankRowsIgnored} ligne(s) vide(s) ou de titre ignorée(s).</p>}
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Rapprochements</p>
            <p className="text-sm">{preview.existingMemberMatches} ligne(s) ressemblant à une fiche existante</p>
            <p className="text-sm">{preview.inFileDuplicates} ligne(s) en double dans le fichier</p>
            <p className="text-sm">{preview.assignmentsDetected} date(s) d’embarquement détectée(s)</p>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-ink-muted">Certificats ({preview.certificates.total})</p>
            <p className="text-sm">
              {preview.certificates.dated} daté(s), {preview.certificates.unlimited} permanent(s), {preview.certificates.unknownExpiry} échéance inconnue
            </p>
            {preview.certificates.expired > 0 && <p className="text-sm text-danger">{preview.certificates.expired} déjà expiré(s)</p>}
            <p className="mt-1 text-xs text-ink-muted">
              {Object.entries(preview.certificates.byCode)
                .map(([k, v]) => `${k} ${v}`)
                .join(' · ')}
            </p>
            <p className="mt-1 text-xs text-ink-muted">Importés en demandes soumises à approbation, document manquant jusqu’au dépôt du scan.</p>
          </div>
        </Panel>
      )}

      <FilterBar>
        <div className="w-48">
          <label className="field-label" htmlFor="ir-status">
            Statut
          </label>
          <Select id="ir-status" value={status} onChange={(e) => setStatus(e.target.value as ImportRowStatus | '')}>
            <option value="">Tous</option>
            {Object.entries(IMPORT_ROW_STATUS_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-44">
          <label className="field-label" htmlFor="ir-decision">
            Décision
          </label>
          <Select id="ir-decision" value={decision} onChange={(e) => setDecision(e.target.value)}>
            <option value="">Toutes</option>
            {Object.entries(IMPORT_DECISION_LABELS).map(([k, l]) => (
              <option key={k} value={k}>
                {l} {d[k as keyof typeof d] ? `(${d[k as keyof typeof d]})` : ''}
              </option>
            ))}
          </Select>
        </div>
        <div className="w-56">
          <label className="field-label" htmlFor="ir-sheet">
            Feuille
          </label>
          <Select id="ir-sheet" value={sheet} onChange={(e) => setSheet(e.target.value)}>
            <option value="">Toutes</option>
            {(job.mapping ?? []).filter((m) => m.include).map((m) => (
              <option key={m.name} value={m.name}>
                {m.name}
              </option>
            ))}
          </Select>
        </div>
      </FilterBar>

      <div className={cn('grid gap-4', selected && 'xl:grid-cols-[minmax(0,1fr)_minmax(420px,520px)]')}>
        <DataTable
          caption="Lignes de l'import"
          rows={rows.rows}
          loading={rows.loading}
          error={rows.error}
          onRetry={() => rows.refetch()}
          hasMore={rows.hasMore}
          onLoadMore={rows.loadMore}
          loadingMore={rows.loadingMore}
          total={rows.total}
          selectedId={selected}
          onRowClick={(r) => setSelected(r.id)}
          columns={[
            {
              key: 'pos',
              header: 'Ligne',
              cell: (r) => (
                <span className="text-xs">
                  <span className="block max-w-[140px] truncate text-ink-muted" title={r.sheetName}>
                    {r.sheetName}
                  </span>
                  <span className="tabular">n° {r.rowNumber}</span>
                </span>
              ),
            },
            {
              key: 'name',
              header: 'Nom',
              cell: (r) => (
                <span className="font-medium text-navy">
                  {[r.normalized.member?.lastName?.toUpperCase(), r.normalized.member?.firstName].filter(Boolean).join(' ') || (
                    <span className="italic text-ink-soft">Nom manquant</span>
                  )}
                </span>
              ),
            },
            {
              key: 'ids',
              header: 'Identifiants',
              hideBelow: 'lg',
              cell: (r) => (
                <span className="block text-xs text-ink-muted">
                  {[
                    r.normalized.member?.amcRef,
                    r.normalized.member?.birthDate && `né(e) ${fmtDate(r.normalized.member.birthDate)}`,
                    r.normalized.member?.passportNumber && `pass. ${r.normalized.member.passportNumber}`,
                  ]
                    .filter(Boolean)
                    .join(' — ') || '—'}
                </span>
              ),
            },
            { key: 'status', header: 'Statut', cell: (r) => <RowStatusBadge status={r.status} /> },
            { key: 'decision', header: 'Décision', cell: (r) => <DecisionBadge decision={r.decision} /> },
            {
              key: 'issues',
              header: 'Contrôles',
              hideBelow: 'md',
              cell: (r) => (
                <span className="flex flex-wrap gap-x-2 text-xs">
                  {r.errors.length > 0 && <span className="font-medium text-danger">{r.errors.length} erreur(s)</span>}
                  {r.warnings.length > 0 && <span className="text-warn">{r.warnings.length} avert.</span>}
                  {r.candidates.length > 0 && <span className="text-warn">{r.candidates.length} candidat(s)</span>}
                  {!r.errors.length && !r.warnings.length && !r.candidates.length && <span className="text-ink-soft">—</span>}
                </span>
              ),
            },
          ]}
        />
        {selected && (
          <ImportRowPanel key={selected} job={job} rowId={selected} initial={selectedRow} onClose={() => setSelected(null)} onSelectRow={setSelected} />
        )}
      </div>

      {!cancelled && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-end gap-3 rounded-lg border border-line bg-white/95 px-4 py-3 shadow-panel backdrop-blur">
          <span className="mr-auto text-sm">
            {committing ? (
              <span className="text-warn">Validation en cours…</span>
            ) : pending > 0 ? (
              <span className="flex items-center gap-1.5 text-danger">
                <AlertTriangle className="h-4 w-4" aria-hidden /> {pending} doublon(s) suspecté(s) sans décision explicite : validation bloquée.
              </span>
            ) : (
              <span className="text-ink-muted">
                Lignes valides sans décision : créées. Lignes invalides non corrigées : non importées. Aucune mise à jour implicite.
              </span>
            )}
          </span>
          {commitError && (
            <span className="w-full text-sm text-danger" role="alert">
              {commitError}
            </span>
          )}
          {job.phase !== 'COMMITTED' && (
            <Button variant="ghost" onClick={() => setCancelOpen(true)} disabled={committing}>
              <Ban className="h-4 w-4" aria-hidden /> Annuler l’import
            </Button>
          )}
          <Button onClick={() => setCommitOpen(true)} disabled={!job.canCommit || pending > 0 || committing}>
            <CheckCheck className="h-4 w-4" aria-hidden /> {job.phase === 'COMMITTED' ? 'Relancer la validation' : "Valider l'import"}
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={commitOpen}
        onOpenChange={setCommitOpen}
        title="Valider l'import"
        description={
          <span className="mt-1 block space-y-1">
            <span className="block">
              Chaque ligne est appliquée dans sa propre transaction ; une ligne déjà appliquée ne l’est jamais deux fois.
            </span>
            <span className="block text-ink">
              Décisions explicites — créer : {d.CREATE ?? 0}, mettre à jour : {d.UPDATE ?? 0}, ignorer : {d.IGNORE ?? 0}, corrigées : {d.CORRECT ?? 0}.
            </span>
            <span className="block">
              Lignes valides sans décision : nouvelles fiches. Lignes invalides non corrigées ({s.INVALID ?? 0}) : non importées.
            </span>
          </span>
        }
        confirmLabel="Valider"
        onConfirm={commit}
      />
      <ConfirmDialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title="Annuler l'import"
        description="Aucune ligne non appliquée ne sera importée. Le job reste consultable et son rapport téléchargeable."
        confirmLabel="Annuler l'import"
        tone="danger"
        requireReason
        reasonLabel="Motif de l'annulation"
        onConfirm={async (reason) => {
          const res = await api.post<ImportJob>(`/members/import-jobs/${job.id}/cancel`, { reason });
          qc.setQueryData(['import-job', job.id], res);
          await qc.invalidateQueries({ queryKey: ['import-jobs'] });
          toast.success('Import annulé');
        }}
      />
    </div>
  );
}
