'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { api, type StoredFileDto } from '@/lib/api';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormError, Notice, SelectField, TextAreaField } from './common';
import { CpContractFields, cpContractPayload, cpInit, type CpFormState } from './cp-form';
import { CP_FIELD_LABELS, CP_VERSION_KIND_LABELS, cpKeys } from './lib';
import type { CpDetail } from './types';

/**
 * Soumission d'une version officielle (ORIGINAL / ADDENDUM / REVISION) avec PDF (contexte CHARTER_PARTY).
 * Seules les clauses effectivement modifiées sont envoyées ; la version en vigueur reste opposable
 * jusqu'à l'approbation par un AUTRE utilisateur habilité.
 */
export function CpVersionDialog({ open, onOpenChange, cp }: { open: boolean; onOpenChange: (o: boolean) => void; cp: CpDetail }) {
  const qc = useQueryClient();
  const hasApproved = cp.versions.some((v) => v.status === 'APPROVED');
  const kinds = hasApproved ? ['ADDENDUM', 'REVISION'] : ['ORIGINAL'];
  const [kind, setKind] = useState(kinds[0]);
  const [file, setFile] = useState<StoredFileDto | null>(null);
  const [summary, setSummary] = useState('');
  const [f, setF] = useState<CpFormState>(() => cpInit(cp));
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setKind(kinds[0]);
      setFile(null);
      setSummary('');
      setF(cpInit(cp));
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const set = (k: keyof CpFormState) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const changes = useMemo(() => {
    const before = cpContractPayload(cpInit(cp));
    const after = cpContractPayload(f);
    return Object.fromEntries(Object.entries(after).filter(([k, v]) => before[k as keyof typeof before] !== v));
  }, [f, cp]);
  const changed = Object.keys(changes);
  const laycanError = f.laycanFrom && f.laycanTo && f.laycanFrom > f.laycanTo;
  const pointless = kind !== 'ORIGINAL' && !changed.length && !file;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ versionNo: number; changedFields: string[] }>(`/charter-parties/${cp.id}/versions`, {
        kind,
        ...(file ? { fileId: file.id } : {}),
        summary: summary.trim() || null,
        ...(changed.length ? { changes } : {}),
      });
      toast.success(`Version v${res.versionNo} soumise à approbation (${res.changedFields.length} clause(s) modifiée(s))`);
      await Promise.all([qc.invalidateQueries({ queryKey: cpKeys.detail(cp.id) }), qc.invalidateQueries({ queryKey: cpKeys.list })]);
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
      title={hasApproved ? 'Soumettre un avenant / une révision' : 'Soumettre la version officielle (ORIGINAL)'}
      description="La version sera approuvée par un autre utilisateur habilité (charter_party.approve). La version en vigueur reste opposable d’ici là."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Annuler
          </Button>
          <Button onClick={submit} loading={busy} disabled={!!laycanError || pointless || !!cp.pendingVersion}>
            Soumettre à approbation
          </Button>
        </>
      }
    >
      <FormError error={error} />
      {cp.pendingVersion && (
        <Notice tone="warn" className="mb-3">
          La version v{cp.pendingVersion.versionNo} est déjà en attente d’approbation : une seule version en attente à la fois.
        </Notice>
      )}
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField label="Nature de la version" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k, label: CP_VERSION_KIND_LABELS[k] }))} />
          <div className="text-sm text-ink-muted sm:pt-6">
            {changed.length ? (
              <span>
                Clauses modifiées : <span className="font-medium text-ink">{changed.map((k) => CP_FIELD_LABELS[k] ?? k).join(', ')}</span>
              </span>
            ) : (
              'Aucune clause modifiée.'
            )}
          </div>
        </div>
        <div>
          <p className="field-label">Contrat signé / avenant (PDF)</p>
          <FileUploader context="CHARTER_PARTY" vesselId={cp.vesselId} label="Déposer le PDF de la version" onUploaded={setFile} />
        </div>
        <TextAreaField label="Résumé de la version" value={summary} onChange={setSummary} rows={2} maxLength={2000} hint="Ex. Addendum n°1 : extension du laycan." />
        {pointless && <Notice tone="warn">Un avenant / une révision doit modifier au moins une clause ou joindre un document.</Notice>}
        <details className="rounded-md border border-line">
          <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-navy">Clauses de la version (pré-remplies avec les valeurs en vigueur)</summary>
          <div className="border-t border-line p-3">
            <CpContractFields f={f} set={set} />
          </div>
        </details>
      </div>
    </Dialog>
  );
}
