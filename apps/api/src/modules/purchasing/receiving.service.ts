import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, vesselWhere } from '../access/auth-context';
import { NumberingService } from '../documents/numbering.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PurchasingCore } from './purchasing-core.service';
import { PurchasingDocuments } from './purchasing-documents.service';
import { LINKS } from './purchasing.constants';
import { escapeLike } from '../../common/utils/like';
import {
  D,
  computeBalance,
  isPoReceivable,
  assertReceiptLineConsistent,
  detectEventVariances,
  fmtQty,
  max0,
  requestHash,
  validateIdempotencyKey,
} from './purchasing.logic';
import {
  CancelDeliveryNoteDto,
  OnboardDeliveryDto,
  CreateDeliveryNoteDto,
  CreateReceiptDto,
  ListDeliveryNotesQuery,
  ListReceiptsQuery,
  ValidateReceiptDto,
} from './receiving.dto';

const RECEIPT_ROUTE = 'POST /api/v1/receipts';
const ONBOARD_ROUTE = 'POST /api/v1/delivery-notes/onboard';

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10).split('-').reverse().join('/');
}


interface Discrepancy {
  poLineId: string;
  lineNo: number;
  designation: string;
  unit: string;
  ordered: string;
  received: string;
  missing: string;
  surplus: string;
  remarks: string | null;
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string; meta?: { code?: string } };
  return err?.code === 'P2002' || err?.meta?.code === '23505' || /unique constraint|duplicate key/i.test(err?.message ?? '');
}

/**
 * BL et réception à bord (CDC §6.7 — PUR-04/05/07) :
 *  - le BL enregistre ce que le fournisseur déclare livrer ; il n'est JAMAIS une preuve de réception ;
 *  - la réception saisit reçu / accepté / rejeté / état / remarques + preuves ; elle est idempotente
 *    (en-tête Idempotency-Key => goods_receipts.idempotency_key UNIQUE : pas de double comptage) ;
 *  - écarts détectés automatiquement, statuts BC (v_po_line_balance) et PR recalculés dans la même transaction ;
 *  - validation du rapport de réception par une personne habilitée distincte du réceptionnaire.
 */
@Injectable()
export class ReceivingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly access: AccessService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly docs: PurchasingDocuments,
    private readonly files: FilesService,
  ) {}

  // ---------------------------------------------------------------------------
  // BL
  // ---------------------------------------------------------------------------

  async listDeliveryNotes(ctx: AuthContext, q: ListDeliveryNotesQuery) {
    const where: Prisma.DeliveryNoteWhereInput = {
      AND: [
        vesselWhere(ctx) as Prisma.DeliveryNoteWhereInput,
        this.core.ownPrOnly(ctx) ? { po: this.core.poOwnWhere(ctx) } : {},
        q.poId ? { poId: q.poId } : {},
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.supplierId ? { supplierId: q.supplierId } : {},
        q.status?.length ? { status: { in: q.status } } : {},
        q.search ? { number: { contains: escapeLike(q.search), mode: 'insensitive' } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.deliveryNote.findMany({
        where,
        orderBy: [{ deliveryDate: 'desc' }, { id: 'desc' }],
        include: { supplier: { select: { id: true, name: true } }, po: { select: { id: true, number: true, status: true } }, _count: { select: { lines: true, receipts: true } } },
        ...cursorArgs(q),
      }),
      this.prisma.deliveryNote.count({ where }),
    ]);
    return toPage(rows, q, total);
  }

  private async findDeliveryNote(ctx: AuthContext, id: string) {
    const dn = await this.prisma.deliveryNote.findUnique({ where: { id } });
    if (!dn) throw Errors.notFound('BL');
    this.access.assertVesselAccess(ctx, dn.vesselId);
    await this.core.assertPoVisible(ctx, dn.poId);
    return dn;
  }

  async getDeliveryNote(ctx: AuthContext, id: string) {
    await this.findDeliveryNote(ctx, id);
    const dn = await this.prisma.deliveryNote.findUniqueOrThrow({
      where: { id },
      include: {
        supplier: { select: { id: true, code: true, name: true } },
        po: { select: { id: true, number: true, status: true } },
        lines: { include: { poLine: { select: { id: true, lineNo: true, designation: true, unit: true, quantityOrdered: true, quantityCancelled: true } } } },
        extraItems: { orderBy: { createdAt: 'asc' } },
        receipts: { select: { id: true, number: true, receivedAt: true, status: true } },
      },
    });
    const names = await this.core.userNames([dn.createdById]);
    return { ...dn, createdByName: names.get(dn.createdById) ?? null, attachments: await this.core.attachmentsOf('DELIVERY_NOTE', [id]) };
  }

  async createDeliveryNote(ctx: AuthContext, dto: CreateDeliveryNoteDto) {
    return this.core.serializable(async (tx) => {
      const po = await this.core.findPo(ctx, dto.poId, tx);
      if (!isPoReceivable(po)) throw Errors.invalidState(`BC ${po.status} : BL impossible (BC non transmis ou clos)`);
      const dup = await tx.deliveryNote.findUnique({ where: { supplierId_number: { supplierId: po.supplierId, number: dto.number } }, select: { id: true } });
      if (dup) throw Errors.duplicate(`BL n° ${dto.number} déjà enregistré pour ce fournisseur`);
      const poLines = await tx.poLine.findMany({ where: { poId: po.id } });
      const ids = dto.lines.map((l) => l.poLineId);
      if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne de BC citée deux fois');
      for (const id of ids) if (!poLines.some((l) => l.id === id)) throw Errors.validation('Ligne d’un autre BC', { poLineId: id });
      const dn = await tx.deliveryNote.create({
        data: {
          number: dto.number,
          supplierId: po.supplierId,
          vesselId: po.vesselId,
          poId: po.id,
          deliveryDate: dto.deliveryDate,
          notes: dto.notes ?? null,
          createdById: ctx.userId,
          lines: {
            create: dto.lines.map((l) => ({ poLineId: l.poLineId, quantityOnNote: l.quantityOnNote, unit: l.unit ?? poLines.find((p) => p.id === l.poLineId)!.unit })),
          },
        },
        include: { lines: true },
      });
      if (dto.fileId) {
        await this.core.addAttachmentTx(ctx, 'DELIVERY_NOTE', dn.id, po.vesselId, dto.fileId, `Scan BL ${dto.number}`, tx);
        await tx.deliveryNote.update({ where: { id: dn.id }, data: { fileId: dto.fileId } });
      }
      await this.core.audit(ctx, { action: 'delivery_note.recorded', entityType: 'delivery_note', entityId: dn.id, vesselId: po.vesselId, after: dn, metadata: { poId: po.id } }, tx);
      // BC ≠ BL : short-shipped signalé dès l'enregistrement du BL (V1 §9.1)
      const variances = await this.core.syncBalanceVariances(ctx, po.id, tx, null);
      return { ...dn, variances };
    });
  }

  async cancelDeliveryNote(ctx: AuthContext, id: string, dto: CancelDeliveryNoteDto) {
    const dn = await this.findDeliveryNote(ctx, id);
    if (dn.status === 'CANCELLED') throw Errors.alreadyProcessed('BL déjà annulé');
    return this.core.serializable(async (tx) => {
      const receipts = await tx.goodsReceipt.count({ where: { deliveryNoteId: id } });
      if (receipts) throw Errors.business('BL lié à une réception : annulation impossible');
      await tx.deliveryNote.update({ where: { id }, data: { status: 'CANCELLED' } });
      await this.core.audit(ctx, { action: 'delivery_note.cancelled', entityType: 'delivery_note', entityId: id, vesselId: dn.vesselId, before: { status: dn.status }, after: { status: 'CANCELLED' }, metadata: { reason: dto.reason } }, tx);
      await this.core.syncBalanceVariances(ctx, dn.poId, tx, null);
      return tx.deliveryNote.findUniqueOrThrow({ where: { id } });
    });
  }

  // ---------------------------------------------------------------------------
  // Réceptions
  // ---------------------------------------------------------------------------

  async listReceipts(ctx: AuthContext, q: ListReceiptsQuery) {
    const where: Prisma.GoodsReceiptWhereInput = {
      AND: [
        vesselWhere(ctx) as Prisma.GoodsReceiptWhereInput,
        this.core.ownPrOnly(ctx) ? { po: this.core.poOwnWhere(ctx) } : {},
        q.poId ? { poId: q.poId } : {},
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.status?.length ? { status: { in: q.status } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.goodsReceipt.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
        include: {
          po: { select: { id: true, number: true, status: true, supplier: { select: { id: true, name: true } } } },
          deliveryNote: { select: { id: true, number: true } },
          _count: { select: { lines: true, variances: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.goodsReceipt.count({ where }),
    ]);
    return toPage(rows, q, total);
  }

  private async findReceipt(ctx: AuthContext, id: string) {
    const r = await this.prisma.goodsReceipt.findUnique({ where: { id } });
    if (!r) throw Errors.notFound('Réception');
    this.access.assertVesselAccess(ctx, r.vesselId);
    await this.core.assertPoVisible(ctx, r.poId);
    return r;
  }

  async getReceipt(ctx: AuthContext, id: string) {
    await this.findReceipt(ctx, id);
    const r = await this.prisma.goodsReceipt.findUniqueOrThrow({
      where: { id },
      include: {
        po: { select: { id: true, number: true, status: true, currency: true, supplier: { select: { id: true, name: true } } } },
        deliveryNote: { select: { id: true, number: true, deliveryDate: true, status: true } },
        lines: { include: { poLine: { select: { id: true, lineNo: true, designation: true, unit: true } }, deliveryNoteLine: { select: { id: true, quantityOnNote: true } } } },
        variances: { orderBy: { createdAt: 'asc' } },
      },
    });
    const names = await this.core.userNames([r.receivedById, r.validatedById]);
    const { idempotencyKey: _k, ...rest } = r;
    return {
      ...rest,
      lines: [...r.lines].sort((a, b) => a.poLine.lineNo - b.poLine.lineNo),
      receivedByName: names.get(r.receivedById) ?? null,
      validatedByName: r.validatedById ? names.get(r.validatedById) ?? null : null,
      attachments: await this.core.attachmentsOf('GOODS_RECEIPT', [id]),
    };
  }

  /**
   * Rejeu d'une requête déjà traitée (PUR-05) : même clé + même auteur + même contenu => la réception
   * d'origine est renvoyée, sans nouveau comptage. Clé réutilisée pour un autre contenu => 409.
   */
  private async findReplay(ctx: AuthContext, key: string, hash: string) {
    const [existing, idem] = await Promise.all([
      this.prisma.goodsReceipt.findUnique({ where: { idempotencyKey: key }, select: { id: true, receivedById: true } }),
      this.prisma.idempotencyKey.findUnique({ where: { userId_key: { userId: ctx.userId, key } } }),
    ]);
    if (!existing) {
      if (idem) throw Errors.idempotencyConflict('Idempotency-Key déjà utilisée pour une autre opération');
      return null;
    }
    if (existing.receivedById !== ctx.userId) throw Errors.idempotencyConflict('Idempotency-Key déjà utilisée');
    if (idem && idem.requestHash !== hash) throw Errors.idempotencyConflict('Même Idempotency-Key avec un contenu différent : nouvelle clé requise');
    return this.getReceipt(ctx, existing.id);
  }

  async createReceipt(ctx: AuthContext, rawKey: string | undefined, dto: CreateReceiptDto) {
    const key = validateIdempotencyKey(rawKey);
    const hash = requestHash(dto);
    const replay = await this.findReplay(ctx, key, hash);
    if (replay) return { receipt: replay, replay: true };
    let created: { id: string; replay: boolean };
    try {
      created = await this.core.serializable(async (tx) => {
        const dup = await tx.goodsReceipt.findUnique({ where: { idempotencyKey: key }, select: { id: true } });
        if (dup) return { id: dup.id, replay: true };
        const po = await this.core.findPo(ctx, dto.poId, tx);
        if (!isPoReceivable(po)) throw Errors.invalidState(`BC ${po.status} : réception impossible (BC non transmis, annulé ou clos)`);
        const poLines = await tx.poLine.findMany({ where: { poId: po.id } });
        const dn = dto.deliveryNoteId ? await tx.deliveryNote.findUnique({ where: { id: dto.deliveryNoteId }, include: { lines: true } }) : null;
        if (dto.deliveryNoteId && (!dn || dn.poId !== po.id)) throw Errors.validation('BL introuvable pour ce BC');
        if (dn?.status === 'CANCELLED') throw Errors.business('BL annulé');
        const ids = dto.lines.map((l) => l.poLineId);
        if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne de BC citée deux fois');
        const lines = dto.lines.map((l, i) => {
          const poLine = poLines.find((p) => p.id === l.poLineId);
          if (!poLine) throw Errors.validation(`Ligne ${i + 1} : ligne d’un autre BC`);
          const facts = { poLineId: l.poLineId, qtyReceived: l.qtyReceived, qtyAccepted: l.qtyAccepted, qtyRejected: l.qtyRejected, condition: l.condition };
          assertReceiptLineConsistent(facts, `Ligne ${poLine.lineNo}`);
          let deliveryNoteLineId: string | null = null;
          if (l.deliveryNoteLineId) {
            const dnl = dn?.lines.find((x) => x.id === l.deliveryNoteLineId);
            if (!dnl || dnl.poLineId !== l.poLineId) throw Errors.validation(`Ligne ${poLine.lineNo} : ligne de BL incohérente`);
            deliveryNoteLineId = dnl.id;
          } else if (dn) {
            deliveryNoteLineId = dn.lines.find((x) => x.poLineId === l.poLineId)?.id ?? null;
          }
          return { poLine, facts, deliveryNoteLineId, remarks: l.remarks ?? null };
        });
        const vessel = await tx.vessel.findUniqueOrThrow({ where: { id: po.vesselId }, select: { code: true } });
        const number = await this.numbering.nextFormatted('GR', vessel.code, tx);
        const receipt = await tx.goodsReceipt.create({
          data: {
            number,
            vesselId: po.vesselId,
            poId: po.id,
            deliveryNoteId: dn?.id ?? null,
            receivedAt: dto.receivedAt ?? new Date(),
            receivedById: ctx.userId,
            responsibleName: dto.responsibleName ?? ctx.displayName,
            status: 'CONFIRMED',
            notes: dto.notes ?? null,
            idempotencyKey: key,
            lines: {
              create: lines.map((l) => ({
                poLineId: l.poLine.id,
                deliveryNoteLineId: l.deliveryNoteLineId,
                qtyReceived: l.facts.qtyReceived,
                qtyAccepted: l.facts.qtyAccepted,
                qtyRejected: l.facts.qtyRejected,
                condition: l.facts.condition,
                remarks: l.remarks,
              })),
            },
          },
          include: { lines: true },
        });
        await tx.idempotencyKey.create({
          data: { userId: ctx.userId, key, route: RECEIPT_ROUTE, requestHash: hash, responseStatus: 201, responseBody: { receiptId: receipt.id, number } },
        });
        for (const fileId of dto.evidenceFileIds) {
          await this.core.addAttachmentTx(ctx, 'GOODS_RECEIPT', receipt.id, po.vesselId, fileId, 'Preuve de réception', tx);
        }
        if (dn && dn.status === 'RECORDED') await tx.deliveryNote.update({ where: { id: dn.id }, data: { status: 'RECEIVED' } });

        // Écarts : avarie / mauvaise référence / rejet (événement) + solde cumulé (short-shipped / short-received / surplus)
        const eventVariances = [];
        for (const l of lines) {
          for (const v of detectEventVariances(l.facts)) {
            const row = await tx.variance.create({
              data: { poId: po.id, poLineId: v.poLineId, receiptId: receipt.id, type: v.type, quantity: v.quantity, description: `Ligne ${l.poLine.lineNo} — ${v.description}`, createdById: ctx.userId },
            });
            eventVariances.push({ id: row.id, type: row.type, quantity: fmtQty(row.quantity), poLineId: row.poLineId });
            await this.core.audit(ctx, { action: 'variance.detected', entityType: 'variance', entityId: row.id, vesselId: po.vesselId, after: row }, tx);
          }
        }
        const balance = await this.core.syncBalanceVariances(ctx, po.id, tx, receipt.id);
        const poStatus = await this.core.recomputePoStatus(ctx, po.id, tx, 'receipt.recorded');
        await this.core.settleClosures(ctx, [po.id], tx, 'receipt.recorded');
        const variances = [...eventVariances, ...balance.created];
        await this.core.audit(
          ctx,
          {
            action: 'receipt.recorded',
            entityType: 'goods_receipt',
            entityId: receipt.id,
            vesselId: po.vesselId,
            after: { ...receipt, idempotencyKey: undefined },
            metadata: { poId: po.id, deliveryNoteId: dn?.id ?? null, idempotencyKeyHash: hash.slice(0, 16), variances, autoResolved: balance.resolved, poStatus },
          },
          tx,
        );
        const purchasing = await this.access.usersWithPermission('variances.manage', po.vesselId, tx);
        await this.notifications.notify(
          {
            userIds: [...purchasing, po.createdById],
            excludeUserIds: [ctx.userId],
            type: variances.length ? 'purchasing.receipt_variances' : 'purchasing.receipt_recorded',
            title: variances.length
              ? `Réception ${number} (BC ${po.number}) : ${variances.length} écart(s) détecté(s)`
              : `Réception ${number} enregistrée (BC ${po.number})`,
            body: variances.map((v) => `${v.type} : ${v.quantity}`).join(' ; ') || undefined,
            module: 'purchasing',
            entityType: 'goods_receipt',
            entityId: receipt.id,
            vesselId: po.vesselId,
            link: LINKS.receipt(receipt.id),
            priority: variances.length ? 'HIGH' : 'NORMAL',
            dedupeKey: `receipt:${receipt.id}`,
            email: variances.length > 0,
            requiredPermission: 'receiving.view',
          },
          tx,
        );
        return { id: receipt.id, replay: false };
      });
    } catch (e) {
      // Requête concurrente portant la même clé : la première l'emporte, la seconde renvoie son résultat
      if (isUniqueViolation(e)) {
        const r = await this.findReplay(ctx, key, hash);
        if (r) return { receipt: r, replay: true };
      }
      throw e;
    }
    return { receipt: await this.getReceipt(ctx, created.id), replay: created.replay };
  }

  // ---------------------------------------------------------------------------
  // BL saisi à bord (refonte 22/10/2026) : BL + réception en une étape, écarts signalés aux Achats
  // ---------------------------------------------------------------------------

  /**
   * POST /delivery-notes/onboard — réponse du bord à un BC émis. Tout utilisateur du navire habilité
   * (receiving.record) qui voit le BC peut le saisir. Crée le BL (quantités = reçu déclaré), la réception
   * correspondante, les articles hors BC et les pièces jointes ; puis compare au BC : tout écart de quantité
   * (manque ou surplus) déclenche une alerte HAUTE aux Achats ; un BL conforme est simplement signalé « reçu ».
   * BC et PR se clôturent automatiquement quand tout est reçu sans écart.
   */
  async recordOnboard(ctx: AuthContext, rawKey: string | undefined, dto: OnboardDeliveryDto) {
    const key = validateIdempotencyKey(rawKey);
    const hash = requestHash(dto);
    const replay = await this.findOnboardReplay(ctx, key, hash);
    if (replay) return { ...replay, replay: true };
    let created: { deliveryNoteId: string; receiptId: string | null; poId: string; discrepancies: Discrepancy[] } | null;
    try {
      created = await this.core.serializable(async (tx) => {
        // Requête concurrente de même clé déjà validée (ou reprise après conflit de sérialisation) : rejeu, pas 409 (ACH-09)
        const already = await tx.idempotencyKey.findUnique({ where: { userId_key: { userId: ctx.userId, key } } });
        if (already) return null;
        const po = await this.core.findPo(ctx, dto.poId, tx);
        if (!isPoReceivable(po)) throw Errors.invalidState(`BC ${po.status} : BL impossible (BC non émis, annulé ou clôturé)`, { status: po.status });
        const poLines = await tx.poLine.findMany({ where: { poId: po.id }, orderBy: { lineNo: 'asc' } });
        const balances = new Map((await this.core.balancesForPos([po.id], tx)).map((b) => [b.poLineId, b]));

        // Quantités reçues : tout le reste à recevoir (« conforme ») ou saisie ligne à ligne
        let received: { poLine: (typeof poLines)[number]; quantity: Prisma.Decimal; remarks: string | null }[];
        if (dto.allReceived) {
          if (dto.lines.length) throw Errors.validation('« Tout reçu » et saisie par ligne sont exclusifs');
          received = poLines
            .filter((l) => l.status !== 'CANCELLED')
            .map((l) => ({ poLine: l, quantity: max0(D(balances.get(l.id)?.qtyRemaining ?? 0)), remarks: null }))
            .filter((r) => r.quantity.greaterThan(0));
          if (!received.length) throw Errors.business('Tout le BC est déjà reçu : rien à déclarer (articles hors BC : saisie par ligne)');
        } else {
          const ids = dto.lines.map((l) => l.poLineId);
          if (new Set(ids).size !== ids.length) throw Errors.validation('Ligne de BC citée deux fois');
          received = dto.lines.map((l, i) => {
            const poLine = poLines.find((p) => p.id === l.poLineId);
            if (!poLine) throw Errors.validation(`Ligne ${i + 1} : ligne d’un autre BC`, { poLineId: l.poLineId });
            if (poLine.status === 'CANCELLED' && D(l.quantity).greaterThan(0)) throw Errors.business(`Ligne ${poLine.lineNo} annulée sur le BC : notez-la comme article hors BC`);
            return { poLine, quantity: D(l.quantity), remarks: l.remarks ?? null };
          });
        }
        const positive = received.filter((r) => r.quantity.greaterThan(0));
        const remarked = received.filter((r) => r.quantity.isZero() && r.remarks);
        if (!positive.length && !dto.extraItems.length) {
          throw Errors.validation('Aucune quantité reçue : saisissez au moins une ligne, un article hors BC, ou « tout reçu »');
        }

        const vessel = await tx.vessel.findUniqueOrThrow({ where: { id: po.vesselId }, select: { code: true } });
        const number = dto.number?.trim() || (await this.numbering.nextFormatted('BL', vessel.code, tx));
        const dup = await tx.deliveryNote.findUnique({ where: { supplierId_number: { supplierId: po.supplierId, number } }, select: { id: true } });
        if (dup) throw Errors.duplicate(`BL n° ${number} déjà enregistré pour ce fournisseur`);
        const deliveryDate = dto.deliveryDate ?? new Date(new Date().toISOString().slice(0, 10));
        const notes = [dto.notes, ...remarked.map((r) => `Ligne ${r.poLine.lineNo} (${r.poLine.designation}) : ${r.remarks}`)].filter(Boolean).join('\n') || null;
        const dn = await tx.deliveryNote.create({
          data: {
            number,
            supplierId: po.supplierId,
            vesselId: po.vesselId,
            poId: po.id,
            deliveryDate,
            status: positive.length ? 'RECEIVED' : 'RECORDED',
            notes,
            createdById: ctx.userId,
            lines: { create: positive.map((r) => ({ poLineId: r.poLine.id, quantityOnNote: r.quantity, unit: r.poLine.unit })) },
            extraItems: {
              create: dto.extraItems.map((x) => ({ designation: x.designation, reference: x.reference ?? null, quantity: x.quantity, unit: x.unit, remarks: x.remarks ?? null })),
            },
          },
          include: { lines: true },
        });
        for (const [i, fileId] of dto.fileIds.entries()) {
          await this.core.addAttachmentTx(ctx, 'DELIVERY_NOTE', dn.id, po.vesselId, fileId, i === 0 ? `BL ${number}` : `BL ${number} (${i + 1})`, tx);
        }
        if (dto.fileIds.length) await tx.deliveryNote.update({ where: { id: dn.id }, data: { fileId: dto.fileIds[0] } });

        let receiptId: string | null = null;
        if (positive.length) {
          const receiptNumber = await this.numbering.nextFormatted('GR', vessel.code, tx);
          const receipt = await tx.goodsReceipt.create({
            data: {
              number: receiptNumber,
              vesselId: po.vesselId,
              poId: po.id,
              deliveryNoteId: dn.id,
              receivedAt: new Date(),
              receivedById: ctx.userId,
              responsibleName: ctx.displayName,
              status: 'CONFIRMED',
              notes: dto.notes ?? null,
              idempotencyKey: `onboard:${requestHash({ userId: ctx.userId, key }).slice(0, 64)}`,
              lines: {
                create: positive.map((r) => ({
                  poLineId: r.poLine.id,
                  deliveryNoteLineId: dn.lines.find((x) => x.poLineId === r.poLine.id)?.id ?? null,
                  qtyReceived: r.quantity,
                  qtyAccepted: r.quantity,
                  qtyRejected: 0,
                  condition: 'GOOD',
                  remarks: r.remarks,
                })),
              },
            },
          });
          receiptId = receipt.id;
        }
        await tx.idempotencyKey.create({
          data: { userId: ctx.userId, key, route: ONBOARD_ROUTE, requestHash: hash, responseStatus: 201, responseBody: { deliveryNoteId: dn.id, receiptId } },
        });

        // Comparaison BC ↔ reçu cumulé (écarts de solde synchronisés), statuts et clôtures
        const sync = await this.core.syncBalanceVariances(ctx, po.id, tx, receiptId);
        const poStatus = await this.core.recomputePoStatus(ctx, po.id, tx, 'delivery.onboard');
        await this.core.settleClosures(ctx, [po.id], tx, 'delivery.onboard');
        const after = await this.core.balancesForPos([po.id], tx);
        const discrepancies: Discrepancy[] = after
          .filter((b) => poLines.find((l) => l.id === b.poLineId)?.status !== 'CANCELLED')
          .map((b) => {
            const bal = computeBalance({ ordered: b.quantityOrdered, cancelled: b.quantityCancelled, onNotes: b.qtyOnDeliveryNotes, received: b.qtyPhysicallyReceived, accepted: b.qtyAccepted, rejected: b.qtyRejected });
            const remark = received.find((r) => r.poLine.id === b.poLineId)?.remarks ?? null;
            return {
              poLineId: b.poLineId,
              lineNo: b.lineNo,
              designation: b.designation,
              unit: b.unit,
              ordered: fmtQty(bal.effectiveOrdered),
              received: fmtQty(b.qtyAccepted),
              missing: fmtQty(bal.remaining),
              surplus: fmtQty(bal.surplus),
              remarks: remark,
            };
          })
          .filter((d) => D(d.missing).greaterThan(0) || D(d.surplus).greaterThan(0));

        // Résultat conservé pour un rejeu (écarts compris)
        await tx.idempotencyKey.update({
          where: { userId_key: { userId: ctx.userId, key } },
          data: { responseBody: { deliveryNoteId: dn.id, receiptId, discrepancies } as unknown as Prisma.InputJsonValue },
        });

        await this.core.audit(
          ctx,
          {
            action: 'delivery.onboard_recorded',
            entityType: 'delivery_note',
            entityId: dn.id,
            vesselId: po.vesselId,
            after: { number, poId: po.id, lines: positive.map((r) => ({ poLineId: r.poLine.id, quantity: fmtQty(r.quantity) })), extraItems: dto.extraItems },
            metadata: { allReceived: dto.allReceived, receiptId, fileIds: dto.fileIds, discrepancies, variancesCreated: sync.created, autoResolved: sync.resolved, poStatus },
          },
          tx,
        );

        // Achats : alerte HAUTE en cas d'incohérence reçu / commandé ; sinon simple « BL reçu »
        const purchasing = await this.access.usersWithPermission('variances.manage', po.vesselId, tx);
        const supplier = await tx.supplier.findUniqueOrThrow({ where: { id: po.supplierId }, select: { name: true } });
        const extras = dto.extraItems.map((x) => `• ${x.designation} : ${fmtQty(x.quantity)} ${x.unit}${x.remarks ? ` — ${x.remarks}` : ''}`);
        const body = [
          `BL ${number} du ${fmtDay(deliveryDate)} — ${supplier.name} — saisi par ${ctx.displayName}`,
          ...(discrepancies.length
            ? [
                '',
                'Écarts entre reçu et commandé (cumul du BC) :',
                ...discrepancies.map(
                  (d) =>
                    `• ${d.designation} : commandé ${d.ordered} ${d.unit}, reçu ${d.received}` +
                    (D(d.missing).greaterThan(0) ? ` → manque ${d.missing}` : ` → surplus ${d.surplus}`) +
                    (d.remarks ? ` — « ${d.remarks} »` : ''),
                ),
                '',
                'Décision : attendre le reliquat, ou correction auprès du fournisseur (révision du BC ou BC complémentaire).',
              ]
            : ['', 'Reçu conforme au BC.']),
          ...(extras.length ? ['', 'Articles reçus hors BC (information) :', ...extras] : []),
          ...(dto.notes ? ['', `Remarque du bord : ${dto.notes}`] : []),
        ].join('\n');
        await this.notifications.notify(
          {
            userIds: [...purchasing, po.createdById],
            excludeUserIds: [ctx.userId],
            type: discrepancies.length ? 'purchasing.delivery_discrepancy' : 'purchasing.delivery_received',
            title: discrepancies.length
              ? `⚠ Écart de réception — BC ${po.number} : ${discrepancies.length} article(s) non conforme(s)`
              : `BL reçu — BC ${po.number} conforme`,
            body,
            module: 'purchasing',
            entityType: 'purchase_order',
            entityId: po.id,
            vesselId: po.vesselId,
            link: LINKS.po(po.id),
            priority: discrepancies.length ? 'HIGH' : 'NORMAL',
            dedupeKey: `delivery:${dn.id}`,
            email: discrepancies.length > 0,
            requiredPermission: 'bc.view',
          },
          tx,
        );
        return { deliveryNoteId: dn.id, receiptId, poId: po.id, discrepancies };
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        const r = await this.findOnboardReplay(ctx, key, hash);
        if (r) return { ...r, replay: true };
      }
      throw e;
    }
    if (!created) {
      const r = await this.findOnboardReplay(ctx, key, hash);
      if (!r) throw Errors.idempotencyConflict('Idempotency-Key déjà utilisée');
      return { ...r, replay: true };
    }
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: created.poId }, select: { id: true, number: true, status: true, lockVersion: true } });
    return { deliveryNote: await this.getDeliveryNote(ctx, created.deliveryNoteId), receiptId: created.receiptId, order: po, discrepancies: created.discrepancies, replay: false };
  }

  /** Rejeu (même clé, même contenu) : renvoie le BL d'origine sans nouveau comptage ; autre contenu => 409. */
  private async findOnboardReplay(ctx: AuthContext, key: string, hash: string) {
    const idem = await this.prisma.idempotencyKey.findUnique({ where: { userId_key: { userId: ctx.userId, key } } });
    if (!idem) return null;
    if (idem.route !== ONBOARD_ROUTE || idem.requestHash !== hash) throw Errors.idempotencyConflict('Même Idempotency-Key avec un contenu différent : nouvelle clé requise');
    const body = idem.responseBody as unknown as { deliveryNoteId: string; receiptId: string | null; discrepancies?: Discrepancy[] };
    const dn = await this.getDeliveryNote(ctx, body.deliveryNoteId);
    const po = await this.prisma.purchaseOrder.findUniqueOrThrow({ where: { id: dn.poId }, select: { id: true, number: true, status: true, lockVersion: true } });
    return { deliveryNote: dn, receiptId: body.receiptId, order: po, discrepancies: body.discrepancies ?? [] };
  }

  /** Validation du rapport de réception par une personne habilitée (receiving.validate), distincte du réceptionnaire. */
  async validateReceipt(ctx: AuthContext, id: string, dto: ValidateReceiptDto) {
    const r = await this.findReceipt(ctx, id);
    if (r.status === 'VALIDATED') throw Errors.alreadyProcessed('Rapport de réception déjà validé');
    if (r.status !== 'CONFIRMED') throw Errors.invalidState(`Réception ${r.status} : validation impossible`);
    if (r.receivedById === ctx.userId) throw Errors.selfApproval();
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.goodsReceipt.updateMany({ where: { id, status: 'CONFIRMED' }, data: { status: 'VALIDATED', validatedById: ctx.userId, validatedAt: new Date() } });
      if (!res.count) throw Errors.alreadyProcessed();
      await this.core.audit(ctx, { action: 'receipt.validated', entityType: 'goods_receipt', entityId: id, vesselId: r.vesselId, before: { status: r.status }, after: { status: 'VALIDATED' }, metadata: { comment: dto.comment } }, tx);
      await this.notifications.notify(
        {
          userIds: [r.receivedById],
          type: 'purchasing.receipt_validated',
          title: `Rapport de réception ${r.number} validé`,
          body: dto.comment ?? undefined,
          module: 'purchasing',
          entityType: 'goods_receipt',
          entityId: id,
          vesselId: r.vesselId,
          link: LINKS.receipt(id),
          requiredPermission: 'receiving.view',
        },
        tx,
      );
      return tx.goodsReceipt.findUniqueOrThrow({ where: { id }, select: { id: true, number: true, status: true, validatedById: true, validatedAt: true } });
    });
  }

  async receiptPdf(ctx: AuthContext, id: string, download: boolean) {
    const r = await this.findReceipt(ctx, id);
    const file = await this.docs.storeReceipt(ctx, id, r.vesselId);
    await this.core.audit(ctx, { action: 'receipt.pdf_generated', entityType: 'goods_receipt', entityId: id, vesselId: r.vesselId, metadata: { fileId: file.id } });
    return { fileId: file.id, ...(await this.files.issueLink(ctx, file, download ? 'download' : 'preview')) };
  }
}
