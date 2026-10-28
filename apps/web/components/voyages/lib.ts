'use client';

import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api';

// -----------------------------------------------------------------------------
// Clés de cache
// -----------------------------------------------------------------------------

export const voyageKeys = {
  list: ['voyages'] as const,
  /** Préfixe commun : invalider ['voyage', id] rafraîchit workspace + sous-listes */
  ws: (id: string) => ['voyage', id] as const,
  sub: (id: string, k: string, ...rest: unknown[]) => ['voyage', id, k, ...rest] as const,
};

export const cpKeys = {
  list: ['charter-parties'] as const,
  detail: (id: string) => ['charter-party', id] as const,
};

// -----------------------------------------------------------------------------
// Libellés (FR + termes maritimes anglais)
// -----------------------------------------------------------------------------

export const PORT_CALL_LABELS: Record<string, string> = {
  LOAD: 'Load port (chargement)',
  DISCHARGE: 'Discharge port (déchargement)',
  INTERMEDIATE: 'Escale intermédiaire',
  BUNKERING: 'Bunkering (soutage)',
};

export const PORT_CALL_SHORT: Record<string, string> = {
  LOAD: 'Load',
  DISCHARGE: 'Discharge',
  INTERMEDIATE: 'Intermédiaire',
  BUNKERING: 'Bunkering',
};

export const NOTICE_STATUS_LABELS: Record<string, string> = {
  PLANNED: 'Planifiée',
  DRAFTED: 'Brouillon rédigé',
  VALIDATED: 'Validée — à envoyer',
  SENT: 'Marquée envoyée',
  CANCELLED: 'Annulée',
};

export const TASK_STATUS_LABELS: Record<string, string> = {
  OPEN: 'À faire',
  DONE: 'Réalisée',
  CANCELLED: 'Annulée',
};

export const INSTRUCTION_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  ISSUED: 'Émise (en vigueur)',
  SUPERSEDED: 'Remplacée',
};

export const CP_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  PENDING_APPROVAL: 'En attente d’approbation',
  APPROVED: 'Approuvée',
  SUPERSEDED: 'Remplacée',
  CANCELLED: 'Annulée',
};

export const CP_TYPE_LABELS: Record<string, string> = {
  VOYAGE: 'Voyage charter',
  TIME: 'Time charter',
  BAREBOAT: 'Bareboat charter',
  COA: 'COA (contract of affreightment)',
  OTHER: 'Autre',
};

export const CP_VERSION_KIND_LABELS: Record<string, string> = {
  ORIGINAL: 'Original',
  ADDENDUM: 'Addendum (avenant)',
  REVISION: 'Revision',
};

export const CP_VERSION_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  PENDING_APPROVAL: 'En attente d’approbation',
  RETURNED: 'Retournée',
  REJECTED: 'Refusée',
  APPROVED: 'Approuvée',
  CANCELLED: 'Retirée',
};

/** Libellés des champs contractuels (texte contrôlé, jamais interprété). */
export const CP_FIELD_LABELS: Record<string, string> = {
  cpType: 'Type de CP',
  cpDate: 'Date de la CP',
  charterer: 'Charterer (affréteur)',
  owner: 'Owner (armateur)',
  broker: 'Broker',
  signatories: 'Signataires',
  laycanFrom: 'Laycan — début',
  laycanTo: 'Laycan — fin',
  loadPorts: 'Load port(s)',
  dischargePorts: 'Discharge port(s)',
  cargoDescription: 'Cargaison',
  norClause: 'Clause NOR',
  laytimeClause: 'Clause laytime',
  freightTerms: 'Freight',
  demurrageTerms: 'Demurrage / despatch',
  otherClauses: 'Autres clauses',
};

export const VOYAGE_FIELD_LABELS: Record<string, string> = {
  etd: 'ETD',
  eta: 'ETA',
  atd: 'ATD',
  ata: 'ATA',
  laycanFrom: 'Laycan début',
  laycanTo: 'Laycan fin',
};

export const NOTICE_KIND_SUGGESTIONS = ['FIXING', 'DAILY', 'ETA_NOTICE', '12H_DEFINITE', 'DEPARTURE', 'NOR_TENDERED'];
export const TASK_CATEGORY_SUGGESTIONS = ['CHECKLIST', 'MASTER_CHECKLIST', 'SURVEY', 'DOCUMENTS', 'HOLDS', 'BILLS_OF_LADING', 'NOR'];
export const AGENT_ROLE_SUGGESTIONS = ['LOAD_AGENT', 'DISCHARGE_AGENT', 'PROTECTING_AGENT', 'BUNKER_AGENT'];
export const VOYAGE_FILE_CATEGORIES = ['CHARTER_PARTY', 'INSTRUCTIONS', 'NOR', 'BILLS_OF_LADING', 'SURVEY', 'STATEMENT_OF_FACTS', 'CORRESPONDENCE', 'OTHER'];

// -----------------------------------------------------------------------------
// Dates : les horodatages opérationnels sont saisis et affichés en UTC (pratique maritime)
// -----------------------------------------------------------------------------

/** Date civile ISO -> valeur <input type="date">. */
export function toDateInput(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : '';
}

/** Horodatage ISO -> valeur <input type="datetime-local"> exprimée en UTC. */
export function toUtcInput(v: string | null | undefined): string {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16);
}

/** Valeur <input type="datetime-local"> (UTC) -> ISO 8601 avec fuseau Z ; vide -> null. */
export function fromUtcInput(v: string): string | null {
  if (!v) return null;
  return `${v.length === 16 ? `${v}:00` : v}Z`;
}

export function nowUtcInput(): string {
  return new Date().toISOString().slice(0, 16);
}

const utcFmt = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

/** Horodatage affiché en UTC explicite : « 22/04/2026 08:00 UTC ». */
export function fmtUtc(v: string | null | undefined): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : `${utcFmt.format(d)} UTC`;
}

/** Laycan « 22/04/2026 → 25/04/2026 ». */
export function fmtLaycan(from: string | null | undefined, to: string | null | undefined, fmt: (v: string) => string): string {
  if (!from && !to) return '—';
  return `${from ? fmt(from) : '?'} → ${to ? fmt(to) : '?'}`;
}

/** Texte vide -> null (jamais de valeur inventée). */
export function nn(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  return t === '' ? null : t;
}

// -----------------------------------------------------------------------------
// Erreurs API : 409 STALE_VERSION avec option « Recharger », détails de validation
// -----------------------------------------------------------------------------

export function isStale(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'STALE_VERSION';
}

/** Messages de détail ([{path, message}] ou { candidates }) renvoyés par l'API. */
export function errorDetails(e: unknown): string[] {
  if (!(e instanceof ApiError) || !Array.isArray(e.details)) return [];
  return (e.details as { path?: string; message?: string }[]).map((d) => d?.message).filter((m): m is string => !!m);
}

/** Toast d'erreur : conflit de version -> action « Recharger », sinon message + détails. */
export function notifyError(e: unknown, reload?: () => void) {
  if (isStale(e)) {
    toast.error('Version périmée : cette fiche a été modifiée entre-temps.', {
      description: 'Rechargez pour voir la dernière version avant de recommencer.',
      action: reload ? { label: 'Recharger', onClick: reload } : undefined,
      duration: 12_000,
    });
    return;
  }
  const details = errorDetails(e);
  toast.error(errorMessage(e), details.length ? { description: details.slice(0, 4).join(' · ') } : undefined);
}

/**
 * Mutation métier : toasts, invalidation des caches, gestion explicite du 409 STALE_VERSION
 * (proposition de rechargement) — le serveur reste l'unique autorité.
 */
export function useOp<TVars, TRes = unknown>(
  fn: (vars: TVars) => Promise<TRes>,
  opts: {
    success?: string | ((res: TRes, vars: TVars) => string);
    invalidate?: QueryKey[];
    onSuccess?: (res: TRes, vars: TVars) => void;
    /** Rechargement proposé sur conflit de version */
    reload?: () => void;
    /** Erreur gérée par l'appelant (ex. affichage dans le dialogue) : pas de toast */
    onError?: (e: unknown) => boolean | void;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (res, vars) => {
      if (opts.success) toast.success(typeof opts.success === 'function' ? opts.success(res, vars) : opts.success);
      await Promise.all((opts.invalidate ?? []).map((k) => qc.invalidateQueries({ queryKey: k })));
      opts.onSuccess?.(res, vars);
    },
    onError: (e) => {
      if (opts.onError?.(e) === true) return;
      notifyError(e, opts.reload ?? (() => (opts.invalidate ?? []).forEach((k) => qc.invalidateQueries({ queryKey: k }))));
    },
  });
}

/** Copie dans le presse-papiers avec retour utilisateur. */
export async function copyText(text: string, label = 'Texte copié') {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label);
  } catch {
    toast.error('Copie impossible : sélectionnez le texte manuellement.');
  }
}
