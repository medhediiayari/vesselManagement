/**
 * Énumérations métier partagées API/Web (miroir des enums Prisma) avec libellés FR.
 * Les statuts sont toujours affichés avec un libellé, jamais par la seule couleur (CDC §1.3).
 */

export const VALIDITY_STATUSES = ['VALID', 'EXPIRING_SOON', 'EXPIRED', 'UNLIMITED', 'EXPIRY_UNKNOWN'] as const;
export type ValidityStatus = (typeof VALIDITY_STATUSES)[number];

export const VALIDITY_LABELS: Record<ValidityStatus, string> = {
  VALID: 'Valide',
  EXPIRING_SOON: 'Expire bientôt',
  EXPIRED: 'Expiré',
  UNLIMITED: 'Illimité',
  EXPIRY_UNKNOWN: 'Échéance inconnue',
};

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  PENDING_APPROVAL: "En attente d'approbation",
  RETURNED: 'Retourné pour correction',
  REJECTED: 'Refusé',
  APPROVED: 'Approuvé',
  CANCELLED: 'Annulé',
};

export const RENEWAL_STATUS_LABELS: Record<string, string> = {
  NOT_STARTED: 'Non démarré',
  IN_PROGRESS: 'Renouvellement en cours',
  COMPLETED: 'Terminé',
};

export const ATTACHMENT_STATUS_LABELS: Record<string, string> = {
  MISSING: 'Document manquant',
  PENDING_APPROVAL: 'Pièce en attente',
  OFFICIAL: 'Pièce officielle',
  ARCHIVED: 'Archivée',
  REJECTED: 'Refusée',
};

export const MEMBER_STATUS_LABELS: Record<string, string> = {
  ON_BOARD: 'À bord',
  AVAILABLE: 'Disponible',
  ON_LEAVE: 'En congé',
  PLANNED_JOIN: 'Embarquement prévu',
  INACTIVE: 'Inactif',
};

/**
 * Catégories d'équipage (filtre de la liste Members), définies par les codes du référentiel des rangs.
 * Elles reprennent les quatre familles de la matrice d'équipage AMC : officiers pont / machine,
 * personnel pont, personnel machine et cuisine.
 */
export const CREW_CATEGORIES = {
  DECK_OFFICERS: { label: 'Officiers pont', rankCodes: ['MASTER', 'C_OFF', '2_OFF', '3_OFF', 'DECK_CADET'] },
  ENGINE_OFFICERS: { label: 'Officiers machine', rankCodes: ['C_ENG', '2_ENG', '3_ENG', 'ENG_CADET'] },
  DECK_RATINGS: { label: 'Personnel pont', rankCodes: ['BOSUN', 'AB', 'OS', 'DECK_RATING'] },
  ENGINE_CATERING: { label: 'Machine & cuisine', rankCodes: ['OILER', 'WIPER', 'ENGINE_RATING', 'ELEC', 'COOK', 'CH_COOK', 'STEWARD'] },
} as const;
export type CrewCategory = keyof typeof CREW_CATEGORIES;
export const CREW_CATEGORY_KEYS = Object.keys(CREW_CATEGORIES) as CrewCategory[];

export const VESSEL_STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Actif',
  INACTIVE: 'Inactif',
  LAID_UP: 'Désarmé',
  SOLD: 'Vendu',
};

export const PR_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  SUBMITTED: 'Soumise',
  UNDER_REVIEW: 'En discussion',
  REVISED: 'Counter-PR à décider',
  APPROVED: 'Validée',
  SOURCING: 'Consultation fournisseurs',
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

export const PO_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  APPROVAL_PENDING: 'Second regard en attente',
  APPROVED: 'Validé (à émettre)',
  SENT: 'Émis',
  PARTIALLY_RECEIVED: 'Partiellement reçu',
  RECEIVED: 'Reçu',
  CLOSED: 'Clôturé',
  CANCELLED: 'Annulé',
};

export const RFQ_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  ISSUED: 'Émise',
  QUOTED: 'Devis reçus',
  EVALUATED: 'Évaluée',
  CLOSED: 'Clôturée',
  CANCELLED: 'Annulée',
};

export const VOYAGE_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  PLANNED: 'Planifié',
  ACTIVE: 'En cours',
  COMPLETED: 'Terminé',
  CANCELLED: 'Annulé',
};

export const NOON_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  SUBMITTED: 'Soumis',
  ACKNOWLEDGED: 'Accusé de réception',
  CORRECTION_REQUESTED: 'Correction demandée',
  CORRECTED: 'Corrigé',
  ARCHIVED: 'Archivé',
};

export const CSO_VERSION_STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Brouillon',
  PENDING_APPROVAL: "En attente d'approbation",
  RETURNED: 'Retourné',
  REJECTED: 'Refusé',
  PUBLISHED: 'Publié (officiel)',
  SUPERSEDED: 'Archivé (remplacé)',
  CANCELLED: 'Annulé',
};

export const FILE_SCAN_LABELS: Record<string, string> = {
  PENDING: 'Analyse antivirus en cours',
  CLEAN: 'Analysé — sain',
  INFECTED: 'Quarantaine (menace)',
  SKIPPED: 'Non analysé (antivirus désactivé)',
  ERROR: 'Analyse en échec',
};

export const FILE_CONTEXTS = [
  'CERTIFICATE',
  'CSO_DOCUMENT',
  'VESSEL_PHOTO',
  'VESSEL_ATTACHMENT',
  'MEMBER_PHOTO',
  'MEMBER_DOCUMENT',
  'PURCHASING',
  'VOYAGE',
  'CHARTER_PARTY',
  'NOON_REPORT',
  'IMPORT_SOURCE',
] as const;
export type FileContextKey = (typeof FILE_CONTEXTS)[number];

/** Extensions acceptées par contexte (indication UI ; le serveur contrôle le contenu réel). */
export const FILE_ACCEPT: Record<FileContextKey, string> = {
  CERTIFICATE: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff',
  CSO_DOCUMENT: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.docx,.xlsx,.xls',
  VESSEL_PHOTO: '.jpg,.jpeg,.png,.webp',
  VESSEL_ATTACHMENT: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.docx,.xlsx,.xls',
  MEMBER_PHOTO: '.jpg,.jpeg,.png,.webp',
  MEMBER_DOCUMENT: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.docx',
  PURCHASING: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.xlsx,.xls,.docx',
  VOYAGE: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff,.docx,.xlsx,.xls',
  CHARTER_PARTY: '.pdf,.docx,.jpg,.jpeg,.png',
  NOON_REPORT: '.pdf,.jpg,.jpeg,.png,.webp,.tif,.tiff',
  IMPORT_SOURCE: '.xlsx,.xls,.csv,.zip',
};
