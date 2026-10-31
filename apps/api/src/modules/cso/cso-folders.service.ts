import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CsoDocument, CsoFolder, CsoLibrary, CsoVersion, PrincipalType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CsoAction, breaksWithoutViewRule, grantedActions, pathIds, subtreeAllows } from './cso-acl.logic';
import { CsoAccessService, OWNER_CSO_VERSION } from './cso-access.service';
import { assertPrincipalsExist, isUniqueViolation, presentFolder, presentLibrary, principalLabels } from './cso-presenters';
import { CsoWorkflowService } from './cso-workflow.service';
import type {
  ArchiveDto,
  CreateFolderDto,
  ListFoldersQuery,
  MoveFolderDto,
  PutAclDto,
  PutValidatorsDto,
  RenameFolderDto,
  RestoreFolderDto,
  TreeQuery,
} from './cso.dto';

export interface TreeNode {
  id: string;
  name: string;
  status: string;
  depth: number;
  actions: CsoAction[];
  children: TreeNode[];
}

/**
 * Bibliothèques et arborescence CSO (CDC §5.1/§5.6, CSO-002/018..021). Les zones non autorisées
 * n'apparaissent jamais : un dossier n'est listé que si l'utilisateur peut le voir, et l'arbre est
 * élagué sous tout dossier invisible.
 */
@Injectable()
export class CsoFoldersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly csoAccess: CsoAccessService,
    private readonly audit: AuditService,
    private readonly workflow: CsoWorkflowService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  /** Bibliothèques atteignables : centrale (flotte) + bibliothèques des navires du scope. */
  async listLibraries(ctx: AuthContext) {
    const libs = await this.prisma.csoLibrary.findMany({
      where: { OR: [{ kind: 'CENTRAL' }, { kind: 'VESSEL', ...vesselWhere(ctx) }] },
      include: { vessel: { select: { id: true, code: true, name: true, status: true } } },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return libs
      .filter((l) => this.csoAccess.libraryInScope(ctx, l))
      .map((l) => ({ ...presentLibrary(l, l.vessel), canCreateRootFolder: can(ctx, 'cso.folder.create') }));
  }

  private statusFilter(ctx: AuthContext, includeArchived?: boolean) {
    return includeArchived && can(ctx, 'cso.archive.view') ? {} : { status: 'ACTIVE' as const };
  }

  /** Sous-dossiers directs visibles d'un dossier, ou dossiers racine d'une bibliothèque. */
  async listFolders(ctx: AuthContext, q: ListFoldersQuery) {
    let where: { parentId: string | null; libraryId?: string };
    if (q.parentId) {
      const { folder } = await this.csoAccess.assertFolder(ctx, q.parentId);
      where = { parentId: folder.id };
    } else {
      if (!q.libraryId) throw Errors.validation('libraryId ou parentId requis');
      await this.csoAccess.getLibrary(ctx, q.libraryId);
      where = { libraryId: q.libraryId, parentId: null };
    }
    const rows = await this.prisma.csoFolder.findMany({
      where: { ...where, ...this.statusFilter(ctx, q.includeArchived) },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const eff = await this.csoAccess.foldersAccess(ctx, rows);
    return rows.filter((f) => this.csoAccess.folderVisible(f, eff.get(f.id)!)).map((f) => presentFolder(f, eff.get(f.id)));
  }

  async getFolder(ctx: AuthContext, id: string) {
    const { folder, library, eff } = await this.csoAccess.assertFolder(ctx, id);
    const vessel = library.vesselId
      ? await this.prisma.vessel.findUnique({ where: { id: library.vesselId }, select: { id: true, code: true, name: true } })
      : null;
    return {
      ...presentFolder(folder, eff),
      library: presentLibrary(library, vessel),
      breadcrumb: await this.breadcrumb(ctx, folder),
    };
  }

  /** Fil d'Ariane : les ancêtres invisibles sont omis (truncated = true), jamais nommés. */
  async breadcrumb(ctx: AuthContext, folder: Pick<CsoFolder, 'id' | 'path'>, db: Db = this.prisma) {
    const ids = pathIds(folder.path).filter((x) => x !== folder.id);
    if (!ids.length) return { items: [] as { id: string; name: string }[], truncated: false };
    const ancestors = await db.csoFolder.findMany({ where: { id: { in: ids } } });
    const eff = await this.csoAccess.foldersAccess(ctx, ancestors, db);
    const byId = new Map(ancestors.map((a) => [a.id, a]));
    const items: { id: string; name: string }[] = [];
    let truncated = false;
    for (const aid of ids) {
      const a = byId.get(aid);
      if (a && this.csoAccess.folderVisible(a, eff.get(a.id)!)) items.push({ id: a.id, name: a.name });
      else truncated = true;
    }
    return { items, truncated };
  }

  async effectiveAccess(ctx: AuthContext, id: string) {
    const { folder, eff } = await this.csoAccess.assertFolder(ctx, id);
    return { folderId: folder.id, status: folder.status, actions: grantedActions(eff), map: eff };
  }

  /** Arbre visible sous un dossier (inclus). */
  async folderTree(ctx: AuthContext, id: string, q: TreeQuery) {
    const { folder } = await this.csoAccess.assertFolder(ctx, id);
    return this.buildTree(ctx, folder.libraryId, folder, q);
  }

  /** Arbre visible complet d'une bibliothèque. */
  async libraryTree(ctx: AuthContext, libraryId: string, q: TreeQuery) {
    const library = await this.csoAccess.getLibrary(ctx, libraryId);
    return this.buildTree(ctx, library.id, null, q);
  }

  private async buildTree(ctx: AuthContext, libraryId: string, root: CsoFolder | null, q: TreeQuery): Promise<TreeNode[]> {
    const rows = await this.prisma.csoFolder.findMany({
      where: { libraryId, ...(root ? { path: { startsWith: root.path } } : {}), ...this.statusFilter(ctx, q.includeArchived) },
      orderBy: [{ depth: 'asc' }, { name: 'asc' }],
    });
    const eff = await this.csoAccess.foldersAccess(ctx, rows);
    const nodes = new Map<string, TreeNode>();
    const roots: TreeNode[] = [];
    const baseDepth = root ? root.depth : 0;
    for (const f of rows) {
      const e = eff.get(f.id)!;
      if (!this.csoAccess.folderVisible(f, e)) continue;
      if (f.depth - baseDepth > q.maxDepth) continue;
      const node: TreeNode = { id: f.id, name: f.name, status: f.status, depth: f.depth, actions: grantedActions(e), children: [] };
      const isRoot = root ? f.id === root.id : f.parentId === null;
      if (isRoot) {
        roots.push(node);
        nodes.set(f.id, node);
        continue;
      }
      // Élagage : un dossier n'apparaît que sous un parent lui-même visible
      const parent = f.parentId ? nodes.get(f.parentId) : undefined;
      if (!parent) continue;
      parent.children.push(node);
      nodes.set(f.id, node);
    }
    return roots;
  }

  // ---------------------------------------------------------------------------
  // Création / renommage
  // ---------------------------------------------------------------------------

  private async assertNameAvailable(db: Db, libraryId: string, parentId: string | null, name: string, excludeId?: string) {
    const dup = await db.csoFolder.findFirst({
      where: {
        libraryId,
        parentId,
        status: 'ACTIVE',
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (dup) throw Errors.duplicate('Un dossier actif porte déjà ce nom à cet emplacement', { field: 'name' });
  }

  async create(ctx: AuthContext, dto: CreateFolderDto) {
    let library: CsoLibrary;
    let parent: CsoFolder | null = null;
    if (dto.parentId) {
      const p = await this.csoAccess.assertFolder(ctx, dto.parentId, ['folder_create'], { requireActive: true });
      parent = p.folder;
      library = p.library;
      if (dto.libraryId && dto.libraryId !== library.id) throw Errors.validation('Le dossier parent appartient à une autre bibliothèque');
    } else {
      library = await this.csoAccess.getLibrary(ctx, dto.libraryId!);
      this.access.assertCan(ctx, 'cso.folder.create');
    }
    await this.assertNameAvailable(this.prisma, library.id, parent?.id ?? null, dto.name);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const id = randomUUID();
        const folder = await tx.csoFolder.create({
          data: {
            id,
            libraryId: library.id,
            parentId: parent?.id ?? null,
            name: dto.name,
            path: `${parent?.path ?? '/'}${id}/`,
            depth: parent ? parent.depth + 1 : 0,
            createdById: ctx.userId,
          },
        });
        await this.audit.record(
          ctx,
          {
            action: 'cso.folder.created',
            module: 'cso',
            entityType: 'cso_folder',
            entityId: id,
            vesselId: library.vesselId,
            after: { name: folder.name, libraryId: library.id, parentId: folder.parentId },
          },
          tx,
        );
        const eff = (await this.csoAccess.foldersAccess(ctx, [folder], tx)).get(id)!;
        return presentFolder(folder, eff);
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.duplicate('Un dossier actif porte déjà ce nom à cet emplacement', { field: 'name' });
      throw e;
    }
  }

  async rename(ctx: AuthContext, id: string, dto: RenameFolderDto) {
    const { folder, library } = await this.csoAccess.assertFolder(ctx, id, ['folder_rename'], { requireActive: true });
    if (folder.name === dto.name) return presentFolder(folder);
    await this.assertNameAvailable(this.prisma, folder.libraryId, folder.parentId, dto.name, folder.id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const res = await tx.csoFolder.updateMany({
          where: { id, status: 'ACTIVE', ...(dto.expectedUpdatedAt ? { updatedAt: dto.expectedUpdatedAt } : {}) },
          data: { name: dto.name },
        });
        if (!res.count) throw Errors.staleVersion();
        await this.audit.record(
          ctx,
          {
            action: 'cso.folder.renamed',
            module: 'cso',
            entityType: 'cso_folder',
            entityId: id,
            vesselId: library.vesselId,
            before: { name: folder.name },
            after: { name: dto.name },
          },
          tx,
        );
        return presentFolder(await tx.csoFolder.findUniqueOrThrow({ where: { id } }));
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.duplicate('Un dossier actif porte déjà ce nom à cet emplacement', { field: 'name' });
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Déplacement (CSO-021, CDC §5.6)
  // ---------------------------------------------------------------------------

  /**
   * Déplacement d'un dossier : folder_move sur la source, folder_create sur la destination, scope
   * sur LES DEUX bibliothèques, et visibilité de tout le contenu déplacé (jamais de déplacement
   * d'éléments que l'utilisateur ne voit pas => aucun privilège implicite via la destination).
   * Chemins / profondeurs de TOUS les descendants recalculés par une seule requête SQL (préfixe).
   */
  async move(ctx: AuthContext, id: string, dto: MoveFolderDto) {
    const src = await this.csoAccess.assertFolder(ctx, id, ['folder_move'], { requireActive: true });
    const folder = src.folder;
    if (dto.expectedUpdatedAt && folder.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime()) throw Errors.staleVersion();

    let targetParent: CsoFolder | null = null;
    let targetLib: CsoLibrary;
    if (dto.targetParentId) {
      const t = await this.csoAccess.assertFolder(ctx, dto.targetParentId, ['folder_create'], { requireActive: true });
      targetParent = t.folder;
      targetLib = t.library;
      if (dto.targetLibraryId && dto.targetLibraryId !== targetLib.id) {
        throw Errors.validation('Le dossier cible appartient à une autre bibliothèque');
      }
      if (targetParent.path.startsWith(folder.path)) {
        throw Errors.business('Impossible de déplacer un dossier dans lui-même ou dans l’un de ses sous-dossiers');
      }
    } else {
      targetLib = await this.csoAccess.getLibrary(ctx, dto.targetLibraryId!);
      this.access.assertCan(ctx, 'cso.folder.create');
    }
    if ((targetParent?.id ?? null) === folder.parentId && targetLib.id === folder.libraryId) {
      throw Errors.business('Le dossier est déjà à cet emplacement');
    }
    const crossLibrary = targetLib.id !== folder.libraryId;

    // Tout le contenu déplacé doit être visible du demandeur (ACL « view »)
    const [descendants, docs] = await Promise.all([
      this.prisma.csoFolder.findMany({ where: { path: { startsWith: folder.path }, id: { not: folder.id } } }),
      this.prisma.csoDocument.findMany({ where: { folder: { path: { startsWith: folder.path } } } }),
    ]);
    const fEff = await this.csoAccess.foldersAccess(ctx, descendants);
    const { eff: dEff } = await this.csoAccess.documentsAccess(ctx, docs);
    if (!subtreeAllows([...descendants.map((d) => fEff.get(d.id)!), ...docs.map((d) => dEff.get(d.id)!)])) {
      throw Errors.aclDenied('Le dossier contient des éléments hors de vos droits : déplacement impossible');
    }
    if (crossLibrary) {
      const catIds = [...new Set(docs.map((d) => d.categoryId).filter((x): x is string => !!x))];
      const cats = await this.prisma.csoCategory.findMany({ where: { id: { in: catIds } } });
      for (const c of cats) this.workflow.assertCategoryCompatible(c, targetLib);
    }

    const oldPath = folder.path;
    const newPath = `${targetParent?.path ?? '/'}${folder.id}/`;
    const delta = (targetParent ? targetParent.depth + 1 : 0) - folder.depth;
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Verrouillage DANS la transaction : sous-arbre déplacé + dossier cible (anti-déplacements concurrents)
        const locked = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM cso_folders
           WHERE left(path, ${oldPath.length}::int) = ${oldPath}
              ${targetParent ? Prisma.sql`OR id = ${targetParent.id}::uuid` : Prisma.empty}
           ORDER BY id
             FOR UPDATE`;
        const stale = () => Errors.staleVersion('Arborescence modifiée entre-temps : recharger avant de déplacer');
        const cur = await tx.csoFolder.findUnique({ where: { id: folder.id } });
        if (
          !cur ||
          cur.status !== 'ACTIVE' ||
          cur.path !== oldPath ||
          cur.depth !== folder.depth ||
          cur.parentId !== folder.parentId ||
          cur.libraryId !== folder.libraryId
        ) {
          throw stale();
        }
        if (targetParent) {
          const tgt = await tx.csoFolder.findUnique({ where: { id: targetParent.id } });
          if (!tgt || tgt.status !== 'ACTIVE' || tgt.path !== targetParent.path || tgt.depth !== targetParent.depth || tgt.libraryId !== targetLib.id) {
            throw stale();
          }
          if (tgt.path.startsWith(oldPath)) throw Errors.business('Impossible de déplacer un dossier dans lui-même ou dans l’un de ses sous-dossiers');
        }
        // Le contenu verrouillé doit être exactement celui dont la visibilité a été contrôlée
        const subtreeCount = locked.filter((r) => r.id !== targetParent?.id).length;
        const docCount = await tx.csoDocument.count({ where: { folder: { path: { startsWith: oldPath } } } });
        if (subtreeCount !== descendants.length + 1 || docCount !== docs.length) throw stale();
        await this.assertNameAvailable(tx, targetLib.id, targetParent?.id ?? null, folder.name, folder.id);
        const moved = await tx.$executeRaw`
          UPDATE cso_folders
             SET path = ${newPath} || substr(path, ${oldPath.length + 1}::int),
                 depth = depth + ${delta}::int,
                 library_id = ${targetLib.id}::uuid,
                 updated_at = now()
           WHERE left(path, ${oldPath.length}::int) = ${oldPath}`;
        if (moved !== subtreeCount) throw stale();
        await tx.csoFolder.update({ where: { id: folder.id }, data: { parentId: targetParent?.id ?? null } });
        if (crossLibrary) {
          await tx.$executeRaw`
            UPDATE cso_documents
               SET library_id = ${targetLib.id}::uuid, vessel_id = ${targetLib.vesselId}::uuid, updated_at = now()
             WHERE folder_id IN (SELECT id FROM cso_folders WHERE left(path, ${newPath.length}::int) = ${newPath})`;
          await tx.$executeRaw`
            UPDATE files SET vessel_id = ${targetLib.vesselId}::uuid
             WHERE owner_type = ${OWNER_CSO_VERSION}
               AND owner_id IN (
                 SELECT v.id FROM cso_versions v
                   JOIN cso_documents d ON d.id = v.document_id
                   JOIN cso_folders f ON f.id = d.folder_id
                  WHERE left(f.path, ${newPath.length}::int) = ${newPath})`;
        }
        const before = { libraryId: folder.libraryId, parentId: folder.parentId, path: oldPath };
        const after = { libraryId: targetLib.id, parentId: targetParent?.id ?? null, path: newPath };
        const metadata = {
          foldersUpdated: moved,
          documents: docs.length,
          crossLibrary,
          fromVesselId: src.library.vesselId,
          toVesselId: targetLib.vesselId,
        };
        await this.audit.record(
          ctx,
          { action: 'cso.folder.moved', module: 'cso', entityType: 'cso_folder', entityId: folder.id, vesselId: src.library.vesselId, before, after, metadata },
          tx,
        );
        if (crossLibrary && targetLib.vesselId !== src.library.vesselId) {
          // Trace aussi côté navire de destination (audit filtré par scope navire)
          await this.audit.record(
            ctx,
            { action: 'cso.folder.moved_in', module: 'cso', entityType: 'cso_folder', entityId: folder.id, vesselId: targetLib.vesselId, before, after, metadata },
            tx,
          );
        }
        const updated = await tx.csoFolder.findUniqueOrThrow({ where: { id: folder.id } });
        return { ...presentFolder(updated), descendantsUpdated: moved - 1, documentsMoved: docs.length };
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.duplicate('Un dossier actif porte déjà ce nom à la destination', { field: 'name' });
      // Deux déplacements croisés verrouillent en sens inverse : PostgreSQL en interrompt un (40P01)
      if (/40P01|deadlock/i.test(String((e as Error)?.message ?? ''))) throw Errors.conflict('Déplacement concurrent en cours : réessayer');
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Archivage récursif / restauration complète ou sélective (CSO-019/020)
  // ---------------------------------------------------------------------------

  /**
   * Archivage récursif (CSO-019). Comme pour le déplacement, l'opération est refusée si un élément
   * concerné (sous-dossier actif ou document non archivé) est invisible ou non archivable par
   * l'utilisateur : jamais de dépublication / annulation d'approbation sur du contenu hors droits.
   * Les lignes du sous-arbre sont verrouillées dans la transaction (pas de mouvement concurrent).
   */
  async archive(ctx: AuthContext, id: string, dto: ArchiveDto) {
    const { folder, library } = await this.csoAccess.assertFolder(ctx, id, ['folder_archive'], { requireActive: true });
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        await tx.$queryRaw`SELECT id FROM cso_folders WHERE left(path, ${folder.path.length}::int) = ${folder.path} FOR UPDATE`;
        const current = await tx.csoFolder.findUnique({ where: { id: folder.id } });
        if (!current || current.path !== folder.path || current.status !== 'ACTIVE') throw Errors.staleVersion('Dossier modifié entre-temps : recharger');
        const subtree = await tx.csoFolder.findMany({ where: { path: { startsWith: folder.path } } });
        const activeFolders = subtree.filter((f) => f.status === 'ACTIVE');
        const docs = await tx.csoDocument.findMany({ where: { folderId: { in: subtree.map((f) => f.id) }, status: { not: 'ARCHIVED' } } });
        const fEff = await this.csoAccess.foldersAccess(ctx, activeFolders, tx);
        const { eff: dEff } = await this.csoAccess.documentsAccess(ctx, docs, tx);
        const items = [...activeFolders.map((f) => fEff.get(f.id)!), ...docs.map((d) => dEff.get(d.id)!)];
        if (!subtreeAllows(items, ['folder_archive'])) throw Errors.aclDenied('Le dossier contient des éléments hors de vos droits : archivage impossible');
        const toArchive = activeFolders.map((f) => f.id);
        await tx.csoFolder.updateMany({ where: { id: { in: toArchive } }, data: { status: 'ARCHIVED', archivedAt: now, archivedById: ctx.userId } });
        await this.workflow.archiveDocuments(ctx, docs, dto.reason, { cascadeFromFolderId: folder.id }, tx);
        await this.audit.record(
          ctx,
          {
            action: 'cso.folder.archived',
            module: 'cso',
            entityType: 'cso_folder',
            entityId: folder.id,
            vesselId: library.vesselId,
            before: { status: 'ACTIVE' },
            after: { status: 'ARCHIVED' },
            metadata: { reason: dto.reason, folderIds: toArchive, documentIds: docs.map((d) => d.id) },
          },
          tx,
        );
        return { id: folder.id, status: 'ARCHIVED', foldersArchived: toArchive.length, documentsArchived: docs.length };
      },
      { timeout: 60_000 },
    );
  }

  /**
   * Restauration complète (recursive) ou sélective (includeDocumentIds) : les éléments non choisis
   * restent archivés ; chaque document déjà approuvé repasse par une NOUVELLE approbation (version de
   * restauration PENDING_APPROVAL) avant toute republication, un document jamais approuvé revient en
   * brouillon (CSO-03).
   */
  async restore(ctx: AuthContext, id: string, dto: RestoreFolderDto) {
    const { folder, library } = await this.csoAccess.assertFolder(ctx, id, ['restore', 'view_archived']);
    if (folder.status !== 'ARCHIVED') throw Errors.invalidState('Dossier non archivé');
    if (folder.parentId) {
      const parent = await this.prisma.csoFolder.findUniqueOrThrow({ where: { id: folder.parentId }, select: { status: true } });
      if (parent.status !== 'ACTIVE') throw Errors.business('Restaurer d’abord le dossier parent');
    }

    // Dossiers restaurés : le dossier + (si récursif) les descendants archivés visibles dont le parent est restauré
    const subtree = dto.recursive
      ? await this.prisma.csoFolder.findMany({ where: { path: { startsWith: folder.path } }, orderBy: { depth: 'asc' } })
      : [folder];
    const fEff = await this.csoAccess.foldersAccess(ctx, subtree);
    const restored = new Set<string>([folder.id]);
    for (const f of subtree) {
      if (f.id === folder.id || f.status !== 'ARCHIVED' || !f.parentId || !restored.has(f.parentId)) continue;
      const e = fEff.get(f.id)!;
      if (e.view && e.view_archived && e.restore) restored.add(f.id);
    }

    const candidates = await this.prisma.csoDocument.findMany({ where: { folderId: { in: [...restored] }, status: 'ARCHIVED' } });
    const { eff: dEff } = await this.csoAccess.documentsAccess(ctx, candidates);
    // Déjà approuvés : nouvelle approbation ; jamais approuvés : retour en brouillon (CSO-03, audit #10)
    const modes = await this.workflow.restoreModes(candidates.map((d) => d.id), this.prisma);
    const eligible = candidates.filter((d) => {
      const e = dEff.get(d.id)!;
      return e.view && e.view_archived && e.restore && modes.has(d.id);
    });
    let selected = eligible;
    if (dto.includeDocumentIds) {
      const eligibleIds = new Set(eligible.map((d) => d.id));
      const invalid = dto.includeDocumentIds.filter((x) => !eligibleIds.has(x));
      if (invalid.length) throw Errors.validation('Documents non restaurables dans ce périmètre', { documentIds: invalid });
      const wanted = new Set(dto.includeDocumentIds);
      selected = eligible.filter((d) => wanted.has(d.id));
    }

    let results: { doc: CsoDocument; version: CsoVersion }[] = [];
    try {
      results = await this.prisma.$transaction(
        async (tx) => {
          await tx.csoFolder.updateMany({
            where: { id: { in: [...restored] }, status: 'ARCHIVED' },
            data: { status: 'ACTIVE', archivedAt: null, archivedById: null },
          });
          const res = await this.workflow.restoreDocuments(ctx, selected, dto.reason, { viaFolderId: folder.id }, tx);
          await this.audit.record(
            ctx,
            {
              action: 'cso.folder.restored',
              module: 'cso',
              entityType: 'cso_folder',
              entityId: folder.id,
              vesselId: library.vesselId,
              before: { status: 'ARCHIVED' },
              after: { status: 'ACTIVE' },
              metadata: {
                reason: dto.reason,
                recursive: dto.recursive,
                selective: !!dto.includeDocumentIds,
                folderIds: [...restored],
                documentIds: selected.map((d) => d.id),
              },
            },
            tx,
          );
          return res;
        },
        { timeout: 60_000 },
      );
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.duplicate('Un dossier actif porte déjà le même nom : renommer avant de restaurer');
      throw e;
    }
    for (const r of results) await this.workflow.notifyValidators(r.doc, r.version);
    const asDraft = results.filter((r) => r.version.status === 'DRAFT');
    return {
      id: folder.id,
      status: 'ACTIVE',
      foldersRestored: restored.size,
      documentsRestored: results.length,
      documentsRestoredAsDraft: asDraft.length,
      documentsLeftArchived: candidates.length - results.length,
      pendingApprovalVersionIds: results.filter((r) => r.version.status === 'PENDING_APPROVAL').map((r) => r.version.id),
      draftVersionIds: asDraft.map((r) => r.version.id),
    };
  }

  // ---------------------------------------------------------------------------
  // ACL dossier / document (CSO-003/004 — chaque changement audité)
  // ---------------------------------------------------------------------------

  async getAcl(ctx: AuthContext, kind: 'folder' | 'document', id: string) {
    let own: { id: string; principalType: PrincipalType; principalId: string; actions: string[]; effect: 'ALLOW' | 'DENY'; createdAt: Date }[];
    let inheritAcl: boolean;
    let startPath: string;
    let selfFolderId: string | null = null;
    if (kind === 'folder') {
      const { folder } = await this.csoAccess.assertFolder(ctx, id, ['acl_manage']);
      own = await this.prisma.csoAclEntry.findMany({ where: { folderId: id }, orderBy: { createdAt: 'asc' } });
      inheritAcl = folder.inheritAcl;
      startPath = folder.path;
      selfFolderId = folder.id;
    } else {
      const { doc, folder } = await this.csoAccess.assertDocument(ctx, id, ['acl_manage']);
      own = await this.prisma.csoAclEntry.findMany({ where: { documentId: id }, orderBy: { createdAt: 'asc' } });
      inheritAcl = doc.inheritAcl;
      startPath = folder.path;
    }

    // Entrées héritées : dossiers ancêtres jusqu'à la première rupture d'héritage
    const inherited: { folderId: string; folderName: string | null; inheritAcl: boolean; entries: typeof own }[] = [];
    if (inheritAcl) {
      const ids = pathIds(startPath).filter((x) => x !== selfFolderId).reverse();
      const folders = await this.prisma.csoFolder.findMany({ where: { id: { in: ids } }, include: { acl: true } });
      const fEff = await this.csoAccess.foldersAccess(ctx, folders);
      for (const fid of ids) {
        const f = folders.find((x) => x.id === fid);
        if (!f) break;
        const visible = this.csoAccess.folderVisible(f, fEff.get(f.id)!);
        inherited.push({ folderId: f.id, folderName: visible ? f.name : null, inheritAcl: f.inheritAcl, entries: f.acl });
        if (!f.inheritAcl) break;
      }
    }
    const label = await principalLabels(this.prisma, [...own, ...inherited.flatMap((i) => i.entries)]);
    const withLabel = (e: (typeof own)[number]) => ({
      id: e.id,
      principalType: e.principalType,
      principalId: e.principalId,
      principalLabel: label(e.principalType, e.principalId),
      actions: e.actions,
      effect: e.effect,
      createdAt: e.createdAt,
    });
    return {
      kind,
      id,
      inheritAcl,
      entries: own.map(withLabel),
      inherited: inherited.map((i) => ({ ...i, entries: i.entries.map(withLabel) })),
    };
  }

  /** Remplace les ACL propres + rupture d'héritage. Refuse une modification qui retirerait au gestionnaire son droit acl_manage. */
  async putAcl(ctx: AuthContext, kind: 'folder' | 'document', id: string, dto: PutAclDto) {
    let vesselId: string | null;
    if (kind === 'folder') vesselId = (await this.csoAccess.assertFolder(ctx, id, ['acl_manage'])).library.vesselId;
    else vesselId = (await this.csoAccess.assertDocument(ctx, id, ['acl_manage'])).doc.vesselId;

    // Fusion des doublons (même principal + même effet)
    const merged = new Map<string, { principalType: PrincipalType; principalId: string; effect: 'ALLOW' | 'DENY'; actions: Set<string> }>();
    for (const e of dto.entries) {
      const k = `${e.principalType}:${e.principalId}:${e.effect}`;
      const cur = merged.get(k) ?? { principalType: e.principalType, principalId: e.principalId, effect: e.effect, actions: new Set<string>() };
      e.actions.forEach((a) => cur.actions.add(a));
      merged.set(k, cur);
    }
    const entries = [...merged.values()].map((e) => ({ ...e, actions: [...e.actions].sort() }));
    if (breaksWithoutViewRule(dto.inheritAcl, entries)) {
      throw Errors.business(
        'Rupture d’héritage refusée : ajoutez au moins une règle « Autoriser » sur l’action Consulter. Sans elle, tout titulaire de la permission de consultation CSO verrait cet élément.',
        { field: 'entries' },
      );
    }
    await assertPrincipalsExist(this.prisma, entries);

    return this.prisma.$transaction(async (tx) => {
      const where = kind === 'folder' ? { folderId: id } : { documentId: id };
      const before = await tx.csoAclEntry.findMany({ where, select: { principalType: true, principalId: true, actions: true, effect: true } });
      const beforeInherit =
        kind === 'folder'
          ? (await tx.csoFolder.findUniqueOrThrow({ where: { id }, select: { inheritAcl: true } })).inheritAcl
          : (await tx.csoDocument.findUniqueOrThrow({ where: { id }, select: { inheritAcl: true } })).inheritAcl;
      await tx.csoAclEntry.deleteMany({ where });
      if (entries.length) {
        await tx.csoAclEntry.createMany({
          data: entries.map((e) => ({ ...where, principalType: e.principalType, principalId: e.principalId, actions: e.actions, effect: e.effect, createdById: ctx.userId })),
        });
      }
      if (kind === 'folder') await tx.csoFolder.update({ where: { id }, data: { inheritAcl: dto.inheritAcl } });
      else await tx.csoDocument.update({ where: { id }, data: { inheritAcl: dto.inheritAcl } });

      // Garde-fou anti-verrouillage : le gestionnaire doit conserver acl_manage
      try {
        if (kind === 'folder') await this.csoAccess.assertFolder(ctx, id, ['acl_manage'], {}, tx);
        else await this.csoAccess.assertDocument(ctx, id, ['acl_manage'], {}, tx);
      } catch {
        throw Errors.business('Modification refusée : elle vous retirerait le droit de gérer les accès de cet élément');
      }
      await this.audit.record(
        ctx,
        {
          action: 'cso.acl.updated',
          module: 'cso',
          entityType: kind === 'folder' ? 'cso_folder' : 'cso_document',
          entityId: id,
          vesselId,
          before: { inheritAcl: beforeInherit, entries: before },
          after: { inheritAcl: dto.inheritAcl, entries },
        },
        tx,
      );
      return { kind, id, inheritAcl: dto.inheritAcl, entries };
    });
  }

  // ---------------------------------------------------------------------------
  // Validateurs par dossier (CSO-006)
  // ---------------------------------------------------------------------------

  async getValidators(ctx: AuthContext, id: string) {
    const { folder } = await this.csoAccess.assertFolder(ctx, id);
    const own = await this.prisma.csoFolderValidator.findMany({ where: { folderId: id } });
    const effective = await this.csoAccess.validatorsFor(folder.path);
    const refs = [
      ...own.map((v) => ({ principalType: v.principalType, principalId: v.principalId })),
      ...(effective?.validators ?? []).map((v) => ({ principalType: v.type, principalId: v.id })),
    ];
    const label = await principalLabels(this.prisma, refs);
    return {
      folderId: id,
      validators: own.map((v) => ({ principalType: v.principalType, principalId: v.principalId, label: label(v.principalType, v.principalId) })),
      effective: effective
        ? {
            fromFolderId: effective.folderId,
            inherited: effective.folderId !== id,
            validators: effective.validators.map((v) => ({ principalType: v.type, principalId: v.id, label: label(v.type, v.id) })),
          }
        : null,
      /** Aucun validateur configuré dans la hiérarchie : tout titulaire de cso.approve (scope + ACL) est éligible */
      fallbackToApprovePermission: !effective,
    };
  }

  /**
   * Configuration des validateurs : réservée à l'administration CSO (cso.categories.manage — équivalent
   * « Super Admin » du CDC §5.3) + droit acl_manage sur le dossier. L'éligibilité réelle (cso.approve,
   * ACL approve, scope navire, pas d'auto-approbation) est revérifiée à chaque décision.
   */
  async putValidators(ctx: AuthContext, id: string, dto: PutValidatorsDto) {
    const { library } = await this.csoAccess.assertFolder(ctx, id, ['acl_manage'], { requireActive: true });
    const unique = [...new Map(dto.validators.map((v) => [`${v.principalType}:${v.principalId}`, v])).values()];
    await assertPrincipalsExist(this.prisma, unique);
    const warnings: string[] = [];
    for (const v of unique.filter((x) => x.principalType === 'USER')) {
      if (!(await this.access.userCan(v.principalId, 'cso.approve', library.vesselId))) {
        warnings.push(`Utilisateur ${v.principalId} sans permission cso.approve ou hors scope : non éligible en l'état`);
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.csoFolderValidator.findMany({ where: { folderId: id }, select: { principalType: true, principalId: true } });
      await tx.csoFolderValidator.deleteMany({ where: { folderId: id } });
      if (unique.length) await tx.csoFolderValidator.createMany({ data: unique.map((v) => ({ folderId: id, ...v })) });
      await this.audit.record(
        ctx,
        {
          action: 'cso.folder.validators_updated',
          module: 'cso',
          entityType: 'cso_folder',
          entityId: id,
          vesselId: library.vesselId,
          before: { validators: before },
          after: { validators: unique },
        },
        tx,
      );
      return { folderId: id, validators: unique, warnings };
    });
  }
}

