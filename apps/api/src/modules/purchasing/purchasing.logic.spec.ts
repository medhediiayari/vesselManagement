import { Prisma } from '@prisma/client';
import { AppError } from '../../common/errors';
import {
  D,
  DEFAULT_REVIEW_CIRCUITS,
  INVOICE_TRANSITIONS,
  PO_TRANSITIONS,
  PR_TRANSITIONS,
  RFQ_TRANSITIONS,
  VARIANCE_TRANSITIONS,
  applyRevisionLine,
  assertOverAllocationAllowed,
  assertReceiptLineConsistent,
  assertTransition,
  canTransition,
  cheapestPerCurrency,
  computeBalance,
  computePoTotals,
  computeQuotationTotals,
  coverage,
  derivePoReceiptStatus,
  derivePrProgressStatus,
  desiredBalanceVariances,
  detectEventVariances,
  diffRevision,
  distributeFifo,
  effectiveQuantity,
  evaluateAllocations,
  invoiceMatchReasonsText,
  isAutoClosable,
  isPoReceivable,
  planSplit,
  splitSuffix,
  planBalanceVariances,
  prDateIssue,
  planRevision,
  prLineBadge,
  receivedValue,
  requestHash,
  resolveReviewCircuit,
  secondApprovalDecision,
  shrinkAllocations,
  suggestInvoiceMatch,
  unallocatedQuantity,
  validateIdempotencyKey,
  validateReviewRules,
} from './purchasing.logic';

const s = (d: Prisma.Decimal) => d.toString();

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (e) {
    return e instanceof AppError ? e.code : 'OTHER';
  }
  return undefined;
}

describe('Rapprochement BC / BL / reçu (PUR-04)', () => {
  it('BC 10, BL 8, reçu 7 => reliquat 3, écart BL vs reçu 1, short-shipped 2', () => {
    const b = computeBalance({ ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 });
    expect(s(b.remaining)).toBe('3');
    expect(s(b.deltaNoteVsReceived)).toBe('1');
    expect(s(b.shortShipped)).toBe('2');
    expect(s(b.shortReceived)).toBe('1');
    expect(s(b.surplus)).toBe('0');
  });

  it('reliquat = max(0, commandé − annulé − accepté) : les rejets restent dus', () => {
    const b = computeBalance({ ordered: 10, cancelled: 0, onNotes: 10, received: 10, accepted: 8, rejected: 2 });
    expect(s(b.remaining)).toBe('2');
    expect(s(b.shortReceived)).toBe('0');
  });

  it('jamais de reliquat négatif ; surplus signalé', () => {
    const b = computeBalance({ ordered: 5, cancelled: 0, onNotes: 7, received: 7, accepted: 7, rejected: 0 });
    expect(s(b.remaining)).toBe('0');
    expect(s(b.surplus)).toBe('2');
  });

  it('annulation partielle prise en compte', () => {
    const b = computeBalance({ ordered: 10, cancelled: 3, onNotes: 0, received: 0, accepted: 0, rejected: 0 });
    expect(s(b.remaining)).toBe('7');
    expect(s(b.effectiveOrdered)).toBe('7');
  });

  it('décimales sans erreur de flottant', () => {
    const b = computeBalance({ ordered: '0.3', cancelled: '0.1', onNotes: 0, received: '0.1', accepted: '0.1', rejected: 0 });
    expect(s(b.remaining)).toBe('0.1');
  });
});

describe('Détection des écarts', () => {
  it('PUR-04 : écarts de solde short-shipped 2 et short-received 1', () => {
    const want = desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 }, { hasDeliveryNotes: true });
    expect(s(want.SHORT_SHIPPED)).toBe('2');
    expect(s(want.SHORT_RECEIVED)).toBe('1');
    expect(s(want.SURPLUS)).toBe('0');
  });

  it('pas de short-received tant que le BL n’est pas réceptionné', () => {
    const pending = desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 8, received: 0, accepted: 0, rejected: 0 }, { hasDeliveryNotes: true, onReceivedNotes: 0 });
    expect(s(pending.SHORT_RECEIVED)).toBe('0');
    expect(s(pending.SHORT_SHIPPED)).toBe('2');
    const done = desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 }, { hasDeliveryNotes: true, onReceivedNotes: 8 });
    expect(s(done.SHORT_RECEIVED)).toBe('1');
  });

  it('pas de short-shipped sans BL enregistré', () => {
    const want = desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 0, received: 4, accepted: 4, rejected: 0 }, { hasDeliveryNotes: false });
    expect(s(want.SHORT_SHIPPED)).toBe('0');
  });

  it('plan : création, mise à jour puis résolution automatique quand le solde est comblé', () => {
    const first = planBalanceVariances([], desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 }, { hasDeliveryNotes: true }));
    expect(first.create.map((c) => [c.type, s(c.quantity)])).toEqual([
      ['SHORT_SHIPPED', '2'],
      ['SHORT_RECEIVED', '1'],
    ]);
    const open = [
      { id: 'v1', type: 'SHORT_SHIPPED' as const, quantity: D(2) },
      { id: 'v2', type: 'SHORT_RECEIVED' as const, quantity: D(1) },
    ];
    // Second BL de 2, réception de 3 => tout est comblé
    const second = planBalanceVariances(open, desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 10, received: 10, accepted: 10, rejected: 0 }, { hasDeliveryNotes: true }));
    expect(second.create).toHaveLength(0);
    expect(second.resolve.map((r) => r.id).sort()).toEqual(['v1', 'v2']);
    const third = planBalanceVariances(open, desiredBalanceVariances({ ordered: 10, cancelled: 0, onNotes: 9, received: 7, accepted: 7, rejected: 0 }, { hasDeliveryNotes: true }));
    expect(third.update.map((u) => [u.id, s(u.quantity)]).sort()).toEqual([
      ['v1', '1'],
      ['v2', '2'],
    ]);
  });

  it('écarts événementiels : avarie, mauvaise référence, rejet', () => {
    expect(detectEventVariances({ poLineId: 'l', qtyReceived: 5, qtyAccepted: 3, qtyRejected: 2, condition: 'DAMAGED' })[0]).toMatchObject({ type: 'DAMAGED' });
    expect(s(detectEventVariances({ poLineId: 'l', qtyReceived: 5, qtyAccepted: 3, qtyRejected: 2, condition: 'DAMAGED' })[0].quantity)).toBe('2');
    expect(detectEventVariances({ poLineId: 'l', qtyReceived: 4, qtyAccepted: 0, qtyRejected: 4, condition: 'WRONG_ITEM' })[0]).toMatchObject({ type: 'WRONG_REFERENCE' });
    expect(detectEventVariances({ poLineId: 'l', qtyReceived: 4, qtyAccepted: 3, qtyRejected: 1, condition: 'GOOD' })[0]).toMatchObject({ type: 'REJECTED' });
    expect(detectEventVariances({ poLineId: 'l', qtyReceived: 4, qtyAccepted: 4, qtyRejected: 0, condition: 'GOOD' })).toHaveLength(0);
  });

  it('reçu = accepté + rejeté (sinon 422)', () => {
    expect(code(() => assertReceiptLineConsistent({ poLineId: 'l', qtyReceived: 7, qtyAccepted: 6, qtyRejected: 0, condition: 'GOOD' }, 'L1'))).toBe('VALIDATION_FAILED');
    expect(code(() => assertReceiptLineConsistent({ poLineId: 'l', qtyReceived: '7.5', qtyAccepted: '7', qtyRejected: '0.5', condition: 'GOOD' }, 'L1'))).toBeUndefined();
  });
});

describe('Allocation PR -> BC (anti-sur-allocation, V1 §9.3)', () => {
  const states = [{ prLineId: 'p1', prNumber: 'ISK-PR-2026-0323', lineNo: 3, effective: D(10), allocated: D(6) }];

  it('capacité = approuvé − annulé − déjà alloué', () => {
    expect(evaluateAllocations(states, [{ prLineId: 'p1', quantity: 4 }])).toHaveLength(0);
    const over = evaluateAllocations(states, [{ prLineId: 'p1', quantity: 5 }]);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ capacity: '4', requested: '5', excess: '1' });
  });

  it('cumule plusieurs lignes BC sur la même ligne PR', () => {
    expect(evaluateAllocations(states, [{ prLineId: 'p1', quantity: 2 }, { prLineId: 'p1', quantity: 3 }])).toHaveLength(1);
  });

  it('dépassement refusé sauf paramètre + motif', () => {
    const over = evaluateAllocations(states, [{ prLineId: 'p1', quantity: 5 }]);
    expect(code(() => assertOverAllocationAllowed(over, false, 'urgence'))).toBe('BUSINESS_RULE');
    expect(code(() => assertOverAllocationAllowed(over, true, ''))).toBe('VALIDATION_FAILED');
    expect(code(() => assertOverAllocationAllowed(over, true, 'Conditionnement fournisseur par 5'))).toBeUndefined();
  });

  it('quantité effective : approuvée sinon demandée, moins annulée', () => {
    expect(s(effectiveQuantity({ quantityRequested: 10, quantityApproved: null, quantityCancelled: 0 }))).toBe('10');
    expect(s(effectiveQuantity({ quantityRequested: 10, quantityApproved: 8, quantityCancelled: 2 }))).toBe('6');
    expect(s(effectiveQuantity({ quantityRequested: 10, quantityApproved: 8, quantityCancelled: 0, status: 'CANCELLED' }))).toBe('0');
  });

  it('PUR-03 : PR divisée en 2 BC / fournisseurs, totaux de quantités cohérents', () => {
    const st = [{ prLineId: 'p1', prNumber: 'PR', lineNo: 1, effective: D(10), allocated: D(0) }];
    expect(evaluateAllocations(st, [{ prLineId: 'p1', quantity: 6 }])).toHaveLength(0);
    const afterFirst = [{ ...st[0], allocated: D(6) }];
    expect(evaluateAllocations(afterFirst, [{ prLineId: 'p1', quantity: 4 }])).toHaveLength(0);
    expect(evaluateAllocations(afterFirst, [{ prLineId: 'p1', quantity: '4.001' }])).toHaveLength(1);
  });

  it('quantité BC = Σ allocations (excédent non alloué détecté)', () => {
    expect(s(unallocatedQuantity(10, [4, 6], 'L1'))).toBe('0');
    expect(s(unallocatedQuantity(1000, [1], 'L1'))).toBe('999');
    expect(code(() => unallocatedQuantity(5, [4, 2], 'L1'))).toBe('VALIDATION_FAILED');
  });

  it('répartition FIFO et réduction des allocations', () => {
    expect(distributeFifo(7, [4, 6]).map(s)).toEqual(['4', '3']);
    expect(distributeFifo(12, [4, 6]).map(s)).toEqual(['4', '6']);
    expect(shrinkAllocations([4, 6], 7).map(s)).toEqual(['4', '3']);
    expect(shrinkAllocations([4, 6], 3).map(s)).toEqual(['3', '0']);
  });
});

describe('Statuts dérivés', () => {
  it('statut BC depuis la vue de solde', () => {
    const line = { status: 'OPEN' as const, ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 };
    expect(derivePoReceiptStatus('SENT', [line])).toBe('PARTIALLY_RECEIVED');
    expect(derivePoReceiptStatus('SENT', [{ ...line, received: 10, accepted: 10 }])).toBe('RECEIVED');
    expect(derivePoReceiptStatus('SENT', [{ ...line, received: 0, accepted: 0 }])).toBe('SENT');
    expect(derivePoReceiptStatus('DRAFT', [line])).toBe('DRAFT');
    // reliquat annulé par avenant => reçu
    expect(derivePoReceiptStatus('PARTIALLY_RECEIVED', [{ ...line, cancelled: 3 }])).toBe('RECEIVED');
  });

  it('PUR-07 : une facture n’intervient pas — BC partiellement reçu reste PARTIALLY_RECEIVED', () => {
    const line = { status: 'OPEN' as const, ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 };
    const match = suggestInvoiceMatch('EUR', [{ poId: 'po', currency: 'EUR', orderedTotal: 1000, receivedValue: 700, invoicedCumulative: 1000 }]);
    expect(match.suggestion).toBe('DISPUTED');
    expect(match.reasons).toContain('EXCEEDS_RECEIVED');
    expect(derivePoReceiptStatus('PARTIALLY_RECEIVED', [line])).toBe('PARTIALLY_RECEIVED');
  });

  it('badges de ligne PR et statut PR', () => {
    expect(prLineBadge({ status: 'OPEN', effective: 10, ordered: 0, accepted: 0 })).toBe('NOT_ORDERED');
    expect(prLineBadge({ status: 'OPEN', effective: 10, ordered: 6, accepted: 0 })).toBe('PARTIALLY_ORDERED');
    expect(prLineBadge({ status: 'OPEN', effective: 10, ordered: 10, accepted: 7 })).toBe('PARTIALLY_RECEIVED');
    expect(prLineBadge({ status: 'OPEN', effective: 10, ordered: 10, accepted: 10 })).toBe('RECEIVED');
    expect(prLineBadge({ status: 'CANCELLED', effective: 0, ordered: 0, accepted: 0 })).toBe('CANCELLED');

    const l = (ordered: number, accepted: number) => ({ status: 'OPEN' as const, effective: 10, ordered, accepted });
    expect(derivePrProgressStatus([l(0, 0), l(0, 0)], false)).toBe('APPROVED');
    expect(derivePrProgressStatus([l(0, 0)], true)).toBe('SOURCING');
    expect(derivePrProgressStatus([l(10, 0), l(0, 0)], true)).toBe('PARTIALLY_ORDERED');
    expect(derivePrProgressStatus([l(10, 0), l(10, 0)], false)).toBe('ORDERED');
    expect(derivePrProgressStatus([l(10, 7), l(10, 0)], false)).toBe('PARTIALLY_RECEIVED');
    expect(derivePrProgressStatus([l(10, 10), { status: 'CANCELLED', effective: 0, ordered: 0, accepted: 0 }], false)).toBe('RECEIVED');
    expect(derivePrProgressStatus([{ status: 'CANCELLED', effective: 0, ordered: 0, accepted: 0 }], false)).toBeNull();
  });
});

describe('Tables de transitions (CDC §12)', () => {
  it('PR', () => {
    expect(canTransition(PR_TRANSITIONS, 'DRAFT', 'SUBMITTED')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'DRAFT', 'APPROVED')).toBe(false);
    expect(canTransition(PR_TRANSITIONS, 'SUBMITTED', 'UNDER_REVIEW')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'UNDER_REVIEW', 'REVISED')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'APPROVED', 'SOURCING')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'CLOSED', 'APPROVED')).toBe(false);
    expect(canTransition(PR_TRANSITIONS, 'REJECTED', 'SUBMITTED')).toBe(false);
    expect(code(() => assertTransition(PR_TRANSITIONS, 'APPROVED', 'APPROVED', 'PR'))).toBe('ALREADY_PROCESSED');
    expect(code(() => assertTransition(PR_TRANSITIONS, 'DRAFT', 'APPROVED', 'PR'))).toBe('INVALID_STATE');
  });

  it('RFQ', () => {
    expect(canTransition(RFQ_TRANSITIONS, 'DRAFT', 'ISSUED')).toBe(true);
    expect(canTransition(RFQ_TRANSITIONS, 'ISSUED', 'QUOTED')).toBe(true);
    expect(canTransition(RFQ_TRANSITIONS, 'QUOTED', 'EVALUATED')).toBe(true);
    expect(canTransition(RFQ_TRANSITIONS, 'EVALUATED', 'CLOSED')).toBe(true);
    expect(canTransition(RFQ_TRANSITIONS, 'DRAFT', 'EVALUATED')).toBe(false);
    expect(canTransition(RFQ_TRANSITIONS, 'CANCELLED', 'ISSUED')).toBe(false);
  });

  it('BC', () => {
    expect(canTransition(PO_TRANSITIONS, 'DRAFT', 'APPROVAL_PENDING')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'DRAFT', 'SENT')).toBe(false);
    expect(canTransition(PO_TRANSITIONS, 'APPROVAL_PENDING', 'APPROVED')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'APPROVED', 'SENT')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'SENT', 'PARTIALLY_RECEIVED')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'PARTIALLY_RECEIVED', 'CANCELLED')).toBe(false);
    expect(canTransition(PO_TRANSITIONS, 'CLOSED', 'SENT')).toBe(false);
    // Avenant à la hausse d'un BC transmis : retour en second regard (pas de retour en brouillon)
    expect(canTransition(PO_TRANSITIONS, 'SENT', 'APPROVAL_PENDING')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'PARTIALLY_RECEIVED', 'APPROVAL_PENDING')).toBe(true);
    expect(canTransition(PO_TRANSITIONS, 'SENT', 'DRAFT')).toBe(false);
  });

  it('BC transmis reste réceptionnable pendant le second regard d’un avenant', () => {
    expect(isPoReceivable({ status: 'SENT', sentAt: null })).toBe(true);
    expect(isPoReceivable({ status: 'APPROVAL_PENDING', sentAt: new Date() })).toBe(true);
    expect(isPoReceivable({ status: 'APPROVAL_PENDING', sentAt: null })).toBe(false);
    expect(isPoReceivable({ status: 'APPROVED', sentAt: null })).toBe(false);
    expect(isPoReceivable({ status: 'CLOSED', sentAt: new Date() })).toBe(false);
    expect(derivePoReceiptStatus('APPROVAL_PENDING', [{ status: 'OPEN', ordered: 10, cancelled: 0, onNotes: 8, received: 7, accepted: 7, rejected: 0 }])).toBe('APPROVAL_PENDING');
  });

  it('écarts et factures', () => {
    expect(canTransition(VARIANCE_TRANSITIONS, 'OPEN', 'IN_PROGRESS')).toBe(true);
    expect(canTransition(VARIANCE_TRANSITIONS, 'OPEN', 'CLOSED')).toBe(false);
    expect(canTransition(VARIANCE_TRANSITIONS, 'RESOLVED', 'CLOSED')).toBe(true);
    expect(canTransition(INVOICE_TRANSITIONS, 'RECEIVED', 'MATCHED')).toBe(true);
    expect(canTransition(INVOICE_TRANSITIONS, 'APPROVED', 'CANCELLED')).toBe(false);
  });
});

describe('Counter-PR (PUR-02)', () => {
  const current = [
    { id: 'a', lineNo: 1, designation: 'Lampe torche', reference: null, unit: 'pcs', quantityRequested: D(3), quantityApproved: null, quantityCancelled: D(0), status: 'OPEN' as const, allocated: D(0) },
    { id: 'b', lineNo: 2, designation: 'Baladeuse', reference: null, unit: 'pcs', quantityRequested: D(2), quantityApproved: null, quantityCancelled: D(0), status: 'OPEN' as const, allocated: D(0) },
    { id: 'c', lineNo: 3, designation: 'Courroie', reference: '22 x 1650 Li', unit: 'pcs', quantityRequested: D(10), quantityApproved: D(10), quantityCancelled: D(0), status: 'OPEN' as const, allocated: D(4) },
  ];

  it('snapshot complet : lignes non citées conservées (KEEP), ADD/CHANGE/REMOVE', () => {
    const plan = planRevision(current, [
      { action: 'CHANGE', prLineId: 'a', quantity: '5' },
      { action: 'REMOVE', prLineId: 'b' },
      { action: 'ADD', designation: 'Antigel', unit: 'L', quantity: '20' },
    ]);
    expect(plan.changes).toBe(3);
    expect(plan.lines.map((l) => [l.action, l.prLineId, s(l.quantity)])).toEqual([
      ['CHANGE', 'a', '5'],
      ['REMOVE', 'b', '0'],
      ['KEEP', 'c', '10'],
      ['ADD', null, '20'],
    ]);
  });

  it('refuse une quantité révisée inférieure au déjà commandé et une révision vide', () => {
    expect(code(() => planRevision(current, [{ action: 'CHANGE', prLineId: 'c', quantity: '3' }]))).toBe('BUSINESS_RULE');
    expect(code(() => planRevision(current, [{ action: 'KEEP', prLineId: 'a' }]))).toBe('VALIDATION_FAILED');
    expect(code(() => planRevision(current, [{ action: 'CHANGE', prLineId: 'zzz', quantity: 1 }]))).toBe('VALIDATION_FAILED');
  });

  it('acceptation : quantités de travail modifiées, quantité demandée intacte', () => {
    const op = applyRevisionLine(current[0], 'CHANGE', '5')!;
    expect(s(op.quantityApproved)).toBe('5');
    expect(op.status).toBe('OPEN');
    const rm = applyRevisionLine(current[2], 'REMOVE', 4)!;
    expect(s(rm.quantityCancelled)).toBe('6');
    expect(rm.status).toBe('OPEN');
    const rm2 = applyRevisionLine(current[1], 'REMOVE', 0)!;
    expect(rm2.status).toBe('CANCELLED');
    expect(s(rm2.quantityCancelled)).toBe('2');
    expect(applyRevisionLine(current[0], 'KEEP', 3)).toBeNull();
  });

  it('diff original vs révision visible', () => {
    const plan = planRevision(current, [{ action: 'CHANGE', prLineId: 'a', quantity: '5' }, { action: 'ADD', designation: 'Antigel', unit: 'L', quantity: 20 }]);
    const diff = diffRevision(current, plan.lines);
    expect(diff[0]).toMatchObject({ action: 'CHANGE', lineNo: 1, quantityDelta: '2', original: { quantityRequested: '3' } });
    expect(diff.find((d) => d.action === 'ADD')).toMatchObject({ original: null, quantityDelta: '20' });
  });
});

describe('Devis et comparaison sans FX (CDC §6.5)', () => {
  it('totaux du devis', () => {
    const t = computeQuotationTotals(
      [
        { isAvailable: true, quantityOffered: '3', unitPrice: '12.3456' },
        { isAvailable: false, quantityOffered: '2', unitPrice: '5' },
      ],
      { freight: '10', tax: '2.5', discount: '1' },
    );
    expect(t.lineTotals.map((x) => x?.toString() ?? null)).toEqual(['37.04', null]);
    expect(s(t.subtotal)).toBe('37.04');
    expect(s(t.total)).toBe('48.54');
  });

  it('moins cher par ligne au sein d’une même devise uniquement', () => {
    const cheapest = cheapestPerCurrency([
      { quotationLineId: 'eur1', currency: 'EUR', isAvailable: true, unitPrice: '10', compliance: 'COMPLIANT' },
      { quotationLineId: 'eur2', currency: 'EUR', isAvailable: true, unitPrice: '9', compliance: 'COMPLIANT' },
      { quotationLineId: 'eur3', currency: 'EUR', isAvailable: true, unitPrice: '5', compliance: 'NON_COMPLIANT' },
      { quotationLineId: 'tnd1', currency: 'TND', isAvailable: true, unitPrice: '30', compliance: 'COMPLIANT' },
    ]);
    expect([...cheapest].sort()).toEqual(['eur2', 'tnd1']);
  });

  it('couverture', () => {
    const c = coverage(
      [
        { id: 'r1', quantity: 10 },
        { id: 'r2', quantity: 2 },
        { id: 'r3', quantity: 1 },
      ],
      [
        { rfqLineId: 'r1', isAvailable: true, unitPrice: 1, quantityOffered: 8 },
        { rfqLineId: 'r2', isAvailable: true, unitPrice: 1, quantityOffered: 2 },
        { rfqLineId: 'r3', isAvailable: false, unitPrice: null, quantityOffered: null },
      ],
    );
    expect(c).toMatchObject({ quotedLines: 2, fullyCoveredLines: 1, percent: '66.7', fullPercent: '33.3' });
  });
});

describe('Totaux et second regard BC (seuils non pré-remplis)', () => {
  it('totaux BC avec annulation', () => {
    const t = computePoTotals(
      [
        { quantityOrdered: 10, quantityCancelled: 0, unitPrice: '2.5' },
        { quantityOrdered: 4, quantityCancelled: 1, unitPrice: '10' },
        { quantityOrdered: 1, quantityCancelled: 0, unitPrice: '99', status: 'CANCELLED' },
      ],
      { tax: '1.10', freight: '5' },
    );
    expect(s(t.subtotal)).toBe('55');
    expect(s(t.total)).toBe('61.1');
  });

  it('sans seuil configuré : pas de second regard (aucun seuil inventé)', () => {
    expect(secondApprovalDecision(1_000_000, 'EUR', [], 'THRESHOLD_ONLY')).toMatchObject({ required: false, reason: 'NO_THRESHOLD_CONFIGURED' });
  });

  it('seuil par devise, sans conversion', () => {
    const th = [{ currency: 'EUR', amount: '5000', requiresSecondApproval: true, isActive: true }];
    expect(secondApprovalDecision('5000', 'EUR', th, 'THRESHOLD_ONLY').required).toBe(true);
    expect(secondApprovalDecision('4999.99', 'EUR', th, 'THRESHOLD_ONLY').required).toBe(false);
    // Fail-closed : seuils paramétrés mais pas pour cette devise => second regard (pas de contournement par la devise)
    expect(secondApprovalDecision('900000', 'TND', th, 'THRESHOLD_ONLY')).toMatchObject({ required: true, reason: 'NO_THRESHOLD_FOR_CURRENCY' });
    expect(secondApprovalDecision('1', 'ZZZ', th, 'THRESHOLD_ONLY').required).toBe(true);
    expect(secondApprovalDecision('900000', 'TND', [{ ...th[0], isActive: false }], 'THRESHOLD_ONLY')).toMatchObject({ required: false, reason: 'NO_THRESHOLD_CONFIGURED' });
    expect(secondApprovalDecision('1', 'TND', th, 'ALWAYS').required).toBe(true);
    expect(secondApprovalDecision('1', 'EUR', th, 'THRESHOLD_ONLY', true)).toMatchObject({ required: true, reason: 'OVER_ALLOCATION' });
  });
});

describe('Circuit de revue PR (PUR-01)', () => {
  const facts = { requesterRoles: ['CHIEF_ENGINEER'], category: 'Consommable machine', priority: 'NORMAL' as const, departmentId: null, vesselId: 'v' };

  it('PR Chief Engineer : pas de visa Captain par défaut', () => {
    const c = resolveReviewCircuit(DEFAULT_REVIEW_CIRCUITS, facts);
    expect(c.ruleId).toBe('CHIEF_ENGINEER');
    expect(c.captainApprovalRequired).toBe(false);
    expect(c.steps.map((x) => x.key)).toEqual(['PURCHASING_APPROVAL']);
  });

  it('règle configurable avec visa Master (catégorie, insensible aux accents)', () => {
    const rules = [
      {
        id: 'SAFETY',
        label: 'Sécurité',
        match: { categories: ['Equipement sécurité'] },
        steps: [
          { key: 'CAPTAIN_ENDORSEMENT', label: 'Visa Master', permission: 'pr.submit', roleKeys: ['CAPTAIN'] },
          { key: 'PURCHASING_APPROVAL', label: 'Purchasing', permission: 'pr.approve' },
        ],
      },
      ...DEFAULT_REVIEW_CIRCUITS,
    ];
    const c = resolveReviewCircuit(rules, { ...facts, category: 'ÉQUIPEMENT SECURITE' });
    expect(c.ruleId).toBe('SAFETY');
    expect(c.captainApprovalRequired).toBe(true);
    expect(resolveReviewCircuit(rules, { ...facts, requesterRoles: ['CAPTAIN'] }).ruleId).toBe('DEFAULT');
  });

  it('validation des règles', () => {
    expect(code(() => validateReviewRules([{ id: 'X', label: 'x', match: {}, steps: [{ key: 'S', label: 's', permission: 'pr.submit' }] }], ['pr.submit', 'pr.approve']))).toBe(
      'VALIDATION_FAILED',
    );
    expect(code(() => validateReviewRules(DEFAULT_REVIEW_CIRCUITS, ['pr.approve']))).toBeUndefined();
  });
});

describe('Rapprochement facture', () => {
  it('MATCHED si facturé ≤ commandé et ≤ reçu dans la même devise', () => {
    expect(suggestInvoiceMatch('EUR', [{ poId: 'p', currency: 'EUR', orderedTotal: 100, receivedValue: 100, invoicedCumulative: 100 }]).suggestion).toBe('MATCHED');
    const r = suggestInvoiceMatch('USD', [{ poId: 'p', currency: 'EUR', orderedTotal: 100, receivedValue: 100, invoicedCumulative: 100 }]);
    expect(r.reasons).toContain('CURRENCY_MISMATCH');
  });

  it('motifs d’écart libellés en français (UI-02)', () => {
    const r = suggestInvoiceMatch('EUR', [{ poId: 'p', currency: 'EUR', orderedTotal: 100, receivedValue: 50, invoicedCumulative: 120 }]);
    expect(invoiceMatchReasonsText(r.reasons)).toBe('dépasse le montant commandé, dépasse la valeur reçue à bord');
  });

  it('valeur reçue au prorata, exacte si tout est reçu', () => {
    const po = { subtotal: 100, taxAmount: 10, freightAmount: 10, totalAmount: 120 };
    expect(s(receivedValue([{ unitPrice: 10, accepted: 7, effectiveOrdered: 10, remaining: 3, status: 'OPEN' }], po))).toBe('84');
    expect(s(receivedValue([{ unitPrice: 10, accepted: 10, effectiveOrdered: 10, remaining: 0, status: 'OPEN' }], po))).toBe('120');
  });
});

describe('Idempotence (PUR-05)', () => {
  it('clé validée', () => {
    expect(validateIdempotencyKey('rcpt-2026-0001')).toBe('rcpt-2026-0001');
    expect(code(() => validateIdempotencyKey(undefined))).toBe('VALIDATION_FAILED');
    expect(code(() => validateIdempotencyKey('short'))).toBe('VALIDATION_FAILED');
    expect(code(() => validateIdempotencyKey('a'.repeat(129)))).toBe('VALIDATION_FAILED');
    expect(code(() => validateIdempotencyKey('bad key with spaces'))).toBe('VALIDATION_FAILED');
  });

  it('empreinte indépendante de l’ordre des clés', () => {
    expect(requestHash({ a: 1, b: [{ x: '2', y: null }] })).toBe(requestHash({ b: [{ y: null, x: '2' }], a: 1 }));
    expect(requestHash({ a: 1 })).not.toBe(requestHash({ a: 2 }));
  });
});

describe('Dates d’en-tête d’une PR', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const today = day('2026-10-21');

  it('accepte une demande du jour, passée (saisie a posteriori) ou du lendemain (navire à l’est de UTC)', () => {
    expect(prDateIssue(today, null, today)).toBeNull();
    expect(prDateIssue(day('2026-02-03'), day('2026-02-20'), today)).toBeNull();
    expect(prDateIssue(day('2026-10-22'), null, today)).toBeNull();
  });

  it('refuse une demande au-delà du lendemain', () => {
    expect(prDateIssue(day('2026-10-23'), null, today)?.field).toBe('requestDate');
  });

  it('besoin le jour même accepté, besoin antérieur à la demande refusé', () => {
    expect(prDateIssue(today, today, today)).toBeNull();
    expect(prDateIssue(today, day('2026-10-20'), today)).toEqual({ field: 'neededBy', message: 'La date de besoin ne peut pas précéder la date de la demande' });
  });
});

describe('Division en sous-PR (refonte 22/10/2026)', () => {
  const line = (id: string, lineNo: number, extra: Partial<{ status: 'OPEN' | 'CANCELLED'; quantityApproved: string | null; quantityCancelled: string }> = {}) => ({
    id,
    lineNo,
    status: extra.status ?? ('OPEN' as const),
    quantityRequested: '4',
    quantityApproved: extra.quantityApproved ?? null,
    quantityCancelled: extra.quantityCancelled ?? '0',
  });
  const lines = [line('a', 1), line('b', 2), line('c', 3)];

  it('suffixes A, B… et au plus 26 sous-PR', () => {
    expect(splitSuffix(0)).toBe('A');
    expect(splitSuffix(1)).toBe('B');
    expect(splitSuffix(25)).toBe('Z');
    expect(code(() => splitSuffix(26))).toBe('VALIDATION_FAILED');
  });

  it('répartit des lignes entières, dans l’ordre d’origine, en ignorant les groupes vides', () => {
    const plan = planSplit(lines, [{ lineIds: ['c', 'a'], label: ' Fournisseur X ' }, { lineIds: [] }, { lineIds: ['b'] }]);
    expect(plan.map((g) => g.suffix)).toEqual(['A', 'B']);
    expect(plan[0].label).toBe('Fournisseur X');
    expect(plan[0].lines.map((l) => l.lineNo)).toEqual([1, 3]);
    expect(plan[1].lines[0].effective.toString()).toBe('4');
  });

  it('exige au moins deux sous-PR non vides', () => {
    expect(code(() => planSplit(lines, [{ lineIds: ['a', 'b', 'c'] }, { lineIds: [] }]))).toBe('VALIDATION_FAILED');
  });

  it('refuse une ligne affectée deux fois ou une ligne oubliée', () => {
    expect(code(() => planSplit(lines, [{ lineIds: ['a', 'b'] }, { lineIds: ['b', 'c'] }]))).toBe('VALIDATION_FAILED');
    expect(code(() => planSplit(lines, [{ lineIds: ['a'] }, { lineIds: ['b'] }]))).toBe('VALIDATION_FAILED');
    expect(code(() => planSplit(lines, [{ lineIds: ['a'] }, { lineIds: ['zz', 'b', 'c'] }]))).toBe('VALIDATION_FAILED');
  });

  it('les lignes annulées (counter-PR) restent sur la PR mère', () => {
    const withCancelled = [...lines, line('d', 4, { status: 'CANCELLED' }), line('e', 5, { quantityApproved: '4', quantityCancelled: '4' })];
    expect(planSplit(withCancelled, [{ lineIds: ['a'] }, { lineIds: ['b', 'c'] }])).toHaveLength(2);
    expect(code(() => planSplit(withCancelled, [{ lineIds: ['a', 'd'] }, { lineIds: ['b', 'c'] }]))).toBe('BUSINESS_RULE');
  });

  it('quantité de la sous-PR = quantité de travail après counter-PR', () => {
    const plan = planSplit([line('a', 1, { quantityApproved: '6' }), line('b', 2)], [{ lineIds: ['a'] }, { lineIds: ['b'] }]);
    expect(plan[0].lines[0].effective.toString()).toBe('6');
  });

  it('transitions : division depuis la discussion ou une PR validée, PR mère clôturée ensuite', () => {
    expect(canTransition(PR_TRANSITIONS, 'UNDER_REVIEW', 'SPLIT')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'SUBMITTED', 'SPLIT')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'APPROVED', 'SPLIT')).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'ORDERED', 'SPLIT')).toBe(false);
    expect(PR_TRANSITIONS.SPLIT).toEqual(['CLOSED']);
  });

  it('PR en attente reprise au statut dérivé, même commandée ou reçue pendant l’attente (ACH-02)', () => {
    for (const to of ['ORDERED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'] as const) expect(canTransition(PR_TRANSITIONS, 'ON_HOLD', to)).toBe(true);
    expect(canTransition(PR_TRANSITIONS, 'ON_HOLD', 'SPLIT')).toBe(false);
  });
});

describe('Clôture automatique (tout reçu, aucun écart)', () => {
  it('seulement si tout est reçu et qu’aucun écart n’est ouvert', () => {
    expect(isAutoClosable({ status: 'RECEIVED', openVariances: 0 })).toBe(true);
    expect(isAutoClosable({ status: 'RECEIVED', openVariances: 1 })).toBe(false);
    expect(isAutoClosable({ status: 'PARTIALLY_RECEIVED', openVariances: 0 })).toBe(false);
  });
});

describe('Counter-PR directe : modification d’en-tête seule', () => {
  it('admise sans changement de ligne quand allowNoLineChange', () => {
    const cur = [{ id: 'a', lineNo: 1, designation: 'Filtre', reference: null, unit: 'pcs', quantityRequested: '2', quantityApproved: null, quantityCancelled: '0', status: 'OPEN' as const, allocated: '0' }];
    expect(code(() => planRevision(cur, []))).toBe('VALIDATION_FAILED');
    expect(planRevision(cur, [], { allowNoLineChange: true }).changes).toBe(0);
  });
});
