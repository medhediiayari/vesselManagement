import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createZodDto } from 'nestjs-zod';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { ExcelService, ExportColumn } from '../documents/excel.service';
import { FilesService } from '../files/files.service';
import { ListOrdersFilters, ListOrdersSchema } from './orders.dto';
import { OrdersService } from './orders.service';
import { ListPrFilters, ListPrSchema } from './purchase-requests.dto';
import { PurchaseRequestsService } from './purchase-requests.service';
import { PurchasingCore } from './purchasing-core.service';
import { MAX_EXPORT_ROWS, OWNER_EXPORT_JOB } from './purchasing.constants';
import { D } from './purchasing.logic';

export class ExportPrQuery extends createZodDto(ListPrSchema.omit({ limit: true, cursor: true })) {}
export class ExportOrdersQuery extends createZodDto(ListOrdersSchema.omit({ limit: true, cursor: true })) {}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(D(v as string).toFixed(3)));
const money = (v: unknown) => (v === null || v === undefined ? null : Number(D(v as string).toFixed(2)));
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

/**
 * Exports Excel Achats (reports.export) : mêmes filtres et MÊME scope navire que les listes (aucun élément hors
 * périmètre), fichier stocké en contexte EXPORT (accès réservé au demandeur, rétention courte), lien signé,
 * export audité avec ses filtres.
 */
@Injectable()
export class PurchasingExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly excel: ExcelService,
    private readonly files: FilesService,
    private readonly prs: PurchaseRequestsService,
    private readonly orders: OrdersService,
  ) {}

  private async store(ctx: AuthContext, buffer: Buffer, fileName: string, resource: string, params: Record<string, unknown>, itemCount: number) {
    const jobId = randomUUID();
    const file = await this.files.storeGenerated(buffer, fileName, 'EXCEL', XLSX_MIME, 'EXPORT', null, ctx.userId, { type: OWNER_EXPORT_JOB, id: jobId });
    await this.prisma.$transaction(async (tx) => {
      await tx.exportJob.create({
        data: {
          id: jobId,
          format: 'XLSX',
          module: 'purchasing',
          resource,
          params: JSON.parse(JSON.stringify(params)),
          status: 'COMPLETED',
          fileId: file.id,
          itemCount,
          requestedById: ctx.userId,
          finishedAt: new Date(),
        },
      });
      await this.core.audit(ctx, { action: 'purchasing.export', entityType: 'export_job', entityId: jobId, metadata: { resource, filters: params, itemCount, fileId: file.id, format: 'XLSX' } }, tx);
    });
    return { exportJobId: jobId, itemCount, fileId: file.id, ...(await this.files.issueLink(ctx, file, 'download')) };
  }

  async purchaseRequests(ctx: AuthContext, q: Partial<ListPrFilters>) {
    const where = this.prs.buildWhere(ctx, q);
    const rows = await this.prisma.purchaseRequest.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS + 1,
      include: { vessel: { select: { code: true, name: true } }, lines: { orderBy: { lineNo: 'asc' } } },
    });
    if (rows.length > MAX_EXPORT_ROWS) throw Errors.business(`Export limité à ${MAX_EXPORT_ROWS} PR : affinez les filtres`);
    const progress = await this.core.prLinesProgress(rows.flatMap((r) => r.lines));
    const names = await this.core.userNames(rows.map((r) => r.requesterId));
    const headerCols: ExportColumn[] = [
      { header: 'N° PR', key: 'number', width: 20 },
      { header: 'Navire', key: 'vessel', width: 20 },
      { header: 'Date', key: 'requestDate', width: 12 },
      { header: 'Demandeur', key: 'requester', width: 26 },
      { header: 'Catégorie', key: 'category', width: 22 },
      { header: 'Priorité', key: 'priority', width: 10 },
      { header: 'Besoin pour le', key: 'neededBy', width: 14 },
      { header: 'Objet', key: 'subject', width: 36 },
      { header: 'Statut', key: 'status', width: 20 },
      { header: 'Lignes', key: 'lines', width: 8 },
      { header: 'Lignes reçues', key: 'received', width: 12 },
    ];
    const lineCols: ExportColumn[] = [
      { header: 'N° PR', key: 'number', width: 20 },
      { header: 'ITEM', key: 'lineNo', width: 6 },
      { header: 'Désignation', key: 'designation', width: 40 },
      { header: 'Référence', key: 'reference', width: 20 },
      { header: 'Unité', key: 'unit', width: 8 },
      { header: 'ROB', key: 'rob', width: 10 },
      { header: 'Qté demandée', key: 'requested', width: 12, numFmt: '0.###' },
      { header: 'Qté effective', key: 'effective', width: 12, numFmt: '0.###' },
      { header: 'Commandé', key: 'ordered', width: 11, numFmt: '0.###' },
      { header: 'Sur BL', key: 'onNotes', width: 9, numFmt: '0.###' },
      { header: 'Reçu physique', key: 'received', width: 12, numFmt: '0.###' },
      { header: 'Accepté', key: 'accepted', width: 9, numFmt: '0.###' },
      { header: 'Rejeté', key: 'rejected', width: 9, numFmt: '0.###' },
      { header: 'À commander', key: 'toOrder', width: 12, numFmt: '0.###' },
      { header: 'Avancement', key: 'badge', width: 18 },
      { header: 'BC', key: 'orders', width: 28 },
      { header: 'Remarques', key: 'remarks', width: 30 },
    ];
    const buffer = await this.excel.writeXlsx([
      {
        name: 'Purchase Requests',
        columns: headerCols,
        rows: rows.map((r) => ({
          number: r.number,
          vessel: r.vessel.name,
          requestDate: day(r.requestDate),
          requester: names.get(r.requesterId) ?? '',
          category: r.category,
          priority: r.priority,
          neededBy: day(r.neededBy),
          subject: r.subject,
          status: r.status,
          lines: r.lines.length,
          received: r.lines.filter((l) => progress.get(l.id)?.badge === 'RECEIVED').length,
        })),
      },
      {
        name: 'Lignes',
        columns: lineCols,
        rows: rows.flatMap((r) =>
          r.lines.map((l) => {
            const p = progress.get(l.id)!;
            return {
              number: r.number,
              lineNo: l.lineNo,
              designation: l.designation,
              reference: l.reference,
              unit: l.unit,
              rob: l.rob,
              requested: num(p.requested),
              effective: num(p.effective),
              ordered: num(p.ordered),
              onNotes: num(p.onDeliveryNotes),
              received: num(p.received),
              accepted: num(p.accepted),
              rejected: num(p.rejected),
              toOrder: num(p.toOrder),
              badge: p.badge,
              orders: p.orders.map((o) => `${o.poNumber} (${o.quantity})`).join(', '),
              remarks: l.remarks,
            };
          }),
        ),
      },
    ]);
    return this.store(ctx, buffer, `purchase-requests-${new Date().toISOString().slice(0, 10)}.xlsx`, 'purchase_requests', q, rows.length);
  }

  async purchaseOrders(ctx: AuthContext, q: Partial<ListOrdersFilters>) {
    const where = this.orders.buildWhere(ctx, q);
    const rows = await this.prisma.purchaseOrder.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS + 1,
      include: {
        vessel: { select: { name: true } },
        supplier: { select: { name: true } },
        lines: { orderBy: { lineNo: 'asc' }, include: { allocations: { include: { prLine: { select: { lineNo: true, pr: { select: { number: true } } } } } } } },
      },
    });
    if (rows.length > MAX_EXPORT_ROWS) throw Errors.business(`Export limité à ${MAX_EXPORT_ROWS} BC : affinez les filtres`);
    const balances = new Map((await this.core.balancesForPos(rows.map((r) => r.id))).map((b) => [b.poLineId, b]));
    const buffer = await this.excel.writeXlsx([
      {
        name: 'Bons de commande',
        columns: [
          { header: 'N° BC', key: 'number', width: 20 },
          { header: 'Navire', key: 'vessel', width: 20 },
          { header: 'Fournisseur', key: 'supplier', width: 28 },
          { header: 'Statut', key: 'status', width: 18 },
          { header: 'Date', key: 'orderDate', width: 12 },
          { header: 'Livraison attendue', key: 'expected', width: 16 },
          { header: 'Devise', key: 'currency', width: 8 },
          { header: 'Sous-total', key: 'subtotal', width: 14, numFmt: '#,##0.00' },
          { header: 'Taxes', key: 'tax', width: 12, numFmt: '#,##0.00' },
          { header: 'Fret', key: 'freight', width: 12, numFmt: '#,##0.00' },
          { header: 'Total', key: 'total', width: 14, numFmt: '#,##0.00' },
          { header: 'Révision', key: 'revisionNo', width: 9 },
          { header: 'PR', key: 'prs', width: 28 },
        ],
        rows: rows.map((r) => ({
          number: r.number,
          vessel: r.vessel.name,
          supplier: r.supplier.name,
          status: r.status,
          orderDate: day(r.orderDate),
          expected: day(r.expectedDeliveryDate),
          currency: r.currency,
          subtotal: money(r.subtotal),
          tax: money(r.taxAmount),
          freight: money(r.freightAmount),
          total: money(r.totalAmount),
          revisionNo: r.revisionNo,
          prs: [...new Set(r.lines.flatMap((l) => l.allocations.map((a) => a.prLine.pr.number)))].join(', '),
        })),
      },
      {
        name: 'Lignes et rapprochement',
        columns: [
          { header: 'N° BC', key: 'number', width: 20 },
          { header: 'N°', key: 'lineNo', width: 5 },
          { header: 'Désignation', key: 'designation', width: 36 },
          { header: 'Unité', key: 'unit', width: 8 },
          { header: 'Commandé (BC)', key: 'ordered', width: 13, numFmt: '0.###' },
          { header: 'Annulé', key: 'cancelled', width: 9, numFmt: '0.###' },
          { header: 'BL', key: 'onNotes', width: 9, numFmt: '0.###' },
          { header: 'Reçu physique', key: 'received', width: 12, numFmt: '0.###' },
          { header: 'Accepté', key: 'accepted', width: 9, numFmt: '0.###' },
          { header: 'Rejeté', key: 'rejected', width: 9, numFmt: '0.###' },
          { header: 'Reliquat', key: 'remaining', width: 9, numFmt: '0.###' },
          { header: 'PU', key: 'unitPrice', width: 12, numFmt: '#,##0.0000' },
          { header: 'Total ligne', key: 'lineTotal', width: 13, numFmt: '#,##0.00' },
          { header: 'Lignes PR', key: 'prLines', width: 26 },
        ],
        rows: rows.flatMap((r) =>
          r.lines.map((l) => {
            const b = balances.get(l.id);
            return {
              number: r.number,
              lineNo: l.lineNo,
              designation: l.designation,
              unit: l.unit,
              ordered: num(l.quantityOrdered),
              cancelled: num(l.quantityCancelled),
              onNotes: num(b?.qtyOnDeliveryNotes ?? 0),
              received: num(b?.qtyPhysicallyReceived ?? 0),
              accepted: num(b?.qtyAccepted ?? 0),
              rejected: num(b?.qtyRejected ?? 0),
              remaining: num(b?.qtyRemaining ?? 0),
              unitPrice: Number(D(l.unitPrice).toFixed(4)),
              lineTotal: money(l.lineTotal),
              prLines: l.allocations.map((a) => `${a.prLine.pr.number}/${a.prLine.lineNo} (${D(a.quantity).toString()})`).join(', '),
            };
          }),
        ),
      },
    ]);
    return this.store(ctx, buffer, `purchase-orders-${new Date().toISOString().slice(0, 10)}.xlsx`, 'purchase_orders', q, rows.length);
  }
}
