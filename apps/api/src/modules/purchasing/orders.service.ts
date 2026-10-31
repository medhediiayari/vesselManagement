import { Injectable, Logger } from '@nestjs/common';
import { LineStatus, PoStatus, Prisma, PurchaseOrder } from '@prisma/client';
import { Errors } from '../../common/errors';
import { env } from '../../config/env';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, canAccessVessel, vesselWhere } from '../access/auth-context';
import { NumberingService } from '../documents/numbering.service';
import { FilesService } from '../files/files.service';
import { EmailService } from '../notifications/email.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  ListOrdersFilters,
  MarkOrderSentDto,
  OrderBody,
  OrderCloseDto,
  OrderReasonDto,
  OrderRejectDto,
  OrderVersionDto,
  PoLineInput,
  ReplaceOrderDto,
  ReviseOrderInput,
} from './orders.dto';
import { PurchasingConfigService } from './purchasing-config.service';
import { PurchasingCore } from './purchasing-core.service';
import { PurchasingDocuments } from './purchasing-documents.service';
import { LINKS } from './purchasing.constants';
import { escapeLike } from '../../common/utils/like';
import {
  D,
  OverAllocation,
  PoApprovalMode,
  ThresholdRow,
  PO_RECEIVABLE_STATUSES,
  PO_TRANSITIONS,
  isPoReceivable,
  assertTransition,
  computeBalance,
  computePoTotals,
  fmtQty,
  max0,
  poLineTotal,
  secondApprovalDecision,
  shrinkAllocations,
  sumD,
  unallocatedQuantity,
} from './purchasing.logic';

interface ResolvedLine {
  lineNo: number;
  designation: string;
  reference: string | null;
  unit: string;
  quantityOrdered: Prisma.Decimal;
  unitPrice: Prisma.Decimal;
  quotationLineId: string | null;
  quotationId: string | null;
  quotationCurrency: string | null;
  /** Navire de la RFQ d'origine (ligne de devis) — doit égaler le navire du BC */
  rfqVesselId: string | null;
  remarks: string | null;
  allocations: { prLineId: string; quantity: Prisma.Decimal }[];
  /** Quantité commandée non couverte par les allocations PR (0 attendu) */
  unallocated: Prisma.Decimal;
}

function mergeAllocations(list: { prLineId: string; quantity: Prisma.Decimal.Value }[]) {
  const m = new Map<string, Prisma.Decimal>();
  for (const a of list) m.set(a.prLineId, (m.get(a.prLineId) ?? new Prisma.Decimal(0)).plus(D(a.quantity)));
  return [...m.entries()].map(([prLineId, quantity]) => ({ prLineId, quantity }));
}

const CONTRACTUAL: PoStatus[] = ['SENT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED'];

/**
 * Bons de commande — BC = OC = Purchase Order, un seul type (CDC §6.6, §16.2).
 * Refonte du 22/10/2026 : « Émettre » (issue) enchaîne contrôle, validation et émission en un clic — le BC émis
 * (statut SENT) est transmis au créateur de la PR (notification + e-mail avec le PDF : fournisseur, livraison,
 * port) ; l'acheteur contacte le fournisseur lui-même. Le second
 * regard n'intervient que si un seuil configuré l'exige ; à son approbation, le BC est émis automatiquement.
 * Aucun e-mail n'est envoyé aux fournisseurs (décision AMC du 23/10/2026) : l'acheteur les contacte lui-même
 * avec le PDF du BC et peut noter cette transmission (markSent, canal MANUAL).
 * Création depuis des lignes de devis sélectionnées ou manuellement depuis des lignes PR, avec allocations
 * n:m explicites contrôlées sous verrou (SELECT … FOR UPDATE, transaction SERIALIZABLE — V1 §9.3).
 * Second regard selon seuil configurable par devise (jamais pré-rempli). Un BC envoyé n'est jamais modifié
 * silencieusement : avenant = PoRevision (snapshot) + nouveau PDF.
 */
@Injectable()
export class OrdersService {
  private readonly logger = new Logger('PurchaseOrders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly access: AccessService,
    private readonly numbering: NumberingService,
    private readonly config: PurchasingConfigService,
    private readonly docs: PurchasingDocuments,
    private readonly files: FilesService,
    private readonly email: EmailService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  buildWhere(ctx: AuthContext, q: Partial<ListOrdersFilters>): Prisma.PurchaseOrderWhereInput {
    const today = new Date();
    const and: Prisma.PurchaseOrderWhereInput[] = [vesselWhere(ctx) as Prisma.PurchaseOrderWhereInput, this.core.poOwnWhere(ctx)];
    if (q.vesselId) and.push({ vesselId: q.vesselId });
    if (q.supplierId) and.push({ supplierId: q.supplierId });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.prId) and.push({ lines: { some: { allocations: { some: { prLine: { prId: q.prId } } } } } });
    if (q.discrepancy) and.push({ variances: { some: { status: 'OPEN' } } });
    if (q.overdue) {
      and.push({
        status: { in: ['SENT', 'PARTIALLY_RECEIVED'] },
        expectedDeliveryDate: { lt: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) },
      });
    }
    if (q.search) {
      and.push({
        OR: [
          { number: { contains: escapeLike(q.search), mode: 'insensitive' } },
          { supplier: { name: { contains: escapeLike(q.search), mode: 'insensitive' } } },
          { lines: { some: { designation: { contains: escapeLike(q.search), mode: 'insensitive' } } } },
        ],
      });
    }
    return { AND: and };
  }

  async list(ctx: AuthContext, q: ListOrdersFilters) {
    const where = this.buildWhere(ctx, q);
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          vessel: { select: { id: true, code: true, name: true } },
          supplier: { select: { id: true, code: true, name: true } },
          _count: { select: { lines: true, variances: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } } } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.purchaseOrder.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    // PR d'origine de chaque BC (via les allocations) : regroupement « par Purchase Request » de la liste
    const allocations = page.items.length
      ? await this.prisma.poLineAllocation.findMany({
          where: { poLine: { poId: { in: page.items.map((p) => p.id) } } },
          select: {
            poLine: { select: { poId: true } },
            prLine: { select: { pr: { select: { id: true, number: true, subject: true, status: true, parent: { select: { number: true } } } } } },
          },
        })
      : [];
    const prsByPo = new Map<string, Map<string, { id: string; number: string; subject: string; status: string; parentNumber: string | null }>>();
    for (const a of allocations) {
      const pr = a.prLine.pr;
      const m = prsByPo.get(a.poLine.poId) ?? new Map();
      m.set(pr.id, { id: pr.id, number: pr.number, subject: pr.subject, status: pr.status, parentNumber: pr.parent?.number ?? null });
      prsByPo.set(a.poLine.poId, m);
    }
    return {
      ...page,
      items: page.items.map((p) => ({ ...p, prs: [...(prsByPo.get(p.id)?.values() ?? [])].sort((x, y) => x.number.localeCompare(y.number)) })),
    };
  }

  async get(ctx: AuthContext, id: string) {
    await this.core.findPo(ctx, id);
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: {
        vessel: { select: { id: true, code: true, name: true } },
        supplier: { include: { contacts: true } },
        quotation: { select: { id: true, reference: true, rfqId: true, currency: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: {
            allocations: {
              orderBy: { createdAt: 'asc' },
              include: { prLine: { select: { id: true, lineNo: true, designation: true, unit: true, pr: { select: { id: true, number: true, requesterId: true } } } } },
            },
          },
        },
        revisions: { orderBy: { revisionNo: 'desc' }, select: { id: true, revisionNo: true, reason: true, pdfFileId: true, createdById: true, createdAt: true } },
        dispatches: { orderBy: { createdAt: 'desc' } },
      },
    });
    const balances = new Map((await this.core.balancesForPos([id])).map((b) => [b.poLineId, b]));
    const names = await this.core.userNames([po.createdById, po.approvedById, po.secondApprovedById, po.sentById, ...po.revisions.map((r) => r.createdById)]);
    const related: Record<string, unknown> = {};
    if (can(ctx, 'receiving.view')) {
      related.deliveryNotes = await this.prisma.deliveryNote.findMany({ where: { poId: id }, orderBy: { createdAt: 'asc' }, include: { lines: true, extraItems: true } });
      related.receipts = await this.prisma.goodsReceipt.findMany({
        where: { poId: id },
        orderBy: { receivedAt: 'asc' },
        // Remarques par ligne saisies à bord (affichées avec les écarts de réception)
        select: { id: true, number: true, receivedAt: true, status: true, deliveryNoteId: true, lines: { where: { remarks: { not: null } }, select: { poLineId: true, remarks: true } } },
      });
      related.variances = await this.prisma.variance.findMany({ where: { poId: id }, orderBy: { createdAt: 'asc' } });
    }
    if (can(ctx, 'invoice.view')) {
      related.invoices = await this.prisma.invoice.findMany({ where: { orders: { some: { poId: id } } }, select: { id: true, number: true, status: true, currency: true, amount: true, taxAmount: true } });
    }
    return {
      ...po,
      createdByName: names.get(po.createdById) ?? null,
      approvedByName: po.approvedById ? names.get(po.approvedById) ?? null : null,
      secondApprovedByName: po.secondApprovedById ? names.get(po.secondApprovedById) ?? null : null,
      sentByName: po.sentById ? names.get(po.sentById) ?? null : null,
      lines: po.lines.map((l) => {
        const b = balances.get(l.id);
        return {
          ...l,
          balance: b
            ? {
                ordered: fmtQty(b.quantityOrdered),
                cancelled: fmtQty(b.quantityCancelled),
                onDeliveryNotes: fmtQty(b.qtyOnDeliveryNotes),
                physicallyReceived: fmtQty(b.qtyPhysicallyReceived),
                accepted: fmtQty(b.qtyAccepted),
                rejected: fmtQty(b.qtyRejected),
                remaining: fmtQty(b.qtyRemaining),
              }
            : null,
        };
      }),
      revisions: po.revisions.map((r) => ({ ...r, createdByName: names.get(r.createdById) ?? null })),
      attachments: await this.core.attachmentsOf('PURCHASE_ORDER', [id]),
      ...related,
    };
  }

  async history(ctx: AuthContext, id: string) {
    await this.core.findPo(ctx, id);
    return this.prisma.auditEvent.findMany({
      where: { module: 'purchasing', entityType: 'purchase_order', entityId: id },
      orderBy: { occurredAt: 'asc' },
      take: 500,
      select: { id: true, occurredAt: true, actorLabel: true, action: true, before: true, after: true, metadata: true },
    });
  }

  async revisions(ctx: AuthContext, id: string) {
    await this.core.findPo(ctx, id);
    const rows = await this.prisma.poRevision.findMany({ where: { poId: id }, orderBy: { revisionNo: 'desc' } });
    const names = await this.core.userNames(rows.map((r) => r.createdById));
    return rows.map((r) => ({ ...r, createdByName: names.get(r.createdById) ?? null }));
  }

  /**
   * GET /orders/:id/reconciliation — par ligne : Ordered (BC) | Delivery Note (BL) | Physically Received |
   * Accepted | Rejected | Remaining = max(0, ordered − cancelled − accepted) (vue v_po_line_balance, PUR-04).
   * Un BL n'est jamais une preuve de réception physique.
   */
  async reconciliation(ctx: AuthContext, id: string) {
    const po = await this.core.findPo(ctx, id);
    const [balances, lines, variances] = await Promise.all([
      this.core.balancesForPos([id]),
      this.prisma.poLine.findMany({
        where: { poId: id },
        include: { allocations: { include: { prLine: { select: { lineNo: true, pr: { select: { id: true, number: true } } } } } } },
      }),
      this.prisma.variance.findMany({ where: { poId: id, status: { in: ['OPEN', 'IN_PROGRESS'] } }, orderBy: { createdAt: 'asc' } }),
    ]);
    const rows = balances.map((b) => {
      const line = lines.find((l) => l.id === b.poLineId)!;
      const bal = computeBalance({
        ordered: b.quantityOrdered,
        cancelled: b.quantityCancelled,
        onNotes: b.qtyOnDeliveryNotes,
        received: b.qtyPhysicallyReceived,
        accepted: b.qtyAccepted,
        rejected: b.qtyRejected,
      });
      return {
        poLineId: b.poLineId,
        lineNo: b.lineNo,
        designation: b.designation,
        unit: b.unit,
        status: line.status,
        ordered: fmtQty(b.quantityOrdered),
        cancelled: fmtQty(b.quantityCancelled),
        effectiveOrdered: fmtQty(bal.effectiveOrdered),
        onDeliveryNotes: fmtQty(b.qtyOnDeliveryNotes),
        physicallyReceived: fmtQty(b.qtyPhysicallyReceived),
        accepted: fmtQty(b.qtyAccepted),
        rejected: fmtQty(b.qtyRejected),
        remaining: fmtQty(b.qtyRemaining),
        deltaNoteVsReceived: fmtQty(b.deltaNoteVsReceived),
        deltaOrderedVsNote: fmtQty(b.deltaOrderedVsNote),
        shortShipped: fmtQty(bal.shortShipped),
        shortReceived: fmtQty(bal.shortReceived),
        surplus: fmtQty(bal.surplus),
        prAllocations: line.allocations.map((a) => ({ prId: a.prLine.pr.id, prNumber: a.prLine.pr.number, prLineNo: a.prLine.lineNo, quantity: fmtQty(a.quantity) })),
        openVariances: variances.filter((v) => v.poLineId === b.poLineId).map((v) => ({ id: v.id, type: v.type, quantity: fmtQty(v.quantity), status: v.status })),
      };
    });
    return {
      po: { id: po.id, number: po.number, status: po.status, currency: po.currency, vesselId: po.vesselId },
      lines: rows,
      totals: {
        ordered: fmtQty(sumD(balances.map((b) => D(b.quantityOrdered).minus(b.quantityCancelled)))),
        onDeliveryNotes: fmtQty(sumD(balances.map((b) => b.qtyOnDeliveryNotes))),
        physicallyReceived: fmtQty(sumD(balances.map((b) => b.qtyPhysicallyReceived))),
        accepted: fmtQty(sumD(balances.map((b) => b.qtyAccepted))),
        rejected: fmtQty(sumD(balances.map((b) => b.qtyRejected))),
        remaining: fmtQty(sumD(balances.map((b) => b.qtyRemaining))),
      },
      note: 'Un BL (Bon de Livraison) n’est pas une preuve de réception physique : seule la quantité acceptée à bord solde le reliquat.',
    };
  }

  // ---------------------------------------------------------------------------
  // Création / brouillon
  // ---------------------------------------------------------------------------

  /**
   * Résout les lignes saisies (depuis devis sélectionné ou manuelles) — contrôles hors capacité PR.
   * Une ligne de devis n'est utilisable que si son RFQ est dans le scope de l'utilisateur ; ses allocations
   * ne peuvent viser QUE la ligne PR de la ligne RFQ correspondante (pas de détournement vers un autre navire).
   */
  private async resolveLines(
    ctx: AuthContext,
    tx: Tx,
    inputs: PoLineInput[],
    supplierId: string,
    startLineNo: number,
    excludePoId: string | null,
  ): Promise<ResolvedLine[]> {
    const qlIds = inputs.map((l) => l.quotationLineId).filter((x): x is string => !!x);
    const qLines = qlIds.length
      ? await tx.quotationLine.findMany({
          where: { id: { in: qlIds } },
          include: {
            quotation: { select: { id: true, supplierId: true, currency: true, status: true, rfq: { select: { vesselId: true } } } },
            rfqLine: true,
            selections: { where: { withdrawnAt: null }, select: { quantity: true } },
          },
        })
      : [];
    const resolved: ResolvedLine[] = [];
    for (const [i, input] of inputs.entries()) {
      const label = `Ligne ${i + 1}`;
      const qty = D(input.quantity);
      if (input.quotationLineId) {
        const ql = qLines.find((q) => q.id === input.quotationLineId);
        // Message générique : aucune information sur un devis hors périmètre
        if (!ql || !canAccessVessel(ctx, ql.quotation.rfq.vesselId)) throw Errors.validation(`${label} : ligne de devis introuvable`);
        if (ql.quotation.supplierId !== supplierId) throw Errors.validation(`${label} : ligne de devis d’un autre fournisseur`);
        if (ql.quotation.status === 'WITHDRAWN') throw Errors.business(`${label} : devis retiré`);
        const rfqPrLineId = ql.rfqLine.prLineId;
        if (!rfqPrLineId) throw Errors.validation(`${label} : ligne RFQ sans ligne PR d’origine`);
        const selected = sumD(ql.selections.map((s) => s.quantity));
        if (selected.isZero()) throw Errors.business(`${label} : ligne de devis non sélectionnée (sélection quotation.evaluate requise)`);
        const already = await tx.poLine.findMany({
          where: { quotationLineId: ql.id, status: { not: 'CANCELLED' }, po: { status: { not: 'CANCELLED' }, ...(excludePoId ? { id: { not: excludePoId } } : {}) } },
          select: { quantityOrdered: true, quantityCancelled: true },
        });
        const inThisPo = sumD(resolved.filter((r) => r.quotationLineId === ql.id).map((r) => r.quantityOrdered));
        const ordered = sumD(already.map((a) => D(a.quantityOrdered).minus(a.quantityCancelled))).plus(inThisPo);
        if (ordered.plus(qty).greaterThan(selected)) {
          throw Errors.business(`${label} : quantité commandée supérieure à la quantité sélectionnée (${fmtQty(selected)}, déjà commandé ${fmtQty(ordered)})`);
        }
        const price = input.unitPrice ?? ql.unitPrice;
        if (price === null || price === undefined) throw Errors.validation(`${label} : prix unitaire requis`);
        const allocations = input.allocations?.length ? input.allocations : [{ prLineId: rfqPrLineId, quantity: qty.toString() }];
        if (allocations.some((a) => a.prLineId !== rfqPrLineId)) {
          throw Errors.validation(`${label} : une ligne de devis ne s’alloue qu’à la ligne PR de sa ligne RFQ`);
        }
        const merged = mergeAllocations(allocations);
        resolved.push({
          lineNo: startLineNo + i,
          designation: input.designation ?? ql.rfqLine.designation,
          reference: input.reference ?? ql.rfqLine.reference,
          unit: input.unit ?? ql.rfqLine.unit,
          quantityOrdered: qty,
          unitPrice: D(price),
          quotationLineId: ql.id,
          quotationId: ql.quotation.id,
          quotationCurrency: ql.quotation.currency,
          rfqVesselId: ql.quotation.rfq.vesselId,
          remarks: input.remarks ?? ql.remarks ?? null,
          allocations: merged,
          unallocated: unallocatedQuantity(qty, merged.map((a) => a.quantity), label),
        });
      } else {
        if (!input.allocations?.length) throw Errors.validation(`${label} : allocation(s) aux lignes PR obligatoire(s)`);
        if (input.unitPrice === undefined) throw Errors.validation(`${label} : prix unitaire requis`);
        let designation = input.designation;
        let unit = input.unit;
        let reference = input.reference ?? null;
        if (!designation || !unit) {
          const first = await tx.prLine.findUnique({ where: { id: input.allocations[0].prLineId }, include: { pr: { select: { vesselId: true } } } });
          if (!first || !canAccessVessel(ctx, first.pr.vesselId)) throw Errors.validation(`${label} : ligne PR introuvable`);
          designation ??= first.designation;
          unit ??= first.unit;
          reference ??= first.reference;
        }
        const merged = mergeAllocations(input.allocations);
        resolved.push({
          lineNo: startLineNo + i,
          designation,
          reference,
          unit,
          quantityOrdered: qty,
          unitPrice: D(input.unitPrice),
          quotationLineId: null,
          quotationId: null,
          quotationCurrency: null,
          rfqVesselId: null,
          remarks: input.remarks ?? null,
          allocations: merged,
          unallocated: unallocatedQuantity(qty, merged.map((a) => a.quantity), label),
        });
      }
    }
    return resolved;
  }

  /**
   * Σ allocations PR = quantité commandée par ligne (V1 §8.4). Un excédent non alloué n'est admis que par le
   * parcours explicite de sur-allocation (paramètre purchasing.allowOverAllocation + motif) ; il impose alors
   * un second regard. Retourne les numéros de ligne concernés.
   */
  private async assertUnallocated(lines: { lineNo: number; unallocated: Prisma.Decimal }[], reason: string | null | undefined): Promise<number[]> {
    const excess = lines.filter((l) => l.unallocated.greaterThan(0));
    if (!excess.length) return [];
    const details = excess.map((l) => ({ lineNo: l.lineNo, unallocated: fmtQty(l.unallocated) }));
    if (!(await this.settings.get('purchasing.allowOverAllocation'))) {
      throw Errors.business('Quantité commandée non couverte par les allocations PR : Σ allocations doit égaler la quantité de la ligne', { lines: details });
    }
    if (!reason || reason.trim().length < 3) throw Errors.validation('Quantité non allouée aux PR : motif (overAllocationReason) obligatoire', { lines: details });
    return excess.map((l) => l.lineNo);
  }

  /** Les lignes de devis doivent provenir d'une RFQ du navire du BC (pas de fuite de prix inter-navires). */
  private assertQuotationVessel(lines: ResolvedLine[], vesselId: string) {
    if (lines.some((l) => l.rfqVesselId && l.rfqVesselId !== vesselId)) throw Errors.validation('Ligne de devis introuvable pour ce navire');
  }

  /** Navire du BC = navire (unique) des lignes PR allouées ; scope vérifié. */
  private async vesselOf(ctx: AuthContext, tx: Tx, prLineIds: string[]) {
    const lines = await tx.prLine.findMany({ where: { id: { in: [...new Set(prLineIds)] } }, select: { id: true, pr: { select: { vesselId: true } } } });
    const vessels = new Set(lines.map((l) => l.pr.vesselId));
    if (!vessels.size) throw Errors.validation('Lignes PR introuvables');
    if (vessels.size > 1) throw Errors.validation('Un BC couvre des PR d’un seul navire');
    return this.core.vesselForWrite(ctx, [...vessels][0], tx);
  }

  private async header(ctx: AuthContext, tx: Tx, dto: OrderBody, lines: ResolvedLine[], vesselId: string) {
    const supplier = await tx.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw Errors.validation('Fournisseur introuvable');
    if (!supplier.isActive) throw Errors.business(`Fournisseur ${supplier.name} inactif`);
    const quotationIds = [...new Set(lines.map((l) => l.quotationId).filter((x): x is string => !!x))];
    if (dto.quotationId && quotationIds.some((q) => q !== dto.quotationId)) throw Errors.validation('Lignes issues d’un autre devis que quotationId');
    const quotationId = dto.quotationId ?? (quotationIds.length === 1 ? quotationIds[0] : null);
    let quotationCurrency: string | null = null;
    if (quotationId) {
      const q = await tx.quotation.findUnique({ where: { id: quotationId }, select: { supplierId: true, status: true, currency: true, rfq: { select: { vesselId: true } } } });
      if (!q || !canAccessVessel(ctx, q.rfq.vesselId) || q.rfq.vesselId !== vesselId || q.supplierId !== dto.supplierId) {
        throw Errors.validation('Devis introuvable pour ce fournisseur et ce navire');
      }
      if (q.status === 'WITHDRAWN') throw Errors.business('Devis retiré');
      quotationCurrency = q.currency;
    }
    const quotationCurrencies = [...new Set([...lines.map((l) => l.quotationCurrency), quotationCurrency].filter((x): x is string => !!x))];
    if (quotationCurrencies.length > 1) throw Errors.validation('Lignes de devis en devises différentes : un BC = une devise');
    const currency = dto.currency ?? quotationCurrencies[0] ?? supplier.currency;
    if (!currency) throw Errors.validation('Devise du BC requise');
    // BC issu d'un devis : devise du devis imposée (aucune conversion, pas de contournement des seuils par la devise)
    if (quotationCurrencies.length && quotationCurrencies[0] !== currency) {
      throw Errors.validation(`Devise ${currency} différente de celle du devis (${quotationCurrencies[0]}) : aucune conversion n’est appliquée`);
    }
    const totals = computePoTotals(
      lines.map((l) => ({ quantityOrdered: l.quantityOrdered, quantityCancelled: 0, unitPrice: l.unitPrice })),
      { tax: dto.taxAmount, freight: dto.freightAmount },
    );
    return { supplier, quotationId, currency, totals };
  }

  private lineCreate(l: ResolvedLine, total: Prisma.Decimal, over: OverAllocation[], unallocatedLineNos: number[], reason: string | null | undefined) {
    const overIds = new Set(over.map((o) => o.prLineId));
    const flagged = unallocatedLineNos.includes(l.lineNo);
    return {
      lineNo: l.lineNo,
      designation: l.designation,
      reference: l.reference,
      quantityOrdered: l.quantityOrdered,
      unit: l.unit,
      unitPrice: l.unitPrice,
      lineTotal: total,
      quotationLineId: l.quotationLineId,
      remarks: l.remarks,
      allocations: {
        create: l.allocations.map((a) => ({
          prLineId: a.prLineId,
          quantity: a.quantity,
          overAllocationReason: flagged || overIds.has(a.prLineId) ? (reason ?? null) : null,
        })),
      },
    };
  }

  /** Création dans une transaction SERIALIZABLE existante (réutilisée par le BC complémentaire). */
  async createTx(ctx: AuthContext, tx: Tx, dto: OrderBody, origin: Record<string, unknown> = {}) {
    const lines = await this.resolveLines(ctx, tx, dto.lines, dto.supplierId, 1, null);
    const vessel = await this.vesselOf(ctx, tx, lines.flatMap((l) => l.allocations.map((a) => a.prLineId)));
    this.assertQuotationVessel(lines, vessel.id);
    const over = await this.core.lockAndCheckAllocations(
      ctx,
      tx,
      lines.flatMap((l) => l.allocations.map((a) => ({ prLineId: a.prLineId, quantity: a.quantity, poLineUnit: l.unit }))),
      { vesselId: vessel.id, overAllocationReason: dto.overAllocationReason },
    );
    const unallocated = await this.assertUnallocated(lines, dto.overAllocationReason);
    const { quotationId, currency, totals } = await this.header(ctx, tx, dto, lines, vessel.id);
    const number = await this.numbering.nextFormatted('BC', vessel.code, tx);
    const po = await tx.purchaseOrder.create({
      data: {
        number,
        vesselId: vessel.id,
        supplierId: dto.supplierId,
        quotationId,
        currency,
        status: 'DRAFT',
        expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
        deliveryPort: dto.deliveryPort ?? null,
        deliveryTerms: dto.deliveryTerms ?? null,
        paymentTerms: dto.paymentTerms ?? null,
        notes: dto.notes ?? null,
        subtotal: totals.subtotal,
        taxAmount: dto.taxAmount ?? 0,
        freightAmount: dto.freightAmount ?? 0,
        totalAmount: totals.total,
        createdById: ctx.userId,
        lines: { create: lines.map((l, i) => this.lineCreate(l, totals.lineTotals[i], over, unallocated, dto.overAllocationReason)) },
      },
      include: { lines: { include: { allocations: true }, orderBy: { lineNo: 'asc' } } },
    });
    await this.core.audit(
      ctx,
      {
        action: 'po.created',
        entityType: 'purchase_order',
        entityId: po.id,
        vesselId: po.vesselId,
        after: po,
        metadata: { overAllocations: over, unallocatedLines: unallocated, overAllocationReason: dto.overAllocationReason, ...origin },
      },
      tx,
    );
    return po;
  }

  async create(ctx: AuthContext, dto: OrderBody & { issueNow?: boolean }) {
    if (!dto.issueNow) return this.core.serializable((tx) => this.createTx(ctx, tx, dto));
    const [thresholds, mode] = await Promise.all([this.config.thresholds(), this.config.poApprovalMode()]);
    const res = await this.core.serializable(async (tx) => {
      const po = await this.createTx(ctx, tx, dto);
      const { after, decision } = await this.submitTx(ctx, tx, po, { expectedVersion: po.lockVersion }, thresholds, mode);
      if (after.status === 'APPROVED') await this.markIssuedTx(ctx, tx, after.id, 'po.created');
      return { id: po.id, issued: after.status === 'APPROVED', decision };
    });
    if (res.issued) await this.afterIssue(ctx, res.id);
    const order = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: res.id }, include: { lines: { include: { allocations: true }, orderBy: { lineNo: 'asc' } } } });
    return { ...order, issued: res.issued, approvalDecision: res.decision };
  }

  /** PUT /orders/:id — remplacement complet tant que le BC est DRAFT. */
  async replace(ctx: AuthContext, id: string, dto: ReplaceOrderDto) {
    return this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      if (po.status !== 'DRAFT') throw Errors.invalidState('Seul un BC brouillon est modifiable (BC envoyé : révision)');
      const before = await tx.poLine.findMany({ where: { poId: id }, include: { allocations: true } });
      await tx.poLine.deleteMany({ where: { poId: id } });
      const lines = await this.resolveLines(ctx, tx, dto.lines, dto.supplierId, 1, id);
      const vessel = await this.vesselOf(ctx, tx, lines.flatMap((l) => l.allocations.map((a) => a.prLineId)));
      if (vessel.id !== po.vesselId) throw Errors.validation('Le navire d’un BC ne peut pas changer');
      this.assertQuotationVessel(lines, vessel.id);
      const over = await this.core.lockAndCheckAllocations(
        ctx,
        tx,
        lines.flatMap((l) => l.allocations.map((a) => ({ prLineId: a.prLineId, quantity: a.quantity, poLineUnit: l.unit }))),
        { vesselId: vessel.id, overAllocationReason: dto.overAllocationReason },
      );
      const unallocated = await this.assertUnallocated(lines, dto.overAllocationReason);
      const { quotationId, currency, totals } = await this.header(ctx, tx, dto, lines, vessel.id);
      await this.core.bumpPo(tx, po, dto.expectedVersion, {
        supplierId: dto.supplierId,
        quotationId,
        currency,
        expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
        deliveryPort: dto.deliveryPort ?? null,
        deliveryTerms: dto.deliveryTerms ?? null,
        paymentTerms: dto.paymentTerms ?? null,
        notes: dto.notes ?? null,
        subtotal: totals.subtotal,
        taxAmount: dto.taxAmount ?? 0,
        freightAmount: dto.freightAmount ?? 0,
        totalAmount: totals.total,
      });
      for (const [i, l] of lines.entries()) {
        await tx.poLine.create({ data: { poId: id, ...this.lineCreate(l, totals.lineTotals[i], over, unallocated, dto.overAllocationReason) } });
      }
      const after = await tx.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { include: { allocations: true }, orderBy: { lineNo: 'asc' } } } });
      await this.core.audit(ctx, { action: 'po.updated', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, before: { ...po, lines: before }, after }, tx);
      return after;
    });
  }

  // ---------------------------------------------------------------------------
  // Approbation (second regard selon seuil — CHOIX RECOMMANDÉ §6.5)
  // ---------------------------------------------------------------------------

  async submit(ctx: AuthContext, id: string, dto: OrderVersionDto) {
    const [thresholds, mode] = await Promise.all([this.config.thresholds(), this.config.poApprovalMode()]);
    return this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      const { after, decision } = await this.submitTx(ctx, tx, po, dto, thresholds, mode);
      return { ...after, approvalDecision: decision };
    });
  }

  /** Contrôles de soumission (capacité PR sous verrou, allocations) et décision de second regard. */
  private async submitTx(ctx: AuthContext, tx: Tx, po: PurchaseOrder, dto: OrderVersionDto, thresholds: ThresholdRow[], mode: PoApprovalMode) {
    {
      const id = po.id;
      assertTransition(PO_TRANSITIONS, po.status, 'APPROVAL_PENDING', 'Soumission BC');
      const lines = await tx.poLine.findMany({ where: { poId: id }, include: { allocations: true } });
      if (!lines.length) throw Errors.business('BC sans ligne');
      // Re-contrôle de capacité sous verrou : la situation a pu évoluer depuis le brouillon
      const reasons = lines.flatMap((l) => l.allocations.map((a) => a.overAllocationReason)).filter((x): x is string => !!x);
      const over = await this.core.lockAndCheckAllocations(
        ctx,
        tx,
        lines.flatMap((l) => l.allocations.map((a) => ({ prLineId: a.prLineId, quantity: a.quantity, poLineUnit: l.unit }))),
        { vesselId: po.vesselId, excludePoLineIds: lines.map((l) => l.id), overAllocationReason: reasons[0] ?? null },
      );
      // Σ allocations = quantité commandée, sauf excédent explicitement motivé (V1 §8.4)
      for (const l of lines) {
        const unallocated = unallocatedQuantity(D(l.quantityOrdered).minus(l.quantityCancelled), l.allocations.map((a) => a.quantity), `Ligne ${l.lineNo}`);
        if (unallocated.greaterThan(0) && !l.allocations.some((a) => a.overAllocationReason)) {
          throw Errors.business(`Ligne ${l.lineNo} : quantité non couverte par les allocations PR (${fmtQty(unallocated)})`);
        }
      }
      const decision = secondApprovalDecision(po.totalAmount, po.currency, thresholds, mode, over.length > 0 || reasons.length > 0);
      const now = new Date();
      const status: PoStatus = decision.required ? 'APPROVAL_PENDING' : 'APPROVED';
      const after = await this.core.bumpPo(tx, po, dto.expectedVersion, {
        status,
        requiresSecondApproval: decision.required,
        approvedById: ctx.userId,
        approvedAt: now,
      });
      await this.core.audit(
        ctx,
        {
          action: 'po.submitted',
          entityType: 'purchase_order',
          entityId: id,
          vesselId: po.vesselId,
          before: { status: po.status },
          after: { status: 'APPROVAL_PENDING' },
          metadata: { decision, mode, total: po.totalAmount, currency: po.currency, comment: dto.comment },
        },
        tx,
      );
      if (!decision.required) {
        await this.core.audit(
          ctx,
          { action: 'po.approved', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, before: { status: 'APPROVAL_PENDING' }, after: { status: 'APPROVED' }, metadata: { secondApproval: false, reason: decision.reason } },
          tx,
        );
        await this.core.recomputePrStatuses(ctx, await this.core.prIdsForPos([id], tx), tx, 'po.approved');
      } else {
        const approvers = await this.access.usersWithPermission('bc.approve', po.vesselId, tx);
        await this.notifications.notify(
          {
            userIds: approvers,
            excludeUserIds: [ctx.userId, po.createdById],
            type: 'purchasing.po_approval_required',
            title: `BC ${po.number} : second regard requis (${po.totalAmount.toString()} ${po.currency})`,
            body: decision.threshold ? `Seuil ${decision.threshold} ${po.currency} atteint.` : `Motif : ${decision.reason}`,
            module: 'purchasing',
            entityType: 'purchase_order',
            entityId: id,
            vesselId: po.vesselId,
            link: LINKS.po(id),
            priority: 'HIGH',
            dedupeKey: `po:${id}:approval:${after.lockVersion}`,
            email: true,
            requiredPermission: 'bc.approve',
          },
          tx,
        );
      }
      return { after, decision };
    }
  }

  /**
   * POST /orders/:id/issue — « Émettre le BC » : soumission + validation (si aucun second regard n'est requis)
   * + émission (SENT) dans une seule transaction, puis PDF officiel et transmission au créateur de la PR.
   */
  async issue(ctx: AuthContext, id: string, dto: OrderVersionDto) {
    const [thresholds, mode] = await Promise.all([this.config.thresholds(), this.config.poApprovalMode()]);
    const res = await this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      if (po.sentAt || PO_RECEIVABLE_STATUSES.includes(po.status)) throw Errors.alreadyProcessed('BC déjà émis');
      if (po.status === 'APPROVAL_PENDING') throw Errors.invalidState('BC en attente du second regard : il sera émis automatiquement à son approbation');
      let current = po;
      let decision: ReturnType<typeof secondApprovalDecision> | null = null;
      if (po.status === 'DRAFT') {
        const r = await this.submitTx(ctx, tx, po, dto, thresholds, mode);
        current = r.after;
        decision = r.decision;
      } else if (po.status !== 'APPROVED') {
        throw Errors.invalidState(`BC ${po.status} : émission impossible`, { status: po.status });
      } else if (po.lockVersion !== dto.expectedVersion) {
        throw Errors.staleVersion(undefined, { currentVersion: po.lockVersion });
      }
      if (current.status !== 'APPROVED') return { issued: false, decision };
      await this.markIssuedTx(ctx, tx, id, 'po.issue');
      return { issued: true, decision };
    });
    if (res.issued) await this.afterIssue(ctx, id);
    const order = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
    return {
      order: { id: order.id, number: order.number, status: order.status, lockVersion: order.lockVersion, sentAt: order.sentAt },
      issued: res.issued,
      approvalDecision: res.decision,
      message: res.issued
        ? 'BC émis : le créateur de la PR l’a reçu (notification et e-mail avec le PDF). Contactez le fournisseur.'
        : 'Second regard requis (seuil configuré) : le BC sera émis automatiquement dès son approbation.',
    };
  }

  /**
   * BC déjà transmis revenu à APPROVED (avenant approuvé) : retour au statut de réception dérivé du reçu, puis
   * clôtures automatiques BC / PR (audit ACH-04).
   */
  private async resumeReceiptStatusTx(ctx: AuthContext, tx: Tx, id: string, trigger: string) {
    const before = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    if (before.status !== 'APPROVED' || !before.sentAt) return;
    await tx.purchaseOrder.update({ where: { id }, data: { status: 'SENT', lockVersion: { increment: 1 } } });
    await this.core.audit(ctx, { action: 'po.status_recomputed', entityType: 'purchase_order', entityId: id, vesselId: before.vesselId, before: { status: 'APPROVED' }, after: { status: 'SENT' }, metadata: { trigger } }, tx);
    await this.core.recomputePoStatus(ctx, id, tx, trigger);
    await this.core.settleClosures(ctx, [id], tx, trigger);
  }

  /** Passage APPROVED → SENT (« émis ») ; statuts BC / PR recalculés. */
  private async markIssuedTx(ctx: AuthContext, tx: Tx, id: string, trigger: string) {
    const before = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
    if (before.status !== 'APPROVED') return;
    await tx.purchaseOrder.update({ where: { id }, data: { status: 'SENT', sentAt: new Date(), sentById: ctx.userId, lockVersion: { increment: 1 } } });
    await this.core.recomputePoStatus(ctx, id, tx, 'po.issued');
    await this.core.recomputePrStatuses(ctx, await this.core.prIdsForPos([id], tx), tx, 'po.issued');
    await this.core.audit(
      ctx,
      { action: 'po.issued', entityType: 'purchase_order', entityId: id, vesselId: before.vesselId, before: { status: 'APPROVED' }, after: { status: 'SENT' }, metadata: { trigger } },
      tx,
    );
  }

  /** Après commit : PDF officiel puis transmission au(x) créateur(s) de PR (échec d'e-mail tracé, jamais bloquant). */
  private async afterIssue(ctx: AuthContext, id: string) {
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
    let pdf: { file: { id: string; originalName: string }; buffer: Buffer } | null = null;
    try {
      pdf = await this.ensureOfficialPdf(ctx, po);
    } catch (e) {
      this.logger.error(`PDF du BC ${po.number} non généré : ${String(e)}`);
    }
    await this.notifyRequestersIssued(ctx, id, pdf);
  }

  /**
   * BC émis → créateur(s) de la PR : notification plateforme (fournisseur, date de livraison, port, articles) et
   * e-mail avec le PDF du BC. Les destinataires sont filtrés sur leurs droits réels (bc.view + navire).
   */
  private async notifyRequestersIssued(ctx: AuthContext, id: string, pdf: { file: { id: string; originalName: string }; buffer: Buffer } | null) {
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({
      where: { id },
      include: { supplier: { select: { name: true } }, vessel: { select: { name: true } }, lines: { where: { status: 'OPEN' }, orderBy: { lineNo: 'asc' } } },
    });
    const prs = await this.prisma.purchaseRequest.findMany({
      where: { lines: { some: { allocations: { some: { poLine: { poId: id } } } } } },
      select: { requesterId: true, number: true },
    });
    const requesters = [...new Set(prs.map((p) => p.requesterId))];
    if (!requesters.length) return;
    const allowed = await this.access.usersWithPermission('bc.view', po.vesselId, this.prisma, requesters);
    const fmtDay = (d: Date | null) => (d ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : 'à confirmer');
    const details = [
      `Fournisseur : ${po.supplier.name}`,
      `Livraison prévue : ${fmtDay(po.expectedDeliveryDate)}${po.deliveryPort ? ` — port : ${po.deliveryPort}` : ''}`,
      ...(po.deliveryTerms ? [`Conditions de livraison : ${po.deliveryTerms}`] : []),
      `PR : ${[...new Set(prs.map((p) => p.number))].join(', ')}`,
      '',
      ...po.lines.map((l) => `• ${l.designation}${l.reference ? ` (réf. ${l.reference})` : ''} : ${fmtQty(D(l.quantityOrdered).minus(l.quantityCancelled))} ${l.unit}`),
      ...(po.notes ? ['', po.notes] : []),
      '',
      'À la livraison, répondez à ce BC par un BL dans la plateforme (saisie des quantités reçues ou fichier joint).',
    ].join('\n');
    const title = `BC ${po.number} émis — ${po.supplier.name}`;
    const notified = await this.notifications.notify({
      userIds: allowed,
      excludeUserIds: [ctx.userId],
      type: 'purchasing.po_issued',
      title,
      body: details,
      module: 'purchasing',
      entityType: 'purchase_order',
      entityId: id,
      vesselId: po.vesselId,
      link: LINKS.po(id),
      priority: 'HIGH',
      dedupeKey: `po:${id}:issued:${po.revisionNo}`,
      requiredPermission: 'bc.view',
    });
    if (!notified.length) return;
    const users = await this.prisma.user.findMany({ where: { id: { in: notified } }, select: { id: true, email: true, username: true, displayName: true } });
    for (const u of users) {
      await this.prisma.poDispatch.create({
        data: { poId: id, recipient: (u.email ?? u.username).slice(0, 320), recipientKind: 'REQUESTER', channel: 'APP', status: 'SENT', sentAt: new Date(), fileId: pdf?.file.id ?? null, createdById: ctx.userId },
      });
      if (!u.email) continue;
      const res = await this.email.sendNow({
        to: u.email,
        subject: `AMC — ${title} (${po.vessel.name})`,
        text: `Bonjour ${u.displayName},\n\nLe bon de commande ${po.number} a été émis pour votre demande.\n\n${details}\n\nOuvrir le BC (connexion requise) : ${env().APP_BASE_URL}${LINKS.po(id)}\n\n— Plateforme AMC — Achats`,
        attachments: pdf ? [{ filename: pdf.file.originalName, content: pdf.buffer, contentType: 'application/pdf' }] : undefined,
      });
      const ok = res.status === 'SENT';
      await this.prisma.poDispatch.create({
        data: {
          poId: id,
          recipient: u.email.slice(0, 320),
          recipientKind: 'REQUESTER',
          channel: 'EMAIL',
          status: ok ? 'SENT' : 'FAILED',
          sentAt: ok ? new Date() : null,
          fileId: pdf?.file.id ?? null,
          error: ok ? null : (res.status === 'SUPPRESSED' ? 'E-mail non envoyé : envoi désactivé (EMAIL_MODE=disabled)' : (res.error ?? 'Échec du transport e-mail')).slice(0, 1000),
          createdById: ctx.userId,
        },
      });
    }
  }

  async approve(ctx: AuthContext, id: string, dto: OrderVersionDto) {
    const result = await this.prisma.$transaction(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      if (po.status === 'APPROVED') throw Errors.alreadyProcessed('BC déjà approuvé');
      assertTransition(PO_TRANSITIONS, po.status, 'APPROVED', 'Approbation BC');
      // Le créateur (ni l'émetteur) ne peut approuver son propre BC — même Super Admin
      if (po.createdById === ctx.userId || po.approvedById === ctx.userId) throw Errors.selfApproval();
      const now = new Date();
      const after = await this.core.bumpPo(tx, po, dto.expectedVersion, { status: 'APPROVED', secondApprovedById: ctx.userId, secondApprovedAt: now });
      await this.core.audit(
        ctx,
        { action: 'po.approved', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, before: { status: po.status }, after: { status: 'APPROVED' }, metadata: { secondApproval: true, comment: dto.comment } },
        tx,
      );
      await this.core.recomputePrStatuses(ctx, await this.core.prIdsForPos([id], tx), tx, 'po.approved');
      // Flux simplifié : un BC approuvé jamais transmis est émis immédiatement
      const issueNow = !po.sentAt;
      if (issueNow) {
        await this.notifyUsers(tx, [po.createdById], po, 'purchasing.po_approved', `BC ${po.number} approuvé (second regard) et émis`, dto.comment ?? undefined, 'bc.view');
        await this.markIssuedTx(ctx, tx, id, 'po.approved');
      } else {
        // Avenant d'un BC déjà transmis : le BC reprend son statut de réception (livraisons enregistrées pendant le
        // second regard comprises) et se clôture si tout est reçu ; la nouvelle version reste à noter comme envoyée
        await this.resumeReceiptStatusTx(ctx, tx, id, 'po.amendment_approved');
        await this.notifyUsers(
          tx,
          [po.createdById],
          po,
          'purchasing.po_approved',
          `Avenant n°${po.revisionNo} du BC ${po.number} approuvé (second regard)`,
          ['Notez l’envoi de la nouvelle version au fournisseur.', dto.comment].filter(Boolean).join('\n'),
          'bc.view',
        );
      }
      return { after: await tx.purchaseOrder.findUniqueOrThrow({ where: { id } }), issueNow };
    });
    if (result.issueNow) await this.afterIssue(ctx, id);
    return result.after;
  }

  async reject(ctx: AuthContext, id: string, dto: OrderRejectDto) {
    return this.prisma.$transaction(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      if (po.sentAt) throw Errors.business('Avenant d’un BC déjà transmis : approuvez-le ou proposez un nouvel avenant (pas de retour en brouillon)');
      assertTransition(PO_TRANSITIONS, po.status, 'DRAFT', 'Refus BC');
      const after = await this.core.bumpPo(tx, po, dto.expectedVersion, { status: 'DRAFT', approvedById: null, approvedAt: null, requiresSecondApproval: false });
      await this.core.audit(ctx, { action: 'po.rejected', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, before: { status: po.status }, after: { status: 'DRAFT' }, metadata: { comment: dto.comment } }, tx);
      await this.notifyUsers(tx, [po.createdById], po, 'purchasing.po_rejected', `BC ${po.number} renvoyé en brouillon`, dto.comment, 'bc.view');
      return after;
    });
  }

  // ---------------------------------------------------------------------------
  // Envoi (PDF officiel + e-mail fournisseur, statut réel du transport)
  // ---------------------------------------------------------------------------

  private async ensureOfficialPdf(ctx: AuthContext, po: PurchaseOrder) {
    if (po.pdfFileId) {
      const file = await this.files.getOrThrow(po.pdfFileId);
      return { file, buffer: await this.files.readBuffer(file) };
    }
    const { file, buffer } = await this.docs.storePo(ctx, po.id, po.vesselId);
    await this.prisma.$transaction(async (tx) => {
      await tx.purchaseOrder.update({ where: { id: po.id }, data: { pdfFileId: file.id } });
      if (po.revisionNo) await tx.poRevision.updateMany({ where: { poId: po.id, revisionNo: po.revisionNo, pdfFileId: null }, data: { pdfFileId: file.id } });
      await this.core.audit(ctx, { action: 'po.pdf_generated', entityType: 'purchase_order', entityId: po.id, vesselId: po.vesselId, metadata: { fileId: file.id, revisionNo: po.revisionNo } }, tx);
    });
    return { file, buffer };
  }

  async markSent(ctx: AuthContext, id: string, dto: MarkOrderSentDto) {
    const current = await this.core.findPo(ctx, id);
    if (!['APPROVED', ...PO_RECEIVABLE_STATUSES].includes(current.status)) throw Errors.invalidState(`BC ${current.status} : transmission impossible`);
    const { file } = await this.ensureOfficialPdf(ctx, current);
    return this.prisma.$transaction(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      const wasApproved = po.status === 'APPROVED';
      const after = await this.core.bumpPo(tx, po, dto.expectedVersion, wasApproved ? { status: 'SENT', sentAt: new Date(), sentById: ctx.userId } : {});
      const dispatch = await tx.poDispatch.create({
        data: {
          poId: id,
          recipient: dto.recipient.slice(0, 320),
          recipientKind: 'SUPPLIER',
          channel: 'MANUAL',
          status: 'SENT',
          sentAt: new Date(),
          fileId: file.id,
          error: dto.note ? `Note : ${dto.note}`.slice(0, 1000) : null,
          createdById: ctx.userId,
        },
      });
      await this.core.audit(
        ctx,
        {
          action: 'po.marked_sent',
          entityType: 'purchase_order',
          entityId: id,
          vesselId: po.vesselId,
          before: { status: po.status },
          after: { status: after.status },
          metadata: { channel: dto.channel, recipient: dto.recipient, note: dto.note, declaredBy: ctx.userId, dispatchId: dispatch.id, fileId: file.id },
        },
        tx,
      );
      if (wasApproved) {
        await this.core.recomputePoStatus(ctx, id, tx, 'po.marked_sent');
        // Livraisons déjà enregistrées (BC transmis puis avenant approuvé) : clôture si tout est reçu (ACH-04)
        await this.core.settleClosures(ctx, [id], tx, 'po.marked_sent');
        await this.notifyOnboard(ctx, tx, po, file.id, 'sent');
      }
      return { order: await tx.purchaseOrder.findUniqueOrThrow({ where: { id } }), dispatch };
    });
  }

  /** BC transmis au Captain (receiving.record sur le navire) et au(x) créateur(s) de PR (CDC §6.6, V1 §9.3). */
  private async notifyOnboard(ctx: AuthContext, tx: Tx, po: PurchaseOrder, fileId: string | null, kind: 'sent' | 'revised' | 'cancelled') {
    // Captain(s) du navire : détenteurs de receiving.record AFFECTÉS au navire (scope SELECTED) — hors personnel
    // à terre « toute la flotte » (Super Admin…), qui consulte le BC via ses propres droits.
    const recorders = await this.access.usersWithPermission('receiving.record', po.vesselId, tx);
    const captains = recorders.length
      ? (await tx.user.findMany({ where: { id: { in: recorders }, vesselScope: 'SELECTED' }, select: { id: true } })).map((u) => u.id)
      : [];
    const prs = await tx.purchaseRequest.findMany({
      where: { lines: { some: { allocations: { some: { poLine: { poId: po.id } } } } } },
      select: { requesterId: true, number: true },
    });
    const requesters = prs.map((p) => p.requesterId);
    const title =
      kind === 'sent'
        ? `BC ${po.number} envoyé au fournisseur — préparer la réception`
        : kind === 'revised'
          ? `BC ${po.number} révisé (révision ${po.revisionNo})`
          : `BC ${po.number} annulé`;
    const notified = await this.notifications.notify(
      {
        userIds: [...captains, ...requesters],
        excludeUserIds: [ctx.userId],
        type: `purchasing.po_${kind}`,
        title,
        body: prs.length ? `PR liée(s) : ${[...new Set(prs.map((p) => p.number))].join(', ')}` : undefined,
        module: 'purchasing',
        entityType: 'purchase_order',
        entityId: po.id,
        vesselId: po.vesselId,
        link: LINKS.po(po.id),
        dedupeKey: `po:${po.id}:${kind}:${po.revisionNo}:${fileId ?? ''}`,
        email: true,
        requiredPermission: 'bc.view',
      },
      tx,
    );
    if (!notified.length) return;
    const users = await tx.user.findMany({ where: { id: { in: notified } }, select: { id: true, email: true, username: true } });
    for (const u of users) {
      await tx.poDispatch.create({
        data: {
          poId: po.id,
          recipient: (u.email ?? u.username).slice(0, 320),
          recipientKind: requesters.includes(u.id) ? 'REQUESTER' : 'CAPTAIN',
          channel: 'APP',
          status: 'SENT',
          sentAt: new Date(),
          fileId,
          createdById: ctx.userId,
        },
      });
    }
  }

  private async notifyUsers(tx: Tx, userIds: string[], po: PurchaseOrder, type: string, title: string, body: string | undefined, requiredPermission: string) {
    await this.notifications.notify(
      { userIds, type, title, body, module: 'purchasing', entityType: 'purchase_order', entityId: po.id, vesselId: po.vesselId, link: LINKS.po(po.id), email: true, requiredPermission },
      tx,
    );
  }

  // ---------------------------------------------------------------------------
  // Révision / avenant (jamais de modification silencieuse d'un BC envoyé)
  // ---------------------------------------------------------------------------

  /**
   * Applique un avenant dans une transaction SERIALIZABLE : snapshot des quantités contractuelles
   * précédentes (PoRevision), nouvelles quantités / prix / lignes, allocations ajustées, statuts recalculés.
   * Le PDF de la nouvelle révision est généré après commit (regeneratePdf).
   */
  async reviseTx(ctx: AuthContext, tx: Tx, po: PurchaseOrder, input: ReviseOrderInput) {
    if (!isPoReceivable(po)) throw Errors.invalidState(`BC ${po.status} : révision réservée aux BC envoyés (brouillon : modification directe)`);
    const lines = await tx.poLine.findMany({ where: { poId: po.id }, include: { allocations: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } }, orderBy: { lineNo: 'asc' } });
    const balances = new Map((await this.core.balancesForPos([po.id], tx)).map((b) => [b.poLineId, b]));
    const snapshot = {
      revisionNo: po.revisionNo,
      status: po.status,
      currency: po.currency,
      subtotal: po.subtotal,
      taxAmount: po.taxAmount,
      freightAmount: po.freightAmount,
      totalAmount: po.totalAmount,
      expectedDeliveryDate: po.expectedDeliveryDate,
      pdfFileId: po.pdfFileId,
      lines: lines.map((l) => ({
        id: l.id,
        lineNo: l.lineNo,
        designation: l.designation,
        reference: l.reference,
        quantityOrdered: l.quantityOrdered,
        quantityCancelled: l.quantityCancelled,
        unit: l.unit,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
        status: l.status,
        allocations: l.allocations.map((a) => ({ prLineId: a.prLineId, quantity: a.quantity, overAllocationReason: a.overAllocationReason })),
      })),
    };

    type Change = { line: (typeof lines)[number]; ordered: Prisma.Decimal; cancelled: Prisma.Decimal; status: LineStatus; unitPrice: Prisma.Decimal; remarks: string | null; replaceAllocations?: { prLineId: string; quantity: Prisma.Decimal }[] };
    const changes: Change[] = [];
    const seen = new Set<string>();
    for (const c of input.lines) {
      const line = lines.find((l) => l.id === c.poLineId);
      if (!line) throw Errors.validation('Ligne de BC inconnue', { poLineId: c.poLineId });
      if (seen.has(line.id)) throw Errors.validation(`Ligne ${line.lineNo} citée deux fois`);
      seen.add(line.id);
      if (c.cancelRemaining && c.quantityOrdered) throw Errors.validation(`Ligne ${line.lineNo} : quantityOrdered et cancelRemaining exclusifs`);
      const b = balances.get(line.id)!;
      let ordered = D(line.quantityOrdered);
      let cancelled = D(line.quantityCancelled);
      let status = line.status;
      if (c.quantityOrdered) {
        const q = D(c.quantityOrdered);
        if (q.lessThan(b.qtyAccepted)) throw Errors.business(`Ligne ${line.lineNo} : quantité inférieure à la quantité déjà acceptée (${fmtQty(b.qtyAccepted)})`);
        ordered = q;
        cancelled = new Prisma.Decimal(0);
        status = 'OPEN';
      }
      if (c.cancelRemaining) {
        const remaining = max0(ordered.minus(cancelled).minus(b.qtyAccepted));
        if (remaining.isZero()) throw Errors.business(`Ligne ${line.lineNo} : aucun reliquat à annuler`);
        cancelled = cancelled.plus(remaining);
        status = D(b.qtyPhysicallyReceived).isZero() ? 'CANCELLED' : 'OPEN';
      }
      changes.push({
        line,
        ordered,
        cancelled,
        status,
        unitPrice: c.unitPrice !== undefined ? D(c.unitPrice) : D(line.unitPrice),
        remarks: c.remarks !== undefined ? (c.remarks ?? null) : line.remarks,
        replaceAllocations: c.allocations ? mergeAllocations(c.allocations) : undefined,
      });
    }

    // Lignes ajoutées par avenant
    const startNo = Math.max(0, ...lines.map((l) => l.lineNo)) + 1;
    const added = input.addLines.length ? await this.resolveLines(ctx, tx, input.addLines, po.supplierId, startNo, po.id) : [];
    this.assertQuotationVessel(added, po.vesselId);
    for (const a of added) {
      if (a.quotationCurrency && a.quotationCurrency !== po.currency) throw Errors.validation('Ligne de devis dans une autre devise que le BC');
    }

    // Contrôle de capacité pour les allocations nouvelles / remplacées (réductions : aucun contrôle requis)
    const replaced = changes.filter((c) => c.replaceAllocations);
    for (const c of replaced) {
      const effective = c.status === 'CANCELLED' ? new Prisma.Decimal(0) : max0(c.ordered.minus(c.cancelled));
      if (sumD(c.replaceAllocations!.map((a) => a.quantity)).greaterThan(effective)) {
        throw Errors.validation(`Ligne ${c.line.lineNo} : allocations supérieures à la quantité effective (${fmtQty(effective)})`);
      }
    }
    const over = await this.core.lockAndCheckAllocations(
      ctx,
      tx,
      [
        ...replaced.flatMap((c) => c.replaceAllocations!.map((a) => ({ prLineId: a.prLineId, quantity: a.quantity, poLineUnit: c.line.unit }))),
        ...added.flatMap((l) => l.allocations.map((a) => ({ prLineId: a.prLineId, quantity: a.quantity, poLineUnit: l.unit }))),
      ],
      { vesselId: po.vesselId, excludePoLineIds: replaced.map((c) => c.line.id), overAllocationReason: input.overAllocationReason },
    );
    const overIds = new Set(over.map((o) => o.prLineId));
    // Σ allocations = quantité effective par ligne (hausse sans allocation PR => parcours de dépassement motivé)
    const effectiveOf = (c: Change) => (c.status === 'CANCELLED' ? new Prisma.Decimal(0) : max0(c.ordered.minus(c.cancelled)));
    const shrunkOf = new Map(changes.map((c) => [c.line.id, shrinkAllocations(c.line.allocations.map((a) => a.quantity), effectiveOf(c))]));
    const unallocatedLines = await this.assertUnallocated(
      [
        ...changes.map((c) => ({
          lineNo: c.line.lineNo,
          unallocated: max0(effectiveOf(c).minus(sumD(c.replaceAllocations ? c.replaceAllocations.map((a) => a.quantity) : shrunkOf.get(c.line.id)!))),
        })),
        ...added,
      ],
      input.overAllocationReason,
    );

    for (const c of changes) {
      const effective = c.status === 'CANCELLED' ? new Prisma.Decimal(0) : max0(c.ordered.minus(c.cancelled));
      await tx.poLine.update({
        where: { id: c.line.id },
        data: {
          quantityOrdered: c.ordered,
          quantityCancelled: c.cancelled,
          status: c.status,
          unitPrice: c.unitPrice,
          remarks: c.remarks,
          lineTotal: poLineTotal({ quantityOrdered: c.ordered, quantityCancelled: c.cancelled, unitPrice: c.unitPrice, status: c.status }),
        },
      });
      if (c.replaceAllocations) {
        await tx.poLineAllocation.deleteMany({ where: { poLineId: c.line.id } });
        for (const a of c.replaceAllocations) {
          await tx.poLineAllocation.create({
            data: { poLineId: c.line.id, prLineId: a.prLineId, quantity: a.quantity, overAllocationReason: overIds.has(a.prLineId) ? (input.overAllocationReason ?? null) : null },
          });
        }
      } else {
        // Les allocations ne dépassent jamais la quantité effective de la ligne (reliquat annulé => capacité PR libérée)
        const shrunk = shrunkOf.get(c.line.id)!;
        for (const [i, a] of c.line.allocations.entries()) {
          if (shrunk[i].equals(a.quantity)) continue;
          if (shrunk[i].isZero()) await tx.poLineAllocation.delete({ where: { id: a.id } });
          else await tx.poLineAllocation.update({ where: { id: a.id }, data: { quantity: shrunk[i] } });
        }
      }
      if (unallocatedLines.includes(c.line.lineNo)) {
        await tx.poLineAllocation.updateMany({ where: { poLineId: c.line.id }, data: { overAllocationReason: input.overAllocationReason ?? null } });
      }
    }
    for (const l of added) {
      await tx.poLine.create({
        data: {
          poId: po.id,
          ...this.lineCreate(l, poLineTotal({ quantityOrdered: l.quantityOrdered, quantityCancelled: 0, unitPrice: l.unitPrice }), over, unallocatedLines, input.overAllocationReason),
        },
      });
    }

    const fresh = await tx.poLine.findMany({ where: { poId: po.id } });
    const taxAmount = input.taxAmount !== undefined ? D(input.taxAmount) : D(po.taxAmount);
    const freightAmount = input.freightAmount !== undefined ? D(input.freightAmount) : D(po.freightAmount);
    const totals = computePoTotals(fresh, { tax: taxAmount, freight: freightAmount });

    // Second regard ré-évalué sur le montant révisé : un avenant à la hausse (prix, quantité, ligne, montant)
    // qui franchit la règle (seuil / mode ALWAYS / dépassement d'allocation) repasse en APPROVAL_PENDING ;
    // le renvoi au fournisseur est alors bloqué jusqu'à l'approbation par une autre personne (bc.approve).
    const increases =
      totals.total.greaterThan(po.totalAmount) ||
      added.length > 0 ||
      changes.some((c) => effectiveOf(c).greaterThan(max0(D(c.line.quantityOrdered).minus(c.line.quantityCancelled))) || c.unitPrice.greaterThan(c.line.unitPrice));
    const hasOver = over.length > 0 || unallocatedLines.length > 0;
    const [thresholds, mode] = await Promise.all([this.config.thresholds(tx), this.config.poApprovalMode(tx)]);
    const decision = secondApprovalDecision(totals.total, po.currency, thresholds, mode, hasOver);
    const reapproval = (increases || hasOver) && decision.required;
    if (reapproval && po.status !== 'APPROVAL_PENDING') assertTransition(PO_TRANSITIONS, po.status, 'APPROVAL_PENDING', 'Avenant BC');

    const revisionNo = po.revisionNo + 1;
    const revision = await tx.poRevision.create({ data: { poId: po.id, revisionNo, snapshot: JSON.parse(JSON.stringify(snapshot)), reason: input.reason, createdById: ctx.userId } });
    await this.core.bumpPo(tx, po, input.expectedVersion, {
      revisionNo,
      subtotal: totals.subtotal,
      taxAmount,
      freightAmount,
      totalAmount: totals.total,
      pdfFileId: null,
      ...(input.expectedDeliveryDate !== undefined ? { expectedDeliveryDate: input.expectedDeliveryDate } : {}),
      ...(reapproval
        ? { status: 'APPROVAL_PENDING', requiresSecondApproval: true, approvedById: ctx.userId, approvedAt: new Date(), secondApprovedById: null, secondApprovedAt: null }
        : {}),
    });
    await this.core.recomputePoStatus(ctx, po.id, tx, 'po.revised');
    await this.core.syncBalanceVariances(ctx, po.id, tx, null);
    // Correction (fournisseur) : la comparaison BC ↔ BL est refaite ; BC et PR se clôturent si tout est reçu
    await this.core.settleClosures(ctx, [po.id], tx, 'po.revised');
    const after = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id }, include: { lines: { include: { allocations: true }, orderBy: { lineNo: 'asc' } } } });
    await this.core.audit(
      ctx,
      {
        action: 'po.revised',
        entityType: 'purchase_order',
        entityId: po.id,
        vesselId: po.vesselId,
        before: snapshot,
        after: { revisionNo, subtotal: after.subtotal, totalAmount: after.totalAmount, lines: after.lines },
        metadata: { reason: input.reason, revisionId: revision.id, overAllocations: over, unallocatedLines, approvalDecision: decision, reapproval },
      },
      tx,
    );
    if (reapproval) {
      const approvers = await this.access.usersWithPermission('bc.approve', po.vesselId, tx);
      await this.notifications.notify(
        {
          userIds: approvers,
          excludeUserIds: [ctx.userId, po.createdById],
          type: 'purchasing.po_approval_required',
          title: `Avenant ${revisionNo} du BC ${po.number} : second regard requis (${totals.total.toFixed(2)} ${po.currency})`,
          body: `Motif de l’avenant : ${input.reason}`,
          module: 'purchasing',
          entityType: 'purchase_order',
          entityId: po.id,
          vesselId: po.vesselId,
          link: LINKS.po(po.id),
          priority: 'HIGH',
          dedupeKey: `po:${po.id}:revision-approval:${revisionNo}`,
          email: true,
          requiredPermission: 'bc.approve',
        },
        tx,
      );
    }
    return { revision, order: after, approvalDecision: decision, reapprovalRequired: reapproval };
  }

  /** Génère et enregistre le PDF de la révision courante (après commit). */
  async regeneratePdf(ctx: AuthContext, poId: string) {
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    try {
      return (await this.ensureOfficialPdf(ctx, po)).file;
    } catch (e) {
      this.logger.error(`PDF BC ${po.number} non régénéré : ${String(e)}`);
      return null;
    }
  }

  async revise(ctx: AuthContext, id: string, dto: ReviseOrderInput) {
    const result = await this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      return this.reviseTx(ctx, tx, po, dto);
    });
    const file = await this.regeneratePdf(ctx, id);
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id } });
    await this.prisma.$transaction((tx) => this.notifyOnboard(ctx, tx, po, file?.id ?? null, 'revised'));
    return {
      revision: { ...result.revision, pdfFileId: file?.id ?? null },
      order: await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, include: { lines: { include: { allocations: true }, orderBy: { lineNo: 'asc' } } } }),
      pdf: file ? await this.files.issueLink(ctx, file, 'preview') : null,
      approvalDecision: result.approvalDecision,
      note: result.reapprovalRequired
        ? 'Avenant soumis à second regard (bc.approve, autre personne) : le renvoi au fournisseur est bloqué jusqu’à approbation.'
        : 'Révision enregistrée : transmettez la nouvelle version au fournisseur puis notez l’envoi (« Noter l’envoi au fournisseur »).',
    };
  }

  // ---------------------------------------------------------------------------
  // Annulation / clôture
  // ---------------------------------------------------------------------------

  async cancel(ctx: AuthContext, id: string, dto: OrderReasonDto) {
    return this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, id, tx);
      if (!(po.status === 'DRAFT' && po.createdById === ctx.userId && can(ctx, 'bc.create'))) this.access.assertCan(ctx, 'bc.cancel');
      assertTransition(PO_TRANSITIONS, po.status, 'CANCELLED', 'Annulation BC');
      if (po.sentAt) {
        const [receipts, notes] = await Promise.all([
          tx.goodsReceipt.count({ where: { poId: id } }),
          tx.deliveryNote.count({ where: { poId: id, status: { not: 'CANCELLED' } } }),
        ]);
        if (receipts || notes) throw Errors.business('BL ou réception enregistré : annulez le reliquat par une révision puis clôturez le BC');
      }
      const after = await this.core.bumpPo(tx, po, dto.expectedVersion, { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: dto.reason });
      await this.core.audit(ctx, { action: 'po.cancelled', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, before: { status: po.status }, after: { status: 'CANCELLED' }, metadata: { reason: dto.reason } }, tx);
      await this.core.recomputePrStatuses(ctx, await this.core.prIdsForPos([id], tx), tx, 'po.cancelled');
      if (po.status === 'SENT') await this.notifyOnboard(ctx, tx, after, po.pdfFileId, 'cancelled');
      return {
        ...after,
        note: po.status === 'SENT' ? 'BC annulé dans la plateforme : informez le fournisseur (aucun envoi externe automatique).' : undefined,
      };
    });
  }

  /**
   * Clôture : écarts ouverts à traiter d'abord ; s'il reste un reliquat, décision documentée (bc.cancel + motif)
   * matérialisée par une révision qui annule le reliquat (V1 §9.3).
   */
  async close(ctx: AuthContext, id: string, dto: OrderCloseDto) {
    let revised = false;
    const result = await this.core.serializable(async (tx) => {
      let po = await this.core.findPo(ctx, id, tx);
      assertTransition(PO_TRANSITIONS, po.status, 'CLOSED', 'Clôture BC');
      const open = await tx.variance.count({ where: { poId: id, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
      if (open) throw Errors.business(`${open} écart(s) ouvert(s) : à résoudre avant clôture`);
      const balances = await this.core.balancesForPos([id], tx);
      const lines = await tx.poLine.findMany({ where: { poId: id }, select: { id: true, status: true } });
      const withRemaining = balances.filter((b) => D(b.qtyRemaining).greaterThan(0) && lines.find((l) => l.id === b.poLineId)?.status !== 'CANCELLED');
      let version = dto.expectedVersion;
      if (withRemaining.length) {
        this.access.assertCan(ctx, 'bc.cancel');
        if (!dto.reason) throw Errors.validation('Reliquat ouvert : décision de clôture documentée (motif) obligatoire');
        await this.reviseTx(ctx, tx, po, {
          expectedVersion: version,
          reason: `Clôture avec reliquat : ${dto.reason}`,
          lines: withRemaining.map((b) => ({ poLineId: b.poLineId, cancelRemaining: true })),
          addLines: [],
        });
        revised = true;
        po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id } });
        version = po.lockVersion;
      }
      const after = await this.core.bumpPo(tx, po, version, { status: 'CLOSED', closedAt: new Date() });
      await this.core.audit(ctx, { action: 'po.closed', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, before: { status: po.status }, after: { status: 'CLOSED' }, metadata: { reason: dto.reason, cancelledRemaining: revised } }, tx);
      await this.core.recomputePrStatuses(ctx, await this.core.prIdsForPos([id], tx), tx, 'po.closed');
      return after;
    });
    if (revised) await this.regeneratePdf(ctx, id);
    return result;
  }

  // ---------------------------------------------------------------------------
  // PDF
  // ---------------------------------------------------------------------------

  /** PDF officiel (version transmise) si le BC est envoyé ; sinon projet généré à la demande. */
  async pdf(ctx: AuthContext, id: string, download: boolean) {
    const po = await this.core.findPo(ctx, id);
    let file;
    if (po.pdfFileId && (CONTRACTUAL.includes(po.status) || po.status === 'APPROVED')) {
      file = await this.files.getOrThrow(po.pdfFileId);
    } else if (po.status === 'APPROVED') {
      file = (await this.ensureOfficialPdf(ctx, po)).file;
    } else if (CONTRACTUAL.includes(po.status)) {
      file = (await this.ensureOfficialPdf(ctx, po)).file;
    } else {
      file = (await this.docs.storePo(ctx, id, po.vesselId, { draft: true })).file;
      await this.core.audit(ctx, { action: 'po.pdf_preview_generated', entityType: 'purchase_order', entityId: id, vesselId: po.vesselId, metadata: { fileId: file.id, status: po.status } });
    }
    return { fileId: file.id, official: file.id === (await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id }, select: { pdfFileId: true } })).pdfFileId, ...(await this.files.issueLink(ctx, file, download ? 'download' : 'preview')) };
  }
}
