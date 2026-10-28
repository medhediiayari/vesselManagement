'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DateField, FormError, Notice, SelectField, TextAreaField, TextInputField } from './common';
import { CP_FIELD_LABELS, CP_TYPE_LABELS, cpKeys, nn, toDateInput } from './lib';
import type { CharterPartyBase } from './types';

export interface CpFormState {
  reference: string;
  vesselId: string;
  cpType: string;
  cpDate: string;
  charterer: string;
  owner: string;
  broker: string;
  signatories: string;
  laycanFrom: string;
  laycanTo: string;
  loadPorts: string;
  dischargePorts: string;
  cargoDescription: string;
  norClause: string;
  laytimeClause: string;
  freightTerms: string;
  demurrageTerms: string;
  otherClauses: string;
}

export function cpInit(cp?: Partial<CharterPartyBase> | null): CpFormState {
  return {
    reference: cp?.reference ?? '',
    vesselId: cp?.vesselId ?? '',
    cpType: cp?.cpType ?? 'VOYAGE',
    cpDate: toDateInput(cp?.cpDate),
    charterer: cp?.charterer ?? '',
    owner: cp?.owner ?? '',
    broker: cp?.broker ?? '',
    signatories: cp?.signatories ?? '',
    laycanFrom: toDateInput(cp?.laycanFrom),
    laycanTo: toDateInput(cp?.laycanTo),
    loadPorts: cp?.loadPorts ?? '',
    dischargePorts: cp?.dischargePorts ?? '',
    cargoDescription: cp?.cargoDescription ?? '',
    norClause: cp?.norClause ?? '',
    laytimeClause: cp?.laytimeClause ?? '',
    freightTerms: cp?.freightTerms ?? '',
    demurrageTerms: cp?.demurrageTerms ?? '',
    otherClauses: cp?.otherClauses ?? '',
  };
}

/** Champs contractuels -> corps API (texte vide = null : rien n'est inventé). */
export function cpContractPayload(f: CpFormState) {
  return {
    cpType: f.cpType,
    cpDate: f.cpDate || null,
    charterer: nn(f.charterer),
    owner: nn(f.owner),
    broker: nn(f.broker),
    signatories: nn(f.signatories),
    laycanFrom: f.laycanFrom || null,
    laycanTo: f.laycanTo || null,
    loadPorts: nn(f.loadPorts),
    dischargePorts: nn(f.dischargePorts),
    cargoDescription: nn(f.cargoDescription),
    norClause: nn(f.norClause),
    laytimeClause: nn(f.laytimeClause),
    freightTerms: nn(f.freightTerms),
    demurrageTerms: nn(f.demurrageTerms),
    otherClauses: nn(f.otherClauses),
  };
}

/** Sous-formulaire des champs contractuels (partagé : création, brouillon, nouvelle version). */
export function CpContractFields({ f, set }: { f: CpFormState; set: (k: keyof CpFormState) => (v: string) => void }) {
  const laycanError = f.laycanFrom && f.laycanTo && f.laycanFrom > f.laycanTo ? 'La date de début doit précéder la date de fin' : undefined;
  return (
    <div className="space-y-4">
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold text-navy">Parties et dates</legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <SelectField label={CP_FIELD_LABELS.cpType} value={f.cpType} onChange={set('cpType')} options={Object.entries(CP_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
          <DateField label={CP_FIELD_LABELS.cpDate} value={f.cpDate} onChange={set('cpDate')} />
          <TextInputField label={CP_FIELD_LABELS.signatories} value={f.signatories} onChange={set('signatories')} maxLength={500} hint="Si connus." />
          <TextInputField label={CP_FIELD_LABELS.charterer} value={f.charterer} onChange={set('charterer')} maxLength={200} />
          <TextInputField label={CP_FIELD_LABELS.owner} value={f.owner} onChange={set('owner')} maxLength={200} />
          <TextInputField label={CP_FIELD_LABELS.broker} value={f.broker} onChange={set('broker')} maxLength={200} />
          <DateField label={CP_FIELD_LABELS.laycanFrom} value={f.laycanFrom} onChange={set('laycanFrom')} />
          <DateField label={CP_FIELD_LABELS.laycanTo} value={f.laycanTo} onChange={set('laycanTo')} error={laycanError} />
        </div>
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold text-navy">Ports et cargaison</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField label={CP_FIELD_LABELS.loadPorts} value={f.loadPorts} onChange={set('loadPorts')} maxLength={500} />
          <TextInputField label={CP_FIELD_LABELS.dischargePorts} value={f.dischargePorts} onChange={set('dischargePorts')} maxLength={500} />
        </div>
        <TextAreaField label={CP_FIELD_LABELS.cargoDescription} value={f.cargoDescription} onChange={set('cargoDescription')} rows={2} maxLength={10000} />
      </fieldset>
      <fieldset className="space-y-3">
        <legend className="mb-1 text-sm font-semibold text-navy">Clauses (texte contractuel)</legend>
        <Notice tone="warn">
          Ne renseigner que les clauses explicitement présentes dans le contrat. Aucun paramètre financier ni règle de laytime n’est déduit ou
          calculé par la plateforme.
        </Notice>
        <TextAreaField label={CP_FIELD_LABELS.norClause} value={f.norClause} onChange={set('norClause')} rows={3} maxLength={20000} />
        <TextAreaField label={CP_FIELD_LABELS.laytimeClause} value={f.laytimeClause} onChange={set('laytimeClause')} rows={3} maxLength={20000} />
        <TextAreaField label={CP_FIELD_LABELS.freightTerms} value={f.freightTerms} onChange={set('freightTerms')} rows={2} maxLength={20000} />
        <TextAreaField label={CP_FIELD_LABELS.demurrageTerms} value={f.demurrageTerms} onChange={set('demurrageTerms')} rows={2} maxLength={20000} />
        <TextAreaField label={CP_FIELD_LABELS.otherClauses} value={f.otherClauses} onChange={set('otherClauses')} rows={3} maxLength={50000} />
      </fieldset>
    </div>
  );
}

/**
 * Création d'une Charter Party (brouillon) ou modification tant qu'aucune version n'est soumise.
 * Ensuite, toute modification passe par une nouvelle version (avenant / révision) approuvée.
 */
export function CpFormDialog({
  open,
  onOpenChange,
  cp,
  prefill,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  cp?: CharterPartyBase | null;
  prefill?: Partial<CharterPartyBase>;
  onSaved: (cp: CharterPartyBase) => void;
}) {
  const { me } = useSession();
  const qc = useQueryClient();
  const [f, setF] = useState<CpFormState>(() => cpInit(cp ?? prefill));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setF(cpInit(cp ?? prefill));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof CpFormState) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const laycanError = f.laycanFrom && f.laycanTo && f.laycanFrom > f.laycanTo;
  const vesselRequired = me.vesselScope !== 'ALL_FLEET';

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { reference: f.reference.trim(), vesselId: f.vesselId || null, ...cpContractPayload(f) };
      let res: CharterPartyBase;
      if (cp) {
        const before = { reference: cp.reference, vesselId: cp.vesselId, ...cpContractPayload(cpInit(cp)) };
        const changes = Object.fromEntries(Object.entries(body).filter(([k, v]) => before[k as keyof typeof before] !== v));
        res = await api.patch<CharterPartyBase>(`/charter-parties/${cp.id}`, changes);
        toast.success('Charter Party mise à jour');
      } else {
        res = await api.post<CharterPartyBase>('/charter-parties', body);
        toast.success(`Charter Party ${res.reference} créée (brouillon)`);
      }
      await qc.invalidateQueries({ queryKey: cpKeys.list });
      onSaved(res);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={cp ? `Modifier le brouillon ${cp.reference}` : 'Nouvelle Charter Party'}
      description="Document confidentiel. La version officielle (PDF) est soumise ensuite et doit être approuvée par un autre utilisateur habilité."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy} disabled={f.reference.trim().length < 2 || !!laycanError || (vesselRequired && !f.vesselId)}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField label="Référence / numéro" required value={f.reference} onChange={set('reference')} maxLength={80} placeholder="Ex. CP-ISK-2026-001" />
          <SelectField
            label="Navire"
            required={vesselRequired}
            value={f.vesselId}
            onChange={set('vesselId')}
            placeholder={vesselRequired ? 'Choisir un navire…' : 'Aucun (CP non rattachée à un navire)'}
            options={me.accessibleVessels.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))}
          />
        </div>
        <CpContractFields f={f} set={set} />
      </div>
    </Dialog>
  );
}
