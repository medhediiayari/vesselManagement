import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { AUDIT_PERMISSION_BY_MODULE } from '../audit/audit.controller';
import { ExportsService } from './exports.service';

const dateFilter = z
  .string()
  .max(40)
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Date invalide (AAAA-MM-JJ)');

/** Filtres admis par ressource : une valeur invalide donne 422, jamais 500 (ADM-11). Clé inconnue refusée. */
const FILTER_SCHEMAS = {
  certificates: z
    .object({
      vesselId: z.string().uuid().optional(),
      subjectKind: z.enum(['VESSEL', 'MEMBER']).optional(),
      includeArchived: z.enum(['true', 'false']).optional(),
    })
    .strict(),
  vessels: z.object({}).strict(),
  audit: z
    .object({
      module: z
        .string()
        .max(40)
        .refine((m) => m in AUDIT_PERMISSION_BY_MODULE, 'Module inconnu')
        .optional(),
      action: z.string().max(100).optional(),
      from: dateFilter.optional(),
      to: dateFilter.optional(),
    })
    .strict(),
} as const;

export const CreateExportSchema = z
  .object({
    resource: z.enum(['certificates', 'vessels', 'audit']),
    format: z.enum(['CSV', 'XLSX']).default('XLSX'),
    filters: z.record(z.string().max(200)).default({}),
  })
  .superRefine((v, ctx) => {
    const res = FILTER_SCHEMAS[v.resource].safeParse(v.filters);
    if (res.success) return;
    for (const issue of res.error.issues) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', ...issue.path], message: issue.message });
    }
  });
class CreateExportDto extends createZodDto(CreateExportSchema) {}

@ApiTags('Exports')
@Controller('exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  /** POST /exports — génère un CSV/XLSX filtré par droits et scope ; retourne un lien signé. */
  @Post()
  @RequirePermissions('reports.export')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateExportDto) {
    return this.exportsService.create(ctx, dto.resource, dto.format, dto.filters);
  }

  @Get()
  @RequirePermissions('reports.export')
  list(@Auth() ctx: AuthContext) {
    return this.exportsService.list(ctx);
  }

  @Get(':id/download')
  @RequirePermissions('reports.export')
  download(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.exportsService.link(ctx, id);
  }
}
