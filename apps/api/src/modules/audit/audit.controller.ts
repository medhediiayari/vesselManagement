import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth } from '../../common/decorators';
import { Errors } from '../../common/errors';
import { PaginationSchema, cursorArgs, toPage } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';

/** Permission de lecture d'audit par module (ADM-012 : lecture par module ET scope navire). */
export const AUDIT_PERMISSION_BY_MODULE: Record<string, string> = {
  admin: 'audit.view.admin',
  auth: 'audit.view.admin',
  fleet: 'audit.view.fleet',
  members: 'audit.view.members',
  certificates: 'audit.view.certificates',
  cso: 'cso.audit.view',
  purchasing: 'audit.view.purchasing',
  voyages: 'audit.view.voyages',
  noon: 'audit.view.voyages',
  platform: 'audit.view.platform',
};

/** Modules dont les événements sans navire concernent des personnes (fiches, certificats Members). */
const PERSON_MODULES = ['members', 'certificates'];

/**
 * Filtre de périmètre des événements d'audit : navires du scope, et événements sans navire
 * sauf ceux portant sur des personnes, réservés à l'accès transversal Crew/HR (ADM-070).
 */
export function auditScopeWhere(ctx: AuthContext): Prisma.AuditEventWhereInput {
  const crossVessel = can(ctx, 'members.cross_vessel.view');
  const nullVessel: Prisma.AuditEventWhereInput = crossVessel
    ? { vesselId: null }
    : { vesselId: null, module: { notIn: PERSON_MODULES } };
  if (ctx.vesselScope.mode === 'ALL_FLEET') return { OR: [{ vesselId: { not: null } }, nullVessel] };
  return { OR: [{ vesselId: { in: ctx.vesselScope.vesselIds } }, nullVessel] };
}

const AuditQuerySchema = PaginationSchema.extend({
  module: z.string().max(40).optional(),
  entityType: z.string().max(60).optional(),
  entityId: z.string().max(64).optional(),
  vesselId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().max(100).optional(),
  result: z.enum(['SUCCESS', 'DENIED', 'FAILURE']).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
class AuditQuery extends createZodDto(AuditQuerySchema) {}

@ApiTags('Audit')
@Controller('audit')
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /audit — journal filtré par permissions de module ET scope navire. */
  @Get()
  async list(@Auth() ctx: AuthContext, @Query() q: AuditQuery) {
    const readableModules = Object.entries(AUDIT_PERMISSION_BY_MODULE)
      .filter(([, perm]) => can(ctx, perm))
      .map(([m]) => m);
    if (!readableModules.length) throw Errors.forbidden("Aucun droit de lecture d'audit");
    if (q.module && !readableModules.includes(q.module)) {
      throw Errors.forbidden(`Lecture de l'audit ${q.module} non autorisée`);
    }
    if (q.vesselId && ctx.vesselScope.mode === 'SELECTED' && !ctx.vesselScope.vesselIds.includes(q.vesselId)) {
      throw Errors.scopeDenied();
    }

    const scopeFilter = auditScopeWhere(ctx);

    const where: Prisma.AuditEventWhereInput = {
      AND: [
        { module: q.module ? q.module : { in: readableModules } },
        scopeFilter,
        q.entityType ? { entityType: q.entityType } : {},
        q.entityId ? { entityId: q.entityId } : {},
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.actorId ? { actorId: q.actorId } : {},
        q.action ? { action: { startsWith: q.action } } : {},
        q.result ? { result: q.result } : {},
        q.from || q.to ? { occurredAt: { gte: q.from, lte: q.to } } : {},
      ],
    };
    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(q),
    });
    return toPage(rows, q);
  }
}
