import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  CancelImportDto,
  CreateImportJobDto,
  ListImportJobsQuery,
  ListImportRowsQuery,
  RowDecisionDto,
  SetImportMappingDto,
} from './members-import.dto';
import { MembersImportService } from './members-import.service';

/**
 * Import Excel Members (ADM-040..043, CDC V1 §5.3) — toutes les routes exigent members.import.
 * Parcours : POST (découverte) -> PUT mapping (prévisualisation) -> PATCH rows/:rowId (décisions)
 * -> POST commit (idempotent) -> GET report (XLSX).
 */
@ApiTags('Members — Excel import')
@Controller('members/import-jobs')
@RequirePermissions('members.import')
export class MembersImportController {
  constructor(private readonly imports: MembersImportService) {}

  /** Imports créés par l'utilisateur courant (un job n'est visible que de son créateur). */
  @Get()
  list(@Auth() ctx: AuthContext, @Query() q: ListImportJobsQuery) {
    return this.imports.listJobs(ctx, q);
  }

  /** Crée le job depuis un fichier IMPORT_SOURCE : feuilles, en-têtes détectés, mapping suggéré. */
  @Post()
  create(@Auth() ctx: AuthContext, @Body() dto: CreateImportJobDto) {
    return this.imports.createJob(ctx, dto);
  }

  @Get(':id')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.getJob(ctx, id);
  }

  /** Mapping par feuille -> normalisation + détection des doublons -> PREVIEW_READY. */
  @Put(':id/mapping')
  mapping(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetImportMappingDto) {
    return this.imports.setMapping(ctx, id, dto);
  }

  @Get(':id/rows')
  rows(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ListImportRowsQuery) {
    return this.imports.listRows(ctx, id, q);
  }

  @Get(':id/rows/:rowId')
  row(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('rowId', ParseUUIDPipe) rowId: string) {
    return this.imports.getRow(ctx, id, rowId);
  }

  /** Décision explicite par ligne : CREATE | UPDATE | IGNORE | CORRECT. */
  @Patch(':id/rows/:rowId')
  decide(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() dto: RowDecisionDto,
  ) {
    return this.imports.decideRow(ctx, id, rowId, dto);
  }

  @Post(':id/commit')
  commit(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.commit(ctx, id);
  }

  @Post(':id/cancel')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelImportDto) {
    return this.imports.cancel(ctx, id, dto.reason);
  }

  /** Rapport XLSX (lien signé éphémère, fichier EXPORT réservé au demandeur). */
  @Get(':id/report')
  report(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.imports.report(ctx, id);
  }
}
