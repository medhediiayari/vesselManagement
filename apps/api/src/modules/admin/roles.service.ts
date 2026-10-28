import { Injectable } from '@nestjs/common';
import { isKnownPermission } from '@amc/types';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CreateRoleDto, UpdateRoleDto } from './admin.dto';

/** Rôles prédéfinis personnalisables + rôles créés (ADM-020/021/023). */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
      include: { permissions: { select: { permissionKey: true } }, _count: { select: { users: true } } },
    });
    return roles.map((r) => ({
      id: r.id,
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      permissions: r.isSystem ? ['*'] : r.permissions.map((p) => p.permissionKey).sort(),
      userCount: r._count.users,
      updatedAt: r.updatedAt,
    }));
  }

  permissionsCatalog() {
    return this.prisma.permission.findMany({ orderBy: [{ module: 'asc' }, { key: 'asc' }] });
  }

  async create(ctx: AuthContext, dto: CreateRoleDto) {
    this.assertKnown(dto.permissions);
    this.access.assertCanGrant(ctx, dto.permissions);
    return this.prisma.$transaction(async (tx) => {
      const role = await tx.role.create({
        data: {
          key: dto.key,
          name: dto.name,
          description: dto.description ?? null,
          createdById: ctx.userId,
          permissions: { create: [...new Set(dto.permissions)].map((permissionKey) => ({ permissionKey })) },
        },
      });
      await this.audit.record(ctx, { action: 'role.created', module: 'admin', entityType: 'role', entityId: role.id, after: dto }, tx);
      return role;
    });
  }

  /** Modification propagée immédiatement aux titulaires ; overrides individuels préservés (ADM-021). */
  async update(ctx: AuthContext, id: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { permissions: true } });
    if (!role) throw Errors.notFound('Rôle');
    if (role.isSystem) throw Errors.forbidden('Rôle système protégé : non modifiable');
    const before = role.permissions.map((p) => p.permissionKey);
    if (dto.permissions) {
      this.assertKnown(dto.permissions);
      const added = dto.permissions.filter((p) => !before.includes(p));
      const removed = before.filter((p) => !dto.permissions!.includes(p));
      this.access.assertCanGrant(ctx, [...added, ...removed]);
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.role.update({
        where: { id },
        data: { name: dto.name, description: dto.description === undefined ? undefined : dto.description },
      });
      if (dto.permissions) {
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({ data: [...new Set(dto.permissions)].map((permissionKey) => ({ roleId: id, permissionKey })) });
      }
      await this.audit.record(
        ctx,
        {
          action: 'role.updated',
          module: 'admin',
          entityType: 'role',
          entityId: id,
          before: { name: role.name, description: role.description, permissions: before },
          after: { name: updated.name, description: updated.description, permissions: dto.permissions ?? before },
        },
        tx,
      );
      return updated;
    });
  }

  /** Suppression interdite si le rôle est encore attribué (ADM-023). */
  async remove(ctx: AuthContext, id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: { _count: { select: { users: true } }, permissions: true } });
    if (!role) throw Errors.notFound('Rôle');
    if (role.isSystem) throw Errors.forbidden('Rôle système protégé');
    if (role._count.users > 0) throw Errors.business(`Rôle encore attribué à ${role._count.users} utilisateur(s)`);
    this.access.assertCanGrant(ctx, role.permissions.map((p) => p.permissionKey));
    await this.prisma.$transaction(async (tx) => {
      await tx.role.delete({ where: { id } });
      await this.audit.record(
        ctx,
        { action: 'role.deleted', module: 'admin', entityType: 'role', entityId: id, before: { key: role.key, name: role.name } },
        tx,
      );
    });
  }

  private assertKnown(keys: string[]) {
    const unknown = keys.filter((k) => !isKnownPermission(k));
    if (unknown.length) throw Errors.validation('Permission inconnue', { unknown });
  }
}
