'use client';

import { AlertTriangle, Lock, Pencil, RefreshCw, Save, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { ApiError, api, errorMessage } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { customFieldErrors, CustomFieldInput } from './custom-field-input';
import { DUPLICATE_MESSAGE } from './member-create-dialog';
import {
  buildCorePatch,
  CORE_GROUPS,
  CoreGroupFields,
  isProtectedField,
  toCoreValues,
  type CoreKey,
  type CoreValues,
} from './member-form';
import { DuplicateCandidateList, formatCustomValue } from './member-ui';
import type { DuplicateCandidate, MemberDetail } from './types';

interface Props {
  member: MemberDetail;
  /** staff : PATCH /members/:id (verrou optimiste) ; self : PATCH /members/me (champs ouverts au libre-service) */
  mode: 'staff' | 'self';
  /** Libre-service : champs de contact ouverts par le Super Admin (members.selfEditableFields) */
  selfEditableFields?: string[];
  /** Recharge la fiche (après enregistrement ou conflit de version) ; renvoie la fiche fraîche */
  reload: () => Promise<MemberDetail | undefined>;
}

function customValuesOf(m: MemberDetail): Record<string, unknown> {
  return Object.fromEntries(m.customFields.flatMap((s) => s.fields.map((f) => [f.key, f.value ?? null])));
}

/**
 * Onglet Profil : identité, coordonnées, passeport / seaman book, fonction et sections de champs
 * personnalisés. Champs protégés en lecture seule sans members.personal_fields.manage ; enregistrement
 * avec expectedUpdatedAt (409 STALE_VERSION : rechargement en conservant les saisies).
 */
export function MemberProfile({ member, mode, selfEditableFields, reload }: Props) {
  const archived = !!member.archivedAt;
  const [editing, setEditing] = useState(false);
  const [base, setBase] = useState<CoreValues>(() => toCoreValues(member));
  const [values, setValues] = useState<CoreValues>(() => toCoreValues(member));
  const [baseCustom, setBaseCustom] = useState<Record<string, unknown>>(() => customValuesOf(member));
  const [custom, setCustom] = useState<Record<string, unknown>>(() => customValuesOf(member));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});
  const [stale, setStale] = useState(false);
  const [dup, setDup] = useState<{ message: string; candidates: DuplicateCandidate[]; forceable: boolean } | null>(null);
  const [forceReason, setForceReason] = useState('');
  const [busy, setBusy] = useState(false);
  const versionRef = useRef(member.updatedAt);

  // Fiche rechargée hors édition : resynchronise l'affichage
  useEffect(() => {
    if (editing) return;
    setBase(toCoreValues(member));
    setValues(toCoreValues(member));
    setBaseCustom(customValuesOf(member));
    setCustom(customValuesOf(member));
    versionRef.current = member.updatedAt;
  }, [member, editing]);

  const editable = useMemo(() => {
    if (archived) return () => false;
    if (mode === 'self') {
      const allowed = new Set(selfEditableFields ?? []);
      return (k: CoreKey) => allowed.has(k);
    }
    return (k: CoreKey) => member.permissions.canEdit && (!isProtectedField(k) || member.permissions.canEditProtected);
  }, [archived, mode, selfEditableFields, member.permissions]);

  const anyEditable =
    !archived &&
    (CORE_GROUPS.some((g) => g.fields.some((f) => editable(f.key))) || member.customFields.some((s) => s.fields.some((f) => f.editable)));

  const allowedKeys = CORE_GROUPS.flatMap((g) => g.fields.map((f) => f.key)).filter(editable);
  const corePatch = buildCorePatch(base, values, allowedKeys);
  const customPatch = Object.fromEntries(
    Object.entries(custom).filter(([k, v]) => JSON.stringify(v ?? null) !== JSON.stringify(baseCustom[k] ?? null)),
  );
  const dirty = Object.keys(corePatch).length + Object.keys(customPatch).length > 0;

  const cancel = () => {
    setValues(base);
    setCustom(baseCustom);
    setErrors({});
    setCustomErrors({});
    setStale(false);
    setDup(null);
    setForceReason('');
    setEditing(false);
  };

  /** 409 STALE_VERSION : relit la fiche puis réapplique les saisies de l'utilisateur par-dessus. */
  const reloadKeepingChanges = async () => {
    const mine = { core: corePatch, custom: customPatch };
    const fresh = await reload();
    if (!fresh) return;
    const freshValues = toCoreValues(fresh);
    const freshCustom = customValuesOf(fresh);
    setBase(freshValues);
    setBaseCustom(freshCustom);
    setValues({ ...freshValues, ...(Object.fromEntries(Object.entries(mine.core).map(([k, v]) => [k, v ?? ''])) as Partial<CoreValues>) });
    setCustom({ ...freshCustom, ...mine.custom });
    versionRef.current = fresh.updatedAt;
    setStale(false);
    toast.info('Fiche rechargée : vos saisies ont été conservées, vérifiez-les puis enregistrez.');
  };

  const save = async (force = false) => {
    if (!dirty) {
      toast.info('Aucune modification à enregistrer');
      setEditing(false);
      return;
    }
    setBusy(true);
    setErrors({});
    setCustomErrors({});
    try {
      const body: Record<string, unknown> = { ...corePatch };
      if (Object.keys(customPatch).length) body.customFields = customPatch;
      if (mode === 'staff') {
        body.expectedUpdatedAt = versionRef.current;
        if (force) Object.assign(body, { force: true, forceReason: forceReason.trim() });
        await api.patch(`/members/${member.id}`, body);
      } else {
        await api.patch('/members/me', body);
      }
      toast.success(mode === 'self' ? 'Coordonnées mises à jour' : 'Fiche enregistrée');
      setDup(null);
      setForceReason('');
      setEditing(false);
      await reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE_VERSION') {
        setStale(true);
      } else if (e instanceof ApiError && e.code === 'DUPLICATE') {
        const d = (e.details ?? {}) as { candidates?: DuplicateCandidate[]; reason?: string };
        const forceable = d.reason !== 'AMC_REF';
        setDup({ message: forceable ? DUPLICATE_MESSAGE : e.message, candidates: d.candidates ?? [], forceable });
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          Créée le {fmtDateTime(member.createdAt)} — dernière mise à jour {fmtDateTime(member.updatedAt)}
        </p>
        {anyEditable &&
          (editing ? (
            <div className="flex gap-2">
              <Button variant="secondary" onClick={cancel} disabled={busy}>
                <X className="h-4 w-4" aria-hidden /> Annuler
              </Button>
              <Button onClick={() => save(false)} loading={busy} disabled={!dirty || stale || !!dup}>
                <Save className="h-4 w-4" aria-hidden /> Enregistrer
              </Button>
            </div>
          ) : (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" aria-hidden /> {mode === 'self' ? 'Modifier mes coordonnées' : 'Modifier'}
            </Button>
          ))}
      </div>

      {editing && mode === 'staff' && !member.permissions.canEditProtected && (
        <p className="flex items-start gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Matricule, naissance, nationalité, genre, passeport et seaman book sont en lecture seule : leur modification exige la permission
          « données personnelles protégées ».
        </p>
      )}
      {editing && mode === 'self' && (
        <p className="flex items-start gap-2 rounded-md border border-line bg-white px-3 py-2 text-sm text-ink-muted">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          Seules les coordonnées ouvertes au libre-service sont modifiables ; vos données officielles et professionnelles sont tenues par
          l’équipe Crewing. La mise à jour est immédiate et journalisée.
        </p>
      )}

      {stale && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-warn-line bg-warn-bg px-3 py-2 text-sm text-warn" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            La fiche a été modifiée par un autre utilisateur depuis son ouverture. Rechargez-la : vos saisies seront conservées.
          </span>
          <Button size="sm" variant="secondary" onClick={reloadKeepingChanges}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Recharger la fiche
          </Button>
        </div>
      )}

      {dup && (
        <Panel title="Doublon potentiel détecté" className="border border-danger-line">
          <p className="mb-3 text-sm text-danger" role="alert">
            {dup.message}
          </p>
          <DuplicateCandidateList candidates={dup.candidates} />
          {dup.forceable ? (
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <Field label="Motif pour enregistrer malgré le doublon" required htmlFor="upd-force" hint="5 caractères minimum — conservé dans le journal d'audit.">
                <Textarea id="upd-force" rows={2} value={forceReason} onChange={(e) => setForceReason(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setDup(null)}>
                  Revoir la saisie
                </Button>
                <Button variant="danger" onClick={() => save(true)} loading={busy} disabled={forceReason.trim().length < 5}>
                  Enregistrer quand même
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-3 flex justify-end">
              <Button variant="secondary" onClick={() => setDup(null)}>
                Revoir la saisie
              </Button>
            </div>
          )}
        </Panel>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {CORE_GROUPS.map((g) => (
          <Panel key={g.id} title={g.title}>
            <CoreGroupFields
              fields={g.fields}
              values={values}
              onChange={(k, v) => setValues((prev) => ({ ...prev, [k]: v }))}
              editable={editable}
              errors={errors}
              editing={editing}
            />
            {g.id === 'crew' && (
              <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-3 border-t border-line pt-3 sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-ink-muted">Département</dt>
                  <dd className="mt-0.5 text-sm">{member.department ? `${member.department.name} (${member.department.code})` : '—'}</dd>
                </div>
              </dl>
            )}
          </Panel>
        ))}
        {member.customFields.map((s) => (
          <Panel key={s.id ?? '__none__'} title={s.name}>
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              {s.fields.map((f) =>
                editing && f.editable ? (
                  <CustomFieldInput
                    key={f.key}
                    field={f}
                    value={custom[f.key] ?? null}
                    onChange={(v) => setCustom((c) => ({ ...c, [f.key]: v }))}
                    error={customErrors[f.key]}
                  />
                ) : (
                  <div key={f.key} className="min-w-0">
                    <p className="flex items-center gap-2 text-xs text-ink-muted">
                      {f.label}
                      {editing && !f.editable && (
                        <span className="inline-flex items-center gap-1">
                          <Lock className="h-3 w-3" aria-hidden /> Lecture seule
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 break-words text-sm">{formatCustomValue({ type: f.type, value: custom[f.key] })}</p>
                  </div>
                ),
              )}
            </div>
          </Panel>
        ))}
      </div>
    </div>
  );
}
