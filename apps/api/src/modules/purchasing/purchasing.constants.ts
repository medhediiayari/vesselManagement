import { PurchasingEntityType } from '@prisma/client';

/** Propriétaire logique des pièces jointes Achats (devis PDF, scans BL, preuves, factures…). */
export const OWNER_PURCHASING_ATTACHMENT = 'purchasing_attachment';
/** PDF officiel / révisions d'un BC (owner id = purchase_orders.id). */
export const OWNER_PO_PDF = 'purchase_order_pdf';
/** PDF d'une PR généré à la demande (owner id = purchase_requests.id). */
export const OWNER_PR_PDF = 'purchase_request_pdf';
/** PDF RFQ envoyé à un fournisseur — « pièce envoyée » conservée (owner id = rfq_suppliers.id, CDC §6.5). */
export const OWNER_RFQ_PDF = 'rfq_supplier_pdf';
/** Rapport de réception PDF (owner id = goods_receipts.id). */
export const OWNER_RECEIPT_PDF = 'goods_receipt_pdf';
/** Exports Excel (contexte EXPORT : accès réservé au demandeur, géré par FilesService). */
export const OWNER_EXPORT_JOB = 'export_job';

/** Type d'entité dans l'audit pour chaque type polymorphe de pièce jointe. */
export const ENTITY_AUDIT_TYPE: Record<PurchasingEntityType, string> = {
  PR: 'purchase_request',
  RFQ: 'rfq',
  QUOTATION: 'quotation',
  PURCHASE_ORDER: 'purchase_order',
  DELIVERY_NOTE: 'delivery_note',
  GOODS_RECEIPT: 'goods_receipt',
  VARIANCE: 'variance',
  INVOICE: 'invoice',
};

/** Permission de consultation (l'une suffit) exigée pour lire une pièce jointe, en plus du scope navire. */
export const ATTACHMENT_VIEW_PERMISSIONS: Record<PurchasingEntityType, string[]> = {
  PR: ['pr.view'],
  RFQ: ['rfq.view'],
  QUOTATION: ['quotation.view'],
  PURCHASE_ORDER: ['bc.view'],
  DELIVERY_NOTE: ['receiving.view'],
  GOODS_RECEIPT: ['receiving.view'],
  VARIANCE: ['receiving.view', 'variances.manage'],
  INVOICE: ['invoice.view'],
};

/** Permission (l'une suffit) pour ajouter une pièce jointe à une entité. */
export const ATTACHMENT_MANAGE_PERMISSIONS: Record<PurchasingEntityType, string[]> = {
  PR: ['pr.create', 'pr.edit', 'pr.revise', 'pr.approve'],
  RFQ: ['rfq.manage'],
  QUOTATION: ['quotation.record'],
  PURCHASE_ORDER: ['bc.create', 'bc.send'],
  DELIVERY_NOTE: ['receiving.record'],
  GOODS_RECEIPT: ['receiving.record', 'receiving.validate'],
  VARIANCE: ['variances.manage', 'receiving.record'],
  INVOICE: ['invoice.manage'],
};

/** Liens profonds (web) — l'accès est revérifié à l'ouverture. */
export const LINKS = {
  pr: (id: string) => `/purchasing/requests/${id}`,
  rfq: (id: string) => `/purchasing/rfqs/${id}`,
  po: (id: string) => `/purchasing/orders/${id}`,
  receipt: (id: string) => `/purchasing/deliveries/receipts/${id}`,
  deliveryNote: (id: string) => `/purchasing/deliveries/notes/${id}`,
  variance: (id: string) => `/purchasing/deliveries/variances/${id}`,
  invoice: (id: string) => `/purchasing/invoices/${id}`,
};

/** Clés de paramètres propres aux Achats (table system_settings), gérées par PurchasingConfigService. */
export const SETTING_REVIEW_CIRCUITS = 'purchasing.reviewCircuits';
export const SETTING_PO_APPROVAL_MODE = 'purchasing.poApprovalMode';
/** Référence du modèle de formulaire PR (système qualité ISM), recopiée dans chaque PR à sa création. */
export const SETTING_PR_FORM_REF = 'purchasing.prFormRef';
export const DEFAULT_PR_FORM_REF = 'FORM 41 - Rev N°00';

/** Portée des seuils financiers BC dans approval_thresholds. */
export const PO_THRESHOLD_SCOPE = 'PO';

export const MAX_EXPORT_ROWS = 5000;
