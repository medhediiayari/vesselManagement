'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, GitCompareArrows, Plus, RotateCcw, Trash2, Undo2, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDateTime, fmtDecimal } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Input, Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState, ErrorState, LoadingBlock } from '@/components/ui/states';
import { PR_STATUS_LABELS } from '@amc/types';
import {
  COMMON_UNITS,
  PRIORITY_LABELS,
  REVISION_ACTION_LABELS,
  REVISION_ACTION_TONES,
  REVISION_KIND_LABELS,
  REVISION_STATUS_LABELS,
  REVISION_STATUS_TONES,
  commandError,
  dec,
  decimalError,
  purKeys,
  toApiDecimal,
  toDateInput,
  useCommand,
} from './lib';
import type { PrDetail, PrRevision, PrRevisionDiffLine, RevisionAction } from './types';
import { Callout, DecimalInput, FormField, StatusPill, TextActionDialog } from './ui';

export const REVISABLE = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED'];

const HEADER_LABELS: Record<string, string> = { neededBy: 'Date de besoin', priority: 'Priorité', subject: 'Objet', category: 'Catégorie' };

function headerValue(field: string, v: string | null): string {
  if (v === null || v === '') return '—';
  if (field === 'neededBy') return v.split('-').reverse().join('/');
  if (field === 'priority') return PRIORITY_LABELS[v] ?? v;
  return v;
}

function Delta({ value }: { value: string }) {
  const c = dec.cmp(value, '0');
  return (
    <span className={cn('tabular font-medium', c > 0 ? 'text-info' : c < 0 ? 'text-danger' : 'text-ink-muted')}>
      {c > 0 ? '+' : ''}
      {fmtDecimal(value)}
    </span>
  );
}

/** Tableau d'écart PR d'origine (immuable) ↔ proposition révisée (PUR-02). */
export function RevisionDiffTable({ lines }: { lines: PrRevisionDiffLine[] }) {
  return (
    <div className="overflow-x-auto rounded-md border border-line">
      <table className="table-amc">
        <thead>
          <tr>
            <th scope="col">Ligne</th>
            <th scope="col">Action</th>
            <th scope="col">PR d’origine</th>
            <th scope="col" className="text-right">
              Qté demandée
            </th>
            <th scope="col" aria-label="vers" />
            <th scope="col">Proposition</th>
            <th scope="col" className="text-right">
              Qté proposée
            </th>
            <th scope="col" className="text-right">
              Écart
            </th>
            <th scope="col">Situation actuelle</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={`${l.prLineId ?? 'add'}-${i}`} className={cn(l.action === 'KEEP' && 'text-ink-muted')}>
              <td className="tabular">{l.lineNo ?? 'Nouv.'}</td>
              <td>
                <StatusPill status={l.action} labels={REVISION_ACTION_LABELS} tones={REVISION_ACTION_TONES} />
              </td>
              <td className="min-w-[160px]">
                {l.original ? (
                  <>
                    <span className={cn(l.action === 'REMOVE' && 'line-through')}>{l.original.designation}</span>
                    {l.original.reference && <span className="block text-xs text-ink-muted">Réf. {l.original.reference}</span>}
                  </>
                ) : (
                  <span className="text-xs italic text-ink-muted">— (ligne ajoutée)</span>
                )}
              </td>
              <td className="text-right tabular">{l.original ? `${fmtDecimal(l.original.quantityRequested)} ${l.original.unit}` : '—'}</td>
              <td className="text-ink-soft">
                <ArrowRight className="h-4 w-4" aria-hidden />
              </td>
              <td className="min-w-[160px]">
                {l.proposed.designation}
                {l.proposed.reference && <span className="block text-xs text-ink-muted">Réf. {l.proposed.reference}</span>}
                {l.proposed.remarks && <span className="block text-xs italic text-ink-muted">{l.proposed.remarks}</span>}
              </td>
              <td className="text-right tabular">
                {l.action === 'REMOVE' ? (
                  <span title="Quantité conservée car déjà commandée">{fmtDecimal(l.proposed.quantity)} (déjà commandé)</span>
                ) : (
                  `${fmtDecimal(l.proposed.quantity)} ${l.proposed.unit}`
                )}
              </td>
              <td className="text-right">
                <Delta value={l.quantityDelta} />
              </td>
              <td className="text-xs text-ink-muted">
                {l.current ? (
                  <>
                    Approuvé {l.current.quantityApproved !== null ? fmtDecimal(l.current.quantityApproved) : '—'}
                    {dec.gt0(l.current.quantityCancelled) ? ` · annulé ${fmtDecimal(l.current.quantityCancelled)}` : ''}
                    {l.current.status === 'CANCELLED' ? ' · ligne annulée' : ''}
                  </>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RevisionCard({ pr, rev, onChanged }: { pr: PrDetail; rev: PrRevision; onChanged: () => void }) {
  const { can, me } = useSession();
  const run = useCommand();
  const [showDiff, setShowDiff] = useState(rev.status === 'PROPOSED');
  const [dialog, setDialog] = useState<null | 'ACCEPT' | 'REJECT' | 'REQUEST_CORRECTION' | 'WITHDRAW'>(null);
  const diff = useQuery({
    queryKey: [...purKeys.pr(pr.id), 'revision-diff', rev.id],
    queryFn: () => api.get<{ lines: PrRevisionDiffLine[] }>(`/purchase-requests/${pr.id}/revisions/${rev.id}/diff`),
    enabled: showDiff,
  });
  const pending = rev.status === 'PROPOSED' && pr.status === 'REVISED';
  const isProposer = rev.proposedById === me.id;
  const changes = rev.lines.filter((l) => l.action !== 'KEEP').length;
  // Counter-PR directe (refonte 22/10/2026) : proposée et appliquée par la même personne, sans décision séparée
  const direct = rev.status === 'ACCEPTED' && rev.proposedById === rev.decidedById;
  const headerEntries = Object.entries(rev.headerChanges ?? {}) as [string, { before: string | null; after: string | null }][];

  const decide = (decision: 'ACCEPT' | 'REJECT' | 'REQUEST_CORRECTION') => async (comment: string) => {
    await run(
      () => api.post(`/purchase-requests/${pr.id}/revisions/${rev.id}/decision`, { expectedVersion: pr.lockVersion, decision, comment: comment || undefined }),
      decision === 'ACCEPT' ? 'Counter-PR acceptée : quantités de travail mises à jour' : decision === 'REJECT' ? 'Counter-PR refusée' : 'Correction demandée',
    );
    onChanged();
  };

  return (
    <div className="rounded-lg border border-line bg-white">
      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <p className="font-semibold text-navy">
            {REVISION_KIND_LABELS[rev.kind] ?? rev.kind} n°{rev.revisionNo}
            <span className="ml-2 align-middle">
              <StatusPill status={rev.status} labels={REVISION_STATUS_LABELS} tones={REVISION_STATUS_TONES} />
            </span>
          </p>
          <p className="text-xs text-ink-muted">
            {direct
              ? `Appliquée directement par ${rev.proposedByName ?? '—'} le ${fmtDateTime(rev.proposedAt)}`
              : `Proposée par ${rev.proposedByName ?? '—'} le ${fmtDateTime(rev.proposedAt)}`}{' '}
            · {changes} modification(s) de ligne{headerEntries.length ? ` · ${headerEntries.length} modification(s) d’en-tête` : ''}
            {!direct && rev.decidedAt ? ` · décidée par ${rev.decidedByName ?? '—'} le ${fmtDateTime(rev.decidedAt)}` : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setShowDiff((s) => !s)}>
            <GitCompareArrows className="h-4 w-4" aria-hidden /> {showDiff ? 'Masquer l’écart' : 'Comparer à l’origine'}
          </Button>
          {pending && can('pr.approve') && (
            <>
              <Button size="sm" onClick={() => setDialog('ACCEPT')} disabled={isProposer} title={isProposer ? 'Le proposant ne peut pas décider de sa propre Counter-PR' : undefined}>
                <CheckCircle2 className="h-4 w-4" aria-hidden /> Accepter
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setDialog('REQUEST_CORRECTION')} disabled={isProposer}>
                <RotateCcw className="h-4 w-4" aria-hidden /> Demander une correction
              </Button>
              <Button size="sm" variant="danger" onClick={() => setDialog('REJECT')} disabled={isProposer}>
                <XCircle className="h-4 w-4" aria-hidden /> Refuser
              </Button>
            </>
          )}
          {pending && can('pr.revise') && isProposer && (
            <Button size="sm" variant="ghost" onClick={() => setDialog('WITHDRAW')}>
              <Undo2 className="h-4 w-4" aria-hidden /> Retirer
            </Button>
          )}
        </div>
      </div>
      <div className="space-y-3 px-4 py-3">
        {rev.justification && (
          <p className="text-sm">
            <span className="font-medium">Justification : </span>
            <span className="whitespace-pre-line text-ink-muted">{rev.justification}</span>
          </p>
        )}
        {headerEntries.length > 0 && (
          <ul className="space-y-0.5 text-sm">
            {headerEntries.map(([field, c]) => (
              <li key={field}>
                <span className="font-medium">{HEADER_LABELS[field] ?? field} : </span>
                <span className="text-ink-muted line-through">{headerValue(field, c.before)}</span>{' '}
                <ArrowRight className="inline h-3.5 w-3.5 text-ink-soft" aria-hidden /> <span className="font-medium">{headerValue(field, c.after)}</span>
              </li>
            ))}
          </ul>
        )}
        {rev.decisionComment && !direct && (
          <p className="text-sm">
            <span className="font-medium">Décision : </span>
            <span className="whitespace-pre-line text-ink-muted">{rev.decisionComment}</span>
          </p>
        )}
        {pending && isProposer && can('pr.approve') && (
          <p className="text-xs text-ink-muted">Vous avez proposé cette Counter-PR : la décision revient à une autre personne habilitée (séparation des rôles).</p>
        )}
        {showDiff && (diff.isLoading ? <LoadingBlock rows={3} /> : diff.error ? <ErrorState error={diff.error} onRetry={() => diff.refetch()} /> : <RevisionDiffTable lines={diff.data?.lines ?? []} />)}
      </div>
      <TextActionDialog
        open={dialog === 'ACCEPT'}
        onOpenChange={(o) => !o && setDialog(null)}
        title={`Accepter la Counter-PR n°${rev.revisionNo}`}
        description="Les quantités de travail (approuvées) des lignes sont mises à jour ; la quantité demandée d’origine reste inchangée."
        confirmLabel="Accepter"
        onConfirm={decide('ACCEPT')}
      />
      <TextActionDialog
        open={dialog === 'REQUEST_CORRECTION'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Demander une correction"
        label="Correction attendue"
        required
        confirmLabel="Demander la correction"
        onConfirm={decide('REQUEST_CORRECTION')}
      />
      <TextActionDialog open={dialog === 'REJECT'} onOpenChange={(o) => !o && setDialog(null)} title="Refuser la Counter-PR" label="Motif du refus" required confirmLabel="Refuser" tone="danger" onConfirm={decide('REJECT')} />
      <TextActionDialog
        open={dialog === 'WITHDRAW'}
        onOpenChange={(o) => !o && setDialog(null)}
        title="Retirer ma Counter-PR"
        confirmLabel="Retirer"
        onConfirm={async (comment) => {
          await run(() => api.post(`/purchase-requests/${pr.id}/revisions/${rev.id}/withdraw`, { expectedVersion: pr.lockVersion, comment: comment || undefined }), 'Counter-PR retirée');
          onChanged();
        }}
      />
    </div>
  );
}

interface DraftLine {
  prLineId: string;
  /** REPLACE = retrait de la ligne + nouvel article (autre désignation / référence / unité) */
  action: Exclude<RevisionAction, 'ADD'> | 'REPLACE';
  quantity: string;
  remarks: string;
  designation: string;
  reference: string;
  unit: string;
}
/** Ligne de révision envoyée à l'API (POST /purchase-requests/:id/counter). */
interface RevisionLinePayload {
  action: RevisionAction;
  prLineId?: string;
  quantity?: string;
  designation?: string;
  reference?: string;
  unit?: string;
  remarks?: string;
}
interface AddLine {
  key: string;
  designation: string;
  reference: string;
  quantity: string;
  unit: string;
  remarks: string;
}

/**
 * Counter-PR appliquée directement (décision « Counter-PR » en discussion) : quantités, retraits, remplacements,
 * ajouts et en-tête (date de besoin, priorité, objet, catégorie). Motif facultatif ; le demandeur est notifié du
 * détail ; l'avant / après est conservé dans l'onglet Counter-PR.
 */
export function CounterForm({ pr, onDone }: { pr: PrDetail; onDone: (applied: boolean) => void }) {
  const run = useCommand();
  const [justification, setJustification] = useState('');
  const [lines, setLines] = useState<DraftLine[]>(() =>
    pr.lines
      .filter((l) => l.status !== 'CANCELLED')
      .map((l) => ({ prLineId: l.id, action: 'KEEP', quantity: '', remarks: '', designation: l.designation, reference: l.reference ?? '', unit: l.unit })),
  );
  const [adds, setAdds] = useState<AddLine[]>([]);
  const [header, setHeader] = useState({ neededBy: toDateInput(pr.neededBy), priority: pr.priority as string, subject: pr.subject, category: pr.category });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(pr.lines.map((l) => [l.id, l])), [pr.lines]);

  const lineErrors = lines.map((d) => {
    if (d.action !== 'CHANGE' && d.action !== 'REPLACE') return null;
    const l = byId.get(d.prLineId)!;
    if (d.action === 'REPLACE') {
      if (!d.designation.trim()) return 'Désignation obligatoire';
      if (!d.unit.trim()) return 'Unité obligatoire';
      if (dec.gt0(l.progress?.allocated ?? '0')) return 'Ligne déjà commandée : remplacement impossible';
    }
    const err = decimalError(d.quantity, { required: true, positive: true, scale: 3 });
    if (err) return err;
    const allocated = l.progress?.allocated ?? '0';
    if (d.action === 'CHANGE' && dec.cmp(toApiDecimal(d.quantity), allocated) < 0) return `≥ ${fmtDecimal(allocated)} (déjà commandé)`;
    return null;
  });
  const addErrors = adds.map((a) => {
    if (!a.designation.trim()) return 'Désignation obligatoire';
    if (!a.unit.trim()) return 'Unité obligatoire';
    return decimalError(a.quantity, { required: true, positive: true, scale: 3 });
  });
  const headerPayload: Record<string, string | null> = {};
  if (header.neededBy !== toDateInput(pr.neededBy)) headerPayload.neededBy = header.neededBy || null;
  if (header.priority !== pr.priority) headerPayload.priority = header.priority;
  if (header.subject.trim() && header.subject.trim() !== pr.subject) headerPayload.subject = header.subject.trim();
  if (header.category.trim() && header.category.trim() !== pr.category) headerPayload.category = header.category.trim();
  const headerCount = Object.keys(headerPayload).length;
  const changeCount = lines.filter((l) => l.action !== 'KEEP').length + adds.length;
  const canSubmit = changeCount + headerCount > 0 && lineErrors.every((e) => !e) && addErrors.every((e) => !e);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await run(
        () =>
          api.post(`/purchase-requests/${pr.id}/counter`, {
            expectedVersion: pr.lockVersion,
            justification: justification.trim() || undefined,
            header: headerPayload,
            lines: [
              ...lines.flatMap((l): RevisionLinePayload[] => {
                if (l.action === 'KEEP') return [];
                if (l.action === 'REPLACE') {
                  return [
                    { action: 'REMOVE', prLineId: l.prLineId, remarks: 'Remplacée (Counter-PR)' },
                    {
                      action: 'ADD',
                      designation: l.designation.trim(),
                      reference: l.reference.trim() || undefined,
                      quantity: toApiDecimal(l.quantity),
                      unit: l.unit.trim(),
                      remarks: l.remarks.trim() || undefined,
                    },
                  ];
                }
                return [{ action: l.action, prLineId: l.prLineId, quantity: l.action === 'CHANGE' ? toApiDecimal(l.quantity) : undefined, remarks: l.remarks.trim() || undefined }];
              }),
              ...adds.map((a) => ({
                action: 'ADD',
                designation: a.designation.trim(),
                reference: a.reference.trim() || undefined,
                quantity: toApiDecimal(a.quantity),
                unit: a.unit.trim(),
                remarks: a.remarks.trim() || undefined,
              })),
            ],
          }),
        'Counter-PR appliquée. Prochaine étape : « Continuer » (valider la PR modifiée) ou « Diviser », en haut de la page.',
      );
      onDone(true);
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  const set = (i: number, patch: Partial<DraftLine>) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <Panel title="Counter-PR — modifier la demande">
      <p className="mb-3 text-sm text-ink-muted">
        Les modifications s’appliquent immédiatement et le demandeur est notifié avec le détail. La demande d’origine reste consultable (avant / après) dans
        l’onglet Counter-PR. Une quantité ne peut pas descendre sous la quantité déjà commandée.
      </p>
      <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FormField label="Date de besoin">
          <Input type="date" value={header.neededBy} onChange={(e) => setHeader((h) => ({ ...h, neededBy: e.target.value }))} />
        </FormField>
        <FormField label="Priorité">
          <Select value={header.priority} onChange={(e) => setHeader((h) => ({ ...h, priority: e.target.value }))}>
            {Object.entries(PRIORITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="Catégorie">
          <Input value={header.category} onChange={(e) => setHeader((h) => ({ ...h, category: e.target.value }))} maxLength={120} />
        </FormField>
        <FormField label="Objet">
          <Input value={header.subject} onChange={(e) => setHeader((h) => ({ ...h, subject: e.target.value }))} maxLength={300} />
        </FormField>
      </div>
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="table-amc">
          <thead>
            <tr>
              <th scope="col">N°</th>
              <th scope="col">Article</th>
              <th scope="col" className="text-right">
                Qté actuelle
              </th>
              <th scope="col" className="text-right">
                Déjà commandé
              </th>
              <th scope="col">Action</th>
              <th scope="col" className="text-right">
                Nouvelle qté
              </th>
              <th scope="col">Remarque</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((d, i) => {
              const l = byId.get(d.prLineId)!;
              return (
                <tr key={d.prLineId} className={cn(d.action !== 'KEEP' && 'bg-warn-bg/30')}>
                  <td className="tabular">{l.lineNo}</td>
                  <td className="min-w-[200px]">
                    {d.action === 'REPLACE' ? (
                      <div className="space-y-1">
                        <span className="block text-xs text-ink-muted line-through">
                          {l.designation}
                          {l.reference ? ` · réf. ${l.reference}` : ''}
                        </span>
                        <Input value={d.designation} onChange={(e) => set(i, { designation: e.target.value })} placeholder="Nouvelle désignation" className="h-8 text-sm" aria-label={`Nouvelle désignation ligne ${l.lineNo}`} maxLength={500} />
                        <div className="flex gap-1">
                          <Input value={d.reference} onChange={(e) => set(i, { reference: e.target.value })} placeholder="Référence" className="h-8 text-sm" aria-label={`Nouvelle référence ligne ${l.lineNo}`} maxLength={200} />
                          <Input value={d.unit} list="revision-units" onChange={(e) => set(i, { unit: e.target.value })} className="h-8 w-24 text-sm" aria-label={`Unité ligne ${l.lineNo}`} maxLength={32} />
                        </div>
                      </div>
                    ) : (
                      <>
                        {l.designation}
                        {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                      </>
                    )}
                  </td>
                  <td className="text-right tabular">
                    {fmtDecimal(l.progress?.effective ?? l.quantityApproved ?? l.quantityRequested)} {l.unit}
                  </td>
                  <td className="text-right tabular">{fmtDecimal(l.progress?.allocated ?? '0')}</td>
                  <td>
                    <Select
                      value={d.action}
                      aria-label={`Action ligne ${l.lineNo}`}
                      className="h-8 w-40 text-sm"
                      onChange={(e) => {
                        const action = e.target.value as DraftLine['action'];
                        set(i, { action, quantity: action === 'REPLACE' && !d.quantity ? (l.progress?.effective ?? l.quantityRequested) : d.quantity });
                      }}
                    >
                      <option value="KEEP">Conserver</option>
                      <option value="CHANGE">Modifier la quantité</option>
                      <option value="REPLACE">Remplacer l’article</option>
                      <option value="REMOVE">Retirer</option>
                    </Select>
                  </td>
                  <td className="w-32 text-right">
                    {d.action === 'CHANGE' || d.action === 'REPLACE' ? (
                      <>
                        <DecimalInput value={d.quantity} onChange={(v) => set(i, { quantity: v })} invalid={!!lineErrors[i]} ariaLabel={`Nouvelle quantité ligne ${l.lineNo}`} className="h-8" />
                        {lineErrors[i] && <span className="text-xs text-danger">{lineErrors[i]}</span>}
                      </>
                    ) : d.action === 'REMOVE' ? (
                      <span className="text-xs text-danger">Non commandé annulé</span>
                    ) : (
                      <span className="text-xs text-ink-muted">—</span>
                    )}
                  </td>
                  <td className="min-w-[160px]">
                    <Input value={d.remarks} onChange={(e) => set(i, { remarks: e.target.value })} className="h-8 text-sm" aria-label={`Remarque ligne ${l.lineNo}`} maxLength={1000} disabled={d.action === 'KEEP'} />
                  </td>
                </tr>
              );
            })}
            {adds.map((a, i) => (
              <tr key={a.key} className="bg-info-bg/40">
                <td>
                  <Badge tone="info">Ajout</Badge>
                </td>
                <td className="min-w-[200px]">
                  <Input
                    value={a.designation}
                    onChange={(e) => setAdds((prev) => prev.map((x, j) => (j === i ? { ...x, designation: e.target.value } : x)))}
                    placeholder="Désignation"
                    className="h-8 text-sm"
                    aria-label="Désignation de la ligne ajoutée"
                    maxLength={500}
                  />
                  <Input
                    value={a.reference}
                    onChange={(e) => setAdds((prev) => prev.map((x, j) => (j === i ? { ...x, reference: e.target.value } : x)))}
                    placeholder="Référence (facultatif)"
                    className="mt-1 h-8 text-sm"
                    aria-label="Référence de la ligne ajoutée"
                    maxLength={200}
                  />
                </td>
                <td colSpan={2}>
                  <Input
                    value={a.unit}
                    list="revision-units"
                    onChange={(e) => setAdds((prev) => prev.map((x, j) => (j === i ? { ...x, unit: e.target.value } : x)))}
                    className="h-8 w-24 text-sm"
                    aria-label="Unité de la ligne ajoutée"
                    maxLength={32}
                  />
                </td>
                <td>
                  <IconButton label="Supprimer l’ajout" onClick={() => setAdds((prev) => prev.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </td>
                <td className="w-32">
                  <DecimalInput
                    value={a.quantity}
                    onChange={(v) => setAdds((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: v } : x)))}
                    invalid={!!addErrors[i] && !!a.quantity}
                    ariaLabel="Quantité ajoutée"
                    className="h-8"
                  />
                </td>
                <td>
                  <Input
                    value={a.remarks}
                    onChange={(e) => setAdds((prev) => prev.map((x, j) => (j === i ? { ...x, remarks: e.target.value } : x)))}
                    className="h-8 text-sm"
                    aria-label="Remarque de la ligne ajoutée"
                    maxLength={1000}
                  />
                  {addErrors[i] && (a.designation || a.quantity) && <span className="text-xs text-danger">{addErrors[i]}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <datalist id="revision-units">
          {COMMON_UNITS.map((u) => (
            <option key={u} value={u} />
          ))}
        </datalist>
      </div>
      <Button
        variant="secondary"
        size="sm"
        className="mt-2"
        onClick={() => setAdds((prev) => [...prev, { key: `${Date.now()}-${prev.length}`, designation: '', reference: '', quantity: '', unit: 'pcs', remarks: '' }])}
      >
        <Plus className="h-4 w-4" aria-hidden /> Ajouter un article
      </Button>
      <div className="mt-4">
        <FormField label="Motif (facultatif)" hint="Visible du demandeur (notification et e-mail) et conservé avec la révision.">
          <Textarea rows={2} value={justification} onChange={(e) => setJustification(e.target.value)} maxLength={5000} className="min-h-[60px]" />
        </FormField>
      </div>
      {error && <Callout tone="danger" className="mt-3" title="Counter-PR refusée">{error}</Callout>}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" onClick={() => onDone(false)}>
          Annuler
        </Button>
        <Button onClick={submit} disabled={!canSubmit} loading={busy}>
          Appliquer la Counter-PR ({changeCount + headerCount} modification{changeCount + headerCount > 1 ? 's' : ''})
        </Button>
      </div>
    </Panel>
  );
}

/** Onglet Counter-PR d'une PR : Counter-PR appliquées (avant / après), anciennes propositions et leurs décisions. */
export function PrRevisionsTab({
  pr,
  onChanged,
  startOpen = false,
  onFormClosed,
  onApplied,
  nextStep,
}: {
  pr: PrDetail;
  onChanged: () => void;
  startOpen?: boolean;
  onFormClosed?: () => void;
  /** Après une Counter-PR appliquée (ex. retour en haut de page, sur le panneau de décision) */
  onApplied?: () => void;
  /** Rappel de la prochaine étape affiché au-dessus de l'historique (PR encore en discussion) */
  nextStep?: ReactNode;
}) {
  const { can, me } = useSession();
  const [open, setOpen] = useState(startOpen);
  // Ouverture depuis le panneau de décision alors que l'onglet est déjà affiché
  useEffect(() => {
    if (startOpen) setOpen(true);
  }, [startOpen]);
  const q = useQuery({
    queryKey: [...purKeys.pr(pr.id), 'revisions', pr.lockVersion],
    queryFn: () => api.get<PrRevision[]>(`/purchase-requests/${pr.id}/revisions`),
  });
  const hasPending = (q.data ?? []).some((r) => r.status === 'PROPOSED');
  const isRequester = pr.requesterId === me.id;
  const canCounter = can('pr.revise') && REVISABLE.includes(pr.status) && !hasPending && !isRequester;
  const close = (applied: boolean) => {
    setOpen(false);
    onFormClosed?.();
    if (applied) {
      onChanged();
      onApplied?.();
    }
  };

  return (
    <div className="space-y-4">
      {!open && canCounter && (
        <div className="flex justify-end">
          <Button variant={nextStep ? 'secondary' : 'primary'} onClick={() => setOpen(true)}>
            <GitCompareArrows className="h-4 w-4" aria-hidden /> {pr.currentRevisionNo > 0 ? 'Modifier à nouveau (Counter-PR)' : 'Appliquer une Counter-PR'}
          </Button>
        </div>
      )}
      {!open && nextStep}
      {open && canCounter && <CounterForm pr={pr} onDone={close} />}
      {q.isLoading && <LoadingBlock rows={3} />}
      {q.error && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !q.data.length && !open && (
        <EmptyState
          title="Aucune Counter-PR"
          description={
            canCounter
              ? 'Les Achats peuvent modifier quantités, articles et date de besoin ; le demandeur est notifié et la demande d’origine reste consultable.'
              : `Aucune modification des Achats sur cette PR (${PR_STATUS_LABELS[pr.status] ?? pr.status}).`
          }
        />
      )}
      {q.data?.map((rev) => (
        <RevisionCard key={rev.id} pr={pr} rev={rev} onChanged={onChanged} />
      ))}
    </div>
  );
}
