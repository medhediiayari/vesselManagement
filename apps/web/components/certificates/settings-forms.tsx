'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Plus, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { ApiError, api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea, TextField } from '@/components/ui/field';
import { PrincipalPicker, useRoles } from './pickers';
import {
  FREQUENCY_LABELS,
  SUBJECT_KIND_LABELS,
  type CertificateTypeDto,
  type PrincipalDto,
  type ReminderFrequency,
  type ReminderPolicyDto,
  type SubjectKind,
  type ValidatorCheckDto,
} from './types';

const samePrincipals = (a: PrincipalDto[], b: PrincipalDto[]) => {
  const key = (p: PrincipalDto) => `${p.principalType}:${p.principalId}`;
  const sa = new Set(a.map(key));
  return sa.size === b.length && b.every((p) => sa.has(key(p)));
};
const toPrincipalInput = (list: PrincipalDto[]) => list.map(({ principalType, principalId }) => ({ principalType, principalId }));
const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

/** Erreurs serveur -> erreurs de champ (validation zod [{path}] ou DUPLICATE {field}). */
function apiFieldErrors(e: unknown): Record<string, string> {
  if (!(e instanceof ApiError)) return {};
  const out = e.fieldErrors;
  const d = e.details as { field?: string } | undefined;
  if (e.code === 'DUPLICATE' && d?.field) out[d.field] = e.message;
  return out;
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      {message}
    </p>
  );
}

function Section({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-sm font-semibold text-navy">{title}</h3>
        {hint && <p className="text-xs text-ink-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

// =============================================================================
// Types de certificats
// =============================================================================

/** Création / modification d'un type (lecture seule sans certificates.types.manage). */
export function TypeFormDialog({
  open,
  onOpenChange,
  type,
  policies,
  categories,
  readOnly,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  type: CertificateTypeDto | null;
  policies: ReminderPolicyDto[];
  categories: string[];
  readOnly?: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [subjectKind, setSubjectKind] = useState<SubjectKind>('VESSEL');
  const [category, setCategory] = useState('');
  const [description, setDescription] = useState('');
  const [months, setMonths] = useState('');
  const [requiresDocument, setRequiresDocument] = useState(true);
  const [allowMultiple, setAllowMultiple] = useState(false);
  const [policyId, setPolicyId] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [sortOrder, setSortOrder] = useState('0');
  const [validators, setValidators] = useState<PrincipalDto[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { kind: useId(), desc: useId(), policy: useId(), cats: useId() };
  const locked = !!type && type.certificateCount > 0;

  // Validateurs désignés réellement habilités à approuver (CRT-02)
  const principals = toPrincipalInput(validators);
  const check = useQuery({
    queryKey: ['certificate-types', 'validators-check', principals.map((p) => `${p.principalType}:${p.principalId}`).sort().join(',')],
    queryFn: () => api.post<ValidatorCheckDto>('/certificate-types/validators/check', { principals }),
    enabled: open && !readOnly && principals.length > 0,
    staleTime: 30_000,
  });
  const noEffectiveValidator = principals.length > 0 && check.data?.effectiveApprovers === 0;
  const validatorWarnings = useMemo(
    () =>
      new Map(
        (check.data?.principals ?? [])
          .filter((p) => p.approverCount === 0)
          .map((p) => [`${p.principalType}:${p.principalId}`, p.principalType === 'USER' ? 'sans droit d’approbation' : 'personne n’a le droit d’approuver'] as const),
      ),
    [check.data],
  );

  useEffect(() => {
    if (!open) return;
    setCode(type?.code ?? '');
    setName(type?.name ?? '');
    setSubjectKind(type?.subjectKind ?? 'VESSEL');
    setCategory(type?.category ?? '');
    setDescription(type?.description ?? '');
    setMonths(type?.defaultValidityMonths ? String(type.defaultValidityMonths) : '');
    setRequiresDocument(type?.requiresDocument ?? true);
    setAllowMultiple(type?.allowMultiple ?? false);
    setPolicyId(type?.reminderPolicyId ?? '');
    setIsActive(type?.isActive ?? true);
    setSortOrder(String(type?.sortOrder ?? 0));
    setValidators(type?.validators ?? []);
    setErrors({});
    setFormError(null);
  }, [open, type]);

  async function save() {
    const local: Record<string, string> = {};
    if (!/^[A-Za-z0-9_-]{2,40}$/.test(code.trim())) local.code = 'Code : 2 à 40 caractères A-Z 0-9 _ -';
    if (name.trim().length < 2) local.name = 'Nom requis (2 caractères minimum)';
    if (category.trim().length < 2) local.category = 'Catégorie requise';
    if (months && (!Number.isInteger(Number(months)) || Number(months) < 1 || Number(months) > 600)) local.defaultValidityMonths = 'Entre 1 et 600 mois';
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length) return;
    if (noEffectiveValidator) {
      setFormError('Aucun des validateurs désignés n’a le droit « Approuver les certificats » : les demandes de ce type resteraient bloquées.');
      return;
    }
    const fields = {
      code: code.trim().toUpperCase(),
      name: name.trim(),
      subjectKind,
      category: category.trim(),
      description: description.trim(),
      defaultValidityMonths: numOrNull(months),
      requiresDocument,
      allowMultiple,
      reminderPolicyId: policyId || null,
      isActive,
      sortOrder: Number(sortOrder) || 0,
    };
    setBusy(true);
    try {
      if (!type) {
        await api.post('/certificate-types', { ...fields, validators: toPrincipalInput(validators) });
        toast.success('Type de certificat créé');
      } else {
        await api.patch(`/certificate-types/${type.id}`, fields);
        let realigned: { pendingRequests: number; notifiedValidators: number } | undefined;
        if (!samePrincipals(type.validators ?? [], validators)) {
          const res = await api.put<{ realigned?: typeof realigned }>(`/certificate-types/${type.id}/validators`, {
            principals: toPrincipalInput(validators),
          });
          realigned = res.realigned;
        }
        toast.success('Type de certificat mis à jour', {
          description: realigned?.pendingRequests
            ? `${realigned.pendingRequests} demande(s) en attente réaffectée(s) : ${realigned.notifiedValidators} nouveau(x) validateur(s) notifié(s).`
            : 'Modification journalisée dans l’audit.',
        });
      }
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      setErrors(apiFieldErrors(e));
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={type ? (readOnly ? `Type ${type.code}` : `Modifier le type ${type.code}`) : 'Nouveau type de certificat'}
      description={type ? `${type.certificateCount} certificat(s) utilisent ce type. Aucun type n’est supprimé : désactivez-le.` : 'Les types inactifs ne sont plus proposés à la création.'}
      size="lg"
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Annuler
            </Button>
            <Button onClick={save} loading={busy}>
              Enregistrer
            </Button>
          </>
        )
      }
    >
      <fieldset disabled={readOnly} className="space-y-5">
        <FormError message={formError} />
        <Section title="Identification">
          <div className="grid gap-3 sm:grid-cols-[160px_minmax(0,1fr)]">
            <TextField label="Code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} error={errors.code} maxLength={40} className="tabular" />
            <TextField label="Nom" required value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={200} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Titulaire" required htmlFor={ids.kind} error={errors.subjectKind} hint={locked ? 'Verrouillé : des certificats utilisent ce type.' : undefined}>
              <Select id={ids.kind} value={subjectKind} onChange={(e) => setSubjectKind(e.target.value as SubjectKind)} disabled={locked || readOnly}>
                {(['VESSEL', 'MEMBER'] as SubjectKind[]).map((k) => (
                  <option key={k} value={k}>
                    {SUBJECT_KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Catégorie" required htmlFor={ids.cats} error={errors.category} hint="Ex. STATUTORY, CLASS, STCW, MEDICAL…">
              <Input id={ids.cats} list={`${ids.cats}-list`} value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} invalid={!!errors.category} />
              <datalist id={`${ids.cats}-list`}>
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
          </div>
          <Field label="Description" htmlFor={ids.desc} error={errors.description}>
            <Textarea id={ids.desc} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={2000} />
          </Field>
        </Section>

        <Section title="Règles">
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField
              label="Validité usuelle (mois)"
              type="number"
              min={1}
              max={600}
              value={months}
              onChange={(e) => setMonths(e.target.value)}
              error={errors.defaultValidityMonths}
              hint="Sert à proposer l’échéance."
            />
            <TextField label="Ordre d’affichage" type="number" min={0} value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} error={errors.sortOrder} />
            <Field label="Politique de rappel" htmlFor={ids.policy} error={errors.reminderPolicyId}>
              <Select id={ids.policy} value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
                <option value="">Aucune (pas de rappel)</option>
                {policies.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <Checkbox label="Document requis" description="Sinon « Document manquant » n’est pas signalé." checked={requiresDocument} onChange={(e) => setRequiresDocument(e.target.checked)} />
            <Checkbox label="Plusieurs certificats actifs" description="Pour un même titulaire." checked={allowMultiple} onChange={(e) => setAllowMultiple(e.target.checked)} />
            <Checkbox label="Type actif" description="Proposé à la création." checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />
          </div>
        </Section>

        <Section
          title="Validateurs éligibles"
          hint="Utilisateurs, rôles ou départements désignés ; ils doivent aussi avoir le droit d’approuver et l’accès au certificat. Le demandeur n’est jamais éligible."
        >
          <PrincipalPicker
            value={validators}
            onChange={setValidators}
            disabled={readOnly}
            warnings={validatorWarnings}
            emptyHint="Aucun validateur désigné : tout utilisateur habilité à approuver et ayant accès au certificat est éligible."
          />
          {noEffectiveValidator && (
            <p role="alert" className="flex items-start gap-2 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Aucun validateur désigné n’a le droit « Approuver les certificats » : les demandes de ce type resteraient bloquées. Ajoutez une personne
              habilitée ou accordez-lui ce droit (Administration → rôles).
            </p>
          )}
        </Section>
      </fieldset>
    </Dialog>
  );
}

// =============================================================================
// Politiques de rappel
// =============================================================================

function ThresholdsEditor({ value, onChange, disabled, error }: { value: number[]; onChange: (v: number[]) => void; disabled?: boolean; error?: string }) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const add = () => {
    const n = Number(draft);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return;
    onChange([...new Set([...value, n])].sort((a, b) => b - a));
    setDraft('');
  };
  return (
    <Field label="Seuils avant échéance (jours)" htmlFor={id} error={error} hint="Un rappel à chacun de ces seuils (ex. 90 / 60 / 30 / 7).">
      <div className="space-y-2">
        <div className="flex min-h-[28px] flex-wrap gap-1.5" aria-live="polite">
          {value.length === 0 && <span className="text-sm text-ink-muted">Aucun seuil.</span>}
          {value.map((d) => (
            <span key={d} className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-white px-2 py-0.5 text-xs font-medium tabular">
              J-{d}
              {!disabled && (
                <button type="button" className="rounded-full p-0.5 text-ink-muted hover:bg-navy-50" aria-label={`Retirer le seuil ${d} jours`} onClick={() => onChange(value.filter((x) => x !== d))}>
                  <X className="h-3 w-3" aria-hidden />
                </button>
              )}
            </span>
          ))}
        </div>
        {!disabled && (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={id}
              type="number"
              min={1}
              max={3650}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  add();
                }
              }}
              className="w-28"
              placeholder="Jours"
            />
            <Button variant="secondary" size="sm" onClick={add} disabled={!draft}>
              <Plus className="h-4 w-4" aria-hidden /> Ajouter
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onChange([90, 60, 30, 7])}>
              Standard 90 / 60 / 30 / 7
            </Button>
          </div>
        )}
      </div>
    </Field>
  );
}

export function PolicyFormDialog({
  open,
  onOpenChange,
  policy,
  readOnly,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  policy: ReminderPolicyDto | null;
  readOnly?: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const roles = useRoles(open && !readOnly);
  const [name, setName] = useState('');
  const [thresholds, setThresholds] = useState<number[]>([90, 60, 30, 7]);
  const [frequency, setFrequency] = useState<ReminderFrequency>('AT_THRESHOLDS');
  const [custom, setCustom] = useState('');
  const [postInterval, setPostInterval] = useState('');
  const [postMax, setPostMax] = useState('');
  const [unknownInterval, setUnknownInterval] = useState('');
  const [missingInterval, setMissingInterval] = useState('');
  const [overdueHours, setOverdueHours] = useState('');
  const [escalationRoleId, setEscalationRoleId] = useState('');
  const [recipients, setRecipients] = useState<PrincipalDto[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { freq: useId(), role: useId() };

  useEffect(() => {
    if (!open) return;
    const s = (n: number | null | undefined) => (n === null || n === undefined ? '' : String(n));
    setName(policy?.name ?? '');
    setThresholds(policy?.thresholdsDays ?? [90, 60, 30, 7]);
    setFrequency(policy?.frequency ?? 'AT_THRESHOLDS');
    setCustom(s(policy?.customIntervalDays));
    setPostInterval(s(policy?.postExpiryIntervalDays));
    setPostMax(s(policy?.postExpiryMaxReminders));
    setUnknownInterval(s(policy?.unknownExpiryIntervalDays));
    setMissingInterval(s(policy?.missingDocumentIntervalDays));
    setOverdueHours(s(policy?.approvalOverdueHours));
    setEscalationRoleId(policy?.escalationRoleId ?? '');
    setRecipients(policy?.recipients ?? []);
    setErrors({});
    setFormError(null);
  }, [open, policy]);

  async function save() {
    const local: Record<string, string> = {};
    if (name.trim().length < 2) local.name = 'Nom requis (2 caractères minimum)';
    if (frequency === 'CUSTOM' && !custom) local.customIntervalDays = 'Intervalle requis pour la fréquence personnalisée';
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length) return;
    const fields = {
      name: name.trim(),
      thresholdsDays: thresholds,
      frequency,
      customIntervalDays: frequency === 'CUSTOM' ? numOrNull(custom) : null,
      postExpiryIntervalDays: numOrNull(postInterval),
      postExpiryMaxReminders: numOrNull(postMax),
      unknownExpiryIntervalDays: numOrNull(unknownInterval),
      missingDocumentIntervalDays: numOrNull(missingInterval),
      approvalOverdueHours: numOrNull(overdueHours),
      escalationRoleId: escalationRoleId || null,
    };
    setBusy(true);
    try {
      if (!policy) {
        await api.post('/certificate-reminder-policies', { ...fields, recipients: toPrincipalInput(recipients) });
        toast.success('Politique de rappel créée');
      } else {
        await api.patch(`/certificate-reminder-policies/${policy.id}`, fields);
        if (!samePrincipals(policy.recipients ?? [], recipients)) {
          await api.put(`/certificate-reminder-policies/${policy.id}/recipients`, { principals: toPrincipalInput(recipients) });
        }
        toast.success('Politique de rappel mise à jour');
      }
      await onSaved();
      onOpenChange(false);
    } catch (e) {
      setErrors(apiFieldErrors(e));
      setFormError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={policy ? (readOnly ? policy.name : `Modifier « ${policy.name} »`) : 'Nouvelle politique de rappel'}
      description="Alertes distinctes : échéance, après expiration, date inconnue, document manquant et approbation en retard. Envois plateforme + e-mail, filtrés sur les droits réels des destinataires."
      size="lg"
      footer={
        readOnly ? (
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Fermer
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              Annuler
            </Button>
            <Button onClick={save} loading={busy}>
              Enregistrer
            </Button>
          </>
        )
      }
    >
      <fieldset disabled={readOnly} className="space-y-5">
        <FormError message={formError} />
        <Section title="Échéance">
          <TextField label="Nom" required value={name} onChange={(e) => setName(e.target.value)} error={errors.name} maxLength={120} />
          <ThresholdsEditor value={thresholds} onChange={setThresholds} disabled={readOnly} error={errors.thresholdsDays} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Fréquence" htmlFor={ids.freq} error={errors.frequency}>
              <Select id={ids.freq} value={frequency} onChange={(e) => setFrequency(e.target.value as ReminderFrequency)}>
                {(Object.keys(FREQUENCY_LABELS) as ReminderFrequency[]).map((f) => (
                  <option key={f} value={f}>
                    {FREQUENCY_LABELS[f]}
                  </option>
                ))}
              </Select>
            </Field>
            {frequency === 'CUSTOM' && (
              <TextField
                label="Intervalle personnalisé (jours)"
                type="number"
                min={1}
                max={365}
                required
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                error={errors.customIntervalDays}
                hint="Appliqué à l’intérieur du plus grand seuil."
              />
            )}
          </div>
        </Section>
        <Section title="Après expiration" hint="Le suivi « renouvellement en cours » n’interrompt jamais ces rappels.">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Intervalle (jours)" type="number" min={1} max={365} value={postInterval} onChange={(e) => setPostInterval(e.target.value)} error={errors.postExpiryIntervalDays} hint="Vide = aucun rappel après expiration." />
            <TextField label="Nombre maximal de rappels" type="number" min={0} max={1000} value={postMax} onChange={(e) => setPostMax(e.target.value)} error={errors.postExpiryMaxReminders} hint="Vide = illimité." />
          </div>
        </Section>
        <Section title="Données et documents manquants">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Date inconnue : rappel tous les (jours)"
              type="number"
              min={1}
              max={365}
              value={unknownInterval}
              onChange={(e) => setUnknownInterval(e.target.value)}
              error={errors.unknownExpiryIntervalDays}
              hint="Rappel de complétion, jamais d’alerte d’échéance. Vide = désactivé."
            />
            <TextField
              label="Document manquant : rappel tous les (jours)"
              type="number"
              min={1}
              max={365}
              value={missingInterval}
              onChange={(e) => setMissingInterval(e.target.value)}
              error={errors.missingDocumentIntervalDays}
              hint="Vide = désactivé."
            />
          </div>
        </Section>
        <Section title="Approbations en retard">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="Escalade après (heures)"
              type="number"
              min={1}
              max={2160}
              value={overdueHours}
              onChange={(e) => setOverdueHours(e.target.value)}
              error={errors.approvalOverdueHours}
              hint="Vide = pas d’escalade."
            />
            <Field label="Rôle d’escalade" htmlFor={ids.role} error={errors.escalationRoleId ?? (roles.error ? errorMessage(roles.error) : undefined)}>
              <Select id={ids.role} value={escalationRoleId} onChange={(e) => setEscalationRoleId(e.target.value)} disabled={readOnly || roles.isLoading || !!roles.error}>
                <option value="">{readOnly && policy?.escalationRole ? policy.escalationRole.name ?? '—' : 'Aucun'}</option>
                {(roles.data ?? []).map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
                {escalationRoleId && !roles.data?.some((r) => r.id === escalationRoleId) && (
                  <option value={escalationRoleId}>{policy?.escalationRole?.name ?? 'Rôle actuel'}</option>
                )}
              </Select>
            </Field>
          </div>
        </Section>
        <Section title="Destinataires" hint="Utilisateurs, rôles ou départements ; seuls ceux ayant réellement accès au certificat reçoivent les rappels.">
          <PrincipalPicker value={recipients} onChange={setRecipients} disabled={readOnly} emptyHint="Aucun destinataire configuré." />
        </Section>
      </fieldset>
    </Dialog>
  );
}
