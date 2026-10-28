/**
 * Moteur d'accès documentaire CSO — logique PURE (sans I/O), testée unitairement.
 *
 * Formule (CDC §2.1 / §5.2 / §5.6, CSO-003/004/014) :
 *   autorisé(action) = permission module (cso.*)
 *                    ∧ scope navire de la bibliothèque (bibliothèque centrale = flotte entière)
 *                    ∧ ACL ressource (héritée du dossier parent jusqu'à une rupture d'héritage)
 *                    ∧ implications (toute action exige « view » ; download_archived exige view_archived)
 *
 * ACL (chaîne document -> dossier -> ancêtres, arrêt APRÈS un nœud dont inheritAcl = false) :
 *  - un DENY visant l'un des principaux de l'utilisateur pour l'action => refus (prioritaire) ;
 *  - si la chaîne contient au moins un ALLOW mentionnant l'action => mode restrictif :
 *    l'utilisateur doit correspondre à l'un de ces ALLOW ;
 *  - si aucune entrée ne mentionne l'action => permission module + scope suffisent.
 * L'ACL n'accorde jamais au-delà de la permission module (« exceptions compatibles »).
 *
 * Partage interne actif (CSO-014) : ajoute au plus view + preview (+ download si allowDownload) sur le
 * document ; ne contourne ni la permission module, ni le scope navire, ni un DENY explicite, et
 * n'accorde JAMAIS d'autre action (edit, approve, acl_manage, share, archives…), qui restent évaluées
 * exactement comme sans partage.
 */

export const CSO_ACTIONS = [
  'view',
  'preview',
  'download',
  'view_archived',
  'download_archived',
  'edit',
  'folder_create',
  'folder_rename',
  'folder_move',
  'folder_archive',
  'acl_manage',
  'approve',
  'restore',
  'share',
] as const;
export type CsoAction = (typeof CSO_ACTIONS)[number];

/** Permission module requise pour chaque action (l'ACL ne peut jamais l'outrepasser). */
export const ACTION_PERMISSION: Record<CsoAction, string> = {
  view: 'cso.view',
  preview: 'cso.preview',
  download: 'cso.download',
  view_archived: 'cso.archive.view',
  download_archived: 'cso.archive.download',
  edit: 'cso.edit',
  folder_create: 'cso.folder.create',
  folder_rename: 'cso.folder.rename',
  folder_move: 'cso.folder.move',
  folder_archive: 'cso.folder.archive',
  acl_manage: 'cso.folder.acl_manage',
  approve: 'cso.approve',
  restore: 'cso.restore',
  share: 'cso.share',
};

export type PrincipalKind = 'USER' | 'ROLE' | 'DEPARTMENT';

export interface PrincipalRef {
  type: PrincipalKind;
  id: string;
}

export interface AclEntryLike {
  principalType: PrincipalKind;
  principalId: string;
  actions: string[];
  effect: 'ALLOW' | 'DENY';
}

/** Nœud de la chaîne d'héritage (document ou dossier). */
export interface AclNode {
  inheritAcl: boolean;
  entries: AclEntryLike[];
}

export interface ShareGrant {
  allowDownload: boolean;
}

export interface AccessInput {
  /** Permissions effectives de l'utilisateur (rôles + overrides). */
  permissions: ReadonlySet<string>;
  /** Principaux de l'utilisateur : user, rôles, départements actifs. */
  principals: PrincipalRef[];
  /** Bibliothèque accessible (centrale, ou navire dans le scope). */
  inScope: boolean;
  /** Chaîne du plus spécifique (document ou dossier ciblé) vers la racine. */
  chain: AclNode[];
  /** Partages internes actifs visant l'utilisateur sur CE document. */
  shares?: ShareGrant[];
  /** Ressource évaluée : la « porte de secours » Super Admin ne vaut que pour les dossiers. */
  target: 'folder' | 'document';
  /**
   * Super Admin : conserve la visibilité du dossier et la gestion d'ACL même en cas de DENY
   * (évite un verrouillage irréversible d'une zone) — jamais l'accès au contenu des documents.
   */
  superAdmin?: boolean;
}

export type ActionMap = Record<CsoAction, boolean>;

export type AclDecision = 'DENY' | 'ALLOW' | 'NOT_LISTED' | 'NEUTRAL';

/** Entrées applicables : nœud courant puis ancêtres, arrêt après le premier nœud sans héritage. */
export function collectEntries(chain: AclNode[]): AclEntryLike[] {
  const out: AclEntryLike[] = [];
  for (const node of chain) {
    out.push(...node.entries);
    if (!node.inheritAcl) break;
  }
  return out;
}

export function matchesPrincipal(entry: Pick<AclEntryLike, 'principalType' | 'principalId'>, principals: PrincipalRef[]): boolean {
  return principals.some((p) => p.type === entry.principalType && p.id === entry.principalId);
}

/**
 * Décision ACL brute pour une action :
 *  DENY (refus explicite), ALLOW (l'utilisateur figure dans un ALLOW),
 *  NOT_LISTED (mode restrictif : des ALLOW existent mais pas pour lui), NEUTRAL (aucune entrée).
 */
export function aclDecision(entries: AclEntryLike[], action: CsoAction, principals: PrincipalRef[]): AclDecision {
  const relevant = entries.filter((e) => e.actions.includes(action));
  if (relevant.some((e) => e.effect === 'DENY' && matchesPrincipal(e, principals))) return 'DENY';
  const allows = relevant.filter((e) => e.effect === 'ALLOW');
  if (!allows.length) return 'NEUTRAL';
  return allows.some((e) => matchesPrincipal(e, principals)) ? 'ALLOW' : 'NOT_LISTED';
}


/** Évaluation ACL + permission module + scope + implications, SANS partage. */
function evaluateWithoutShares(input: AccessInput, entries: AclEntryLike[]): ActionMap {
  const raw = {} as ActionMap;
  for (const action of CSO_ACTIONS) {
    if (!input.inScope || !input.permissions.has(ACTION_PERMISSION[action])) {
      raw[action] = false;
      continue;
    }
    const decision = aclDecision(entries, action, input.principals);
    raw[action] = decision === 'ALLOW' || decision === 'NEUTRAL';
  }
  // Implications : aucune action sur une ressource invisible.
  const result = {} as ActionMap;
  for (const action of CSO_ACTIONS) {
    result[action] = raw[action] && (action === 'view' || raw.view);
  }
  result.download_archived = result.download_archived && result.view_archived;
  return result;
}

/**
 * Apport d'un partage : UNIQUEMENT view + preview (+ download si allowDownload), chacun exigeant la
 * permission module, le scope et l'absence de DENY. Le partage ne rend jamais « visible » le document
 * pour les autres actions : edit, approve, acl_manage, share, archives… restent évaluées exactement
 * comme sans partage (sinon toute action non mentionnée par l'ACL deviendrait accordée).
 */
function shareGrant(input: AccessInput, entries: AclEntryLike[], shares: ShareGrant[], base: ActionMap): Pick<ActionMap, 'view' | 'preview' | 'download'> {
  const allowed = (action: CsoAction) =>
    input.inScope && input.permissions.has(ACTION_PERMISSION[action]) && aclDecision(entries, action, input.principals) !== 'DENY';
  const view = base.view || allowed('view');
  return {
    view,
    preview: base.preview || (view && allowed('preview')),
    download: base.download || (view && shares.some((s) => s.allowDownload) && allowed('download')),
  };
}

/** Actions effectives d'un utilisateur sur une ressource. */
export function evaluateAccess(input: AccessInput): ActionMap {
  const entries = collectEntries(input.chain);
  const shares = input.target === 'document' ? input.shares ?? [] : [];
  const result = evaluateWithoutShares(input, entries);
  if (shares.length) Object.assign(result, shareGrant(input, entries, shares, result));

  if (input.superAdmin && input.target === 'folder' && input.inScope) {
    if (input.permissions.has(ACTION_PERMISSION.view)) result.view = true;
    if (input.permissions.has(ACTION_PERMISSION.acl_manage)) result.acl_manage = true;
  }
  return result;
}

/** Liste des actions accordées (réponse « effective-access » pour l'UI). */
export function grantedActions(map: ActionMap): CsoAction[] {
  return CSO_ACTIONS.filter((a) => map[a]);
}

export function emptyActions(): ActionMap {
  return Object.fromEntries(CSO_ACTIONS.map((a) => [a, false])) as ActionMap;
}

/** Liste d'ancêtres d'un chemin matérialisé "/a/b/c/" -> ["a","b","c"] (racine en premier). */
export function pathIds(path: string): string[] {
  return path.split('/').filter(Boolean);
}

/**
 * Construit la chaîne d'héritage (plus spécifique d'abord) à partir du chemin du dossier.
 * `nodes` contient les dossiers connus (id -> nœud) ; un ancêtre manquant interrompt la chaîne.
 */
export function chainFromPath(path: string, nodes: Map<string, AclNode>, documentNode?: AclNode): AclNode[] {
  const chain: AclNode[] = documentNode ? [documentNode] : [];
  const ids = pathIds(path).reverse();
  for (const id of ids) {
    const n = nodes.get(id);
    if (!n) break;
    chain.push(n);
  }
  return chain;
}

// -----------------------------------------------------------------------------
// Visibilité métier des documents et versions (workflow + archives — CSO-005/007/008)
// -----------------------------------------------------------------------------

export type DocStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export type VersionStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'RETURNED'
  | 'REJECTED'
  | 'PUBLISHED'
  | 'SUPERSEDED'
  | 'CANCELLED';

export interface DocLike {
  status: DocStatus;
  authorId: string;
}

/** Participant au workflow : auteur, rédacteur (edit) ou validateur (approve). */
export function isWorkflowParticipant(eff: ActionMap, doc: DocLike, userId: string, submitterIds: string[] = []): boolean {
  return doc.authorId === userId || submitterIds.includes(userId) || eff.edit || eff.approve;
}

/**
 * Un document est visible si l'action « view » est accordée ET :
 *  - archivé : droit view_archived (CSO-008) ;
 *  - jamais publié (DRAFT / restauration en attente) : réservé aux participants du workflow
 *    (aucun contenu non officiel exposé aux simples lecteurs).
 */
export function canSeeDocument(eff: ActionMap, doc: DocLike, userId: string, submitterIds: string[] = []): boolean {
  if (!eff.view) return false;
  if (doc.status === 'ARCHIVED') return eff.view_archived;
  if (doc.status === 'DRAFT') return isWorkflowParticipant(eff, doc, userId, submitterIds);
  return true;
}

export type VersionMode = 'meta' | 'preview' | 'thumbnail' | 'download';

const OFFICIAL_VERSION: VersionStatus[] = ['PUBLISHED'];
const ARCHIVED_VERSION: VersionStatus[] = ['SUPERSEDED'];

/**
 * Accès à une version (fichier) :
 *  - version officielle courante : preview / download ;
 *  - version archivée (SUPERSEDED ou document archivé) : view_archived (aperçu) /
 *    download_archived (téléchargement) — CSO-008 ;
 *  - version non officielle (brouillon, en attente, retournée, rejetée, annulée) :
 *    participants du workflow uniquement (soumetteur, edit, approve) + preview / download.
 */
export function canAccessVersion(
  eff: ActionMap,
  doc: DocLike,
  version: { status: VersionStatus; submittedById: string },
  userId: string,
  mode: VersionMode,
): boolean {
  if (!canSeeDocument(eff, doc, userId, [version.submittedById])) return false;
  const archived = ARCHIVED_VERSION.includes(version.status) || (doc.status === 'ARCHIVED' && version.status === 'PUBLISHED');
  if (archived) {
    if (mode === 'download') return eff.download_archived;
    return eff.view_archived;
  }
  if (!OFFICIAL_VERSION.includes(version.status)) {
    if (!isWorkflowParticipant(eff, doc, userId, [version.submittedById])) return false;
  }
  if (mode === 'meta') return eff.view;
  if (mode === 'download') return eff.download;
  return eff.preview;
}

// -----------------------------------------------------------------------------
// Validateurs (CSO-006) : dossier le plus proche ayant des validateurs configurés
// -----------------------------------------------------------------------------

export interface FolderValidators {
  folderId: string;
  validators: PrincipalRef[];
}

/**
 * Validateurs applicables : ceux du dossier le plus proche (dossier puis ancêtres) qui en définit.
 * `null` => aucun validateur configuré dans la hiérarchie : tout titulaire de cso.approve dans le scope.
 */
export function nearestValidators(chainNearestFirst: FolderValidators[]): FolderValidators | null {
  for (const f of chainNearestFirst) if (f.validators.length) return f;
  return null;
}

export function isConfiguredValidator(principals: PrincipalRef[], config: FolderValidators | null): boolean {
  if (!config) return true;
  return config.validators.some((v) => matchesPrincipal({ principalType: v.type, principalId: v.id }, principals));
}

// -----------------------------------------------------------------------------
// ACL de champs personnalisés (CSO-031/032, CDC §5.6)
// -----------------------------------------------------------------------------

export interface FieldAclLike {
  principalType: PrincipalKind;
  principalId: string;
  canView: boolean;
  canEdit: boolean;
}

export interface FieldAccessInput {
  isConfidential: boolean;
  archived: boolean;
  acl: FieldAclLike[];
  principals: PrincipalRef[];
  permissions: ReadonlySet<string>;
  /** Droit de voir le document (et scope navire) */
  documentView: boolean;
  /** Droit d'éditer le document (cso.edit + ACL edit + scope) */
  documentEdit: boolean;
}

/**
 * Visibilité / édition d'un champ :
 *  - vue : document visible ; champ confidentiel => cso.fields.view ; une entrée canView=false
 *    visant l'utilisateur masque le champ (refus prioritaire) ; si des entrées canView=true existent,
 *    l'utilisateur doit en faire partie (liste restrictive) ;
 *  - édition : vue + cso.fields.edit + édition du document + champ non archivé ; si des entrées
 *    canEdit=true existent, l'utilisateur doit en faire partie.
 */
export function fieldAccess(input: FieldAccessInput): { view: boolean; edit: boolean } {
  const mine = input.acl.filter((e) => matchesPrincipal(e, input.principals));
  let view = input.documentView;
  if (input.isConfidential && !input.permissions.has('cso.fields.view')) view = false;
  if (mine.some((e) => !e.canView)) view = false;
  const viewList = input.acl.filter((e) => e.canView);
  if (viewList.length && !mine.some((e) => e.canView)) view = false;

  let edit = view && !input.archived && input.documentEdit && input.permissions.has('cso.fields.edit');
  const editList = input.acl.filter((e) => e.canEdit);
  if (editList.length && !mine.some((e) => e.canEdit && e.canView)) edit = false;
  return { view, edit };
}

// -----------------------------------------------------------------------------
// Opérations de sous-arbre (déplacement / archivage — audit #9, CDC §5.6)
// -----------------------------------------------------------------------------

/**
 * Une opération portant sur tout un sous-arbre n'est permise que si CHAQUE élément concerné
 * (dossier ou document) est visible et autorise l'action : jamais d'effet sur du contenu hors droits.
 */
export function subtreeAllows(items: ActionMap[], actions: CsoAction[] = []): boolean {
  return items.every((e) => e.view && actions.every((a) => e[a]));
}
