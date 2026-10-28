'use client';

import { AlertTriangle, CheckCircle2, CloudOff, Loader2, RefreshCw } from 'lucide-react';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/page';
import { commandError } from './lib';
import {
  PrHeaderFields,
  PrLineEditor,
  headerErrors,
  headerToApi,
  linesSummary,
  newRow,
  rowsFingerprint,
  rowsFromLines,
  rowsToApi,
  type EditorRow,
  type PrHeaderState,
} from './pr-draft-form';
import type { PrDetail, PrHeader } from './types';
import { toDateInput } from './lib';
import { Callout } from './ui';

type SaveState = 'saved' | 'dirty' | 'saving' | 'incomplete' | 'error' | 'conflict';

export interface PrDraftEditorHandle {
  /** Enregistre immédiatement ; renvoie la version courante (lockVersion) ou null si impossible. */
  flush: () => Promise<number | null>;
  /** Lignes valides présentes (pour bloquer une soumission vide). */
  validLineCount: () => number;
}

function headerFromPr(pr: PrDetail): PrHeaderState {
  return {
    vesselId: pr.vesselId,
    category: pr.category,
    subject: pr.subject,
    priority: pr.priority,
    neededBy: toDateInput(pr.neededBy),
    requestDate: toDateInput(pr.requestDate),
    departmentId: pr.departmentId ?? '',
    comment: pr.comment ?? '',
  };
}

const headerFp = (h: PrHeaderState) => JSON.stringify(headerToApi(h));

/**
 * Brouillon PR éditable avec enregistrement automatique (1,5 s après la dernière frappe) :
 * PATCH en-tête puis PUT lignes, chacun avec expectedVersion (verrou optimiste). Un 409 STALE_VERSION
 * suspend l'enregistrement et propose de recharger la version serveur (jamais d'écrasement silencieux).
 */
export const PrDraftEditor = forwardRef<PrDraftEditorHandle, { pr: PrDetail; onReload: () => Promise<unknown>; disabled?: boolean }>(function PrDraftEditor(
  { pr, onReload, disabled },
  ref,
) {
  const [header, setHeader] = useState<PrHeaderState>(() => headerFromPr(pr));
  const [rows, setRows] = useState<EditorRow[]>(() => (pr.lines.length ? [...rowsFromLines(pr.lines), newRow()] : [newRow(), newRow(), newRow()]));
  const [state, setState] = useState<SaveState>('saved');
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(pr.updatedAt);
  const version = useRef(pr.lockVersion);
  const savedHeader = useRef(headerFp(headerFromPr(pr)));
  const savedLines = useRef(rowsFingerprint(rowsFromLines(pr.lines)));
  const saving = useRef<Promise<number | null> | null>(null);
  const latest = useRef({ header, rows });
  latest.current = { header, rows };

  const hErr = headerErrors(header, false);
  const summary = useMemo(() => linesSummary(rows), [rows]);

  const save = useCallback(async (): Promise<number | null> => {
    if (saving.current) await saving.current;
    const run = async (): Promise<number | null> => {
      const { header: h, rows: r } = latest.current;
      const hfp = headerFp(h);
      const lfp = rowsFingerprint(r);
      const sum = linesSummary(r);
      const headerOk = !Object.keys(headerErrors(h, false)).length;
      const needHeader = hfp !== savedHeader.current;
      const needLines = lfp !== savedLines.current;
      if (!needHeader && !needLines) {
        setState('saved');
        return version.current;
      }
      if ((needHeader && !headerOk) || (needLines && sum.incomplete.length)) {
        setState('incomplete');
        return null;
      }
      setState('saving');
      setError(null);
      try {
        if (needHeader) {
          const res = await api.patch<PrHeader>(`/purchase-requests/${pr.id}`, { expectedVersion: version.current, ...headerToApi(h) });
          version.current = res.lockVersion;
          savedHeader.current = hfp;
        }
        if (needLines) {
          const res = await api.put<PrHeader>(`/purchase-requests/${pr.id}/lines`, { expectedVersion: version.current, lines: rowsToApi(sum.valid) });
          version.current = res.lockVersion;
          savedLines.current = lfp;
        }
        setSavedAt(new Date().toISOString());
        const stillDirty = headerFp(latest.current.header) !== savedHeader.current || rowsFingerprint(latest.current.rows) !== savedLines.current;
        setState(stillDirty ? 'dirty' : 'saved');
        return version.current;
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'INVALID_STATE')) {
          setState('conflict');
          setError(e.code === 'STALE_VERSION' ? 'Cette PR a été modifiée ailleurs (autre onglet ou autre utilisateur).' : e.message);
        } else {
          setState('error');
          setError(commandError(e));
        }
        return null;
      }
    };
    const p = run();
    saving.current = p;
    try {
      return await p;
    } finally {
      saving.current = null;
    }
  }, [pr.id]);

  // Enregistrement automatique (débounce 1,5 s)
  useEffect(() => {
    if (state === 'conflict' || disabled) return;
    const dirty = headerFp(header) !== savedHeader.current || rowsFingerprint(rows) !== savedLines.current;
    if (!dirty) return;
    setState((s) => (s === 'saving' ? s : 'dirty'));
    const t = setTimeout(() => void save(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [header, rows]);

  // Avertissement à la fermeture de l'onglet si des modifications ne sont pas enregistrées
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (state === 'dirty' || state === 'saving' || state === 'incomplete' || state === 'error') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [state]);

  useImperativeHandle(ref, () => ({ flush: save, validLineCount: () => linesSummary(latest.current.rows).valid.length }), [save]);

  const reloadFromServer = async () => {
    const fresh = (await onReload()) as { data?: PrDetail } | undefined;
    const next = fresh?.data;
    if (next) {
      const h = headerFromPr(next);
      setHeader(h);
      setRows(next.lines.length ? [...rowsFromLines(next.lines), newRow()] : [newRow()]);
      version.current = next.lockVersion;
      savedHeader.current = headerFp(h);
      savedLines.current = rowsFingerprint(rowsFromLines(next.lines));
      setState('saved');
      setError(null);
      setSavedAt(next.updatedAt);
    }
  };

  const indicator = {
    saved: { icon: <CheckCircle2 className="h-4 w-4 text-ok" aria-hidden />, text: savedAt ? `Enregistré (${fmtDateTime(savedAt)})` : 'Enregistré' },
    dirty: { icon: <Loader2 className="h-4 w-4 text-ink-muted" aria-hidden />, text: 'Modifications en attente d’enregistrement…' },
    saving: { icon: <Loader2 className="h-4 w-4 animate-spin text-action" aria-hidden />, text: 'Enregistrement…' },
    incomplete: { icon: <AlertTriangle className="h-4 w-4 text-warn" aria-hidden />, text: 'Non enregistré : saisie incomplète' },
    error: { icon: <CloudOff className="h-4 w-4 text-danger" aria-hidden />, text: 'Échec de l’enregistrement' },
    conflict: { icon: <AlertTriangle className="h-4 w-4 text-danger" aria-hidden />, text: 'Conflit de version' },
  }[state];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-white px-3 py-2" aria-live="polite">
        <span className="inline-flex items-center gap-2 text-sm">
          {indicator.icon}
          {indicator.text}
        </span>
        {(state === 'error' || state === 'incomplete' || state === 'dirty') && (
          <Button size="sm" variant="secondary" onClick={() => void save()}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Enregistrer maintenant
          </Button>
        )}
      </div>
      {state === 'conflict' && (
        <Callout tone="danger" title="Enregistrement automatique suspendu">
          <p>{error} Vos modifications locales n’ont pas été envoyées pour ne rien écraser.</p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={reloadFromServer}>
            <RefreshCw className="h-4 w-4" aria-hidden /> Recharger la version serveur (abandonne la saisie locale)
          </Button>
        </Callout>
      )}
      {state === 'error' && error && <Callout tone="danger" title="L’enregistrement a échoué">{error}</Callout>}
      {state === 'incomplete' && (
        <Callout tone="warn" title="Brouillon non enregistré">
          {Object.keys(hErr).length ? 'En-tête : catégorie et objet (2 caractères minimum) sont obligatoires. ' : ''}
          {summary.incomplete.length ? `Ligne(s) ${summary.incomplete.join(', ')} : désignation, quantité > 0 et unité obligatoires. Les lignes vides sont ignorées.` : ''}
        </Callout>
      )}
      <Panel title="En-tête">
        <PrHeaderFields value={header} onChange={(p) => setHeader((h) => ({ ...h, ...p }))} errors={hErr} vesselLocked disabled={disabled || state === 'conflict'} storedFormRef={pr.formRef ?? null} />
      </Panel>
      <Panel title={`Lignes (${summary.valid.length})`}>
        <PrLineEditor rows={rows} onChange={setRows} disabled={disabled || state === 'conflict'} />
      </Panel>
    </div>
  );
});
