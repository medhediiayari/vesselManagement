'use client';

import { Plus, Split, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { cn, fmtDecimal } from '@/lib/format';
import { Button, IconButton } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Textarea } from '@/components/ui/field';
import { commandError, dec, useCommand } from './lib';
import type { PrDetail } from './types';
import { Callout, FormField } from './ui';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

interface Group {
  key: string;
  label: string;
}

/**
 * Décision « Diviser » (vaut validation) : chaque ligne ENTIÈRE est affectée à une sous-PR (une par fournisseur
 * visé). Les sous-PR sont créées validées (<n°>-A, -B…) ; la PR mère passe « Divisée » en lecture seule.
 */
export function PrSplitDialog({ pr, open, onOpenChange, onDone }: { pr: PrDetail; open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const run = useCommand();
  const active = useMemo(() => pr.lines.filter((l) => l.status !== 'CANCELLED' && dec.gt0(l.progress?.effective ?? l.quantityApproved ?? l.quantityRequested)), [pr.lines]);
  const [groups, setGroups] = useState<Group[]>([
    { key: 'g0', label: '' },
    { key: 'g1', label: '' },
  ]);
  // Ligne → index de sous-PR (par défaut toutes en A : l'acheteur déplace celles du second fournisseur)
  const [assign, setAssign] = useState<Record<string, number>>(() => Object.fromEntries(active.map((l) => [l.id, 0])));
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = groups.map((_, i) => active.filter((l) => assign[l.id] === i).length);
  const nonEmpty = counts.filter((c) => c > 0).length;
  const valid = nonEmpty >= 2;
  // Les sous-PR sont numérotées dans l'ordre des groupes NON vides (A, B… sans trou) : un groupe vide prend la
  // lettre qu'il aurait s'il recevait une ligne.
  const suffixOf = (i: number) => LETTERS[counts.slice(0, i).filter((c) => c > 0).length];

  const removeGroup = (i: number) => {
    setGroups((g) => g.filter((_, j) => j !== i));
    setAssign((a) => Object.fromEntries(Object.entries(a).map(([id, g]) => [id, g === i ? 0 : g > i ? g - 1 : g])));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await run(
        () =>
          api.post(`/purchase-requests/${pr.id}/split`, {
            expectedVersion: pr.lockVersion,
            comment: comment.trim() || undefined,
            groups: groups.map((g, i) => ({ lineIds: active.filter((l) => assign[l.id] === i).map((l) => l.id), label: g.label.trim() || undefined })),
          }),
        `PR ${pr.number} divisée en ${nonEmpty} sous-PR`,
      );
      onOpenChange(false);
      onDone();
    } catch (e) {
      setError(commandError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`Diviser la PR ${pr.number}`}
      description="Une sous-PR par fournisseur visé, lignes entières uniquement. Chaque sous-PR est validée et suit son propre BC puis son propre BL ; la PR d’origine reste consultable en lecture seule."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} disabled={!valid} loading={busy}>
            <Split className="h-4 w-4" aria-hidden /> Créer {nonEmpty} sous-PR
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          {groups.map((g, i) => {
            const suffix = suffixOf(i);
            return (
              <div key={g.key} className={cn('rounded-md border px-3 py-2', counts[i] ? 'border-navy-100 bg-navy-50' : 'border-dashed border-line')}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-navy">
                    Sous-PR <span className="ref">{`${pr.number}-${suffix}`}</span>
                    {!counts[i] && <span className="ml-1 font-normal text-ink-muted">(vide)</span>}
                  </p>
                  <span className="text-xs tabular text-ink-muted">{counts[i]} ligne(s)</span>
                  {groups.length > 2 && (
                    <IconButton label={`Supprimer la sous-PR ${suffix}`} onClick={() => removeGroup(i)}>
                      <Trash2 className="h-4 w-4" />
                    </IconButton>
                  )}
                </div>
                <Input
                  value={g.label}
                  onChange={(e) => setGroups((prev) => prev.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                  placeholder="Fournisseur visé (facultatif)"
                  aria-label={`Fournisseur visé, groupe ${i + 1}`}
                  className="mt-1 h-8 text-sm"
                  maxLength={120}
                />
              </div>
            );
          })}
        </div>
        {groups.length < LETTERS.length && groups.length < active.length && (
          <Button variant="secondary" size="sm" onClick={() => setGroups((g) => [...g, { key: `g${Date.now()}`, label: '' }])}>
            <Plus className="h-4 w-4" aria-hidden /> Ajouter une sous-PR
          </Button>
        )}

        <div className="overflow-x-auto rounded-md border border-line">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">N°</th>
                <th scope="col">Article</th>
                <th scope="col" className="text-right">
                  Quantité
                </th>
                <th scope="col">Sous-PR</th>
              </tr>
            </thead>
            <tbody>
              {active.map((l) => (
                <tr key={l.id}>
                  <td className="tabular">{l.lineNo}</td>
                  <td className="min-w-[180px]">
                    {l.designation}
                    {l.reference && <span className="block text-xs text-ink-muted">Réf. {l.reference}</span>}
                  </td>
                  <td className="text-right tabular">
                    {fmtDecimal(l.progress?.effective ?? l.quantityApproved ?? l.quantityRequested)} {l.unit}
                  </td>
                  <td>
                    <div role="radiogroup" aria-label={`Sous-PR de la ligne ${l.lineNo}`} className="flex flex-wrap gap-1">
                      {groups.map((g, i) => {
                        const selected = assign[l.id] === i;
                        return (
                          <button
                            key={g.key}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            onClick={() => setAssign((a) => ({ ...a, [l.id]: i }))}
                            title={g.label || `Sous-PR ${suffixOf(i)}`}
                            className={cn(
                              'min-w-[2.25rem] rounded border px-2 py-1 text-xs font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-action',
                              selected ? 'border-navy bg-navy text-white' : 'border-line bg-white text-ink-muted hover:border-navy-600',
                            )}
                          >
                            {suffixOf(i)}
                            {g.label ? <span className="ml-1 hidden font-normal sm:inline">{g.label.slice(0, 14)}</span> : null}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pr.lines.length > active.length && (
          <p className="text-xs text-ink-muted">Les lignes annulées par Counter-PR restent sur la PR d’origine et ne sont pas reprises.</p>
        )}
        {!valid && <Callout tone="info">Affectez au moins une ligne à une deuxième sous-PR.</Callout>}
        <FormField label="Commentaire" hint="Facultatif — visible du demandeur, conservé dans la discussion.">
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} className="min-h-[56px]" />
        </FormField>
        {error && <Callout tone="danger" title="Division refusée">{error}</Callout>}
      </div>
    </Dialog>
  );
}
