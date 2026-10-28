import { Injectable } from '@nestjs/common';
import { PERMISSION_KEYS } from '@amc/types';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { Errors } from '../../common/errors';
import { AuthContext, VesselScope, can, canAccessVessel } from './auth-context';

export const SUPER_ADMIN_ROLE_KEY = 'SUPER_ADMIN';

export interface EffectivePermissions {
  permissions: Set<string>;
  denied: Set<string>;
  isSuperAdmin: boolean;
  roleIds: string[];
  roleKeys: string[];
}

/**
 * Policy engine RBAC + vessel scope (CDC §2.1, §14.1 « écrire en premier »).
 * allowed = account_active ∧ session_active ∧ module_action_allowed(role_union + overrides)
 *           ∧ vessel_scope_allowed ∧ resource_acl_allowed ∧ field_acl_allowed ∧ workflow_condition_allowed
 * Les trois premiers termes sont évalués ici ; ACL ressource / champ et conditions de workflow
 * sont évalués par les services métier (CSO, certificats…).
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  /** Calcule les permissions effectives d'un utilisateur depuis la base (pas de cache). */
  async computeEffectivePermissions(userId: string, db: Db = this.prisma): Promise<EffectivePermissions> {
    const [userRoles, overrides] = await Promise.all([
      db.userRole.findMany({
        where: { userId },
        select: { role: { select: { id: true, key: true, permissions: { select: { permissionKey: true } } } } },
      }),
      db.permissionOverride.findMany({ where: { userId }, select: { permissionKey: true, effect: true } }),
    ]);

    const roleIds = userRoles.map((ur) => ur.role.id);
    const roleKeys = userRoles.map((ur) => ur.role.key);
    const isSuperAdmin = roleKeys.includes(SUPER_ADMIN_ROLE_KEY);

    const permissions = new Set<string>();
    if (isSuperAdmin) PERMISSION_KEYS.forEach((k) => permissions.add(k));
    for (const ur of userRoles) for (const rp of ur.role.permissions) permissions.add(rp.permissionKey);

    const denied = new Set<string>();
    for (const o of overrides) {
      if (o.effect === 'ALLOW') permissions.add(o.permissionKey);
    }
    // DENY > ALLOW > union des rôles (ADM-022) — appliqué en dernier
    for (const o of overrides) {
      if (o.effect === 'DENY') {
        permissions.delete(o.permissionKey);
        denied.add(o.permissionKey);
      }
    }
    return { permissions, denied, isSuperAdmin, roleIds, roleKeys };
  }

  async computeVesselScope(userId: string, mode: 'ALL_FLEET' | 'SELECTED', db: Db = this.prisma): Promise<VesselScope> {
    if (mode === 'ALL_FLEET') return { mode: 'ALL_FLEET' };
    const rows = await db.userVesselAccess.findMany({ where: { userId }, select: { vesselId: true } });
    return { mode: 'SELECTED', vesselIds: rows.map((r) => r.vesselId) };
  }

  /** Lève 403 FORBIDDEN si la permission manque. */
  assertCan(ctx: AuthContext, permission: string): void {
    if (!can(ctx, permission)) throw Errors.forbidden(`Permission requise : ${permission}`, { permission });
  }

  assertCanAll(ctx: AuthContext, permissions: string[]): void {
    for (const p of permissions) this.assertCan(ctx, p);
  }

  /** Lève 403 SCOPE_DENIED si le navire est hors périmètre (anti-IDOR cross-vessel). */
  assertVesselAccess(ctx: AuthContext, vesselId: string | null | undefined): void {
    if (!canAccessVessel(ctx, vesselId)) throw Errors.scopeDenied();
  }

  /**
   * Délégation administrative (ADM-005/006) : un administrateur ne peut accorder
   * que des permissions qu'il possède lui-même effectivement.
   */
  assertCanGrant(ctx: AuthContext, permissionKeys: Iterable<string>): void {
    if (ctx.isSuperAdmin && ctx.deniedPermissions.size === 0) return;
    const missing = [...permissionKeys].filter((k) => !ctx.permissions.has(k));
    if (missing.length) {
      throw Errors.forbidden('Délégation refusée : vous ne pouvez pas accorder des droits que vous ne possédez pas', {
        missing,
      });
    }
  }

  /** Un délégué ne peut accorder l'accès qu'aux navires de son propre périmètre. */
  assertCanGrantVessels(ctx: AuthContext, mode: 'ALL_FLEET' | 'SELECTED', vesselIds: string[]): void {
    if (ctx.vesselScope.mode === 'ALL_FLEET') return;
    if (mode === 'ALL_FLEET') {
      throw Errors.forbidden('Délégation refusée : vous ne disposez pas vous-même de « Toute la flotte »');
    }
    const own = new Set(ctx.vesselScope.vesselIds);
    const missing = vesselIds.filter((v) => !own.has(v));
    if (missing.length) throw Errors.forbidden('Délégation refusée : navires hors de votre périmètre', { missing });
  }

  /** Permissions (clés) d'un ensemble de rôles — sert à contrôler l'attribution d'un rôle. */
  async permissionsOfRoles(roleIds: string[], db: Db = this.prisma): Promise<{ keys: Set<string>; superAdmin: boolean }> {
    const roles = await db.role.findMany({
      where: { id: { in: roleIds } },
      select: { key: true, permissions: { select: { permissionKey: true } } },
    });
    const keys = new Set<string>();
    let superAdmin = false;
    for (const r of roles) {
      if (r.key === SUPER_ADMIN_ROLE_KEY) {
        superAdmin = true;
        PERMISSION_KEYS.forEach((k) => keys.add(k));
      }
      r.permissions.forEach((p) => keys.add(p.permissionKey));
    }
    return { keys, superAdmin };
  }

  /**
   * Utilisateurs actifs disposant d'une permission ET de l'accès à un navire
   * (sert au calcul des validateurs éligibles et des destinataires de notifications).
   */
  async usersWithPermission(
    permission: string,
    vesselId: string | null,
    db: Db = this.prisma,
    restrictToUserIds?: string[],
  ): Promise<string[]> {
    // Une seule requête (pas de N+1) : rôles, permissions de rôle, overrides et scopes.
    const users = await db.user.findMany({
      where: { status: 'ACTIVE', lockedAt: null, ...(restrictToUserIds ? { id: { in: restrictToUserIds } } : {}) },
      select: {
        id: true,
        vesselScope: true,
        vesselAccess: vesselId ? { where: { vesselId }, select: { vesselId: true } } : false,
        roles: { select: { role: { select: { key: true, permissions: { where: { permissionKey: permission }, select: { permissionKey: true } } } } } },
        overrides: { where: { permissionKey: permission }, select: { effect: true } },
      },
    });
    const result: string[] = [];
    for (const u of users) {
      if (vesselId && u.vesselScope !== 'ALL_FLEET' && !(u.vesselAccess ?? []).length) continue;
      if (u.overrides.some((o) => o.effect === 'DENY')) continue;
      const granted =
        u.overrides.some((o) => o.effect === 'ALLOW') ||
        u.roles.some((r) => r.role.key === SUPER_ADMIN_ROLE_KEY || r.role.permissions.length > 0);
      if (granted) result.push(u.id);
    }
    return result;
  }

  /** Vérifie pour un utilisateur donné (pas forcément l'appelant) permission + scope navire. */
  async userCan(userId: string, permission: string, vesselId: string | null, db: Db = this.prisma): Promise<boolean> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { status: true, lockedAt: true, vesselScope: true, vesselAccess: { select: { vesselId: true } } },
    });
    if (!user || user.status !== 'ACTIVE' || user.lockedAt) return false;
    if (vesselId && user.vesselScope !== 'ALL_FLEET' && !user.vesselAccess.some((a) => a.vesselId === vesselId)) {
      return false;
    }
    const eff = await this.computeEffectivePermissions(userId, db);
    return eff.permissions.has(permission);
  }
}
