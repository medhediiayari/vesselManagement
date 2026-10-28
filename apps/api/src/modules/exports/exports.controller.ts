import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { ExportsService } from './exports.service';

const CreateExportSchema = z.object({
  resource: z.enum(['certificates', 'vessels', 'audit']),
  format: z.enum(['CSV', 'XLSX']).default('XLSX'),
  filters: z.record(z.string().max(200)).default({}),
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
