import { Injectable } from '@nestjs/common';
import type { CsoDocument, CsoFolder, CsoLibrary } from '@prisma/client';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, canAccessVessel, principalsOf } from '../access/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import {
  ACTION_PERMISSION,
  ActionMap,
  AclEntryLike,
  AclNode,
  CsoAction,
  FolderValidators,
  PrincipalRef,
  ShareGrant,
  canSeeDocument,
  chainFromPath,
  emptyActions,
  evaluateAccess,
  isConfiguredValidator,
  nearestValidators,
  pathIds,
} from './cso-acl.logic';
import { IN_FLIGHT_VERSION } from './cso-rules';

export const OWNER_CSO_VERSION = 'cso_version';
export const OWNER_CSO_IMPORT = 'cso_import_job';
export const OWNER_EXPORT_JOB = 'export_job';

const ACL_SELECT = { principalType: true, principalId: true, actions: true, effect: true } as const;

export type FolderRef = Pick<CsoFolder, 'id' | 'libraryId' | 'path' | 'status'>;
export type DocumentRef = Pick<CsoDocument, 'id' | 'libraryId' | 'folderId' | 'status' | 'authorId' | 'inheritAcl'>;

export interface FolderAccess<F extends FolderRef = CsoFolder> {
  folder: F;
  library: CsoLibrary;
  eff: ActionMap;
}

export interface DocumentAccess {
  doc: CsoDocument;
  folder: CsoFolder;
  library: CsoLibrary;
  eff: ActionMap;
  /** Accès obtenu (au moins en partie) grâce à un partage interne actif */
  viaShare: boolean;
}

/**
 * Évaluation des droits documentaires CSO (CDC §5.2/§5.6) : charge en lot les chaînes d'héritage
 * (dossiers ancêtres via le chemin matérialisé), les ACL document et les partages, puis applique
 * le moteur pur `evaluateAccess`. Aucune décision n'est mise en cache : droits recalculés à chaque appel.
 */
@Injectable()
export class CsoAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------------------------------------------------------------------------
  // Bibliothèques & scope
  // ---------------------------------------------------------------------------

  /** Bibliothèque centrale = flotte entière ; bibliothèque navire = scope navire. */
  libraryInScope(ctx: AuthContext, lib: Pick<CsoLibrary, 'kind' | 'vesselId'>): boolean {
    return lib.kind === 'CENTRAL' || canAccessVessel(ctx, lib.vesselId);
  }

  async libraries(db: Db = this.prisma): Promise<Map<string, CsoLibrary>> {
    const rows = await db.csoLibrary.findMany();
    return new Map(rows.map((l) => [l.id, l]));
  }

  async getLibrary(ctx: AuthContext, id: string, db: Db = this.prisma): Promise<CsoLibrary> {
    const lib = await db.csoLibrary.findUnique({ where: { id } });
    if (!lib) throw Errors.notFound('Bibliothèque');
    if (!this.libraryInScope(ctx, lib)) throw Errors.scopeDenied();
    return lib;
  }

  // ---------------------------------------------------------------------------
  // Chargement des chaînes d'héritage
  // ---------------------------------------------------------------------------

  /** Nœuds ACL des dossiers (et de leurs ancêtres) pour un ensemble de chemins. */
  async folderNodes(paths: string[], db: Db = this.prisma): Promise<Map<string, AclNode>> {
    const ids = [...new Set(paths.flatMap(pathIds))];
    if (!ids.length) return new Map();
    const rows = await db.csoFolder.findMany({
      where: { id: { in: ids } },
      select: { id: true, inheritAcl: true, acl: { select: ACL_SELECT } },
    });
    return new Map(rows.map((r) => [r.id, { inheritAcl: r.inheritAcl, entries: r.acl as AclEntryLike[] }]));
  }

  private evalInput(ctx: AuthContext, inScope: boolean, chain: AclNode[], target: 'folder' | 'document', shares?: ShareGrant[]) {
    return evaluateAccess({
      permissions: ctx.permissions,
      principals: principalsOf(ctx) as PrincipalRef[],
      inScope,
      chain,
      shares,
      target,
      superAdmin: ctx.isSuperAdmin,
    });
  }

  /** Droits effectifs sur un lot de dossiers. */
  async foldersAccess<F extends FolderRef>(
    ctx: AuthContext,
    folders: F[],
    db: Db = this.prisma,
    libs?: Map<string, CsoLibrary>,
  ): Promise<Map<string, ActionMap>> {
    const libraries = libs ?? (await this.libraries(db));
    const nodes = await this.folderNodes(folders.map((f) => f.path), db);
    const out = new Map<string, ActionMap>();
    for (const f of folders) {
      const lib = libraries.get(f.libraryId);
      if (!lib) {
        out.set(f.id, emptyActions());
        continue;
      }
      out.set(f.id, this.evalInput(ctx, this.libraryInScope(ctx, lib), chainFromPath(f.path, nodes), 'folder'));
    }
    return out;
  }

  /** Droits effectifs sur un lot de documents (ACL document + chaîne du dossier + partages actifs). */
  async documentsAccess(
    ctx: AuthContext,
    docs: DocumentRef[],
    db: Db = this.prisma,
  ): Promise<{ eff: Map<string, ActionMap>; viaShare: Set<string> }> {
    const eff = new Map<string, ActionMap>();
    const viaShare = new Set<string>();
    if (!docs.length) return { eff, viaShare };
    const docIds = docs.map((d) => d.id);
    const [libraries, folders, docAcl, shares] = await Promise.all([
      this.libraries(db),
      db.csoFolder.findMany({ where: { id: { in: [...new Set(docs.map((d) => d.folderId))] } }, select: { id: true, path: true } }),
      db.csoAclEntry.findMany({ where: { documentId: { in: docIds } }, select: { ...ACL_SELECT, documentId: true } }),
      db.csoShare.findMany({
        where: {
          documentId: { in: docIds },
          revokedAt: null,
          OR: [{ recipientUserId: ctx.userId }, ...(ctx.departmentIds.length ? [{ recipientDepartmentId: { in: ctx.departmentIds } }] : [])],
        },
        select: { documentId: true, allowDownload: true },
      }),
    ]);
    const folderPath = new Map(folders.map((f) => [f.id, f.path]));
    const nodes = await this.folderNodes([...folderPath.values()], db);
    for (const d of docs) {
      const lib = libraries.get(d.libraryId);
      const path = folderPath.get(d.folderId);
      if (!lib || !path) {
        eff.set(d.id, emptyActions());
        continue;
      }
      const docNode: AclNode = { inheritAcl: d.inheritAcl, entries: docAcl.filter((e) => e.documentId === d.id) as AclEntryLike[] };
      const chain = chainFromPath(path, nodes, docNode);
      const docShares = shares.filter((s) => s.documentId === d.id);
      const inScope = this.libraryInScope(ctx, lib);
      const withShares = this.evalInput(ctx, inScope, chain, 'document', docShares);
      if (docShares.length) {
        const without = this.evalInput(ctx, inScope, chain, 'document');
        if ((withShares.view && !without.view) || (withShares.download && !without.download)) viaShare.add(d.id);
      }
      eff.set(d.id, withShares);
    }
    return { eff, viaShare };
  }

  // ---------------------------------------------------------------------------
  // Assertions (lecture d'un enregistrement + contrôle des actions)
  // ---------------------------------------------------------------------------

  private assertActions(ctx: AuthContext, eff: ActionMap, actions: CsoAction[]): void {
    for (const a of actions) {
      if (eff[a]) continue;
      const perm = ACTION_PERMISSION[a];
      if (!can(ctx, perm)) throw Errors.forbidden(`Permission requise : ${perm}`, { permission: perm });
      throw Errors.aclDenied();
    }
  }

  /** Dossier visible ? (archivé => view_archived) */
  folderVisible(folder: Pick<CsoFolder, 'status'>, eff: ActionMap): boolean {
    return eff.view && (folder.status === 'ACTIVE' || eff.view_archived);
  }

  /**
   * Charge un dossier et vérifie scope + visibilité + actions demandées.
   * Les dossiers non visibles sont refusés sans divulguer leur contenu (403 ACL_DENIED).
   */
  async assertFolder(
    ctx: AuthContext,
    id: string,
    actions: CsoAction[] = [],
    opts: { requireActive?: boolean } = {},
    db: Db = this.prisma,
  ): Promise<FolderAccess> {
    const folder = await db.csoFolder.findUnique({ where: { id } });
    if (!folder) throw Errors.notFound('Dossier');
    const libs = await this.libraries(db);
    const library = libs.get(folder.libraryId)!;
    if (!this.libraryInScope(ctx, library)) throw Errors.scopeDenied();
    const eff = (await this.foldersAccess(ctx, [folder], db, libs)).get(folder.id)!;
    if (!this.folderVisible(folder, eff)) {
      if (!can(ctx, 'cso.view')) throw Errors.forbidden('Permission requise : cso.view', { permission: 'cso.view' });
      throw Errors.aclDenied();
    }
    this.assertActions(ctx, eff, actions);
    if (opts.requireActive && folder.status !== 'ACTIVE') throw Errors.invalidState('Dossier archivé : opération impossible');
    return { folder, library, eff };
  }

  /** Charge un document et vérifie scope + visibilité métier + actions demandées. */
  async assertDocument(
    ctx: AuthContext,
    id: string,
    actions: CsoAction[] = [],
    opts: { requireNotArchived?: boolean } = {},
    db: Db = this.prisma,
  ): Promise<DocumentAccess> {
    const doc = await db.csoDocument.findUnique({ where: { id } });
    if (!doc) throw Errors.notFound('Document');
    const [library, folder] = await Promise.all([
      db.csoLibrary.findUniqueOrThrow({ where: { id: doc.libraryId } }),
      db.csoFolder.findUniqueOrThrow({ where: { id: doc.folderId } }),
    ]);
    if (!this.libraryInScope(ctx, library)) throw Errors.scopeDenied();
    const { eff, viaShare } = await this.documentsAccess(ctx, [doc], db);
    const e = eff.get(doc.id)!;
    const submitters = await this.inFlightSubmitters([doc.id], db);
    if (!canSeeDocument(e, doc, ctx.userId, submitters.get(doc.id) ?? [])) {
      if (!can(ctx, 'cso.view')) throw Errors.forbidden('Permission requise : cso.view', { permission: 'cso.view' });
      throw Errors.aclDenied();
    }
    this.assertActions(ctx, e, actions);
    if (opts.requireNotArchived && doc.status === 'ARCHIVED') throw Errors.invalidState('Document archivé : opération impossible');
    return { doc, folder, library, eff: e, viaShare: viaShare.has(doc.id) };
  }

  /** Soumetteurs des versions en cours (visibilité des documents jamais publiés). */
  async inFlightSubmitters(docIds: string[], db: Db = this.prisma): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!docIds.length) return out;
    const rows = await db.csoVersion.findMany({
      where: { documentId: { in: docIds }, status: { in: IN_FLIGHT_VERSION } },
      select: { documentId: true, submittedById: true },
    });
    for (const r of rows) out.set(r.documentId, [...(out.get(r.documentId) ?? []), r.submittedById]);
    return out;
  }

  /** Filtre une liste de documents sur la visibilité effective (ACL + workflow + archives). */
  async filterVisibleDocuments<D extends DocumentRef>(
    ctx: AuthContext,
    docs: D[],
    db: Db = this.prisma,
  ): Promise<{ visible: D[]; eff: Map<string, ActionMap>; viaShare: Set<string> }> {
    const { eff, viaShare } = await this.documentsAccess(ctx, docs, db);
    const submitters = await this.inFlightSubmitters(
      docs.filter((d) => d.status === 'DRAFT').map((d) => d.id),
      db,
    );
    const visible = docs.filter((d) => canSeeDocument(eff.get(d.id)!, d, ctx.userId, submitters.get(d.id) ?? []));
    return { visible, eff, viaShare };
  }

  // ---------------------------------------------------------------------------
  // Validateurs (CSO-006) et contexte d'un autre utilisateur
  // ---------------------------------------------------------------------------

  /** Validateurs applicables au dossier (dossier le plus proche qui en définit), ou null. */
  async validatorsFor(folderPath: string, db: Db = this.prisma): Promise<FolderValidators | null> {
    const ids = pathIds(folderPath);
    const rows = await db.csoFolderValidator.findMany({ where: { folderId: { in: ids } } });
    const chain: FolderValidators[] = ids
      .slice()
      .reverse()
      .map((folderId) => ({
        folderId,
        validators: rows.filter((r) => r.folderId === folderId).map((r) => ({ type: r.principalType, id: r.principalId })),
      }));
    return nearestValidators(chain);
  }

  isEligibleValidator(ctx: AuthContext, config: FolderValidators | null): boolean {
    return isConfiguredValidator(principalsOf(ctx) as PrincipalRef[], config);
  }

  /**
   * Contexte d'autorisation d'un autre utilisateur (worker ZIP, rappels, filtrage des destinataires),
   * recalculé depuis la base comme le fait le guard. null si compte inactif / verrouillé.
   */
  async contextForUser(userId: string, db: Db = this.prisma): Promise<AuthContext | null> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        username: true,
        displayName: true,
        email: true,
        status: true,
        lockedAt: true,
        memberId: true,
        vesselScope: true,
        mustChangePassword: true,
        departments: { where: { department: { status: 'ACTIVE' } }, select: { departmentId: true } },
      },
    });
    if (!user || user.status !== 'ACTIVE' || user.lockedAt) return null;
    const [eff, scope] = await Promise.all([
      this.access.computeEffectivePermissions(user.id, db),
      this.access.computeVesselScope(user.id, user.vesselScope, db),
    ]);
    return {
      userId: user.id,
      sessionId: '',
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      memberId: user.memberId,
      mustChangePassword: user.mustChangePassword,
      isSuperAdmin: eff.isSuperAdmin,
      roleIds: eff.roleIds,
      roleKeys: eff.roleKeys,
      departmentIds: user.departments.map((d) => d.departmentId),
      permissions: eff.permissions,
      deniedPermissions: eff.denied,
      vesselScope: scope,
      ip: null,
      userAgent: null,
      requestId: null,
    };
  }

  /**
   * Utilisateurs réellement autorisés à une action sur un document (permission module + scope + ACL
   * + règle validateurs pour approve) — sert aux notifications : jamais de destinataire sans droit réel.
   */
  async usersAllowedOnDocument(
    candidateIds: string[],
    doc: DocumentRef,
    action: CsoAction,
    opts: { validators?: FolderValidators | null; excludeUserIds?: string[] } = {},
    db: Db = this.prisma,
    cache?: Map<string, AuthContext | null>,
  ): Promise<string[]> {
    const out: string[] = [];
    for (const userId of new Set(candidateIds)) {
      if (opts.excludeUserIds?.includes(userId)) continue;
      let uctx = cache?.get(userId);
      if (uctx === undefined) {
        uctx = await this.contextForUser(userId, db);
        cache?.set(userId, uctx);
      }
      if (!uctx) continue;
      const { eff } = await this.documentsAccess(uctx, [doc], db);
      const e = eff.get(doc.id)!;
      if (!e.view || !e[action]) continue;
      if (action === 'approve' && opts.validators !== undefined && !this.isEligibleValidator(uctx, opts.validators)) continue;
      out.push(userId);
    }
    return out;
  }

  /** Candidats validateurs d'un document : principaux configurés, sinon titulaires de cso.approve. */
  async validatorCandidates(config: FolderValidators | null, vesselId: string | null, db: Db = this.prisma): Promise<string[]> {
    if (config) {
      return this.notifications.resolvePrincipals(
        config.validators.map((v) => ({ type: v.type, id: v.id })),
        db,
      );
    }
    return this.access.usersWithPermission('cso.approve', vesselId, db);
  }
}
