/** Règles pures de l'administration des comptes (testées en unitaire). */

/** Droits qu'un administrateur ne peut pas se retirer lui-même : il ne pourrait plus les rétablir (ADM-05). */
export function isSelfLockoutPermission(key: string): boolean {
  return key === 'permissions.manage' || key.startsWith('users.') || key.startsWith('roles.');
}

/**
 * DENY d'administration nouvellement posés sur son propre compte. Un DENY déjà en base est toléré,
 * pour ne pas bloquer la modification des autres exceptions.
 */
export function selfLockoutDenies(
  wanted: { permissionKey: string; effect: 'ALLOW' | 'DENY' }[],
  existing: { permissionKey: string; effect: 'ALLOW' | 'DENY' }[],
): string[] {
  const kept = new Set(existing.filter((o) => o.effect === 'DENY').map((o) => o.permissionKey));
  return [
    ...new Set(
      wanted.filter((o) => o.effect === 'DENY' && isSelfLockoutPermission(o.permissionKey) && !kept.has(o.permissionKey)).map((o) => o.permissionKey),
    ),
  ];
}
