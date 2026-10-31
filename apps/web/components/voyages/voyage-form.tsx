'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type Page } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { DateField, FormError, Notice, SelectField, TextAreaField, TextInputField, UtcDateTimeField } from './common';
import { CP_STATUS_LABELS, cpKeys, fromUtcInput, nn, toDateInput, toUtcInput, voyageKeys } from './lib';
import type { CpListItem, VoyageBase } from './types';

interface FormState {
  vesselId: string;
  charterer: string;
  broker: string;
  description: string;
  laycanFrom: string;
  laycanTo: string;
  etd: string;
  eta: string;
  atd: string;
  ata: string;
  notes: string;
  charterPartyId: string;
}

function initial(v?: VoyageBase | null, vesselId?: string | null): FormState {
  return {
    vesselId: v?.vesselId ?? vesselId ?? '',
    charterer: v?.charterer ?? '',
    broker: v?.broker ?? '',
    description: v?.description ?? '',
    laycanFrom: toDateInput(v?.laycanFrom),
    laycanTo: toDateInput(v?.laycanTo),
    etd: toUtcInput(v?.etd),
    eta: toUtcInput(v?.eta),
    atd: toUtcInput(v?.atd),
    ata: toUtcInput(v?.ata),
    notes: v?.notes ?? '',
    charterPartyId: v?.charterPartyId ?? '',
  };
}

function payload(f: FormState) {
  return {
    charterer: nn(f.charterer),
    broker: nn(f.broker),
    description: nn(f.description),
    laycanFrom: f.laycanFrom || null,
    laycanTo: f.laycanTo || null,
    etd: fromUtcInput(f.etd),
    eta: fromUtcInput(f.eta),
    atd: fromUtcInput(f.atd),
    ata: fromUtcInput(f.ata),
    notes: nn(f.notes),
  };
}

/** CP rattachables pour un navire (actives, non rattachées à un autre voyage). */
export function useLinkableCps(vesselId: string | null | undefined, voyageId: string | null, enabled: boolean) {
  const q = useQuery({
    queryKey: [...cpKeys.list, 'linkable', vesselId],
    queryFn: () => api.get<Page<CpListItem>>('/charter-parties', { query: { vesselId: vesselId ?? undefined, limit: 200 } }),
    enabled: enabled && !!vesselId,
  });
  const items = (q.data?.items ?? []).filter(
    (cp) => ['DRAFT', 'PENDING_APPROVAL', 'APPROVED'].includes(cp.status) && cp.voyages.every((v) => v.id === voyageId),
  );
  return { ...q, items };
}

/**
 * Création (DRAFT) / modification d'un voyage. En modification, seuls les champs changés sont
 * envoyés avec `expectedVersion` (verrou optimiste) ; les changements ETA/ETD/ATA/ATD sont audités.
 */
export function VoyageFormDialog({
  open,
  onOpenChange,
  voyage,
  defaultVesselId,
  onSaved,
  focus,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  voyage?: VoyageBase | null;
  defaultVesselId?: string | null;
  onSaved: (v: VoyageBase) => void;
  /** Mise à jour rapide de l'ETA : réduit le formulaire au planning */
  focus?: 'schedule';
}) {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const [f, setF] = useState<FormState>(() => initial(voyage, defaultVesselId));
  /** Version de référence figée à l'ouverture : garantit le verrou optimiste même si la fiche est rafraîchie */
  const [base, setBase] = useState<VoyageBase | null>(voyage ?? null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const editing = !!voyage;
  const set = (k: keyof FormState) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  // Réinitialisation à l'ouverture uniquement (un rafraîchissement en arrière-plan n'efface pas la saisie)
  useEffect(() => {
    if (open) {
      setF(initial(voyage, defaultVesselId));
      setBase(voyage ?? null);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const cps = useLinkableCps(f.vesselId, voyage?.id ?? null, open && !editing && can('charter_party.view'));
  const laycanError = f.laycanFrom && f.laycanTo && f.laycanFrom > f.laycanTo ? 'La date de début doit précéder la date de fin' : undefined;
  const vessels = me.accessibleVessels.filter((v) => v.status !== 'SOLD');
  // Mêmes contrôles que l'API (audit FLT-06) : valeurs « AAAA-MM-JJTHH:mm » UTC, comparables comme chaînes
  const actualLimit = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 16);
  const baseForm = base ? initial(base) : null;
  const futureActual = (k: 'atd' | 'ata') => !!f[k] && f[k] > actualLimit && f[k] !== baseForm?.[k];
  const timeErrors = {
    eta: f.etd && f.eta && f.etd > f.eta ? 'L’ETA doit suivre l’ETD' : undefined,
    atd: futureActual('atd') ? 'Date réelle dans le futur' : undefined,
    ata: f.atd && f.ata && f.atd > f.ata ? 'L’ATA doit suivre l’ATD' : futureActual('ata') ? 'Date réelle dans le futur' : undefined,
  };
  const timeInvalid = Object.values(timeErrors).some(Boolean);

  const changes = useMemo(() => {
    if (!base) return null;
    const a = payload(initial(base));
    const b = payload(f);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(b) as (keyof typeof b)[]) if (a[k] !== b[k]) out[k] = b[k];
    return out;
  }, [f, base]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      let res: VoyageBase;
      if (base) {
        res = await api.patch<VoyageBase>(`/voyages/${base.id}`, { ...changes, expectedVersion: base.lockVersion });
        toast.success('Voyage mis à jour');
      } else {
        res = await api.post<VoyageBase>('/voyages', {
          vesselId: f.vesselId,
          ...payload(f),
          ...(f.charterPartyId ? { charterPartyId: f.charterPartyId } : {}),
        });
        toast.success(`Voyage ${res.reference} créé (brouillon)`);
      }
      await qc.invalidateQueries({ queryKey: voyageKeys.list });
      onSaved(res);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }

  const schedule = (
    <div className="grid gap-3 sm:grid-cols-2">
      <UtcDateTimeField label="ETD" value={f.etd} onChange={set('etd')} />
      <UtcDateTimeField label="ETA" value={f.eta} onChange={set('eta')} hint="Arrivée estimée au port de destination." error={timeErrors.eta} />
      {editing && (
        <>
          <UtcDateTimeField label="ATD" value={f.atd} onChange={set('atd')} hint="Départ réel." error={timeErrors.atd} />
          <UtcDateTimeField label="ATA" value={f.ata} onChange={set('ata')} hint="Arrivée réelle." error={timeErrors.ata} />
        </>
      )}
    </div>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={editing ? (focus === 'schedule' ? `Mettre à jour le planning — ${voyage!.reference}` : `Modifier ${voyage!.reference}`) : 'Nouveau voyage'}
      description={
        editing
          ? 'Chaque modification de planning (ETD/ETA/ATD/ATA, laycan) est tracée dans la chronologie du voyage.'
          : 'Le voyage est créé en brouillon ; la référence est attribuée automatiquement (ex. ISK-VOY-2026-0002).'
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button
            onClick={save}
            loading={busy}
            disabled={!!laycanError || timeInvalid || (!editing && !f.vesselId) || (editing && changes !== null && Object.keys(changes).length === 0)}
          >
            {editing ? 'Enregistrer' : 'Créer le voyage'}
          </Button>
        </>
      }
    >
      <FormError
        error={error}
        onReload={() => {
          void qc.invalidateQueries({ queryKey: voyageKeys.ws(voyage?.id ?? '') });
          onOpenChange(false);
        }}
      />
      {focus === 'schedule' ? (
        <div className="space-y-3">
          {schedule}
          <div className="grid gap-3 sm:grid-cols-2">
            <DateField label="Laycan — début" value={f.laycanFrom} onChange={set('laycanFrom')} />
            <DateField label="Laycan — fin" value={f.laycanTo} onChange={set('laycanTo')} error={laycanError} />
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {editing ? (
              <TextInputField label="Navire" value={me.accessibleVessels.find((v) => v.id === f.vesselId)?.name ?? '—'} onChange={() => undefined} disabled />
            ) : (
              <SelectField
                label="Navire"
                required
                value={f.vesselId}
                onChange={(v) => setF((p) => ({ ...p, vesselId: v, charterPartyId: '' }))}
                placeholder="Choisir un navire…"
                options={vessels.map((v) => ({ value: v.id, label: `${v.name} (${v.code})` }))}
              />
            )}
            <TextInputField label="Charterer" value={f.charterer} onChange={set('charterer')} maxLength={200} placeholder="Ex. SEMBODJA CO. LTD" />
            <TextInputField label="Broker" value={f.broker} onChange={set('broker')} maxLength={200} hint="Facultatif — ne renseigner que si connu." />
            <div className="grid grid-cols-2 gap-3">
              <DateField label="Laycan — début" value={f.laycanFrom} onChange={set('laycanFrom')} />
              <DateField label="Laycan — fin" value={f.laycanTo} onChange={set('laycanTo')} error={laycanError} />
            </div>
          </div>
          <TextAreaField label="Description" value={f.description} onChange={set('description')} rows={2} maxLength={5000} />
          {schedule}
          {!editing && can('charter_party.view') && (
            <SelectField
              label="Charter Party (facultatif en brouillon)"
              value={f.charterPartyId}
              onChange={set('charterPartyId')}
              placeholder={f.vesselId ? (cps.isLoading ? 'Chargement…' : 'Aucune — rattacher plus tard') : 'Choisir d’abord le navire'}
              disabled={!f.vesselId}
              options={cps.items.map((cp) => ({
                value: cp.id,
                label: `${cp.reference} — ${cp.charterer ?? 'charterer non renseigné'} — laycan ${fmtDate(cp.laycanFrom)} → ${fmtDate(cp.laycanTo)} (${CP_STATUS_LABELS[cp.status]})`,
              }))}
              hint="Le rattachement devient obligatoire pour quitter le brouillon lorsqu’une CP existe pour ce voyage."
            />
          )}
          <TextAreaField label="Notes" value={f.notes} onChange={set('notes')} rows={3} maxLength={10000} />
          {!editing && (
            <Notice title="Ne jamais inventer de données">
              Laissez vides les champs inconnus (broker, références financières…) : ils pourront être complétés plus tard.
            </Notice>
          )}
        </div>
      )}
    </Dialog>
  );
}
