'use client';

import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

export interface VesselDto {
  id: string;
  code: string;
  name: string;
  imoNumber: string | null;
  mmsi: string | null;
  callSign: string | null;
  flag: string | null;
  portOfRegistry: string | null;
  vesselType: string | null;
  status: 'ACTIVE' | 'INACTIVE' | 'LAID_UP' | 'SOLD';
  managerName: string | null;
  ownerName: string | null;
  classSociety: string | null;
  yearBuilt: number | null;
  builder: string | null;
  grossTonnage: string | null;
  netTonnage: string | null;
  deadweight: string | null;
  lengthOverall: string | null;
  beam: string | null;
  summerDraft: string | null;
  timezone: string;
  contactEmail: string | null;
  contactPhone: string | null;
  photoFileId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const FIELDS: { key: keyof VesselDto; label: string; hint?: string; type?: string; required?: boolean; span?: boolean }[] = [
  { key: 'name', label: 'Nom', required: true },
  { key: 'code', label: 'Code navire', hint: '2 à 16 caractères, ex. ISK', required: true },
  { key: 'imoNumber', label: 'Numéro OMI (IMO)', hint: '7 chiffres avec clé de contrôle' },
  { key: 'mmsi', label: 'MMSI', hint: '9 chiffres' },
  { key: 'callSign', label: 'Indicatif d’appel' },
  { key: 'flag', label: 'Pavillon', hint: 'Code pays ISO, ex. TN' },
  { key: 'portOfRegistry', label: "Port d'immatriculation" },
  { key: 'vesselType', label: 'Type de navire' },
  { key: 'classSociety', label: 'Société de classification' },
  { key: 'managerName', label: 'Gestionnaire' },
  { key: 'ownerName', label: 'Armateur / propriétaire' },
  { key: 'builder', label: 'Chantier' },
  { key: 'yearBuilt', label: 'Année de construction', type: 'number', hint: `Au plus ${new Date().getFullYear() + 3}` },
  { key: 'grossTonnage', label: 'Jauge brute (GT)' },
  { key: 'netTonnage', label: 'Jauge nette (NT)', hint: 'Au plus la jauge brute' },
  { key: 'deadweight', label: 'Port en lourd (DWT, t)' },
  { key: 'lengthOverall', label: 'Longueur hors-tout (m)' },
  { key: 'beam', label: 'Largeur (m)' },
  { key: 'summerDraft', label: "Tirant d'eau été (m)" },
  { key: 'timezone', label: 'Fuseau horaire (IANA)', hint: 'Heure bord affichée dans l’en-tête' },
  { key: 'contactEmail', label: 'E-mail de bord', type: 'email' },
  { key: 'contactPhone', label: 'Téléphone de bord' },
];

/** Libellés des champs (historique de la fiche navire). */
export const VESSEL_FIELD_LABELS: Record<string, string> = Object.fromEntries([
  ...FIELDS.map((f) => [f.key, f.label]),
  ['notes', 'Notes'],
]);

/** Fuseaux IANA du navigateur : une liste fermée évite les fautes de frappe (audit FLT-01). */
function timeZoneOptions(): string[] {
  const list = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  return Array.from(new Set(['UTC', ...list]));
}

function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Création / modification des informations officielles (historisées dans l'audit). */
export function VesselFormDialog({
  open,
  onOpenChange,
  vessel,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vessel?: VesselDto;
  onSaved: (v: VesselDto & { accessible?: boolean }) => void;
}) {
  const initial = Object.fromEntries(FIELDS.map((f) => [f.key, vessel?.[f.key] ?? ''])) as Record<string, string | number>;
  const [values, setValues] = useState<Record<string, string | number>>({ ...initial, notes: vessel?.notes ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [zones] = useState(timeZoneOptions);

  async function save() {
    setBusy(true);
    setErrors({});
    setFormError(null);
    const payload: Record<string, unknown> = {};
    for (const f of [...FIELDS.map((x) => x.key), 'notes' as const]) {
      const v = values[f];
      if (v === '' || v === undefined) {
        if (vessel) payload[f] = f === 'timezone' ? undefined : null;
        continue;
      }
      payload[f] = f === 'yearBuilt' ? Number(v) : v;
    }
    try {
      const res = vessel ? await api.patch<VesselDto>(`/vessels/${vessel.id}`, payload) : await api.post<VesselDto>('/vessels', payload);
      onSaved(res);
      onOpenChange(false);
    } catch (e) {
      if (e instanceof ApiError) {
        setErrors(e.fieldErrors);
        setFormError(e.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={vessel ? `Modifier ${vessel.name}` : 'Nouveau navire'}
      description="Les modifications des informations officielles sont historisées."
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={save} loading={busy} disabled={!values.name || !values.code}>
            {vessel ? 'Enregistrer' : 'Créer le navire'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {FIELDS.map((f) => (
          <Field key={f.key} label={f.label} hint={f.hint} error={errors[f.key]} required={f.required} htmlFor={`v-${f.key}`}>
            {f.key === 'timezone' ? (
              <Select
                id={`v-${f.key}`}
                value={String(values.timezone || 'UTC')}
                invalid={!!errors.timezone}
                onChange={(e) => setValues((s) => ({ ...s, timezone: e.target.value }))}
              >
                {/* Valeur historique hors liste : conservée et signalée pour être corrigée */}
                {values.timezone && !zones.includes(String(values.timezone)) && (
                  <option value={String(values.timezone)}>
                    {String(values.timezone)}
                    {isValidTimeZone(String(values.timezone)) ? '' : ' (invalide)'}
                  </option>
                )}
                {zones.map((z) => (
                  <option key={z} value={z}>
                    {z}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                id={`v-${f.key}`}
                type={f.type ?? 'text'}
                value={values[f.key] ?? ''}
                invalid={!!errors[f.key]}
                onChange={(e) => setValues((s) => ({ ...s, [f.key]: e.target.value }))}
              />
            )}
          </Field>
        ))}
        <Field label="Notes" className="sm:col-span-2" htmlFor="v-notes">
          <Textarea id="v-notes" value={values.notes ?? ''} onChange={(e) => setValues((s) => ({ ...s, notes: e.target.value }))} />
        </Field>
      </div>
      {formError && (
        <p className="mt-3 rounded-md border border-danger-line bg-danger-bg px-3 py-2 text-sm text-danger" role="alert">
          {formError}
        </p>
      )}
    </Dialog>
  );
}
