import { Injectable } from '@nestjs/common';
import { MemberFieldDefinition, Prisma } from '@prisma/client';
import { PERMISSIONS } from '@amc/types';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CreateFieldDto, CreateSectionDto, UpdateFieldDto, UpdateSectionDto } from './member-fields.dto';
import { selectChoices } from './members.logic';

/** Clés de permission utilisables pour la visibilité / l'édition d'un champ : module Members uniquement (ADM-037). */
const MEMBER_PERMISSION_KEYS = new Set(PERMISSIONS.filter((p) => p.module === 'members').map((p) => p.key));

/**
 * Sections et champs personnalisés des fiches Members (ADM-036..039) : ordre d'affichage,
 * permissions de consultation / édition par champ, archivage / réactivation sans perte de valeurs
 * (jamais de suppression).
 */
@Injectable()
export class MemberFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Sections + champs (archivés seulement pour members.fields.manage). */
  async listSections(ctx: AuthContext, includeArchived: boolean) {
    const withArchived = includeArchived && can(ctx, 'members.fields.manage');
    const [sections, fields] = await Promise.all([
      this.prisma.memberFieldSection.findMany({
        where: withArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
      this.prisma.memberFieldDefinition.findMany({
        where: withArchived ? {} : { archivedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { _count: { select: { values: true } } },
      }),
    ]);
    const present = (f: (typeof fields)[number]) => {
      const { _count, ...rest } = f;
      return { ...rest, valuesCount: _count.values };
    };
    return {
      sections: sections.map((s) => ({ ...s, fields: fields.filter((f) => f.sectionId === s.id).map(present) })),
      unsectioned: fields.filter((f) => !f.sectionId || !sections.some((s) => s.id === f.sectionId)).map(present),
    };
  }

  async createSection(ctx: AuthContext, dto: CreateSectionDto) {
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.memberFieldSection.aggregate({ _max: { sortOrder: true } });
      const s = await tx.memberFieldSection.create({ data: { name: dto.name, sortOrder: dto.sortOrder ?? (max._max.sortOrder ?? -1) + 1 } });
      await this.audit.record(ctx, { action: 'member_field_section.created', module: 'members', entityType: 'member_field_section', entityId: s.id, after: s }, tx);
      return s;
    });
  }

  async updateSection(ctx: AuthContext, id: string, dto: UpdateSectionDto) {
    const before = await this.prisma.memberFieldSection.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Section');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.memberFieldSection.update({ where: { id }, data: dto });
      await this.audit.record(
        ctx,
        { action: 'member_field_section.updated', module: 'members', entityType: 'member_field_section', entityId: id, before: { name: before.name, sortOrder: before.sortOrder }, after: dto },
        tx,
      );
      return after;
    });
  }

  async reorderSections(ctx: AuthContext, ids: string[]) {
    const found = await this.prisma.memberFieldSection.count({ where: { id: { in: ids } } });
    if (found !== new Set(ids).size) throw Errors.validation('Section inconnue dans la liste');
    await this.prisma.$transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.memberFieldSection.update({ where: { id }, data: { sortOrder: i } });
      await this.audit.record(ctx, { action: 'member_field_section.reordered', module: 'members', entityType: 'member_field_section', after: { ids } }, tx);
    });
    return this.listSections(ctx, false);
  }

  /** Archiver une section masque ses champs ; les valeurs restent intactes (ADM-039). */
  async setSectionArchived(ctx: AuthContext, id: string, archived: boolean) {
    const s = await this.prisma.memberFieldSection.findUnique({ where: { id } });
    if (!s) throw Errors.notFound('Section');
    if (!!s.archivedAt === archived) throw Errors.alreadyProcessed(archived ? 'Section déjà archivée' : 'Section déjà active');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.memberFieldSection.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
      await this.audit.record(
        ctx,
        { action: archived ? 'member_field_section.archived' : 'member_field_section.reactivated', module: 'members', entityType: 'member_field_section', entityId: id },
        tx,
      );
      return after;
    });
  }

  async createField(ctx: AuthContext, dto: CreateFieldDto) {
    this.assertPermissionKeys(dto.viewPermission, dto.editPermission);
    if (dto.sectionId) await this.assertSection(dto.sectionId);
    const exists = await this.prisma.memberFieldDefinition.findUnique({ where: { key: dto.key }, select: { id: true, archivedAt: true } });
    if (exists) {
      throw Errors.duplicate(
        exists.archivedAt ? 'Clé déjà utilisée par un champ archivé : le réactiver plutôt que le recréer' : 'Clé de champ déjà utilisée',
        { key: dto.key, fieldId: exists.id },
      );
    }
    return this.prisma.$transaction(async (tx) => {
      const max = await tx.memberFieldDefinition.aggregate({ where: { sectionId: dto.sectionId ?? null }, _max: { sortOrder: true } });
      const f = await tx.memberFieldDefinition.create({
        data: {
          sectionId: dto.sectionId ?? null,
          key: dto.key,
          label: dto.label,
          type: dto.type,
          options: dto.options ? (dto.options as Prisma.InputJsonValue) : Prisma.JsonNull,
          required: dto.required,
          sortOrder: dto.sortOrder ?? (max._max.sortOrder ?? -1) + 1,
          viewPermission: dto.viewPermission ?? null,
          editPermission: dto.editPermission ?? null,
          selfEditable: dto.selfEditable,
        },
      });
      await this.audit.record(ctx, { action: 'member_field.created', module: 'members', entityType: 'member_field_definition', entityId: f.id, after: f }, tx);
      return f;
    });
  }

  async updateField(ctx: AuthContext, id: string, dto: UpdateFieldDto) {
    const before = await this.prisma.memberFieldDefinition.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Champ');
    this.assertPermissionKeys(dto.viewPermission, dto.editPermission);
    if (dto.sectionId) await this.assertSection(dto.sectionId);
    if (dto.options !== undefined) {
      if ((before.type === 'SELECT') !== !!dto.options) throw Errors.validation('options.choices requis pour SELECT uniquement');
      if (dto.options) await this.assertChoicesRemovable(before, dto.options.choices);
    }
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.memberFieldDefinition.update({
        where: { id },
        data: {
          ...dto,
          options: dto.options === undefined ? undefined : dto.options ? (dto.options as Prisma.InputJsonValue) : Prisma.JsonNull,
        },
      });
      await this.audit.record(
        ctx,
        { action: 'member_field.updated', module: 'members', entityType: 'member_field_definition', entityId: id, before, after },
        tx,
      );
      return after;
    });
  }

  /** Ordre des champs d'une section (ou des champs hors section si sectionId = null). */
  async reorderFields(ctx: AuthContext, sectionId: string | null, ids: string[]) {
    const found = await this.prisma.memberFieldDefinition.count({ where: { id: { in: ids }, sectionId } });
    if (found !== new Set(ids).size) throw Errors.validation('Champ inconnu ou hors de la section indiquée');
    await this.prisma.$transaction(async (tx) => {
      for (const [i, id] of ids.entries()) await tx.memberFieldDefinition.update({ where: { id }, data: { sortOrder: i } });
      await this.audit.record(ctx, { action: 'member_field.reordered', module: 'members', entityType: 'member_field_definition', after: { sectionId, ids } }, tx);
    });
    return this.listSections(ctx, false);
  }

  /** Archivage / réactivation : jamais de suppression, valeurs conservées et de nouveau visibles à la réactivation. */
  async setFieldArchived(ctx: AuthContext, id: string, archived: boolean) {
    const f = await this.prisma.memberFieldDefinition.findUnique({ where: { id }, include: { _count: { select: { values: true } } } });
    if (!f) throw Errors.notFound('Champ');
    if (!!f.archivedAt === archived) throw Errors.alreadyProcessed(archived ? 'Champ déjà archivé' : 'Champ déjà actif');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.memberFieldDefinition.update({ where: { id }, data: { archivedAt: archived ? new Date() : null } });
      await this.audit.record(
        ctx,
        {
          action: archived ? 'member_field.archived' : 'member_field.reactivated',
          module: 'members',
          entityType: 'member_field_definition',
          entityId: id,
          metadata: { key: f.key, preservedValues: f._count.values },
        },
        tx,
      );
      return after;
    });
  }

  private assertPermissionKeys(...keys: (string | null | undefined)[]) {
    const invalid = keys.filter((k): k is string => !!k && !MEMBER_PERMISSION_KEYS.has(k));
    if (invalid.length) {
      throw Errors.validation('Permission inconnue ou hors module Members', { invalid, allowed: [...MEMBER_PERMISSION_KEYS] });
    }
  }

  private async assertSection(id: string) {
    const s = await this.prisma.memberFieldSection.findUnique({ where: { id }, select: { archivedAt: true } });
    if (!s) throw Errors.notFound('Section');
    if (s.archivedAt) throw Errors.business('Section archivée : la réactiver avant d’y ajouter des champs');
  }

  /** Un choix utilisé par des valeurs existantes ne peut pas être retiré (valeurs préservées). */
  private async assertChoicesRemovable(def: MemberFieldDefinition, nextChoices: string[]) {
    const removed = selectChoices(def.options).choices.filter((c) => !nextChoices.includes(c));
    if (!removed.length) return;
    const values = await this.prisma.memberFieldValue.findMany({ where: { fieldId: def.id }, select: { value: true } });
    const used = removed.filter((c) => values.some((v) => v.value === c || (Array.isArray(v.value) && v.value.includes(c))));
    if (used.length) throw Errors.conflict('Choix encore utilisés par des fiches : retrait impossible', { choices: used });
  }
}
