'use client';

import { useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { ApiError, errorMessage } from '@/lib/api';
import type { Tone } from '@/components/ui/badge';
import type { OverAllocationLine } from './types';

// =============================================================================
// Décimaux exacts (chaînes API) — jamais de float pour un calcul de quantité / montant
// =============================================================================

const SCALE = 6;
const FACTOR = 10n ** BigInt(SCALE);

/** Chaîne décimale -> entier mis à l'échelle 10^6 (exact). Valeur invalide => null. */
function parseScaled(v: string | number | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(',', '.');
  if (!s) return null;
  const m = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  const int = BigInt(m[2] || '0');
  const frac = (m[3] ?? '').slice(0, SCALE).padEnd(SCALE, '0');
  const abs = int * FACTOR + BigInt(frac || '0');
  return m[1] ? -abs : abs;
}

function formatScaled(n: bigint): string {
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const int = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${int.toString()}${frac ? `.${frac}` : ''}`;
}

/** Arithmétique décimale exacte sur chaînes (BigInt à l'échelle 10^-6). */
export const dec = {
  /** Vrai si la chaîne est un nombre décimal valide (virgule ou point). */
  valid: (v: string | null | undefined) => parseScaled(v) !== null,
  norm: (v: string | number | null | undefined): string => {
    const p = parseScaled(v);
    return p === null ? '0' : formatScaled(p);
  },
  add: (...vals: (string | null | undefined)[]): string => formatScaled(vals.reduce<bigint>((s, v) => s + (parseScaled(v) ?? 0n), 0n)),
  sub: (a: string | null | undefined, b: string | null | undefined): string => formatScaled((parseScaled(a) ?? 0n) - (parseScaled(b) ?? 0n)),
  max0: (v: string | null | undefined): string => {
    const p = parseScaled(v) ?? 0n;
    return formatScaled(p < 0n ? 0n : p);
  },
  cmp: (a: string | null | undefined, b: string | null | undefined): -1 | 0 | 1 => {
    const x = parseScaled(a) ?? 0n;
    const y = parseScaled(b) ?? 0n;
    return x < y ? -1 : x > y ? 1 : 0;
  },
  gt0: (v: string | null | undefined) => (parseScaled(v) ?? 0n) > 0n,
  isZero: (v: string | null | undefined) => (parseScaled(v) ?? 0n) === 0n,
  min: (a: string, b: string) => (dec.cmp(a, b) <= 0 ? dec.norm(a) : dec.norm(b)),
  /** Produit exact arrondi (demi-supérieur) à `scale` décimales (aperçu d'un total de ligne). */
  mul: (a: string | null | undefined, b: string | null | undefined, scale = 2): string => {
    const x = parseScaled(a) ?? 0n;
    const y = parseScaled(b) ?? 0n;
    const raw = x * y; // échelle 10^12
    const div = 10n ** BigInt(2 * SCALE - scale);
    const neg = raw < 0n;
    const abs = neg ? -raw : raw;
    const q = (abs + div / 2n) / div; // échelle 10^scale
    return formatScaled((neg ? -q : q) * 10n ** BigInt(SCALE - scale));
  },
  /** Part (0..100) d'une valeur sur un total — usage visuel uniquement (largeur d'un segment). */
  percentOf: (part: string | null | undefined, total: string | null | undefined): number => {
    const p = parseScaled(part) ?? 0n;
    const t = parseScaled(total) ?? 0n;
    if (t <= 0n || p <= 0n) return 0;
    return Number((p * 10000n) / t) / 100;
  },
  /** Nombre de décimales d'une saisie (contrôle de l'échelle DECIMAL(18,s)). */
  scale: (v: string): number => {
    const m = /\.(\d+)$/.exec(v.trim().replace(',', '.'));
    return m ? m[1].length : 0;
  },
};

/** Normalise une saisie utilisateur (virgule française) en chaîne décimale pour l'API. */
export function toApiDecimal(v: string): string {
  return v.trim().replace(/\s/g, '').replace(',', '.');
}

/** Message d'erreur de saisie d'une quantité / d'un montant (null si valide). */
export function decimalError(v: string, opts: { required?: boolean; positive?: boolean; scale?: number } = {}): string | null {
  const s = toApiDecimal(v);
  if (!s) return opts.required ? 'Obligatoire' : null;
  if (!/^\d+(\.\d+)?$/.test(s)) return 'Nombre décimal attendu';
  if (opts.scale !== undefined && dec.scale(s) > opts.scale) return `${opts.scale} décimale(s) au maximum`;
  if (opts.positive && !dec.gt0(s)) return 'Doit être > 0';
  return null;
}

// =============================================================================
// Libellés FR (statuts toujours affichés en texte + icône)
// =============================================================================

export const PRIORITY_LABELS: Record<string, string> = { LOW: 'Basse', NORMAL: 'Normale', HIGH: 'Haute', URGENT: 'Urgente' };
export const PRIORITY_TONES: Record<string, Tone> = { LOW: 'neutral', NORMAL: 'navy', HIGH: 'warn', URGENT: 'danger' };

export const LINE_BADGE_LABELS: Record<string, string> = {
  NOT_ORDERED: 'Non commandée',
  PARTIALLY_ORDERED: 'Partiellement commandée',
  ORDERED: 'Commandée',
  PARTIALLY_RECEIVED: 'Partiellement reçue',
  RECEIVED: 'Reçue',
  CANCELLED: 'Annulée',
};
export const LINE_BADGE_TONES: Record<string, Tone> = {
  NOT_ORDERED: 'neutral',
  PARTIALLY_ORDERED: 'warn',
  ORDERED: 'info',
  PARTIALLY_RECEIVED: 'warn',
  RECEIVED: 'ok',
  CANCELLED: 'neutral',
};

export const PR_STATUS_TONES: Record<string, Tone> = {
  DRAFT: 'neutral',
  SUBMITTED: 'info',
  UNDER_REVIEW: 'warn',
  REVISED: 'warn',
  APPROVED: 'ok',
  SOURCING: 'info',
  PARTIALLY_ORDERED: 'warn',
  ORDERED: 'info',
  PARTIALLY_RECEIVED: 'warn',
  RECEIVED: 'ok',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
  REJECTED: 'danger',
  ON_HOLD: 'warn',
  SPLIT: 'navy',
};

export const PO_STATUS_TONES: Record<string, Tone> = {
  DRAFT: 'neutral',
  APPROVAL_PENDING: 'warn',
  APPROVED: 'info',
  SENT: 'ok',
  PARTIALLY_RECEIVED: 'warn',
  RECEIVED: 'ok',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
};

export const RFQ_STATUS_TONES: Record<string, Tone> = {
  DRAFT: 'neutral',
  ISSUED: 'info',
  QUOTED: 'warn',
  EVALUATED: 'ok',
  CLOSED: 'neutral',
  CANCELLED: 'danger',
};

export const RFQ_SUPPLIER_STATUS_LABELS: Record<string, string> = {
  PENDING: 'À contacter',
  SENT: 'Contacté',
  SEND_FAILED: 'À contacter',
  DECLINED: 'Déclinée',
  QUOTED: 'Devis reçu',
};
export const RFQ_SUPPLIER_STATUS_TONES: Record<string, Tone> = {
  PENDING: 'neutral',
  SENT: 'ok',
  SEND_FAILED: 'neutral',
  DECLINED: 'neutral',
  QUOTED: 'info',
};

export const QUOTATION_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Reçu',
  SELECTED: 'Retenu',
  PARTIALLY_SELECTED: 'Partiellement retenu',
  NOT_SELECTED: 'Non retenu',
  WITHDRAWN: 'Retiré',
};
export const QUOTATION_STATUS_TONES: Record<string, Tone> = {
  RECEIVED: 'info',
  SELECTED: 'ok',
  PARTIALLY_SELECTED: 'ok',
  NOT_SELECTED: 'neutral',
  WITHDRAWN: 'danger',
};

export const COMPLIANCE_LABELS: Record<string, string> = { COMPLIANT: 'Conforme', ALTERNATIVE: 'Alternative', NON_COMPLIANT: 'Non conforme' };
export const COMPLIANCE_TONES: Record<string, Tone> = { COMPLIANT: 'ok', ALTERNATIVE: 'warn', NON_COMPLIANT: 'danger' };

export const REVISION_ACTION_LABELS: Record<string, string> = { KEEP: 'Conservée', CHANGE: 'Modifiée', ADD: 'Ajoutée', REMOVE: 'Retirée' };
export const REVISION_ACTION_TONES: Record<string, Tone> = { KEEP: 'neutral', CHANGE: 'warn', ADD: 'info', REMOVE: 'danger' };
export const REVISION_STATUS_LABELS: Record<string, string> = {
  PROPOSED: 'Proposée',
  ACCEPTED: 'Acceptée',
  REJECTED: 'Refusée',
  CORRECTION_REQUESTED: 'Correction demandée',
  WITHDRAWN: 'Retirée',
};
export const REVISION_STATUS_TONES: Record<string, Tone> = {
  PROPOSED: 'warn',
  ACCEPTED: 'ok',
  REJECTED: 'danger',
  CORRECTION_REQUESTED: 'danger',
  WITHDRAWN: 'neutral',
};
export const REVISION_KIND_LABELS: Record<string, string> = { COUNTER_PR: 'Counter-PR', REVISION: 'Révision' };

export const VARIANCE_TYPE_LABELS: Record<string, string> = {
  SHORT_SHIPPED: 'Manquant au BL (short-shipped)',
  SHORT_RECEIVED: 'Manquant à bord (short-received)',
  SURPLUS: 'Excédent',
  DAMAGED: 'Endommagé',
  WRONG_REFERENCE: 'Mauvaise référence',
  REJECTED: 'Rejeté à réception',
};
export const VARIANCE_TYPE_TONES: Record<string, Tone> = {
  SHORT_SHIPPED: 'warn',
  SHORT_RECEIVED: 'danger',
  SURPLUS: 'info',
  DAMAGED: 'danger',
  WRONG_REFERENCE: 'danger',
  REJECTED: 'danger',
};
export const VARIANCE_STATUS_LABELS: Record<string, string> = { OPEN: 'Ouvert', IN_PROGRESS: 'En traitement', RESOLVED: 'Résolu', CLOSED: 'Clôturé' };
export const VARIANCE_STATUS_TONES: Record<string, Tone> = { OPEN: 'danger', IN_PROGRESS: 'warn', RESOLVED: 'ok', CLOSED: 'neutral' };

export const CONDITION_LABELS: Record<string, string> = { GOOD: 'Bon état', DAMAGED: 'Endommagé', WRONG_ITEM: 'Mauvais article' };
export const CONDITION_TONES: Record<string, Tone> = { GOOD: 'ok', DAMAGED: 'danger', WRONG_ITEM: 'danger' };

export const DN_STATUS_LABELS: Record<string, string> = { RECORDED: 'Enregistré (non réceptionné)', RECEIVED: 'Réceptionné', CANCELLED: 'Annulé' };
export const DN_STATUS_TONES: Record<string, Tone> = { RECORDED: 'info', RECEIVED: 'ok', CANCELLED: 'danger' };

export const RECEIPT_STATUS_LABELS: Record<string, string> = { DRAFT: 'Brouillon', CONFIRMED: 'À valider', VALIDATED: 'Validée' };
export const RECEIPT_STATUS_TONES: Record<string, Tone> = { DRAFT: 'neutral', CONFIRMED: 'warn', VALIDATED: 'ok' };

export const INVOICE_STATUS_LABELS: Record<string, string> = {
  RECEIVED: 'Reçue',
  UNDER_REVIEW: 'En revue',
  MATCHED: 'Rapprochée',
  DISPUTED: 'En litige',
  APPROVED: 'Approuvée',
  CANCELLED: 'Annulée',
};
export const INVOICE_STATUS_TONES: Record<string, Tone> = {
  RECEIVED: 'info',
  UNDER_REVIEW: 'warn',
  MATCHED: 'ok',
  DISPUTED: 'danger',
  APPROVED: 'ok',
  CANCELLED: 'neutral',
};
/** Transitions facture autorisées (miroir de INVOICE_TRANSITIONS côté API — le serveur décide). */
export const INVOICE_NEXT: Record<string, string[]> = {
  RECEIVED: ['UNDER_REVIEW', 'MATCHED', 'DISPUTED', 'CANCELLED'],
  UNDER_REVIEW: ['MATCHED', 'DISPUTED', 'CANCELLED'],
  MATCHED: ['APPROVED', 'DISPUTED', 'CANCELLED'],
  DISPUTED: ['UNDER_REVIEW', 'MATCHED', 'CANCELLED'],
  APPROVED: [],
  CANCELLED: [],
};
export const MATCH_REASON_LABELS: Record<string, string> = {
  CURRENCY_MISMATCH: 'Devise différente de celle du BC',
  EXCEEDS_ORDERED: 'Facturé > commandé',
  EXCEEDS_RECEIVED: 'Facturé > reçu / accepté',
  NO_ORDER: 'Aucun BC rattaché',
};

export const DISPATCH_STATUS_LABELS: Record<string, string> = { PENDING: 'En cours', SENT: 'Envoyé', FAILED: 'Échec' };
export const DISPATCH_STATUS_TONES: Record<string, Tone> = { PENDING: 'info', SENT: 'ok', FAILED: 'danger' };
export const DISPATCH_KIND_LABELS: Record<string, string> = { SUPPLIER: 'Fournisseur', CAPTAIN: 'Capitaine', REQUESTER: 'Demandeur PR', INTERNAL: 'Interne (utilisateur AMC)' };
export const DISPATCH_CHANNEL_LABELS: Record<string, string> = { EMAIL: 'E-mail', APP: 'Notification plateforme', MANUAL: 'Déclaré manuellement' };

export const APPROVAL_REASON_LABELS: Record<string, string> = {
  NO_THRESHOLD_CONFIGURED: 'aucun seuil configuré (décision AMC en attente) — pas de second regard',
  NO_THRESHOLD_FOR_CURRENCY: 'des seuils existent mais aucun pour cette devise — second regard requis',
  BELOW_THRESHOLD: 'montant sous le seuil de la devise — pas de second regard',
  THRESHOLD_REACHED: 'seuil de la devise atteint — second regard requis',
  POLICY_ALWAYS: 'politique « tout BC » — second regard requis',
  OVER_ALLOCATION: 'sur-allocation motivée — second regard requis',
};

/** Unités usuelles proposées (saisie libre : aucune unité imposée). */
export const COMMON_UNITS = ['pcs', 'L', 'kg', 'm', 'm²', 'm³', 'bidon', 'carton', 'boîte', 'jeu', 'set', 'rouleau', 'paire', 'fût', 'sac', 'lot'];
export const COMMON_CURRENCIES = ['EUR', 'USD', 'TND', 'GBP', 'CHF', 'AED', 'XOF', 'MAD'];
export const INCOTERMS = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP', 'FAS', 'FOB', 'CFR', 'CIF'];

/** Libellés des actions d'historique (journal d'audit Achats). */
export const HISTORY_ACTION_LABELS: Record<string, string> = {
  'pr.created': 'PR créée',
  'pr.updated': 'En-tête modifié',
  'pr.lines_replaced': 'Lignes modifiées',
  'pr.submitted': 'PR soumise',
  'pr.review_started': 'Prise en revue Achats',
  'pr.step_endorsed': 'Visa d’étape',
  'pr.approved': 'PR approuvée',
  'pr.rejected': 'PR rejetée',
  'pr.held': 'Mise en attente',
  'pr.resumed': 'Reprise',
  'pr.cancelled': 'PR annulée',
  'pr.closed': 'PR clôturée',
  'pr.comment_added': 'Commentaire',
  'pr.revision_proposed': 'Counter-PR proposée',
  'pr.revision_accepted': 'Counter-PR acceptée',
  'pr.revision_rejected': 'Counter-PR refusée',
  'pr.revision_correction_requested': 'Correction demandée sur la Counter-PR',
  'pr.revision_withdrawn': 'Counter-PR retirée',
  'pr.status_recomputed': 'Avancement recalculé',
  'pr.pdf_generated': 'PDF généré',
  'attachment.added': 'Pièce jointe ajoutée',
  'po.created': 'BC créé',
  'po.updated': 'BC modifié',
  'po.replaced': 'BC modifié',
  'po.submitted': 'BC soumis',
  'po.approved': 'BC approuvé',
  'po.rejected': 'BC refusé (retour brouillon)',
  'po.sent': 'BC envoyé au fournisseur',
  'po.send_failed': "Échec d'envoi du BC",
  'po.marked_sent': 'Transmission déclarée manuellement',
  'po.revised': 'Avenant / révision',
  'po.cancelled': 'BC annulé',
  'po.closed': 'BC clôturé',
  'po.status_recomputed': 'Statut de réception recalculé',
  'po.pdf_generated': 'PDF officiel généré',
  'file.preview': 'Document consulté',
  'file.download': 'Document téléchargé',
};

// =============================================================================
// Cache & rafraîchissement
// =============================================================================

export const purKeys = {
  all: ['pur'] as const,
  board: (vesselId?: string) => ['pur', 'board', vesselId ?? 'all'] as const,
  config: ['pur', 'config'] as const,
  prFormDefaults: (vesselId: string) => ['pur', 'pr-form-defaults', vesselId || 'none'] as const,
  prs: ['pur', 'prs'] as const,
  pr: (id: string) => ['pur', 'pr', id] as const,
  rfqs: ['pur', 'rfqs'] as const,
  rfq: (id: string) => ['pur', 'rfq', id] as const,
  orders: ['pur', 'orders'] as const,
  order: (id: string) => ['pur', 'order', id] as const,
  notes: ['pur', 'notes'] as const,
  note: (id: string) => ['pur', 'note', id] as const,
  receipts: ['pur', 'receipts'] as const,
  receipt: (id: string) => ['pur', 'receipt', id] as const,
  variances: ['pur', 'variances'] as const,
  variance: (id: string) => ['pur', 'variance', id] as const,
  invoices: ['pur', 'invoices'] as const,
  invoice: (id: string) => ['pur', 'invoice', id] as const,
  suppliers: ['pur', 'suppliers'] as const,
  supplier: (id: string) => ['pur', 'supplier', id] as const,
};

/** Après une commande : tout le cache Achats + dashboard + notifications sont rafraîchis. */
export function usePurRefresh() {
  const qc = useQueryClient();
  return useCallback(async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: purKeys.all }),
      qc.invalidateQueries({ queryKey: ['dashboard'] }),
      qc.invalidateQueries({ queryKey: ['notifications'] }),
    ]);
  }, [qc]);
}

/**
 * Exécute une commande ; sur 409 STALE_VERSION (verrou optimiste) les données sont rechargées
 * avant de relancer l'erreur (affichée par l'appelant : toast / ConfirmDialog).
 */
export function useCommand() {
  const refresh = usePurRefresh();
  return useCallback(
    async <T,>(fn: () => Promise<T>, success?: string | ((r: T) => string)): Promise<T> => {
      try {
        const res = await fn();
        if (success) toast.success(typeof success === 'function' ? success(res) : success);
        await refresh();
        return res;
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'STALE_VERSION' || e.code === 'ALREADY_PROCESSED' || e.code === 'INVALID_STATE')) {
          await refresh();
        }
        throw e;
      }
    },
    [refresh],
  );
}

/** Message lisible d'une erreur API, avec mention spécifique des conflits de version. */
export function commandError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'STALE_VERSION') {
    return `${e.message} — les données affichées ont été rechargées, vérifiez puis recommencez.`;
  }
  if (e instanceof ApiError && e.code === 'SELF_APPROVAL_FORBIDDEN') return e.message;
  return errorMessage(e);
}

/** Lignes en dépassement renvoyées par l'API (sur-allocation), sinon null. */
export function overAllocationLines(e: unknown): OverAllocationLine[] | null {
  if (!(e instanceof ApiError)) return null;
  const d = e.details as { lines?: OverAllocationLine[] } | undefined;
  return d && Array.isArray(d.lines) && d.lines.length && 'excess' in d.lines[0] ? d.lines : null;
}

// =============================================================================
// Divers
// =============================================================================

export function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

/** Filtres de liste portés par l'URL (liens partageables, liens du dashboard). */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const set = useCallback(
    (patch: Record<string, string | null | undefined>) => {
      const next = new URLSearchParams(sp.toString());
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === '') next.delete(k);
        else next.set(k, v);
      }
      const qs = next.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false });
    },
    [router, pathname, sp],
  );
  return { sp, get: (k: string) => sp.get(k) ?? '', set };
}

/** Date civile ISO (API) -> valeur d'<input type="date">. */
export function toDateInput(v: string | null | undefined): string {
  return v ? v.slice(0, 10) : '';
}

export function todayInput(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Clé d'idempotence (UUID v4) — une par formulaire de réception, conservée entre les tentatives. */
export function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* contexte non sécurisé */
  }
  const rnd = () => Math.random().toString(16).slice(2, 10);
  return `rcpt-${Date.now().toString(16)}-${rnd()}-${rnd()}`;
}

/**
 * BC sur lequel BL et réceptions sont possibles : envoyé / partiellement reçu / reçu, ou déjà transmis puis
 * repassé en approbation par un avenant à la hausse (miroir de isPoReceivable côté API).
 */
export function isPoReceivable(po: { status: string; sentAt?: string | null }): boolean {
  return ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'].includes(po.status) || ((po.status === 'APPROVAL_PENDING' || po.status === 'APPROVED') && !!po.sentAt);
}

/** Vrai si la date civile est dépassée (UTC). */
export function isPast(v: string | null | undefined): boolean {
  if (!v) return false;
  const d = new Date(v);
  const now = new Date();
  return d.getTime() < Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

/** Somme des montants par devise (jamais de conversion FX). */
export function totalsByCurrency<T>(rows: T[], currency: (r: T) => string, amount: (r: T) => string | null | undefined): [string, string][] {
  const m = new Map<string, string>();
  for (const r of rows) m.set(currency(r), dec.add(m.get(currency(r)) ?? '0', amount(r) ?? '0'));
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}
