import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma, PrLine, PurchasingEntityType, StoredFile } from '@prisma/client';
import { Errors } from '../../common/errors';
import { Db, PrismaService, Tx, isSerializationFailure } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, canAccessVessel } from '../access/auth-context';
import { AuditInput, AuditService } from '../audit/audit.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService, toFileDto } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SettingsService } from '../settings/settings.service';
import {
  ATTACHMENT_MANAGE_PERMISSIONS,
  ATTACHMENT_VIEW_PERMISSIONS,
  ENTITY_AUDIT_TYPE,
  OWNER_PO_PDF,
  OWNER_PR_PDF,
  OWNER_PURCHASING_ATTACHMENT,
  OWNER_RECEIPT_PDF,
  OWNER_RFQ_PDF,
  LINKS,
} from './purchasing.constants';
import {
  BALANCE_VARIANCE_TYPES,
  OverAllocation,
  PO_COMMITTED_STATUSES,
  PR_ORDERABLE_STATUSES,
  PR_PROGRESS_STATUSES,
  PR_TERMINAL_STATUSES,
  PrLineBadge,
  assertOverAllocationAllowed,
  computeBalance,
  derivePoReceiptStatus,
  derivePrProgressStatus,
  desiredBalanceVariances,
  distributeFifo,
  effectiveQuantity,
  evaluateAllocations,
  fmtQty,
  isAutoClosable,
  max0,
  normalizeUnit,
  planBalanceVariances,
  prLineBadge,
  sumD,
} from './purchasing.logic';

/** Ligne de la vue SQL `v_po_line_balance` (migration 0002). */
export interface BalanceRow {
  poLineId: string;
  poId: string;
  lineNo: number;
  designation: string;
  unit: string;
  quantityOrdered: Prisma.Decimal;
  quantityCancelled: Prisma.Decimal;
  qtyOnDeliveryNotes: Prisma.Decimal;
  qtyPhysicallyReceived: Prisma.Decimal;
  qtyAccepted: Prisma.Decimal;
  qtyRejected: Prisma.Decimal;
  qtyRemaining: Prisma.Decimal;
  deltaNoteVsReceived: Prisma.Decimal;
  deltaOrderedVsNote: Prisma.Decimal;
}

export interface PrLineProgress {
  prLineId: string;
  lineNo: number;
  requested: string;
  approved: string | null;
  cancelled: string;
  effective: string;
  /** Alloué sur tout BC non annulé (y compris brouillons) — base du contrôle de capacité */
  allocated: string;
  /** Commandé = alloué sur BC approuvés / envoyés / reçus (V1 §8.4 « Qty Ordered ») */
  ordered: string;
  onDeliveryNotes: string;
  received: string;
  accepted: string;
  rejected: string;
  /** À commander = max(0, effectif − alloué) */
  toOrder: string;
  /** Commandé non expédié (pas encore sur BL) */
  orderedNotShipped: string;
  /** Sur BL mais non reçu physiquement */
  onNoteNotReceived: string;
  /** Commandé non accepté (reliquat) */
  orderedNotAccepted: string;
  badge: PrLineBadge;
  orders: { poId: string; poNumber: string; poStatus: string; quantity: string }[];
}

type PrLineLike = Pick<PrLine, 'id' | 'lineNo' | 'quantityRequested' | 'quantityApproved' | 'quantityCancelled' | 'status'>;

const sqlUuids = (ids: string[]) => Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));

/**
 * Filtres « ses propres PR » (droit pr.view_all absent — ex. Chief Engineer, décision AMC du 22/10/2026),
 * réutilisables hors du module Achats (tableau de bord, fiche navire) pour ne rien divulguer par les compteurs.
 */
export function prOwnFilter(ctx: AuthContext): Prisma.PurchaseRequestWhereInput {
  return can(ctx, 'pr.view_all') ? {} : { requesterId: ctx.userId };
}

export function poOwnFilter(ctx: AuthContext): Prisma.PurchaseOrderWhereInput {
  return can(ctx, 'pr.view_all') ? {} : { lines: { some: { allocations: { some: { prLine: { pr: { requesterId: ctx.userId } } } } } } };
}

/** RFQ consultant au moins une ligne d'une PR de l'utilisateur (devis : via leur RFQ). */
export function rfqOwnFilter(ctx: AuthContext): Prisma.RfqWhereInput {
  return can(ctx, 'pr.view_all') ? {} : { lines: { some: { prLine: { pr: { requesterId: ctx.userId } } } } };
}

/** Factures rattachées à au moins un BC visible (BC alloué à une PR de l'utilisateur). */
export function invoiceOwnFilter(ctx: AuthContext): Prisma.InvoiceWhereInput {
  return can(ctx, 'pr.view_all') ? {} : { orders: { some: { po: poOwnFilter(ctx) } } };
}

/**
 * Socle partagé du module Achats : scope navire, verrous, transactions sérialisables, pièces jointes,
 * rapprochement (vue v_po_line_balance), recalcul des statuts PR / BC, détection des écarts de solde
 * et resolvers d'accès aux fichiers (CDC §6, ARCHITECTURE §3).
 */
@Injectable()
export class PurchasingCore implements OnModuleInit {
  private readonly logger = new Logger('Purchasing');

  constructor(
    readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly auditService: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Visibilité « ses propres PR » (droit pr.view_all absent — ex. Chief Engineer, décision AMC 22/10/2026)
  // ---------------------------------------------------------------------------

  /** Vrai si l'utilisateur ne voit que ses propres PR (et les BC / BL qui en découlent). */
  ownPrOnly(ctx: AuthContext): boolean {
    return !can(ctx, 'pr.view_all');
  }

  /** Filtre PR complémentaire du scope navire. */
  prOwnWhere(ctx: AuthContext): Prisma.PurchaseRequestWhereInput {
    return prOwnFilter(ctx);
  }

  /** Filtre BC : BC alloués à au moins une PR dont l'utilisateur est demandeur. */
  poOwnWhere(ctx: AuthContext): Prisma.PurchaseOrderWhereInput {
    return poOwnFilter(ctx);
  }

  /** Contrôle d'accès à un BC pour un utilisateur restreint à ses PR (404 générique : rien n'est divulgué). */
  async assertPoVisible(ctx: AuthContext, poId: string, db: Db = this.prisma): Promise<void> {
    if (!this.ownPrOnly(ctx)) return;
    const n = await db.purchaseOrder.count({ where: { id: poId, ...this.poOwnWhere(ctx) } });
    if (!n) throw Errors.notFound('Bon de commande');
  }

  rfqOwnWhere(ctx: AuthContext): Prisma.RfqWhereInput {
    return rfqOwnFilter(ctx);
  }

  invoiceOwnWhere(ctx: AuthContext): Prisma.InvoiceWhereInput {
    return invoiceOwnFilter(ctx);
  }

  async assertRfqVisible(ctx: AuthContext, rfqId: string, db: Db = this.prisma): Promise<void> {
    if (!this.ownPrOnly(ctx)) return;
    const n = await db.rfq.count({ where: { id: rfqId, ...this.rfqOwnWhere(ctx) } });
    if (!n) throw Errors.notFound('RFQ');
  }

  async assertInvoiceVisible(ctx: AuthContext, invoiceId: string, db: Db = this.prisma): Promise<void> {
    if (!this.ownPrOnly(ctx)) return;
    const n = await db.invoice.count({ where: { id: invoiceId, ...this.invoiceOwnWhere(ctx) } });
    if (!n) throw Errors.notFound('Facture');
  }

  // ---------------------------------------------------------------------------
  // Resolvers d'accès fichiers (download = même permission que view : pas de permission distincte en Achats)
  // ---------------------------------------------------------------------------

  onModuleInit(): void {
    this.registry.register(OWNER_PURCHASING_ATTACHMENT, async (ctx, file) => {
      const att = await this.prisma.purchasingAttachment.findUnique({ where: { id: file.ownerId! } });
      if (!att) throw Errors.notFound('Pièce jointe');
      this.assertAnyPermission(ctx, ATTACHMENT_VIEW_PERMISSIONS[att.entityType]);
      this.access.assertVesselAccess(ctx, att.vesselId);
      // Cloisonnement « ses propres PR » sur l'entité porteuse (audit ACH-01)
      await this.entityVessel(ctx, att.entityType, att.entityId);
      return { module: 'purchasing', entityType: ENTITY_AUDIT_TYPE[att.entityType], entityId: att.entityId, vesselId: att.vesselId, downloadName: file.originalName };
    });
    this.registry.register(OWNER_PO_PDF, async (ctx, file) => {
      this.access.assertCan(ctx, 'bc.view');
      const po = await this.prisma.purchaseOrder.findUnique({ where: { id: file.ownerId! }, select: { id: true, vesselId: true } });
      if (!po) throw Errors.notFound('Bon de commande');
      this.access.assertVesselAccess(ctx, po.vesselId);
      await this.assertPoVisible(ctx, po.id);
      return { module: 'purchasing', entityType: 'purchase_order', entityId: po.id, vesselId: po.vesselId, downloadName: file.originalName };
    });
    this.registry.register(OWNER_PR_PDF, async (ctx, file) => {
      this.access.assertCan(ctx, 'pr.view');
      const pr = await this.prisma.purchaseRequest.findUnique({ where: { id: file.ownerId! }, select: { id: true, vesselId: true, requesterId: true } });
      if (!pr) throw Errors.notFound('Purchase Request');
      this.access.assertVesselAccess(ctx, pr.vesselId);
      if (this.ownPrOnly(ctx) && pr.requesterId !== ctx.userId) throw Errors.notFound('Purchase Request');
      return { module: 'purchasing', entityType: 'purchase_request', entityId: pr.id, vesselId: pr.vesselId, downloadName: file.originalName };
    });
    this.registry.register(OWNER_RFQ_PDF, async (ctx, file) => {
      this.access.assertCan(ctx, 'rfq.view');
      const rs = await this.prisma.rfqSupplier.findUnique({ where: { id: file.ownerId! }, select: { rfq: { select: { id: true, vesselId: true } } } });
      if (!rs) throw Errors.notFound('RFQ');
      this.access.assertVesselAccess(ctx, rs.rfq.vesselId);
      await this.assertRfqVisible(ctx, rs.rfq.id);
      return { module: 'purchasing', entityType: 'rfq', entityId: rs.rfq.id, vesselId: rs.rfq.vesselId, downloadName: file.originalName };
    });
    this.registry.register(OWNER_RECEIPT_PDF, async (ctx, file) => {
      this.access.assertCan(ctx, 'receiving.view');
      const r = await this.prisma.goodsReceipt.findUnique({ where: { id: file.ownerId! }, select: { id: true, vesselId: true, poId: true } });
      if (!r) throw Errors.notFound('Réception');
      this.access.assertVesselAccess(ctx, r.vesselId);
      await this.assertPoVisible(ctx, r.poId);
      return { module: 'purchasing', entityType: 'goods_receipt', entityId: r.id, vesselId: r.vesselId, downloadName: file.originalName };
    });
  }

  assertAnyPermission(ctx: AuthContext, permissions: string[]): void {
    if (!permissions.some((p) => can(ctx, p))) throw Errors.forbidden(`Permission requise : ${permissions.join(' ou ')}`, { anyOf: permissions });
  }

  // ---------------------------------------------------------------------------
  // Transactions, audit
  // ---------------------------------------------------------------------------

  /**
   * Transaction SERIALIZABLE avec reprise sur conflit de sérialisation / deadlock (y compris les erreurs
   * remontées par $queryRaw, code P2010) — allocations concurrentes, réceptions (V1 §9.3, PUR-05).
   */
  async serializable<T>(fn: (tx: Tx) => Promise<T>, retries = 4): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 30_000,
        });
      } catch (e) {
        if (attempt < retries && isSerializationFailure(e)) {
          await new Promise((r) => setTimeout(r, 15 + Math.floor(Math.random() * 60)));
          continue;
        }
        throw e;
      }
    }
  }

  audit(ctx: AuthContext | null, input: Omit<AuditInput, 'module'>, db: Db = this.prisma): Promise<void> {
    return this.auditService.record(ctx, { module: 'purchasing', ...input }, db);
  }

  // ---------------------------------------------------------------------------
  // Chargements avec contrôle de scope navire (anti-IDOR, PUR-06)
  // ---------------------------------------------------------------------------

  async vesselForWrite(ctx: AuthContext, vesselId: string, db: Db = this.prisma) {
    const vessel = await db.vessel.findUnique({ where: { id: vesselId } });
    if (!vessel) throw Errors.notFound('Navire');
    this.access.assertVesselAccess(ctx, vessel.id);
    if (vessel.status === 'SOLD' || vessel.status === 'INACTIVE') throw Errors.business(`Navire ${vessel.name} ${vessel.status} : création impossible`);
    return vessel;
  }

  async findPr(ctx: AuthContext, id: string, db: Db = this.prisma) {
    const pr = await db.purchaseRequest.findUnique({ where: { id } });
    if (!pr) throw Errors.notFound('Purchase Request');
    this.access.assertVesselAccess(ctx, pr.vesselId);
    if (this.ownPrOnly(ctx) && pr.requesterId !== ctx.userId) throw Errors.notFound('Purchase Request');
    return pr;
  }

  async findPo(ctx: AuthContext, id: string, db: Db = this.prisma) {
    const po = await db.purchaseOrder.findUnique({ where: { id } });
    if (!po) throw Errors.notFound('Bon de commande');
    this.access.assertVesselAccess(ctx, po.vesselId);
    await this.assertPoVisible(ctx, po.id, db);
    return po;
  }

  async findRfq(ctx: AuthContext, id: string, db: Db = this.prisma) {
    const rfq = await db.rfq.findUnique({ where: { id } });
    if (!rfq) throw Errors.notFound('RFQ');
    this.access.assertVesselAccess(ctx, rfq.vesselId);
    await this.assertRfqVisible(ctx, rfq.id, db);
    return rfq;
  }

  /** Verrou optimiste PR (expectedVersion) + incrément de lock_version. */
  async bumpPr(tx: Tx, pr: { id: string; lockVersion: number }, expected: number, data: Prisma.PurchaseRequestUncheckedUpdateManyInput) {
    if (pr.lockVersion !== expected) throw Errors.staleVersion(undefined, { currentVersion: pr.lockVersion });
    const res = await tx.purchaseRequest.updateMany({ where: { id: pr.id, lockVersion: expected }, data: { ...data, lockVersion: { increment: 1 } } });
    if (res.count === 0) throw Errors.staleVersion();
    return tx.purchaseRequest.findUniqueOrThrow({ where: { id: pr.id } });
  }

  async bumpPo(tx: Tx, po: { id: string; lockVersion: number }, expected: number, data: Prisma.PurchaseOrderUncheckedUpdateManyInput) {
    if (po.lockVersion !== expected) throw Errors.staleVersion(undefined, { currentVersion: po.lockVersion });
    const res = await tx.purchaseOrder.updateMany({ where: { id: po.id, lockVersion: expected }, data: { ...data, lockVersion: { increment: 1 } } });
    if (res.count === 0) throw Errors.staleVersion();
    return tx.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } });
  }

  async userNames(ids: (string | null | undefined)[], db: Db = this.prisma): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (!unique.length) return new Map();
    const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
    return new Map(rows.map((r) => [r.id, r.displayName]));
  }

  // ---------------------------------------------------------------------------
  // Pièces jointes polymorphes (owner type `purchasing_attachment`)
  // ---------------------------------------------------------------------------

  /**
   * Navire de rattachement d'une entité Achats + contrôle de scope, puis filtre « ses propres PR » (sans
   * pr.view_all : PR dont on est demandeur, BC / BL / réceptions / écarts / factures qui en découlent, RFQ et
   * devis qui les consultent) — 404 générique, comme pour l'entité elle-même (audit ACH-01).
   */
  async entityVessel(ctx: AuthContext, entityType: PurchasingEntityType, entityId: string, db: Db = this.prisma): Promise<string> {
    let vesselId: string | null | undefined;
    let ownCheck: (() => Promise<void>) | null = null;
    const viaPo = (poId: string | undefined) => async () => {
      if (!poId) throw Errors.notFound(ENTITY_AUDIT_TYPE[entityType]);
      await this.assertPoVisible(ctx, poId, db);
    };
    switch (entityType) {
      case 'PR': {
        const pr = await db.purchaseRequest.findUnique({ where: { id: entityId }, select: { vesselId: true, requesterId: true } });
        vesselId = pr?.vesselId;
        ownCheck = async () => {
          if (this.ownPrOnly(ctx) && pr?.requesterId !== ctx.userId) throw Errors.notFound('Purchase Request');
        };
        break;
      }
      case 'RFQ':
        vesselId = (await db.rfq.findUnique({ where: { id: entityId }, select: { vesselId: true } }))?.vesselId;
        ownCheck = () => this.assertRfqVisible(ctx, entityId, db);
        break;
      case 'QUOTATION': {
        const q = await db.quotation.findUnique({ where: { id: entityId }, select: { rfqId: true, rfq: { select: { vesselId: true } } } });
        vesselId = q?.rfq.vesselId;
        ownCheck = () => this.assertRfqVisible(ctx, q!.rfqId, db);
        break;
      }
      case 'PURCHASE_ORDER':
        vesselId = (await db.purchaseOrder.findUnique({ where: { id: entityId }, select: { vesselId: true } }))?.vesselId;
        ownCheck = viaPo(entityId);
        break;
      case 'DELIVERY_NOTE': {
        const dn = await db.deliveryNote.findUnique({ where: { id: entityId }, select: { vesselId: true, poId: true } });
        vesselId = dn?.vesselId;
        ownCheck = viaPo(dn?.poId);
        break;
      }
      case 'GOODS_RECEIPT': {
        const r = await db.goodsReceipt.findUnique({ where: { id: entityId }, select: { vesselId: true, poId: true } });
        vesselId = r?.vesselId;
        ownCheck = viaPo(r?.poId);
        break;
      }
      case 'VARIANCE': {
        const v = await db.variance.findUnique({ where: { id: entityId }, select: { poId: true, po: { select: { vesselId: true } } } });
        vesselId = v?.po.vesselId;
        ownCheck = viaPo(v?.poId);
        break;
      }
      case 'INVOICE':
        vesselId = (await db.invoice.findUnique({ where: { id: entityId }, select: { vesselId: true } }))?.vesselId;
        ownCheck = () => this.assertInvoiceVisible(ctx, entityId, db);
        break;
    }
    if (!vesselId) throw Errors.notFound(ENTITY_AUDIT_TYPE[entityType]);
    this.access.assertVesselAccess(ctx, vesselId);
    if (ownCheck) await ownCheck();
    return vesselId;
  }

  /** Rattache un fichier déposé (contexte PURCHASING) à une entité, dans la transaction appelante. */
  async addAttachmentTx(
    ctx: AuthContext,
    entityType: PurchasingEntityType,
    entityId: string,
    vesselId: string,
    fileId: string,
    title: string | null | undefined,
    tx: Tx,
  ) {
    const att = await tx.purchasingAttachment.create({
      data: { entityType, entityId, vesselId, fileId, title: title ?? null, uploadedById: ctx.userId },
    });
    await this.files.attach(ctx, fileId, { type: OWNER_PURCHASING_ATTACHMENT, id: att.id, contexts: ['PURCHASING'], vesselId }, tx);
    await this.audit(
      ctx,
      { action: 'attachment.added', entityType: ENTITY_AUDIT_TYPE[entityType], entityId, vesselId, after: { attachmentId: att.id, fileId, title } },
      tx,
    );
    return att;
  }

  /** Commande générique « ajouter une pièce jointe » (permission de gestion propre au type d'entité). */
  async addAttachment(ctx: AuthContext, entityType: PurchasingEntityType, entityId: string, fileId: string, title?: string | null) {
    this.assertAnyPermission(ctx, ATTACHMENT_MANAGE_PERMISSIONS[entityType]);
    const vesselId = await this.entityVessel(ctx, entityType, entityId);
    const att = await this.prisma.$transaction((tx) => this.addAttachmentTx(ctx, entityType, entityId, vesselId, fileId, title, tx));
    const file = await this.prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } });
    return { ...att, file: toFileDto(file) };
  }

  async listAttachments(ctx: AuthContext, entityType: PurchasingEntityType, entityId: string) {
    this.assertAnyPermission(ctx, ATTACHMENT_VIEW_PERMISSIONS[entityType]);
    await this.entityVessel(ctx, entityType, entityId);
    return this.attachmentsOf(entityType, [entityId]);
  }

  async attachmentsOf(entityType: PurchasingEntityType, entityIds: string[], db: Db = this.prisma) {
    if (!entityIds.length) return [];
    const rows = await db.purchasingAttachment.findMany({ where: { entityType, entityId: { in: entityIds } }, orderBy: { createdAt: 'asc' } });
    const files = rows.length ? await db.storedFile.findMany({ where: { id: { in: rows.map((r) => r.fileId) } } }) : [];
    const byId = new Map<string, StoredFile>(files.map((f) => [f.id, f]));
    return rows.map((r) => ({ ...r, file: byId.has(r.fileId) ? toFileDto(byId.get(r.fileId)!) : null }));
  }

  // ---------------------------------------------------------------------------
  // Rapprochement : vue v_po_line_balance
  // ---------------------------------------------------------------------------

  private balanceSelect = Prisma.sql`
    SELECT po_line_id AS "poLineId", po_id AS "poId", line_no AS "lineNo", designation, unit,
           quantity_ordered AS "quantityOrdered", quantity_cancelled AS "quantityCancelled",
           qty_on_delivery_notes AS "qtyOnDeliveryNotes", qty_physically_received AS "qtyPhysicallyReceived",
           qty_accepted AS "qtyAccepted", qty_rejected AS "qtyRejected", qty_remaining AS "qtyRemaining",
           delta_note_vs_received AS "deltaNoteVsReceived", delta_ordered_vs_note AS "deltaOrderedVsNote"
    FROM v_po_line_balance`;

  async balancesForPos(poIds: string[], db: Db = this.prisma): Promise<BalanceRow[]> {
    if (!poIds.length) return [];
    const rows = await db.$queryRaw<BalanceRow[]>`${this.balanceSelect} WHERE po_id IN (${sqlUuids(poIds)}) ORDER BY po_id, line_no`;
    return rows.map(normalizeBalance);
  }

  async balancesForPoLines(poLineIds: string[], db: Db = this.prisma): Promise<BalanceRow[]> {
    if (!poLineIds.length) return [];
    const rows = await db.$queryRaw<BalanceRow[]>`${this.balanceSelect} WHERE po_line_id IN (${sqlUuids(poLineIds)})`;
    return rows.map(normalizeBalance);
  }

  // ---------------------------------------------------------------------------
  // Avancement par ligne PR (badges) — allocations n:m + répartition FIFO des quantités BC
  // ---------------------------------------------------------------------------

  async prLinesProgress(lines: PrLineLike[], db: Db = this.prisma): Promise<Map<string, PrLineProgress>> {
    const ids = lines.map((l) => l.id);
    const result = new Map<string, PrLineProgress>();
    if (!ids.length) return result;
    const own = await db.poLineAllocation.findMany({ where: { prLineId: { in: ids } }, select: { poLineId: true } });
    const poLineIds = [...new Set(own.map((a) => a.poLineId))];
    const allocs = poLineIds.length
      ? await db.poLineAllocation.findMany({
          where: { poLineId: { in: poLineIds } },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: {
            poLineId: true,
            prLineId: true,
            quantity: true,
            poLine: { select: { status: true, po: { select: { id: true, number: true, status: true } } } },
          },
        })
      : [];
    const balances = new Map((await this.balancesForPoLines(poLineIds, db)).map((b) => [b.poLineId, b]));

    type Acc = { allocated: Prisma.Decimal; ordered: Prisma.Decimal; onNotes: Prisma.Decimal; received: Prisma.Decimal; accepted: Prisma.Decimal; rejected: Prisma.Decimal; orders: PrLineProgress['orders'] };
    const acc = new Map<string, Acc>();
    const zero = () => new Prisma.Decimal(0);
    ids.forEach((id) => acc.set(id, { allocated: zero(), ordered: zero(), onNotes: zero(), received: zero(), accepted: zero(), rejected: zero(), orders: [] }));

    for (const poLineId of poLineIds) {
      const active = allocs.filter((a) => a.poLineId === poLineId && a.poLine.status !== 'CANCELLED' && a.poLine.po.status !== 'CANCELLED');
      const bal = balances.get(poLineId);
      const qs = active.map((a) => a.quantity);
      const onNotes = distributeFifo(bal?.qtyOnDeliveryNotes ?? 0, qs);
      const received = distributeFifo(bal?.qtyPhysicallyReceived ?? 0, qs);
      const accepted = distributeFifo(bal?.qtyAccepted ?? 0, qs);
      const rejected = distributeFifo(bal?.qtyRejected ?? 0, qs);
      active.forEach((a, i) => {
        const x = acc.get(a.prLineId);
        if (!x) return;
        x.allocated = x.allocated.plus(a.quantity);
        if (PO_COMMITTED_STATUSES.includes(a.poLine.po.status)) x.ordered = x.ordered.plus(a.quantity);
        x.onNotes = x.onNotes.plus(onNotes[i]);
        x.received = x.received.plus(received[i]);
        x.accepted = x.accepted.plus(accepted[i]);
        x.rejected = x.rejected.plus(rejected[i]);
        x.orders.push({ poId: a.poLine.po.id, poNumber: a.poLine.po.number, poStatus: a.poLine.po.status, quantity: fmtQty(a.quantity) });
      });
    }

    for (const l of lines) {
      const x = acc.get(l.id)!;
      const effective = effectiveQuantity(l);
      result.set(l.id, {
        prLineId: l.id,
        lineNo: l.lineNo,
        requested: fmtQty(l.quantityRequested),
        approved: l.quantityApproved === null ? null : fmtQty(l.quantityApproved),
        cancelled: fmtQty(l.quantityCancelled),
        effective: fmtQty(effective),
        allocated: fmtQty(x.allocated),
        ordered: fmtQty(x.ordered),
        onDeliveryNotes: fmtQty(x.onNotes),
        received: fmtQty(x.received),
        accepted: fmtQty(x.accepted),
        rejected: fmtQty(x.rejected),
        toOrder: fmtQty(max0(effective.minus(x.allocated))),
        orderedNotShipped: fmtQty(max0(x.ordered.minus(x.onNotes))),
        onNoteNotReceived: fmtQty(max0(x.onNotes.minus(x.received))),
        orderedNotAccepted: fmtQty(max0(x.ordered.minus(x.accepted))),
        badge: prLineBadge({ status: l.status, effective, ordered: x.ordered, accepted: x.accepted }),
        orders: x.orders,
      });
    }
    return result;
  }

  /**
   * Verrou des lignes d'une PR (même verrou que le contrôle d'allocation) : sérialise annulation / mise en
   * attente / Counter-PR avec la création concurrente de BC (V1 §9.3).
   */
  async lockPrLines(tx: Tx, prId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM pr_lines WHERE pr_id = ${prId}::uuid ORDER BY id FOR UPDATE`;
  }

  /** Quantité allouée par ligne PR sur des BC non annulés. */
  async allocatedByPrLine(prLineIds: string[], db: Db = this.prisma, excludePoLineIds: string[] = []): Promise<Map<string, Prisma.Decimal>> {
    const out = new Map<string, Prisma.Decimal>(prLineIds.map((id) => [id, new Prisma.Decimal(0)]));
    if (!prLineIds.length) return out;
    const rows = await db.poLineAllocation.findMany({
      where: {
        prLineId: { in: prLineIds },
        poLine: { status: { not: 'CANCELLED' }, po: { status: { not: 'CANCELLED' } } },
        ...(excludePoLineIds.length ? { poLineId: { notIn: excludePoLineIds } } : {}),
      },
      select: { prLineId: true, quantity: true },
    });
    for (const r of rows) out.set(r.prLineId, (out.get(r.prLineId) ?? new Prisma.Decimal(0)).plus(r.quantity));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Contrôle de capacité avec verrous de lignes (V1 §9.3 : acheteurs concurrents)
  // ---------------------------------------------------------------------------

  /**
   * Verrouille les lignes PR (SELECT … FOR UPDATE) puis vérifie Σ allocations ≤ approuvé − annulé.
   * À appeler dans `serializable()`. Retourne les lignes en dépassement autorisé (motif obligatoire).
   */
  async lockAndCheckAllocations(
    ctx: AuthContext,
    tx: Tx,
    requests: { prLineId: string; quantity: Prisma.Decimal.Value; poLineUnit: string }[],
    opts: { vesselId: string; excludePoLineIds?: string[]; overAllocationReason?: string | null },
  ): Promise<OverAllocation[]> {
    const ids = [...new Set(requests.map((r) => r.prLineId))];
    if (!ids.length) return [];
    await tx.$queryRaw`SELECT id FROM pr_lines WHERE id IN (${sqlUuids(ids)}) ORDER BY id FOR UPDATE`;
    const lines = await tx.prLine.findMany({ where: { id: { in: ids } }, include: { pr: { select: { id: true, number: true, vesselId: true, status: true } } } });
    // Messages génériques tant que le scope n'est pas établi : aucun identifiant d'un autre navire n'est divulgué
    if (lines.length !== ids.length || lines.some((l) => !canAccessVessel(ctx, l.pr.vesselId))) {
      throw Errors.validation('Ligne PR introuvable dans les allocations');
    }
    for (const l of lines) {
      if (l.pr.vesselId !== opts.vesselId) throw Errors.validation('Un BC ne couvre que des PR du navire du BC');
      if (!PR_ORDERABLE_STATUSES.includes(l.pr.status)) {
        throw Errors.invalidState(`PR ${l.pr.number} au statut ${l.pr.status} : commande impossible (approbation requise, aucune Counter-PR en cours)`, {
          prId: l.pr.id,
          status: l.pr.status,
        });
      }
      if (l.status === 'CANCELLED') throw Errors.business(`PR ${l.pr.number} ligne ${l.lineNo} annulée : allocation impossible`);
      for (const r of requests.filter((x) => x.prLineId === l.id)) {
        if (normalizeUnit(r.poLineUnit) !== normalizeUnit(l.unit)) {
          throw Errors.validation(
            `PR ${l.pr.number} ligne ${l.lineNo} : unité « ${l.unit} » ≠ unité BC « ${r.poLineUnit} » (aucune conversion implicite)`,
            { prLineId: l.id },
          );
        }
      }
    }
    const allocated = await this.allocatedByPrLine(ids, tx, opts.excludePoLineIds ?? []);
    const over = evaluateAllocations(
      lines.map((l) => ({ prLineId: l.id, prNumber: l.pr.number, lineNo: l.lineNo, effective: effectiveQuantity(l), allocated: allocated.get(l.id) })),
      requests,
    );
    assertOverAllocationAllowed(over, await this.settings.get('purchasing.allowOverAllocation'), opts.overAllocationReason);
    return over;
  }

  // ---------------------------------------------------------------------------
  // Recalcul des statuts (PR d'avancement, BC de réception)
  // ---------------------------------------------------------------------------

  async derivePrStatus(prId: string, db: Db = this.prisma) {
    const lines = await db.prLine.findMany({ where: { prId } });
    const progress = await this.prLinesProgress(lines, db);
    const hasActiveRfq =
      (await db.rfqLine.count({
        where: { prLineId: { in: lines.map((l) => l.id) }, rfq: { status: { in: ['ISSUED', 'QUOTED', 'EVALUATED'] } } },
      })) > 0;
    return derivePrProgressStatus(
      lines.map((l) => ({ status: l.status, effective: effectiveQuantity(l), ordered: progress.get(l.id)!.ordered, accepted: progress.get(l.id)!.accepted })),
      hasActiveRfq,
    );
  }

  /**
   * Recalcule le statut d'avancement des PR approuvées (aucun effet sur DRAFT/REVISED/ON_HOLD/terminaux).
   * Une PR entièrement reçue, sans écart ouvert sur ses BC, est clôturée automatiquement ; une PR mère
   * divisée est clôturée quand toutes ses sous-PR sont terminées.
   */
  async recomputePrStatuses(ctx: AuthContext | null, prIds: string[], tx: Tx, trigger: string): Promise<void> {
    const parents = new Set<string>();
    for (const prId of [...new Set(prIds)]) {
      const pr = await tx.purchaseRequest.findUnique({
        where: { id: prId },
        select: { id: true, number: true, status: true, vesselId: true, requesterId: true, parentId: true },
      });
      if (!pr || !PR_PROGRESS_STATUSES.includes(pr.status)) continue;
      const derived = await this.derivePrStatus(prId, tx);
      let next = derived;
      if (derived === 'RECEIVED' && isAutoClosable({ status: derived, openVariances: await this.openVariancesForPr(prId, tx) })) next = 'CLOSED';
      if (!next || next === pr.status) continue;
      await tx.purchaseRequest.update({
        where: { id: prId },
        data: { status: next, lockVersion: { increment: 1 }, ...(next === 'CLOSED' ? { closedAt: new Date() } : {}) },
      });
      await this.audit(
        ctx,
        {
          action: next === 'CLOSED' ? 'pr.auto_closed' : 'pr.status_recomputed',
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          before: { status: pr.status },
          after: { status: next },
          metadata: { trigger, ...(next === 'CLOSED' ? { rule: 'Tout ce qui figure sur les BC a été reçu, aucun écart ouvert' } : {}) },
        },
        tx,
      );
      if (next === 'CLOSED') {
        await this.notifications.notify(
          {
            userIds: [pr.requesterId],
            type: 'purchasing.pr_closed',
            title: `PR ${pr.number} clôturée : tout a été reçu`,
            body: 'Les articles des bons de commande ont tous été reçus à bord, sans écart ouvert.',
            module: 'purchasing',
            entityType: 'purchase_request',
            entityId: prId,
            vesselId: pr.vesselId,
            link: LINKS.pr(prId),
            dedupeKey: `pr:${prId}:auto-closed`,
            requiredPermission: 'pr.view',
          },
          tx,
        );
        if (pr.parentId) parents.add(pr.parentId);
      }
    }
    for (const parentId of parents) await this.closeParentIfDone(ctx, parentId, tx, trigger);
  }

  /** PR mère « Divisée » : clôturée quand toutes ses sous-PR sont clôturées, annulées ou rejetées. */
  async closeParentIfDone(ctx: AuthContext | null, parentId: string, tx: Tx, trigger: string): Promise<void> {
    const parent = await tx.purchaseRequest.findUnique({ where: { id: parentId }, select: { id: true, status: true, vesselId: true } });
    if (!parent || parent.status !== 'SPLIT') return;
    const open = await tx.purchaseRequest.count({ where: { parentId, status: { notIn: [...PR_TERMINAL_STATUSES] } } });
    if (open) return;
    await tx.purchaseRequest.update({ where: { id: parentId }, data: { status: 'CLOSED', closedAt: new Date(), lockVersion: { increment: 1 } } });
    await this.audit(
      ctx,
      {
        action: 'pr.auto_closed',
        entityType: 'purchase_request',
        entityId: parentId,
        vesselId: parent.vesselId,
        before: { status: 'SPLIT' },
        after: { status: 'CLOSED' },
        metadata: { trigger, rule: 'Toutes les sous-PR sont terminées' },
      },
      tx,
    );
  }

  /** Écarts ouverts (OPEN / IN_PROGRESS) sur les BC non annulés liés à une PR. */
  async openVariancesForPr(prId: string, db: Db = this.prisma): Promise<number> {
    return db.variance.count({
      where: {
        status: { in: ['OPEN', 'IN_PROGRESS'] },
        po: { status: { not: 'CANCELLED' }, lines: { some: { allocations: { some: { prLine: { prId } } } } } },
      },
    });
  }

  /**
   * Clôture automatique des BC entièrement reçus sans écart ouvert, puis recalcul (et clôture éventuelle) des PR
   * liées. À appeler après tout événement qui modifie le reçu ou les écarts (BL, correction, résolution d'écart).
   */
  async settleClosures(ctx: AuthContext | null, poIds: string[], tx: Tx, trigger: string): Promise<void> {
    for (const poId of [...new Set(poIds)]) {
      const po = await tx.purchaseOrder.findUnique({ where: { id: poId }, select: { id: true, status: true, vesselId: true } });
      if (!po) continue;
      const openVariances = await tx.variance.count({ where: { poId, status: { in: ['OPEN', 'IN_PROGRESS'] } } });
      if (!isAutoClosable({ status: po.status, openVariances })) continue;
      await tx.purchaseOrder.update({ where: { id: poId }, data: { status: 'CLOSED', closedAt: new Date(), lockVersion: { increment: 1 } } });
      await this.audit(
        ctx,
        {
          action: 'po.auto_closed',
          entityType: 'purchase_order',
          entityId: poId,
          vesselId: po.vesselId,
          before: { status: po.status },
          after: { status: 'CLOSED' },
          metadata: { trigger, rule: 'Tout le BC a été reçu, aucun écart ouvert' },
        },
        tx,
      );
    }
    await this.recomputePrStatuses(ctx, await this.prIdsForPos(poIds, tx), tx, trigger);
  }

  async prIdsForPos(poIds: string[], db: Db = this.prisma): Promise<string[]> {
    if (!poIds.length) return [];
    const rows = await db.poLineAllocation.findMany({ where: { poLine: { poId: { in: poIds } } }, select: { prLine: { select: { prId: true } } } });
    return [...new Set(rows.map((r) => r.prLine.prId))];
  }

  /** Statut de réception du BC depuis v_po_line_balance (PARTIALLY_RECEIVED / RECEIVED) — jamais depuis une facture. */
  async recomputePoStatus(ctx: AuthContext | null, poId: string, tx: Tx, trigger: string) {
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId } });
    const lines = await tx.poLine.findMany({ where: { poId }, select: { id: true, status: true } });
    const balances = await this.balancesForPos([poId], tx);
    const next = derivePoReceiptStatus(
      po.status,
      balances.map((b) => ({
        status: lines.find((l) => l.id === b.poLineId)?.status ?? 'OPEN',
        ordered: b.quantityOrdered,
        cancelled: b.quantityCancelled,
        onNotes: b.qtyOnDeliveryNotes,
        received: b.qtyPhysicallyReceived,
        accepted: b.qtyAccepted,
        rejected: b.qtyRejected,
      })),
    );
    if (next !== po.status) {
      await tx.purchaseOrder.update({ where: { id: poId }, data: { status: next, lockVersion: { increment: 1 } } });
      await this.audit(
        ctx,
        { action: 'po.status_recomputed', entityType: 'purchase_order', entityId: poId, vesselId: po.vesselId, before: { status: po.status }, after: { status: next }, metadata: { trigger } },
        tx,
      );
    }
    return next;
  }

  // ---------------------------------------------------------------------------
  // Écarts de solde (short-shipped / short-received / surplus) synchronisés sur l'état cumulé
  // ---------------------------------------------------------------------------

  async syncBalanceVariances(ctx: AuthContext, poId: string, tx: Tx, receiptId: string | null) {
    const balances = await this.balancesForPos([poId], tx);
    const lines = await tx.poLine.findMany({ where: { poId }, select: { id: true, status: true } });
    const hasDeliveryNotes = (await tx.deliveryNote.count({ where: { poId, status: { not: 'CANCELLED' } } })) > 0;
    // Quantités des BL déjà réceptionnés (statut RECEIVED) : base du short-received
    const receivedNoteLines = await tx.deliveryNoteLine.findMany({
      where: { deliveryNote: { poId, status: 'RECEIVED' } },
      select: { poLineId: true, quantityOnNote: true },
    });
    const open = await tx.variance.findMany({
      where: { poId, status: { in: ['OPEN', 'IN_PROGRESS'] }, type: { in: [...BALANCE_VARIANCE_TYPES] } },
      orderBy: { createdAt: 'asc' },
    });
    const po = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: poId }, select: { vesselId: true } });
    const created: { id: string; type: string; quantity: string; poLineId: string }[] = [];
    const resolved: string[] = [];
    for (const b of balances) {
      const line = lines.find((l) => l.id === b.poLineId);
      const facts = {
        ordered: b.quantityOrdered,
        cancelled: b.quantityCancelled,
        onNotes: b.qtyOnDeliveryNotes,
        received: b.qtyPhysicallyReceived,
        accepted: b.qtyAccepted,
        rejected: b.qtyRejected,
      };
      const desired =
        line?.status === 'CANCELLED'
          ? { SHORT_SHIPPED: new Prisma.Decimal(0), SHORT_RECEIVED: new Prisma.Decimal(0), SURPLUS: new Prisma.Decimal(0) }
          : desiredBalanceVariances(facts, {
              hasDeliveryNotes,
              onReceivedNotes: sumD(receivedNoteLines.filter((n) => n.poLineId === b.poLineId).map((n) => n.quantityOnNote)),
            });
      const plan = planBalanceVariances(
        open.filter((v) => v.poLineId === b.poLineId),
        desired,
      );
      const bal = computeBalance(facts);
      const describe = (type: string, q: Prisma.Decimal) =>
        type === 'SHORT_SHIPPED'
          ? `Ligne ${b.lineNo} — short-shipped : commandé ${fmtQty(bal.effectiveOrdered)} ${b.unit}, cumul BL ${fmtQty(b.qtyOnDeliveryNotes)} (manque ${fmtQty(q)})`
          : type === 'SHORT_RECEIVED'
            ? `Ligne ${b.lineNo} — short-received : BL réceptionnés ${fmtQty(q.plus(b.qtyPhysicallyReceived))} ${b.unit}, reçu physiquement ${fmtQty(b.qtyPhysicallyReceived)} (manque ${fmtQty(q)})`
            : `Ligne ${b.lineNo} — surplus : reçu ${fmtQty(b.qtyPhysicallyReceived)} ${b.unit} pour ${fmtQty(bal.effectiveOrdered)} commandé(s) (surplus ${fmtQty(q)})`;
      for (const c of plan.create) {
        const v = await tx.variance.create({
          data: { poId, poLineId: b.poLineId, receiptId, type: c.type, quantity: c.quantity, description: describe(c.type, c.quantity), createdById: ctx.userId },
        });
        created.push({ id: v.id, type: v.type, quantity: fmtQty(v.quantity), poLineId: v.poLineId });
        await this.audit(ctx, { action: 'variance.detected', entityType: 'variance', entityId: v.id, vesselId: po.vesselId, after: v }, tx);
      }
      for (const u of plan.update) {
        const type = open.find((v) => v.id === u.id)!.type;
        await tx.variance.update({ where: { id: u.id }, data: { quantity: u.quantity, description: describe(type, u.quantity) } });
        await this.audit(ctx, { action: 'variance.quantity_updated', entityType: 'variance', entityId: u.id, vesselId: po.vesselId, after: { quantity: u.quantity } }, tx);
      }
      for (const r of plan.resolve) {
        await tx.variance.update({
          where: { id: r.id },
          data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: 'Résolu automatiquement : solde comblé (livraison, réception ou avenant ultérieurs)' },
        });
        resolved.push(r.id);
        await this.audit(ctx, { action: 'variance.auto_resolved', entityType: 'variance', entityId: r.id, vesselId: po.vesselId, after: { status: 'RESOLVED' } }, tx);
      }
    }
    return { created, resolved };
  }

  /** Somme décimale utilitaire exposée aux services. */
  sum(values: Prisma.Decimal.Value[]): Prisma.Decimal {
    return sumD(values);
  }
}

function normalizeBalance(r: BalanceRow): BalanceRow {
  const d = (v: unknown) => (Prisma.Decimal.isDecimal(v) ? (v as Prisma.Decimal) : new Prisma.Decimal(String(v ?? 0)));
  return {
    ...r,
    lineNo: Number(r.lineNo),
    quantityOrdered: d(r.quantityOrdered),
    quantityCancelled: d(r.quantityCancelled),
    qtyOnDeliveryNotes: d(r.qtyOnDeliveryNotes),
    qtyPhysicallyReceived: d(r.qtyPhysicallyReceived),
    qtyAccepted: d(r.qtyAccepted),
    qtyRejected: d(r.qtyRejected),
    qtyRemaining: d(r.qtyRemaining),
    deltaNoteVsReceived: d(r.deltaNoteVsReceived),
    deltaOrderedVsNote: d(r.deltaOrderedVsNote),
  };
}
