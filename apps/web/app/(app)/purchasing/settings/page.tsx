'use client';

import { PERMISSIONS } from '@amc/types';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, BellRing, Plus, Save, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { cn, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { PageHeader, Panel } from '@/components/ui/page';
import { ErrorState, Forbidden, LoadingBlock } from '@/components/ui/states';
import { CurrencyInput } from '@/components/purchasing/manual-po-dialog';
import { PRIORITY_LABELS, commandError, decimalError, purKeys, toApiDecimal, useCommand } from '@/components/purchasing/lib';
import type { ApprovalThreshold, PrPriority, PurchasingConfig, ReviewRuleDef } from '@/components/purchasing/types';
import { Callout, DecimalInput, FormField, Money } from '@/components/purchasing/ui';

const PURCHASING_PERMS = PERMISSIONS.filter((p) => p.module === 'purchasing' && /^(pr|bc|rfq|quotation)\./.test(p.key));
const csv = (v: string[] | undefined) => (v ?? []).join(', ');
const parseCsv = (v: string) =>
  v
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const codeOk = (v: string) => /^[A-Z0-9_]{2,40}$/.test(v);

/** Liste séparée par des virgules : texte libre pendant la saisie, analysé à la sortie du champ. */
function CsvInput({ value, onChange, upper, placeholder, ariaLabel }: { value: string[] | undefined; onChange: (v: string[]) => void; upper?: boolean; placeholder?: string; ariaLabel: string }) {
  const [text, setText] = useState(csv(value));
  const [focused, setFocused] = useState(false);
  const joined = csv(value);
  useEffect(() => {
    if (!focused) setText(joined);
  }, [joined, focused]);
  return (
    <Input
      value={text}
      placeholder={placeholder}
      aria-label={ariaLabel}
      className="h-8 text-sm"
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(upper ? e.target.value.toUpperCase() : e.target.value)}
      onBlur={() => {
        setFocused(false);
        onChange(parseCsv(text));
      }}
    />
  );
}

export default function PurchasingSettingsPage() {
  const { can } = useSession();
  const config = useQuery({ queryKey: purKeys.config, queryFn: () => api.get<PurchasingConfig>('/purchasing/config'), enabled: can('settings.manage') });
  const thresholds = useQuery({ queryKey: [...purKeys.config, 'thresholds'], queryFn: () => api.get<ApprovalThreshold[]>('/purchasing/approval-thresholds'), enabled: can('settings.manage') });
  if (!can('settings.manage')) return <Forbidden message="Le paramétrage Achats requiert la permission settings.manage." />;
  if (config.isLoading) return <LoadingBlock rows={8} />;
  if (config.error || !config.data) return <ErrorState error={config.error} onRetry={() => config.refetch()} />;
  const c = config.data;
  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Paramétrage' }]}
        title="Paramétrage Achats"
        description="Hypothèses configurables (CDC §17) : référence du formulaire PR, circuits de revue des PR, mode d’approbation des BC et seuils financiers par devise. Chaque modification est auditée."
        actions={<FollowupButton />}
      />
      <div className="space-y-5">
        <Panel title="Notes">
          <ul className="list-inside list-disc space-y-1 text-sm text-ink-muted">
            {c.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
            <li>
              Sur-allocation (paramètre système purchasing.allowOverAllocation) : actuellement{' '}
              <span className="font-medium text-ink">{c.allowOverAllocation ? 'autorisée avec motif et second regard' : 'interdite'}</span> —{' '}
              <Link href="/admin/settings" className="text-action hover:underline">
                paramètres système
              </Link>
              .
            </li>
          </ul>
        </Panel>
        <PrFormRefPanel value={c.prFormRef} />
        <ApprovalModePanel mode={c.poApprovalMode} />
        <ThresholdsPanel rows={thresholds.data ?? c.poThresholds} loading={thresholds.isLoading} />
        <CircuitsPanel initial={c.reviewCircuits.rules} source={c.reviewCircuits.source} />
      </div>
    </>
  );
}

function FollowupButton() {
  const run = useCommand();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const r = await run(() => api.post<Record<string, number>>('/purchasing/followup/run'));
          toast.success(`Relances exécutées : ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(', ')}`);
        } catch (e) {
          toast.error(commandError(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      <BellRing className="h-4 w-4" aria-hidden /> Lancer les relances maintenant
    </Button>
  );
}

/** Référence du modèle de formulaire PR (système qualité), recopiée automatiquement dans chaque nouvelle PR. */
function PrFormRefPanel({ value: current }: { value: string }) {
  const run = useCommand();
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(current), [current]);
  const trimmed = value.trim();
  const error = trimmed.length < 2 ? '2 caractères minimum' : null;
  return (
    <Panel title="Formulaire de demande d’achat (PR)">
      <FormField
        label="Référence du formulaire"
        required
        error={value !== current ? (error ?? undefined) : undefined}
        hint="Recopiée automatiquement dans chaque nouvelle PR. Les PR existantes gardent la référence en vigueur à leur création."
        className="md:max-w-md"
      >
        <Input value={value} onChange={(e) => setValue(e.target.value)} maxLength={80} placeholder="ex. FORM 41 - Rev N°00" />
      </FormField>
      <div className="mt-3 flex justify-end">
        <Button
          disabled={!!error || trimmed === current}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await run(() => api.put('/purchasing/config/pr-form-ref', { formRef: trimmed }), 'Référence du formulaire PR enregistrée');
            } catch (e) {
              toast.error(commandError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save className="h-4 w-4" aria-hidden /> Enregistrer
        </Button>
      </div>
    </Panel>
  );
}

function ApprovalModePanel({ mode }: { mode: 'THRESHOLD_ONLY' | 'ALWAYS' }) {
  const run = useCommand();
  const [value, setValue] = useState(mode);
  const [busy, setBusy] = useState(false);
  useEffect(() => setValue(mode), [mode]);
  return (
    <Panel title="Approbation des bons de commande">
      <fieldset className="space-y-2">
        <legend className="sr-only">Mode d’approbation</legend>
        {(
          [
            [
              'THRESHOLD_ONLY',
              'Selon seuil par devise (défaut)',
              'Second regard si le total atteint le seuil actif de la devise du BC. Sans aucun seuil configuré : pas de second regard. Si des seuils existent mais aucun pour la devise du BC : second regard exigé.',
            ],
            ['ALWAYS', 'Tout BC', 'Chaque BC doit être approuvé par une seconde personne (bc.approve), quel que soit le montant.'],
          ] as const
        ).map(([k, label, hint]) => (
          <label key={k} className={cn('flex cursor-pointer gap-3 rounded-md border px-3 py-2', value === k ? 'border-action bg-action-50' : 'border-line')}>
            <input type="radio" name="po-mode" className="mt-1" checked={value === k} onChange={() => setValue(k)} />
            <span>
              <span className="block text-sm font-medium">{label}</span>
              <span className="block text-xs text-ink-muted">{hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="mt-3 flex justify-end">
        <Button
          disabled={value === mode}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await run(() => api.put('/purchasing/config/po-approval-mode', { mode: value }), 'Mode d’approbation enregistré');
            } catch (e) {
              toast.error(commandError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save className="h-4 w-4" aria-hidden /> Enregistrer
        </Button>
      </div>
    </Panel>
  );
}

function ThresholdsPanel({ rows, loading }: { rows: ApprovalThreshold[]; loading: boolean }) {
  const run = useCommand();
  const [f, setF] = useState({ currency: '', amount: '', requiresSecondApproval: true, isActive: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const amountErr = f.amount ? decimalError(f.amount, { required: true, scale: 2 }) : null;
  const save = async (row: { currency: string; amount: string; requiresSecondApproval: boolean; isActive: boolean }) => {
    setBusy(true);
    setError(null);
    try {
      await run(() => api.put('/purchasing/approval-thresholds', row), `Seuil ${row.currency} enregistré`);
      return true;
    } catch (e) {
      setError(commandError(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const active = rows.filter((r) => r.isActive);
  return (
    <Panel title="Seuils de second regard par devise">
      <Callout tone="warn" className="mb-3" title="Aucune valeur n’est pré-remplie : les seuils sont une décision AMC">
        Les montants (et devises concernées) doivent être arrêtés par AMC avant mise en production. Aucun taux de change n’est appliqué : un seuil ne s’applique qu’aux BC de sa devise. Dès qu’un seuil
        actif existe, un BC dans une devise sans seuil exige un second regard.
      </Callout>
      {loading ? (
        <LoadingBlock rows={2} />
      ) : rows.length ? (
        <div className="mb-4 overflow-x-auto">
          <table className="table-amc">
            <thead>
              <tr>
                <th scope="col">Devise</th>
                <th scope="col" className="text-right">
                  Seuil
                </th>
                <th scope="col">Second regard</th>
                <th scope="col">État</th>
                <th scope="col">Mis à jour</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.currency}>
                  <td className="font-medium">{r.currency}</td>
                  <td className="text-right">
                    <Money value={r.amount} currency={r.currency} />
                  </td>
                  <td>{r.requiresSecondApproval ? <Badge tone="warn">Requis au-delà du seuil</Badge> : <Badge tone="neutral">Non</Badge>}</td>
                  <td>{r.isActive ? <Badge tone="ok">Actif</Badge> : <Badge tone="neutral">Inactif</Badge>}</td>
                  <td className="text-xs text-ink-muted">{r.updatedAt ? fmtDateTime(r.updatedAt) : '—'}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setF({ currency: r.currency, amount: r.amount, requiresSecondApproval: r.requiresSecondApproval, isActive: r.isActive })}>
                      Modifier
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      loading={busy}
                      onClick={() => save({ currency: r.currency, amount: r.amount, requiresSecondApproval: r.requiresSecondApproval, isActive: !r.isActive })}
                    >
                      {r.isActive ? 'Désactiver' : 'Activer'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-1 text-xs text-ink-muted">{active.length ? `${active.length} seuil(s) actif(s).` : 'Aucun seuil actif : aucun second regard n’est exigé en mode « selon seuil ».'}</p>
        </div>
      ) : (
        <p className="mb-4 text-sm text-ink-muted">Aucun seuil configuré (situation par défaut).</p>
      )}
      <div className="grid items-end gap-3 rounded-md border border-dashed border-line-strong p-3 md:grid-cols-[120px_180px_auto_auto_auto]">
        <FormField label="Devise" required>
          <CurrencyInput value={f.currency} onChange={(v) => setF((x) => ({ ...x, currency: v }))} />
        </FormField>
        <FormField label="Montant du seuil" required error={amountErr ?? undefined}>
          <DecimalInput value={f.amount} onChange={(v) => setF((x) => ({ ...x, amount: v }))} placeholder="Décision AMC" />
        </FormField>
        <Checkbox label="Second regard requis" checked={f.requiresSecondApproval} onChange={(e) => setF((x) => ({ ...x, requiresSecondApproval: e.target.checked }))} />
        <Checkbox label="Actif" checked={f.isActive} onChange={(e) => setF((x) => ({ ...x, isActive: e.target.checked }))} />
        <Button
          disabled={!/^[A-Z]{3}$/.test(f.currency) || !f.amount || !!amountErr}
          loading={busy}
          onClick={async () => {
            if (await save({ ...f, amount: toApiDecimal(f.amount) })) setF({ currency: '', amount: '', requiresSecondApproval: true, isActive: true });
          }}
        >
          <Save className="h-4 w-4" aria-hidden /> Enregistrer le seuil
        </Button>
      </div>
      {error && (
        <Callout tone="danger" className="mt-3">
          {error}
        </Callout>
      )}
    </Panel>
  );
}

function CircuitsPanel({ initial, source }: { initial: ReviewRuleDef[]; source: 'DEFAULT' | 'SETTINGS' }) {
  const run = useCommand();
  const { me } = useSession();
  const [rules, setRules] = useState<ReviewRuleDef[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRules(initial), [initial]);
  const patchRule = (i: number, p: Partial<ReviewRuleDef>) => setRules((prev) => prev.map((r, j) => (j === i ? { ...r, ...p } : r)));
  const patchMatch = (i: number, p: Partial<ReviewRuleDef['match']>) => setRules((prev) => prev.map((r, j) => (j === i ? { ...r, match: { ...r.match, ...p } } : r)));
  const patchStep = (i: number, k: number, p: Partial<ReviewRuleDef['steps'][number]>) =>
    setRules((prev) => prev.map((r, j) => (j === i ? { ...r, steps: r.steps.map((s, m) => (m === k ? { ...s, ...p } : s)) } : r)));
  const move = (i: number, d: -1 | 1) =>
    setRules((prev) => {
      const j = i + d;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const issues: string[] = [];
  const ids = new Set<string>();
  rules.forEach((r, i) => {
    if (!codeOk(r.id)) issues.push(`Règle ${i + 1} : identifiant A-Z 0-9 _ (2 à 40)`);
    if (ids.has(r.id)) issues.push(`Règle ${i + 1} : identifiant dupliqué`);
    ids.add(r.id);
    if (r.label.trim().length < 2) issues.push(`Règle ${i + 1} : libellé requis`);
    if (!r.steps.length) issues.push(`Règle ${i + 1} : au moins une étape`);
    if (r.steps.length && r.steps[r.steps.length - 1].permission !== 'pr.approve') issues.push(`Règle ${i + 1} : la dernière étape doit exiger pr.approve`);
    r.steps.forEach((s, k) => {
      if (!codeOk(s.key)) issues.push(`Règle ${i + 1}, étape ${k + 1} : clé A-Z 0-9 _`);
      if (s.label.trim().length < 2) issues.push(`Règle ${i + 1}, étape ${k + 1} : libellé requis`);
    });
  });

  return (
    <Panel
      title="Circuits de revue des PR"
      actions={<span className="text-xs text-ink-muted">{source === 'DEFAULT' ? 'Circuits par défaut (aucun paramétrage enregistré)' : 'Circuits paramétrés'}</span>}
    >
      <p className="mb-3 text-sm text-ink-muted">
        Règles évaluées dans l’ordre : la première qui correspond s’applique et est figée sur la PR à la soumission. La dernière étape est toujours l’approbation Purchasing (pr.approve). Par défaut,
        une PR du Chief Engineer ne requiert pas le visa du Captain (PUR-01) ; un visa Master se configure par une étape intermédiaire réservée au rôle CAPTAIN.
      </p>
      <ol className="space-y-3">
        {rules.map((r, i) => (
          <li key={i} className="rounded-lg border border-line p-3">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-semibold text-navy">
                {i + 1}. {r.label || 'Nouvelle règle'}
              </p>
              <div className="flex">
                <IconButton label="Monter" onClick={() => move(i, -1)} disabled={i === 0}>
                  <ArrowUp className="h-4 w-4" />
                </IconButton>
                <IconButton label="Descendre" onClick={() => move(i, 1)} disabled={i === rules.length - 1}>
                  <ArrowDown className="h-4 w-4" />
                </IconButton>
                <IconButton label="Supprimer la règle" onClick={() => setRules((prev) => prev.filter((_, j) => j !== i))} disabled={rules.length === 1} className="hover:text-danger">
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
            <div className="grid gap-2 md:grid-cols-[180px_minmax(0,1fr)]">
              <FormField label="Identifiant">
                <Input value={r.id} onChange={(e) => patchRule(i, { id: e.target.value.toUpperCase() })} className="h-8 text-sm" />
              </FormField>
              <FormField label="Libellé">
                <Input value={r.label} onChange={(e) => patchRule(i, { label: e.target.value })} className="h-8 text-sm" maxLength={200} />
              </FormField>
            </div>
            <p className="mb-1 mt-2 text-xs font-medium text-ink-muted">Conditions (vides = toutes)</p>
            <div className="grid gap-2 md:grid-cols-3">
              <FormField label="Rôles du demandeur" hint="ex. CHIEF_ENGINEER, CAPTAIN">
                <CsvInput value={r.match.requesterRoles} onChange={(v) => patchMatch(i, { requesterRoles: v })} upper ariaLabel={`Règle ${i + 1} : rôles du demandeur`} />
              </FormField>
              <FormField label="Catégories" hint="séparées par des virgules">
                <CsvInput value={r.match.categories} onChange={(v) => patchMatch(i, { categories: v })} ariaLabel={`Règle ${i + 1} : catégories`} />
              </FormField>
              <FormField label="Navires">
                <Select multiple value={r.match.vesselIds ?? []} onChange={(e) => patchMatch(i, { vesselIds: Array.from(e.target.selectedOptions).map((o) => o.value) })} className="h-20 text-sm">
                  {me.accessibleVessels.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </Select>
              </FormField>
            </div>
            <div className="mt-2 flex flex-wrap gap-3">
              <span className="text-xs text-ink-muted">Priorités :</span>
              {(Object.keys(PRIORITY_LABELS) as PrPriority[]).map((p) => (
                <Checkbox
                  key={p}
                  label={PRIORITY_LABELS[p]}
                  checked={(r.match.priorities ?? []).includes(p)}
                  onChange={(e) => patchMatch(i, { priorities: e.target.checked ? [...(r.match.priorities ?? []), p] : (r.match.priorities ?? []).filter((x) => x !== p) })}
                />
              ))}
            </div>
            <p className="mb-1 mt-3 text-xs font-medium text-ink-muted">Étapes</p>
            <ol className="space-y-1.5">
              {r.steps.map((s, k) => (
                <li key={k} className="grid items-end gap-2 md:grid-cols-[30px_160px_minmax(0,1fr)_160px_minmax(0,1fr)_auto]">
                  <span className="pb-2 text-xs tabular text-ink-muted">{k + 1}.</span>
                  <FormField label="Clé">
                    <Input value={s.key} onChange={(e) => patchStep(i, k, { key: e.target.value.toUpperCase() })} className="h-8 text-sm" />
                  </FormField>
                  <FormField label="Libellé">
                    <Input value={s.label} onChange={(e) => patchStep(i, k, { label: e.target.value })} className="h-8 text-sm" maxLength={200} />
                  </FormField>
                  <FormField label="Permission">
                    <Select value={s.permission} onChange={(e) => patchStep(i, k, { permission: e.target.value })} className="h-8 text-sm">
                      {PURCHASING_PERMS.map((p) => (
                        <option key={p.key} value={p.key}>
                          {p.key}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label="Rôles requis (facultatif)">
                    <CsvInput value={s.roleKeys} onChange={(v) => patchStep(i, k, { roleKeys: v })} upper placeholder="ex. CAPTAIN" ariaLabel={`Règle ${i + 1}, étape ${k + 1} : rôles requis`} />
                  </FormField>
                  <IconButton label="Supprimer l’étape" onClick={() => patchRule(i, { steps: r.steps.filter((_, m) => m !== k) })} disabled={r.steps.length === 1} className="mb-0.5 hover:text-danger">
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                </li>
              ))}
            </ol>
            {r.steps.length < 5 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-1"
                onClick={() => patchRule(i, { steps: [{ key: 'CAPTAIN_ENDORSEMENT', label: 'Visa Master', permission: 'pr.submit', roleKeys: ['CAPTAIN'] }, ...r.steps] })}
              >
                <Plus className="h-4 w-4" aria-hidden /> Ajouter une étape intermédiaire (avant l’approbation)
              </Button>
            )}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            setRules((prev) => [
              { id: `RULE_${prev.length + 1}`, label: '', match: {}, steps: [{ key: 'PURCHASING_APPROVAL', label: 'Revue et approbation Purchasing', permission: 'pr.approve' }] },
              ...prev,
            ])
          }
        >
          <Plus className="h-4 w-4" aria-hidden /> Nouvelle règle (en tête)
        </Button>
        <Button
          disabled={issues.length > 0}
          loading={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await run(
                () =>
                  api.put('/purchasing/config/review-circuits', {
                    rules: rules.map((r) => ({
                      id: r.id,
                      label: r.label.trim(),
                      match: Object.fromEntries(Object.entries(r.match).filter(([, v]) => Array.isArray(v) && v.length)),
                      steps: r.steps.map((s) => ({ key: s.key, label: s.label.trim(), permission: s.permission, ...(s.roleKeys?.length ? { roleKeys: s.roleKeys } : {}) })),
                    })),
                  }),
                'Circuits de revue enregistrés (appliqués aux prochaines soumissions)',
              );
            } catch (e) {
              setError(commandError(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Save className="h-4 w-4" aria-hidden /> Enregistrer les circuits
        </Button>
      </div>
      {issues.length > 0 && (
        <ul className="mt-2 list-inside list-disc text-xs text-danger">
          {issues.slice(0, 6).map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ul>
      )}
      {error && (
        <Callout tone="danger" className="mt-3" title="Circuits refusés">
          {error}
        </Callout>
      )}
    </Panel>
  );
}
