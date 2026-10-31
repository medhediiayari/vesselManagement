'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, FileText, Info, ShieldCheck, Users, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ApiError, api, errorMessage, type StoredFileDto } from '@/lib/api';
import { cn, fmtBytes, fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea, TextField } from '@/components/ui/field';
import { announceWorkflow, certKeys, conflictMessage, selfApproves, toDateInput } from './lib';
import { MemberPicker, type PickOption } from './pickers';
import { FolderSelect, useCertificateFolders } from './tree';
import {
  EXPIRY_KIND_LABELS,
  SUBJECT_KIND_LABELS,
  type ApproversDto,
  type CertificateData,
  type CertificateDetail,
  type CertificateTypeDto,
  type ExpiryKind,
  type RequestDto,
  type RequestKind,
  type SubjectKind,
  type WorkflowResult,
} from './types';

export type CertificateFormMode =
  | { mode: 'create'; defaults?: { subjectKind?: SubjectKind; vesselId?: string | null; typeId?: string | null; folderId?: string | null } }
  | { mode: 'renew'; certificate: CertificateDetail }
  | { mode: 'correct'; certificate: CertificateDetail }
  | { mode: 'edit'; certificate: CertificateDetail; request: RequestDto };

interface FormState {
  subjectKind: SubjectKind;
  vesselId: string;
  member: PickOption | null;
  typeId: string;
  certificateNumber: string;
  issuer: string;
  authority: string;
  country: string;
  placeOfIssue: string;
  issuedOn: string;
  validFrom: string;
  expiryKind: ExpiryKind;
  expiryOn: string;
  remarks: string;
  changeNote: string;
  submit: boolean;
  folderId: string;
}

function fromData(d: Partial<CertificateData> | null | undefined): Partial<FormState> {
  if (!d) return {};
  return {
    certificateNumber: d.certificateNumber ?? '',
    issuer: d.issuer ?? '',
    authority: d.authority ?? '',
    country: d.country ?? '',
    placeOfIssue: d.placeOfIssue ?? '',
    issuedOn: toDateInput(d.issuedOn),
    validFrom: toDateInput(d.validFrom),
    expiryKind: d.expiryKind ?? 'DATED',
    expiryOn: toDateInput(d.expiryOn),
    remarks: d.remarks ?? '',
  };
}

function initialState(props: CertificateFormMode, defaultVessel: string, canSubmit: boolean): FormState {
  const base: FormState = {
    subjectKind: 'VESSEL',
    vesselId: defaultVessel,
    member: null,
    typeId: '',
    certificateNumber: '',
    issuer: '',
    authority: '',
    country: '',
    placeOfIssue: '',
    issuedOn: '',
    validFrom: '',
    expiryKind: 'DATED',
    expiryOn: '',
    remarks: '',
    changeNote: '',
    submit: canSubmit,
    folderId: '',
  };
  if (props.mode === 'create') {
    return {
      ...base,
      subjectKind: props.defaults?.subjectKind ?? 'VESSEL',
      vesselId: props.defaults?.vesselId ?? defaultVessel,
      typeId: props.defaults?.typeId ?? '',
      folderId: props.defaults?.folderId ?? '',
    };
  }
  if (props.mode === 'renew') {
    // Identification reprise ; numéro et dates nouveaux (le serveur reprend aussi émetteur / autorité)
    const cur = props.certificate.currentRevision;
    return { ...base, issuer: cur?.issuer ?? '', authority: cur?.authority ?? '', country: cur?.country ?? '', placeOfIssue: cur?.placeOfIssue ?? '' };
  }
  if (props.mode === 'correct') return { ...base, ...fromData(props.certificate.currentRevision), submit: canSubmit };
  return { ...base, ...fromData(props.request.versions[0]), submit: false };
}

function addMonths(isoDay: string, months: number): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0); // 31 -> fin de mois
  return d.toISOString().slice(0, 10);
}

function Section({ title, children, description }: { title: string; children: ReactNode; description?: ReactNode }) {
  return (
    <fieldset className="space-y-3 border-t border-line pt-4 first:border-t-0 first:pt-0">
      <legend className="sr-only">{title}</legend>
      <div>
        <h3 className="text-sm font-semibold text-navy">{title}</h3>
        {description && <p className="text-xs text-ink-muted">{description}</p>}
      </div>
      {children}
    </fieldset>
  );
}

/**
 * Formulaire unique de saisie certificat : création, renouvellement, correction et modification
 * d'une demande (nouvelle version immuable, expectedVersion). Les contrôles définitifs sont
 * faits par le serveur ; ses erreurs champ par champ sont affichées sous chaque champ.
 */
export function CertificateFormDialog({
  open,
  onOpenChange,
  onDone,
  ...props
}: CertificateFormMode & {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onDone: (res: WorkflowResult) => void | Promise<void>;
}) {
  const { me, can, currentVessel } = useSession();
  // Publication directe : self_approve (toute demande) ou renewal.self_approve (renouvellement)
  const kind: RequestKind =
    props.mode === 'create' ? 'CREATE' : props.mode === 'renew' ? 'RENEWAL' : props.mode === 'correct' ? 'CORRECTION' : props.request.kind;
  const selfApprove = selfApproves(can, kind);
  const canSubmit = can('certificates.submit') || selfApprove;
  const canFile = can('certificates.folders.manage');
  const canMemberCerts = can('members.certificates.view');
  const defaultVessel = currentVessel?.id ?? (me.accessibleVessels.length === 1 ? me.accessibleVessels[0].id : '');
  const [s, setS] = useState<FormState>(() => initialState(props, defaultVessel, canSubmit));
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [removeFile, setRemoveFile] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<{ message: string; certificateId?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ids = { subject: useId(), vessel: useId(), type: useId(), expiry: useId(), remarks: useId(), note: useId(), folder: useId() };

  // Ré-initialisation à chaque ouverture (nouvelle version de la demande, autre certificat…)
  const resetKey = props.mode === 'edit' ? `${props.request.id}:${props.request.version}` : props.mode === 'create' ? 'create' : props.certificate.id;
  useEffect(() => {
    if (!open) return;
    setS(initialState(props, defaultVessel, canSubmit));
    setFile(null);
    setRemoveFile(false);
    setErrors({});
    setFormError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resetKey]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => {
    setS((prev) => ({ ...prev, [k]: v }));
    clearError(k);
  };
  const clearError = (k: string) =>
    setErrors((prev) => {
      if (!(k in prev)) return prev;
      const next = { ...prev };
      delete next[k];
      return next;
    });

  const isCreate = props.mode === 'create';
  const certificate = props.mode === 'create' ? null : props.certificate;
  const subjectKind = certificate?.subjectKind ?? s.subjectKind;
  const vesselIdForUpload = subjectKind === 'VESSEL' ? (certificate?.vesselId ?? (s.vesselId || null)) : null;

  const types = useQuery({
    queryKey: [...certKeys.types, { subjectKind: s.subjectKind, active: true }],
    queryFn: () => api.get<CertificateTypeDto[]>('/certificate-types', { query: { subjectKind: s.subjectKind, active: true } }),
    enabled: open && isCreate,
    staleTime: 60_000,
  });
  const selectedType = useMemo(() => types.data?.find((t) => t.id === s.typeId) ?? null, [types.data, s.typeId]);
  const folders = useCertificateFolders(open && isCreate && canFile);
  // Qui recevra la demande d'approbation (renouvellement / correction d'un certificat existant)
  const approvers = useQuery({
    queryKey: [...certKeys.detail(certificate?.id ?? ''), 'approvers', props.mode],
    queryFn: () =>
      api.get<ApproversDto>(`/certificates/${certificate!.id}/approvers`, { query: { kind: props.mode === 'correct' ? 'CORRECTION' : 'RENEWAL' } }),
    enabled: open && !!certificate && (props.mode === 'renew' || props.mode === 'correct'),
    staleTime: 30_000,
  });
  const typeInfo = certificate?.type ?? selectedType;
  const defaultMonths = certificate?.type.defaultValidityMonths ?? selectedType?.defaultValidityMonths ?? null;
  const anchor = s.validFrom || s.issuedOn;
  const suggestedExpiry = defaultMonths && anchor && s.expiryKind === 'DATED' ? addMonths(anchor, defaultMonths) : null;

  // Pièce proposée par la version en cours (modification de demande)
  const currentVersionFile = useMemo(() => {
    if (props.mode !== 'edit') return null;
    const fid = props.request.versions[0]?.fileId;
    if (!fid) return null;
    const att = props.certificate.attachments.find((a) => a.file?.id === fid);
    return { id: fid, name: att?.file?.originalName ?? 'Pièce proposée' };
  }, [props]);

  const title =
    props.mode === 'create'
      ? 'Nouveau certificat'
      : props.mode === 'renew'
        ? 'Renouveler le certificat'
        : props.mode === 'correct'
          ? 'Corriger la révision courante'
          : `Modifier la demande (version ${props.request.version})`;
  const description =
    props.mode === 'create'
      ? selfApprove
        ? 'Publication directe : le certificat devient officiel dès l’enregistrement, sans circuit d’approbation (sauf brouillon).'
        : 'Le certificat devient officiel après approbation par un validateur éligible (jamais le demandeur).'
      : props.mode === 'renew'
        ? selfApprove
          ? 'Publication directe : le nouveau certificat devient courant dès l’enregistrement, sans circuit d’approbation.'
          : "L'ancien certificat reste courant (dates, document officiel et alertes) jusqu'à l'approbation du nouveau."
        : props.mode === 'correct'
          ? selfApprove
            ? 'Publication directe : la révision corrigée remplace la révision courante dès l’enregistrement (sauf brouillon).'
            : 'La correction est une demande à valider : la révision courante reste en vigueur jusqu’à son approbation.'
          : 'Chaque modification crée une nouvelle version immuable ; une demande en attente redevient à valider et les validateurs sont notifiés.';

  function localValidate(): Record<string, string> {
    const e: Record<string, string> = {};
    if (isCreate) {
      if (s.subjectKind === 'VESSEL' && !s.vesselId) e.vesselId = 'Choisissez un navire';
      if (s.subjectKind === 'MEMBER' && !s.member) e.memberId = 'Choisissez un marin';
      if (!s.typeId) e.typeId = 'Choisissez un type de certificat';
    }
    if (s.expiryKind === 'DATED' && !s.expiryOn) e.expiryOn = "Date d'expiration requise pour un certificat daté";
    if (s.country.trim() && !/^[A-Za-z]{2}$/.test(s.country.trim())) e.country = 'Code pays ISO à 2 lettres (ex. FR, CI, SN)';
    if (s.issuedOn && s.expiryKind === 'DATED' && s.expiryOn && s.issuedOn > s.expiryOn) e.issuedOn = "La date d'émission est postérieure à l'expiration";
    if (s.validFrom && s.expiryKind === 'DATED' && s.expiryOn && s.validFrom > s.expiryOn) e.validFrom = "Le début de validité est postérieur à l'expiration";
    if (props.mode === 'correct' && s.changeNote.trim().length < 3) e.changeNote = 'Motif de correction obligatoire (3 caractères minimum)';
    return e;
  }

  async function save() {
    const local = localValidate();
    setErrors(local);
    setFormError(null);
    if (Object.keys(local).length) return;

    const data = {
      certificateNumber: s.certificateNumber.trim(),
      issuer: s.issuer.trim(),
      authority: s.authority.trim(),
      country: s.country.trim() ? s.country.trim().toUpperCase() : null,
      placeOfIssue: s.placeOfIssue.trim(),
      issuedOn: s.issuedOn || null,
      validFrom: s.validFrom || null,
      expiryKind: s.expiryKind,
      expiryOn: s.expiryKind === 'DATED' ? s.expiryOn || null : null,
      remarks: s.remarks.trim(),
    };
    const changeNote = s.changeNote.trim() || undefined;
    setBusy(true);
    try {
      let res: WorkflowResult;
      if (props.mode === 'create') {
        res = await api.post<WorkflowResult>('/certificates', {
          subjectKind: s.subjectKind,
          ...(s.subjectKind === 'VESSEL' ? { vesselId: s.vesselId } : { memberId: s.member?.id }),
          typeId: s.typeId,
          ...data,
          fileId: file?.id ?? null,
          changeNote,
          submit: canSubmit && s.submit,
          ...(canFile && s.folderId ? { folderId: s.folderId } : {}),
        });
        announceWorkflow(res, canSubmit && s.submit ? (res.autoApproved ? 'Certificat créé et publié' : 'Certificat créé et soumis à approbation') : 'Certificat créé (brouillon)');
      } else if (props.mode === 'renew') {
        res = await api.post<WorkflowResult>(`/certificates/${props.certificate.id}/renew`, {
          ...data,
          fileId: file?.id ?? null,
          changeNote,
          submit: canSubmit && s.submit,
        });
        announceWorkflow(
          res,
          canSubmit && s.submit ? (res.autoApproved ? 'Certificat renouvelé (publié sans approbation)' : 'Renouvellement soumis à approbation') : 'Renouvellement enregistré en brouillon',
        );
      } else if (props.mode === 'correct') {
        res = await api.post<WorkflowResult>(`/certificates/${props.certificate.id}/corrections`, {
          ...data,
          fileId: file?.id ?? null,
          changeNote: s.changeNote.trim(),
          submit: canSubmit && s.submit,
        });
        announceWorkflow(res, canSubmit && s.submit ? (res.autoApproved ? 'Correction publiée' : 'Correction soumise à approbation') : 'Correction enregistrée en brouillon');
      } else {
        res = await api.patch<WorkflowResult>(`/certificate-requests/${props.request.id}`, {
          expectedVersion: props.request.version,
          ...data,
          fileId: file ? file.id : removeFile ? null : undefined,
          changeNote,
        });
        announceWorkflow(res, `Nouvelle version enregistrée (v${res.request?.version ?? props.request.version + 1})`);
      }
      await onDone(res);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        const d = e.details as { certificateId?: string } | undefined;
        setFormError({ message: conflictMessage(e) ?? e.message, certificateId: e.code === 'CONFLICT' ? d?.certificateId : undefined });
        if (e.code === 'STALE_VERSION' || e.code === 'ALREADY_PROCESSED') await onDone({});
      } else {
        setFormError({ message: errorMessage(e) });
      }
    } finally {
      setBusy(false);
    }
  }

  const submitLabel =
    props.mode === 'edit'
      ? 'Enregistrer la nouvelle version'
      : canSubmit && s.submit
        ? selfApprove
          ? props.mode === 'renew'
            ? 'Renouveler et publier'
            : 'Enregistrer et publier'
          : 'Enregistrer et soumettre'
        : 'Enregistrer le brouillon';

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {formError && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div>
              <p>{formError.message}</p>
              {formError.certificateId && (
                <Link href={`/certificates/${formError.certificateId}`} className="font-medium underline" onClick={() => onOpenChange(false)}>
                  Ouvrir le certificat existant
                </Link>
              )}
            </div>
          </div>
        )}

        {isCreate ? (
          <Section title="Titulaire et type">
            <div role="radiogroup" aria-labelledby={ids.subject} className="space-y-1">
              <p id={ids.subject} className="field-label">
                Titulaire
              </p>
              <div className="flex flex-wrap gap-2">
                {(['VESSEL', 'MEMBER'] as SubjectKind[]).map((k) => {
                  const disabled = k === 'MEMBER' && !canMemberCerts;
                  return (
                    <label
                      key={k}
                      className={cn(
                        'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                        s.subjectKind === k ? 'border-action bg-action-50 font-medium text-navy' : 'border-line-strong bg-white',
                        disabled && 'cursor-not-allowed opacity-50',
                      )}
                    >
                      <input
                        type="radio"
                        name="subjectKind"
                        value={k}
                        checked={s.subjectKind === k}
                        disabled={disabled}
                        onChange={() => setS((prev) => ({ ...prev, subjectKind: k, typeId: '', member: null }))}
                        className="h-4 w-4 text-action focus:ring-action"
                      />
                      Certificat {SUBJECT_KIND_LABELS[k].toLowerCase()}
                    </label>
                  );
                })}
              </div>
              {!canMemberCerts && <p className="field-hint">Les certificats marins requièrent le droit « Consulter les certificats des marins ».</p>}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {s.subjectKind === 'VESSEL' ? (
                <Field label="Navire" required htmlFor={ids.vessel} error={errors.vesselId} hint="Navires de votre périmètre uniquement.">
                  <Select id={ids.vessel} value={s.vesselId} invalid={!!errors.vesselId} onChange={(e) => set('vesselId', e.target.value)}>
                    <option value="">Choisir un navire…</option>
                    {me.accessibleVessels.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name} ({v.code})
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : (
                <MemberPicker
                  value={s.member}
                  onChange={(m) => {
                    set('member', m);
                    clearError('memberId');
                  }}
                  error={errors.memberId}
                />
              )}
              <Field
                label="Type de certificat"
                required
                htmlFor={ids.type}
                error={errors.typeId}
                hint={types.error ? errorMessage(types.error) : 'Types actifs applicables à ce titulaire.'}
              >
                <Select id={ids.type} value={s.typeId} invalid={!!errors.typeId} onChange={(e) => set('typeId', e.target.value)} disabled={types.isLoading}>
                  <option value="">{types.isLoading ? 'Chargement…' : 'Choisir un type…'}</option>
                  {Object.entries(
                    (types.data ?? []).reduce<Record<string, CertificateTypeDto[]>>((acc, t) => {
                      (acc[t.category] ??= []).push(t);
                      return acc;
                    }, {}),
                  ).map(([cat, list]) => (
                    <optgroup key={cat} label={cat}>
                      {list.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name} ({t.code})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </Field>
              {canFile && (folders.data?.length ?? 0) > 0 && (
                <Field label="Dossier de l’arborescence" htmlFor={ids.folder} hint="Classement facultatif, sans effet sur les droits.">
                  <FolderSelect id={ids.folder} value={s.folderId} onChange={(v) => set('folderId', v)} folders={folders.data ?? []} />
                </Field>
              )}
            </div>
            {selectedType && (
              <p className="flex items-start gap-1.5 text-xs text-ink-muted">
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>
                  {selectedType.requiresDocument ? 'Document officiel attendu' : 'Document facultatif'}
                  {selectedType.defaultValidityMonths ? ` — validité usuelle ${selectedType.defaultValidityMonths} mois` : ''}
                  {selectedType.allowMultiple ? ' — plusieurs certificats simultanés autorisés' : ' — un seul certificat actif par titulaire'}
                  {selectedType.description ? `. ${selectedType.description}` : ''}
                </span>
              </p>
            )}
          </Section>
        ) : (
          certificate && (
            <div className="rounded-md bg-canvas px-3 py-2 text-sm">
              <span className="font-medium text-navy">{certificate.type.name}</span>
              <span className="text-ink-muted"> — {certificate.subject.label}</span>
              {certificate.currentRevision && (
                <span className="block text-xs text-ink-muted">
                  Révision courante n° {certificate.currentRevision.revisionNo} — {certificate.currentRevision.certificateNumber ?? 'sans numéro'} — échéance{' '}
                  {certificate.currentRevision.expiryKind === 'DATED' ? fmtDate(certificate.currentRevision.expiryOn) : EXPIRY_KIND_LABELS[certificate.currentRevision.expiryKind].toLowerCase()}
                </span>
              )}
            </div>
          )
        )}

        <Section title="Identification">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Numéro du certificat" value={s.certificateNumber} onChange={(e) => set('certificateNumber', e.target.value)} error={errors.certificateNumber} maxLength={120} className="tabular" />
            <TextField label="Émetteur" value={s.issuer} onChange={(e) => set('issuer', e.target.value)} error={errors.issuer} maxLength={200} />
            <TextField label="Autorité" value={s.authority} onChange={(e) => set('authority', e.target.value)} error={errors.authority} maxLength={200} hint="Administration, société de classification…" />
            <div className="grid grid-cols-[96px_minmax(0,1fr)] gap-3">
              <TextField label="Pays" value={s.country} onChange={(e) => set('country', e.target.value.toUpperCase())} error={errors.country} maxLength={2} placeholder="FR" hint="ISO 2 lettres" />
              <TextField label="Lieu d'émission" value={s.placeOfIssue} onChange={(e) => set('placeOfIssue', e.target.value)} error={errors.placeOfIssue} maxLength={120} />
            </div>
          </div>
        </Section>

        <Section title="Dates et échéance" description="« Date inconnue » n'émet aucune alerte d'expiration mais un rappel de complétion ; « Illimité » n'a pas d'échéance.">
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Date d'émission" type="date" value={s.issuedOn} onChange={(e) => set('issuedOn', e.target.value)} error={errors.issuedOn} />
            <TextField label="Valide à partir du" type="date" value={s.validFrom} onChange={(e) => set('validFrom', e.target.value)} error={errors.validFrom} />
          </div>
          <div role="radiogroup" aria-labelledby={ids.expiry}>
            <p id={ids.expiry} className="field-label">
              Type d&apos;échéance<span className="ml-0.5 text-danger" aria-hidden>*</span>
            </p>
            <div className="flex flex-wrap gap-2">
              {(['DATED', 'UNLIMITED', 'UNKNOWN'] as ExpiryKind[]).map((k) => (
                <label
                  key={k}
                  className={cn(
                    'inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm',
                    s.expiryKind === k ? 'border-action bg-action-50 font-medium text-navy' : 'border-line-strong bg-white',
                  )}
                >
                  <input
                    type="radio"
                    name="expiryKind"
                    value={k}
                    checked={s.expiryKind === k}
                    onChange={() => set('expiryKind', k)}
                    className="h-4 w-4 text-action focus:ring-action"
                  />
                  {k === 'DATED' ? 'Daté' : EXPIRY_KIND_LABELS[k]}
                </label>
              ))}
            </div>
          </div>
          {s.expiryKind === 'DATED' && (
            <div className="grid gap-3 sm:grid-cols-2 sm:items-end">
              <TextField label="Date d'expiration" type="date" required value={s.expiryOn} onChange={(e) => set('expiryOn', e.target.value)} error={errors.expiryOn} hint="Dernier jour de validité." />
              {suggestedExpiry && suggestedExpiry !== s.expiryOn && (
                <Button variant="ghost" size="sm" className="justify-start" onClick={() => set('expiryOn', suggestedExpiry)}>
                  <CalendarClock className="h-4 w-4" aria-hidden /> Proposer {fmtDate(suggestedExpiry)} (+{defaultMonths} mois)
                </Button>
              )}
            </div>
          )}
          {s.expiryKind !== 'DATED' && errors.expiryOn && (
            <p className="field-error" role="alert">
              {errors.expiryOn}
            </p>
          )}
          <Field label="Remarques" htmlFor={ids.remarks} error={errors.remarks}>
            <Textarea id={ids.remarks} rows={2} value={s.remarks} onChange={(e) => set('remarks', e.target.value)} maxLength={5000} />
          </Field>
        </Section>

        <Section
          title="Document"
          description={
            props.mode === 'correct' && props.certificate.currentRevision?.officialAttachment
              ? 'Sans nouvelle pièce, le document officiel actuel est conservé pour la révision corrigée.'
              : !typeInfo || typeInfo.requiresDocument
                ? "Facultatif à ce stade : sans pièce, le certificat restera signalé « Document manquant » après approbation."
                : 'Facultatif pour ce type de certificat.'
          }
        >
          {currentVersionFile && !file && (
            <div className="flex items-center gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm">
              <FileText className="h-4 w-4 text-action" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                <span className={removeFile ? 'text-ink-muted line-through' : undefined}>{currentVersionFile.name}</span>
                <span className="ml-1.5 text-xs text-ink-muted">{removeFile ? '— sera retirée' : '— pièce proposée par la version actuelle (conservée)'}</span>
              </span>
              <Button variant="ghost" size="sm" onClick={() => setRemoveFile((r) => !r)}>
                {removeFile ? 'Conserver' : 'Retirer'}
              </Button>
            </div>
          )}
          {file ? (
            <div className="flex items-center gap-2 rounded-md border border-ok-line bg-ok-bg px-3 py-2 text-sm">
              <FileText className="h-4 w-4 text-ok" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {file.originalName} <span className="text-xs text-ink-muted">({fmtBytes(file.sizeBytes)})</span>
              </span>
              <button type="button" className="rounded p-0.5 text-ink-muted hover:bg-white" aria-label="Retirer la pièce déposée" onClick={() => setFile(null)}>
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <FileUploader
              context="CERTIFICATE"
              vesselId={vesselIdForUpload}
              label={currentVersionFile ? 'Remplacer par un autre document' : 'Déposer le certificat (PDF ou image)'}
              disabled={isCreate && s.subjectKind === 'VESSEL' && !s.vesselId}
              onUploaded={(f) => {
                setFile(f);
                setRemoveFile(false);
              }}
            />
          )}
          {errors.fileId && (
            <p className="field-error" role="alert">
              {errors.fileId}
            </p>
          )}
          <p className="text-xs text-ink-muted">
            {selfApprove && props.mode !== 'edit'
              ? 'Publiée directement, la pièce devient le document officiel dès l’enregistrement.'
              : 'La pièce reste « en attente » et n’est jamais officielle avant l’approbation de la demande.'}
          </p>
        </Section>

        <Section title="Validation">
          <Field
            label={
              props.mode === 'correct'
                ? 'Motif de la correction'
                : props.mode === 'edit'
                  ? 'Note de modification'
                  : selfApprove
                    ? 'Note pour l’historique'
                    : 'Note pour les validateurs'
            }
            required={props.mode === 'correct'}
            htmlFor={ids.note}
            error={errors.changeNote}
            hint={props.mode === 'correct' ? 'Obligatoire — conservé dans l’historique.' : 'Facultatif.'}
          >
            <Textarea id={ids.note} rows={2} value={s.changeNote} invalid={!!errors.changeNote} onChange={(e) => set('changeNote', e.target.value)} maxLength={500} />
          </Field>
          {props.mode !== 'edit' &&
            (canSubmit ? (
              selfApprove ? (
                <Checkbox
                  label="Publier immédiatement (sans approbation)"
                  description="Votre profil publie directement : la décision est tracée à votre nom dans l’historique. Sinon, la demande reste en brouillon."
                  checked={s.submit}
                  onChange={(e) => set('submit', e.target.checked)}
                />
              ) : (
                <Checkbox
                  label="Soumettre immédiatement à approbation"
                  description="Tous les validateurs éligibles sont notifiés. Sinon, la demande reste en brouillon, visible de vous seul."
                  checked={s.submit}
                  onChange={(e) => set('submit', e.target.checked)}
                />
              )
            ) : (
              <p className="text-xs text-ink-muted">Vous n’avez pas le droit de soumettre : la demande sera enregistrée en brouillon.</p>
            ))}
          {(props.mode === 'renew' || props.mode === 'correct') && <ApproversHint data={approvers.data} loading={approvers.isLoading} />}
        </Section>
        <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
      </form>
    </Dialog>
  );
}

/** Destinataires de la demande d'approbation (même règle que la notification serveur). */
function ApproversHint({ data, loading }: { data?: ApproversDto; loading: boolean }) {
  if (loading) return <p className="text-xs text-ink-soft">Recherche des validateurs…</p>;
  if (!data) return null;
  if (data.selfApprove) {
    return (
      <p className="flex items-start gap-1.5 rounded-md bg-teal-50 px-3 py-2 text-xs text-teal-700">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>Aucune approbation requise : vous publiez directement.</span>
      </p>
    );
  }
  const names = data.approvers.map((a) => a.displayName);
  return (
    <div className={cn('flex items-start gap-1.5 rounded-md px-3 py-2 text-xs', names.length ? 'bg-canvas text-ink-muted' : 'bg-warn-bg text-warn')}>
      <Users className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      {names.length ? (
        <p>
          <span className="font-medium text-ink">Demande d’approbation envoyée à :</span> {names.slice(0, 6).join(', ')}
          {names.length > 6 ? ` et ${names.length - 6} autre(s)` : ''}.{' '}
          {data.validatorsConfigured
            ? 'Validateurs désignés pour ce type, ayant le droit d’approuver et accès au certificat.'
            : 'Utilisateurs ayant le droit « Approuver les certificats » et accès au certificat (aucun validateur désigné pour ce type).'}
        </p>
      ) : (
        <p>Aucun validateur éligible : la demande resterait en attente. Désignez des validateurs dans Configuration → types de certificat.</p>
      )}
    </div>
  );
}
