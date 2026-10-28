'use client';

import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtDecimal } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button, IconButton } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/field';
import { Panel } from '@/components/ui/page';
import { EmptyState } from '@/components/ui/states';
import { FormError, StoredText, TextAreaField, TextInputField } from './common';
import { nn, useOp, voyageKeys } from './lib';
import type { CargoRow, VoyageWorkspace } from './types';

interface CargoForm {
  commodity: string;
  description: string;
  qtyMinMt: string;
  qtyMaxMt: string;
  qtyActualMt: string;
  unit: string;
  quantityOption: string;
  stowageFactor: string;
  stowageFactorUnit: string;
  isDangerous: boolean;
  documentation: string;
  notes: string;
}

const init = (c?: CargoRow | null): CargoForm => ({
  commodity: c?.commodity ?? '',
  description: c?.description ?? '',
  qtyMinMt: c?.qtyMinMt ?? '',
  qtyMaxMt: c?.qtyMaxMt ?? '',
  qtyActualMt: c?.qtyActualMt ?? '',
  unit: c?.unit ?? 'MT',
  quantityOption: c?.quantityOption ?? '',
  stowageFactor: c?.stowageFactor ?? '',
  stowageFactorUnit: c?.stowageFactorUnit ?? '',
  isDangerous: c?.isDangerous ?? false,
  documentation: c?.documentation ?? '',
  notes: c?.notes ?? '',
});

/** Décimal ≥ 0 (virgule acceptée), au plus `scale` décimales. */
function decError(v: string, scale: number, intDigits: number): string | undefined {
  if (!v.trim()) return undefined;
  const s = v.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(s)) return 'Nombre positif attendu';
  const [i, d] = s.split('.');
  if ((d?.length ?? 0) > scale) return `Au plus ${scale} décimales`;
  if (i.replace(/^0+(?=\d)/, '').length > intDigits) return `Au plus ${intDigits} chiffres avant la virgule`;
  return undefined;
}
const dec = (v: string) => (v.trim() ? v.trim().replace(',', '.') : null);

function CargoDialog({ open, onOpenChange, voyageId, cargo }: { open: boolean; onOpenChange: (o: boolean) => void; voyageId: string; cargo: CargoRow | null }) {
  const [f, setF] = useState<CargoForm>(() => init(cargo));
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    if (open) {
      setF(init(cargo));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof CargoForm) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const errs = {
    qtyMinMt: decError(f.qtyMinMt, 3, 11),
    qtyMaxMt: decError(f.qtyMaxMt, 3, 11),
    qtyActualMt: decError(f.qtyActualMt, 3, 11),
    stowageFactor: decError(f.stowageFactor, 3, 7),
  };
  const minMax =
    !errs.qtyMinMt && !errs.qtyMaxMt && dec(f.qtyMinMt) && dec(f.qtyMaxMt) && Number(dec(f.qtyMinMt)) > Number(dec(f.qtyMaxMt))
      ? 'Minimum supérieur au maximum'
      : undefined;
  const invalid = f.commodity.trim().length < 2 || !f.unit.trim() || Object.values(errs).some(Boolean) || !!minMax;
  const save = useOp(
    () => {
      const body = {
        commodity: f.commodity.trim(),
        description: nn(f.description),
        qtyMinMt: dec(f.qtyMinMt),
        qtyMaxMt: dec(f.qtyMaxMt),
        qtyActualMt: dec(f.qtyActualMt),
        unit: f.unit.trim(),
        quantityOption: nn(f.quantityOption),
        stowageFactor: dec(f.stowageFactor),
        stowageFactorUnit: nn(f.stowageFactorUnit),
        isDangerous: f.isDangerous,
        documentation: nn(f.documentation),
        notes: nn(f.notes),
      };
      return cargo ? api.patch(`/voyages/${voyageId}/cargo/${cargo.id}`, body) : api.post(`/voyages/${voyageId}/cargo`, body);
    },
    {
      success: cargo ? 'Cargaison mise à jour' : 'Cargaison ajoutée',
      invalidate: [voyageKeys.ws(voyageId)],
      onSuccess: () => onOpenChange(false),
      onError: (e) => {
        setError(e);
        return true;
      },
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={cargo ? `Cargaison — ${cargo.commodity}` : 'Ajouter une cargaison'}
      description="Quantités en décimal exact (aucun arrondi). Laisser vide ce qui n’est pas documenté."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={invalid}>
            Enregistrer
          </Button>
        </>
      }
    >
      <FormError error={error} />
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField label="Commodity" required value={f.commodity} onChange={set('commodity')} maxLength={200} placeholder="Ex. DAP Fertiliser in Bulk" />
          <TextInputField label="Unité" required value={f.unit} onChange={set('unit')} maxLength={16} />
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <TextInputField label="Quantité min" inputMode="decimal" value={f.qtyMinMt} onChange={set('qtyMinMt')} error={errs.qtyMinMt} />
          <TextInputField label="Quantité max" inputMode="decimal" value={f.qtyMaxMt} onChange={set('qtyMaxMt')} error={errs.qtyMaxMt ?? minMax} />
          <TextInputField label="Quantité réelle" inputMode="decimal" value={f.qtyActualMt} onChange={set('qtyActualMt')} error={errs.qtyActualMt} />
          <TextInputField label="Option" value={f.quantityOption} onChange={set('quantityOption')} maxLength={120} placeholder="owners option" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInputField label="Stowage factor" inputMode="decimal" value={f.stowageFactor} onChange={set('stowageFactor')} error={errs.stowageFactor} />
          <TextInputField label="Unité du stowage factor" value={f.stowageFactorUnit} onChange={set('stowageFactorUnit')} maxLength={32} placeholder="cbft/MT WOG" />
        </div>
        <Checkbox
          label="Marchandise dangereuse"
          description="À cocher uniquement si le document le mentionne."
          checked={f.isDangerous}
          onChange={(e) => setF((p) => ({ ...p, isDangerous: e.target.checked }))}
        />
        <TextAreaField label="Description" value={f.description} onChange={set('description')} rows={2} maxLength={5000} />
        <TextAreaField label="Documentation (survey, B/L, certificats…)" value={f.documentation} onChange={set('documentation')} rows={2} maxLength={5000} />
        <TextAreaField label="Notes" value={f.notes} onChange={set('notes')} rows={2} maxLength={5000} />
      </div>
    </Dialog>
  );
}

export function CargoTab({ ws }: { ws: VoyageWorkspace }) {
  const id = ws.overview.id;
  const canEdit = ws.permissions.edit;
  const [dialog, setDialog] = useState<{ cargo: CargoRow | null } | null>(null);
  const [remove, setRemove] = useState<CargoRow | null>(null);
  const del = useOp((cargoId: string) => api.delete(`/voyages/${id}/cargo/${cargoId}`), {
    success: 'Cargaison supprimée',
    invalidate: [voyageKeys.ws(id)],
  });
  return (
    <Panel
      title="Cargaison"
      actions={
        canEdit && (
          <Button size="sm" onClick={() => setDialog({ cargo: null })}>
            <Plus className="h-4 w-4" aria-hidden /> Ajouter
          </Button>
        )
      }
      bodyClassName="p-0"
    >
      {ws.cargo.length === 0 ? (
        <EmptyState title="Aucune cargaison" description="Commodity, quantités min / max / réelle, stowage factor et documentation." />
      ) : (
        <ul className="divide-y divide-line">
          {ws.cargo.map((c) => (
            <li key={c.id} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-navy">{c.commodity}</p>
                  {c.description && <p className="text-sm text-ink-muted">{c.description}</p>}
                </div>
                <div className="flex items-center gap-1">
                  {c.isDangerous && (
                    <Badge tone="danger" icon={<AlertTriangle className="h-3.5 w-3.5" aria-hidden />}>
                      Dangereuse
                    </Badge>
                  )}
                  {canEdit && (
                    <>
                      <IconButton label={`Modifier ${c.commodity}`} onClick={() => setDialog({ cargo: c })}>
                        <Pencil className="h-4 w-4" />
                      </IconButton>
                      <IconButton label={`Supprimer ${c.commodity}`} onClick={() => setRemove(c)}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </>
                  )}
                </div>
              </div>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
                <div>
                  <dt className="text-xs text-ink-muted">Quantité contractuelle</dt>
                  <dd className="tabular">
                    {c.qtyMinMt || c.qtyMaxMt ? `${fmtDecimal(c.qtyMinMt)} – ${fmtDecimal(c.qtyMaxMt)} ${c.unit}` : '—'}
                    {c.quantityOption && <span className="block text-xs text-ink-muted">{c.quantityOption}</span>}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Quantité réelle</dt>
                  <dd className="tabular">{c.qtyActualMt ? `${fmtDecimal(c.qtyActualMt)} ${c.unit}` : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Stowage factor</dt>
                  <dd className="tabular">{c.stowageFactor ? `${fmtDecimal(c.stowageFactor)} ${c.stowageFactorUnit ?? ''}` : '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-ink-muted">Documentation</dt>
                  <dd>
                    <StoredText>{c.documentation}</StoredText>
                  </dd>
                </div>
              </dl>
              {c.notes && (
                <div className="mt-2">
                  <StoredText className="text-ink-muted">{c.notes}</StoredText>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <CargoDialog open={!!dialog} onOpenChange={(o) => !o && setDialog(null)} voyageId={id} cargo={dialog?.cargo ?? null} />
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title={`Supprimer la cargaison ${remove?.commodity ?? ''} ?`}
        confirmLabel="Supprimer"
        tone="danger"
        onConfirm={async () => {
          if (remove) await del.mutateAsync(remove.id).catch(() => undefined);
        }}
      />
    </Panel>
  );
}
