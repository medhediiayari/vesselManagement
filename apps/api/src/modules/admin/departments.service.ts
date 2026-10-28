import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { CreateDepartmentDto, UpdateDepartmentDto } from './admin.dto';

/**
 * Départements (ADM-024..029) : responsable principal + adjoints (droits propres, sans héritage
 * automatique) ; désactivation sans perte d'affectations, aucune nouvelle affectation pendant l'inactivité.
 */
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const rows = await this.prisma.department.findMany({
      orderBy: { name: 'asc' },
      include: {
        primaryManager: { select: { id: true, displayName: true } },
        deputies: { select: { user: { select: { id: true, displayName: true } } } },
        _count: { select: { memberships: true } },
      },
    });
    return rows.map((d) => ({
      id: d.id,
      code: d.code,
      name: d.name,
      status: d.status,
      primaryManager: d.primaryManager,
      deputies: d.deputies.map((x) => x.user),
      memberCount: d._count.memberships,
      updatedAt: d.updatedAt,
    }));
  }

  async members(id: string) {
    const rows = await this.prisma.departmentMembership.findMany({
      where: { departmentId: id },
      include: { user: { select: { id: true, displayName: true, username: true, status: true, jobTitle: true } } },
      orderBy: { user: { displayName: 'asc' } },
    });
    return rows.map((r) => ({ ...r.user, isPrimary: r.isPrimary }));
  }

  async create(ctx: AuthContext, dto: CreateDepartmentDto) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.department.create({
        data: {
          code: dto.code,
          name: dto.name,
          primaryManagerId: dto.primaryManagerId ?? null,
          deputies: { create: dto.deputyIds.map((userId) => ({ userId })) },
        },
      });
      await this.audit.record(ctx, { action: 'department.created', module: 'admin', entityType: 'department', entityId: d.id, after: dto }, tx);
      return d;
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDepartmentDto) {
    const before = await this.prisma.department.findUnique({ where: { id }, include: { deputies: true } });
    if (!before) throw Errors.notFound('Département');
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.department.update({
        where: { id },
        data: { name: dto.name, primaryManagerId: dto.primaryManagerId === undefined ? undefined : dto.primaryManagerId },
      });
      if (dto.deputyIds) {
        await tx.departmentDeputy.deleteMany({ where: { departmentId: id } });
        await tx.departmentDeputy.createMany({ data: dto.deputyIds.map((userId) => ({ departmentId: id, userId })) });
      }
      await this.audit.record(
        ctx,
        {
          action: 'department.updated',
          module: 'admin',
          entityType: 'department',
          entityId: id,
          before: { name: before.name, primaryManagerId: before.primaryManagerId, deputyIds: before.deputies.map((x) => x.userId) },
          after: dto,
        },
        tx,
      );
      return d;
    });
  }

  async setStatus(ctx: AuthContext, id: string, active: boolean) {
    const before = await this.prisma.department.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Département');
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.department.update({ where: { id }, data: { status: active ? 'ACTIVE' : 'INACTIVE' } });
      await this.audit.record(
        ctx,
        {
          action: active ? 'department.reactivated' : 'department.deactivated',
          module: 'admin',
          entityType: 'department',
          entityId: id,
          before: { status: before.status },
          after: { status: d.status },
        },
        tx,
      );
      return d;
    });
  }
}
