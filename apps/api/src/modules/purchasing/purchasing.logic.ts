import { createHash } from 'node:crypto';
import {
  InvoiceStatus,
  ItemCondition,
  LineStatus,
  PoStatus,
  PrPriority,
  PrStatus,
  RevisionLineAction,
  RfqStatus,
  VarianceStatus,
  VarianceType,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';

/**
 * Règles métier PURES du domaine Achats (CDC §6, V1 §8-9) — sans accès base, testées en unitaire
 * (purchasing.logic.spec.ts). Toute arithmétique de quantités / montants passe par Prisma.Decimal
 * (jamais de float : CDC §13.2, ARCHITECTURE §3 « DTO »).
 */

// =============================================================================
// Arithmétique décimale
// =============================================================================

export type Dec = Prisma.Decimal;
export type DecInput = Prisma.Decimal.Value | null | undefined;

export const ZERO = new Prisma.Decimal(0);

export function D(v: DecInput): Prisma.Decimal {
  if (v === null || v === undefined || v === '') return new Prisma.Decimal(0);
  return Prisma.Decimal.isDecimal(v) ? (v as Prisma.Decimal) : new Prisma.Decimal(v);
}

export function sumD(values: Iterable<DecInput>): Prisma.Decimal {
  let total = new Prisma.Decimal(0);
  for (const v of values) total = total.plus(D(v));
  return total;
}

export function max0(v: DecInput): Prisma.Decimal {
  const d = D(v);
  return d.isNegative() ? new Prisma.Decimal(0) : d;
}

export function minD(a: DecInput, b: DecInput): Prisma.Decimal {
  const x = D(a);
  const y = D(b);
  return x.lessThan(y) ? x : y;
}

/** Montant arrondi au centime (DECIMAL(18,2)), arrondi commercial. */
export function round2(v: DecInput): Prisma.Decimal {
  return D(v).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/** Quantité arrondie au millième (DECIMAL(18,3)). */
export function round3(v: DecInput): Prisma.Decimal {
  return D(v).toDecimalPlaces(3, Prisma.Decimal.ROUND_HALF_UP);
}

/** Affichage d'une quantité sans zéros superflus ("10", "2.5"). */
export function fmtQty(v: DecInput): string {
  return round3(v).toString();
}

export function fmtMoney(v: DecInput): string {
  return round2(v).toFixed(2);
}

/** Unités textuelles (pcs, L, bidon…) : comparaison insensible à la casse et aux espaces (CDC §6.3). */
export function normalizeUnit(u: string | null | undefined): string {
  return (u ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// =============================================================================
// Machines à états (CDC §12) — transitions par commandes
// =============================================================================

export type TransitionTable<S extends string> = Record<S, readonly S[]>;

/**
 * PR : DRAFT → SUBMITTED → UNDER_REVIEW (« en discussion ») → APPROVED (« validée ») ou SPLIT (« divisée » en
 * sous-PR validées) → SOURCING → PARTIALLY_ORDERED/ORDERED → PARTIALLY_RECEIVED/RECEIVED → CLOSED ;
 * CANCELLED / REJECTED / ON_HOLD selon permissions (CDC §12, V1 §8.5, refonte du 22/10/2026).
 * Les statuts « d'avancement » (APPROVED … RECEIVED) sont DÉRIVÉS des lignes (derivePrProgressStatus).
 * REVISED ne concerne plus que les anciennes Counter-PR « proposées » (la Counter-PR est désormais appliquée
 * directement par l'acheteur).
 */
export const PR_TRANSITIONS: TransitionTable<PrStatus> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'],
  SUBMITTED: ['UNDER_REVIEW', 'REVISED', 'APPROVED', 'SPLIT', 'REJECTED', 'ON_HOLD', 'CANCELLED'],
  UNDER_REVIEW: ['REVISED', 'APPROVED', 'SPLIT', 'REJECTED', 'ON_HOLD', 'CANCELLED'],
  // Sortie de REVISED = décision sur la Counter-PR (retour en revue ou au statut d'avancement dérivé)
  REVISED: ['UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'],
  APPROVED: ['SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'REVISED', 'SPLIT', 'ON_HOLD', 'CANCELLED'],
  SOURCING: ['APPROVED', 'PARTIALLY_ORDERED', 'ORDERED', 'REVISED', 'ON_HOLD', 'CANCELLED'],
  PARTIALLY_ORDERED: ['APPROVED', 'SOURCING', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REVISED', 'ON_HOLD', 'CLOSED'],
  ORDERED: ['APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'REVISED', 'CLOSED'],
  PARTIALLY_RECEIVED: ['PARTIALLY_ORDERED', 'ORDERED', 'RECEIVED', 'REVISED', 'CLOSED'],
  RECEIVED: ['PARTIALLY_RECEIVED', 'CLOSED'],
  // Reprise au statut d'avancement dérivé : des BC ont pu être émis, livrés ou clôturés pendant l'attente (ACH-02)
  ON_HOLD: ['UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED', 'CANCELLED'],
  // PR mère : clôturée automatiquement quand toutes ses sous-PR sont terminées
  SPLIT: ['CLOSED'],
  CLOSED: [],
  CANCELLED: [],
  REJECTED: [],
};

/** RFQ : DRAFT → ISSUED → QUOTED → EVALUATED → CLOSED ; CANCELLED (CDC §12). */
export const RFQ_TRANSITIONS: TransitionTable<RfqStatus> = {
  DRAFT: ['ISSUED', 'CANCELLED'],
  ISSUED: ['QUOTED', 'CLOSED', 'CANCELLED'],
  QUOTED: ['EVALUATED', 'CLOSED', 'CANCELLED'],
  // Retrait de toutes les sélections => retour à QUOTED
  EVALUATED: ['QUOTED', 'CLOSED', 'CANCELLED'],
  CLOSED: [],
  CANCELLED: [],
};

/** BC = OC = PO : DRAFT → APPROVAL_PENDING → APPROVED → SENT → PARTIALLY_RECEIVED/RECEIVED → CLOSED (CDC §12). */
export const PO_TRANSITIONS: TransitionTable<PoStatus> = {
  DRAFT: ['APPROVAL_PENDING', 'CANCELLED'],
  APPROVAL_PENDING: ['APPROVED', 'DRAFT', 'CANCELLED'],
  APPROVED: ['SENT', 'CANCELLED'],
  // APPROVAL_PENDING depuis un BC transmis : avenant à la hausse soumis à second regard (avant renvoi)
  SENT: ['PARTIALLY_RECEIVED', 'RECEIVED', 'APPROVAL_PENDING', 'CLOSED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['RECEIVED', 'APPROVAL_PENDING', 'CLOSED'],
  // Avenant augmentant une quantité après réception complète
  RECEIVED: ['PARTIALLY_RECEIVED', 'APPROVAL_PENDING', 'CLOSED'],
  CLOSED: [],
  CANCELLED: [],
};

export const VARIANCE_TRANSITIONS: TransitionTable<VarianceStatus> = {
  OPEN: ['IN_PROGRESS', 'RESOLVED'],
  IN_PROGRESS: ['RESOLVED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
};

/** Facture : revue / rapprochement ; paiement et comptabilité hors V1 (CDC §6.7). */
export const INVOICE_TRANSITIONS: TransitionTable<InvoiceStatus> = {
  RECEIVED: ['UNDER_REVIEW', 'MATCHED', 'DISPUTED', 'CANCELLED'],
  UNDER_REVIEW: ['MATCHED', 'DISPUTED', 'CANCELLED'],
  MATCHED: ['APPROVED', 'DISPUTED', 'CANCELLED'],
  DISPUTED: ['UNDER_REVIEW', 'MATCHED', 'CANCELLED'],
  APPROVED: [],
  CANCELLED: [],
};

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  return (table[from] ?? []).includes(to);
}

/** Lève ALREADY_PROCESSED si l'état cible est déjà atteint (CERT-04), INVALID_STATE sinon. */
export function assertTransition<S extends string>(table: TransitionTable<S>, from: S, to: S, label: string): void {
  if (from === to) throw Errors.alreadyProcessed(`${label} : déjà au statut ${to}`);
  if (!canTransition(table, from, to)) {
    throw Errors.invalidState(`${label} : transition ${from} → ${to} interdite`, { from, to });
  }
}

/** Tolérance sur la date de la demande : un navire à l'est de UTC peut déjà être au lendemain. */
export const PR_REQUEST_DATE_TOLERANCE_DAYS = 1;

/**
 * Dates d'en-tête d'une PR (dates sans heure, minuit UTC) : la demande n'est pas future (une saisie a posteriori
 * d'une demande papier reste possible) et le besoin ne précède pas la demande, sinon la PR serait en retard
 * dès sa création. Retourne le champ fautif et un message FR, ou null.
 */
export function prDateIssue(
  requestDate: Date,
  neededBy: Date | null | undefined,
  today: Date,
): { field: 'requestDate' | 'neededBy'; message: string } | null {
  const limit = today.getTime() + PR_REQUEST_DATE_TOLERANCE_DAYS * 86_400_000;
  if (requestDate.getTime() > limit) return { field: 'requestDate', message: 'La date de la demande ne peut pas être dans le futur' };
  if (neededBy && neededBy.getTime() < requestDate.getTime()) {
    return { field: 'neededBy', message: 'La date de besoin ne peut pas précéder la date de la demande' };
  }
  return null;
}

/** Statuts PR « d'avancement » recalculés automatiquement depuis les lignes. */
export const PR_PROGRESS_STATUSES: readonly PrStatus[] = [
  'APPROVED',
  'SOURCING',
  'PARTIALLY_ORDERED',
  'ORDERED',
  'PARTIALLY_RECEIVED',
  'RECEIVED',
];

/** Une PR dont on peut commander les lignes (BC) : décision d'approbation acquise, pas de Counter-PR en cours. */
export const PR_ORDERABLE_STATUSES: readonly PrStatus[] = ['APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED'];

/** Une PR dont les lignes peuvent être mises en consultation (RFQ) — y compris pendant la revue (CDC §6.2). */
export const PR_SOURCEABLE_STATUSES: readonly PrStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'];

/** Une Counter-PR peut être proposée sur ces statuts (CDC §6.4). */
export const PR_REVISABLE_STATUSES: readonly PrStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'SOURCING',
  'PARTIALLY_ORDERED',
  'ORDERED',
  'PARTIALLY_RECEIVED',
];

/** Division en sous-PR : décision prise en discussion, ou PR validée tant que rien n'est consulté ni commandé. */
export const PR_SPLITTABLE_STATUSES: readonly PrStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED'];
/** Statuts terminaux d'une sous-PR (la PR mère se clôture quand toutes ses sous-PR y sont). */
export const PR_TERMINAL_STATUSES: readonly PrStatus[] = ['CLOSED', 'CANCELLED', 'REJECTED'];

export const PR_HOLDABLE_STATUSES: readonly PrStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'];
export const PR_CANCELLABLE_STATUSES: readonly PrStatus[] = ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'APPROVED', 'SOURCING', 'ON_HOLD'];
export const PR_CLOSABLE_STATUSES: readonly PrStatus[] = ['PARTIALLY_ORDERED', 'ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED'];
/** PR « en retard » : besoin non satisfait à la date needed_by. */
export const PR_OPEN_STATUSES: readonly PrStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'REVISED',
  'APPROVED',
  'SOURCING',
  'PARTIALLY_ORDERED',
  'ORDERED',
  'PARTIALLY_RECEIVED',
  'ON_HOLD',
];
/** PR non (entièrement) commandées — relance planifiée (SCHEDULED_JOBS.PURCHASING_FOLLOWUP). */
export const PR_NOT_ORDERED_STATUSES: readonly PrStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'REVISED',
  'APPROVED',
  'SOURCING',
  'PARTIALLY_ORDERED',
  'ON_HOLD',
];

/** BC « commandés » (engagement fournisseur acquis) : comptent dans « Qty Ordered » d'une ligne PR. */
export const PO_COMMITTED_STATUSES: readonly PoStatus[] = ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];
/** BC sur lesquels BL et réceptions peuvent être enregistrés. */
export const PO_RECEIVABLE_STATUSES: readonly PoStatus[] = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED'];

/**
 * BC déjà transmis au fournisseur : livraisons et avenants restent enregistrables, y compris lorsqu'un avenant
 * attend son second regard (APPROVAL_PENDING) ou son renvoi (APPROVED) — la réalité physique prime.
 */
export function isPoReceivable(po: { status: PoStatus; sentAt: Date | null }): boolean {
  return PO_RECEIVABLE_STATUSES.includes(po.status) || ((po.status === 'APPROVAL_PENDING' || po.status === 'APPROVED') && !!po.sentAt);
}

// =============================================================================
// Quantités PR : demandé / approuvé / annulé / alloué (V1 §8.4)
// =============================================================================

export interface PrLineQuantities {
  quantityRequested: DecInput;
  quantityApproved: DecInput;
  quantityCancelled: DecInput;
  status?: LineStatus;
}

/** Quantité de travail : approuvée (après revue / Counter-PR) sinon demandée. Qty Requested n'est jamais modifiée. */
export function workingQuantity(l: PrLineQuantities): Prisma.Decimal {
  return l.quantityApproved === null || l.quantityApproved === undefined ? D(l.quantityRequested) : D(l.quantityApproved);
}

/** Quantité effective à satisfaire = approuvée − annulée (jamais négative). */
export function effectiveQuantity(l: PrLineQuantities): Prisma.Decimal {
  if (l.status === 'CANCELLED') return new Prisma.Decimal(0);
  return max0(workingQuantity(l).minus(D(l.quantityCancelled)));
}

export interface AllocationLineState {
  prLineId: string;
  prNumber: string;
  lineNo: number;
  /** effective (approuvée − annulée) */
  effective: DecInput;
  /** Somme des allocations existantes sur des lignes BC non annulées (hors BC en cours de remplacement) */
  allocated: DecInput;
}

export interface AllocationRequest {
  prLineId: string;
  quantity: DecInput;
}

export interface OverAllocation {
  prLineId: string;
  prNumber: string;
  lineNo: number;
  effective: string;
  alreadyAllocated: string;
  requested: string;
  capacity: string;
  excess: string;
}

/**
 * Contrôle anti-sur-allocation (CDC §6.4, V1 §9.3) : Σ allocations (BC non annulés) ≤ approuvé − annulé.
 * Retourne les lignes en dépassement (vide si tout tient dans la capacité).
 */
export function evaluateAllocations(states: AllocationLineState[], requests: AllocationRequest[]): OverAllocation[] {
  const byLine = new Map<string, Prisma.Decimal>();
  for (const r of requests) {
    const q = D(r.quantity);
    if (!q.greaterThan(0)) throw Errors.validation('Quantité allouée : doit être > 0', { prLineId: r.prLineId });
    byLine.set(r.prLineId, (byLine.get(r.prLineId) ?? new Prisma.Decimal(0)).plus(q));
  }
  const over: OverAllocation[] = [];
  for (const [prLineId, requested] of byLine) {
    const s = states.find((x) => x.prLineId === prLineId);
    if (!s) throw Errors.validation('Ligne PR inconnue dans les allocations', { prLineId });
    const capacity = D(s.effective).minus(D(s.allocated));
    if (requested.greaterThan(capacity)) {
      over.push({
        prLineId,
        prNumber: s.prNumber,
        lineNo: s.lineNo,
        effective: fmtQty(s.effective),
        alreadyAllocated: fmtQty(s.allocated),
        requested: fmtQty(requested),
        capacity: fmtQty(max0(capacity)),
        excess: fmtQty(requested.minus(max0(capacity))),
      });
    }
  }
  return over;
}

/**
 * Décision sur un dépassement : interdit par défaut ; autorisé seulement si le paramètre
 * `purchasing.allowOverAllocation` est vrai ET qu'un motif explicite est fourni (V1 §9.1 « Sur-commande »).
 */
export function assertOverAllocationAllowed(over: OverAllocation[], allowOverAllocation: boolean, reason: string | null | undefined): void {
  if (!over.length) return;
  if (!allowOverAllocation) {
    throw Errors.business('Sur-allocation interdite : la quantité commandée dépasse la quantité approuvée restante', { lines: over });
  }
  if (!reason || reason.trim().length < 3) {
    throw Errors.validation('Dépassement de la quantité approuvée : motif (overAllocationReason) obligatoire', { lines: over });
  }
}

/** Répartit une quantité (BL, reçu, accepté…) d'une ligne BC sur ses allocations dans l'ordre FIFO. */
export function distributeFifo(total: DecInput, parts: DecInput[]): Prisma.Decimal[] {
  let remaining = max0(total);
  return parts.map((p) => {
    const share = minD(max0(p), remaining);
    remaining = remaining.minus(share);
    return share;
  });
}

/**
 * Réduit des allocations (les plus récentes d'abord) pour que leur somme ne dépasse pas `capacity`
 * (après annulation d'un reliquat ou baisse de quantité sur une ligne BC). Retourne les nouvelles quantités.
 */
export function shrinkAllocations(quantities: DecInput[], capacity: DecInput): Prisma.Decimal[] {
  const out = quantities.map((q) => D(q));
  let excess = sumD(out).minus(max0(capacity));
  for (let i = out.length - 1; i >= 0 && excess.greaterThan(0); i--) {
    const cut = minD(out[i], excess);
    out[i] = out[i].minus(cut);
    excess = excess.minus(cut);
  }
  return out;
}

/**
 * Quantité d'une ligne BC non couverte par ses allocations PR (Σ allocations doit égaler la quantité
 * effective commandée). > 0 => dépassement : interdit sauf parcours de sur-allocation explicite (motif).
 * Les allocations ne peuvent jamais excéder la quantité de la ligne.
 */
export function unallocatedQuantity(lineQuantity: DecInput, allocations: DecInput[], label: string): Prisma.Decimal {
  const total = sumD(allocations);
  const qty = D(lineQuantity);
  if (total.greaterThan(qty)) throw Errors.validation(`${label} : allocations (${fmtQty(total)}) supérieures à la quantité commandée (${fmtQty(qty)})`);
  return qty.minus(total);
}

// =============================================================================
// Rapprochement BC / BL / reçu physique (CDC §6.7 — PUR-04)
// =============================================================================

export interface PoLineBalanceInput {
  ordered: DecInput;
  cancelled: DecInput;
  onNotes: DecInput;
  received: DecInput;
  accepted: DecInput;
  rejected: DecInput;
}

export interface PoLineBalance {
  effectiveOrdered: Prisma.Decimal;
  /** qty_remaining = max(0, ordered − cancelled − accepted) */
  remaining: Prisma.Decimal;
  /** BL − reçu physique (un BL n'est pas une preuve de réception) */
  deltaNoteVsReceived: Prisma.Decimal;
  deltaOrderedVsNote: Prisma.Decimal;
  shortShipped: Prisma.Decimal;
  shortReceived: Prisma.Decimal;
  surplus: Prisma.Decimal;
}

/** Même formule que la vue SQL `v_po_line_balance` (migration 0002), avec les écarts dérivés. */
export function computeBalance(b: PoLineBalanceInput): PoLineBalance {
  const effectiveOrdered = max0(D(b.ordered).minus(D(b.cancelled)));
  return {
    effectiveOrdered,
    remaining: max0(D(b.ordered).minus(D(b.cancelled)).minus(D(b.accepted))),
    deltaNoteVsReceived: D(b.onNotes).minus(D(b.received)),
    deltaOrderedVsNote: D(b.ordered).minus(D(b.onNotes)),
    shortShipped: max0(effectiveOrdered.minus(D(b.onNotes))),
    shortReceived: max0(D(b.onNotes).minus(D(b.received))),
    surplus: max0(D(b.received).minus(effectiveOrdered)),
  };
}

export interface ReceiptLineFacts {
  poLineId: string;
  qtyReceived: DecInput;
  qtyAccepted: DecInput;
  qtyRejected: DecInput;
  condition: ItemCondition;
}

export interface VarianceDraft {
  poLineId: string;
  type: VarianceType;
  quantity: Prisma.Decimal;
  description: string;
}

/** Contrôle reçu = accepté + rejeté (même règle que le CHECK SQL receipt_lines_qty_consistency). */
export function assertReceiptLineConsistent(l: ReceiptLineFacts, label: string): void {
  const rec = D(l.qtyReceived);
  const acc = D(l.qtyAccepted);
  const rej = D(l.qtyRejected);
  if (rec.isNegative() || acc.isNegative() || rej.isNegative()) throw Errors.validation(`${label} : quantités négatives interdites`);
  if (!acc.plus(rej).equals(rec)) {
    throw Errors.validation(`${label} : reçu (${fmtQty(rec)}) ≠ accepté (${fmtQty(acc)}) + rejeté (${fmtQty(rej)})`);
  }
}

/**
 * Écarts « événement » propres à une réception : avarie, mauvaise référence, rejet (CDC §6.7).
 * Une ligne en état DAMAGED / WRONG_ITEM porte sur la quantité rejetée (ou reçue si rien n'est rejeté).
 */
export function detectEventVariances(l: ReceiptLineFacts): VarianceDraft[] {
  const received = D(l.qtyReceived);
  const rejected = D(l.qtyRejected);
  const affected = rejected.greaterThan(0) ? rejected : received;
  if (l.condition === 'WRONG_ITEM' && affected.greaterThan(0)) {
    return [{ poLineId: l.poLineId, type: 'WRONG_REFERENCE', quantity: affected, description: `Mauvaise référence livrée : ${fmtQty(affected)}` }];
  }
  if (l.condition === 'DAMAGED' && affected.greaterThan(0)) {
    return [{ poLineId: l.poLineId, type: 'DAMAGED', quantity: affected, description: `Article(s) endommagé(s) : ${fmtQty(affected)}` }];
  }
  if (rejected.greaterThan(0)) {
    return [{ poLineId: l.poLineId, type: 'REJECTED', quantity: rejected, description: `Quantité rejetée à la réception : ${fmtQty(rejected)}` }];
  }
  return [];
}

export type BalanceVarianceType = Extract<VarianceType, 'SHORT_SHIPPED' | 'SHORT_RECEIVED' | 'SURPLUS'>;
export const BALANCE_VARIANCE_TYPES: readonly BalanceVarianceType[] = ['SHORT_SHIPPED', 'SHORT_RECEIVED', 'SURPLUS'];

/**
 * Écarts « de solde » cumulés d'une ligne BC (recalculés à chaque BL / réception) :
 *  - SHORT_SHIPPED  : commandé > cumul des BL (seulement si au moins un BL existe pour le BC) ;
 *  - SHORT_RECEIVED : cumul des BL déjà réceptionnés > reçu physique ;
 *  - SURPLUS        : reçu physique > commandé (net des annulations).
 */
export function desiredBalanceVariances(
  b: PoLineBalanceInput,
  opts: { hasDeliveryNotes: boolean; onReceivedNotes?: DecInput },
): Record<BalanceVarianceType, Prisma.Decimal> {
  const bal = computeBalance(b);
  // Short-received : seulement pour les BL déjà réceptionnés (un BL en attente de réception n'est pas un manquant)
  const shortReceived = opts.onReceivedNotes === undefined ? bal.shortReceived : max0(D(opts.onReceivedNotes).minus(D(b.received)));
  return {
    SHORT_SHIPPED: opts.hasDeliveryNotes ? bal.shortShipped : new Prisma.Decimal(0),
    SHORT_RECEIVED: shortReceived,
    SURPLUS: bal.surplus,
  };
}

export interface OpenVariance {
  id: string;
  type: VarianceType;
  quantity: DecInput;
}

export interface BalanceVariancePlan {
  create: { type: BalanceVarianceType; quantity: Prisma.Decimal }[];
  update: { id: string; quantity: Prisma.Decimal }[];
  resolve: { id: string; type: BalanceVarianceType }[];
}

/**
 * Synchronise les écarts de solde ouverts d'une ligne BC avec l'état cumulé courant :
 * un écart par type reste ouvert tant que le solde est non nul, puis est résolu automatiquement
 * (« comblé par une livraison ultérieure ») — le reliquat reste visible jusqu'à réception, annulation
 * ou clôture documentée (V1 §9.3).
 */
export function planBalanceVariances(open: OpenVariance[], desired: Record<BalanceVarianceType, Prisma.Decimal>): BalanceVariancePlan {
  const plan: BalanceVariancePlan = { create: [], update: [], resolve: [] };
  for (const type of BALANCE_VARIANCE_TYPES) {
    const want = desired[type];
    const existing = open.filter((v) => v.type === type);
    if (want.greaterThan(0)) {
      if (!existing.length) plan.create.push({ type, quantity: want });
      else {
        if (!D(existing[0].quantity).equals(want)) plan.update.push({ id: existing[0].id, quantity: want });
        existing.slice(1).forEach((v) => plan.resolve.push({ id: v.id, type }));
      }
    } else {
      existing.forEach((v) => plan.resolve.push({ id: v.id, type }));
    }
  }
  return plan;
}

// =============================================================================
// Statuts dérivés BC et PR
// =============================================================================

export interface PoLineReceiptState extends PoLineBalanceInput {
  status: LineStatus;
}

/**
 * Statut de réception d'un BC dérivé de `v_po_line_balance` : RECEIVED si tous les reliquats sont nuls
 * (et au moins une réception), PARTIALLY_RECEIVED dès qu'une quantité a été physiquement reçue.
 * Une facture n'intervient JAMAIS dans ce calcul (PUR-07).
 */
export function derivePoReceiptStatus(current: PoStatus, lines: PoLineReceiptState[]): PoStatus {
  if (!PO_RECEIVABLE_STATUSES.includes(current)) return current;
  const active = lines.filter((l) => l.status !== 'CANCELLED');
  const anyReceived = lines.some((l) => D(l.received).greaterThan(0));
  if (!anyReceived) return 'SENT';
  const allDone = active.every((l) => computeBalance(l).remaining.isZero());
  return allDone ? 'RECEIVED' : 'PARTIALLY_RECEIVED';
}

/**
 * Clôture automatique (règle AMC du 22/10/2026) : un BC se clôture quand tout ce qu'il porte (après
 * corrections) a été reçu à bord et qu'aucun écart n'est ouvert ; une PR quand toutes ses lignes sont reçues
 * et qu'aucun écart n'est ouvert sur ses BC. Jamais de clôture avec un manque.
 */
export function isAutoClosable(f: { status: PoStatus | PrStatus; openVariances: number }): boolean {
  return f.status === 'RECEIVED' && f.openVariances === 0;
}

export type PrLineBadge = 'CANCELLED' | 'NOT_ORDERED' | 'PARTIALLY_ORDERED' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED';

export interface PrLineProgressInput {
  status: LineStatus;
  effective: DecInput;
  ordered: DecInput;
  accepted: DecInput;
}

/** Badge d'avancement par ligne (V1 §9.1 « chaque ligne a son avancement propre »). */
export function prLineBadge(l: PrLineProgressInput): PrLineBadge {
  const effective = D(l.effective);
  if (l.status === 'CANCELLED' || effective.isZero()) return 'CANCELLED';
  const accepted = D(l.accepted);
  const ordered = D(l.ordered);
  if (accepted.greaterThanOrEqualTo(effective)) return 'RECEIVED';
  if (accepted.greaterThan(0)) return 'PARTIALLY_RECEIVED';
  if (ordered.greaterThanOrEqualTo(effective)) return 'ORDERED';
  if (ordered.greaterThan(0)) return 'PARTIALLY_ORDERED';
  return 'NOT_ORDERED';
}

/**
 * Statut d'avancement d'une PR approuvée dérivé de ses lignes. Retourne null si aucune ligne active
 * (toutes annulées) : le statut courant est alors conservé.
 */
export function derivePrProgressStatus(lines: PrLineProgressInput[], hasActiveRfq: boolean): PrStatus | null {
  const badges = lines.map(prLineBadge).filter((b) => b !== 'CANCELLED');
  if (!badges.length) return null;
  if (badges.every((b) => b === 'RECEIVED')) return 'RECEIVED';
  if (badges.some((b) => b === 'RECEIVED' || b === 'PARTIALLY_RECEIVED')) return 'PARTIALLY_RECEIVED';
  if (badges.every((b) => b === 'ORDERED')) return 'ORDERED';
  if (badges.some((b) => b === 'ORDERED' || b === 'PARTIALLY_ORDERED')) return 'PARTIALLY_ORDERED';
  return hasActiveRfq ? 'SOURCING' : 'APPROVED';
}

// =============================================================================
// Counter-PR / révisions (CDC §6.4 — PUR-02)
// =============================================================================

export interface RevisionCurrentLine {
  id: string;
  lineNo: number;
  designation: string;
  reference: string | null;
  unit: string;
  quantityRequested: DecInput;
  quantityApproved: DecInput;
  quantityCancelled: DecInput;
  status: LineStatus;
  /** Quantité déjà allouée sur des BC non annulés */
  allocated: DecInput;
}

export interface RevisionLineInput {
  action: RevisionLineAction;
  prLineId?: string | null;
  quantity?: DecInput;
  designation?: string | null;
  reference?: string | null;
  unit?: string | null;
  remarks?: string | null;
}

export interface PlannedRevisionLine {
  prLineId: string | null;
  action: RevisionLineAction;
  designation: string;
  reference: string | null;
  quantity: Prisma.Decimal;
  unit: string;
  remarks: string | null;
}

/**
 * Construit la proposition révisée complète (snapshot) : chaque ligne existante non citée est
 * conservée (KEEP). CHANGE porte sur la quantité de travail (≥ quantité déjà commandée) ; REMOVE
 * annule le non-commandé ; ADD crée une nouvelle ligne. La PR d'origine n'est jamais écrasée.
 */
export function planRevision(
  current: RevisionCurrentLine[],
  input: RevisionLineInput[],
  opts: { allowNoLineChange?: boolean } = {},
): { lines: PlannedRevisionLine[]; changes: number } {
  const seen = new Set<string>();
  const planned: PlannedRevisionLine[] = [];
  const byId = new Map(current.map((l) => [l.id, l]));
  let changes = 0;
  for (const [i, raw] of input.entries()) {
    const label = `Ligne ${i + 1}`;
    if (raw.action === 'ADD') {
      const q = D(raw.quantity);
      if (!raw.designation?.trim()) throw Errors.validation(`${label} : désignation requise pour un ajout`);
      if (!raw.unit?.trim()) throw Errors.validation(`${label} : unité requise pour un ajout`);
      if (!q.greaterThan(0)) throw Errors.validation(`${label} : quantité ajoutée > 0 requise`);
      planned.push({
        prLineId: null,
        action: 'ADD',
        designation: raw.designation.trim(),
        reference: raw.reference?.trim() || null,
        quantity: q,
        unit: raw.unit.trim(),
        remarks: raw.remarks?.trim() || null,
      });
      changes++;
      continue;
    }
    if (!raw.prLineId) throw Errors.validation(`${label} : prLineId requis pour ${raw.action}`);
    const line = byId.get(raw.prLineId);
    if (!line) throw Errors.validation(`${label} : ligne PR inconnue`, { prLineId: raw.prLineId });
    if (seen.has(line.id)) throw Errors.validation(`${label} : ligne PR citée deux fois`, { prLineId: line.id });
    seen.add(line.id);
    const allocated = D(line.allocated);
    const effective = effectiveQuantity(line);
    const base = { prLineId: line.id, designation: line.designation, reference: line.reference, unit: line.unit, remarks: raw.remarks?.trim() || null };
    if (raw.action === 'KEEP') {
      planned.push({ ...base, action: 'KEEP', quantity: effective });
    } else if (raw.action === 'CHANGE') {
      const q = D(raw.quantity);
      if (!q.greaterThan(0)) throw Errors.validation(`${label} : nouvelle quantité > 0 requise (utilisez REMOVE pour retirer)`);
      if (q.lessThan(allocated)) {
        throw Errors.business(`${label} : quantité inférieure à la quantité déjà commandée (${fmtQty(allocated)})`, { prLineId: line.id });
      }
      if (q.equals(effective) && line.status !== 'CANCELLED') {
        planned.push({ ...base, action: 'KEEP', quantity: effective });
      } else {
        planned.push({ ...base, action: 'CHANGE', quantity: q });
        changes++;
      }
    } else if (raw.action === 'REMOVE') {
      if (line.status === 'CANCELLED') throw Errors.business(`${label} : ligne déjà annulée`);
      planned.push({ ...base, action: 'REMOVE', quantity: allocated });
      changes++;
    }
  }
  for (const line of current) {
    if (seen.has(line.id)) continue;
    planned.push({
      prLineId: line.id,
      action: 'KEEP',
      designation: line.designation,
      reference: line.reference,
      quantity: effectiveQuantity(line),
      unit: line.unit,
      remarks: null,
    });
  }
  if (!changes && !opts.allowNoLineChange) throw Errors.validation('La révision ne contient aucune modification (CHANGE / ADD / REMOVE)');
  const order = new Map(current.map((l) => [l.id, l.lineNo]));
  planned.sort((a, b) => (order.get(a.prLineId ?? '') ?? 1e9) - (order.get(b.prLineId ?? '') ?? 1e9));
  return { lines: planned, changes };
}

export interface RevisionApplyOp {
  prLineId: string;
  quantityApproved: Prisma.Decimal;
  quantityCancelled: Prisma.Decimal;
  status: LineStatus;
}

/**
 * Effet d'une ligne de révision ACCEPTÉE sur les quantités de travail d'une ligne existante
 * (quantityRequested reste intacte). Retourne null pour KEEP / ADD.
 */
export function applyRevisionLine(line: RevisionCurrentLine, action: RevisionLineAction, quantity: DecInput): RevisionApplyOp | null {
  const allocated = D(line.allocated);
  if (action === 'CHANGE') {
    const q = D(quantity);
    if (q.lessThan(allocated)) {
      throw Errors.business(`Ligne ${line.lineNo} : quantité révisée inférieure à la quantité déjà commandée (${fmtQty(allocated)})`);
    }
    return { prLineId: line.id, quantityApproved: q, quantityCancelled: new Prisma.Decimal(0), status: 'OPEN' };
  }
  if (action === 'REMOVE') {
    const working = workingQuantity(line);
    return {
      prLineId: line.id,
      quantityApproved: working,
      quantityCancelled: max0(working.minus(allocated)),
      status: allocated.isZero() ? 'CANCELLED' : 'OPEN',
    };
  }
  return null;
}

export interface RevisionDiffLine {
  action: RevisionLineAction;
  prLineId: string | null;
  lineNo: number | null;
  original: { designation: string; reference: string | null; quantityRequested: string; unit: string } | null;
  proposed: { designation: string; reference: string | null; quantity: string; unit: string; remarks: string | null };
  /** Proposé − demandé à l'origine (ADD : +quantité) */
  quantityDelta: string;
}

/** Différence ligne à ligne PR d'origine (immuable) vs proposition révisée (PUR-02). */
export function diffRevision(
  original: { id: string; lineNo: number; designation: string; reference: string | null; quantityRequested: DecInput; unit: string }[],
  revision: { prLineId: string | null; action: RevisionLineAction; designation: string; reference: string | null; quantity: DecInput; unit: string; remarks: string | null }[],
): RevisionDiffLine[] {
  const byId = new Map(original.map((l) => [l.id, l]));
  return revision.map((r) => {
    const o = r.prLineId ? byId.get(r.prLineId) ?? null : null;
    const delta = D(r.quantity).minus(o ? D(o.quantityRequested) : 0);
    return {
      action: r.action,
      prLineId: r.prLineId,
      lineNo: o?.lineNo ?? null,
      original: o ? { designation: o.designation, reference: o.reference, quantityRequested: fmtQty(o.quantityRequested), unit: o.unit } : null,
      proposed: { designation: r.designation, reference: r.reference, quantity: fmtQty(r.quantity), unit: r.unit, remarks: r.remarks },
      quantityDelta: fmtQty(delta),
    };
  });
}

// =============================================================================
// Division d'une PR en sous-PR (refonte 22/10/2026) : lignes entières uniquement
// =============================================================================

export const MAX_SPLIT_GROUPS = 26;

/** Suffixe de la sous-PR n° i (0 → A, 1 → B…) : ISK-PR-2026-0332-A. */
export function splitSuffix(index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= MAX_SPLIT_GROUPS) throw Errors.validation(`Au plus ${MAX_SPLIT_GROUPS} sous-PR`);
  return String.fromCharCode(65 + index);
}

export interface SplitLineState {
  id: string;
  lineNo: number;
  status: LineStatus;
  quantityRequested: DecInput;
  quantityApproved: DecInput;
  quantityCancelled: DecInput;
}

export interface SplitGroupInput {
  lineIds: string[];
  label?: string | null;
}

export interface PlannedSplitGroup<L extends SplitLineState> {
  suffix: string;
  label: string | null;
  lines: (L & { effective: Prisma.Decimal })[];
}

/**
 * Répartition des lignes ACTIVES (non annulées, quantité effective > 0) en au moins deux sous-PR non vides ;
 * chaque ligne active est affectée exactement une fois (lignes entières : pas de partage de quantité).
 * Les groupes vides sont ignorés ; l'ordre des lignes d'origine est conservé dans chaque sous-PR.
 */
export function planSplit<L extends SplitLineState>(lines: L[], groups: SplitGroupInput[]): PlannedSplitGroup<L>[] {
  const active = lines.filter((l) => l.status !== 'CANCELLED' && effectiveQuantity(l).greaterThan(0));
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const nonEmpty = groups.filter((g) => g.lineIds.length > 0);
  if (nonEmpty.length < 2) throw Errors.validation('Une division crée au moins deux sous-PR non vides');
  if (nonEmpty.length > MAX_SPLIT_GROUPS) throw Errors.validation(`Au plus ${MAX_SPLIT_GROUPS} sous-PR`);
  const planned = nonEmpty.map((g, i) => {
    const groupLines = g.lineIds.map((id) => {
      const l = byId.get(id);
      if (!l) throw Errors.validation('Ligne inconnue dans la division', { prLineId: id });
      if (seen.has(id)) throw Errors.validation(`Ligne ${l.lineNo} affectée à deux sous-PR (lignes entières uniquement)`, { prLineId: id });
      if (!active.includes(l)) throw Errors.business(`Ligne ${l.lineNo} annulée : elle ne peut pas être reprise dans une sous-PR`, { prLineId: id });
      seen.add(id);
      return { ...l, effective: effectiveQuantity(l) };
    });
    groupLines.sort((a, b) => a.lineNo - b.lineNo);
    return { suffix: splitSuffix(i), label: g.label?.trim() || null, lines: groupLines };
  });
  const missing = active.filter((l) => !seen.has(l.id));
  if (missing.length) {
    throw Errors.validation(`Ligne(s) ${missing.map((l) => l.lineNo).join(', ')} non affectée(s) : chaque ligne va dans une sous-PR`, {
      prLineIds: missing.map((l) => l.id),
    });
  }
  return planned;
}

// =============================================================================
// Devis : totaux et comparaison sans conversion FX (CDC §6.5)
// =============================================================================

export interface QuotationLineAmounts {
  isAvailable: boolean;
  quantityOffered: DecInput;
  unitPrice: DecInput;
}

export function computeQuotationTotals(
  lines: QuotationLineAmounts[],
  charges: { freight?: DecInput; tax?: DecInput; discount?: DecInput },
): { lineTotals: (Prisma.Decimal | null)[]; subtotal: Prisma.Decimal; total: Prisma.Decimal } {
  const lineTotals = lines.map((l) =>
    l.isAvailable && l.quantityOffered !== null && l.quantityOffered !== undefined && l.unitPrice !== null && l.unitPrice !== undefined
      ? round2(D(l.quantityOffered).times(D(l.unitPrice)))
      : null,
  );
  const subtotal = round2(sumD(lineTotals));
  const total = round2(subtotal.plus(D(charges.freight)).plus(D(charges.tax)).minus(D(charges.discount)));
  if (total.isNegative()) throw Errors.validation('Total du devis négatif : remise supérieure au montant');
  return { lineTotals, subtotal, total };
}

export interface ComparableOffer {
  quotationLineId: string;
  currency: string;
  isAvailable: boolean;
  unitPrice: DecInput;
  compliance: 'COMPLIANT' | 'ALTERNATIVE' | 'NON_COMPLIANT';
}

/**
 * Offres les moins chères par ligne, DANS UNE MÊME DEVISE (aucun taux de change inventé) :
 * prix unitaire minimal parmi les offres disponibles, chiffrées et non « NON_COMPLIANT ».
 */
export function cheapestPerCurrency(offers: ComparableOffer[]): Set<string> {
  const best = new Map<string, Prisma.Decimal>();
  const eligible = offers.filter((o) => o.isAvailable && o.unitPrice !== null && o.unitPrice !== undefined && o.compliance !== 'NON_COMPLIANT');
  for (const o of eligible) {
    const cur = best.get(o.currency);
    if (!cur || D(o.unitPrice).lessThan(cur)) best.set(o.currency, D(o.unitPrice));
  }
  return new Set(eligible.filter((o) => D(o.unitPrice).equals(best.get(o.currency)!)).map((o) => o.quotationLineId));
}

export function coverage(
  rfqLines: { id: string; quantity: DecInput }[],
  offers: { rfqLineId: string; isAvailable: boolean; unitPrice: DecInput; quantityOffered: DecInput }[],
): { totalLines: number; quotedLines: number; fullyCoveredLines: number; percent: string; fullPercent: string } {
  let quoted = 0;
  let full = 0;
  for (const l of rfqLines) {
    const o = offers.find((x) => x.rfqLineId === l.id);
    if (!o || !o.isAvailable || o.unitPrice === null || o.unitPrice === undefined) continue;
    quoted++;
    if (o.quantityOffered === null || o.quantityOffered === undefined || D(o.quantityOffered).greaterThanOrEqualTo(D(l.quantity))) full++;
  }
  const pct = (n: number) => (rfqLines.length ? new Prisma.Decimal(n).times(100).dividedBy(rfqLines.length).toDecimalPlaces(1).toFixed(1) : '0.0');
  return { totalLines: rfqLines.length, quotedLines: quoted, fullyCoveredLines: full, percent: pct(quoted), fullPercent: pct(full) };
}

// =============================================================================
// Totaux BC
// =============================================================================

export interface PoLineAmounts {
  quantityOrdered: DecInput;
  quantityCancelled: DecInput;
  unitPrice: DecInput;
  status?: LineStatus;
}

export function poLineTotal(l: PoLineAmounts): Prisma.Decimal {
  if (l.status === 'CANCELLED') return new Prisma.Decimal(0);
  return round2(max0(D(l.quantityOrdered).minus(D(l.quantityCancelled))).times(D(l.unitPrice)));
}

export function computePoTotals(lines: PoLineAmounts[], charges: { tax?: DecInput; freight?: DecInput }) {
  const lineTotals = lines.map(poLineTotal);
  const subtotal = round2(sumD(lineTotals));
  const total = round2(subtotal.plus(D(charges.tax)).plus(D(charges.freight)));
  return { lineTotals, subtotal, total };
}

// =============================================================================
// Second regard BC selon seuil configurable (CHOIX RECOMMANDÉ §6.5 — seuils NON pré-remplis)
// =============================================================================

export type PoApprovalMode = 'THRESHOLD_ONLY' | 'ALWAYS';

export interface ThresholdRow {
  currency: string;
  amount: DecInput;
  requiresSecondApproval: boolean;
  isActive: boolean;
}

/**
 * THRESHOLD_ONLY (défaut) : second regard requis si le total atteint le seuil actif DE LA DEVISE du BC —
 * aucun seuil n'est inventé, aucune conversion FX n'est faite.
 *  - aucun seuil actif configuré (décision AMC en attente) : pas de second regard ;
 *  - des seuils existent mais AUCUN pour la devise du BC : second regard exigé (fail-closed — empêche le
 *    contournement par une devise non paramétrée) ;
 * ALWAYS : tout BC requiert l'approbation d'une seconde personne (bc.approve).
 * Une sur-allocation autorisée (ou une quantité non couverte par les allocations PR) impose un second regard.
 */
export function secondApprovalDecision(
  total: DecInput,
  currency: string,
  thresholds: ThresholdRow[],
  mode: PoApprovalMode,
  hasOverAllocation = false,
): { required: boolean; reason: string; threshold: string | null } {
  if (mode === 'ALWAYS') return { required: true, reason: 'POLICY_ALWAYS', threshold: null };
  if (hasOverAllocation) return { required: true, reason: 'OVER_ALLOCATION', threshold: null };
  const active = thresholds.filter((x) => x.isActive);
  if (!active.length) return { required: false, reason: 'NO_THRESHOLD_CONFIGURED', threshold: null };
  const t = active.find((x) => x.currency === currency);
  if (!t) return { required: true, reason: 'NO_THRESHOLD_FOR_CURRENCY', threshold: null };
  if (t.requiresSecondApproval && D(total).greaterThanOrEqualTo(D(t.amount))) {
    return { required: true, reason: 'THRESHOLD_REACHED', threshold: fmtMoney(t.amount) };
  }
  return { required: false, reason: 'BELOW_THRESHOLD', threshold: fmtMoney(t.amount) };
}

// =============================================================================
// Circuits de revue PR (CDC §6.4 — PUR-01) : règles configurables, circuit appliqué tracé
// =============================================================================

export interface ReviewStepDef {
  key: string;
  label: string;
  /** Permission exigée de l'acteur de l'étape (la dernière étape doit être 'pr.approve') */
  permission: string;
  /** Rôles dont l'acteur doit détenir au moins un (ex. ['CAPTAIN'] pour un visa Master) */
  roleKeys?: string[];
}

export interface ReviewCircuitRule {
  id: string;
  label: string;
  match: {
    requesterRoles?: string[];
    categories?: string[];
    priorities?: PrPriority[];
    departmentIds?: string[];
    vesselIds?: string[];
  };
  steps: ReviewStepDef[];
}

export interface AppliedReviewStep extends ReviewStepDef {
  status: 'PENDING' | 'DONE';
  actorId: string | null;
  actorName: string | null;
  at: string | null;
  comment: string | null;
}

export interface AppliedReviewCircuit {
  ruleId: string;
  label: string;
  captainApprovalRequired: boolean;
  evaluatedAt: string;
  facts: { requesterRoles: string[]; category: string; priority: PrPriority; departmentId: string | null };
  steps: AppliedReviewStep[];
}

const PURCHASING_APPROVAL_STEP: ReviewStepDef = {
  key: 'PURCHASING_APPROVAL',
  label: 'Revue et approbation Purchasing',
  permission: 'pr.approve',
};

/**
 * Règles par défaut (évaluées dans l'ordre, la première qui correspond s'applique).
 * PUR-01 / V1 §8.2 « VALIDÉ » : une PR du Chief Engineer ne requiert PAS le visa du Captain.
 * Aucune règle par défaut n'impose de visa Captain ; un circuit avec visa se configure ainsi :
 *   { id: 'URGENT_CAPTAIN', label: '…', match: { priorities: ['URGENT'] },
 *     steps: [{ key: 'CAPTAIN_ENDORSEMENT', label: 'Visa Master', permission: 'pr.submit', roleKeys: ['CAPTAIN'] },
 *             { key: 'PURCHASING_APPROVAL', label: 'Approbation Purchasing', permission: 'pr.approve' }] }
 * (PUT /api/v1/purchasing/config/review-circuits, permission settings.manage).
 */
export const DEFAULT_REVIEW_CIRCUITS: ReviewCircuitRule[] = [
  {
    id: 'CHIEF_ENGINEER',
    label: 'PR Chief Engineer — revue Purchasing, sans visa Captain systématique (PUR-01)',
    match: { requesterRoles: ['CHIEF_ENGINEER'] },
    steps: [PURCHASING_APPROVAL_STEP],
  },
  {
    id: 'DEFAULT',
    label: 'Circuit par défaut — revue et approbation Purchasing',
    match: {},
    steps: [PURCHASING_APPROVAL_STEP],
  },
];

function norm(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
}

export function ruleMatches(
  rule: ReviewCircuitRule,
  facts: { requesterRoles: string[]; category: string; priority: PrPriority; departmentId: string | null; vesselId: string },
): boolean {
  const m = rule.match ?? {};
  if (m.requesterRoles?.length && !m.requesterRoles.some((r) => facts.requesterRoles.includes(r))) return false;
  if (m.categories?.length && !m.categories.some((c) => norm(c) === norm(facts.category))) return false;
  if (m.priorities?.length && !m.priorities.includes(facts.priority)) return false;
  if (m.departmentIds?.length && (!facts.departmentId || !m.departmentIds.includes(facts.departmentId))) return false;
  if (m.vesselIds?.length && !m.vesselIds.includes(facts.vesselId)) return false;
  return true;
}

/** Applique la première règle correspondante ; repli sur un circuit Purchasing seul. */
export function resolveReviewCircuit(
  rules: ReviewCircuitRule[],
  facts: { requesterRoles: string[]; category: string; priority: PrPriority; departmentId: string | null; vesselId: string },
  now = new Date(),
): AppliedReviewCircuit {
  const rule = rules.find((r) => ruleMatches(r, facts)) ?? DEFAULT_REVIEW_CIRCUITS[DEFAULT_REVIEW_CIRCUITS.length - 1];
  return {
    ruleId: rule.id,
    label: rule.label,
    captainApprovalRequired: rule.steps.some((s) => s.roleKeys?.includes('CAPTAIN')),
    evaluatedAt: now.toISOString(),
    facts: { requesterRoles: facts.requesterRoles, category: facts.category, priority: facts.priority, departmentId: facts.departmentId },
    steps: rule.steps.map((s) => ({ ...s, status: 'PENDING', actorId: null, actorName: null, at: null, comment: null })),
  };
}

/** Valide une liste de règles (dernière étape = approbation Purchasing 'pr.approve'). */
export function validateReviewRules(rules: ReviewCircuitRule[], knownPermissions: string[]): void {
  if (!rules.length) throw Errors.validation('Au moins une règle de circuit est requise');
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) throw Errors.validation(`Identifiant de règle dupliqué : ${r.id}`);
    ids.add(r.id);
    if (!r.steps.length) throw Errors.validation(`Règle ${r.id} : au moins une étape`);
    const last = r.steps[r.steps.length - 1];
    if (last.permission !== 'pr.approve') throw Errors.validation(`Règle ${r.id} : la dernière étape doit exiger pr.approve`);
    for (const s of r.steps) {
      if (!knownPermissions.includes(s.permission)) throw Errors.validation(`Règle ${r.id} : permission inconnue ${s.permission}`);
    }
  }
}

// =============================================================================
// Rapprochement facture (CDC §6.7 — PUR-07 : la facture ne clôt jamais un BC)
// =============================================================================

export interface InvoiceOrderFacts {
  poId: string;
  currency: string;
  orderedTotal: DecInput;
  /** Valeur reçue/acceptée estimée (biens acceptés × PU + frais au prorata) */
  receivedValue: DecInput;
  /** Cumul facturé sur ce BC (toutes factures non annulées, y compris celle-ci) */
  invoicedCumulative: DecInput;
}

export interface InvoiceMatchResult {
  suggestion: 'MATCHED' | 'DISPUTED';
  reasons: ('CURRENCY_MISMATCH' | 'EXCEEDS_ORDERED' | 'EXCEEDS_RECEIVED' | 'NO_ORDER')[];
  byCurrency: Record<string, { ordered: string; received: string; invoiced: string }>;
}

/** Libellés FR des motifs d'écart (notifications, messages d'erreur — audit UI-02). */
export const INVOICE_MATCH_REASON_LABELS: Record<InvoiceMatchResult['reasons'][number], string> = {
  CURRENCY_MISMATCH: 'devise différente de celle du BC',
  EXCEEDS_ORDERED: 'dépasse le montant commandé',
  EXCEEDS_RECEIVED: 'dépasse la valeur reçue à bord',
  NO_ORDER: 'aucun BC rattaché',
};

export function invoiceMatchReasonsText(reasons: InvoiceMatchResult['reasons']): string {
  return reasons.map((r) => INVOICE_MATCH_REASON_LABELS[r] ?? r).join(', ');
}

export function suggestInvoiceMatch(invoiceCurrency: string, orders: InvoiceOrderFacts[]): InvoiceMatchResult {
  const reasons = new Set<InvoiceMatchResult['reasons'][number]>();
  if (!orders.length) reasons.add('NO_ORDER');
  const by = new Map<string, { ordered: Prisma.Decimal; received: Prisma.Decimal; invoiced: Prisma.Decimal }>();
  for (const o of orders) {
    if (o.currency !== invoiceCurrency) reasons.add('CURRENCY_MISMATCH');
    const cur = by.get(o.currency) ?? { ordered: new Prisma.Decimal(0), received: new Prisma.Decimal(0), invoiced: new Prisma.Decimal(0) };
    cur.ordered = cur.ordered.plus(D(o.orderedTotal));
    cur.received = cur.received.plus(D(o.receivedValue));
    cur.invoiced = cur.invoiced.plus(D(o.invoicedCumulative));
    by.set(o.currency, cur);
  }
  for (const v of by.values()) {
    if (v.invoiced.greaterThan(v.ordered)) reasons.add('EXCEEDS_ORDERED');
    if (v.invoiced.greaterThan(v.received)) reasons.add('EXCEEDS_RECEIVED');
  }
  const byCurrency: InvoiceMatchResult['byCurrency'] = {};
  for (const [k, v] of by) byCurrency[k] = { ordered: fmtMoney(v.ordered), received: fmtMoney(v.received), invoiced: fmtMoney(v.invoiced) };
  return { suggestion: reasons.size ? 'DISPUTED' : 'MATCHED', reasons: [...reasons], byCurrency };
}

/** Valeur reçue d'un BC : biens acceptés × PU, frais (taxes + fret) au prorata ; total exact si tout est reçu. */
export function receivedValue(
  lines: { unitPrice: DecInput; accepted: DecInput; effectiveOrdered: DecInput; remaining: DecInput; status: LineStatus }[],
  po: { subtotal: DecInput; taxAmount: DecInput; freightAmount: DecInput; totalAmount: DecInput },
): Prisma.Decimal {
  const active = lines.filter((l) => l.status !== 'CANCELLED');
  if (active.length && active.every((l) => D(l.remaining).isZero()) && active.some((l) => D(l.accepted).greaterThan(0))) {
    return round2(po.totalAmount);
  }
  const goods = round2(sumD(lines.map((l) => minD(l.accepted, l.effectiveOrdered).times(D(l.unitPrice)))));
  const subtotal = D(po.subtotal);
  if (subtotal.isZero()) return goods;
  const charges = D(po.taxAmount).plus(D(po.freightAmount));
  return round2(goods.plus(charges.times(goods).dividedBy(subtotal)));
}

// =============================================================================
// Idempotence des réceptions (PUR-05)
// =============================================================================

/** En-tête Idempotency-Key : 8 à 128 caractères [A-Za-z0-9._:-] (UUID conseillé). */
export function validateIdempotencyKey(raw: string | string[] | undefined): string {
  const key = Array.isArray(raw) ? raw[0] : raw;
  if (!key) throw Errors.validation('En-tête Idempotency-Key obligatoire pour enregistrer une réception (PUR-05)');
  const k = key.trim();
  if (k.length < 8 || k.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(k)) {
    throw Errors.validation('Idempotency-Key invalide : 8 à 128 caractères parmi A-Z a-z 0-9 . _ : -');
  }
  return k;
}

/** JSON canonique (clés triées) pour comparer deux requêtes portant la même clé d'idempotence. */
export function stableStringify(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (Prisma.Decimal.isDecimal(v)) return JSON.stringify((v as Prisma.Decimal).toString());
  if (v instanceof Date) return JSON.stringify(v.toISOString());
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function requestHash(v: unknown): string {
  return createHash('sha256').update(stableStringify(v)).digest('hex');
}
