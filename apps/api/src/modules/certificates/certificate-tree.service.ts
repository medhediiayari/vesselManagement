import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CertificateAccessService } from './certificate-access.service';
import { DATA_REQUEST_KINDS, OPEN_REQUEST_STATUSES } from './certificate.logic';
import { CreateCategoryDto, CreateFolderDto, FileCertificatesDto, UpdateCategoryDto, UpdateFolderDto } from './certificates.dto';

const MODULE = 'certificates' as const;
/** Profondeur maximale de l'arborescence (racine = 0). */
export const MAX_FOLDER_DEPTH = 5;

interface FolderNode {
  id: string;
  parentId: string | null;
}

/** Identifiants du dossier et de tous ses descendants (table de petite taille, chargée entière). */
export function folderSubtree(folders: FolderNode[], rootId: string): string[] {
  const children = new Map<string, string[]>();
  for (const f of folders) {
    if (!f.parentId) continue;
    children.set(f.parentId, [...(children.get(f.parentId) ?? []), f.id]);
  }
  const out: string[] = [];
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (out.includes(id)) continue;
    out.push(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

function depthOf(folders: FolderNode[], id: string | null): number {
  const byId = new Map(folders.map((f) => [f.id, f]));
  let depth = -1;
  for (let cur = id ? byId.get(id) : undefined; cur && depth < 100; cur = cur.parentId ? byId.get(cur.parentId) : undefined) depth++;
  return depth;
}

/** Hauteur du sous-arbre (0 = dossier sans enfant). */
function heightOf(folders: FolderNode[], id: string): number {
  const kids = folders.filter((f) => f.parentId === id);
  return kids.length ? 1 + Math.max(...kids.map((k) => heightOf(folders, k.id))) : 0;
}

const sameName = (a: string, b: string) => a.localeCompare(b, 'fr', { sensitivity: 'base' }) === 0;

/** Nom de référence d'une catégorie saisie : celui déjà au référentiel à la casse / aux accents près (CRT-07). */
export function canonicalCategory(existing: string[], name: string): string {
  return existing.find((c) => sameName(c, name)) ?? name;
}

/**
 * Certificats comptés dans l'arborescence : mêmes règles que la liste par défaut (actifs, avec
 * révision courante ou demande de données ouverte — CRT-05).
 */
const LISTED_CERTIFICATE: Prisma.CertificateWhereInput = {
  archivedAt: null,
  OR: [
    { currentRevisionId: { not: null } },
    { requests: { some: { status: { in: [...OPEN_REQUEST_STATUSES] }, kind: { in: [...DATA_REQUEST_KINDS] } } } },
  ],
};

/**
 * Arborescence de l'explorateur Certificats : dossiers de classement hiérarchiques
 * (`certificates.folders.manage`) et référentiel des catégories (`certificates.categories.manage`).
 * Le classement est purement organisationnel : il n'ouvre ni ne restreint aucun droit (les
 * certificats restent filtrés par scope navire / ADM-070) et les compteurs ne portent que sur les
 * certificats visibles par l'appelant. Toute modification est auditée.
 */
@Injectable()
export class CertificateTreeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly certAccess: CertificateAccessService,
  ) {}

  // ---------------------------------------------------------------------------
  // Dossiers
  // ---------------------------------------------------------------------------

  async listFolders(ctx: AuthContext) {
    // Gestionnaires : nombre total de certificats classés (archivés et hors périmètre compris),
    // c'est-à-dire ceux qu'une suppression du dossier déplacerait (CRT-06)
    const manager = can(ctx, 'certificates.folders.manage');
    const [folders, counts, filed] = await Promise.all([
      this.prisma.certificateFolder.findMany({
        select: { id: true, parentId: true, name: true, sortOrder: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.certificate.groupBy({
        by: ['folderId'],
        where: { AND: [this.certAccess.visibleWhere(ctx), LISTED_CERTIFICATE, { folderId: { not: null } }] },
        _count: { _all: true },
      }),
      manager
        ? this.prisma.certificate.groupBy({ by: ['folderId'], where: { folderId: { not: null } }, _count: { _all: true } })
        : Promise.resolve([]),
    ]);
    const count = new Map(counts.map((c) => [c.folderId, c._count._all]));
    const filedCount = new Map(filed.map((c) => [c.folderId, c._count._all]));
    return folders.map((f) => ({
      ...f,
      certificateCount: count.get(f.id) ?? 0,
      filedCount: manager ? (filedCount.get(f.id) ?? 0) : null,
    }));
  }

  /** Identifiants à filtrer pour un dossier (sous-dossiers inclus) — 404 si inconnu. */
  async subtreeIds(folderId: string): Promise<string[]> {
    const folders = await this.prisma.certificateFolder.findMany({ select: { id: true, parentId: true } });
    if (!folders.some((f) => f.id === folderId)) throw Errors.notFound('Dossier');
    return folderSubtree(folders, folderId);
  }

  async createFolder(ctx: AuthContext, dto: CreateFolderDto) {
    return this.prisma.serializable(async (tx) => {
      const folders = await tx.certificateFolder.findMany({ select: { id: true, parentId: true, name: true } });
      const parentId = dto.parentId ?? null;
      if (parentId && !folders.some((f) => f.id === parentId)) throw Errors.notFound('Dossier parent');
      if (depthOf(folders, parentId) + 1 > MAX_FOLDER_DEPTH) {
        throw Errors.business(`Profondeur maximale atteinte (${MAX_FOLDER_DEPTH + 1} niveaux)`);
      }
      this.assertNameFree(folders, parentId, dto.name);
      const created = await tx.certificateFolder.create({
        data: { name: dto.name, parentId, createdById: ctx.userId, sortOrder: folders.filter((f) => f.parentId === parentId).length },
        select: { id: true, parentId: true, name: true, sortOrder: true },
      });
      await this.audit.record(
        ctx,
        { action: 'certificate_folder.created', module: MODULE, entityType: 'certificate_folder', entityId: created.id, after: { name: created.name, parentId } },
        tx,
      );
      return { ...created, certificateCount: 0 };
    });
  }

  async updateFolder(ctx: AuthContext, id: string, dto: UpdateFolderDto) {
    return this.prisma.serializable(async (tx) => {
      const folders = await tx.certificateFolder.findMany({ select: { id: true, parentId: true, name: true, sortOrder: true } });
      const before = folders.find((f) => f.id === id);
      if (!before) throw Errors.notFound('Dossier');
      const parentId = dto.parentId === undefined ? before.parentId : dto.parentId;
      const name = dto.name ?? before.name;
      if (parentId !== before.parentId) {
        if (parentId && !folders.some((f) => f.id === parentId)) throw Errors.notFound('Dossier parent');
        if (parentId && folderSubtree(folders, id).includes(parentId)) {
          throw Errors.business('Un dossier ne peut pas être déplacé dans lui-même ou dans un de ses sous-dossiers');
        }
        if (depthOf(folders, parentId) + 1 + heightOf(folders, id) > MAX_FOLDER_DEPTH) {
          throw Errors.business(`Profondeur maximale atteinte (${MAX_FOLDER_DEPTH + 1} niveaux)`);
        }
      }
      if (parentId !== before.parentId || name !== before.name) this.assertNameFree(folders, parentId, name, id);
      const after = await tx.certificateFolder.update({
        where: { id },
        data: { name, parentId, ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }) },
        select: { id: true, parentId: true, name: true, sortOrder: true },
      });
      await this.audit.record(
        ctx,
        {
          action: 'certificate_folder.updated',
          module: MODULE,
          entityType: 'certificate_folder',
          entityId: id,
          before: { name: before.name, parentId: before.parentId, sortOrder: before.sortOrder },
          after: { name: after.name, parentId: after.parentId, sortOrder: after.sortOrder },
        },
        tx,
      );
      return after;
    });
  }

  /**
   * Suppression d'un dossier sans sous-dossier : ses certificats (y compris hors du périmètre de
   * l'appelant, le classement étant global) remontent dans le dossier parent — jamais supprimés.
   */
  async deleteFolder(ctx: AuthContext, id: string) {
    return this.prisma.serializable(async (tx) => {
      const folder = await tx.certificateFolder.findUnique({ where: { id }, include: { _count: { select: { children: true } } } });
      if (!folder) throw Errors.notFound('Dossier');
      if (folder._count.children) throw Errors.business('Supprimez ou déplacez d’abord les sous-dossiers');
      const moved = await tx.certificate.updateMany({ where: { folderId: id }, data: { folderId: folder.parentId } });
      await tx.certificateFolder.delete({ where: { id } });
      await this.audit.record(
        ctx,
        {
          action: 'certificate_folder.deleted',
          module: MODULE,
          entityType: 'certificate_folder',
          entityId: id,
          before: { name: folder.name, parentId: folder.parentId },
          metadata: { movedCertificates: moved.count, movedTo: folder.parentId },
        },
        tx,
      );
      return { deleted: true, movedCertificates: moved.count, movedTo: folder.parentId };
    });
  }

  /** Classement de certificats visibles par l'appelant dans un dossier (null = non classé). */
  async fileCertificates(ctx: AuthContext, dto: FileCertificatesDto) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.folderId && !(await tx.certificateFolder.count({ where: { id: dto.folderId } }))) throw Errors.notFound('Dossier');
      const ids = [...new Set(dto.certificateIds)];
      const certs = await tx.certificate.findMany({
        where: { AND: [{ id: { in: ids } }, this.certAccess.visibleWhere(ctx)] },
        select: { id: true, folderId: true, vesselId: true },
      });
      if (certs.length !== ids.length) throw Errors.notFound('Certificat');
      const changed = certs.filter((c) => c.folderId !== dto.folderId);
      if (changed.length) {
        await tx.certificate.updateMany({ where: { id: { in: changed.map((c) => c.id) } }, data: { folderId: dto.folderId } });
      }
      for (const c of changed) {
        await this.audit.record(
          ctx,
          {
            action: 'certificate.filed',
            module: MODULE,
            entityType: 'certificate',
            entityId: c.id,
            vesselId: c.vesselId,
            before: { folderId: c.folderId },
            after: { folderId: dto.folderId },
          },
          tx,
        );
      }
      return { updated: changed.length };
    });
  }

  private assertNameFree(folders: { id: string; parentId: string | null; name: string }[], parentId: string | null, name: string, selfId?: string) {
    if (folders.some((f) => f.id !== selfId && f.parentId === parentId && sameName(f.name, name))) {
      throw Errors.duplicate(`Un dossier « ${name} » existe déjà à cet emplacement`, [{ path: 'name' }]);
    }
  }

  // ---------------------------------------------------------------------------
  // Catégories (référentiel de CertificateType.category)
  // ---------------------------------------------------------------------------

  async listCategories(ctx: AuthContext) {
    const [rows, types, counts] = await Promise.all([
      this.prisma.certificateCategory.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      this.prisma.certificateType.findMany({ select: { id: true, category: true, subjectKind: true } }),
      this.prisma.certificate.groupBy({
        by: ['typeId'],
        where: { AND: [this.certAccess.visibleWhere(ctx), LISTED_CERTIFICATE] },
        _count: { _all: true },
      }),
    ]);
    const categoryOfType = new Map(types.map((t) => [t.id, t.category]));
    const certCount = new Map<string, number>();
    for (const c of counts) {
      const cat = categoryOfType.get(c.typeId);
      if (cat) certCount.set(cat, (certCount.get(cat) ?? 0) + c._count._all);
    }
    const present = (name: string, id: string | null, sortOrder: number) => {
      const kinds = [...new Set(types.filter((t) => t.category === name).map((t) => t.subjectKind))];
      return { id, name, sortOrder, typeCount: types.filter((t) => t.category === name).length, subjectKinds: kinds, certificateCount: certCount.get(name) ?? 0 };
    };
    const known = new Set(rows.map((r) => r.name));
    // Catégorie portée par un type mais absente du référentiel (données antérieures) : affichée, non modifiable
    const orphans = [...new Set(types.map((t) => t.category))].filter((c) => !known.has(c)).sort((a, b) => a.localeCompare(b, 'fr'));
    return [...rows.map((r) => present(r.name, r.id, r.sortOrder)), ...orphans.map((name) => present(name, null, 100_000))];
  }

  async createCategory(ctx: AuthContext, dto: CreateCategoryDto) {
    return this.prisma.serializable(async (tx) => {
      await this.assertCategoryFree(tx, dto.name);
      const count = await tx.certificateCategory.count();
      const created = await tx.certificateCategory.create({ data: { name: dto.name, sortOrder: count, createdById: ctx.userId } });
      await this.audit.record(
        ctx,
        { action: 'certificate_category.created', module: MODULE, entityType: 'certificate_category', entityId: created.id, after: { name: created.name } },
        tx,
      );
      return created;
    });
  }

  /** Renommage propagé à tous les types de la catégorie (même transaction). */
  async updateCategory(ctx: AuthContext, id: string, dto: UpdateCategoryDto) {
    return this.prisma.serializable(async (tx) => {
      const before = await tx.certificateCategory.findUnique({ where: { id } });
      if (!before) throw Errors.notFound('Catégorie');
      const name = dto.name ?? before.name;
      let renamedTypes = 0;
      if (name !== before.name) {
        if (!sameName(name, before.name)) await this.assertCategoryFree(tx, name);
        renamedTypes = (await tx.certificateType.updateMany({ where: { category: before.name }, data: { category: name } })).count;
      }
      const after = await tx.certificateCategory.update({
        where: { id },
        data: { name, ...(dto.sortOrder === undefined ? {} : { sortOrder: dto.sortOrder }) },
      });
      await this.audit.record(
        ctx,
        {
          action: 'certificate_category.updated',
          module: MODULE,
          entityType: 'certificate_category',
          entityId: id,
          before: { name: before.name, sortOrder: before.sortOrder },
          after: { name: after.name, sortOrder: after.sortOrder },
          metadata: { renamedTypes },
        },
        tx,
      );
      return { ...after, renamedTypes };
    });
  }

  async deleteCategory(ctx: AuthContext, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const cat = await tx.certificateCategory.findUnique({ where: { id } });
      if (!cat) throw Errors.notFound('Catégorie');
      const used = await tx.certificateType.count({ where: { category: cat.name } });
      if (used) throw Errors.business(`Catégorie utilisée par ${used} type(s) de certificat : réaffectez-les d’abord (Configuration)`);
      await tx.certificateCategory.delete({ where: { id } });
      await this.audit.record(
        ctx,
        { action: 'certificate_category.deleted', module: MODULE, entityType: 'certificate_category', entityId: id, before: { name: cat.name } },
        tx,
      );
      return { deleted: true };
    });
  }

  /**
   * Enregistre au référentiel une catégorie saisie sur un type (création / modification de type) et
   * renvoie le nom à utiliser : une catégorie existante qui ne diffère que par la casse est reprise.
   */
  async ensureCategory(db: Db, name: string, userId: string): Promise<string> {
    const all = await db.certificateCategory.findMany({ select: { name: true } });
    const canonical = canonicalCategory(all.map((c) => c.name), name);
    if (!all.some((c) => c.name === canonical)) {
      await db.certificateCategory.create({ data: { name, createdById: userId, sortOrder: 100 } });
    }
    return canonical;
  }

  private async assertCategoryFree(db: Db, name: string) {
    const all = await db.certificateCategory.findMany({ select: { name: true } });
    if (all.some((c) => sameName(c.name, name))) throw Errors.duplicate(`La catégorie « ${name} » existe déjà`, [{ path: 'name' }]);
  }
}
