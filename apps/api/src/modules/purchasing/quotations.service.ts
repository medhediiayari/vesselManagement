import { Injectable } from '@nestjs/common';
import { Prisma, QuotationStatus } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { PurchasingCore } from './purchasing-core.service';
import {
  D,
  cheapestPerCurrency,
  computeQuotationTotals,
  coverage,
  fmtMoney,
  fmtQty,
  sumD,
} from './purchasing.logic';
import { CreateSelectionsDto, RecordQuotationDto, WithdrawQuotationDto, WithdrawSelectionDto } from './quotations.dto';

/**
 * Devis fournisseurs et comparaison (CDC §6.5) : un devis n'est jamais écrasé (correction = retrait + nouveau),
 * le PDF original est conservé ; la comparaison ne convertit jamais de devise (totaux groupés par devise) ;
 * la sélection est une commande distincte (quotation.evaluate) avec justification.
 */
@Injectable()
export class QuotationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
  ) {}

  async record(ctx: AuthContext, rfqId: string, dto: RecordQuotationDto) {
    const totals = computeQuotationTotals(
      dto.lines.map((l) => ({ isAvailable: l.isAvailable, quantityOffered: l.quantityOffered ?? null, unitPrice: l.unitPrice ?? null })),
      { freight: dto.freightAmount, tax: dto.taxAmount, discount: dto.discountAmount },
    );
    // Contrôles + création atomiques (un seul devis actif par fournisseur, même en concurrence)
    return this.core.serializable(async (tx) => {
      const rfq = await this.core.findRfq(ctx, rfqId, tx);
      // Fournisseurs contactés hors plateforme (téléphone, e-mail personnel…) : un devis peut être saisi sur une RFQ
      // non émise — la consultation est alors réputée faite (tracée), sans envoi obligatoire depuis la plateforme.
      if (!['DRAFT', 'ISSUED', 'QUOTED', 'EVALUATED'].includes(rfq.status)) throw Errors.invalidState(`RFQ ${rfq.status} : saisie de devis impossible (RFQ close ou annulée)`);
      const rs = await tx.rfqSupplier.findUnique({ where: { rfqId_supplierId: { rfqId, supplierId: dto.supplierId } } });
      if (!rs) throw Errors.business('Ce fournisseur n’a pas été consulté sur cette RFQ');
      await tx.$queryRaw`SELECT id FROM rfq_suppliers WHERE id = ${rs.id}::uuid FOR UPDATE`;
      const active = await tx.quotation.findFirst({ where: { rfqId, supplierId: dto.supplierId, status: { not: 'WITHDRAWN' } }, select: { id: true } });
      if (active) throw Errors.conflict('Un devis actif existe déjà pour ce fournisseur : retirez-le avant d’en saisir un nouveau (jamais d’écrasement)', { quotationId: active.id });
      const rfqLines = await tx.rfqLine.findMany({ where: { rfqId } });
      const ids = dto.lines.map((l) => l.rfqLineId);
      if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne RFQ citée deux fois');
      for (const id of ids) if (!rfqLines.some((l) => l.id === id)) throw Errors.validation('Ligne RFQ inconnue', { rfqLineId: id });
      const q = await tx.quotation.create({
        data: {
          rfqId,
          supplierId: dto.supplierId,
          reference: dto.reference ?? null,
          receivedAt: dto.receivedAt ?? new Date(),
          currency: dto.currency,
          validUntil: dto.validUntil ?? null,
          leadTimeDays: dto.leadTimeDays ?? null,
          incoterm: dto.incoterm ?? null,
          deliveryTerms: dto.deliveryTerms ?? null,
          paymentTerms: dto.paymentTerms ?? null,
          freightAmount: dto.freightAmount ?? null,
          taxAmount: dto.taxAmount ?? null,
          discountAmount: dto.discountAmount ?? null,
          subtotal: totals.subtotal,
          totalAmount: totals.total,
          comments: dto.comments ?? null,
          createdById: ctx.userId,
          lines: {
            create: dto.lines.map((l, i) => ({
              rfqLineId: l.rfqLineId,
              isAvailable: l.isAvailable,
              quantityOffered: l.quantityOffered ?? null,
              unit: l.unit ?? rfqLines.find((r) => r.id === l.rfqLineId)!.unit,
              unitPrice: l.unitPrice ?? null,
              lineTotal: totals.lineTotals[i],
              leadTimeDays: l.leadTimeDays ?? null,
              compliance: l.compliance,
              remarks: l.remarks ?? null,
            })),
          },
        },
        include: { lines: true },
      });
      if (dto.fileId) {
        await this.core.addAttachmentTx(ctx, 'QUOTATION', q.id, rfq.vesselId, dto.fileId, 'Devis original (PDF fournisseur)', tx);
        await tx.quotation.update({ where: { id: q.id }, data: { fileId: dto.fileId } });
      }
      const contactedOutside = rs.status === 'PENDING' || rs.status === 'SEND_FAILED' || rs.status === 'DECLINED';
      await tx.rfqSupplier.update({
        where: { id: rs.id },
        data: { status: 'QUOTED', ...(contactedOutside && !rs.sentAt ? { sentTo: 'MANUEL : devis reçu hors plateforme', sentAt: new Date(), sendError: null } : {}) },
      });
      if (contactedOutside) {
        await this.core.audit(
          ctx,
          { action: 'rfq.marked_sent', entityType: 'rfq', entityId: rfqId, vesselId: rfq.vesselId, before: { status: rs.status }, after: { status: 'QUOTED' }, metadata: { supplierId: dto.supplierId, channel: 'MANUAL', implicit: true, reason: 'Devis reçu hors plateforme' } },
          tx,
        );
      }
      if (rfq.status === 'DRAFT') {
        await tx.rfq.updateMany({ where: { id: rfqId, status: 'DRAFT' }, data: { status: 'QUOTED', issuedAt: new Date() } });
        await this.core.audit(ctx, { action: 'rfq.issued', entityType: 'rfq', entityId: rfqId, vesselId: rfq.vesselId, before: { status: 'DRAFT' }, after: { status: 'QUOTED' }, metadata: { trigger: 'quotation.recorded' } }, tx);
        const prs = await tx.purchaseRequest.findMany({ where: { lines: { some: { rfqLines: { some: { rfqId } } } } }, select: { id: true } });
        await this.core.recomputePrStatuses(ctx, prs.map((p) => p.id), tx, 'rfq.issued');
      }
      if (rfq.status === 'ISSUED') await tx.rfq.updateMany({ where: { id: rfqId, status: 'ISSUED' }, data: { status: 'QUOTED' } });
      await this.core.audit(
        ctx,
        { action: 'quotation.recorded', entityType: 'quotation', entityId: q.id, vesselId: rfq.vesselId, after: q, metadata: { rfqId, rfqStatusBefore: rfq.status } },
        tx,
      );
      return tx.quotation.findUniqueOrThrow({ where: { id: q.id }, include: { lines: true } });
    });
  }

  private async findQuotation(ctx: AuthContext, id: string, db: Tx | PrismaService = this.prisma) {
    const q = await db.quotation.findUnique({ where: { id }, include: { rfq: { select: { id: true, vesselId: true, status: true, number: true } } } });
    if (!q) throw Errors.notFound('Devis');
    await this.core.findRfq(ctx, q.rfqId, db);
    return q;
  }

  async get(ctx: AuthContext, id: string) {
    await this.findQuotation(ctx, id);
    const q = await this.prisma.quotation.findUniqueOrThrow({
      where: { id },
      include: {
        rfq: { select: { id: true, number: true, title: true, status: true, vesselId: true } },
        supplier: { select: { id: true, code: true, name: true, currency: true } },
        lines: { include: { rfqLine: true, selections: { orderBy: { selectedAt: 'asc' } } } },
      },
    });
    return { ...q, attachments: await this.core.attachmentsOf('QUOTATION', [id]) };
  }

  async listForRfq(ctx: AuthContext, rfqId: string) {
    await this.core.findRfq(ctx, rfqId);
    return this.prisma.quotation.findMany({
      where: { rfqId },
      orderBy: { receivedAt: 'asc' },
      include: { supplier: { select: { id: true, code: true, name: true } }, lines: true },
    });
  }

  async withdraw(ctx: AuthContext, id: string, dto: WithdrawQuotationDto) {
    return this.core.serializable(async (tx) => {
      const q = await this.findQuotation(ctx, id, tx);
      if (q.status === 'WITHDRAWN') throw Errors.alreadyProcessed('Devis déjà retiré');
      const used = await tx.poLine.count({
        where: { status: { not: 'CANCELLED' }, po: { status: { not: 'CANCELLED' } }, OR: [{ quotationLineId: { in: (await tx.quotationLine.findMany({ where: { quotationId: id }, select: { id: true } })).map((l) => l.id) } }, { po: { quotationId: id } }] },
      });
      if (used) throw Errors.business('Devis utilisé par un bon de commande actif : retrait impossible');
      const now = new Date();
      await tx.quotationSelection.updateMany({ where: { quotationLine: { quotationId: id }, withdrawnAt: null }, data: { withdrawnAt: now } });
      const res = await tx.quotation.updateMany({ where: { id, status: { not: 'WITHDRAWN' } }, data: { status: 'WITHDRAWN', evaluationNote: `Retiré : ${dto.reason}` } });
      if (!res.count) throw Errors.alreadyProcessed('Devis déjà retiré');
      const others = await tx.quotation.count({ where: { rfqId: q.rfqId, supplierId: q.supplierId, status: { not: 'WITHDRAWN' } } });
      if (!others) {
        const rs = await tx.rfqSupplier.findUnique({ where: { rfqId_supplierId: { rfqId: q.rfqId, supplierId: q.supplierId } } });
        if (rs?.status === 'QUOTED') await tx.rfqSupplier.update({ where: { id: rs.id }, data: { status: rs.sentAt ? 'SENT' : 'PENDING' } });
      }
      await this.refreshStatuses(tx, q.rfqId);
      await this.core.audit(ctx, { action: 'quotation.withdrawn', entityType: 'quotation', entityId: id, vesselId: q.rfq.vesselId, before: { status: q.status }, after: { status: 'WITHDRAWN' }, metadata: { reason: dto.reason } }, tx);
      return tx.quotation.findUniqueOrThrow({ where: { id } });
    });
  }

  /**
   * GET /rfqs/:id/comparison — par ligne RFQ : toutes les offres ; par devis : totaux dans SA devise,
   * couverture, délais, conformité, validité ; offre la moins chère par ligne signalée AU SEIN D'UNE MÊME DEVISE.
   * Aucun taux de change n'est inventé (CDC §6.5).
   */
  async comparison(ctx: AuthContext, rfqId: string) {
    const rfq = await this.core.findRfq(ctx, rfqId);
    const lines = await this.prisma.rfqLine.findMany({ where: { rfqId }, orderBy: { lineNo: 'asc' } });
    const quotations = await this.prisma.quotation.findMany({
      where: { rfqId, status: { not: 'WITHDRAWN' } },
      orderBy: { receivedAt: 'asc' },
      include: { supplier: { select: { id: true, code: true, name: true } }, lines: { include: { selections: { where: { withdrawnAt: null } } } } },
    });
    const allOffers = quotations.flatMap((q) => q.lines.map((l) => ({ ...l, currency: q.currency, quotationId: q.id })));
    // Moins cher PAR LIGNE RFQ et par devise
    const cheapest = new Set<string>();
    for (const l of lines) {
      const ids = cheapestPerCurrency(
        allOffers
          .filter((o) => o.rfqLineId === l.id)
          .map((o) => ({ quotationLineId: o.id, currency: o.currency, isAvailable: o.isAvailable, unitPrice: o.unitPrice, compliance: o.compliance })),
      );
      ids.forEach((id) => cheapest.add(id));
    }
    const today = new Date();

    const summaries = quotations.map((q) => {
      const cov = coverage(
        lines.map((l) => ({ id: l.id, quantity: l.quantity })),
        q.lines.map((l) => ({ rfqLineId: l.rfqLineId, isAvailable: l.isAvailable, unitPrice: l.unitPrice, quantityOffered: l.quantityOffered })),
      );
      const leadTimes = q.lines.map((l) => l.leadTimeDays ?? q.leadTimeDays).filter((x): x is number => x !== null && x !== undefined);
      return {
        quotationId: q.id,
        supplier: q.supplier,
        reference: q.reference,
        currency: q.currency,
        status: q.status,
        subtotal: fmtMoney(q.subtotal),
        freightAmount: q.freightAmount === null ? null : fmtMoney(q.freightAmount),
        taxAmount: q.taxAmount === null ? null : fmtMoney(q.taxAmount),
        discountAmount: q.discountAmount === null ? null : fmtMoney(q.discountAmount),
        totalAmount: fmtMoney(q.totalAmount),
        coverage: cov,
        leadTimeDays: q.leadTimeDays,
        maxLineLeadTimeDays: leadTimes.length ? Math.max(...leadTimes) : null,
        validUntil: q.validUntil,
        expired: !!q.validUntil && q.validUntil < new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
        incoterm: q.incoterm,
        paymentTerms: q.paymentTerms,
        deliveryTerms: q.deliveryTerms,
        hasOriginalFile: !!q.fileId,
        compliance: {
          compliant: q.lines.filter((l) => l.compliance === 'COMPLIANT').length,
          alternative: q.lines.filter((l) => l.compliance === 'ALTERNATIVE').length,
          nonCompliant: q.lines.filter((l) => l.compliance === 'NON_COMPLIANT').length,
        },
        cheapestLineCount: q.lines.filter((l) => cheapest.has(l.id)).length,
      };
    });

    const totalsByCurrency: Record<string, { quotationId: string; supplierName: string; totalAmount: string; coveragePercent: string; lowestTotal: boolean }[]> = {};
    for (const cur of [...new Set(quotations.map((q) => q.currency))].sort()) {
      const group = summaries.filter((s) => s.currency === cur).sort((a, b) => D(a.totalAmount).comparedTo(D(b.totalAmount)));
      totalsByCurrency[cur] = group.map((s, i) => ({
        quotationId: s.quotationId,
        supplierName: s.supplier.name,
        totalAmount: s.totalAmount,
        coveragePercent: s.coverage.percent,
        lowestTotal: i === 0 || D(s.totalAmount).equals(D(group[0].totalAmount)),
      }));
    }

    return {
      rfq: { id: rfq.id, number: rfq.number, title: rfq.title, status: rfq.status },
      currencies: Object.keys(totalsByCurrency),
      fxNote:
        Object.keys(totalsByCurrency).length > 1
          ? 'Devis en plusieurs devises : aucun taux de change n’est appliqué ; les totaux ne sont comparables qu’au sein d’une même devise.'
          : null,
      quotations: summaries,
      totalsByCurrency,
      lines: lines.map((l) => {
        const offers = allOffers.filter((o) => o.rfqLineId === l.id);
        const selected = sumD(offers.flatMap((o) => o.selections.map((s) => s.quantity)));
        return {
          rfqLineId: l.id,
          lineNo: l.lineNo,
          designation: l.designation,
          reference: l.reference,
          quantity: fmtQty(l.quantity),
          unit: l.unit,
          selectedQuantity: fmtQty(selected),
          offers: offers.map((o) => {
            const q = quotations.find((x) => x.id === o.quotationId)!;
            return {
              quotationId: o.quotationId,
              quotationLineId: o.id,
              supplierId: q.supplier.id,
              supplierName: q.supplier.name,
              currency: o.currency,
              isAvailable: o.isAvailable,
              quantityOffered: o.quantityOffered === null ? null : fmtQty(o.quantityOffered),
              unit: o.unit,
              unitPrice: o.unitPrice === null ? null : o.unitPrice.toString(),
              lineTotal: o.lineTotal === null ? null : fmtMoney(o.lineTotal),
              leadTimeDays: o.leadTimeDays ?? q.leadTimeDays,
              compliance: o.compliance,
              remarks: o.remarks,
              cheapestInCurrency: cheapest.has(o.id),
              selectedQuantity: fmtQty(sumD(o.selections.map((s) => s.quantity))),
            };
          }),
        };
      }),
    };
  }

  async listSelections(ctx: AuthContext, rfqId: string) {
    await this.core.findRfq(ctx, rfqId);
    const rows = await this.prisma.quotationSelection.findMany({
      where: { quotationLine: { quotation: { rfqId } } },
      orderBy: { selectedAt: 'asc' },
      include: { quotationLine: { select: { id: true, rfqLineId: true, unitPrice: true, unit: true, quotation: { select: { id: true, currency: true, supplier: { select: { id: true, name: true } } } } } } },
    });
    const names = await this.core.userNames(rows.map((r) => r.selectedById));
    return rows.map((r) => ({ ...r, selectedByName: names.get(r.selectedById) ?? null }));
  }

  /** POST /rfqs/:id/selections — choix fournisseur(s) par ligne, éventuellement réparti entre fournisseurs (PUR-03). */
  async select(ctx: AuthContext, rfqId: string, dto: CreateSelectionsDto) {
    return this.core.serializable(async (tx) => {
      const rfq = await this.core.findRfq(ctx, rfqId, tx);
      if (rfq.status !== 'QUOTED' && rfq.status !== 'EVALUATED') throw Errors.invalidState(`RFQ ${rfq.status} : sélection impossible`);
      const ids = dto.selections.map((s) => s.quotationLineId);
      if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne de devis citée deux fois');
      const qLines = await tx.quotationLine.findMany({
        where: { id: { in: ids } },
        include: { quotation: { select: { id: true, rfqId: true, status: true, validUntil: true, supplierId: true } }, rfqLine: true },
      });
      if (qLines.length !== ids.length) throw Errors.validation('Ligne de devis introuvable');
      const warnings: string[] = [];
      const today = new Date();
      for (const s of dto.selections) {
        const ql = qLines.find((x) => x.id === s.quotationLineId)!;
        if (ql.quotation.rfqId !== rfqId) throw Errors.validation('Ligne de devis d’une autre RFQ');
        if (ql.quotation.status === 'WITHDRAWN') throw Errors.business('Devis retiré : sélection impossible');
        if (!ql.isAvailable || ql.unitPrice === null) throw Errors.business(`Ligne ${ql.rfqLine.lineNo} : offre non disponible ou non chiffrée`);
        if (ql.quantityOffered !== null && D(s.quantity).greaterThan(ql.quantityOffered)) {
          throw Errors.business(`Ligne ${ql.rfqLine.lineNo} : quantité sélectionnée supérieure à la quantité offerte (${fmtQty(ql.quantityOffered)})`);
        }
        if (ql.compliance === 'NON_COMPLIANT') warnings.push(`Ligne ${ql.rfqLine.lineNo} : offre non conforme retenue (justification requise)`);
        if (ql.quotation.validUntil && ql.quotation.validUntil < today) warnings.push(`Ligne ${ql.rfqLine.lineNo} : devis expiré le ${ql.quotation.validUntil.toISOString().slice(0, 10)}`);
      }
      // Σ sélections actives par ligne RFQ ≤ quantité consultée
      const rfqLineIds = [...new Set(qLines.map((q) => q.rfqLineId))];
      for (const rfqLineId of rfqLineIds) {
        const rfqLine = qLines.find((q) => q.rfqLineId === rfqLineId)!.rfqLine;
        const existing = await tx.quotationSelection.findMany({ where: { withdrawnAt: null, quotationLine: { rfqLineId } }, select: { quantity: true } });
        const added = dto.selections.filter((s) => qLines.find((q) => q.id === s.quotationLineId)!.rfqLineId === rfqLineId).map((s) => s.quantity);
        const total = sumD([...existing.map((e) => e.quantity), ...added]);
        if (total.greaterThan(rfqLine.quantity)) {
          throw Errors.business(`Ligne ${rfqLine.lineNo} : sélection totale ${fmtQty(total)} > quantité consultée ${fmtQty(rfqLine.quantity)}`);
        }
      }
      const created = [];
      for (const s of dto.selections) {
        created.push(
          await tx.quotationSelection.create({
            data: { quotationLineId: s.quotationLineId, quantity: s.quantity, justification: dto.justification, selectedById: ctx.userId },
          }),
        );
      }
      await this.refreshStatuses(tx, rfqId);
      await this.core.audit(
        ctx,
        {
          action: 'rfq.selection_made',
          entityType: 'rfq',
          entityId: rfqId,
          vesselId: rfq.vesselId,
          before: { status: rfq.status },
          after: { selections: created.map((c) => ({ id: c.id, quotationLineId: c.quotationLineId, quantity: c.quantity })) },
          metadata: { justification: dto.justification, warnings },
        },
        tx,
      );
      return { selections: created, warnings, rfqStatus: (await tx.rfq.findUniqueOrThrow({ where: { id: rfqId }, select: { status: true } })).status };
    });
  }

  async withdrawSelection(ctx: AuthContext, rfqId: string, selectionId: string, dto: WithdrawSelectionDto) {
    return this.core.serializable(async (tx) => {
      const rfq = await this.core.findRfq(ctx, rfqId, tx);
      const sel = await tx.quotationSelection.findUnique({ where: { id: selectionId }, include: { quotationLine: { include: { quotation: true } } } });
      if (!sel || sel.quotationLine.quotation.rfqId !== rfqId) throw Errors.notFound('Sélection');
      if (sel.withdrawnAt) throw Errors.alreadyProcessed('Sélection déjà retirée');
      const used = await tx.poLine.count({ where: { quotationLineId: sel.quotationLineId, status: { not: 'CANCELLED' }, po: { status: { not: 'CANCELLED' } } } });
      if (used) throw Errors.business('Sélection déjà commandée (BC actif) : retrait impossible');
      const res = await tx.quotationSelection.updateMany({ where: { id: selectionId, withdrawnAt: null }, data: { withdrawnAt: new Date() } });
      if (!res.count) throw Errors.alreadyProcessed('Sélection déjà retirée');
      await this.refreshStatuses(tx, rfqId);
      await this.core.audit(ctx, { action: 'rfq.selection_withdrawn', entityType: 'rfq', entityId: rfqId, vesselId: rfq.vesselId, before: sel, metadata: { reason: dto.reason } }, tx);
      return { id: selectionId, withdrawn: true };
    });
  }

  /** Statuts de devis (SELECTED / PARTIALLY_SELECTED / NOT_SELECTED) et de RFQ (EVALUATED ⇄ QUOTED). */
  private async refreshStatuses(tx: Tx, rfqId: string) {
    const quotations = await tx.quotation.findMany({
      where: { rfqId, status: { not: 'WITHDRAWN' } },
      include: { lines: { include: { selections: { where: { withdrawnAt: null }, select: { id: true } } } } },
    });
    const anySelection = quotations.some((q) => q.lines.some((l) => l.selections.length));
    for (const q of quotations) {
      const available = q.lines.filter((l) => l.isAvailable && l.unitPrice !== null);
      const selected = q.lines.filter((l) => l.selections.length).length;
      let status: QuotationStatus = 'RECEIVED';
      if (anySelection) status = selected === 0 ? 'NOT_SELECTED' : selected >= available.length ? 'SELECTED' : 'PARTIALLY_SELECTED';
      if (status !== q.status) await tx.quotation.update({ where: { id: q.id }, data: { status } });
    }
    const rfq = await tx.rfq.findUniqueOrThrow({ where: { id: rfqId }, select: { status: true } });
    if (anySelection && rfq.status === 'QUOTED') await tx.rfq.update({ where: { id: rfqId }, data: { status: 'EVALUATED' } });
    if (!anySelection && rfq.status === 'EVALUATED') await tx.rfq.update({ where: { id: rfqId }, data: { status: 'QUOTED' } });
  }

  /** Quantité déjà commandée par ligne de devis (BC non annulés) — contrôle « ≤ sélection » à la création du BC. */
  static orderedOnQuotationLine(lines: { quantityOrdered: Prisma.Decimal; quantityCancelled: Prisma.Decimal }[]) {
    return sumD(lines.map((l) => D(l.quantityOrdered).minus(l.quantityCancelled)));
  }
}
