'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import {
  NOON_FIELDS,
  consistencyIssues,
  missingForSubmission,
  sameValue,
  toApiValues,
  toFormValues,
  type ApiValue,
  type FormValues,
  type NoonField,
} from './lib';
import type { NoonReportDetail, NoonValuesDto } from './types';

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'invalid' | 'error' | 'conflict' | 'locked';

const AUTOSAVE_DELAY_MS = 1200;

/**
 * État de saisie d'un Noon Report.
 * - mode « autosave » (DRAFT / CORRECTION_REQUESTED) : PATCH différé des seuls champs modifiés et
 *   valides, avec expectedVersion (verrou optimiste) ; 409 STALE_VERSION -> état « conflict » (arrêt
 *   de l'autosave, choix utilisateur) ; statut changé ailleurs -> « locked ».
 * - mode « local » (correction d'un rapport soumis) : aucune écriture, les changements sont envoyés
 *   en une fois par POST /correct.
 */
export function useNoonDraft(report: NoonReportDetail, mode: 'autosave' | 'local' | 'readonly', onSaved?: (r: Partial<NoonReportDetail>) => void) {
  const [values, setValues] = useState<FormValues>(() => toFormValues(report));
  const valuesRef = useRef(values);
  const baselineRef = useRef<FormValues>(toFormValues(report));
  const versionRef = useRef(report.lockVersion);
  const [version, setVersion] = useState(report.lockVersion);
  const [status, setStatus] = useState<SaveStatus>('idle');
  const statusRef = useRef<SaveStatus>('idle');
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [lastError, setLastError] = useState<unknown>(null);
  /** Erreurs serveur par champ, valables tant que la valeur rejetée n'a pas changé */
  const [rejected, setRejected] = useState<Record<string, { value: string; message: string }>>({});
  const rejectedRef = useRef(rejected);
  const inFlight = useRef<Promise<void> | null>(null);
  const queued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;

  const setStat = (s: SaveStatus) => {
    statusRef.current = s;
    setStatus(s);
  };

  /** Réinitialise depuis le serveur (rechargement, changement de statut). */
  const resetFrom = useCallback((r: NoonReportDetail | NoonValuesDto & { lockVersion: number }) => {
    const v = toFormValues(r);
    valuesRef.current = v;
    baselineRef.current = v;
    versionRef.current = r.lockVersion;
    setValues(v);
    setVersion(r.lockVersion);
    setRejected({});
    rejectedRef.current = {};
    setLastError(null);
    setStat('idle');
  }, []);

  /** Conflit : reprend la dernière version serveur et réapplique les saisies locales non enregistrées. */
  const rebase = useCallback((r: NoonReportDetail) => {
    const server = toFormValues(r);
    const local = valuesRef.current;
    const oldBase = baselineRef.current;
    const merged = { ...server };
    for (const k of NOON_FIELDS) if (!sameValue(k, local[k], oldBase[k])) merged[k] = local[k];
    baselineRef.current = server;
    versionRef.current = r.lockVersion;
    valuesRef.current = merged;
    setValues(merged);
    setVersion(r.lockVersion);
    setLastError(null);
    setStat('dirty');
  }, []);

  // Rapport différent ou changement de statut : on repart des valeurs serveur
  const statusKey = `${report.id}:${report.status}:${mode}`;
  const prevKey = useRef(statusKey);
  useEffect(() => {
    if (prevKey.current !== statusKey) {
      prevKey.current = statusKey;
      resetFrom(report);
    }
  }, [statusKey, report, resetFrom]);

  const dirtyFields = useMemo(() => NOON_FIELDS.filter((k) => !sameValue(k, values[k], baselineRef.current[k])), [values, version, lastSavedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const doSave = useCallback(async (): Promise<void> => {
    if (mode !== 'autosave') return;
    if (statusRef.current === 'conflict' || statusRef.current === 'locked') return;
    if (inFlight.current) {
      queued.current = true;
      return inFlight.current;
    }
    const vals = valuesRef.current;
    const base = baselineRef.current;
    const dirty = NOON_FIELDS.filter((k) => !sameValue(k, vals[k], base[k]));
    if (!dirty.length) {
      setStat(lastSavedAt ? 'saved' : 'idle');
      return;
    }
    const { api: apiVals, errors } = toApiValues(vals);
    const baseApi = toApiValues(base).api;
    const rej = rejectedRef.current;
    let candidate: NoonField[] = dirty.filter((k) => !errors[k] && !(rej[k] && rej[k].value === vals[k]));
    // Le serveur contrôle la cohérence sur les valeurs fusionnées : on écarte les champs en conflit
    for (let i = 0; i < 3; i++) {
      const merged: Record<string, ApiValue> = { ...baseApi };
      for (const k of candidate) merged[k] = apiVals[k];
      const issues = consistencyIssues(merged);
      if (!issues.length) break;
      const drop = new Set<string>();
      for (const is of issues) {
        drop.add(is.path);
        if (is.path === 'runningHours') drop.add('consumptionBasis');
        if (is.path === 'etaNextPort') drop.add('reportDateUtc');
      }
      candidate = candidate.filter((k) => !drop.has(k));
    }
    if (!candidate.length) {
      setStat('invalid');
      return;
    }
    const body: Record<string, unknown> = Object.fromEntries(candidate.map((k) => [k, apiVals[k]]));
    const sent = Object.fromEntries(candidate.map((k) => [k, vals[k]])) as Partial<FormValues>;
    setStat('saving');
    const p = api
      .patch<NoonReportDetail>(`/noon-reports/${report.id}`, { ...body, expectedVersion: versionRef.current })
      .then((res) => {
        versionRef.current = res.lockVersion;
        setVersion(res.lockVersion);
        baselineRef.current = { ...baselineRef.current, ...sent };
        const nextRej = { ...rejectedRef.current };
        for (const k of candidate) delete nextRej[k];
        rejectedRef.current = nextRej;
        setRejected(nextRej);
        setLastError(null);
        setLastSavedAt(new Date());
        onSavedRef.current?.(res);
        const still = NOON_FIELDS.some((k) => !sameValue(k, valuesRef.current[k], baselineRef.current[k]));
        setStat(still ? 'dirty' : 'saved');
      })
      .catch((e: unknown) => {
        setLastError(e);
        if (e instanceof ApiError && e.code === 'STALE_VERSION') return setStat('conflict');
        if (e instanceof ApiError && (e.code === 'ALREADY_PROCESSED' || e.code === 'INVALID_STATE')) return setStat('locked');
        if (e instanceof ApiError && (e.status === 422 || e.code === 'DUPLICATE')) {
          const next = { ...rejectedRef.current };
          const details = Array.isArray(e.details) ? (e.details as { path?: string; message?: string }[]) : [];
          const paths = details.map((d) => d.path).filter((x): x is string => !!x && x in vals);
          if (e.code === 'DUPLICATE') paths.push('reportDateUtc', 'reportType');
          for (const path of paths.length ? paths : candidate) {
            next[path] = { value: vals[path as NoonField], message: details.find((d) => d.path === path)?.message ?? e.message };
          }
          rejectedRef.current = next;
          setRejected(next);
        }
        setStat('error');
      })
      .finally(() => {
        inFlight.current = null;
        if (queued.current) {
          queued.current = false;
          void doSave();
        }
      });
    inFlight.current = p;
    return p;
  }, [mode, report.id, lastSavedAt]);

  const setField = useCallback(
    (k: NoonField, v: string) => {
      const prev = valuesRef.current[k];
      const next = { ...valuesRef.current, [k]: v };
      valuesRef.current = next;
      setValues(next);
      // Simple normalisation (ex. 37°36′N -> 37.6) : rien de nouveau à enregistrer
      if (sameValue(k, prev, v)) return;
      if (mode === 'autosave' && statusRef.current !== 'conflict' && statusRef.current !== 'locked') {
        setStat('dirty');
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void doSave(), AUTOSAVE_DELAY_MS);
      }
    },
    [mode, doSave],
  );

  /** Enregistre immédiatement (avant soumission / correction). Retourne la version courante ou null si des champs restent non enregistrés. */
  const flush = useCallback(async (): Promise<number | null> => {
    if (timer.current) clearTimeout(timer.current);
    if (mode !== 'autosave') return versionRef.current;
    if (inFlight.current) await inFlight.current;
    await doSave();
    if (inFlight.current) await inFlight.current;
    const still = NOON_FIELDS.some((k) => !sameValue(k, valuesRef.current[k], baselineRef.current[k]));
    if (still || statusRef.current === 'conflict' || statusRef.current === 'locked' || statusRef.current === 'error') return null;
    return versionRef.current;
  }, [mode, doSave]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  // Avertissement de sortie si des saisies ne sont pas enregistrées
  useEffect(() => {
    if (mode === 'readonly' || !dirtyFields.length) return;
    const h = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [mode, dirtyFields.length]);

  // Erreurs affichées par champ : format / plage, cohérence, refus serveur
  const { api: apiValues, errors: formatErrors } = useMemo(() => toApiValues(values), [values]);
  const fieldErrors = useMemo(() => {
    const out: Record<string, string> = { ...formatErrors };
    for (const is of consistencyIssues(apiValues)) out[is.path] ??= is.message;
    for (const [k, r] of Object.entries(rejected)) if (values[k as NoonField] === r.value) out[k] ??= r.message;
    return out;
  }, [formatErrors, apiValues, rejected, values]);
  const missing = useMemo(() => {
    const out: Record<string, string> = {};
    for (const is of missingForSubmission(apiValues)) out[is.path] ??= is.message;
    return out;
  }, [apiValues]);

  /** Changements (valeurs API) par rapport à la dernière révision connue — utilisé pour POST /correct. */
  const changes = useCallback((): Record<string, ApiValue> => {
    const out: Record<string, ApiValue> = {};
    for (const k of NOON_FIELDS) if (!sameValue(k, valuesRef.current[k], baselineRef.current[k])) out[k] = apiValues[k];
    return out;
  }, [apiValues]);

  return {
    values,
    setField,
    status,
    version,
    lastSavedAt,
    lastError,
    dirtyFields,
    fieldErrors,
    missing,
    apiValues,
    baseline: baselineRef.current,
    flush,
    resetFrom,
    rebase,
    changes,
    retry: () => {
      setStat('dirty');
      void doSave();
    },
  };
}

export type NoonDraft = ReturnType<typeof useNoonDraft>;
