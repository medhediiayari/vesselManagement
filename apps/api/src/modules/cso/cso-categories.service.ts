import { Injectable } from '@nestjs/common';
import type { CsoCategory, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, accessibleVesselIds, can, canAccessVessel } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { CsoFieldsService } from './cso-fields.service';
import { assertPrincipalsExist, isUniqueViolation, principalLabels } from './cso-presenters';
import type {
  CreateCategoryDto,
  CreateFieldDto,
  ListCategoriesQuery,
  PutFieldAclDto,
  UpdateCategoryDto,
  UpdateFieldDto,
} from './cso.dto';

/**
 * Catégories documentaires, références et champs personnalisés (CSO-025..032).
 * Désactivation / réactivation sans perte ; un champ n'est jamais supprimé (archivage, CSO-030).
 */
@Injectable()
export class CsoCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly fields: CsoFieldsService,
  ) {}

  private scopeWhere(ctx: AuthContext, vesselId?: string): Prisma.CsoCategoryWhereInput {
    if (vesselId) {
      this.access.assertVesselAccess(ctx, vesselId);
      return { OR: [{ scope: 'FLEET' }, { scope: 'VESSEL', vesselId }] };
    }
    const ids = accessibleVesselIds(ctx);
    return { OR: [{ scope: 'FLEET' }, { scope: 'VESSEL', ...(ids ? { vesselId: { in: ids } } : {}) }] };
  }

  async list(ctx: AuthContext, q: ListCategoriesQuery) {
    const includeInactive = q.includeInactive && can(ctx, 'cso.categories.manage');
    const rows = await this.prisma.csoCategory.findMany({
      where: { AND: [this.scopeWhere(ctx, q.vesselId), includeInactive ? {} : { isActive: true }] },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { fields: { where: { archivedAt: null } } } } },
    });
    return rows.map(({ _count, ...c }) => ({ ...c, activeFieldCount: _count.fields }));
  }

  private async loadAccessible(ctx: AuthContext, id: string): Promise<CsoCategory> {
    const cat = await this.prisma.csoCategory.findUnique({ where: { id } });
    if (!cat) throw Errors.notFound('Catégorie');
    if (cat.scope === 'VESSEL' && !canAccessVessel(ctx, cat.vesselId)) throw Errors.scopeDenied();
    if (!cat.isActive && !can(ctx, 'cso.categories.manage')) throw Errors.notFound('Catégorie');
    return cat;
  }

  async get(ctx: AuthContext, id: string) {
    const cat = await this.loadAccessible(ctx, id);
    return { ...cat, fields: await this.listFields(ctx, id, can(ctx, 'cso.categories.manage')) };
  }

  async create(ctx: AuthContext, dto: CreateCategoryDto) {
    if (dto.scope === 'VESSEL') {
      this.access.assertVesselAccess(ctx, dto.vesselId);
      if (!(await this.prisma.vessel.count({ where: { id: dto.vesselId! } }))) throw Errors.notFound('Navire');
    }
    try {
      return await this.prisma.$transaction(async (tx) => {
        const cat = await tx.csoCategory.create({
          data: {
            code: dto.code,
            name: dto.name,
            scope: dto.scope,
            vesselId: dto.scope === 'VESSEL' ? dto.vesselId! : null,
            referenceMode: dto.referenceMode,
            referenceFormat: dto.referenceFormat ?? null,
            requiredFields: dto.requiredFields,
            sortOrder: dto.sortOrder,
          },
        });
        await this.audit.record(ctx, { action: 'cso.category.created', module: 'cso', entityType: 'cso_category', entityId: cat.id, vesselId: cat.vesselId, after: cat }, tx);
        return cat;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.duplicate('Code de catégorie déjà utilisé', { field: 'code' });
      throw e;
    }
  }

  /** Renommage, organisation, format / mode de référence, champs standards obligatoires (audités). */
  async update(ctx: AuthContext, id: string, dto: UpdateCategoryDto) {
    const before = await this.loadAccessible(ctx, id);
    const mode = dto.referenceMode ?? before.referenceMode;
    const format = dto.referenceFormat === undefined ? before.referenceFormat : dto.referenceFormat;
    if (mode === 'AUTO' && !format) throw Errors.validation('Format de référence requis en mode AUTO', { field: 'referenceFormat' });
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.csoCategory.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.referenceMode !== undefined ? { referenceMode: dto.referenceMode } : {}),
          ...(dto.referenceFormat !== undefined ? { referenceFormat: dto.referenceFormat } : {}),
          ...(dto.requiredFields !== undefined ? { requiredFields: dto.requiredFields } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
      await this.audit.record(
        ctx,
        { action: 'cso.category.updated', module: 'cso', entityType: 'cso_category', entityId: id, vesselId: after.vesselId, ...diffFields(before as never, after as never) },
        tx,
      );
      return after;
    });
  }

  /** Désactivation / réactivation sans perte : documents et valeurs conservés. */
  async setActive(ctx: AuthContext, id: string, active: boolean) {
    const before = await this.loadAccessible(ctx, id);
    if (before.isActive === active) return before;
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.csoCategory.update({ where: { id }, data: { isActive: active } });
      await this.audit.record(
        ctx,
        {
          action: active ? 'cso.category.reactivated' : 'cso.category.deactivated',
          module: 'cso',
          entityType: 'cso_category',
          entityId: id,
          vesselId: after.vesselId,
          before: { isActive: before.isActive },
          after: { isActive: active },
        },
        tx,
      );
      return after;
    });
  }

  // ---------------------------------------------------------------------------
  // Champs personnalisés
  // ---------------------------------------------------------------------------

  /** Définitions de champs : un champ confidentiel n'est listé qu'aux gestionnaires ou à ceux qui peuvent le voir. */
  async listFields(ctx: AuthContext, categoryId: string, includeArchived = false) {
    await this.loadAccessible(ctx, categoryId);
    const manage = can(ctx, 'cso.categories.manage');
    const rows = await this.fields.fieldsOfCategory(categoryId);
    return rows
      .filter((f) => (includeArchived && manage) || !f.archivedAt)
      .filter((f) => manage || this.fields.canViewFieldGlobally(ctx, f))
      .map(({ acl, ...f }) => ({ ...f, archived: !!f.archivedAt, aclEntryCount: manage ? acl.length : undefined }));
  }

  private async loadField(ctx: AuthContext, id: string) {
    const field = await this.prisma.csoFieldDefinition.findUnique({ where: { id } });
    if (!field) throw Errors.notFound('Champ');
    const cat = field.categoryId ? await this.loadAccessible(ctx, field.categoryId) : null;
    return { field, cat };
  }

  async createField(ctx: AuthContext, categoryId: string, dto: CreateFieldDto) {
    const cat = await this.loadAccessible(ctx, categoryId);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const field = await tx.csoFieldDefinition.create({
          data: {
            categoryId,
            key: dto.key,
            label: dto.label,
            type: dto.type,
            options: dto.type === 'SELECT' ? (dto.options ?? []) : undefined,
            required: dto.required,
            isConfidential: dto.isConfidential,
            sortOrder: dto.sortOrder,
          },
        });
        await this.audit.record(ctx, { action: 'cso.field.created', module: 'cso', entityType: 'cso_field', entityId: field.id, vesselId: cat.vesselId, after: field }, tx);
        return field;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.duplicate('Clé de champ déjà utilisée dans cette catégorie (champ archivé compris)', { field: 'key' });
      throw e;
    }
  }

  /** Le type et la clé sont figés (valeurs existantes préservées) ; options SELECT : ajout seulement. */
  async updateField(ctx: AuthContext, id: string, dto: UpdateFieldDto) {
    const { field, cat } = await this.loadField(ctx, id);
    if (dto.options && field.type !== 'SELECT') throw Errors.validation('Options réservées aux champs SELECT');
    if (dto.options && field.type === 'SELECT') {
      const current = Array.isArray(field.options) ? (field.options as unknown[]).map(String) : [];
      const removed = current.filter((o) => !dto.options!.includes(o));
      if (removed.length) {
        const used = await this.prisma.csoFieldValue.count({ where: { fieldId: id, OR: removed.map((o) => ({ value: { equals: o } })) } });
        if (used) throw Errors.business('Options utilisées par des documents : retrait impossible (valeurs préservées)', { options: removed });
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.csoFieldDefinition.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.options !== undefined ? { options: dto.options } : {}),
          ...(dto.required !== undefined ? { required: dto.required } : {}),
          ...(dto.isConfidential !== undefined ? { isConfidential: dto.isConfidential } : {}),
          ...(dto.sortOrder !== undefined ? { sortOrder: dto.sortOrder } : {}),
        },
      });
      await this.audit.record(
        ctx,
        { action: 'cso.field.updated', module: 'cso', entityType: 'cso_field', entityId: id, vesselId: cat?.vesselId ?? null, ...diffFields(field as never, after as never) },
        tx,
      );
      return after;
    });
  }

  /** Archivage / réactivation — jamais de suppression (CSO-030). */
  async setFieldArchived(ctx: AuthContext, id: string, archived: boolean) {
    const { field, cat } = await this.loadField(ctx, id);
    if (!!field.archivedAt === archived) return field;
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.csoFieldDefinition.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
      await this.audit.record(
        ctx,
        {
          action: archived ? 'cso.field.archived' : 'cso.field.reactivated',
          module: 'cso',
          entityType: 'cso_field',
          entityId: id,
          vesselId: cat?.vesselId ?? null,
          before: { archivedAt: field.archivedAt },
          after: { archivedAt: after.archivedAt },
        },
        tx,
      );
      return after;
    });
  }

  async getFieldAcl(ctx: AuthContext, id: string) {
    await this.loadField(ctx, id);
    const rows = await this.prisma.csoFieldAcl.findMany({ where: { fieldId: id } });
    const label = await principalLabels(this.prisma, rows);
    return rows.map((r) => ({ ...r, principalLabel: label(r.principalType, r.principalId) }));
  }

  /** Visibilité / édition par user / rôle / département (CSO-031/032) — remplacement complet, audité. */
  async putFieldAcl(ctx: AuthContext, id: string, dto: PutFieldAclDto) {
    const { cat } = await this.loadField(ctx, id);
    const unique = [...new Map(dto.entries.map((e) => [`${e.principalType}:${e.principalId}`, e])).values()];
    await assertPrincipalsExist(this.prisma, unique);
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.csoFieldAcl.findMany({ where: { fieldId: id }, select: { principalType: true, principalId: true, canView: true, canEdit: true } });
      await tx.csoFieldAcl.deleteMany({ where: { fieldId: id } });
      if (unique.length) {
        await tx.csoFieldAcl.createMany({
          data: unique.map((e) => ({ fieldId: id, principalType: e.principalType, principalId: e.principalId, canView: e.canView || e.canEdit, canEdit: e.canEdit })),
        });
      }
      await this.audit.record(
        ctx,
        { action: 'cso.field.acl_updated', module: 'cso', entityType: 'cso_field', entityId: id, vesselId: cat?.vesselId ?? null, before: { entries: before }, after: { entries: unique } },
        tx,
      );
      return tx.csoFieldAcl.findMany({ where: { fieldId: id } });
    });
  }
}
