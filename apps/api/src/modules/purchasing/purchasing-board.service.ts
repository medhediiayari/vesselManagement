import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { PurchasingCore } from './purchasing-core.service';

/**
 * Purchasing board (V1 §9.2) : nouvelles PR, RFQ à relancer, devis à comparer, BC à préparer / approuver /
 * envoyer, manquants à traiter. Chaque compteur n'est calculé que si la permission correspondante est détenue,
 * et toujours dans le scope navire.
 */
@Injectable()
export class PurchasingBoardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
  ) {}

  async board(ctx: AuthContext, vesselId?: string) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // Scope navire ET filtre demandé (jamais l'un à la place de l'autre)
    const scope = { AND: [vesselWhere(ctx), vesselId ? { vesselId } : {}] };
    const out: Record<string, unknown> = {};
    if (can(ctx, 'pr.view')) {
      const pr = (where: Prisma.PurchaseRequestWhereInput) =>
        this.prisma.purchaseRequest.count({ where: { AND: [scope as Prisma.PurchaseRequestWhereInput, this.core.prOwnWhere(ctx), where] } });
      const [submitted, underReview, revised, onHold, toOrder, overdue] = await Promise.all([
        pr({ status: 'SUBMITTED' }),
        pr({ status: 'UNDER_REVIEW' }),
        pr({ status: 'REVISED' }),
        pr({ status: 'ON_HOLD' }),
        pr({ status: { in: ['APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'] } }),
        pr({ neededBy: { lt: today }, status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED', 'ON_HOLD'] } }),
      ]);
      out.purchaseRequests = { inbox: submitted, underReview, counterPrPending: revised, onHold, toOrder, overdueNotOrdered: overdue };
    }
    if (can(ctx, 'rfq.view')) {
      const rfq = (where: Prisma.RfqWhereInput) => this.prisma.rfq.count({ where: { AND: [scope as Prisma.RfqWhereInput, where] } });
      const [drafts, sendFailed, deadlinePassed] = await Promise.all([
        rfq({ status: 'DRAFT' }),
        rfq({ status: { in: ['DRAFT', 'ISSUED', 'QUOTED'] }, suppliers: { some: { status: 'SEND_FAILED' } } }),
        rfq({ status: 'ISSUED', deadline: { lt: now } }),
      ]);
      out.rfqs = { drafts, sendFailed, toFollowUp: deadlinePassed };
    }
    if (can(ctx, 'quotation.view')) {
      out.quotations = { toCompare: await this.prisma.rfq.count({ where: { AND: [scope as Prisma.RfqWhereInput, { status: 'QUOTED' }] } }) };
    }
    if (can(ctx, 'bc.view')) {
      const po = (where: Prisma.PurchaseOrderWhereInput) =>
        this.prisma.purchaseOrder.count({ where: { AND: [scope as Prisma.PurchaseOrderWhereInput, this.core.poOwnWhere(ctx), where] } });
      const [drafts, pending, approvedNotSent, late, partial, toReceive, toDecide, awaitingRemainder] = await Promise.all([
        po({ status: 'DRAFT' }),
        po({ status: 'APPROVAL_PENDING' }),
        po({ status: 'APPROVED' }),
        po({ status: { in: ['SENT', 'PARTIALLY_RECEIVED'] }, expectedDeliveryDate: { lt: today } }),
        po({ status: 'PARTIALLY_RECEIVED' }),
        // Bord : BC émis en attente de BL ; Achats : BC avec écart de réception à décider / reliquat attendu
        po({ status: { in: ['SENT', 'PARTIALLY_RECEIVED'] } }),
        po({ variances: { some: { status: 'OPEN' } } }),
        po({ variances: { some: { status: 'IN_PROGRESS' } }, NOT: { variances: { some: { status: 'OPEN' } } } }),
      ]);
      out.orders = { drafts, approvalPending: pending, approvedNotSent, lateDelivery: late, partiallyReceived: partial, toReceive, discrepanciesToDecide: toDecide, awaitingRemainder };
    }
    if (can(ctx, 'receiving.view') || can(ctx, 'variances.manage')) {
      out.variances = {
        open: await this.prisma.variance.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, po: { AND: [scope as Prisma.PurchaseOrderWhereInput, this.core.poOwnWhere(ctx)] } } }),
        receiptsToValidate: await this.prisma.goodsReceipt.count({ where: { AND: [scope as Prisma.GoodsReceiptWhereInput, { status: 'CONFIRMED' }] } }),
      };
    }
    if (can(ctx, 'invoice.view')) {
      const inv = (where: Prisma.InvoiceWhereInput) => this.prisma.invoice.count({ where: { AND: [scope as Prisma.InvoiceWhereInput, where] } });
      const [toReview, disputed] = await Promise.all([inv({ status: { in: ['RECEIVED', 'UNDER_REVIEW'] } }), inv({ status: 'DISPUTED' })]);
      out.invoices = { toReview, disputed };
    }
    return out;
  }
}
