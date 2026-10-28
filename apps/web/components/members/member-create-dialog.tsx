'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Loader2, Lock, SearchCheck, UserPlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { ApiError, api, errorMessage, type StoredFileDto } from '@/lib/api';
import { useSession } from '@/lib/session';
import { customFieldErrors, CustomFieldInput } from './custom-field-input';
import { buildCorePayload, CORE_GROUPS, CoreFieldInput, emptyCoreValues, isProtectedField, type CoreKey, type CoreValues } from './member-form';
import { DuplicateCandidateList } from './member-ui';
import { useDebounced } from './use-debounced';
import { MANUAL_STATUS_LABELS, type DuplicateCandidate, type FieldConfig, type FieldDefinition, type ManualMemberStatus, type MemberCore } from './types';

/** Message affiché sur 409 DUPLICATE forçable (le message API mentionne le paramètre technique force). */
export const DUPLICATE_MESSAGE =
  'Une fiche ressemblante existe déjà. Vérifiez les candidats ; pour enregistrer quand même, indiquez un motif (journalisé).';

export type CreatedMember = MemberCore & { visible: boolean; forcedDuplicateOf: string[] };

interface Conflict {
  message: string;
  candidates: DuplicateCandidate[];
  /** false : matricule AMC déjà attribué, jamais forçable */
  forceable: boolean;
}

/** Champs personnalisés actifs que l'utilisateur peut saisir (permission d'édition du champ). */
export function editableCreateFields(cfg: FieldConfig | undefined, can: (p: string) => boolean) {
  if (!cfg) return [] as { section: string; fields: FieldDefinition[] }[];
  const active = new Set(cfg.sections.filter((s) => !s.archivedAt).map((s) => s.id));
  const ok = (f: FieldDefinition) =>
    !f.archivedAt && (!f.sectionId || active.has(f.sectionId)) && can(f.viewPermission ?? 'members.view') && can(f.editPermission ?? 'members.edit');
  const groups = cfg.sections
    .filter((s) => !s.archivedAt)
    .map((s) => ({ section: s.name, fields: s.fields.filter(ok) }));
  const loose = cfg.unsectioned.filter(ok);
  if (loose.length) groups.unshift({ section: 'Informations complémentaires', fields: loose });
  return groups.filter((g) => g.fields.length);
}

/**
 * Création d'une fiche Member avec anti-doublon (ADM-042) : contrôle à la volée des identifiants
 * saisis, puis 409 DUPLICATE à l'enregistrement ; « Créer quand même » exige un motif audité et
 * n'est proposé que si l'API l'autorise (jamais pour un matricule AMC déjà attribué).
 */
export function MemberCreateDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onCreated: (m: CreatedMember) => void;
}) {
  const { can } = useSession();
  const canProtected = can('members.personal_fields.manage');
  const [values, setValues] = useState<CoreValues>(emptyCoreValues);
  const [status, setStatus] = useState<ManualMemberStatus>('AVAILABLE');
  const [photo, setPhoto] = useState<StoredFileDto | null>(null);
  const [custom, setCustom] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [forceReason, setForceReason] = useState('');
  const [busy, setBusy] = useState(false);

  const cfg = useQuery({
    queryKey: ['member-custom-fields', false],
    queryFn: () => api.get<FieldConfig>('/members/custom-fields'),
    enabled: open,
  });
  const customGroups = useMemo(() => editableCreateFields(cfg.data, can), [cfg.data, can]);

  // ---- Contrôle des doublons à la saisie (debounce)
  const probe = useMemo(() => {
    const p: Record<string, string> = {};
    const set = (k: string, v: string) => {
      const t = v.trim();
      if (t) p[k] = t;
    };
    set('lastName', values.lastName);
    set('firstName', values.firstName);
    if (canProtected) {
      set('amcRef', values.amcRef);
      set('passportNumber', values.passportNumber);
      set('seamanBookNumber', values.seamanBookNumber);
      if (/^\d{4}-\d{2}-\d{2}$/.test(values.birthDate)) p.birthDate = values.birthDate;
      if (/^[A-Z]{2}$/.test(values.passportCountry)) p.passportCountry = values.passportCountry;
    }
    return p;
  }, [values, canProtected]);
  const debouncedProbe = useDebounced(probe, 500);
  const hasCriteria = !!(
    debouncedProbe.amcRef ||
    debouncedProbe.passportNumber ||
    debouncedProbe.seamanBookNumber ||
    debouncedProbe.birthDate ||
    (debouncedProbe.lastName && debouncedProbe.firstName)
  );
  const dupCheck = useQuery({
    queryKey: ['member-duplicate-check', debouncedProbe],
    queryFn: () => api.post<{ candidates: DuplicateCandidate[] }>('/members/duplicates/check', debouncedProbe),
    enabled: open && hasCriteria && !conflict,
    staleTime: 30_000,
    retry: false,
  });

  const reset = () => {
    setValues(emptyCoreValues());
    setStatus('AVAILABLE');
    setPhoto(null);
    setCustom({});
    setErrors({});
    setCustomErrors({});
    setConflict(null);
    setForceReason('');
  };

  const setField = (k: CoreKey, v: string) => {
    setValues((prev) => ({ ...prev, [k]: v }));
    if (conflict) setConflict(null);
    if (errors[k]) setErrors((e) => ({ ...e, [k]: '' }));
  };

  const submit = async (force: boolean) => {
    const local: Record<string, string> = {};
    if (!values.lastName.trim()) local.lastName = 'Nom obligatoire';
    if (!values.firstName.trim()) local.firstName = 'Prénom obligatoire';
    if (Object.keys(local).length) {
      setErrors(local);
      return;
    }
    const keys = CORE_GROUPS.flatMap((g) => g.fields.map((f) => f.key)).filter((k) => canProtected || !isProtectedField(k));
    const customFields = Object.fromEntries(Object.entries(custom).filter(([, v]) => v !== null && v !== undefined && v !== ''));
    const body = {
      ...buildCorePayload(values, keys),
      status,
      ...(photo ? { photoFileId: photo.id } : {}),
      ...(Object.keys(customFields).length ? { customFields } : {}),
      ...(force ? { force: true, forceReason: forceReason.trim() } : {}),
    };
    setBusy(true);
    try {
      const created = await api.post<CreatedMember>('/members', body);
      reset();
      onOpenChange(false);
      onCreated(created);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DUPLICATE') {
        const d = (e.details ?? {}) as { candidates?: DuplicateCandidate[]; reason?: string };
        const forceable = d.reason !== 'AMC_REF';
        setConflict({ message: forceable ? DUPLICATE_MESSAGE : e.message, candidates: d.candidates ?? [], forceable });
      } else if (e instanceof ApiError && e.status === 422) {
        setErrors(e.fieldErrors);
        setCustomErrors(customFieldErrors(e.details));
        toast.error(e.message);
      } else {
        toast.error(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const shownCandidates = conflict?.candidates ?? dupCheck.data?.candidates ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
      title="Nouvelle fiche"
      description="Fiche unique de la personne : les identifiants saisis sont comparés aux fiches existantes avant création."
      size="xl"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          {conflict?.forceable ? (
            <Button variant="danger" onClick={() => submit(true)} loading={busy} disabled={forceReason.trim().length < 5}>
              Créer quand même
            </Button>
          ) : (
            <Button onClick={() => submit(false)} loading={busy} disabled={!!conflict}>
              <UserPlus className="h-4 w-4" aria-hidden /> Créer la fiche
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-5">
          {CORE_GROUPS.map((g) => {
            const fields = g.fields.filter((f) => canProtected || !isProtectedField(f.key));
            if (!fields.length) return null;
            return (
              <fieldset key={g.id}>
                <legend className="mb-2 text-sm font-semibold text-navy">{g.title}</legend>
                <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                  {fields.map((def) => (
                    <CoreFieldInput key={def.key} def={def} value={values[def.key]} onChange={(v) => setField(def.key, v)} error={errors[def.key] || undefined} />
                  ))}
                  {g.id === 'crew' && (
                    <Field label="Statut administratif" htmlFor="new-member-status" hint="« À bord » et « Embarquement prévu » découlent des affectations.">
                      <Select id="new-member-status" value={status} onChange={(e) => setStatus(e.target.value as ManualMemberStatus)}>
                        {Object.entries(MANUAL_STATUS_LABELS).map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  )}
                </div>
              </fieldset>
            );
          })}
          {!canProtected && (
            <p className="flex items-start gap-2 rounded-md border border-line bg-canvas px-3 py-2 text-sm text-ink-muted">
              <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              Matricule, date et lieu de naissance, nationalité, passeport et seaman book sont des données protégées : elles seront
              saisies par un utilisateur habilité.
            </p>
          )}
          {customGroups.map((g) => (
            <fieldset key={g.section}>
              <legend className="mb-2 text-sm font-semibold text-navy">{g.section}</legend>
              <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
                {g.fields.map((f) => (
                  <CustomFieldInput
                    key={f.key}
                    field={f}
                    value={custom[f.key] ?? null}
                    onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
                    error={customErrors[f.key]}
                  />
                ))}
              </div>
            </fieldset>
          ))}
          <fieldset>
            <legend className="mb-2 text-sm font-semibold text-navy">Photo (facultatif)</legend>
            <FileUploader context="MEMBER_PHOTO" label="Déposer une photo d'identité" onUploaded={setPhoto} />
          </fieldset>
        </div>

        <aside className="lg:sticky lg:top-0 lg:self-start" aria-live="polite" aria-label="Doublons potentiels">
          <div className="rounded-lg border border-line bg-canvas p-3">
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-navy">
              <SearchCheck className="h-4 w-4 text-teal-700" aria-hidden /> Doublons potentiels
            </h3>
            {conflict && (
              <div className="mb-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
                <p className="flex items-start gap-1.5 font-medium">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
                  {conflict.message}
                </p>
              </div>
            )}
            {!conflict && !hasCriteria && (
              <p className="text-sm text-ink-muted">
                Saisissez nom et prénom{canProtected ? ', matricule, date de naissance, passeport ou seaman book' : ''} : les fiches ressemblantes
                s’afficheront ici.
              </p>
            )}
            {!conflict && hasCriteria && dupCheck.isFetching && (
              <p className="flex items-center gap-2 text-sm text-ink-muted">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Recherche de fiches ressemblantes…
              </p>
            )}
            {!conflict && dupCheck.error ? <p className="text-sm text-danger">{errorMessage(dupCheck.error)}</p> : null}
            {(conflict || (hasCriteria && dupCheck.data)) && (
              <DuplicateCandidateList candidates={shownCandidates} emptyText="Aucune fiche ressemblante détectée." />
            )}
            {conflict?.forceable && (
              <div className="mt-3 border-t border-line pt-3">
                <Field label="Motif de création malgré le doublon" required htmlFor="force-reason" hint="5 caractères minimum — conservé dans le journal d'audit.">
                  <Textarea id="force-reason" rows={3} value={forceReason} onChange={(e) => setForceReason(e.target.value)} invalid={!!errors.forceReason} />
                </Field>
              </div>
            )}
            {conflict && !conflict.forceable && (
              <p className="mt-3 text-sm text-ink">Corrigez le matricule saisi ou ouvrez la fiche existante : un matricule AMC ne peut pas être partagé.</p>
            )}
          </div>
        </aside>
      </div>
    </Dialog>
  );
}
