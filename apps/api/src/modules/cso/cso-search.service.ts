import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, accessibleVesselIds, can } from '../access/auth-context';
import { CsoAccessService } from './cso-access.service';
import { CsoFieldsService } from './cso-fields.service';
import { presentDocumentSummary, userLabels } from './cso-presenters';
import { escapeLike, pageOverVisible } from './cso-rules';
import type { SearchQuery } from './cso.dto';

/** Nombre maximal de candidats examinés par requête (le filtrage ACL se fait après la requête SQL). */
const MAX_SCAN = 5_000;

/**
 * Recherche documentaire CSO (CSO-013, CDC §5.4/§5.6) : FTS PostgreSQL sur la colonne générée
 * `search_tsv` (référence + titre + description) + correspondance partielle titre/référence +
 * filtres métadonnées, requête entièrement paramétrée ($queryRaw / Prisma.sql, aucune concaténation).
 * Les candidats sont filtrés par droits effectifs AVANT réponse : aucun titre, référence ou compteur
 * de document non autorisé n'est divulgué ; aucune valeur de champ personnalisé n'est renvoyée.
 */
@Injectable()
export class CsoSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly csoAccess: CsoAccessService,
    private readonly fields: CsoFieldsService,
  ) {}

  async search(ctx: AuthContext, q: SearchQuery) {
    const conditions: Prisma.Sql[] = [];

    // Scope navire (bibliothèque centrale = flotte entière)
    const ids = accessibleVesselIds(ctx);
    if (ids) conditions.push(Prisma.sql`(d.vessel_id IS NULL OR d.vessel_id = ANY(${ids}::uuid[]))`);
    if (q.vesselId) {
      this.access.assertVesselAccess(ctx, q.vesselId);
      conditions.push(Prisma.sql`d.vessel_id = ${q.vesselId}::uuid`);
    }
    if (q.libraryId) {
      await this.csoAccess.getLibrary(ctx, q.libraryId);
      conditions.push(Prisma.sql`d.library_id = ${q.libraryId}::uuid`);
    }
    if (q.folderId) {
      // Dossier + sous-dossiers (préfixe du chemin matérialisé)
      const { folder } = await this.csoAccess.assertFolder(ctx, q.folderId);
      conditions.push(Prisma.sql`left(f.path, ${folder.path.length}::int) = ${folder.path}`);
    }
    if (q.categoryId) conditions.push(Prisma.sql`d.category_id = ${q.categoryId}::uuid`);
    if (q.authorId) conditions.push(Prisma.sql`d.author_id = ${q.authorId}::uuid`);

    const archiveAllowed = can(ctx, 'cso.archive.view');
    if (q.status) {
      if (q.status === 'ARCHIVED' && !archiveAllowed) return { items: [], nextCursor: null };
      conditions.push(Prisma.sql`d.status = ${q.status}::"CsoDocumentStatus"`);
    } else if (!(q.includeArchived && archiveAllowed)) {
      conditions.push(Prisma.sql`d.status <> 'ARCHIVED'::"CsoDocumentStatus"`);
    }
    if (q.from) conditions.push(Prisma.sql`d.created_at >= ${q.from}`);
    if (q.to) conditions.push(Prisma.sql`d.created_at < ${new Date(q.to.getTime() + 86_400_000)}`);

    // Filtre sur un champ personnalisé : uniquement si le champ est consultable par l'utilisateur
    if (q.fieldId) {
      const field = await this.prisma.csoFieldDefinition.findUnique({ where: { id: q.fieldId }, include: { acl: true } });
      if (!field || !this.fields.canViewFieldGlobally(ctx, field)) throw Errors.aclDenied('Champ non consultable');
      if (!q.fieldValue) throw Errors.validation('fieldValue requis avec fieldId');
      const like = `%${escapeLike(q.fieldValue.toLowerCase())}%`;
      conditions.push(
        Prisma.sql`EXISTS (SELECT 1 FROM cso_field_values fv WHERE fv.document_id = d.id AND fv.field_id = ${q.fieldId}::uuid AND lower(fv.value #>> '{}') LIKE ${like})`,
      );
    }

    let rank = Prisma.sql`0::real`;
    if (q.q) {
      const like = `%${escapeLike(q.q.toLowerCase())}%`;
      conditions.push(
        Prisma.sql`(d.search_tsv @@ plainto_tsquery('simple', ${q.q}) OR lower(d.title) LIKE ${like} OR lower(coalesce(d.reference, '')) LIKE ${like})`,
      );
      rank = Prisma.sql`ts_rank(d.search_tsv, plainto_tsquery('simple', ${q.q}))`;
    }
    const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

    // Pagination sur le flux des SEULS documents autorisés (audit #22) : le curseur est le nombre de
    // résultats visibles déjà servis ; le flux est reparcouru depuis le début à chaque page, de sorte
    // qu'aucune valeur de curseur ne reflète le nombre de documents masqués. Parcours borné (MAX_SCAN).
    const skipVisible = q.cursor ? Number(q.cursor) : 0;
    const want = skipVisible + q.limit + 1;
    const batch = Math.max(q.limit * 3, 60);
    const accepted: { id: string; rank: number }[] = [];
    let offset = 0;
    while (accepted.length < want && offset < MAX_SCAN) {
      const rows = await this.prisma.$queryRaw<{ id: string; rank: number }[]>`
        SELECT d.id, ${rank} AS rank
          FROM cso_documents d
          JOIN cso_folders f ON f.id = d.folder_id
          ${where}
         ORDER BY rank DESC, d.updated_at DESC, d.id ASC
         LIMIT ${Math.min(batch, MAX_SCAN - offset)}::int OFFSET ${offset}::int`;
      if (!rows.length) break;
      const docs = await this.prisma.csoDocument.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
      const { visible } = await this.csoAccess.filterVisibleDocuments(ctx, docs);
      const ok = new Set(visible.map((d) => d.id));
      for (const r of rows) if (ok.has(r.id)) accepted.push({ id: r.id, rank: Number(r.rank) });
      offset += rows.length;
      if (rows.length < batch) break;
    }

    const page = pageOverVisible(accepted, skipVisible, q.limit);
    return { items: await this.present(ctx, page.items), nextCursor: page.nextCursor };
  }

  private async present(ctx: AuthContext, rows: { id: string; rank: number }[]) {
    if (!rows.length) return [];
    const docs = await this.prisma.csoDocument.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
    const { eff, viaShare } = await this.csoAccess.documentsAccess(ctx, docs);
    const [users, cats, libs, folders] = await Promise.all([
      userLabels(this.prisma, docs.map((d) => d.authorId)),
      this.prisma.csoCategory.findMany({ where: { id: { in: docs.map((d) => d.categoryId).filter((x): x is string => !!x) } }, select: { id: true, code: true, name: true } }),
      this.prisma.csoLibrary.findMany({ where: { id: { in: docs.map((d) => d.libraryId) } }, include: { vessel: { select: { id: true, code: true, name: true } } } }),
      this.prisma.csoFolder.findMany({ where: { id: { in: docs.map((d) => d.folderId) } } }),
    ]);
    const fEff = await this.csoAccess.foldersAccess(ctx, folders);
    return rows.map((r) => {
      const d = docs.find((x) => x.id === r.id)!;
      const lib = libs.find((l) => l.id === d.libraryId)!;
      const folder = folders.find((f) => f.id === d.folderId)!;
      const folderVisible = this.csoAccess.folderVisible(folder, fEff.get(folder.id)!);
      const summary = presentDocumentSummary(d, {
        eff: eff.get(d.id),
        users,
        category: cats.find((c) => c.id === d.categoryId) ?? null,
        viaShare: viaShare.has(d.id),
      });
      return {
        ...summary,
        description: d.description && d.description.length > 300 ? `${d.description.slice(0, 300)}…` : d.description,
        rank: r.rank,
        library: { id: lib.id, kind: lib.kind, name: lib.name, vessel: lib.vessel },
        // Le nom du dossier n'est donné que s'il est lui-même visible
        folder: folderVisible ? { id: folder.id, name: folder.name } : null,
      };
    });
  }
}
