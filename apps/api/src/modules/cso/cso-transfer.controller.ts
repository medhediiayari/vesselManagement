import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CsoImportService } from './cso-import.service';
import { CsoZipService } from './cso-zip.service';
import { CreateImportJobDto, ImportDecisionsDto, ImportRowsQuery, ZipRequestDto } from './cso.dto';

@ApiTags('CSO — ZIP')
@Controller('cso/zip')
export class CsoZipController {
  constructor(private readonly zip: CsoZipService) {}

  /** Demande d'archive ZIP (asynchrone) — filtrage des droits PAR FICHIER à la génération (CSO-023). */
  @Post()
  @RequireAnyPermission('cso.download', 'cso.archive.download')
  request(@Auth() ctx: AuthContext, @Body() dto: ZipRequestDto) {
    return this.zip.request(ctx, dto);
  }

  @Get()
  @RequireAnyPermission('cso.download', 'cso.archive.download')
  mine(@Auth() ctx: AuthContext) {
    return this.zip.listMine(ctx);
  }

  /** Statut + lien signé éphémère quand l'archive est prête (demandeur uniquement). */
  @Get(':jobId')
  @RequireAnyPermission('cso.download', 'cso.archive.download')
  status(@Auth() ctx: AuthContext, @Param('jobId', ParseUUIDPipe) jobId: string) {
    return this.zip.status(ctx, jobId);
  }
}

@ApiTags('CSO — Import')
@Controller('cso/import-jobs')
export class CsoImportController {
  constructor(private readonly imports: CsoImportService) {}

  /** POST /cso/import-jobs — analyse ZIP / fichier + Excel -> prévisualisation et doublons (CSO-033). */
  @Post()
  @RequirePermissions('cso.import')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateImportJobDto) {
    return this.imports.create(ctx, dto);
  }

  @Get()
  @RequirePermissions('cso.import')
  list(@Auth() ctx: AuthContext) {
    return this.imports.list(ctx);
  }

  @Get(':id')
  @RequirePermissions('cso.import')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(ctx, id);
  }

  @Get(':id/rows')
  @RequirePermissions('cso.import')
  rows(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ImportRowsQuery) {
    return this.imports.rows(ctx, id, q);
  }

  /** Décisions opérateur : IGNORE | CREATE | CREATE_INDEPENDENT | SUBMIT_NEW_VERSION (CSO-034). */
  @Put(':id/decisions')
  @RequirePermissions('cso.import')
  decide(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ImportDecisionsDto) {
    return this.imports.decide(ctx, id, dto);
  }

  /** Application idempotente et reprenable ; aucune publication automatique. */
  @Post(':id/commit')
  @RequirePermissions('cso.import')
  commit(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.commit(ctx, id);
  }
}
