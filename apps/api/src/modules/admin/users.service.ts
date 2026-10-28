import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isKnownPermission } from '@amc/types';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { temporaryPassword } from '../../common/utils/crypto';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService, SUPER_ADMIN_ROLE_KEY } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { assertMemberVisible } from '../access/member-access';
import { AuditService } from '../audit/audit.service';
import { PasswordService } from '../auth/password.service';
import {
  CreateUserDto,
  ListUsersQuery,
  SetDepartmentsDto,
  SetVesselScopeDto,
  UpdateUserDto,
} from './admin.dto';

const USER_SELECT = {
  id: true,
  username: true,
  email: true,
  emailVerifiedAt: true,
  displayName: true,
  jobTitle: true,
  status: true,
  mustChangePassword: true,
  failedLogins: true,
  lockedAt: true,
  lastLoginAt: true,
  vesselScope: true,
  memberId: true,
  createdAt: true,
  updatedAt: true,
  deactivatedAt: true,
  roles: { select: { role: { select: { id: true, key: true, name: true } } } },
  departments: { select: { isPrimary: true, department: { select: { id: true, code: true, name: true, status: true } } } },
} satisfies Prisma.UserSelect;

type UserRow = Prisma.UserGetPayload<{ select: typeof USER_SELECT }>;

function present(u: UserRow) {
  return {
    ...u,
    locked: !!u.lockedAt,
    roles: u.roles.map((r) => r.role),
    departments: u.departments.map((d) => ({ ...d.department, isPrimary: d.isPrimary })),
  };
}

/**
 * Gestion des comptes (CDC §2.3). Toutes les attributions passent par les contrôles
 * de délégation : un administrateur délégué ne peut jamais accorder plus qu'il ne possède.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  async list(q: ListUsersQuery) {
    const where: Prisma.UserWhereInput = {
      AND: [
        q.search
          ? {
              OR: [
                { username: { contains: q.search.toLowerCase() } },
                { email: { contains: q.search.toLowerCase() } },
                { displayName: { contains: q.search, mode: 'insensitive' } },
              ],
            }
          : {},
        q.status === 'LOCKED' ? { lockedAt: { not: null } } : q.status ? { status: q.status } : {},
        q.roleId ? { roles: { some: { roleId: q.roleId } } } : {},
        q.departmentId ? { departments: { some: { departmentId: q.departmentId } } } : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, select: USER_SELECT, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], ...cursorArgs(q) }),
      this.prisma.user.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    return { ...page, items: page.items.map(present) };
  }

  async get(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        overrides: { select: { id: true, permissionKey: true, effect: true, reason: true, createdAt: true } },
        vesselAccess: { select: { vessel: { select: { id: true, code: true, name: true } } } },
        member: { select: { id: true, firstName: true, lastName: true, amcRef: true } },
        _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } },
      },
    });
    if (!user) throw Errors.notFound('Utilisateur');
    const eff = await this.access.computeEffectivePermissions(id);
    return {
      ...present(user),
      overrides: user.overrides,
      vessels: user.vesselAccess.map((a) => a.vessel),
      member: user.member,
      activeSessions: user._count.sessions,
      effectivePermissions: [...eff.permissions].sort(),
    };
  }

  /** Création avec mot de passe temporaire, retourné UNE seule fois (ADM-007). */
  async create(ctx: AuthContext, dto: CreateUserDto) {
    if (dto.memberId) {
      // Lier une fiche Member expose ses données personnelles au futur titulaire du compte
      this.access.assertCan(ctx, 'members.link_user');
      await assertMemberVisible(this.prisma, ctx, dto.memberId);
    }
    await this.assertRolesGrantable(ctx, dto.roleIds);
    this.assertOverridesGrantable(ctx, dto.overrides);
    this.access.assertCanGrantVessels(ctx, dto.vesselScope.mode, dto.vesselScope.vesselIds);
    const tempPassword = temporaryPassword();
    const passwordHash = await this.passwords.hash(tempPassword);
    const company = await this.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });

    const user = await this.prisma.$transaction(async (tx) => {
      if (dto.memberId) await this.assertMemberLinkable(tx, dto.memberId, null);
      const created = await tx.user.create({
        data: {
          companyId: company.id,
          username: dto.username,
          email: dto.email ?? null,
          emailVerifiedAt: dto.email && dto.emailVerified ? new Date() : null,
          displayName: dto.displayName,
          jobTitle: dto.jobTitle ?? null,
          passwordHash,
          mustChangePassword: true,
          vesselScope: dto.vesselScope.mode,
          memberId: dto.memberId ?? null,
          createdById: ctx.userId,
          roles: { create: dto.roleIds.map((roleId) => ({ roleId, assignedById: ctx.userId })) },
          overrides: {
            create: dto.overrides.map((o) => ({ ...o, createdById: ctx.userId })),
          },
          vesselAccess:
            dto.vesselScope.mode === 'SELECTED'
              ? { create: dto.vesselScope.vesselIds.map((vesselId) => ({ vesselId, grantedById: ctx.userId })) }
              : undefined,
        },
        select: USER_SELECT,
      });
      if (dto.departments) await this.writeDepartments(tx, created.id, dto.departments);
      await this.audit.record(
        ctx,
        {
          action: 'user.created',
          module: 'admin',
          entityType: 'user',
          entityId: created.id,
          after: { ...dto, temporaryPassword: undefined },
        },
        tx,
      );
      return created;
    });
    return { user: present(user), temporaryPassword: tempPassword };
  }

  async update(ctx: AuthContext, id: string, dto: UpdateUserDto) {
    const before = await this.loadManageable(ctx, id);
    const after = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id },
        data: {
          username: dto.username,
          email: dto.email === undefined ? undefined : dto.email,
          emailVerifiedAt:
            dto.email !== undefined && dto.email !== before.email
              ? dto.emailVerified ? new Date() : null
              : dto.emailVerified === undefined ? undefined : dto.emailVerified ? new Date() : null,
          displayName: dto.displayName,
          jobTitle: dto.jobTitle === undefined ? undefined : dto.jobTitle,
        },
        select: USER_SELECT,
      });
      await this.audit.record(
        ctx,
        {
          action: 'user.updated',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          before: { username: before.username, email: before.email, displayName: before.displayName, jobTitle: before.jobTitle },
          after: { username: updated.username, email: updated.email, displayName: updated.displayName, jobTitle: updated.jobTitle },
        },
        tx,
      );
      return updated;
    });
    return present(after);
  }

  /** Rôles cumulables (ADM-022) ; effet immédiat sur les sessions ouvertes (ADM-019). */
  async setRoles(ctx: AuthContext, id: string, roleIds: string[]) {
    const user = await this.loadManageable(ctx, id);
    const current = user.roles.map((r) => r.id);
    const added = roleIds.filter((r) => !current.includes(r));
    const removed = current.filter((r) => !roleIds.includes(r));
    await this.assertRolesGrantable(ctx, added);
    if (removed.length) await this.assertRolesGrantable(ctx, removed); // ne retire que ce qu'il pourrait accorder
    await this.prisma.$transaction(async (tx) => {
      if (removed.length) {
        const superRole = await tx.role.findUnique({ where: { key: SUPER_ADMIN_ROLE_KEY } });
        if (superRole && removed.includes(superRole.id)) await this.assertNotLastSuperAdmin(tx, id);
        await tx.userRole.deleteMany({ where: { userId: id, roleId: { in: removed } } });
      }
      if (added.length) {
        await tx.userRole.createMany({ data: added.map((roleId) => ({ userId: id, roleId, assignedById: ctx.userId })) });
      }
      await this.audit.record(
        ctx,
        { action: 'user.roles_changed', module: 'admin', entityType: 'user', entityId: id, before: { roleIds: current }, after: { roleIds }, metadata: { added, removed } },
        tx,
      );
    });
    return this.get(id);
  }

  /** Overrides individuels ALLOW/DENY (DENY prioritaire). Un DENY peut toujours être posé. */
  async setOverrides(ctx: AuthContext, id: string, overrides: { permissionKey: string; effect: 'ALLOW' | 'DENY'; reason?: string }[]) {
    await this.loadManageable(ctx, id);
    this.assertOverridesGrantable(ctx, overrides);
    if (id === ctx.userId && overrides.some((o) => o.effect === 'ALLOW')) {
      throw Errors.forbidden("Impossible de s'accorder à soi-même des permissions");
    }
    const before = await this.prisma.permissionOverride.findMany({ where: { userId: id } });
    await this.prisma.$transaction(async (tx) => {
      await tx.permissionOverride.deleteMany({ where: { userId: id } });
      if (overrides.length) {
        await tx.permissionOverride.createMany({
          data: overrides.map((o) => ({ userId: id, permissionKey: o.permissionKey, effect: o.effect, reason: o.reason ?? null, createdById: ctx.userId })),
        });
      }
      await this.audit.record(
        ctx,
        {
          action: 'user.overrides_changed',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          before: before.map((o) => ({ permissionKey: o.permissionKey, effect: o.effect })),
          after: overrides,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** ALL_FLEET (navires futurs inclus, ADM-003) ou liste explicite. */
  async setVesselScope(ctx: AuthContext, id: string, dto: SetVesselScopeDto) {
    const user = await this.loadManageable(ctx, id);
    this.access.assertCanGrantVessels(ctx, dto.mode, dto.vesselIds);
    const before = await this.prisma.userVesselAccess.findMany({ where: { userId: id }, select: { vesselId: true } });
    await this.prisma.$transaction(async (tx) => {
      if (dto.vesselIds.length) {
        const count = await tx.vessel.count({ where: { id: { in: dto.vesselIds } } });
        if (count !== new Set(dto.vesselIds).size) throw Errors.validation('Navire inconnu dans la sélection');
      }
      await tx.user.update({ where: { id }, data: { vesselScope: dto.mode } });
      await tx.userVesselAccess.deleteMany({ where: { userId: id } });
      if (dto.mode === 'SELECTED' && dto.vesselIds.length) {
        await tx.userVesselAccess.createMany({
          data: [...new Set(dto.vesselIds)].map((vesselId) => ({ userId: id, vesselId, grantedById: ctx.userId })),
        });
      }
      await this.audit.record(
        ctx,
        {
          action: 'user.vessel_scope_changed',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          before: { mode: user.vesselScope, vesselIds: before.map((b) => b.vesselId) },
          after: dto,
        },
        tx,
      );
    });
    return this.get(id);
  }

  async setDepartments(ctx: AuthContext, id: string, dto: SetDepartmentsDto) {
    const user = await this.loadManageable(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await this.writeDepartments(tx, id, dto);
      await this.audit.record(
        ctx,
        {
          action: 'user.departments_changed',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          before: user.departments.map((d) => ({ id: d.id, isPrimary: d.isPrimary })),
          after: dto,
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Désactivation immédiate : sessions révoquées, Member / documents / audit conservés (ADM-010). */
  async setActive(ctx: AuthContext, id: string, active: boolean, reason?: string) {
    if (id === ctx.userId) throw Errors.business('Impossible de modifier le statut de son propre compte');
    const user = await this.loadManageable(ctx, id);
    if (!active && user.roles.some((r) => r.key === SUPER_ADMIN_ROLE_KEY)) {
      await this.assertNotLastSuperAdmin(this.prisma, id);
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { status: active ? 'ACTIVE' : 'DEACTIVATED', deactivatedAt: active ? null : new Date() },
      });
      if (!active) {
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: new Date(), revokedById: ctx.userId, revokedReason: 'ACCOUNT_DEACTIVATED' },
        });
      }
      await this.audit.record(
        ctx,
        {
          action: active ? 'user.reactivated' : 'user.deactivated',
          module: 'admin',
          entityType: 'user',
          entityId: id,
          before: { status: user.status },
          after: { status: active ? 'ACTIVE' : 'DEACTIVATED' },
          metadata: { reason },
        },
        tx,
      );
    });
    return this.get(id);
  }

  /** Déverrouillage UNIQUEMENT avec nouveau mot de passe temporaire (ADM-015, CDC §2.5). */
  async unlock(ctx: AuthContext, id: string) {
    const user = await this.loadManageable(ctx, id);
    if (!user.lockedAt) throw Errors.business("Ce compte n'est pas verrouillé");
    return this.issueTemporaryPassword(ctx, id, 'user.unlocked_with_reset');
  }

  async resetPassword(ctx: AuthContext, id: string) {
    await this.loadManageable(ctx, id);
    return this.issueTemporaryPassword(ctx, id, 'user.password_reset_by_admin');
  }

  private async issueTemporaryPassword(ctx: AuthContext, id: string, action: string) {
    const tempPassword = temporaryPassword();
    const passwordHash = await this.passwords.hash(tempPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: { passwordHash, mustChangePassword: true, lockedAt: null, failedLogins: 0, passwordChangedAt: new Date() },
      });
      await tx.session.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: ctx.userId, revokedReason: 'PASSWORD_RESET_BY_ADMIN' },
      });
      await this.audit.record(ctx, { action, module: 'admin', entityType: 'user', entityId: id }, tx);
    });
    return { temporaryPassword: tempPassword, mustChangePassword: true };
  }

  async listSessions(id: string) {
    return this.prisma.session.findMany({
      where: { userId: id },
      orderBy: { lastSeenAt: 'desc' },
      take: 100,
      select: {
        id: true, deviceLabel: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true,
        expiresAt: true, revokedAt: true, revokedReason: true,
      },
    });
  }

  async revokeSession(ctx: AuthContext, userId: string, sessionId: string | 'all') {
    await this.loadManageable(ctx, userId);
    const res = await this.prisma.session.updateMany({
      where: { userId, revokedAt: null, ...(sessionId === 'all' ? {} : { id: sessionId }) },
      data: { revokedAt: new Date(), revokedById: ctx.userId, revokedReason: 'ADMIN_REVOKED' },
    });
    await this.audit.record(ctx, {
      action: 'user.sessions_revoked',
      module: 'admin',
      entityType: 'user',
      entityId: userId,
      metadata: { sessionId, count: res.count },
    });
    return { revoked: res.count };
  }

  /** Lien User <-> Member 1:1 facultatif, réaffectable, anti-doublon (ADM-030/031). */
  async linkMember(ctx: AuthContext, userId: string, memberId: string | null) {
    const user = await this.loadManageable(ctx, userId);
    if (memberId) await assertMemberVisible(this.prisma, ctx, memberId);
    await this.prisma.$transaction(async (tx) => {
      if (memberId) await this.assertMemberLinkable(tx, memberId, userId);
      await tx.user.update({ where: { id: userId }, data: { memberId } });
      await this.audit.record(
        ctx,
        { action: memberId ? 'user.member_linked' : 'user.member_unlinked', module: 'admin', entityType: 'user', entityId: userId, before: { memberId: user.memberId }, after: { memberId } },
        tx,
      );
    });
    return this.get(userId);
  }

  // ---------------------------------------------------------------------------

  /**
   * Un délégué ne peut agir (modifier, réinitialiser, désactiver…) que sur un compte dont les droits
   * effectifs et le périmètre navires sont inclus dans les siens : sinon une réinitialisation de mot de
   * passe lui donnerait accès à des droits qu'il ne possède pas (ADM-006).
   */
  private async loadManageable(ctx: AuthContext, id: string) {
    const user = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!user) throw Errors.notFound('Utilisateur');
    const p = present(user);
    if (ctx.isSuperAdmin && ctx.deniedPermissions.size === 0) return p;
    if (p.roles.some((r) => r.key === SUPER_ADMIN_ROLE_KEY)) {
      throw Errors.forbidden('Seul un Super Admin peut gérer un compte Super Admin');
    }
    if (id !== ctx.userId) {
      const eff = await this.access.computeEffectivePermissions(id);
      const beyond = [...eff.permissions].filter((k) => !ctx.permissions.has(k));
      if (beyond.length) {
        throw Errors.forbidden('Ce compte dispose de droits que vous ne possédez pas : seul un administrateur de niveau supérieur peut le gérer', {
          missing: beyond.slice(0, 20),
        });
      }
      const targetVessels = (await this.prisma.userVesselAccess.findMany({ where: { userId: id }, select: { vesselId: true } })).map((v) => v.vesselId);
      this.access.assertCanGrantVessels(ctx, p.vesselScope, targetVessels);
    }
    return p;
  }

  private async assertRolesGrantable(ctx: AuthContext, roleIds: string[]) {
    if (!roleIds.length) return;
    const roles = await this.prisma.role.findMany({ where: { id: { in: roleIds } }, select: { id: true } });
    if (roles.length !== new Set(roleIds).size) throw Errors.validation('Rôle inconnu');
    const { keys, superAdmin } = await this.access.permissionsOfRoles(roleIds);
    if (superAdmin && !ctx.isSuperAdmin) throw Errors.forbidden('Seul un Super Admin peut attribuer le rôle Super Admin');
    this.access.assertCanGrant(ctx, keys);
  }

  private assertOverridesGrantable(ctx: AuthContext, overrides: { permissionKey: string; effect: string }[]) {
    const unknown = overrides.filter((o) => !isKnownPermission(o.permissionKey));
    if (unknown.length) throw Errors.validation('Permission inconnue', { unknown: unknown.map((o) => o.permissionKey) });
    this.access.assertCanGrant(ctx, overrides.filter((o) => o.effect === 'ALLOW').map((o) => o.permissionKey));
  }

  private async assertNotLastSuperAdmin(db: Tx | PrismaService, userId: string) {
    const count = await db.userRole.count({
      where: { role: { key: SUPER_ADMIN_ROLE_KEY }, userId: { not: userId }, user: { status: 'ACTIVE' } },
    });
    if (count === 0) throw Errors.business('Impossible : dernier Super Admin actif');
  }

  private async assertMemberLinkable(tx: Tx, memberId: string, userId: string | null) {
    const member = await tx.member.findUnique({ where: { id: memberId }, select: { id: true, user: { select: { id: true } } } });
    if (!member) throw Errors.notFound('Member');
    if (member.user && member.user.id !== userId) {
      throw Errors.duplicate('Cette fiche Member est déjà liée à un autre compte', { userId: member.user.id });
    }
  }

  private async writeDepartments(tx: Tx, userId: string, dto: { primaryId?: string | null; secondaryIds: string[] }) {
    const wanted = new Set([...(dto.primaryId ? [dto.primaryId] : []), ...dto.secondaryIds]);
    const existing = await tx.departmentMembership.findMany({ where: { userId } });
    const newIds = [...wanted].filter((d) => !existing.some((e) => e.departmentId === d));
    if (newIds.length) {
      // Aucune nouvelle affectation vers un département inactif (ADM-028)
      const inactive = await tx.department.findMany({ where: { id: { in: newIds }, status: 'INACTIVE' }, select: { name: true } });
      if (inactive.length) throw Errors.business('Département inactif : nouvelle affectation impossible', { departments: inactive.map((d) => d.name) });
    }
    await tx.departmentMembership.deleteMany({ where: { userId, departmentId: { notIn: [...wanted] } } });
    await tx.departmentMembership.updateMany({ where: { userId }, data: { isPrimary: false } });
    for (const departmentId of wanted) {
      await tx.departmentMembership.upsert({
        where: { userId_departmentId: { userId, departmentId } },
        create: { userId, departmentId, isPrimary: departmentId === dto.primaryId },
        update: { isPrimary: departmentId === dto.primaryId },
      });
    }
  }
}
