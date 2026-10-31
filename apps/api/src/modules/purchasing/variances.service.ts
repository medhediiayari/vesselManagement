import { Injectable } from '@nestjs/common';
import { Prisma, VarianceStatus } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, vesselWhere } from '../access/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { OrdersService } from './orders.service';
import { PurchasingCore } from './purchasing-core.service';
import { LINKS } from './purchasing.constants';
import { D, VARIANCE_TRANSITIONS, assertTransition, fmtQty, isPoReceivable } from './purchasing.logic';
import { AssignVarianceDto, AwaitRemainderDto, ComplementaryForOrderDto, ComplementaryOrderDto, ListVariancesQuery, ResolveVarianceDto } from './receiving.dto';

/**
 * Rapports d'écart (manquant, surplus, avarie, mauvaise référence, rejet — CDC §6.7) : attribution d'une action
 * à un responsable, résolution, clôture ; BC complémentaire pour le reliquat avec lien conservé vers les lignes
 * PR d'origine (V1 §8.4 « réaffectation article par article »).
 */
@Injectable()
export class VariancesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly orders: OrdersService,
  ) {}

  async list(ctx: AuthContext, q: ListVariancesQuery) {
    const where: Prisma.VarianceWhereInput = {
      AND: [
        { po: { ...(vesselWhere(ctx) as Prisma.PurchaseOrderWhereInput), ...this.core.poOwnWhere(ctx) } },
        q.poId ? { poId: q.poId } : {},
        q.vesselId ? { po: { vesselId: q.vesselId } } : {},
        q.status?.length ? { status: { in: q.status } } : {},
        q.type?.length ? { type: { in: q.type } } : {},
        q.assignedToId ? { assignedToId: q.assignedToId } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.variance.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          po: { select: { id: true, number: true, vesselId: true, status: true, supplier: { select: { id: true, name: true } } } },
          poLine: { select: { id: true, lineNo: true, designation: true, unit: true } },
          receipt: { select: { id: true, number: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.variance.count({ where }),
    ]);
    return toPage(rows, q, total);
  }

  private async find(ctx: AuthContext, id: string, db: Tx | PrismaService = this.prisma) {
    const v = await db.variance.findUnique({ where: { id }, include: { po: { select: { id: true, number: true, vesselId: true, status: true, createdById: true } } } });
    if (!v) throw Errors.notFound('Écart');
    this.access.assertVesselAccess(ctx, v.po.vesselId);
    await this.core.assertPoVisible(ctx, v.po.id, db);
    return v;
  }

  async get(ctx: AuthContext, id: string) {
    await this.find(ctx, id);
    const v = await this.prisma.variance.findUniqueOrThrow({
      where: { id },
      include: {
        po: { select: { id: true, number: true, vesselId: true, status: true, supplier: { select: { id: true, name: true } } } },
        poLine: { include: { allocations: { include: { prLine: { select: { lineNo: true, pr: { select: { id: true, number: true } } } } } } } },
        receipt: { select: { id: true, number: true, receivedAt: true } },
      },
    });
    const names = await this.core.userNames([v.createdById, v.assignedToId]);
    const balance = (await this.core.balancesForPoLines([v.poLineId]))[0];
    return {
      ...v,
      createdByName: names.get(v.createdById) ?? null,
      assignedToName: v.assignedToId ? names.get(v.assignedToId) ?? null : null,
      lineBalance: balance
        ? { ordered: fmtQty(D(balance.quantityOrdered).minus(balance.quantityCancelled)), onDeliveryNotes: fmtQty(balance.qtyOnDeliveryNotes), physicallyReceived: fmtQty(balance.qtyPhysicallyReceived), accepted: fmtQty(balance.qtyAccepted), remaining: fmtQty(balance.qtyRemaining) }
        : null,
      attachments: await this.core.attachmentsOf('VARIANCE', [id]),
    };
  }

  private async transition(
    ctx: AuthContext,
    id: string,
    to: VarianceStatus,
    action: string,
    data: Prisma.VarianceUncheckedUpdateManyInput,
    metadata: Record<string, unknown>,
    allowSameStatus = false,
    guard?: (v: { po: { number: string; status: string } }) => void,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const v = await this.find(ctx, id, tx);
      if (!(allowSameStatus && v.status === to)) assertTransition(VARIANCE_TRANSITIONS, v.status, to, 'Écart');
      guard?.(v);
      const res = await tx.variance.updateMany({ where: { id, status: v.status }, data: { ...data, status: to } });
      if (!res.count) throw Errors.staleVersion();
      await this.core.audit(ctx, { action, entityType: 'variance', entityId: id, vesselId: v.po.vesselId, before: { status: v.status, assignedToId: v.assignedToId }, after: { status: to, ...data }, metadata }, tx);
      return { variance: await tx.variance.findUniqueOrThrow({ where: { id } }), po: v.po };
    });
  }

  /** Attribution d'une action à un responsable (doit voir les réceptions du navire). Réattribution possible. */
  async assign(ctx: AuthContext, id: string, dto: AssignVarianceDto) {
    const v = await this.find(ctx, id);
    const allowed =
      (await this.access.userCan(dto.assignedToId, 'variances.manage', v.po.vesselId)) || (await this.access.userCan(dto.assignedToId, 'receiving.view', v.po.vesselId));
    if (!allowed) throw Errors.validation('Responsable sans droit sur les réceptions de ce navire');
    const { variance, po } = await this.transition(ctx, id, 'IN_PROGRESS', 'variance.assigned', { assignedToId: dto.assignedToId }, { comment: dto.comment }, true);
    await this.notifications.notify({
      userIds: [dto.assignedToId],
      excludeUserIds: [ctx.userId],
      type: 'purchasing.variance_assigned',
      title: `Écart ${variance.type} (BC ${po.number}) qui vous est attribué`,
      body: [variance.description, dto.comment].filter(Boolean).join('\n'),
      module: 'purchasing',
      entityType: 'variance',
      entityId: id,
      vesselId: po.vesselId,
      link: LINKS.variance(id),
      priority: 'HIGH',
      email: true,
      requiredPermission: 'receiving.view',
    });
    return variance;
  }

  async resolve(ctx: AuthContext, id: string, dto: ResolveVarianceDto) {
    const { variance, po } = await this.transition(ctx, id, 'RESOLVED', 'variance.resolved', { resolution: dto.resolution, resolvedAt: new Date() }, {});
    await this.prisma.$transaction((tx) => this.core.settleClosures(ctx, [po.id], tx, 'variance.resolved'));
    return variance;
  }

  async close(ctx: AuthContext, id: string, comment?: string | null) {
    const { variance, po } = await this.transition(ctx, id, 'CLOSED', 'variance.closed', {}, { comment });
    await this.prisma.$transaction((tx) => this.core.settleClosures(ctx, [po.id], tx, 'variance.closed'));
    return variance;
  }

  /**
   * POST /orders/:id/await-remainder — décision « Attendre le reliquat » : les écarts ouverts du BC passent « en
   * cours » (pris en charge par l'acheteur) ; le BC reste ouvert et le prochain BL du bord refait la comparaison
   * (écarts comblés résolus automatiquement). Le(s) demandeur(s) sont prévenus.
   */
  async awaitRemainder(ctx: AuthContext, poId: string, dto: AwaitRemainderDto) {
    return this.prisma.$transaction(async (tx) => {
      const po = await this.core.findPo(ctx, poId, tx);
      if (!isPoReceivable(po)) throw Errors.invalidState(`BC ${po.status} : aucune livraison attendue`);
      const open = await tx.variance.findMany({ where: { poId, status: { in: ['OPEN', 'IN_PROGRESS'] } }, select: { id: true, status: true } });
      if (!open.length) throw Errors.business('Aucun écart ouvert sur ce BC');
      await tx.variance.updateMany({ where: { poId, status: 'OPEN' }, data: { status: 'IN_PROGRESS', assignedToId: ctx.userId } });
      await this.core.audit(
        ctx,
        {
          action: 'po.awaiting_remainder',
          entityType: 'purchase_order',
          entityId: poId,
          vesselId: po.vesselId,
          after: { variances: open.map((v) => v.id) },
          metadata: { comment: dto.comment, decision: 'AWAIT_REMAINDER' },
        },
        tx,
      );
      const prs = await tx.purchaseRequest.findMany({
        where: { lines: { some: { allocations: { some: { poLine: { poId } } } } } },
        select: { requesterId: true },
      });
      await this.notifications.notify(
        {
          userIds: [...new Set(prs.map((p) => p.requesterId))],
          excludeUserIds: [ctx.userId],
          type: 'purchasing.po_awaiting_remainder',
          title: `BC ${po.number} : reliquat attendu`,
          body: ['Les Achats attendent la livraison du reliquat : à sa réception, répondez par un nouveau BL.', dto.comment].filter(Boolean).join('\n'),
          module: 'purchasing',
          entityType: 'purchase_order',
          entityId: poId,
          vesselId: po.vesselId,
          link: LINKS.po(poId),
          requiredPermission: 'bc.view',
        },
        tx,
      );
      return { awaiting: open.length };
    });
  }

  /**
   * POST /orders/:id/complementary — « Correction fournisseur » par BC complémentaire : les reliquats choisis
   * (plusieurs lignes) sont annulés sur le BC d'origine par avenant (snapshot conservé), puis reportés sur UN
   * nouveau BC — même fournisseur ou un autre — alloué aux MÊMES lignes PR ; émis immédiatement si demandé.
   */
  async complementaryForOrder(ctx: AuthContext, poId: string, dto: ComplementaryForOrderDto) {
    const result = await this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, poId, tx);
      if (!isPoReceivable(po)) throw Errors.invalidState(`BC d’origine ${po.status}`);
      const ids = dto.lines.map((l) => l.poLineId);
      if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne de BC citée deux fois');
      const lines = await tx.poLine.findMany({ where: { poId, id: { in: ids } }, include: { allocations: true } });
      if (lines.length !== ids.length) throw Errors.validation('Ligne d’un autre BC');
      const balances = new Map((await this.core.balancesForPoLines(ids, tx)).map((b) => [b.poLineId, b]));
      const sameSupplier = !dto.supplierId || dto.supplierId === po.supplierId;
      const plan = dto.lines.map((input) => {
        const line = lines.find((l) => l.id === input.poLineId)!;
        const remaining = D(balances.get(line.id)?.qtyRemaining ?? 0);
        if (remaining.isZero()) throw Errors.business(`Ligne ${line.lineNo} : aucun reliquat`);
        const qty = input.quantity ? D(input.quantity) : remaining;
        if (qty.greaterThan(remaining)) throw Errors.business(`Ligne ${line.lineNo} : quantité supérieure au reliquat (${fmtQty(remaining)})`);
        const price = input.unitPrice ?? (sameSupplier ? line.unitPrice.toString() : undefined);
        if (price === undefined) throw Errors.validation(`Ligne ${line.lineNo} : prix unitaire requis chez un autre fournisseur`);
        return { line, qty, remaining, price, before: line.allocations.map((a) => ({ prLineId: a.prLineId, quantity: D(a.quantity) })) };
      });
      await this.orders.reviseTx(ctx, tx, po, {
        expectedVersion: dto.originalOrderVersion,
        reason: `Correction fournisseur — reliquat reporté sur BC complémentaire : ${dto.reason}`,
        lines: plan.map((p) =>
          p.qty.equals(p.remaining)
            ? { poLineId: p.line.id, cancelRemaining: true }
            : { poLineId: p.line.id, quantityOrdered: D(p.line.quantityOrdered).minus(p.line.quantityCancelled).minus(p.qty).toString() },
        ),
        addLines: [],
      });
      const newLines = [];
      for (const p of plan) {
        const after = await tx.poLineAllocation.findMany({ where: { poLineId: p.line.id } });
        const freed = p.before
          .map((b) => ({ prLineId: b.prLineId, quantity: b.quantity.minus(after.find((a) => a.prLineId === b.prLineId)?.quantity ?? 0) }))
          .filter((f) => f.quantity.greaterThan(0));
        if (!freed.length) throw Errors.business(`Ligne ${p.line.lineNo} : aucune quantité PR libérée`);
        newLines.push({
          designation: p.line.designation,
          reference: p.line.reference,
          unit: p.line.unit,
          quantity: p.qty.toString(),
          unitPrice: p.price,
          remarks: `Reliquat ${po.number} / ligne ${p.line.lineNo}`,
          allocations: freed.map((f) => ({ prLineId: f.prLineId, quantity: f.quantity.toString() })),
        });
      }
      const complementary = await this.orders.createTx(
        ctx,
        tx,
        {
          supplierId: dto.supplierId ?? po.supplierId,
          currency: dto.currency ?? (sameSupplier ? po.currency : undefined),
          expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
          deliveryPort: dto.deliveryPort ?? po.deliveryPort,
          deliveryTerms: dto.deliveryTerms ?? po.deliveryTerms,
          paymentTerms: sameSupplier ? po.paymentTerms : null,
          notes: dto.notes ?? `BC complémentaire du ${po.number} (correction fournisseur)`,
          lines: newLines,
        },
        { complementaryOf: po.id },
      );
      await this.core.audit(
        ctx,
        {
          action: 'po.complementary_order',
          entityType: 'purchase_order',
          entityId: po.id,
          vesselId: po.vesselId,
          after: { complementaryPoId: complementary.id, complementaryNumber: complementary.number },
          metadata: { reason: dto.reason, lines: plan.map((p) => ({ poLineId: p.line.id, lineNo: p.line.lineNo, quantity: fmtQty(p.qty) })), supplierId: dto.supplierId ?? po.supplierId },
        },
        tx,
      );
      return { originalPoId: po.id, complementary };
    });
    await this.orders.regeneratePdf(ctx, result.originalPoId);
    const issued = dto.issueNow ? await this.orders.issue(ctx, result.complementary.id, { expectedVersion: result.complementary.lockVersion }) : null;
    return { complementaryOrder: { id: result.complementary.id, number: result.complementary.number }, issued: issued?.issued ?? false, message: issued?.message ?? null };
  }

  /** Réouverture : jamais sur un BC clôturé ou annulé (l'écart ne pourrait plus être traité — audit ACH-08). */
  async reopen(ctx: AuthContext, id: string, comment?: string | null) {
    const guard = (v: { po: { number: string; status: string } }) => {
      if (v.po.status === 'CLOSED' || v.po.status === 'CANCELLED') {
        throw Errors.invalidState(`BC ${v.po.number} ${v.po.status === 'CLOSED' ? 'clôturé' : 'annulé'} : l’écart ne peut plus être rouvert`, { poStatus: v.po.status });
      }
    };
    return (await this.transition(ctx, id, 'IN_PROGRESS', 'variance.reopened', { resolvedAt: null }, { comment }, false, guard)).variance;
  }

  /**
   * BC complémentaire : avenant du BC d'origine (annulation de la quantité reportée, snapshot conservé) puis
   * nouveau BC brouillon alloué aux MÊMES lignes PR pour la capacité libérée — dans une seule transaction.
   */
  async complementaryOrder(ctx: AuthContext, id: string, dto: ComplementaryOrderDto) {
    const result = await this.core.serializable(async (tx) => {
      const v = await this.find(ctx, id, tx);
      if (v.status !== 'OPEN' && v.status !== 'IN_PROGRESS') throw Errors.invalidState(`Écart ${v.status} : BC complémentaire impossible`);
      const po = await this.core.findPo(ctx, v.poId, tx);
      if (!isPoReceivable(po)) throw Errors.invalidState(`BC d’origine ${po.status}`);
      const line = await tx.poLine.findUniqueOrThrow({ where: { id: v.poLineId }, include: { allocations: true } });
      const [bal] = await this.core.balancesForPoLines([v.poLineId], tx);
      const remaining = D(bal.qtyRemaining);
      if (remaining.isZero()) throw Errors.business('Aucun reliquat sur cette ligne');
      const qty = dto.quantity ? D(dto.quantity) : remaining;
      if (qty.greaterThan(remaining)) throw Errors.business(`Quantité supérieure au reliquat (${fmtQty(remaining)})`);
      const before = new Map(line.allocations.map((a) => [a.prLineId, D(a.quantity)]));
      const newOrdered = D(line.quantityOrdered).minus(line.quantityCancelled).minus(qty);
      await this.orders.reviseTx(ctx, tx, po, {
        expectedVersion: dto.originalOrderVersion,
        reason: `Reliquat reporté sur BC complémentaire : ${dto.reason}`,
        lines: [qty.equals(remaining) ? { poLineId: line.id, cancelRemaining: true } : { poLineId: line.id, quantityOrdered: newOrdered.toString() }],
        addLines: [],
      });
      const after = await tx.poLineAllocation.findMany({ where: { poLineId: line.id } });
      const freed = [...before.entries()]
        .map(([prLineId, q]) => ({ prLineId, quantity: q.minus(after.find((a) => a.prLineId === prLineId)?.quantity ?? 0) }))
        .filter((f) => f.quantity.greaterThan(0));
      if (!freed.length) throw Errors.business('Aucune quantité PR libérée : la ligne n’était pas allouée au-delà du reçu');
      const sameSupplier = !dto.supplierId || dto.supplierId === po.supplierId;
      const complementary = await this.orders.createTx(
        ctx,
        tx,
        {
          supplierId: dto.supplierId ?? po.supplierId,
          currency: dto.currency ?? (sameSupplier ? po.currency : undefined),
          expectedDeliveryDate: dto.expectedDeliveryDate ?? null,
          deliveryPort: dto.deliveryPort ?? po.deliveryPort,
          deliveryTerms: dto.deliveryTerms ?? po.deliveryTerms,
          paymentTerms: sameSupplier ? po.paymentTerms : null,
          notes: dto.notes ?? `BC complémentaire du ${po.number} (reliquat ligne ${line.lineNo})`,
          lines: [
            {
              designation: line.designation,
              reference: line.reference,
              unit: line.unit,
              quantity: qty.toString(),
              unitPrice: dto.unitPrice,
              remarks: `Reliquat ${po.number} / ligne ${line.lineNo}`,
              allocations: freed.map((f) => ({ prLineId: f.prLineId, quantity: f.quantity.toString() })),
            },
          ],
        },
        { complementaryOf: po.id, varianceId: id },
      );
      const resolution = `BC complémentaire ${complementary.number} : ${fmtQty(qty)} ${line.unit} reportés depuis ${po.number}`;
      await tx.variance.update({ where: { id }, data: { status: 'RESOLVED', resolution, resolvedAt: new Date() } });
      await this.core.audit(
        ctx,
        {
          action: 'variance.complementary_order',
          entityType: 'variance',
          entityId: id,
          vesselId: po.vesselId,
          before: { status: v.status },
          after: { status: 'RESOLVED', resolution },
          metadata: { originalPoId: po.id, complementaryPoId: complementary.id, quantity: qty, freedAllocations: freed, reason: dto.reason },
        },
        tx,
      );
      return { originalPoId: po.id, complementary };
    });
    await this.orders.regeneratePdf(ctx, result.originalPoId);
    return { variance: await this.prisma.variance.findUniqueOrThrow({ where: { id } }), complementaryOrder: result.complementary };
  }
}
