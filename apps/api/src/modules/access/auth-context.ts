/**
 * Contexte d'autorisation recalculé À CHAQUE REQUÊTE depuis la base (ADM-019, CDC §2.5) :
 * un changement de rôle, d'override ou de scope navire s'applique dès l'appel suivant,
 * même sur une session déjà ouverte.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  username: string;
  displayName: string;
  email: string | null;
  memberId: string | null;
  mustChangePassword: boolean;
  isSuperAdmin: boolean;
  roleIds: string[];
  roleKeys: string[];
  departmentIds: string[];
  /** Permissions effectives : union(rôles) + ALLOW - DENY (DENY prioritaire). */
  permissions: Set<string>;
  /** Permissions refusées explicitement (DENY) — utile pour la délégation (ADM-006). */
  deniedPermissions: Set<string>;
  vesselScope: VesselScope;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

export type VesselScope = { mode: 'ALL_FLEET' } | { mode: 'SELECTED'; vesselIds: string[] };

export function can(ctx: AuthContext, permission: string): boolean {
  return ctx.permissions.has(permission);
}

export function canAny(ctx: AuthContext, permissions: string[]): boolean {
  return permissions.some((p) => ctx.permissions.has(p));
}

export function canAccessVessel(ctx: AuthContext, vesselId: string | null | undefined): boolean {
  if (!vesselId) return false;
  if (ctx.vesselScope.mode === 'ALL_FLEET') return true;
  return ctx.vesselScope.vesselIds.includes(vesselId);
}

/**
 * Filtre Prisma à appliquer à toute requête sur une table portant `vessel_id`
 * (filtrage côté serveur, jamais côté UI). Retourne `{}` pour ALL_FLEET.
 */
export function vesselWhere(ctx: AuthContext, field = 'vesselId'): Record<string, unknown> {
  if (ctx.vesselScope.mode === 'ALL_FLEET') return {};
  return { [field]: { in: ctx.vesselScope.vesselIds } };
}

/** Liste des navires accessibles, ou null si toute la flotte. */
export function accessibleVesselIds(ctx: AuthContext): string[] | null {
  return ctx.vesselScope.mode === 'ALL_FLEET' ? null : ctx.vesselScope.vesselIds;
}

/** Principaux (user / rôles / départements) auxquels l'utilisateur appartient — pour ACL. */
export function principalsOf(ctx: AuthContext): { type: 'USER' | 'ROLE' | 'DEPARTMENT'; id: string }[] {
  return [
    { type: 'USER', id: ctx.userId },
    ...ctx.roleIds.map((id) => ({ type: 'ROLE' as const, id })),
    ...ctx.departmentIds.map((id) => ({ type: 'DEPARTMENT' as const, id })),
  ];
}
