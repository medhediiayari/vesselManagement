import { Injectable } from '@nestjs/common';
import { InvoiceStatus, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, vesselWhere } from '../access/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateInvoiceDto, InvoiceStatusDto, ListInvoicesQuery } from './invoices.dto';
import { PurchasingCore } from './purchasing-core.service';
import { LINKS } from './purchasing.constants';
import { escapeLike } from '../../common/utils/like';
import {
  D,
  INVOICE_TRANSITIONS,
  assertTransition,
  computeBalance,
  fmtMoney,
  invoiceMatchReasonsText,
  receivedValue,
  round2,
  suggestInvoiceMatch,
  sumD,
} from './purchasing.logic';

/** Factures à examiner : le rapprochement est recalculé pour signaler un écart (audit ACH-13). */
const OPEN_INVOICE_STATUSES: readonly InvoiceStatus[] = ['RECEIVED', 'UNDER_REVIEW'];

/**
 * Factures fournisseurs (CDC §6.7) : fichier original, numéro, montants, devise, liens vers un ou plusieurs BC
 * d'un même navire ; rapprochement commandé / reçu / facturé PAR DEVISE (aucune conversion) avec suggestion
 * MATCHED / DISPUTED. Une facture ne modifie JAMAIS le statut d'un BC (PUR-07) ; paiement hors V1.
 */
@Injectable()
export class InvoicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  async list(ctx: AuthContext, q: ListInvoicesQuery) {
    const where: Prisma.InvoiceWhereInput = {
      AND: [
        vesselWhere(ctx) as Prisma.InvoiceWhereInput,
        this.core.invoiceOwnWhere(ctx),
        q.supplierId ? { supplierId: q.supplierId } : {},
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.poId ? { orders: { some: { poId: q.poId } } } : {},
        q.status?.length ? { status: { in: q.status } } : {},
        q.search ? { number: { contains: escapeLike(q.search), mode: 'insensitive' } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ invoiceDate: 'desc' }, { id: 'desc' }],
        include: { supplier: { select: { id: true, name: true } }, orders: { include: { po: { select: { id: true, number: true, status: true } } } } },
        ...cursorArgs(q),
      }),
      this.prisma.invoice.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    // Écart de rapprochement des factures à examiner (la facture garde son statut — audit ACH-13)
    const items = [];
    for (const r of page.items) {
      const m = OPEN_INVOICE_STATUSES.includes(r.status) ? await this.matching(r.id) : null;
      items.push({ ...r, reconciliation: m ? { suggestion: m.suggestion, reasons: m.reasons } : null });
    }
    return { ...page, items };
  }

  /**
   * Factures à examiner (RECEIVED / UNDER_REVIEW) dont le rapprochement présente un écart, dans le filtre donné
   * (déjà restreint au périmètre de l'utilisateur). Calcul borné à `limit` factures : `capped` le signale.
   */
  async countReconciliationGaps(where: Prisma.InvoiceWhereInput, limit = 200): Promise<{ count: number; capped: boolean }> {
    const open = await this.prisma.invoice.findMany({
      where: { AND: [where, { status: { in: [...OPEN_INVOICE_STATUSES] } }] },
      select: { id: true },
      orderBy: { invoiceDate: 'desc' },
      take: limit + 1,
    });
    let count = 0;
    for (const inv of open.slice(0, limit)) if ((await this.matching(inv.id)).suggestion === 'DISPUTED') count++;
    return { count, capped: open.length > limit };
  }

  private async find(ctx: AuthContext, id: string, db: Db = this.prisma) {
    const inv = await db.invoice.findUnique({ where: { id } });
    if (!inv) throw Errors.notFound('Facture');
    // vessel_id toujours renseigné à la création (BC d'un même navire)
    this.access.assertVesselAccess(ctx, inv.vesselId);
    await this.core.assertInvoiceVisible(ctx, inv.id, db);
    return inv;
  }

  async get(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    const inv = await this.prisma.invoice.findUniqueOrThrow({
      where: { id },
      include: { supplier: { select: { id: true, code: true, name: true } }, orders: { include: { po: { select: { id: true, number: true, status: true, currency: true, totalAmount: true } } } } },
    });
    const names = await this.core.userNames([inv.createdById]);
    return {
      ...inv,
      createdByName: names.get(inv.createdById) ?? null,
      matching: await this.matching(id),
      attachments: await this.core.attachmentsOf('INVOICE', [id]),
    };
  }

  /** Rapprochement commandé / reçu / facturé par devise (lecture seule : n'affecte aucun statut BC). */
  async matching(invoiceId: string, db: Db = this.prisma) {
    const inv = await db.invoice.findUniqueOrThrow({ where: { id: invoiceId }, include: { orders: true } });
    const gross = D(inv.amount).plus(inv.taxAmount);
    const orders = [];
    for (const link of inv.orders) {
      const po = await db.purchaseOrder.findUniqueOrThrow({ where: { id: link.poId } });
      const lines = await db.poLine.findMany({ where: { poId: po.id } });
      const balances = await this.core.balancesForPos([po.id], db);
      const received = receivedValue(
        balances.map((b) => {
          const l = lines.find((x) => x.id === b.poLineId)!;
          const bal = computeBalance({ ordered: b.quantityOrdered, cancelled: b.quantityCancelled, onNotes: b.qtyOnDeliveryNotes, received: b.qtyPhysicallyReceived, accepted: b.qtyAccepted, rejected: b.qtyRejected });
          return { unitPrice: l.unitPrice, accepted: b.qtyAccepted, effectiveOrdered: bal.effectiveOrdered, remaining: bal.remaining, status: l.status };
        }),
        po,
      );
      const links = await db.invoiceOrderLink.findMany({ where: { poId: po.id, invoice: { status: { not: 'CANCELLED' } } }, include: { invoice: { select: { amount: true, taxAmount: true, _count: { select: { orders: true } } } } } });
      const cumulative = sumD(links.map((l) => l.amount ?? (l.invoice._count.orders === 1 ? D(l.invoice.amount).plus(l.invoice.taxAmount) : 0)));
      orders.push({
        poId: po.id,
        number: po.number,
        poStatus: po.status,
        currency: po.currency,
        orderedTotal: round2(po.totalAmount),
        receivedValue: received,
        invoicedCumulative: inv.status === 'CANCELLED' ? cumulative.plus(link.amount ?? gross) : cumulative,
        thisInvoice: link.amount ?? gross,
      });
    }
    const result = suggestInvoiceMatch(inv.currency, orders);
    return {
      ...result,
      invoiceGross: fmtMoney(gross),
      orders: orders.map((o) => ({
        ...o,
        orderedTotal: fmtMoney(o.orderedTotal),
        receivedValue: fmtMoney(o.receivedValue),
        invoicedCumulative: fmtMoney(o.invoicedCumulative),
        thisInvoice: fmtMoney(o.thisInvoice),
      })),
      note: 'Aucune conversion de devise. La facture ne clôt jamais un BC et ne modifie pas son statut de réception (PUR-07).',
    };
  }

  async create(ctx: AuthContext, dto: CreateInvoiceDto) {
    const supplier = await this.prisma.supplier.findUnique({ where: { id: dto.supplierId } });
    if (!supplier) throw Errors.validation('Fournisseur introuvable');
    const poIds = dto.orders.map((o) => o.poId);
    if (new Set(poIds).size !== poIds.length) throw Errors.validation('BC cité deux fois');
    const pos = [];
    for (const id of poIds) {
      const po = await this.core.findPo(ctx, id);
      if (po.supplierId !== dto.supplierId) throw Errors.validation(`BC ${po.number} d’un autre fournisseur`);
      if (['DRAFT', 'APPROVAL_PENDING', 'CANCELLED'].includes(po.status)) throw Errors.invalidState(`BC ${po.number} au statut ${po.status} : facture non rattachable`);
      pos.push(po);
    }
    const vessels = new Set(pos.map((p) => p.vesselId));
    if (vessels.size > 1) throw Errors.validation('Une facture se rattache à des BC d’un même navire (scope)');
    const gross = D(dto.amount).plus(D(dto.taxAmount));
    if (dto.orders.length > 1) {
      if (dto.orders.some((o) => o.amount === undefined)) throw Errors.validation('Plusieurs BC : montant imputé requis pour chacun');
      const sum = sumD(dto.orders.map((o) => o.amount));
      if (!sum.equals(gross)) throw Errors.validation(`Somme des montants imputés (${fmtMoney(sum)}) ≠ montant TTC (${fmtMoney(gross)})`);
    }
    const dup = await this.prisma.invoice.findUnique({ where: { supplierId_number: { supplierId: dto.supplierId, number: dto.number } }, select: { id: true } });
    if (dup) throw Errors.duplicate(`Facture n° ${dto.number} déjà enregistrée pour ce fournisseur`);
    const vesselId = pos[0].vesselId;
    const created = await this.prisma.$transaction(async (tx) => {
      const inv = await tx.invoice.create({
        data: {
          supplierId: dto.supplierId,
          vesselId,
          number: dto.number,
          invoiceDate: dto.invoiceDate,
          dueDate: dto.dueDate ?? null,
          currency: dto.currency,
          amount: dto.amount,
          taxAmount: dto.taxAmount,
          reviewNotes: dto.reviewNotes ?? null,
          createdById: ctx.userId,
          orders: { create: dto.orders.map((o) => ({ poId: o.poId, amount: o.amount ?? (dto.orders.length === 1 ? gross : null) })) },
        },
        include: { orders: true },
      });
      if (dto.fileId) {
        await this.core.addAttachmentTx(ctx, 'INVOICE', inv.id, vesselId, dto.fileId, `Facture ${dto.number} (original)`, tx);
        await tx.invoice.update({ where: { id: inv.id }, data: { fileId: dto.fileId } });
      }
      const matching = await this.matching(inv.id, tx);
      await this.core.audit(ctx, { action: 'invoice.recorded', entityType: 'invoice', entityId: inv.id, vesselId, after: inv, metadata: { matching: { suggestion: matching.suggestion, reasons: matching.reasons } } }, tx);
      if (matching.suggestion === 'DISPUTED') {
        // Écart de rapprochement reporté au département Achats (V1 §9.1 « Facture ≠ livraison »)
        const managers = await this.access.usersWithPermission('invoice.manage', vesselId, tx);
        await this.notifications.notify(
          {
            userIds: managers,
            excludeUserIds: [ctx.userId],
            type: 'purchasing.invoice_disputed',
            title: `Facture ${dto.number} (${supplier.name}) : écart de rapprochement`,
            body: `Motifs : ${invoiceMatchReasonsText(matching.reasons)}.`,
            module: 'purchasing',
            entityType: 'invoice',
            entityId: inv.id,
            vesselId,
            link: LINKS.invoice(inv.id),
            priority: 'HIGH',
            dedupeKey: `invoice:${inv.id}:disputed`,
            email: true,
            requiredPermission: 'invoice.view',
          },
          tx,
        );
      }
      return inv;
    });
    return this.get(ctx, created.id);
  }

  /** Revue de facture : MATCHED contre une suggestion DISPUTED exige une justification ; aucun effet sur le BC. */
  async setStatus(ctx: AuthContext, id: string, dto: InvoiceStatusDto) {
    return this.prisma.$transaction(async (tx) => {
      const inv = await this.find(ctx, id, tx);
      assertTransition(INVOICE_TRANSITIONS, inv.status, dto.status, 'Facture');
      // Annulation et litige : motif obligatoire, comme dans l'interface (audit ACH-12)
      if ((dto.status === 'CANCELLED' || dto.status === 'DISPUTED') && !dto.notes) {
        throw Errors.validation(dto.status === 'CANCELLED' ? 'Motif d’annulation obligatoire' : 'Motif du litige obligatoire', { field: 'notes' });
      }
      if (dto.status === 'APPROVED') {
        // Séparation des tâches : ni l'auteur de la facture, ni celui qui l'a rapprochée (MATCHED) ne l'approuve
        if (inv.createdById === ctx.userId) throw Errors.selfApproval();
        const matchedBy = await tx.auditEvent.findFirst({
          where: { module: 'purchasing', entityType: 'invoice', entityId: id, action: 'invoice.status_changed', after: { path: ['status'], equals: 'MATCHED' } },
          orderBy: { occurredAt: 'desc' },
          select: { actorId: true },
        });
        if (matchedBy?.actorId === ctx.userId) throw Errors.selfApproval();
      }
      const matching = await this.matching(id, tx);
      if (dto.status === 'MATCHED' && matching.suggestion === 'DISPUTED' && !dto.notes) {
        throw Errors.validation(`Rapprochement en écart (${invoiceMatchReasonsText(matching.reasons)}) : justification requise pour valider`, { field: 'notes' });
      }
      const res = await tx.invoice.updateMany({
        where: { id, status: inv.status },
        data: { status: dto.status, ...(dto.notes ? { reviewNotes: [inv.reviewNotes, `[${dto.status}] ${dto.notes}`].filter(Boolean).join('\n') } : {}) },
      });
      if (!res.count) throw Errors.staleVersion();
      await this.core.audit(
        ctx,
        { action: 'invoice.status_changed', entityType: 'invoice', entityId: id, vesselId: inv.vesselId, before: { status: inv.status }, after: { status: dto.status }, metadata: { notes: dto.notes, suggestion: matching.suggestion, reasons: matching.reasons } },
        tx,
      );
      return tx.invoice.findUniqueOrThrow({ where: { id }, include: { orders: true } });
    });
  }
}
