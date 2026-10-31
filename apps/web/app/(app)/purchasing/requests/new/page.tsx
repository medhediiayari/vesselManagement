'use client';

import { Paperclip, Save, Send, Trash2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { api, type StoredFileDto } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { useSession } from '@/lib/session';
import { FileUploader } from '@/components/amc/file-uploader';
import { Button, IconButton } from '@/components/ui/button';
import { PageHeader, Panel } from '@/components/ui/page';
import { Forbidden } from '@/components/ui/states';
import {
  PrHeaderFields,
  PrLineEditor,
  emptyHeader,
  headerErrors,
  headerToApi,
  linesSummary,
  newRow,
  rowsToApi,
  type EditorRow,
  type PrHeaderState,
} from '@/components/purchasing/pr-draft-form';
import { commandError, usePurRefresh, todayInput } from '@/components/purchasing/lib';
import type { PrDetail } from '@/components/purchasing/types';
import { Callout } from '@/components/purchasing/ui';

interface LocalDraft {
  header: PrHeaderState;
  rows: EditorRow[];
  savedAt: string;
}

export default function NewPurchaseRequestPage() {
  const router = useRouter();
  const { me, can, currentVessel } = useSession();
  const refresh = usePurRefresh();
  const storageKey = `amc.pr.new.${me.id}`;
  const defaultVessel = currentVessel?.id ?? (me.accessibleVessels.length === 1 ? me.accessibleVessels[0].id : '');
  const [header, setHeader] = useState<PrHeaderState>(() => emptyHeader(defaultVessel));
  const [rows, setRows] = useState<EditorRow[]>(() => [newRow(), newRow(), newRow()]);
  const [files, setFiles] = useState<StoredFileDto[]>([]);
  const [restoredAt, setRestoredAt] = useState<string | null>(null);
  const [localSavedAt, setLocalSavedAt] = useState<string | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [busy, setBusy] = useState<'draft' | 'submit' | null>(null);
  const loaded = useRef(false);

  // Restauration du brouillon local (saisie non encore envoyée au serveur)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const d = JSON.parse(raw) as LocalDraft;
        if (d.header && Array.isArray(d.rows) && d.rows.length) {
          // Saisie restaurée : la référence du formulaire n'est plus saisie (paramétrage), la date de la demande reste renseignée
          const { formRef: _formRef, ...restored } = d.header as PrHeaderState & { formRef?: string };
          setHeader({ ...emptyHeader(defaultVessel), ...restored, requestDate: restored.requestDate || todayInput() });
          setRows(d.rows.map((r) => newRow(r)));
          setRestoredAt(d.savedAt);
        }
      }
    } catch {
      /* stockage local facultatif */
    }
    loaded.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  // Sauvegarde automatique locale (800 ms) tant que la PR n'est pas créée
  useEffect(() => {
    if (!loaded.current) return;
    const t = setTimeout(() => {
      try {
        const savedAt = new Date().toISOString();
        localStorage.setItem(storageKey, JSON.stringify({ header, rows, savedAt } satisfies LocalDraft));
        setLocalSavedAt(savedAt);
      } catch {
        /* ignore */
      }
    }, 800);
    return () => clearTimeout(t);
  }, [header, rows, storageKey]);

  const hErrors = headerErrors(header);
  const summary = useMemo(() => linesSummary(rows), [rows]);

  if (!can('pr.create')) return <Forbidden message="La création de Purchase Request requiert la permission pr.create." />;

  const clearLocal = () => {
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* ignore */
    }
  };

  const create = async (andSubmit: boolean) => {
    setShowErrors(true);
    if (Object.keys(hErrors).length) {
      toast.error('Complétez l’en-tête (navire, catégorie, objet).');
      return;
    }
    if (summary.incomplete.length) {
      toast.error(`Ligne(s) ${summary.incomplete.join(', ')} à corriger : désignation, quantité > 0 et unité sont obligatoires.`);
      return;
    }
    if (andSubmit && !summary.valid.length) {
      toast.error('Une PR doit comporter au moins une ligne pour être soumise.');
      return;
    }
    setBusy(andSubmit ? 'submit' : 'draft');
    try {
      const pr = await api.post<PrDetail>('/purchase-requests', { vesselId: header.vesselId, ...headerToApi(header), lines: rowsToApi(summary.valid) });
      clearLocal();
      const failures: string[] = [];
      for (const f of files) {
        try {
          await api.post(`/purchase-requests/${pr.id}/attachments`, { fileId: f.id });
        } catch (e) {
          failures.push(`${f.originalName} : ${commandError(e)}`);
        }
      }
      if (failures.length) toast.error(`Pièce(s) jointe(s) non rattachée(s) — ${failures.join(' ; ')}`);
      if (andSubmit) {
        try {
          await api.post(`/purchase-requests/${pr.id}/submit`, { expectedVersion: pr.lockVersion });
          toast.success(`PR ${pr.number} créée et soumise`);
        } catch (e) {
          toast.error(`PR ${pr.number} créée en brouillon mais non soumise : ${commandError(e)}`);
        }
      } else {
        toast.success(`Brouillon ${pr.number} créé — enregistrement automatique actif`);
      }
      await refresh();
      router.replace(`/purchasing/requests/${pr.id}`);
    } catch (e) {
      toast.error(commandError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        breadcrumb={[{ label: 'Achats', href: '/purchasing' }, { label: 'Purchase Requests', href: '/purchasing/requests' }, { label: 'Nouvelle PR' }]}
        title="Nouvelle Purchase Request"
        description="Le numéro est attribué à la création (ex. ISK-PR-2026-0001). Après création, le brouillon est enregistré automatiquement sur le serveur à chaque modification."
        actions={
          <>
            <Button variant="secondary" onClick={() => create(false)} loading={busy === 'draft'} disabled={!!busy}>
              <Save className="h-4 w-4" aria-hidden /> Créer le brouillon
            </Button>
            {can('pr.submit') && (
              <Button onClick={() => create(true)} loading={busy === 'submit'} disabled={!!busy}>
                <Send className="h-4 w-4" aria-hidden /> Créer et soumettre
              </Button>
            )}
          </>
        }
      />

      {restoredAt && (
        <Callout tone="info" className="mb-4" title={`Saisie non envoyée restaurée (${fmtDateTime(restoredAt)})`}>
          <span>Votre saisie précédente a été conservée sur ce poste. </span>
          <button
            type="button"
            className="font-medium text-action hover:underline"
            onClick={() => {
              clearLocal();
              setHeader(emptyHeader(defaultVessel));
              setRows([newRow(), newRow(), newRow()]);
              setRestoredAt(null);
            }}
          >
            Repartir d’une saisie vide
          </button>
        </Callout>
      )}

      <div className="space-y-5">
        <Panel title="En-tête">
          <PrHeaderFields value={header} onChange={(p) => setHeader((h) => ({ ...h, ...p }))} errors={showErrors ? hErrors : {}} />
        </Panel>

        <Panel
          title={`Lignes (${summary.valid.length} valide${summary.valid.length > 1 ? 's' : ''})`}
          actions={<span className="text-xs text-ink-muted">{localSavedAt ? `Saisie conservée localement le ${fmtDateTime(localSavedAt)} (heure locale)` : 'Saisie conservée localement'}</span>}
        >
          {showErrors && summary.incomplete.length > 0 && (
            <Callout tone="danger" className="mb-3" title={`Ligne(s) ${summary.incomplete.join(', ')} à corriger`}>
              Désignation, quantité strictement positive (3 décimales max.) et unité sont obligatoires. Les lignes entièrement vides sont ignorées.
            </Callout>
          )}
          <PrLineEditor rows={rows} onChange={setRows} />
        </Panel>

        <Panel title="Pièces jointes">
          {!header.vesselId ? (
            <p className="text-sm text-ink-muted">Choisissez d’abord le navire : les fichiers sont rattachés au périmètre du navire.</p>
          ) : (
            <>
              <FileUploader
                context="PURCHASING"
                vesselId={header.vesselId}
                multiple
                label="Photos, plaques signalétiques, fiches techniques…"
                onUploaded={(f) => setFiles((prev) => [...prev, f])}
              />
              {files.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {files.map((f) => (
                    <li key={f.id} className="flex items-center gap-2 rounded-md border border-line px-3 py-1.5 text-sm">
                      <Paperclip className="h-4 w-4 text-ink-muted" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{f.originalName}</span>
                      <span className="text-xs tabular text-ink-muted">{fmtBytes(f.sizeBytes)}</span>
                      <IconButton label={`Ne pas rattacher ${f.originalName}`} onClick={() => setFiles((prev) => prev.filter((x) => x.id !== f.id))}>
                        <X className="h-4 w-4" />
                      </IconButton>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-ink-muted">Les fichiers déposés seront rattachés à la PR à sa création.</p>
            </>
          )}
        </Panel>

        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              clearLocal();
              router.push('/purchasing/requests');
            }}
          >
            <Trash2 className="h-4 w-4" aria-hidden /> Abandonner la saisie
          </Button>
          <Button variant="secondary" onClick={() => create(false)} loading={busy === 'draft'} disabled={!!busy}>
            <Save className="h-4 w-4" aria-hidden /> Créer le brouillon
          </Button>
          {can('pr.submit') && (
            <Button onClick={() => create(true)} loading={busy === 'submit'} disabled={!!busy}>
              <Send className="h-4 w-4" aria-hidden /> Créer et soumettre
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
