import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';
import { containsText, escapeLike } from '../../common/utils/like';
import { memberVisibilityWhere } from '../access/member-access';
import { poOwnFilter, prOwnFilter } from '../purchasing/purchasing-core.service';

const LIMIT = 8;

/**
 * Recherche globale (topbar). Chaque catégorie n'est interrogée que si l'utilisateur possède
 * la permission correspondante, avec filtre de scope navire / ADM-070 dans la requête SQL :
 * aucun numéro de certificat ni document n'est exposé sans droit (CDC §4.6). Sans pr.view_all, seules
 * ses propres PR et les BC qui les servent sont cherchés (ADM-01). Jokers LIKE échappés (ADM-22).
 * Les documents CSO (ACL fine) ont leur propre recherche : /cso/search.
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(ctx: AuthContext, q: string) {
    const contains = containsText(q);
    const scopeIn = ctx.vesselScope.mode === 'ALL_FLEET' ? undefined : { in: ctx.vesselScope.vesselIds };
    const vw = scopeIn ? { vesselId: scopeIn } : {};
    const tasks: Record<string, Promise<unknown[]>> = {};

    if (can(ctx, 'vessels.view')) {
      tasks.vessels = this.prisma.vessel.findMany({
        where: { ...(scopeIn ? { id: scopeIn } : {}), OR: [{ name: contains }, { code: contains }, { imoNumber: { contains: escapeLike(q) } }, { callSign: contains }] },
        select: { id: true, code: true, name: true, imoNumber: true, status: true },
        take: LIMIT,
      });
    }
    if (can(ctx, 'members.view')) {
      // Chaque mot doit figurer dans l'un des champs : « Prénom Nom » ne renvoie plus tous les homonymes (ADM-23)
      const terms = q.split(/\s+/).filter(Boolean);
      tasks.members = this.prisma.member.findMany({
        where: {
          AND: [
            memberVisibilityWhere(ctx),
            { archivedAt: null },
            ...terms.map((t) => ({ OR: [{ amcRef: containsText(t) }, { lastName: containsText(t) }, { firstName: containsText(t) }] })),
          ],
        },
        select: { id: true, amcRef: true, firstName: true, lastName: true, rank: true, status: true },
        take: LIMIT,
      });
    }
    if (can(ctx, 'certificates.view')) {
      const branches: Prisma.CertificateWhereInput[] = [{ subjectKind: 'VESSEL', ...vw }];
      if (can(ctx, 'members.certificates.view')) branches.push({ subjectKind: 'MEMBER', member: memberVisibilityWhere(ctx) });
      tasks.certificates = this.prisma.certificate.findMany({
        where: { archivedAt: null, OR: branches, AND: [{ OR: [{ currentNumber: contains }, { type: { name: contains } }, { type: { code: contains } }] }] },
        select: {
          id: true,
          currentNumber: true,
          currentExpiryOn: true,
          currentExpiryKind: true,
          type: { select: { code: true, name: true } },
          vessel: { select: { name: true } },
          member: { select: { firstName: true, lastName: true } },
        },
        take: LIMIT,
      });
    }
    if (can(ctx, 'pr.view')) {
      tasks.purchaseRequests = this.prisma.purchaseRequest.findMany({
        where: { ...vw, ...prOwnFilter(ctx), OR: [{ number: contains }, { subject: contains }, { lines: { some: { designation: contains } } }] },
        select: { id: true, number: true, subject: true, status: true, vessel: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
      });
    }
    if (can(ctx, 'bc.view')) {
      tasks.purchaseOrders = this.prisma.purchaseOrder.findMany({
        where: { ...vw, ...poOwnFilter(ctx), OR: [{ number: contains }, { supplier: { name: contains } }] },
        select: { id: true, number: true, status: true, supplier: { select: { name: true } }, vessel: { select: { code: true } } },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
      });
    }
    if (can(ctx, 'voyages.view')) {
      tasks.voyages = this.prisma.voyage.findMany({
        where: { ...vw, OR: [{ reference: contains }, { charterer: contains }, { description: contains }, { ports: { some: { portName: contains } } }] },
        select: { id: true, reference: true, status: true, charterer: true, vessel: { select: { code: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
      });
    }
    if (can(ctx, 'suppliers.view')) {
      tasks.suppliers = this.prisma.supplier.findMany({
        where: { OR: [{ name: contains }, { code: contains }] },
        select: { id: true, code: true, name: true, isActive: true },
        take: LIMIT,
      });
    }

    const keys = Object.keys(tasks);
    const values = await Promise.all(Object.values(tasks));
    return Object.fromEntries(keys.map((k, i) => [k, values[i]]));
  }
}
