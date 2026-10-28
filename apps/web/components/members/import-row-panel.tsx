'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ExternalLink, Info, Lock, X, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { ErrorState, LoadingBlock } from '@/components/ui/states';
import { ApiError, api, errorMessage } from '@/lib/api';
import { cn, fmtDate, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { DecisionBadge, MEMBER_IMPORT_FIELDS, RowStatusBadge } from './import-shared';
import { formatPlainValue, MemberStatusBadge, ScoreBadge } from './member-ui';
import {
  CREW_DEPARTMENT_LABELS,
  GENDER_LABELS,
  MEMBER_FIELD_LABELS,
  type FieldDiff,
  type ImportCandidate,
  type ImportDecision,
  type ImportJob,
  type ImportRow,
} from './types';

function Section({ title, children, tone }: { title: string; children: ReactNode; tone?: 'danger' | 'warn' }) {
  return (
    <section className="border-t border-line px-4 py-3">
      <h3 className={cn('mb-2 text-sm font-semibold', tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : 'text-navy')}>{title}</h3>
      {children}
    </section>
  );
}

/** Diff côte à côte fiche existante / import (champs fournis par la ligne). */
export function DiffTable({ diff, caption }: { diff: FieldDiff[]; caption: string }) {
  if (!diff.length) return <p className="text-sm text-ink-muted">Aucune valeur comparable.</p>;
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="table-amc">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Champ</th>
            <th scope="col">Fiche existante</th>
            <th scope="col">Import</th>
          </tr>
        </thead>
        <tbody>
          {diff.map((d) => (
            <tr key={d.field} className={cn(d.changed && '[&>td]:bg-warn-bg/50')}>
              <th scope="row" className="border-b border-line px-3 py-2 text-left text-xs font-medium text-ink-muted">
                <span className="inline-flex items-center gap-1">
                  {MEMBER_FIELD_LABELS[d.field] ?? d.field}
                  {d.protected && <Lock className="h-3 w-3" aria-label="donnée protégée" />}
                </span>
              </th>
              <td className="text-sm">{formatPlainValue(d.field, d.current)}</td>
              <td className="text-sm">
                {formatPlainValue(d.field, d.imported)}
                {d.changed ? (
                  <span className="ml-1.5 text-xs font-medium text-warn">modifié</span>
                ) : (
                  <span className="sr-only"> (identique)</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CandidateCard({
  c,
  onSelectRow,
  onUseTarget,
  canDecide,
}: {
  c: ImportCandidate;
  onSelectRow: (rowId: string) => void;
  onUseTarget: (memberId: string) => void;
  canDecide: boolean;
}) {
  if (c.kind === 'ROW') {
    return (
      <li className="rounded-md border border-line bg-white p-3">
        <div className="flex flex-wrap items-center gap-2">
          <ScoreBadge score={c.score} />
          <Badge tone="info" icon={false}>
            Doublon dans le fichier
          </Badge>
        </div>
        <p className="mt-1.5 text-sm">
          Feuille « {c.sheetName} », ligne {c.rowNumber}
        </p>
        <ul className="mt-1 list-disc pl-5 text-xs">
          {c.reasonLabels.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <Button size="sm" variant="ghost" className="mt-1" onClick={() => onSelectRow(c.rowId)}>
          Voir cette ligne
        </Button>
      </li>
    );
  }
  return (
    <li className="rounded-md border border-line bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <ScoreBadge score={c.score} />
        {c.archived && (
          <Badge tone="neutral" icon={false}>
            Fiche archivée
          </Badge>
        )}
      </div>
      {c.member ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
          <Link href={`/members/${c.memberId}`} target="_blank" className="inline-flex items-center gap-1 font-medium text-action hover:underline">
            {c.member.lastName.toUpperCase()} {c.member.firstName}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
            <span className="sr-only">(ouvre un nouvel onglet)</span>
          </Link>
          <MemberStatusBadge status={c.member.status} />
          <span className="text-xs text-ink-muted">{[c.member.amcRef, c.member.rank].filter(Boolean).join(' — ')}</span>
        </div>
      ) : (
        <p className="mt-1.5 text-sm text-ink-muted">
          <Lock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
          Fiche existante hors de votre périmètre : identité et valeurs masquées.
        </p>
      )}
      <ul className="mt-1 list-disc pl-5 text-xs">
        {c.reasonLabels.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      {c.diff && (
        <div className="mt-2">
          <DiffTable diff={c.diff} caption="Comparaison fiche existante et import" />
        </div>
      )}
      {c.member && canDecide && !c.member.archived && (
        <Button size="sm" variant="secondary" className="mt-2" onClick={() => onUseTarget(c.memberId)}>
          Mettre à jour cette fiche
        </Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Décision
// ---------------------------------------------------------------------------

type CorrectionValues = Record<string, string>;

function correctionInput(field: string, value: string, onChange: (v: string) => void, invalid: boolean) {
  const id = `corr-${field}`;
  const label = MEMBER_FIELD_LABELS[field] ?? field;
  let control: ReactNode;
  if (field === 'gender') {
    control = (
      <Select id={id} value={value} invalid={invalid} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {Object.entries(GENDER_LABELS).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
    );
  } else if (field === 'crewDepartment') {
    control = (
      <Select id={id} value={value} invalid={invalid} onChange={(e) => onChange(e.target.value)}>
        <option value="">—</option>
        {Object.entries(CREW_DEPARTMENT_LABELS).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
    );
  } else {
    const date = field === 'birthDate' || field === 'passportExpiry' || field === 'seamanBookExpiry';
    const country = field === 'nationality' || field === 'passportCountry';
    control = (
      <Input
        id={id}
        type={date ? 'date' : 'text'}
        value={value}
        invalid={invalid}
        maxLength={country ? 2 : undefined}
        className={country ? 'uppercase' : undefined}
        onChange={(e) => onChange(country ? e.target.value.toUpperCase() : e.target.value)}
      />
    );
  }
  return (
    <Field key={field} label={label} htmlFor={id}>
      {control}
    </Field>
  );
}

function DecisionForm({
  job,
  row,
  target,
  setTarget,
  hint,
}: {
  job: ImportJob;
  row: ImportRow;
  target: string;
  setTarget: (id: string) => void;
  /** Décision suggérée depuis une carte candidat (« Mettre à jour cette fiche ») */
  hint: number;
}) {
  const qc = useQueryClient();
  const { can } = useSession();
  const memberCands = row.candidates.filter((c): c is Extract<ImportCandidate, { kind: 'MEMBER' }> => c.kind === 'MEMBER');
  const visibleTargets = memberCands.filter((c) => c.member && !c.member.archived);
  const sameRef = memberCands.some((c) => c.reasons.includes('AMC_REF'));
  const hasErrors = row.errors.length > 0;
  const initialDecision: ImportDecision =
    row.decision !== 'PENDING' ? row.decision : hasErrors ? 'CORRECT' : sameRef && visibleTargets.length ? 'UPDATE' : row.candidates.length ? 'IGNORE' : 'CREATE';
  const [decision, setDecision] = useState<ImportDecision>(initialDecision);
  const [reason, setReason] = useState(row.decisionReason ?? '');
  const original = useMemo<CorrectionValues>(
    () => Object.fromEntries(MEMBER_IMPORT_FIELDS.map((f) => [f, row.normalized.member?.[f] ?? ''])),
    [row.normalized.member],
  );
  const [corr, setCorr] = useState<CorrectionValues>(original);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDecision(initialDecision);
    setReason(row.decisionReason ?? '');
    setCorr(original);
    setError(null);
    // Réinitialisation quand la ligne change
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.decidedAt]);

  useEffect(() => {
    if (hint) setDecision('UPDATE');
  }, [hint]);

  const changes = Object.fromEntries(
    MEMBER_IMPORT_FIELDS.filter((f) => (corr[f] ?? '').trim() !== (original[f] ?? '').trim()).map((f) => [f, corr[f].trim() || null]),
  );
  const reasonRequired = decision === 'CREATE' && row.candidates.length > 0;
  const blockers: string[] = [];
  if (decision === 'CREATE' && hasErrors) blockers.push('Ligne invalide : corrigez-la avant de créer la fiche.');
  if (decision === 'CREATE' && sameRef) blockers.push('Matricule AMC déjà attribué à une fiche : choisissez « Mettre à jour » ou « Ignorer ».');
  if (decision === 'UPDATE' && hasErrors) blockers.push('Ligne invalide : corrigez-la avant la mise à jour.');
  if (decision === 'UPDATE' && !target) blockers.push('Choisissez la fiche à mettre à jour.');
  if (decision === 'UPDATE' && !can('members.edit')) blockers.push('La mise à jour d’une fiche existante exige la permission de modifier les fiches.');
  if (decision === 'CORRECT' && !Object.keys(changes).length) blockers.push('Modifiez au moins une valeur.');
  if (reasonRequired && reason.trim().length < 3) blockers.push('Motif obligatoire pour créer malgré un doublon potentiel (3 caractères min.).');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { decision };
      if (decision === 'UPDATE') body.targetMemberId = target;
      if (decision === 'CORRECT') body.corrections = changes;
      if (reason.trim()) body.reason = reason.trim();
      const updated = await api.patch<ImportRow>(`/members/import-jobs/${job.id}/rows/${row.id}`, body);
      qc.setQueryData(['import-row', job.id, row.id], updated);
      await Promise.all([qc.invalidateQueries({ queryKey: ['import-rows', job.id] }), qc.invalidateQueries({ queryKey: ['import-job', job.id] })]);
      if (decision === 'CORRECT' && updated.decision === 'PENDING') {
        toast.warning(
          updated.status === 'DUPLICATE_SUSPECTED'
            ? 'Correction enregistrée : la ligne ressemble toujours à une fiche existante, une décision reste nécessaire.'
            : 'Correction enregistrée : la ligne reste invalide.',
        );
      } else {
        toast.success('Décision enregistrée');
      }
    } catch (e) {
      setError(e instanceof ApiError && e.fieldErrors && Object.keys(e.fieldErrors).length ? `${e.message} — ${Object.values(e.fieldErrors).join(' ; ')}` : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const errorFields = new Set(row.errors.map((e) => e.field).filter(Boolean));
  const options: { value: ImportDecision; label: string; hint: string }[] = [
    { value: 'CREATE', label: 'Créer une nouvelle fiche', hint: row.candidates.length ? 'Malgré le doublon potentiel : motif obligatoire, audité.' : 'Aucune ressemblance détectée.' },
    { value: 'UPDATE', label: 'Mettre à jour une fiche existante', hint: 'Seuls les champs fournis par la ligne sont écrits (diff ci-dessus).' },
    { value: 'IGNORE', label: 'Ignorer la ligne', hint: 'Rien n’est écrit ; la décision figure au rapport.' },
    { value: 'CORRECT', label: 'Corriger les valeurs', hint: 'Les erreurs et doublons sont réévalués après correction.' },
  ];

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="sr-only">Décision pour la ligne</legend>
        <div className="space-y-1.5">
          {options.map((o) => (
            <label
              key={o.value}
              className={cn(
                'flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2',
                decision === o.value ? 'border-action bg-action-50' : 'border-line bg-white hover:bg-canvas',
              )}
            >
              <input
                type="radio"
                name={`decision-${row.id}`}
                value={o.value}
                checked={decision === o.value}
                onChange={() => setDecision(o.value)}
                className="mt-0.5 h-4 w-4 text-action"
              />
              <span>
                <span className="block text-sm font-medium">{o.label}</span>
                <span className="block text-xs text-ink-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {decision === 'UPDATE' && (
        <Field label="Fiche à mettre à jour" required htmlFor={`target-${row.id}`} hint={visibleTargets.length ? undefined : 'Aucune fiche candidate visible dans votre périmètre.'}>
          <Select id={`target-${row.id}`} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">Choisir…</option>
            {visibleTargets.map((c) => (
              <option key={c.memberId} value={c.memberId}>
                {c.member!.lastName.toUpperCase()} {c.member!.firstName}
                {c.member!.amcRef ? ` — ${c.member!.amcRef}` : ''} (score {c.score})
              </option>
            ))}
          </Select>
        </Field>
      )}

      {decision === 'CORRECT' && (
        <div className="grid grid-cols-1 gap-x-3 gap-y-2 sm:grid-cols-2">
          {MEMBER_IMPORT_FIELDS.map((f) => correctionInput(f, corr[f] ?? '', (v) => setCorr((c) => ({ ...c, [f]: v })), errorFields.has(f)))}
        </div>
      )}

      <Field label={reasonRequired ? 'Motif' : 'Motif (facultatif)'} required={reasonRequired} htmlFor={`reason-${row.id}`} hint="Conservé dans le journal d'audit et le rapport d'import.">
        <Textarea id={`reason-${row.id}`} rows={2} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>

      {blockers.length > 0 && (
        <ul className="space-y-1 text-xs text-warn">
          {blockers.map((b) => (
            <li key={b} className="flex items-start gap-1.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {b}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="text-sm font-medium text-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex justify-end">
        <Button onClick={submit} loading={busy} disabled={blockers.length > 0}>
          Enregistrer la décision
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panneau détail de ligne
// ---------------------------------------------------------------------------

function expiryLabel(c: { expiryKind: string; expiryOn: string | null }) {
  if (c.expiryKind === 'UNLIMITED') return 'Permanent';
  if (c.expiryKind === 'UNKNOWN') return 'Échéance inconnue';
  return c.expiryOn ? fmtDate(c.expiryOn) : '—';
}

export function ImportRowPanel({
  job,
  rowId,
  initial,
  onClose,
  onSelectRow,
}: {
  job: ImportJob;
  rowId: string;
  initial?: ImportRow;
  onClose: () => void;
  onSelectRow: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ['import-row', job.id, rowId],
    queryFn: () => api.get<ImportRow>(`/members/import-jobs/${job.id}/rows/${rowId}`),
    initialData: initial,
    staleTime: 5_000,
  });
  const [target, setTarget] = useState('');
  const [hint, setHint] = useState(0);
  const row = q.data;
  useEffect(() => {
    if (!row) return;
    const firstVisible = row.candidates.find((c) => c.kind === 'MEMBER' && c.member && !c.member.archived) as Extract<ImportCandidate, { kind: 'MEMBER' }> | undefined;
    setTarget(row.decisionTargetId ?? firstVisible?.memberId ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id, row?.decidedAt]);

  const canDecide =
    !!row && row.status !== 'APPLIED' && job.status !== 'CANCELLED' && (job.phase === 'PREVIEW_READY' || job.phase === 'COMMITTED');

  return (
    <aside className="panel overflow-hidden xl:sticky xl:top-4 xl:max-h-[calc(100vh-7.5rem)] xl:overflow-y-auto" aria-label="Détail de la ligne">
      <div className="flex items-center justify-between gap-2 px-4 py-3">
        <h2 className="text-md font-semibold">{row ? `Feuille « ${row.sheetName} » — ligne ${row.rowNumber}` : 'Ligne'}</h2>
        <IconButton label="Fermer le détail" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>
      {q.isLoading && <LoadingBlock rows={5} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {row && (
        <>
          <div className="flex flex-wrap items-center gap-2 px-4 pb-3">
            <RowStatusBadge status={row.status} />
            <DecisionBadge decision={row.decision} />
            {row.decidedBy && (
              <span className="text-xs text-ink-muted">
                par {row.decidedBy.displayName} le {fmtDateTime(row.decidedAt)}
              </span>
            )}
          </div>

          {row.status === 'APPLIED' && row.normalized.outcome && (
            <Section title="Appliquée">
              <p className="flex items-center gap-1.5 text-sm">
                <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />
                {row.normalized.outcome.action === 'CREATED' ? 'Fiche créée' : 'Fiche mise à jour'}
                {row.appliedEntityId && (
                  <Link href={`/members/${row.appliedEntityId}`} className="ml-1 font-medium text-action hover:underline">
                    Ouvrir la fiche
                  </Link>
                )}
              </p>
              {row.normalized.outcome.changedFields.length > 0 && (
                <p className="mt-1 text-xs text-ink-muted">
                  Champs écrits : {row.normalized.outcome.changedFields.map((f) => MEMBER_FIELD_LABELS[f] ?? f).join(', ')}
                </p>
              )}
              {row.normalized.outcome.certificates.map((c) => (
                <p key={c.code} className="mt-1 text-xs">
                  {c.code} : {c.result === 'REQUEST_CREATED' ? 'demande créée, en attente d’approbation' : `ignoré — ${c.reason ?? ''}`}
                </p>
              ))}
              {row.normalized.outcome.assignment && (
                <p className="mt-1 text-xs">
                  Affectation : {row.normalized.outcome.assignment.result === 'CREATED' ? 'créée' : `non créée — ${row.normalized.outcome.assignment.reason ?? ''}`}
                </p>
              )}
            </Section>
          )}

          {row.errorMessage && (
            <Section title="Échec à l'application" tone="danger">
              <p className="text-sm text-danger">{row.errorMessage}</p>
            </Section>
          )}

          {row.errors.length > 0 && (
            <Section title={`Erreurs (${row.errors.length})`} tone="danger">
              <ul className="space-y-1 text-sm">
                {row.errors.map((e, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
                    <span>
                      {e.column && <span className="font-mono text-xs text-ink-muted">[{e.column}] </span>}
                      {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {row.warnings.length > 0 && (
            <Section title={`Avertissements (${row.warnings.length})`} tone="warn">
              <ul className="space-y-1 text-sm">
                {row.warnings.map((e, i) => (
                  <li key={i} className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
                    <span>
                      {e.column && <span className="font-mono text-xs text-ink-muted">[{e.column}] </span>}
                      {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <Section title="Valeurs importées (normalisées)">
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
              {Object.entries(row.normalized.member ?? {})
                .filter(([, v]) => v !== undefined && v !== null && v !== '')
                .map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-xs text-ink-muted">{MEMBER_FIELD_LABELS[k] ?? k}</dt>
                    <dd className="break-words">{formatPlainValue(k, v)}</dd>
                  </div>
                ))}
            </dl>
            {row.normalized.corrections && Object.keys(row.normalized.corrections).length > 0 && (
              <p className="mt-2 text-xs text-ink-muted">
                Corrigé :{' '}
                {Object.entries(row.normalized.corrections)
                  .map(([k, c]) => `${MEMBER_FIELD_LABELS[k] ?? k} (${formatPlainValue(k, c.from)} → ${formatPlainValue(k, c.to)})`)
                  .join(' ; ')}
              </p>
            )}
            {row.normalized.certificates.length > 0 && (
              <div className="mt-3">
                <p className="mb-1 text-xs font-medium text-ink-muted">Certificats détectés (importés en demandes à approuver)</p>
                <ul className="space-y-1 text-sm">
                  {row.normalized.certificates.map((c) => (
                    <li key={c.code} className="flex flex-wrap items-center gap-2">
                      <Badge tone="navy" icon={false}>
                        {c.code}
                      </Badge>
                      <span className="tabular">{c.number ?? 'sans numéro'}</span>
                      <span className="text-ink-muted">— {expiryLabel(c)}</span>
                      {c.issuedOn && <span className="text-xs text-ink-muted">délivré le {fmtDate(c.issuedOn)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {row.normalized.assignment && (row.normalized.assignment.joinDate || row.normalized.assignment.vesselText) && (
              <p className="mt-3 text-sm">
                <span className="text-xs font-medium text-ink-muted">Embarquement : </span>
                {[
                  row.normalized.assignment.joinDate && `du ${fmtDate(row.normalized.assignment.joinDate)}`,
                  row.normalized.assignment.signOffDate && `au ${fmtDate(row.normalized.assignment.signOffDate)}`,
                  row.normalized.vesselLabel ?? row.normalized.assignment.vesselText,
                ]
                  .filter(Boolean)
                  .join(' — ')}
              </p>
            )}
            <details className="mt-3">
              <summary className="cursor-pointer text-xs font-medium text-action">Cellules brutes du fichier</summary>
              <table className="mt-2 w-full text-xs">
                <tbody>
                  {row.raw.map((c) => (
                    <tr key={c.column} className="border-b border-line">
                      <td className="py-1 pr-2 font-mono text-ink-muted">{c.column}</td>
                      <td className="py-1 pr-2 text-ink-muted">{c.header || '—'}</td>
                      <td className="py-1 break-all">{String(c.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          </Section>

          {row.decision === 'UPDATE' && row.decisionTargetDiff && (
            <Section title="Mise à jour décidée : champs comparés">
              <DiffTable diff={row.decisionTargetDiff} caption="Fiche cible et import" />
            </Section>
          )}

          {row.candidates.length > 0 && (
            <Section title={`Doublons suspectés (${row.candidates.length})`} tone="warn">
              <ul className="space-y-2">
                {row.candidates.map((c) => (
                  <CandidateCard key={c.kind === 'MEMBER' ? c.memberId : c.rowId} c={c} onSelectRow={onSelectRow} onUseTarget={(id) => {
                      setTarget(id);
                      setHint((n) => n + 1);
                    }}
                    canDecide={canDecide}
                  />
                ))}
              </ul>
            </Section>
          )}

          {canDecide ? (
            <Section title="Décision">
              <DecisionForm job={job} row={row} target={target} setTarget={setTarget} hint={hint} />
            </Section>
          ) : (
            row.status !== 'APPLIED' && (
              <Section title="Décision">
                <p className="text-sm text-ink-muted">Décision non modifiable dans l’état actuel de l’import.</p>
              </Section>
            )
          )}
        </>
      )}
    </aside>
  );
}
