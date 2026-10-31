import type { Me } from '@/lib/session';
import type { RoleDto } from '../types';

/**
 * Raison pour laquelle l'utilisateur courant ne peut ni attribuer ni retirer ce rôle (mêmes règles que
 * l'API : rôle Super Admin réservé aux Super Admins, délégation limitée aux droits détenus — ADM-16).
 */
export function roleGrantBlock(role: RoleDto, me: Me): string | null {
  if (role.key === 'SUPER_ADMIN') return me.isSuperAdmin ? null : 'Réservé aux Super Admins';
  const own = new Set(me.permissions);
  const missing = role.permissions.filter((p) => !own.has(p)).length;
  if (!missing) return null;
  return `Vous ne détenez pas ${missing} des droits de ce rôle : délégation impossible`;
}
