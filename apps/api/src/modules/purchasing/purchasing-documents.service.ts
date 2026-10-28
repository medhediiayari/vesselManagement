import { Injectable } from '@nestjs/common';
import { StoredFile } from '@prisma/client';
import { Db, PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { PdfService } from '../documents/pdf.service';
import { FilesService } from '../files/files.service';
import { PurchasingCore } from './purchasing-core.service';
import { OWNER_PO_PDF, OWNER_PR_PDF, OWNER_RECEIPT_PDF, OWNER_RFQ_PDF } from './purchasing.constants';
import { D, fmtMoney, fmtQty, workingQuantity } from './purchasing.logic';

const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);
const stamp = (d: Date | null | undefined) => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : null);

const PR_STATUS_FR: Record<string, string> = {
  DRAFT: 'Brouillon',
  SUBMITTED: 'Soumise',
  UNDER_REVIEW: 'En discussion (Achats)',
  REVISED: 'Counter-PR proposée',
  APPROVED: 'Validée',
  SOURCING: 'Consultation en cours',
  PARTIALLY_ORDERED: 'Partiellement commandée',
  ORDERED: 'Commandée',
  PARTIALLY_RECEIVED: 'Partiellement reçue',
  RECEIVED: 'Reçue',
  CLOSED: 'Clôturée',
  CANCELLED: 'Annulée',
  REJECTED: 'Rejetée',
  ON_HOLD: 'En attente',
  SPLIT: 'Divisée en sous-PR',
};

/**
 * Documents PDF Achats (V1 §9.2 « Export PDF des PR/BC/Receiving Report ») : numérotation cohérente,
 * informations navire, attribution horodatée des approbations — pas de signature cryptographique en V1 (CDC §17).
 * Les PDF sont stockés via FilesService.storeGenerated (propriétaire logique => resolver d'accès).
 */
@Injectable()
export class PurchasingDocuments {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pdf: PdfService,
    private readonly files: FilesService,
    private readonly core: PurchasingCore,
  ) {}

  // ---------------------------------------------------------------------------
  // PR
  // ---------------------------------------------------------------------------

  async renderPr(prId: string, author: string): Promise<{ buffer: Buffer; fileName: string }> {
    const pr = await this.prisma.purchaseRequest.findUniqueOrThrow({
      where: { id: prId },
      include: { vessel: true, lines: { orderBy: { lineNo: 'asc' } }, revisions: { orderBy: { revisionNo: 'asc' } } },
    });
    const dept = pr.departmentId ? await this.prisma.department.findUnique({ where: { id: pr.departmentId } }) : null;
    const names = await this.core.userNames([pr.requesterId, pr.approvedById, ...pr.revisions.flatMap((r) => [r.proposedById, r.decidedById])]);
    const circuit = pr.reviewCircuit as { label?: string; captainApprovalRequired?: boolean } | null;
    const buffer = await this.pdf.render(
      {
        title: 'Purchase Request',
        subtitle: pr.subject,
        reference: pr.number,
        author,
        meta: [
          ['Navire', pr.vessel.name],
          ['Date de la demande', day(pr.requestDate) ?? ''],
          ['Statut', PR_STATUS_FR[pr.status] ?? pr.status],
        ],
      },
      (b) => {
        b.section('Informations', 1).fields(
          [
            ['Demandeur', names.get(pr.requesterId) ?? pr.requesterId],
            ['Département', dept?.name],
            ['Catégorie', pr.category],
            ['Priorité', pr.priority],
            ['Besoin pour le', day(pr.neededBy)],
            ['Formulaire', pr.formRef],
            ['Circuit de revue appliqué', circuit?.label ?? '—'],
            ['Visa Captain requis', circuit ? (circuit.captainApprovalRequired ? 'Oui' : 'Non') : '—'],
          ],
          2,
        );
        if (pr.comment) b.paragraph('Commentaire', pr.comment);
        b.section('Lignes (demande d’origine et quantités de travail)', 2).table(
          [
            { header: 'ITEM', key: 'lineNo', width: 30, align: 'center' },
            { header: 'Désignation', key: 'designation', width: 150 },
            { header: 'Référence', key: 'reference', width: 80 },
            { header: 'Qté demandée', key: 'requested', width: 55, align: 'right' },
            { header: 'Unité', key: 'unit', width: 40 },
            { header: 'ROB', key: 'rob', width: 40 },
            { header: 'Qté approuvée', key: 'approved', width: 55, align: 'right' },
            { header: 'Remarques', key: 'remarks', width: 110 },
          ],
          pr.lines.map((l) => ({
            lineNo: l.lineNo,
            designation: `${l.designation}${l.addedByRevisionId ? ' (ajout Counter-PR)' : ''}${l.status === 'CANCELLED' ? ' [ANNULÉE]' : ''}`,
            reference: l.reference,
            requested: fmtQty(l.quantityRequested),
            unit: l.unit,
            rob: l.rob,
            approved: l.quantityApproved === null ? null : fmtQty(D(workingQuantity(l)).minus(l.quantityCancelled)),
            remarks: l.remarks,
          })),
        );
        if (pr.revisions.length) {
          b.section('Révisions / Counter-PR', 3).table(
            [
              { header: 'N°', key: 'no', width: 30, align: 'center' },
              { header: 'Statut', key: 'status', width: 80 },
              { header: 'Proposée par', key: 'by', width: 110 },
              { header: 'Décision par', key: 'decidedBy', width: 110 },
              { header: 'Justification', key: 'justification', width: 190 },
            ],
            pr.revisions.map((r) => ({
              no: r.revisionNo,
              status: r.status,
              by: `${names.get(r.proposedById) ?? ''} ${stamp(r.proposedAt) ?? ''}`,
              decidedBy: r.decidedById ? `${names.get(r.decidedById) ?? ''} ${stamp(r.decidedAt) ?? ''}` : null,
              justification: r.justification,
            })),
          );
        }
        b.signatures([
          { label: 'Demandeur', name: names.get(pr.requesterId), date: stamp(pr.submittedAt) },
          { label: 'Approbation Purchasing', name: pr.approvedById ? names.get(pr.approvedById) : null, date: stamp(pr.approvedAt) },
        ]);
        b.note('Attribution horodatée issue du journal d’audit — aucune signature cryptographique en V1 (CDC §17).');
      },
    );
    return { buffer, fileName: `${pr.number}.pdf` };
  }

  async storePr(ctx: AuthContext, prId: string, vesselId: string): Promise<StoredFile> {
    // Réutilise un PDF récent (5 min) généré après la dernière modification de la PR :
    // évite de stocker un nouveau blob à chaque aperçu, sans servir un état périmé.
    const pr = await this.prisma.purchaseRequest.findUniqueOrThrow({ where: { id: prId }, select: { updatedAt: true } });
    const recentSince = new Date(Math.max(pr.updatedAt.getTime(), Date.now() - 5 * 60_000));
    const cached = await this.prisma.storedFile.findFirst({
      where: { ownerType: OWNER_PR_PDF, ownerId: prId, deletedAt: null, createdAt: { gte: recentSince } },
      orderBy: { createdAt: 'desc' },
    });
    if (cached) return cached;
    const { buffer, fileName } = await this.renderPr(prId, ctx.displayName);
    return this.files.storeGenerated(buffer, fileName, 'PDF', 'application/pdf', 'GENERATED', vesselId, ctx.userId, { type: OWNER_PR_PDF, id: prId });
  }

  // ---------------------------------------------------------------------------
  // RFQ (document fournisseur : aucune donnée interne de prix ni de demandeur)
  // ---------------------------------------------------------------------------

  async renderRfq(rfqId: string, supplierId: string, author: string): Promise<{ buffer: Buffer; fileName: string }> {
    const rfq = await this.prisma.rfq.findUniqueOrThrow({ where: { id: rfqId }, include: { vessel: true, lines: { orderBy: { lineNo: 'asc' } } } });
    const supplier = await this.prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } });
    const buffer = await this.pdf.render(
      {
        title: 'Demande de prix (RFQ)',
        subtitle: rfq.title,
        reference: rfq.number,
        author,
        meta: [
          ['Navire', rfq.vessel.name],
          ['Fournisseur', supplier.name],
          ['Date limite de réponse', stamp(rfq.deadline) ?? 'Non précisée'],
        ],
      },
      (b) => {
        b.section('Destinataire', 1).fields(
          [
            ['Fournisseur', supplier.legalName ?? supplier.name],
            ['Code', supplier.code],
            ['Adresse', supplier.address],
            ['E-mail', supplier.email],
          ],
          2,
        );
        b.section('Conditions demandées', 2).fields(
          [
            ['Navire', `${rfq.vessel.name}${rfq.vessel.imoNumber ? ` (IMO ${rfq.vessel.imoNumber})` : ''}`],
            ['Port de livraison', rfq.deliveryPort],
            ['Conditions de livraison', rfq.deliveryTerms],
            ['Date limite', stamp(rfq.deadline)],
          ],
          2,
        );
        if (rfq.notes) b.paragraph('Notes', rfq.notes);
        b.section('Articles', 3).table(
          [
            { header: 'N°', key: 'lineNo', width: 30, align: 'center' },
            { header: 'Désignation', key: 'designation', width: 220 },
            { header: 'Référence', key: 'reference', width: 110 },
            { header: 'Quantité', key: 'quantity', width: 60, align: 'right' },
            { header: 'Unité', key: 'unit', width: 45 },
            { header: 'Remarques', key: 'remarks', width: 120 },
          ],
          rfq.lines.map((l) => ({ ...l, quantity: fmtQty(l.quantity) })),
        );
        b.note(
          'Merci d’indiquer pour chaque article : prix unitaire, devise, disponibilité, délai, conformité / alternative proposée, ' +
            'ainsi que frais de transport, taxes, Incoterm et validité de l’offre. Joindre votre devis au format PDF.',
        );
      },
    );
    return { buffer, fileName: `${rfq.number}-${supplier.code}.pdf` };
  }

  async storeRfq(ctx: AuthContext, rfqSupplierId: string, rfqId: string, supplierId: string, vesselId: string) {
    const { buffer, fileName } = await this.renderRfq(rfqId, supplierId, ctx.displayName);
    const file = await this.files.storeGenerated(buffer, fileName, 'PDF', 'application/pdf', 'GENERATED', vesselId, ctx.userId, { type: OWNER_RFQ_PDF, id: rfqSupplierId });
    return { file, buffer };
  }

  // ---------------------------------------------------------------------------
  // BC / PO officiel
  // ---------------------------------------------------------------------------

  async renderPo(poId: string, author: string, opts: { draft?: boolean } = {}, db: Db = this.prisma): Promise<{ buffer: Buffer; fileName: string }> {
    const po = await db.purchaseOrder.findUniqueOrThrow({
      where: { id: poId },
      include: {
        vessel: true,
        supplier: { include: { contacts: true } },
        quotation: { select: { reference: true, rfq: { select: { number: true } } } },
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { allocations: { include: { prLine: { select: { lineNo: true, pr: { select: { number: true, requesterId: true } } } } } } },
        },
      },
    });
    const names = await this.core.userNames([po.createdById, po.approvedById, po.secondApprovedById], db);
    const prNumbers = [...new Set(po.lines.flatMap((l) => l.allocations.map((a) => a.prLine.pr.number)))];
    const primary = po.supplier.contacts.find((c) => c.isPrimary) ?? po.supplier.contacts[0];
    const buffer = await this.pdf.render(
      {
        title: opts.draft ? 'Bon de commande — PROJET' : 'Bon de commande / Purchase Order',
        subtitle: `${po.supplier.name}${po.revisionNo ? ` — révision ${po.revisionNo}` : ''}`,
        reference: po.number,
        author,
        meta: [
          ['Navire', po.vessel.name],
          ['Date de commande', day(po.orderDate) ?? ''],
          ['Devise', po.currency],
        ],
      },
      (b) => {
        b.section('Fournisseur', 1).fields(
          [
            ['Raison sociale', po.supplier.legalName ?? po.supplier.name],
            ['Code fournisseur', po.supplier.code],
            ['Adresse', po.supplier.address],
            ['Identifiant fiscal', po.supplier.taxId],
            ['E-mail', po.supplier.email],
            ['Contact', primary ? `${primary.name}${primary.email ? ` <${primary.email}>` : ''}` : null],
          ],
          2,
        );
        b.section('Livraison et conditions', 2).fields(
          [
            ['Navire', `${po.vessel.name}${po.vessel.imoNumber ? ` (IMO ${po.vessel.imoNumber})` : ''}`],
            ['Port de livraison', po.deliveryPort],
            ['Livraison attendue', day(po.expectedDeliveryDate)],
            ['Conditions de livraison', po.deliveryTerms],
            ['Conditions de paiement', po.paymentTerms ?? po.supplier.paymentTerms],
            ['Références', [prNumbers.length ? `PR ${prNumbers.join(', ')}` : null, po.quotation ? `Devis ${po.quotation.reference ?? ''} (RFQ ${po.quotation.rfq.number})` : null].filter(Boolean).join(' — ') || null],
          ],
          2,
        );
        b.section('Lignes', 3).table(
          [
            { header: 'N°', key: 'lineNo', width: 28, align: 'center' },
            { header: 'Désignation', key: 'designation', width: 170 },
            { header: 'Réf.', key: 'reference', width: 70 },
            { header: 'Qté', key: 'qty', width: 45, align: 'right' },
            { header: 'Unité', key: 'unit', width: 38 },
            { header: 'PU', key: 'unitPrice', width: 55, align: 'right' },
            { header: 'Total', key: 'lineTotal', width: 60, align: 'right' },
            { header: 'PR', key: 'pr', width: 70 },
          ],
          po.lines.map((l) => ({
            lineNo: l.lineNo,
            designation: `${l.designation}${l.status === 'CANCELLED' ? ' [ANNULÉE]' : ''}${D(l.quantityCancelled).greaterThan(0) && l.status !== 'CANCELLED' ? ` (dont ${fmtQty(l.quantityCancelled)} annulé)` : ''}`,
            reference: l.reference,
            qty: fmtQty(D(l.quantityOrdered).minus(l.quantityCancelled)),
            unit: l.unit,
            unitPrice: D(l.unitPrice).toFixed(4).replace(/0{1,2}$/, ''),
            lineTotal: fmtMoney(l.lineTotal),
            pr: l.allocations.map((a) => `${a.prLine.pr.number}/${a.prLine.lineNo}`).join(', '),
          })),
        );
        b.fields(
          [
            ['Sous-total', `${fmtMoney(po.subtotal)} ${po.currency}`],
            ['Fret', `${fmtMoney(po.freightAmount)} ${po.currency}`],
            ['Taxes', `${fmtMoney(po.taxAmount)} ${po.currency}`],
            ['TOTAL', `${fmtMoney(po.totalAmount)} ${po.currency}`],
          ],
          4,
        );
        if (po.notes) b.paragraph('Notes', po.notes);
        b.section('Approbations', 4).signatures([
          { label: 'Établi par', name: names.get(po.createdById), date: stamp(po.createdAt) },
          { label: 'Émis / approuvé par', name: po.approvedById ? names.get(po.approvedById) : null, date: stamp(po.approvedAt) },
          ...(po.requiresSecondApproval
            ? [{ label: 'Second regard (seuil)', name: po.secondApprovedById ? names.get(po.secondApprovedById) : null, date: stamp(po.secondApprovedAt) }]
            : []),
        ]);
        b.note(
          'Attribution horodatée selon les habilitations AMC (journal d’audit) — pas de signature cryptographique en V1 (CDC §17). ' +
            'BC = OC = Purchase Order : document unique. Toute modification fait l’objet d’une révision numérotée.',
        );
      },
    );
    return { buffer, fileName: `${po.number}${po.revisionNo ? `-REV${po.revisionNo}` : ''}${opts.draft ? '-PROJET' : ''}.pdf` };
  }

  async storePo(ctx: AuthContext, poId: string, vesselId: string, opts: { draft?: boolean } = {}) {
    const { buffer, fileName } = await this.renderPo(poId, ctx.displayName, opts);
    const file = await this.files.storeGenerated(buffer, fileName, 'PDF', 'application/pdf', 'GENERATED', vesselId, ctx.userId, { type: OWNER_PO_PDF, id: poId });
    return { file, buffer };
  }

  // ---------------------------------------------------------------------------
  // Rapport de réception (BC | BL | reçu physique côte à côte)
  // ---------------------------------------------------------------------------

  async renderReceipt(receiptId: string, author: string): Promise<{ buffer: Buffer; fileName: string }> {
    const r = await this.prisma.goodsReceipt.findUniqueOrThrow({
      where: { id: receiptId },
      include: {
        vessel: true,
        po: { include: { supplier: true } },
        deliveryNote: true,
        lines: { include: { poLine: true, deliveryNoteLine: true }, orderBy: { poLine: { lineNo: 'asc' } } },
        variances: true,
      },
    });
    const balances = await this.core.balancesForPos([r.poId]);
    const names = await this.core.userNames([r.receivedById, r.validatedById]);
    const buffer = await this.pdf.render(
      {
        title: 'Rapport de réception',
        subtitle: `${r.po.number} — ${r.po.supplier.name}`,
        reference: r.number,
        author,
        meta: [
          ['Navire', r.vessel.name],
          ['Réception', stamp(r.receivedAt) ?? ''],
          ['Statut', r.status === 'VALIDATED' ? 'Validé' : 'Confirmé (à valider)'],
        ],
      },
      (b) => {
        b.section('Références', 1).fields(
          [
            ['Bon de commande', r.po.number],
            ['Fournisseur', r.po.supplier.name],
            ['BL (Bon de Livraison)', r.deliveryNote ? `${r.deliveryNote.number} du ${day(r.deliveryNote.deliveryDate)}` : 'Aucun BL associé'],
            ['Responsable réception', r.responsibleName ?? names.get(r.receivedById)],
          ],
          2,
        );
        if (r.notes) b.paragraph('Observations', r.notes);
        b.section('Lignes reçues', 2).table(
          [
            { header: 'N°', key: 'lineNo', width: 28, align: 'center' },
            { header: 'Désignation', key: 'designation', width: 160 },
            { header: 'Qté BL', key: 'note', width: 45, align: 'right' },
            { header: 'Reçu', key: 'received', width: 45, align: 'right' },
            { header: 'Accepté', key: 'accepted', width: 45, align: 'right' },
            { header: 'Rejeté', key: 'rejected', width: 45, align: 'right' },
            { header: 'État', key: 'condition', width: 55 },
            { header: 'Remarques', key: 'remarks', width: 110 },
          ],
          r.lines.map((l) => ({
            lineNo: l.poLine.lineNo,
            designation: `${l.poLine.designation} (${l.poLine.unit})`,
            note: l.deliveryNoteLine ? fmtQty(l.deliveryNoteLine.quantityOnNote) : null,
            received: fmtQty(l.qtyReceived),
            accepted: fmtQty(l.qtyAccepted),
            rejected: fmtQty(l.qtyRejected),
            condition: l.condition === 'GOOD' ? 'Bon' : l.condition === 'DAMAGED' ? 'Endommagé' : 'Mauvaise réf.',
            remarks: l.remarks,
          })),
        );
        b.section('Rapprochement cumulé BC | BL | reçu physique', 3).table(
          [
            { header: 'N°', key: 'lineNo', width: 28, align: 'center' },
            { header: 'Désignation', key: 'designation', width: 150 },
            { header: 'Commandé (BC)', key: 'ordered', width: 55, align: 'right' },
            { header: 'BL', key: 'onNotes', width: 45, align: 'right' },
            { header: 'Reçu physique', key: 'received', width: 55, align: 'right' },
            { header: 'Accepté', key: 'accepted', width: 45, align: 'right' },
            { header: 'Reliquat', key: 'remaining', width: 50, align: 'right' },
          ],
          balances.map((x) => ({
            lineNo: x.lineNo,
            designation: x.designation,
            ordered: fmtQty(D(x.quantityOrdered).minus(x.quantityCancelled)),
            onNotes: fmtQty(x.qtyOnDeliveryNotes),
            received: fmtQty(x.qtyPhysicallyReceived),
            accepted: fmtQty(x.qtyAccepted),
            remaining: fmtQty(x.qtyRemaining),
          })),
        );
        b.note('Un BL n’est pas une preuve de réception physique : seules les quantités reçues et acceptées à bord soldent la commande.');
        if (r.variances.length) {
          b.section('Écarts détectés', 4).table(
            [
              { header: 'Type', key: 'type', width: 90 },
              { header: 'Quantité', key: 'quantity', width: 55, align: 'right' },
              { header: 'Statut', key: 'status', width: 60 },
              { header: 'Description', key: 'description', width: 280 },
            ],
            r.variances.map((v) => ({ type: v.type, quantity: fmtQty(v.quantity), status: v.status, description: v.description })),
          );
        }
        b.signatures([
          { label: 'Réceptionné par', name: r.responsibleName ?? names.get(r.receivedById), date: stamp(r.receivedAt) },
          { label: 'Validé par', name: r.validatedById ? names.get(r.validatedById) : null, date: stamp(r.validatedAt) },
        ]);
      },
    );
    return { buffer, fileName: `${r.number}.pdf` };
  }

  async storeReceipt(ctx: AuthContext, receiptId: string, vesselId: string) {
    const { buffer, fileName } = await this.renderReceipt(receiptId, ctx.displayName);
    return this.files.storeGenerated(buffer, fileName, 'PDF', 'application/pdf', 'GENERATED', vesselId, ctx.userId, { type: OWNER_RECEIPT_PDF, id: receiptId });
  }
}
