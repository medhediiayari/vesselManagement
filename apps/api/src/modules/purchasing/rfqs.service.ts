import { Injectable } from '@nestjs/common';
import { Prisma, RfqStatus } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { NumberingService } from '../documents/numbering.service';
import { toFileDto } from '../files/files.service';
import { PurchasingCore } from './purchasing-core.service';
import { OWNER_RFQ_PDF } from './purchasing.constants';
import {
  PR_SOURCEABLE_STATUSES,
  RFQ_TRANSITIONS,
  assertTransition,
  effectiveQuantity,
  fmtQty,
  max0,
} from './purchasing.logic';
import { AddRfqSuppliersDto, CreateRfqDto, ListRfqQuery, MarkRfqSentDto, RfqReasonDto, RfqStatsQuery, UpdateRfqDto } from './rfqs.dto';
import { escapeLike } from '../../common/utils/like';

/**
 * RFQ (CDC §6.5) : créée à partir de lignes PR (une ou plusieurs PR compatibles d'un même navire),
 * fournisseurs consultés, date limite, conditions, pièces. La plateforme n'envoie AUCUN e-mail aux fournisseurs
 * (décision AMC du 23/10/2026) : l'acheteur les contacte lui-même, peut noter ce contact (canal MANUAL, attribué
 * et audité) et saisit directement les devis reçus.
 */
@Injectable()
export class RfqsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly numbering: NumberingService,
  ) {}

  async list(ctx: AuthContext, q: ListRfqQuery) {
    const where: Prisma.RfqWhereInput = {
      AND: [
        vesselWhere(ctx) as Prisma.RfqWhereInput,
        this.core.rfqOwnWhere(ctx),
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.status?.length ? { status: { in: q.status } } : {},
        q.prId ? { lines: { some: { prLine: { prId: q.prId } } } } : {},
        q.supplierId ? { suppliers: { some: { supplierId: q.supplierId } } } : {},
        q.search
          ? { OR: [{ number: { contains: escapeLike(q.search), mode: 'insensitive' } }, { title: { contains: escapeLike(q.search), mode: 'insensitive' } }] }
          : {},
        q.from ? { createdAt: { gte: q.from } } : {},
        q.to ? { createdAt: { lt: new Date(q.to.getTime() + 86_400_000) } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.rfq.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          vessel: { select: { id: true, code: true, name: true } },
          _count: { select: { lines: true, quotations: true } },
          suppliers: { select: { supplierId: true, status: true, supplier: { select: { name: true } } } },
          // PR d'origine (numéros) et devis actifs (hors retirés)
          lines: { select: { prLine: { select: { pr: { select: { id: true, number: true } } } } } },
          quotations: { where: { status: { not: 'WITHDRAWN' } }, select: { id: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.rfq.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    const ids = page.items.map((r) => r.id);
    const [names, withPo] = await Promise.all([
      this.core.userNames(page.items.map((r) => r.createdById)),
      ids.length
        ? this.prisma.purchaseOrder.findMany({
            where: { status: { not: 'CANCELLED' }, quotation: { rfqId: { in: ids } } },
            select: { quotation: { select: { rfqId: true } } },
          })
        : Promise.resolve([]),
    ]);
    const converted = new Set(withPo.map((p) => p.quotation?.rfqId));
    return {
      ...page,
      items: page.items.map(({ lines, quotations, ...r }) => ({
        ...r,
        createdByName: names.get(r.createdById) ?? null,
        prs: [...new Map(lines.filter((l) => l.prLine).map((l) => [l.prLine!.pr.id, l.prLine!.pr])).values()],
        quotationsReceived: quotations.length,
        hasPurchaseOrder: converted.has(r.id),
      })),
    };
  }

  /** Tuiles de la liste : même périmètre navire que la liste. */
  async stats(ctx: AuthContext, q: RfqStatsQuery) {
    const where: Prisma.RfqWhereInput = { AND: [vesselWhere(ctx) as Prisma.RfqWhereInput, this.core.rfqOwnWhere(ctx), q.vesselId ? { vesselId: q.vesselId } : {}] };
    const [groups, toFollowUp, withPurchaseOrder] = await Promise.all([
      this.prisma.rfq.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.rfq.count({ where: { AND: [where, { status: 'ISSUED', deadline: { lt: new Date() } }] } }),
      this.prisma.rfq.count({ where: { AND: [where, { quotations: { some: { orders: { some: { status: { not: 'CANCELLED' } } } } } }] } }),
    ]);
    return {
      total: groups.reduce((n, g) => n + g._count._all, 0),
      byStatus: Object.fromEntries(groups.map((g) => [g.status, g._count._all])),
      toFollowUp,
      withPurchaseOrder,
    };
  }

  async get(ctx: AuthContext, id: string) {
    await this.core.findRfq(ctx, id);
    const rfq = await this.prisma.rfq.findUniqueOrThrow({
      where: { id },
      include: {
        vessel: { select: { id: true, code: true, name: true, imoNumber: true, vesselType: true, photoFileId: true } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { prLine: { select: { id: true, lineNo: true, prId: true, pr: { select: { number: true, status: true } } } } },
        },
        suppliers: { include: { supplier: { select: { id: true, code: true, name: true, email: true, currency: true, isActive: true } } } },
      },
    });
    const sentFiles = await this.prisma.storedFile.findMany({ where: { ownerType: OWNER_RFQ_PDF, ownerId: { in: rfq.suppliers.map((s) => s.id) } }, orderBy: { createdAt: 'desc' } });
    const quotations = can(ctx, 'quotation.view')
      ? await this.prisma.quotation.findMany({
          where: { rfqId: id },
          orderBy: { receivedAt: 'asc' },
          select: { id: true, supplierId: true, reference: true, currency: true, subtotal: true, totalAmount: true, status: true, receivedAt: true, validUntil: true, freightAmount: true, taxAmount: true, discountAmount: true },
        })
      : undefined;
    const names = await this.core.userNames([rfq.createdById]);
    return {
      ...rfq,
      createdByName: names.get(rfq.createdById) ?? null,
      suppliers: rfq.suppliers.map((s) => ({
        ...s,
        sendError: s.sendError,
        sentDocuments: sentFiles.filter((f) => f.ownerId === s.id).map(toFileDto),
      })),
      quotations,
      attachments: await this.core.attachmentsOf('RFQ', [id]),
    };
  }

  /** Date limite de réponse : jamais dans le passé (date seule = fin de journée UTC) — audit ACH-11. */
  private assertDeadline(deadline: Date | null | undefined) {
    if (deadline && deadline.getTime() < Date.now()) throw Errors.validation('La date limite de réponse ne peut pas être dans le passé', { field: 'deadline' });
  }

  async create(ctx: AuthContext, dto: CreateRfqDto) {
    this.assertDeadline(dto.deadline);
    const ids = dto.lines.map((l) => l.prLineId);
    if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne PR citée deux fois');
    const prLines = await this.prisma.prLine.findMany({ where: { id: { in: ids } }, include: { pr: { select: { id: true, number: true, vesselId: true, status: true } } } });
    if (prLines.length !== ids.length) throw Errors.validation('Ligne PR introuvable');
    const vesselIds = new Set(prLines.map((l) => l.pr.vesselId));
    if (vesselIds.size !== 1) throw Errors.validation('Une RFQ ne regroupe que des PR d’un même navire');
    const vessel = await this.core.vesselForWrite(ctx, [...vesselIds][0]);
    for (const l of prLines) {
      if (!PR_SOURCEABLE_STATUSES.includes(l.pr.status)) throw Errors.invalidState(`PR ${l.pr.number} au statut ${l.pr.status} : consultation impossible`);
      if (l.status === 'CANCELLED') throw Errors.business(`PR ${l.pr.number} ligne ${l.lineNo} annulée`);
    }
    const allocated = await this.core.allocatedByPrLine(ids);
    const suppliers = await this.assertSuppliers(dto.supplierIds);
    return this.prisma.$transaction(async (tx) => {
      const number = await this.numbering.nextFormatted('RFQ', vessel.code, tx);
      const rfq = await tx.rfq.create({
        data: {
          number,
          vesselId: vessel.id,
          title: dto.title,
          deadline: dto.deadline ?? null,
          deliveryPort: dto.deliveryPort ?? null,
          deliveryTerms: dto.deliveryTerms ?? null,
          notes: dto.notes ?? null,
          createdById: ctx.userId,
          lines: {
            create: dto.lines.map((input, i) => {
              const l = prLines.find((x) => x.id === input.prLineId)!;
              const open = max0(effectiveQuantity(l).minus(allocated.get(l.id) ?? 0));
              const quantity = input.quantity ?? open.toString();
              if (!open.greaterThan(0) && !input.quantity) throw Errors.business(`PR ${l.pr.number} ligne ${l.lineNo} : plus rien à commander`);
              return {
                lineNo: i + 1,
                prLineId: l.id,
                designation: l.designation,
                reference: l.reference,
                quantity,
                unit: l.unit,
                remarks: input.remarks ?? l.remarks,
              };
            }),
          },
          suppliers: { create: suppliers.map((s) => ({ supplierId: s.id })) },
        },
        include: { lines: true, suppliers: true },
      });
      await this.core.audit(ctx, { action: 'rfq.created', entityType: 'rfq', entityId: rfq.id, vesselId: rfq.vesselId, after: rfq, metadata: { prIds: [...new Set(prLines.map((l) => l.pr.id))] } }, tx);
      return rfq;
    });
  }

  private async assertSuppliers(ids: string[]) {
    if (!ids.length) return [];
    const unique = [...new Set(ids)];
    const rows = await this.prisma.supplier.findMany({ where: { id: { in: unique } } });
    if (rows.length !== unique.length) throw Errors.validation('Fournisseur introuvable');
    const inactive = rows.filter((s) => !s.isActive);
    if (inactive.length) throw Errors.business(`Fournisseur inactif : ${inactive.map((s) => s.name).join(', ')}`);
    return rows;
  }

  async update(ctx: AuthContext, id: string, dto: UpdateRfqDto) {
    const before = await this.core.findRfq(ctx, id);
    if (before.status !== 'DRAFT') throw Errors.invalidState('RFQ émise : modification impossible');
    // Seule une date limite modifiée est contrôlée (un brouillon ancien reste modifiable sur ses autres champs)
    if (dto.deadline && dto.deadline.getTime() !== before.deadline?.getTime()) this.assertDeadline(dto.deadline);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.rfq.updateMany({ where: { id, status: 'DRAFT' }, data: dto as Prisma.RfqUncheckedUpdateManyInput });
      if (!res.count) throw Errors.staleVersion();
      const after = await tx.rfq.findUniqueOrThrow({ where: { id } });
      await this.core.audit(ctx, { action: 'rfq.updated', entityType: 'rfq', entityId: id, vesselId: before.vesselId, before, after }, tx);
      return after;
    });
  }

  async addSuppliers(ctx: AuthContext, id: string, dto: AddRfqSuppliersDto) {
    const rfq = await this.core.findRfq(ctx, id);
    if (!['DRAFT', 'ISSUED', 'QUOTED'].includes(rfq.status)) throw Errors.invalidState(`RFQ ${rfq.status} : ajout de fournisseur impossible`);
    const suppliers = await this.assertSuppliers(dto.supplierIds);
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.rfqSupplier.findMany({ where: { rfqId: id }, select: { supplierId: true } });
      const toAdd = suppliers.filter((s) => !existing.some((e) => e.supplierId === s.id));
      if (toAdd.length) await tx.rfqSupplier.createMany({ data: toAdd.map((s) => ({ rfqId: id, supplierId: s.id })) });
      await this.core.audit(ctx, { action: 'rfq.suppliers_added', entityType: 'rfq', entityId: id, vesselId: rfq.vesselId, after: { supplierIds: toAdd.map((s) => s.id) } }, tx);
      return tx.rfqSupplier.findMany({ where: { rfqId: id }, include: { supplier: { select: { id: true, name: true, email: true } } } });
    });
  }

  async removeSupplier(ctx: AuthContext, id: string, supplierId: string) {
    const rfq = await this.core.findRfq(ctx, id);
    const rs = await this.prisma.rfqSupplier.findUnique({ where: { rfqId_supplierId: { rfqId: id, supplierId } } });
    if (!rs) throw Errors.notFound('Fournisseur consulté');
    if (rs.status === 'SENT' || rs.status === 'QUOTED' || rs.sentAt) throw Errors.business('RFQ déjà transmise à ce fournisseur : retrait impossible (utilisez « décliné »)');
    return this.prisma.$transaction(async (tx) => {
      await tx.rfqSupplier.delete({ where: { id: rs.id } });
      await this.core.audit(ctx, { action: 'rfq.supplier_removed', entityType: 'rfq', entityId: id, vesselId: rfq.vesselId, before: rs }, tx);
      return { removed: true, supplierId };
    });
  }

  /** DRAFT → ISSUED (premier fournisseur contacté) + statut des PR : APPROVED → SOURCING, SUBMITTED → UNDER_REVIEW. */
  private async markIssued(ctx: AuthContext, id: string, action: string) {
    await this.prisma.$transaction(async (tx) => {
      const rfq = await tx.rfq.findUniqueOrThrow({ where: { id } });
      if (rfq.status === 'DRAFT') {
        const res = await tx.rfq.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'ISSUED', issuedAt: new Date() } });
        if (res.count) {
          await this.core.audit(ctx, { action, entityType: 'rfq', entityId: id, vesselId: rfq.vesselId, before: { status: 'DRAFT' }, after: { status: 'ISSUED' } }, tx);
        }
      }
      await this.syncPrStatuses(ctx, id, tx, 'rfq.issued');
    });
  }

  private async syncPrStatuses(ctx: AuthContext, rfqId: string, tx: Tx, trigger: string) {
    const prs = await tx.purchaseRequest.findMany({ where: { lines: { some: { rfqLines: { some: { rfqId } } } } }, select: { id: true, status: true, vesselId: true } });
    for (const pr of prs) {
      if (pr.status === 'SUBMITTED' && trigger === 'rfq.issued') {
        await tx.purchaseRequest.update({ where: { id: pr.id }, data: { status: 'UNDER_REVIEW', lockVersion: { increment: 1 } } });
        await this.core.audit(
          ctx,
          { action: 'pr.review_started', entityType: 'purchase_request', entityId: pr.id, vesselId: pr.vesselId, before: { status: 'SUBMITTED' }, after: { status: 'UNDER_REVIEW' }, metadata: { trigger, rfqId } },
          tx,
        );
      }
    }
    await this.core.recomputePrStatuses(ctx, prs.map((p) => p.id), tx, trigger);
  }

  async markSent(ctx: AuthContext, id: string, supplierId: string, dto: MarkRfqSentDto) {
    const rfq = await this.core.findRfq(ctx, id);
    if (!['DRAFT', 'ISSUED', 'QUOTED'].includes(rfq.status)) throw Errors.invalidState(`RFQ ${rfq.status}`);
    const rs = await this.prisma.rfqSupplier.findUnique({ where: { rfqId_supplierId: { rfqId: id, supplierId } } });
    if (!rs) throw Errors.notFound('Fournisseur consulté');
    if (rs.status === 'SENT' || rs.status === 'QUOTED') throw Errors.alreadyProcessed('RFQ déjà transmise à ce fournisseur');
    await this.prisma.$transaction(async (tx) => {
      await tx.rfqSupplier.update({ where: { id: rs.id }, data: { status: 'SENT', sentTo: `MANUEL : ${dto.recipient}`.slice(0, 320), sentAt: new Date(), sendError: null } });
      await this.core.audit(
        ctx,
        {
          action: 'rfq.marked_sent',
          entityType: 'rfq',
          entityId: id,
          vesselId: rfq.vesselId,
          before: { status: rs.status },
          after: { status: 'SENT' },
          metadata: { supplierId, channel: dto.channel, recipient: dto.recipient, note: dto.note, declaredBy: ctx.userId },
        },
        tx,
      );
    });
    await this.markIssued(ctx, id, 'rfq.issued');
    return this.prisma.rfqSupplier.findUniqueOrThrow({ where: { id: rs.id } });
  }

  async decline(ctx: AuthContext, id: string, supplierId: string, comment?: string | null) {
    const rfq = await this.core.findRfq(ctx, id);
    const rs = await this.prisma.rfqSupplier.findUnique({ where: { rfqId_supplierId: { rfqId: id, supplierId } } });
    if (!rs) throw Errors.notFound('Fournisseur consulté');
    if (rs.status === 'QUOTED' || rs.status === 'DECLINED') throw Errors.invalidState(`Fournisseur au statut ${rs.status}`);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.rfqSupplier.update({ where: { id: rs.id }, data: { status: 'DECLINED' } });
      await this.core.audit(ctx, { action: 'rfq.supplier_declined', entityType: 'rfq', entityId: id, vesselId: rfq.vesselId, before: { status: rs.status }, after: { status: 'DECLINED' }, metadata: { supplierId, comment } }, tx);
      return after;
    });
  }

  async close(ctx: AuthContext, id: string, comment?: string | null) {
    return this.transition(ctx, id, 'CLOSED', 'rfq.closed', comment ?? null);
  }

  async cancel(ctx: AuthContext, id: string, dto: RfqReasonDto) {
    return this.transition(ctx, id, 'CANCELLED', 'rfq.cancelled', dto.reason, async (tx) => {
      // Dans la même transaction sérialisable que le changement d'état : pas de BC créé entre contrôle et annulation
      const qlIds = (await tx.quotationLine.findMany({ where: { quotation: { rfqId: id } }, select: { id: true } })).map((q) => q.id);
      const used = await tx.purchaseOrder.count({
        where: { status: { not: 'CANCELLED' }, OR: [{ quotation: { rfqId: id } }, { lines: { some: { quotationLineId: { in: qlIds } } } }] },
      });
      if (used) throw Errors.business('Des bons de commande actifs découlent de cette RFQ : annulation impossible');
    });
  }

  private async transition(ctx: AuthContext, id: string, to: RfqStatus, action: string, comment: string | null, guard?: (tx: Tx) => Promise<void>) {
    return this.core.serializable(async (tx) => {
      const rfq = await this.core.findRfq(ctx, id, tx);
      assertTransition(RFQ_TRANSITIONS, rfq.status, to, 'RFQ');
      if (guard) await guard(tx);
      const res = await tx.rfq.updateMany({ where: { id, status: rfq.status }, data: { status: to } });
      if (!res.count) throw Errors.staleVersion();
      await this.core.audit(ctx, { action, entityType: 'rfq', entityId: id, vesselId: rfq.vesselId, before: { status: rfq.status }, after: { status: to }, metadata: { comment } }, tx);
      await this.syncPrStatuses(ctx, id, tx, action);
      return tx.rfq.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Lignes RFQ avec quantité restante à commander côté PR (aide à la saisie). */
  async openQuantities(ctx: AuthContext, id: string) {
    await this.core.findRfq(ctx, id);
    const lines = await this.prisma.rfqLine.findMany({ where: { rfqId: id }, include: { prLine: true }, orderBy: { lineNo: 'asc' } });
    const allocated = await this.core.allocatedByPrLine(lines.map((l) => l.prLineId).filter((x): x is string => !!x));
    return lines.map((l) => ({
      rfqLineId: l.id,
      lineNo: l.lineNo,
      prLineId: l.prLineId,
      quantity: fmtQty(l.quantity),
      prOpenQuantity: l.prLine ? fmtQty(max0(effectiveQuantity(l.prLine).minus(allocated.get(l.prLine.id) ?? 0))) : null,
    }));
  }
}
