import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { RequireAnyPermission } from '../../common/decorators';
import { PrismaService } from '../../prisma/prisma.service';

const DirectoryQuery = z.object({
  type: z.enum(['USER', 'ROLE', 'DEPARTMENT']),
  search: z.string().trim().max(100).optional(),
});

/** Permissions qui nécessitent de désigner des personnes / rôles / départements (partage, ACL, validateurs). */
export const DIRECTORY_PERMISSIONS = [
  'users.view',
  'roles.view',
  'departments.view',
  'cso.share',
  'cso.folder.acl_manage',
  'cso.categories.manage',
  'certificates.types.manage',
  'notifications.rules.manage',
  // Achats : attribution d'un écart de réception, filtre par demandeur
  'variances.manage',
  'pr.approve',
] as const;

/**
 * Référentiels non sensibles (listes de choix) accessibles à tout utilisateur authentifié :
 * rangs de bord et départements actifs (identifiant + libellé uniquement, sans membres).
 */
@ApiTags('Référentiels')
@Controller('reference')
export class ReferenceController {
  constructor(private readonly prisma: PrismaService) {}

  @Get('ranks')
  ranks() {
    return this.prisma.rank.findMany({
      where: { isActive: true },
      orderBy: [{ crewDepartment: 'asc' }, { sortOrder: 'asc' }],
      select: { id: true, code: true, name: true, crewDepartment: true },
    });
  }

  @Get('departments')
  departments() {
    return this.prisma.department.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { name: 'asc' },
      select: { id: true, code: true, name: true },
    });
  }

  /**
   * Annuaire minimal pour désigner un destinataire de partage, une entrée d'ACL ou un validateur :
   * identifiant + libellé uniquement (ni e-mail, ni droits, ni périmètre). Réservé aux profils
   * qui doivent désigner des principaux (CSO, configuration des certificats, administration).
   */
  @Get('directory')
  @RequireAnyPermission(...DIRECTORY_PERMISSIONS)
  async directory(@Query() q: Record<string, unknown>) {
    const { type, search } = DirectoryQuery.parse(q);
    const contains = search ? { contains: search, mode: 'insensitive' as const } : undefined;
    if (type === 'USER') {
      const rows = await this.prisma.user.findMany({
        where: { status: 'ACTIVE', ...(contains ? { OR: [{ displayName: contains }, { username: contains }, { jobTitle: contains }] } : {}) },
        orderBy: { displayName: 'asc' },
        take: 25,
        select: { id: true, displayName: true, jobTitle: true },
      });
      return rows.map((u) => ({ id: u.id, label: u.jobTitle ? `${u.displayName} — ${u.jobTitle}` : u.displayName }));
    }
    if (type === 'ROLE') {
      const rows = await this.prisma.role.findMany({ where: contains ? { name: contains } : {}, orderBy: { name: 'asc' }, select: { id: true, name: true } });
      return rows.map((r) => ({ id: r.id, label: r.name }));
    }
    const rows = await this.prisma.department.findMany({
      where: { status: 'ACTIVE', ...(contains ? { name: contains } : {}) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, code: true },
    });
    return rows.map((d) => ({ id: d.id, label: `${d.name} (${d.code})` }));
  }
}
