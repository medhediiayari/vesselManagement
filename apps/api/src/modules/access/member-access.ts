import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import type { Db } from '../../prisma/prisma.service';
import { AuthContext, can } from './auth-context';

/** Affectations qui rendent une fiche visible depuis un navire accessible (contexte courant, pas toute la carrière). */
export const VISIBLE_ASSIGNMENT_STATUSES = ['PLANNED', 'ONBOARD'] as const;

/**
 * ADM-070 — moindre privilège (CDC §2.5, §17) : une fiche Member est visible si
 *  - l'utilisateur possède `members.cross_vessel.view` (Crew/HR transversal), OU
 *  - la personne a une affectation PLANNED/ONBOARD sur un navire du scope de l'utilisateur, OU
 *  - la fiche est celle liée au compte de l'utilisateur lui-même.
 * L'historique d'affectation donne du contexte sans élargir les permissions.
 */
export function memberVisibilityWhere(ctx: AuthContext): Prisma.MemberWhereInput {
  if (can(ctx, 'members.cross_vessel.view')) return {};
  const vesselFilter: Prisma.CrewAssignmentWhereInput =
    ctx.vesselScope.mode === 'ALL_FLEET' ? {} : { vesselId: { in: ctx.vesselScope.vesselIds } };
  const ors: Prisma.MemberWhereInput[] = [
    { crewAssignments: { some: { ...vesselFilter, status: { in: [...VISIBLE_ASSIGNMENT_STATUSES] } } } },
  ];
  if (ctx.memberId) ors.push({ id: ctx.memberId });
  return { OR: ors };
}

export async function isMemberVisible(db: Db, ctx: AuthContext, memberId: string): Promise<boolean> {
  const count = await db.member.count({ where: { AND: [{ id: memberId }, memberVisibilityWhere(ctx)] } });
  return count > 0;
}

/** 404 si la fiche n'existe pas, 403 SCOPE_DENIED si elle est hors du périmètre ADM-070. */
export async function assertMemberVisible(db: Db, ctx: AuthContext, memberId: string): Promise<void> {
  const exists = await db.member.count({ where: { id: memberId } });
  if (!exists) throw Errors.notFound('Member');
  if (!(await isMemberVisible(db, ctx, memberId))) {
    throw Errors.scopeDenied('Fiche Member hors de votre périmètre (ADM-070)');
  }
}
