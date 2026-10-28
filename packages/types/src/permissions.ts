/**
 * Registre des permissions AMC (CDC §2.4, ADM-004).
 * Chaque clé = module.action. Le serveur est la seule autorité : ces clés sont
 * vérifiées à chaque requête (CDC §2.1, formule normative).
 */

export interface PermissionDef {
  key: string;
  module: PermissionModule;
  label: string;
  /** Permission sensible : journalisée et non déléguable sans la posséder (ADM-006). */
  sensitive?: boolean;
}

export const PERMISSION_MODULES = [
  'admin',
  'fleet',
  'members',
  'certificates',
  'cso',
  'purchasing',
  'voyages',
  'noon',
  'platform',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

const p = (key: string, module: PermissionModule, label: string, sensitive = false): PermissionDef => ({
  key,
  module,
  label,
  sensitive,
});

export const PERMISSIONS: PermissionDef[] = [
  // ---------------- Administration
  p('users.view', 'admin', 'Voir les comptes utilisateurs'),
  p('users.create', 'admin', 'Créer des comptes', true),
  p('users.edit', 'admin', 'Modifier les comptes, rôles, scopes et départements', true),
  p('users.deactivate', 'admin', 'Désactiver / réactiver un compte', true),
  p('users.unlock', 'admin', 'Déverrouiller un compte (avec reset temporaire)', true),
  p('users.reset_password', 'admin', 'Réinitialiser un mot de passe vers un mot de passe temporaire', true),
  p('roles.view', 'admin', 'Voir les rôles'),
  p('roles.manage', 'admin', 'Créer / modifier / supprimer des rôles', true),
  p('permissions.manage', 'admin', 'Gérer les overrides de permissions individuels', true),
  p('departments.view', 'admin', 'Voir les départements'),
  p('departments.manage', 'admin', 'Gérer les départements, responsables et affectations', true),
  p('sessions.view', 'admin', 'Voir les sessions des autres utilisateurs'),
  p('sessions.revoke', 'admin', 'Révoquer les sessions des autres utilisateurs', true),
  p('settings.manage', 'admin', 'Paramètres système (timeout, champs self-edit, limites)', true),
  p('audit.view.admin', 'admin', "Lire l'audit du module Administration"),
  p('audit.view.fleet', 'fleet', "Lire l'audit Flotte"),
  p('audit.view.members', 'members', "Lire l'audit Members"),
  p('audit.view.certificates', 'certificates', "Lire l'audit Certificats"),
  p('audit.view.purchasing', 'purchasing', "Lire l'audit Achats"),
  p('audit.view.voyages', 'voyages', "Lire l'audit Voyages / Noon"),
  p('audit.view.platform', 'platform', "Lire l'audit Fichiers / Exports / Notifications"),

  // ---------------- Flotte
  p('vessels.view', 'fleet', 'Voir les navires accessibles'),
  p('vessels.create', 'fleet', 'Créer un navire', true),
  p('vessels.edit', 'fleet', 'Modifier les informations officielles du navire'),
  p('vessel_crew.assign', 'fleet', "Gérer les affectations d'équipage"),
  p('vessel_documents.manage', 'fleet', 'Gérer photos et pièces jointes navire'),

  // ---------------- Members
  p('members.view', 'members', 'Voir les fiches Members (selon ADM-070)'),
  p('members.create', 'members', 'Créer une fiche Member'),
  p('members.edit', 'members', 'Modifier une fiche Member'),
  p('members.import', 'members', 'Importer des Members depuis Excel'),
  p('members.personal_fields.manage', 'members', 'Modifier les données personnelles protégées', true),
  p('members.fields.manage', 'members', 'Configurer sections et champs personnalisés Members', true),
  p('members.certificates.view', 'members', 'Voir les certificats des Members'),
  p('members.cross_vessel.view', 'members', 'Accès transversal Crew/HR à toutes les fiches (ADM-070)', true),
  p('members.link_user', 'members', 'Lier / délier un compte utilisateur à une fiche Member', true),

  // ---------------- Certificats
  p('certificates.view', 'certificates', 'Voir les certificats'),
  p('certificates.create', 'certificates', 'Créer une demande de certificat'),
  p('certificates.edit', 'certificates', 'Modifier une demande en attente'),
  p('certificates.submit', 'certificates', 'Soumettre à approbation'),
  p('certificates.approve', 'certificates', 'Approuver / refuser / retourner (Approve Certificate)', true),
  p('certificates.archive', 'certificates', 'Archiver un certificat'),
  p('certificates.download_current', 'certificates', 'Télécharger le document courant'),
  p('certificates.download_archived', 'certificates', 'Télécharger les documents archivés', true),
  p('certificates.attachments.approve', 'certificates', 'Approuver une pièce jointe ajoutée après validation', true),
  p('certificates.renewal.manage', 'certificates', 'Piloter le suivi de renouvellement'),
  p('certificates.self_approve', 'certificates', 'Publication directe sans approbation (ses propres demandes)', true),
  p('certificates.types.manage', 'certificates', 'Configurer types, validateurs et politiques de rappel', true),

  // ---------------- CSO (Company Security Officer)
  p('cso.view', 'cso', 'Voir la bibliothèque CSO'),
  p('cso.preview', 'cso', 'Prévisualiser les documents CSO'),
  p('cso.download', 'cso', 'Télécharger les documents CSO', true),
  p('cso.create', 'cso', 'Créer / déposer des documents'),
  p('cso.edit', 'cso', 'Modifier documents et métadonnées'),
  p('cso.approve', 'cso', 'Approuver les documents CSO', true),
  p('cso.self_approve', 'cso', 'Publication directe sans approbation (ses propres versions)', true),
  p('cso.restore', 'cso', 'Restaurer des documents / dossiers archivés'),
  p('cso.share', 'cso', 'Partager en interne'),
  p('cso.revoke', 'cso', 'Révoquer des partages'),
  p('cso.archive.view', 'cso', 'Voir les versions archivées', true),
  p('cso.archive.download', 'cso', 'Télécharger les versions archivées', true),
  p('cso.folder.create', 'cso', 'Créer des dossiers'),
  p('cso.folder.rename', 'cso', 'Renommer des dossiers'),
  p('cso.folder.move', 'cso', 'Déplacer des dossiers / documents'),
  p('cso.folder.archive', 'cso', 'Archiver des dossiers'),
  p('cso.folder.acl_manage', 'cso', 'Gérer les ACL de dossiers / documents', true),
  p('cso.fields.view', 'cso', 'Voir les champs CSO confidentiels'),
  p('cso.fields.edit', 'cso', 'Modifier les champs CSO'),
  p('cso.categories.manage', 'cso', 'Gérer catégories, références et champs', true),
  p('cso.import', 'cso', 'Importer en masse (fichiers / ZIP / Excel)'),
  p('cso.audit.view', 'cso', "Lire l'audit CSO"),

  // ---------------- Achats
  p('suppliers.view', 'purchasing', 'Voir les fournisseurs'),
  p('suppliers.manage', 'purchasing', 'Gérer les fournisseurs'),
  p('pr.view', 'purchasing', 'Voir les Purchase Requests'),
  p('pr.view_all', 'purchasing', 'Voir toutes les PR du navire (sinon : uniquement ses propres PR et leurs BC / BL)'),
  p('pr.create', 'purchasing', 'Créer une PR'),
  p('pr.edit', 'purchasing', 'Modifier une PR brouillon'),
  p('pr.submit', 'purchasing', 'Soumettre une PR'),
  p('pr.revise', 'purchasing', 'Proposer une Counter-PR / révision'),
  p('pr.approve', 'purchasing', 'Approuver / rejeter une PR', true),
  p('pr.cancel', 'purchasing', 'Annuler une PR'),
  p('rfq.view', 'purchasing', 'Voir les RFQ'),
  p('rfq.manage', 'purchasing', 'Créer / émettre des RFQ'),
  p('quotation.view', 'purchasing', 'Voir les devis'),
  p('quotation.record', 'purchasing', 'Saisir les devis fournisseurs'),
  p('quotation.evaluate', 'purchasing', 'Comparer et sélectionner les devis', true),
  p('bc.view', 'purchasing', 'Voir les Bons de Commande (BC/PO)'),
  p('bc.create', 'purchasing', 'Créer un BC'),
  p('bc.approve', 'purchasing', 'Approuver un BC', true),
  p('bc.send', 'purchasing', 'Envoyer un BC'),
  p('bc.cancel', 'purchasing', 'Annuler / réviser un BC', true),
  p('receiving.view', 'purchasing', 'Voir BL et réceptions'),
  p('receiving.record', 'purchasing', 'Enregistrer BL et réception à bord'),
  p('receiving.validate', 'purchasing', 'Valider un rapport de réception'),
  p('variances.manage', 'purchasing', "Traiter les écarts / reliquats"),
  p('invoice.view', 'purchasing', 'Voir les factures'),
  p('invoice.manage', 'purchasing', 'Enregistrer / rapprocher les factures'),
  p('reports.export', 'purchasing', 'Exporter rapports (CSV/XLSX/PDF)'),

  // ---------------- Voyages
  p('voyages.view', 'voyages', 'Voir les voyages'),
  p('voyages.create', 'voyages', 'Créer un voyage'),
  p('voyages.edit', 'voyages', 'Modifier un voyage, escales, cargaisons, tâches'),
  p('voyages.activate', 'voyages', 'Planifier / activer un voyage'),
  p('voyages.close', 'voyages', 'Clôturer / annuler un voyage'),
  p('charter_party.view', 'voyages', 'Voir les Charter Parties (confidentiel)', true),
  p('charter_party.manage', 'voyages', 'Créer / réviser une Charter Party'),
  p('charter_party.approve', 'voyages', 'Approuver une Charter Party', true),
  p('instructions.manage', 'voyages', 'Gérer les Voyage Instructions'),

  // ---------------- Noon Reports
  p('noon.view', 'noon', 'Voir les Noon Reports'),
  p('noon.create', 'noon', 'Créer / saisir un Noon Report'),
  p('noon.submit', 'noon', 'Soumettre un Noon Report'),
  p('noon.correct', 'noon', 'Corriger un Noon Report soumis (révision)'),
  p('noon.approve', 'noon', 'Accuser réception / demander correction'),
  p('noon.export', 'noon', 'Exporter un Noon Report PDF'),

  // ---------------- Plateforme
  p('dashboard.view', 'platform', 'Voir le tableau de bord'),
  p('notifications.rules.manage', 'platform', 'Configurer les règles de notification', true),
  p('files.upload', 'platform', 'Téléverser des fichiers'),
];

export const PERMISSION_KEYS = PERMISSIONS.map((x) => x.key);
export type PermissionKey = string;

export function isKnownPermission(key: string): boolean {
  return PERMISSION_KEYS.includes(key);
}

/** Rôles prédéfinis (ADM-020) — personnalisables après seed, sauf SUPER_ADMIN. */
export interface PredefinedRole {
  key: string;
  name: string;
  description: string;
  permissions: string[] | '*';
}

/**
 * Lecture « Direction / Viewer » : liste EXPLICITE (moindre privilège). Exclut volontairement les
 * lectures sensibles : comptes et sessions, accès transversal aux fiches Members (ADM-070),
 * Charter Parties confidentielles, archives / champs / audit CSO.
 */
const VIEWER_READS = [
  'vessels.view',
  'members.view',
  'members.certificates.view',
  'certificates.view',
  'cso.view',
  'suppliers.view',
  'pr.view', 'pr.view_all',
  'rfq.view',
  'quotation.view',
  'bc.view',
  'receiving.view',
  'invoice.view',
  'voyages.view',
  'noon.view',
  'departments.view',
];

/**
 * Matrice RACI AMC (« RACI Matrix platform.xlsx », 17/10/2026) : R/A = actions, C = consultation,
 * I = lecture seule. Lecture des achats accordée aux rôles « I » sur le module Achats.
 */
const PURCHASING_READS = ['pr.view', 'pr.view_all', 'rfq.view', 'quotation.view', 'bc.view', 'receiving.view', 'invoice.view', 'suppliers.view'];

export const PREDEFINED_ROLES: PredefinedRole[] = [
  {
    key: 'SUPER_ADMIN',
    name: 'Super Admin',
    description: 'Rôle système protégé : toutes les permissions (un DENY individuel reste prioritaire).',
    permissions: '*',
  },
  {
    key: 'ADMIN',
    name: 'Administrateur délégué',
    description: 'Gestion des comptes dans la limite de ses propres droits (ADM-005/006).',
    permissions: [
      'users.view', 'users.create', 'users.edit', 'users.deactivate', 'users.unlock', 'users.reset_password',
      'roles.view', 'departments.view', 'departments.manage', 'sessions.view', 'sessions.revoke',
      'audit.view.admin', 'vessels.view', 'dashboard.view', 'files.upload',
    ],
  },
  {
    key: 'CREWING',
    name: 'Crewing / RH',
    description:
      'Crew Dept (Crewing / RH). RACI : A/R fiches marins, matrice, certificats STCW / médicaux, évaluations et formations ; ' +
      'R embarquements ; I achats, Noon Reports.',
    permissions: [
      'members.view', 'members.create', 'members.edit', 'members.import', 'members.personal_fields.manage',
      'members.certificates.view', 'members.cross_vessel.view', 'members.link_user',
      'vessels.view', 'vessel_crew.assign',
      'certificates.view', 'certificates.create', 'certificates.edit', 'certificates.submit',
      'certificates.download_current', 'certificates.renewal.manage',
      'audit.view.members', 'dashboard.view', 'files.upload', 'reports.export',
      ...PURCHASING_READS, 'noon.view',
    ],
  },
  {
    key: 'TECHNICAL',
    name: 'Technical / QHSE',
    description: 'Certificats navires, documents, validations et échéances.',
    permissions: [
      'vessels.view', 'vessels.edit', 'vessel_documents.manage',
      'members.view', 'members.certificates.view',
      'certificates.view', 'certificates.create', 'certificates.edit', 'certificates.submit',
      'certificates.approve', 'certificates.archive', 'certificates.download_current',
      'certificates.download_archived', 'certificates.attachments.approve', 'certificates.renewal.manage',
      'pr.view', 'pr.view_all', 'bc.view', 'receiving.view', 'voyages.view', 'noon.view',
      'audit.view.certificates', 'audit.view.fleet', 'dashboard.view', 'files.upload', 'reports.export',
    ],
  },
  {
    key: 'PURCHASING',
    name: 'Purchasing',
    description: 'PR, RFQ, devis, BC, BL, réceptions et factures.',
    permissions: [
      'vessels.view', 'suppliers.view', 'suppliers.manage',
      'pr.view', 'pr.view_all', 'pr.create', 'pr.edit', 'pr.submit', 'pr.revise', 'pr.approve', 'pr.cancel',
      'rfq.view', 'rfq.manage', 'quotation.view', 'quotation.record', 'quotation.evaluate',
      'bc.view', 'bc.create', 'bc.send', 'receiving.view', 'receiving.validate', 'variances.manage',
      'invoice.view', 'invoice.manage', 'reports.export', 'audit.view.purchasing', 'dashboard.view', 'files.upload',
    ],
  },
  {
    key: 'PURCHASING_MANAGER',
    name: 'Purchasing Manager',
    description:
      'Responsable Achats : tout le circuit (PR en discussion, division, Counter-PR, consultations, BC, écarts de réception) ' +
      '+ second regard sur BC au-delà des seuils configurés (jamais sur ses propres BC).',
    permissions: [
      'vessels.view', 'suppliers.view', 'suppliers.manage',
      'pr.view', 'pr.view_all', 'pr.create', 'pr.edit', 'pr.submit', 'pr.revise', 'pr.approve', 'pr.cancel',
      'rfq.view', 'rfq.manage', 'quotation.view', 'quotation.record', 'quotation.evaluate',
      'bc.view', 'bc.create', 'bc.send', 'bc.approve', 'bc.cancel', 'receiving.view', 'receiving.validate', 'variances.manage',
      'invoice.view', 'invoice.manage', 'reports.export', 'audit.view.purchasing', 'dashboard.view', 'files.upload',
    ],
  },
  {
    key: 'CAPTAIN',
    name: 'Captain / Master',
    description:
      'Captain / Master. RACI : A/R PR (stores, vivres, soutes), dépôt des certificats et rapports de visite, Noon Reports ; ' +
      'R PR pièces, réception, embarquements et contrats MLC, audits ; C certificats ; I RFQ, BC, factures.',
    permissions: [
      'vessels.view', 'members.view', 'certificates.view', 'certificates.create', 'certificates.submit',
      'certificates.download_current', 'cso.view', 'cso.preview',
      'pr.view', 'pr.view_all', 'pr.create', 'pr.edit', 'pr.submit', 'bc.view', 'receiving.view', 'receiving.record',
      'voyages.view', 'charter_party.view', 'noon.view', 'noon.create', 'noon.submit', 'noon.correct', 'noon.export',
      'dashboard.view', 'files.upload',
      'rfq.view', 'quotation.view', 'invoice.view', 'suppliers.view', 'certificates.edit',
      'members.certificates.view', 'members.edit', 'vessel_crew.assign',
    ],
  },
  {
    key: 'CHIEF_ENGINEER',
    name: 'Chief Engineer',
    description:
      'Chief Engineer. Voit uniquement ses propres PR (et leurs BC / BL). RACI : A/R PR pièces de rechange ; R PR soutes, réception, Noon Reports, audits ; ' +
      'C revue technique et devis, dépôt des certificats ; I BC, factures.',
    permissions: [
      'vessels.view', 'certificates.view', 'certificates.download_current',
      'pr.view', 'pr.create', 'pr.edit', 'pr.submit', 'bc.view', 'receiving.view', 'receiving.record',
      'voyages.view', 'noon.view', 'noon.create', 'dashboard.view', 'files.upload',
      'rfq.view', 'quotation.view', 'invoice.view', 'suppliers.view', 'members.view', 'members.certificates.view',
    ],
  },
  {
    key: 'CSO_OFFICER',
    name: 'Company Security Officer',
    description:
      'Bibliothèque documentaire de sûreté (ISPS). RACI : C certificats et audits ; R alertes de sûreté (hors plateforme) ; ' +
      'I achats, équipages, Noon Reports.',
    permissions: [
      'vessels.view',
      'cso.view', 'cso.preview', 'cso.download', 'cso.create', 'cso.edit', 'cso.approve', 'cso.self_approve', 'cso.restore',
      'cso.share', 'cso.revoke', 'cso.archive.view', 'cso.archive.download', 'cso.folder.create',
      'cso.folder.rename', 'cso.folder.move', 'cso.folder.archive', 'cso.folder.acl_manage',
      'cso.fields.view', 'cso.fields.edit', 'cso.categories.manage', 'cso.import', 'cso.audit.view',
      'dashboard.view', 'files.upload',
      ...PURCHASING_READS, 'certificates.view', 'certificates.download_current', 'members.view', 'noon.view',
    ],
  },
  {
    key: 'DPA',
    name: 'DPA — Designated Person Ashore',
    description:
      'RACI : A/R certificats navires (coffre, renouvellements, audits), embarquements/débarquements et contrats MLC, alertes MLC ; ' +
      'C certificats STCW / médicaux ; I achats, fiches marins, Noon Reports.',
    permissions: [
      'vessels.view', 'dashboard.view', 'files.upload', 'reports.export',
      ...PURCHASING_READS,
      'certificates.view', 'certificates.create', 'certificates.edit', 'certificates.submit', 'certificates.approve',
      'certificates.archive', 'certificates.download_current', 'certificates.download_archived',
      'certificates.attachments.approve', 'certificates.renewal.manage', 'certificates.types.manage', 'audit.view.certificates',
      'members.view', 'members.certificates.view', 'members.cross_vessel.view', 'members.edit', 'vessel_crew.assign', 'audit.view.members',
      'noon.view',
    ],
  },
  {
    key: 'OPS_MANAGER',
    name: 'Ops Manager — Opérations & Achats',
    description:
      'RACI : A/R revue technique et RFQ, approbation BC et budget, suivi de livraison et confirmation de réception, factures et fournisseurs ; ' +
      'R création de PR ; C embarquements ; I certificats, équipages, Noon Reports.',
    permissions: [
      'vessels.view', 'dashboard.view', 'files.upload', 'reports.export', 'audit.view.purchasing',
      'pr.view', 'pr.view_all', 'pr.create', 'pr.edit', 'pr.submit', 'pr.revise', 'pr.approve', 'pr.cancel',
      'rfq.view', 'rfq.manage', 'quotation.view', 'quotation.record', 'quotation.evaluate', 'suppliers.view', 'suppliers.manage',
      'bc.view', 'bc.create', 'bc.approve', 'bc.send', 'bc.cancel',
      'receiving.view', 'receiving.record', 'receiving.validate', 'variances.manage',
      'invoice.view', 'invoice.manage',
      'certificates.view', 'members.view', 'noon.view',
    ],
  },
  {
    key: 'COMMERCIAL',
    name: 'Commercial',
    description: 'RACI : C Noon Reports (accusé de réception, demande de correction) ; I achats, certificats, équipages.',
    permissions: [
      'vessels.view', 'dashboard.view', 'reports.export',
      ...PURCHASING_READS, 'certificates.view', 'members.view', 'noon.view', 'noon.export', 'noon.approve',
    ],
  },
  {
    key: 'OPERATIONS',
    name: 'Marine Operations',
    description: 'Voyages, Charter Parties, instructions, Noon Reports.',
    permissions: [
      'vessels.view', 'certificates.view',
      'voyages.view', 'voyages.create', 'voyages.edit', 'voyages.activate', 'voyages.close',
      'charter_party.view', 'charter_party.manage', 'charter_party.approve', 'instructions.manage',
      'noon.view', 'noon.approve', 'noon.export', 'audit.view.voyages', 'dashboard.view', 'files.upload',
      'reports.export',
    ],
  },
  {
    key: 'VIEWER',
    name: 'Direction / Viewer',
    description: 'Visibilité agrégée en lecture selon le scope navire.',
    permissions: [...VIEWER_READS, 'dashboard.view', 'reports.export'],
  },
];
