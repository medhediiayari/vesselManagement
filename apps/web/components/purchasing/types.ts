/**
 * Contrats de l'API Achats (module purchasing). Les quantités et montants sont des chaînes décimales
 * renvoyées par l'API : jamais converties en float pour un calcul (voir lib.ts `dec`).
 */
import type { StoredFileDto } from '@/lib/api';

export type PrStatus =
  | 'DRAFT'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'REVISED'
  | 'APPROVED'
  | 'SOURCING'
  | 'PARTIALLY_ORDERED'
  | 'ORDERED'
  | 'PARTIALLY_RECEIVED'
  | 'RECEIVED'
  | 'CLOSED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'ON_HOLD'
  | 'SPLIT';
export type PrPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
export type PrLineBadge = 'CANCELLED' | 'NOT_ORDERED' | 'PARTIALLY_ORDERED' | 'ORDERED' | 'PARTIALLY_RECEIVED' | 'RECEIVED';
export type PoStatus = 'DRAFT' | 'APPROVAL_PENDING' | 'APPROVED' | 'SENT' | 'PARTIALLY_RECEIVED' | 'RECEIVED' | 'CLOSED' | 'CANCELLED';
export type RfqStatus = 'DRAFT' | 'ISSUED' | 'QUOTED' | 'EVALUATED' | 'CLOSED' | 'CANCELLED';
export type RfqSupplierStatus = 'PENDING' | 'SENT' | 'SEND_FAILED' | 'DECLINED' | 'QUOTED';
export type QuotationStatus = 'RECEIVED' | 'SELECTED' | 'PARTIALLY_SELECTED' | 'NOT_SELECTED' | 'WITHDRAWN';
export type ComplianceStatus = 'COMPLIANT' | 'ALTERNATIVE' | 'NON_COMPLIANT';
export type RevisionAction = 'KEEP' | 'CHANGE' | 'ADD' | 'REMOVE';
export type RevisionStatus = 'PROPOSED' | 'ACCEPTED' | 'REJECTED' | 'CORRECTION_REQUESTED' | 'WITHDRAWN';
export type VarianceType = 'SHORT_SHIPPED' | 'SHORT_RECEIVED' | 'SURPLUS' | 'DAMAGED' | 'WRONG_REFERENCE' | 'REJECTED';
export type VarianceStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type ItemCondition = 'GOOD' | 'DAMAGED' | 'WRONG_ITEM';
export type DeliveryNoteStatus = 'RECORDED' | 'RECEIVED' | 'CANCELLED';
export type ReceiptStatus = 'DRAFT' | 'CONFIRMED' | 'VALIDATED';
export type InvoiceStatus = 'RECEIVED' | 'UNDER_REVIEW' | 'MATCHED' | 'DISPUTED' | 'APPROVED' | 'CANCELLED';
export type DispatchStatus = 'PENDING' | 'SENT' | 'FAILED';

export interface VesselMini {
  id: string;
  code: string;
  name: string;
}

export interface SupplierMini {
  id: string;
  code?: string;
  name: string;
}

export interface PurchasingAttachment {
  id: string;
  entityType: string;
  entityId: string;
  vesselId: string;
  fileId: string;
  title: string | null;
  uploadedById: string;
  createdAt: string;
  file: StoredFileDto | null;
}

export interface HistoryEvent {
  id: string;
  occurredAt: string;
  actorLabel: string | null;
  action: string;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown> | null;
}

export interface PdfLink {
  fileId: string;
  url: string;
  expiresAt: string;
  fileName: string;
  mimeType: string;
  disposition: 'inline' | 'attachment';
  official?: boolean;
}

// ---------------------------------------------------------------------------- PR

/** Avancement d'une ligne PR (PurchasingCore.prLinesProgress). */
export interface PrLineProgressData {
  prLineId: string;
  lineNo: number;
  requested: string;
  approved: string | null;
  cancelled: string;
  effective: string;
  allocated: string;
  ordered: string;
  onDeliveryNotes: string;
  received: string;
  accepted: string;
  rejected: string;
  toOrder: string;
  orderedNotShipped: string;
  onNoteNotReceived: string;
  orderedNotAccepted: string;
  badge: PrLineBadge;
  orders: { poId: string; poNumber: string; poStatus: PoStatus; quantity: string }[];
}

export interface PrLine {
  id: string;
  prId: string;
  lineNo: number;
  designation: string;
  reference: string | null;
  quantityRequested: string;
  unit: string;
  rob: string | null;
  remarks: string | null;
  catalogItemId: string | null;
  addedByRevisionId: string | null;
  quantityApproved: string | null;
  quantityCancelled: string;
  status: 'OPEN' | 'CANCELLED';
  createdAt: string;
  progress?: PrLineProgressData;
}

export interface ReviewStep {
  key: string;
  label: string;
  permission: string;
  roleKeys?: string[];
  status: 'PENDING' | 'DONE';
  actorId: string | null;
  actorName: string | null;
  at: string | null;
  comment: string | null;
}

export interface ReviewCircuit {
  ruleId: string;
  label: string;
  captainApprovalRequired: boolean;
  evaluatedAt: string;
  facts: { requesterRoles: string[]; category: string; priority: PrPriority; departmentId: string | null };
  steps: ReviewStep[];
}

export interface PrHeader {
  id: string;
  number: string;
  vesselId: string;
  departmentId: string | null;
  requesterId: string;
  requestDate: string;
  category: string;
  priority: PrPriority;
  neededBy: string | null;
  subject: string;
  comment: string | null;
  formRef: string | null;
  status: PrStatus;
  currentRevisionNo: number;
  /** Sous-PR : PR mère (division par fournisseur) */
  parentId: string | null;
  submittedAt: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  lockVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrListLine {
  id: string;
  lineNo: number;
  designation: string;
  unit: string;
  requested: string;
  effective: string;
  ordered: string;
  accepted: string;
  badge: PrLineBadge;
}

export interface PrListItem extends PrHeader {
  vessel: VesselMini;
  requesterName: string | null;
  overdue: boolean;
  lineCount: number;
  childCount: number;
  parent: { id: string; number: string } | null;
  badges: Partial<Record<PrLineBadge, number>>;
  lines: PrListLine[];
}

export interface PrRevisionSummary {
  id: string;
  revisionNo: number;
  kind: 'COUNTER_PR' | 'REVISION';
  status: RevisionStatus;
  proposedById: string;
  proposedAt: string;
  decidedById: string | null;
  decidedAt: string | null;
  proposedByName: string | null;
  decidedByName: string | null;
}

export interface PrLinks {
  rfqs?: { id: string; number: string; title: string; status: RfqStatus; deadline: string | null; issuedAt: string | null }[];
  quotations?: { id: string; rfqId: string; reference: string | null; currency: string; totalAmount: string; status: QuotationStatus; supplier: SupplierMini }[];
  orders?: { id: string; number: string; status: PoStatus; currency: string; totalAmount: string; expectedDeliveryDate: string | null; supplier: SupplierMini }[];
  deliveryNotes?: { id: string; number: string; poId: string; deliveryDate: string; status: DeliveryNoteStatus }[];
  receipts?: { id: string; number: string; poId: string; receivedAt: string; status: ReceiptStatus }[];
  invoices?: { id: string; number: string; status: InvoiceStatus; currency: string; amount: string; supplier: SupplierMini }[];
}

export interface PrDetail extends PrHeader {
  reviewCircuit: ReviewCircuit | null;
  vessel: VesselMini;
  lines: PrLine[];
  revisions: PrRevisionSummary[];
  department: { id: string; code: string; name: string } | null;
  requesterName: string | null;
  approvedByName: string | null;
  attachments: PurchasingAttachment[];
  /** Sous-PR : pièces jointes de la PR mère (consultation) */
  parentAttachments: PurchasingAttachment[];
  parent: { id: string; number: string; status: PrStatus; subject: string } | null;
  children: { id: string; number: string; status: PrStatus; subject: string; approvedAt: string | null; lineCount: number }[];
  links: PrLinks;
}

export interface PrComment {
  id: string;
  prId: string;
  revisionId: string | null;
  authorId: string;
  body: string;
  createdAt: string;
  authorName: string | null;
}

export interface PrRevisionLine {
  id: string;
  revisionId: string;
  prLineId: string | null;
  action: RevisionAction;
  designation: string;
  reference: string | null;
  quantity: string;
  unit: string;
  remarks: string | null;
}

export interface PrRevisionDiffLine {
  action: RevisionAction;
  prLineId: string | null;
  lineNo: number | null;
  original: { designation: string; reference: string | null; quantityRequested: string; unit: string } | null;
  proposed: { designation: string; reference: string | null; quantity: string; unit: string; remarks: string | null };
  quantityDelta: string;
  current: { quantityApproved: string | null; quantityCancelled: string; status: string } | null;
}

export interface PrRevision extends PrRevisionSummary {
  prId: string;
  justification: string | null;
  decisionComment: string | null;
  /** Counter-PR directe : modifications d'en-tête { champ: { before, after } } */
  headerChanges: Partial<Record<'neededBy' | 'priority' | 'subject' | 'category', { before: string | null; after: string | null }>> | null;
  lines: PrRevisionLine[];
  comments?: PrComment[];
  diff?: PrRevisionDiffLine[];
}

// ---------------------------------------------------------------------------- Fournisseurs

export interface SupplierContact {
  id: string;
  supplierId: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string | null;
  isPrimary: boolean;
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  legalName: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  country: string | null;
  currency: string | null;
  paymentTerms: string | null;
  taxId: string | null;
  isActive: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  contacts: SupplierContact[];
}

// ---------------------------------------------------------------------------- RFQ & devis

export interface RfqListItem {
  id: string;
  number: string;
  vesselId: string;
  title: string;
  status: RfqStatus;
  deadline: string | null;
  deliveryPort: string | null;
  deliveryTerms: string | null;
  notes: string | null;
  issuedAt: string | null;
  createdAt: string;
  vessel: VesselMini;
  _count: { lines: number; quotations: number };
  suppliers: { supplierId: string; status: RfqSupplierStatus; supplier: { name: string } }[];
  createdByName: string | null;
  /** PR d'origine des lignes */
  prs: { id: string; number: string }[];
  /** Devis actifs (hors retirés) */
  quotationsReceived: number;
  /** Au moins un BC non annulé issu d'un devis de la RFQ */
  hasPurchaseOrder: boolean;
}

/** GET /rfqs/stats : périmètre navire de l'utilisateur. */
export interface RfqStats {
  total: number;
  byStatus: Partial<Record<RfqStatus, number>>;
  toFollowUp: number;
  withPurchaseOrder: number;
}

export interface RfqLine {
  id: string;
  rfqId: string;
  prLineId: string;
  lineNo: number;
  designation: string;
  reference: string | null;
  quantity: string;
  unit: string;
  remarks: string | null;
  prLine: { id: string; lineNo: number; prId: string; pr: { number: string; status: PrStatus } };
}

export interface RfqSupplier {
  id: string;
  rfqId: string;
  supplierId: string;
  status: RfqSupplierStatus;
  sentTo: string | null;
  sentAt: string | null;
  sendError: string | null;
  supplier: { id: string; code: string; name: string; email: string | null; currency: string | null; isActive: boolean };
  sentDocuments: StoredFileDto[];
}

export interface RfqQuotationSummary {
  id: string;
  supplierId: string;
  reference: string | null;
  currency: string;
  subtotal: string;
  totalAmount: string;
  status: QuotationStatus;
  receivedAt: string;
  validUntil: string | null;
}

export interface RfqDetail extends Omit<RfqListItem, '_count' | 'suppliers' | 'prs' | 'quotationsReceived' | 'hasPurchaseOrder' | 'vessel'> {
  createdById: string;
  updatedAt: string;
  vessel: VesselMini & { imoNumber?: string | null; vesselType?: string | null; photoFileId?: string | null };
  lines: RfqLine[];
  suppliers: RfqSupplier[];
  createdByName: string | null;
  /** Absent sans la permission quotation.view */
  quotations?: RfqQuotationSummary[];
  attachments: PurchasingAttachment[];
}

export interface QuotationLine {
  id: string;
  quotationId: string;
  rfqLineId: string;
  isAvailable: boolean;
  quantityOffered: string | null;
  unit: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  leadTimeDays: number | null;
  compliance: ComplianceStatus;
  remarks: string | null;
}

export interface Quotation {
  id: string;
  rfqId: string;
  supplierId: string;
  reference: string | null;
  receivedAt: string;
  currency: string;
  validUntil: string | null;
  leadTimeDays: number | null;
  incoterm: string | null;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  freightAmount: string | null;
  taxAmount: string | null;
  discountAmount: string | null;
  subtotal: string;
  totalAmount: string;
  comments: string | null;
  fileId: string | null;
  status: QuotationStatus;
  evaluationNote: string | null;
  createdAt: string;
  supplier: SupplierMini;
  lines: QuotationLine[];
}

export interface ComparisonOffer {
  quotationId: string;
  quotationLineId: string;
  supplierId: string;
  supplierName: string;
  currency: string;
  isAvailable: boolean;
  quantityOffered: string | null;
  unit: string | null;
  unitPrice: string | null;
  lineTotal: string | null;
  leadTimeDays: number | null;
  compliance: ComplianceStatus;
  remarks: string | null;
  cheapestInCurrency: boolean;
  selectedQuantity: string;
}

export interface ComparisonQuotation {
  quotationId: string;
  supplier: SupplierMini;
  reference: string | null;
  currency: string;
  status: QuotationStatus;
  subtotal: string;
  freightAmount: string | null;
  taxAmount: string | null;
  discountAmount: string | null;
  totalAmount: string;
  coverage: { totalLines: number; quotedLines: number; fullyCoveredLines: number; percent: string; fullPercent: string };
  leadTimeDays: number | null;
  maxLineLeadTimeDays: number | null;
  validUntil: string | null;
  expired: boolean;
  incoterm: string | null;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  hasOriginalFile: boolean;
  compliance: { compliant: number; alternative: number; nonCompliant: number };
  cheapestLineCount: number;
}

export interface Comparison {
  rfq: { id: string; number: string; title: string; status: RfqStatus };
  currencies: string[];
  fxNote: string | null;
  quotations: ComparisonQuotation[];
  totalsByCurrency: Record<string, { quotationId: string; supplierName: string; totalAmount: string; coveragePercent: string; lowestTotal: boolean }[]>;
  lines: {
    rfqLineId: string;
    lineNo: number;
    designation: string;
    reference: string | null;
    quantity: string;
    unit: string;
    selectedQuantity: string;
    offers: ComparisonOffer[];
  }[];
}

export interface Selection {
  id: string;
  quotationLineId: string;
  quantity: string;
  justification: string;
  selectedById: string;
  selectedAt: string;
  withdrawnAt: string | null;
  selectedByName: string | null;
  quotationLine: {
    id: string;
    rfqLineId: string;
    unitPrice: string | null;
    quotation: { id: string; currency: string; supplier: SupplierMini };
  };
}

// ---------------------------------------------------------------------------- BC / PO

export interface PoListItem {
  id: string;
  number: string;
  vesselId: string;
  supplierId: string;
  quotationId: string | null;
  currency: string;
  status: PoStatus;
  orderDate: string;
  expectedDeliveryDate: string | null;
  subtotal: string;
  taxAmount: string;
  freightAmount: string;
  totalAmount: string;
  revisionNo: number;
  requiresSecondApproval: boolean;
  sentAt: string | null;
  createdById: string;
  createdAt: string;
  vessel: VesselMini;
  supplier: SupplierMini;
  _count: { lines: number; variances: number };
  /** PR d'origine (allocations) — regroupement de la liste par Purchase Request */
  prs?: { id: string; number: string; subject: string; status: PrStatus; parentNumber: string | null }[];
}

export interface PoAllocation {
  id: string;
  poLineId: string;
  prLineId: string;
  quantity: string;
  overAllocationReason: string | null;
  createdAt: string;
  prLine: { id: string; lineNo: number; designation: string; unit: string; pr: { id: string; number: string; requesterId: string } };
}

export interface PoLineBalance {
  ordered: string;
  cancelled: string;
  onDeliveryNotes: string;
  physicallyReceived: string;
  accepted: string;
  rejected: string;
  remaining: string;
}

export interface PoLine {
  id: string;
  poId: string;
  lineNo: number;
  designation: string;
  reference: string | null;
  quantityOrdered: string;
  unit: string;
  unitPrice: string;
  lineTotal: string;
  quotationLineId: string | null;
  quantityCancelled: string;
  status: 'OPEN' | 'CANCELLED';
  remarks: string | null;
  allocations: PoAllocation[];
  balance: PoLineBalance | null;
}

export interface PoDispatch {
  id: string;
  poId: string;
  recipient: string;
  recipientKind: 'SUPPLIER' | 'CAPTAIN' | 'REQUESTER' | string;
  channel: 'EMAIL' | 'APP' | 'MANUAL' | string;
  status: DispatchStatus;
  fileId: string | null;
  error: string | null;
  sentAt: string | null;
  createdAt: string;
}

export interface Variance {
  id: string;
  poId: string;
  poLineId: string;
  receiptId: string | null;
  type: VarianceType;
  quantity: string;
  description: string;
  status: VarianceStatus;
  assignedToId: string | null;
  resolution: string | null;
  resolvedAt: string | null;
  createdById: string;
  createdAt: string;
}

export interface DeliveryNoteLine {
  id: string;
  deliveryNoteId: string;
  poLineId: string;
  quantityOnNote: string;
  unit: string;
}

/** Article reçu à bord hors BC (information, sans alerte ni blocage). */
export interface DeliveryExtraItem {
  id: string;
  deliveryNoteId: string;
  designation: string;
  reference: string | null;
  quantity: string;
  unit: string;
  remarks: string | null;
  createdAt: string;
}

/** Écart BC ↔ reçu cumulé renvoyé après un BL saisi à bord. */
export interface DeliveryDiscrepancy {
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

export interface OnboardDeliveryResult {
  deliveryNote: DeliveryNoteDetail;
  receiptId: string | null;
  order: { id: string; number: string; status: PoStatus; lockVersion: number };
  discrepancies: DeliveryDiscrepancy[];
  replay: boolean;
}

export interface IssueOrderResult {
  order: { id: string; number: string; status: PoStatus; lockVersion: number; sentAt: string | null };
  issued: boolean;
  message: string;
}

export interface DeliveryNote {
  id: string;
  number: string;
  supplierId: string;
  vesselId: string;
  poId: string;
  deliveryDate: string;
  fileId: string | null;
  status: DeliveryNoteStatus;
  notes: string | null;
  createdById: string;
  createdAt: string;
}

export interface PoDetail extends Omit<PoListItem, 'supplier' | '_count'> {
  deliveryPort: string | null;
  deliveryTerms: string | null;
  paymentTerms: string | null;
  notes: string | null;
  approvedById: string | null;
  approvedAt: string | null;
  secondApprovedById: string | null;
  secondApprovedAt: string | null;
  sentAt: string | null;
  sentById: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  pdfFileId: string | null;
  lockVersion: number;
  createdById: string;
  updatedAt: string;
  supplier: Supplier;
  quotation: { id: string; reference: string | null; rfqId: string; currency: string } | null;
  lines: PoLine[];
  revisions: { id: string; revisionNo: number; reason: string; pdfFileId: string | null; createdById: string; createdAt: string; createdByName: string | null }[];
  dispatches: PoDispatch[];
  createdByName: string | null;
  approvedByName: string | null;
  secondApprovedByName: string | null;
  sentByName: string | null;
  attachments: PurchasingAttachment[];
  deliveryNotes?: (DeliveryNote & { lines: DeliveryNoteLine[]; extraItems: DeliveryExtraItem[] })[];
  receipts?: { id: string; number: string; receivedAt: string; status: ReceiptStatus; deliveryNoteId: string | null; lines?: { poLineId: string; remarks: string | null }[] }[];
  variances?: Variance[];
  invoices?: { id: string; number: string; status: InvoiceStatus; currency: string; amount: string; taxAmount: string }[];
}

export interface PoRevisionFull {
  id: string;
  poId: string;
  revisionNo: number;
  reason: string;
  pdfFileId: string | null;
  createdById: string;
  createdAt: string;
  createdByName: string | null;
  snapshot: {
    status: PoStatus;
    currency: string;
    subtotal: string;
    taxAmount: string;
    freightAmount: string;
    totalAmount: string;
    revisionNo: number;
    expectedDeliveryDate: string | null;
    pdfFileId?: string | null;
    lines: { id: string; lineNo: number; designation: string; unit: string; quantityOrdered: string; quantityCancelled: string; unitPrice: string; lineTotal: string; status: string }[];
  };
}

export interface ReconciliationLine {
  poLineId: string;
  lineNo: number;
  designation: string;
  unit: string;
  status: 'OPEN' | 'CANCELLED';
  ordered: string;
  cancelled: string;
  effectiveOrdered: string;
  onDeliveryNotes: string;
  physicallyReceived: string;
  accepted: string;
  rejected: string;
  remaining: string;
  deltaNoteVsReceived: string;
  deltaOrderedVsNote: string;
  shortShipped: string;
  shortReceived: string;
  surplus: string;
  prAllocations: { prId: string; prNumber: string; prLineNo: number; quantity: string }[];
  openVariances: { id: string; type: VarianceType; quantity: string; status: VarianceStatus }[];
}

export interface Reconciliation {
  po: { id: string; number: string; status: PoStatus; currency: string; vesselId: string };
  lines: ReconciliationLine[];
  totals: { ordered: string; onDeliveryNotes: string; physicallyReceived: string; accepted: string; rejected: string; remaining: string };
  note: string;
}

/** Détail d'une ligne en dépassement (erreur BUSINESS_RULE / VALIDATION_FAILED, details.lines). */
export interface OverAllocationLine {
  prLineId: string;
  prNumber: string;
  lineNo: number;
  effective: string;
  alreadyAllocated: string;
  requested: string;
  capacity: string;
  excess: string;
}

// ---------------------------------------------------------------------------- BL / réceptions / écarts

export interface DeliveryNoteListItem extends DeliveryNote {
  supplier: SupplierMini;
  po: { id: string; number: string; status: PoStatus };
  _count: { lines: number; receipts: number };
}

export interface DeliveryNoteDetail extends DeliveryNote {
  supplier: SupplierMini;
  po: { id: string; number: string; status: PoStatus };
  lines: (DeliveryNoteLine & { poLine: { id: string; lineNo: number; designation: string; unit: string; quantityOrdered: string; quantityCancelled: string } })[];
  receipts: { id: string; number: string; receivedAt: string; status: ReceiptStatus }[];
  extraItems: DeliveryExtraItem[];
  createdByName: string | null;
  attachments: PurchasingAttachment[];
}

export interface ReceiptListItem {
  id: string;
  number: string;
  vesselId: string;
  poId: string;
  deliveryNoteId: string | null;
  receivedAt: string;
  receivedById: string;
  responsibleName: string | null;
  status: ReceiptStatus;
  validatedById: string | null;
  validatedAt: string | null;
  notes: string | null;
  createdAt: string;
  po: { id: string; number: string; status: PoStatus; supplier: SupplierMini };
  deliveryNote: { id: string; number: string } | null;
  _count: { lines: number; variances: number };
}

export interface ReceiptLine {
  id: string;
  receiptId: string;
  poLineId: string;
  deliveryNoteLineId: string | null;
  qtyReceived: string;
  qtyAccepted: string;
  qtyRejected: string;
  condition: ItemCondition;
  remarks: string | null;
  poLine: { id: string; lineNo: number; designation: string; unit: string };
  deliveryNoteLine: { id: string; quantityOnNote: string } | null;
}

export interface ReceiptDetail {
  id: string;
  number: string;
  vesselId: string;
  poId: string;
  deliveryNoteId: string | null;
  receivedAt: string;
  receivedById: string;
  responsibleName: string | null;
  status: ReceiptStatus;
  validatedById: string | null;
  validatedAt: string | null;
  notes: string | null;
  createdAt: string;
  po: { id: string; number: string; status: PoStatus; currency: string; supplier: SupplierMini };
  deliveryNote: { id: string; number: string; deliveryDate: string; status: DeliveryNoteStatus } | null;
  lines: ReceiptLine[];
  variances: Variance[];
  receivedByName: string | null;
  validatedByName: string | null;
  attachments: PurchasingAttachment[];
  replay?: boolean;
}

export interface VarianceListItem extends Variance {
  po: { id: string; number: string; vesselId: string; status: PoStatus; supplier: SupplierMini };
  poLine: { id: string; lineNo: number; designation: string; unit: string };
  receipt: { id: string; number: string } | null;
}

export interface VarianceDetail extends Variance {
  po: { id: string; number: string; vesselId: string; status: PoStatus; supplier: SupplierMini };
  poLine: Omit<PoLine, 'balance' | 'allocations'> & {
    allocations: { id: string; prLineId: string; quantity: string; prLine: { lineNo: number; pr: { id: string; number: string } } }[];
  };
  receipt: { id: string; number: string; receivedAt: string } | null;
  createdByName: string | null;
  assignedToName: string | null;
  lineBalance: { ordered: string; onDeliveryNotes: string; physicallyReceived: string; accepted: string; remaining: string } | null;
  attachments: PurchasingAttachment[];
}

// ---------------------------------------------------------------------------- Factures

export interface InvoiceListItem {
  id: string;
  supplierId: string;
  vesselId: string | null;
  number: string;
  invoiceDate: string;
  dueDate: string | null;
  currency: string;
  amount: string;
  taxAmount: string;
  fileId: string | null;
  status: InvoiceStatus;
  reviewNotes: string | null;
  createdById: string;
  createdAt: string;
  updatedAt: string;
  supplier: SupplierMini;
  orders: { invoiceId: string; poId: string; amount: string | null; po: { id: string; number: string; status: PoStatus } }[];
}

export interface InvoiceMatching {
  suggestion: 'MATCHED' | 'DISPUTED';
  reasons: ('CURRENCY_MISMATCH' | 'EXCEEDS_ORDERED' | 'EXCEEDS_RECEIVED' | 'NO_ORDER')[];
  byCurrency: Record<string, { ordered: string; received: string; invoiced: string }>;
  invoiceGross: string;
  orders: { poId: string; number: string; poStatus: PoStatus; currency: string; orderedTotal: string; receivedValue: string; invoicedCumulative: string; thisInvoice: string }[];
  note: string;
}

export interface InvoiceDetail extends Omit<InvoiceListItem, 'orders'> {
  orders: { invoiceId: string; poId: string; amount: string | null; po: { id: string; number: string; status: PoStatus; currency: string; totalAmount: string } }[];
  createdByName: string | null;
  matching: InvoiceMatching;
  attachments: PurchasingAttachment[];
}

// ---------------------------------------------------------------------------- Board & paramétrage

export interface PurchasingBoard {
  purchaseRequests?: { inbox: number; underReview: number; counterPrPending: number; onHold: number; toOrder: number; overdueNotOrdered: number };
  rfqs?: { drafts: number; sendFailed: number; toFollowUp: number };
  quotations?: { toCompare: number };
  orders?: {
    drafts: number;
    approvalPending: number;
    approvedNotSent: number;
    lateDelivery: number;
    partiallyReceived: number;
    /** BC émis en attente de BL (bord) */
    toReceive: number;
    /** BC avec écart de réception à décider (Achats) */
    discrepanciesToDecide: number;
    awaitingRemainder: number;
  };
  variances?: { open: number; receiptsToValidate: number };
  invoices?: { toReview: number; disputed: number };
}

export interface ReviewRuleDef {
  id: string;
  label: string;
  match: {
    requesterRoles?: string[];
    categories?: string[];
    priorities?: PrPriority[];
    departmentIds?: string[];
    vesselIds?: string[];
  };
  steps: { key: string; label: string; permission: string; roleKeys?: string[] }[];
}

export interface ApprovalThreshold {
  id?: string;
  currency: string;
  amount: string;
  requiresSecondApproval: boolean;
  isActive: boolean;
  updatedAt?: string;
}

export interface PurchasingConfig {
  reviewCircuits: { rules: ReviewRuleDef[]; source: 'DEFAULT' | 'SETTINGS' };
  poApprovalMode: 'THRESHOLD_ONLY' | 'ALWAYS';
  /** Référence du formulaire PR recopiée dans chaque nouvelle PR (purchasing.prFormRef) */
  prFormRef: string;
  poThresholds: ApprovalThreshold[];
  allowOverAllocation: boolean;
  notes: string[];
}

/** GET /purchase-requests/form-defaults — référence du formulaire et prochaine escale du navire. */
export interface PrFormDefaults {
  formRef: string;
  today: string;
  nextPortCall: { portName: string; eta: string; voyageReference: string } | null;
}
