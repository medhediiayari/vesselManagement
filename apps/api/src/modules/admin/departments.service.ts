import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors';
import { PrismaService, Tx } from '../../prisma/prisma.service';
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
    const department = await this.prisma.department.findUnique({ where: { id }, select: { id: true } });
    if (!department) throw Errors.notFound('Département');
    const rows = await this.prisma.departmentMembership.findMany({
      where: { departmentId: id },
      include: { user: { select: { id: true, displayName: true, username: true, status: true, jobTitle: true } } },
      orderBy: { user: { displayName: 'asc' } },
    });
    return rows.map((r) => ({ ...r.user, isPrimary: r.isPrimary }));
  }

  async create(ctx: AuthContext, dto: CreateDepartmentDto) {
    const deputyIds = [...new Set(dto.deputyIds)];
    return this.prisma.$transaction(async (tx) => {
      await this.assertActiveUsers(tx, [...(dto.primaryManagerId ? [dto.primaryManagerId] : []), ...deputyIds]);
      const d = await tx.department.create({
        data: {
          code: dto.code,
          name: dto.name,
          primaryManagerId: dto.primaryManagerId ?? null,
          deputies: { create: deputyIds.map((userId) => ({ userId })) },
        },
      });
      await this.audit.record(ctx, { action: 'department.created', module: 'admin', entityType: 'department', entityId: d.id, after: dto }, tx);
      return d;
    });
  }

  async update(ctx: AuthContext, id: string, dto: UpdateDepartmentDto) {
    const before = await this.prisma.department.findUnique({ where: { id }, include: { deputies: true } });
    if (!before) throw Errors.notFound('Département');
    const deputyIds = dto.deputyIds ? [...new Set(dto.deputyIds)] : undefined;
    return this.prisma.$transaction(async (tx) => {
      // Seules les nouvelles désignations sont contrôlées : un adjoint déjà en place reste modifiable
      const appointed = [
        ...(dto.primaryManagerId && dto.primaryManagerId !== before.primaryManagerId ? [dto.primaryManagerId] : []),
        ...(deputyIds ?? []).filter((u) => !before.deputies.some((x) => x.userId === u)),
      ];
      await this.assertActiveUsers(tx, appointed);
      const d = await tx.department.update({
        where: { id },
        data: { name: dto.name, primaryManagerId: dto.primaryManagerId === undefined ? undefined : dto.primaryManagerId },
      });
      if (deputyIds) {
        await tx.departmentDeputy.deleteMany({ where: { departmentId: id } });
        await tx.departmentDeputy.createMany({ data: deputyIds.map((userId) => ({ departmentId: id, userId })) });
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
    const status = active ? 'ACTIVE' : 'INACTIVE';
    // Opération sans effet : refusée, donc jamais journalisée (ADM-28)
    if (before.status === status) throw Errors.invalidState(active ? 'Ce département est déjà actif' : 'Ce département est déjà inactif');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.department.updateMany({ where: { id, status: before.status }, data: { status } });
      if (res.count === 0) throw Errors.alreadyProcessed('Le statut de ce département vient de changer : rechargez la page');
      const d = await tx.department.findUniqueOrThrow({ where: { id } });
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

  /** Responsable et adjoints : comptes existants et actifs uniquement (ADM-27, ADM-29). */
  private async assertActiveUsers(tx: Tx, userIds: string[]) {
    const ids = [...new Set(userIds)];
    if (!ids.length) return;
    const users = await tx.user.findMany({ where: { id: { in: ids } }, select: { id: true, displayName: true, status: true } });
    if (users.length !== ids.length) throw Errors.validation('Responsable ou adjoint : compte inconnu');
    const inactive = users.filter((u) => u.status !== 'ACTIVE');
    if (inactive.length) {
      throw Errors.validation('Responsable ou adjoint : seul un compte actif peut être désigné', {
        users: inactive.map((u) => u.displayName),
      });
    }
  }
}
