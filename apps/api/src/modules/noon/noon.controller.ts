import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  AcknowledgeNoonReportDto,
  AddNoonAttachmentDto,
  ArchiveNoonReportDto,
  CorrectNoonReportDto,
  CreateNoonReportDto,
  ListNoonReportsQuery,
  NoonPdfQuerySchema,
  RequestCorrectionDto,
  SubmitNoonReportDto,
  UpdateNoonReportDto,
} from './noon.dto';
import { NoonService } from './noon.service';

/**
 * Noon Reports (CDC §8, §11 « GET/POST /noon-reports ; POST /noon-reports/{id}/submit ») :
 * formulaire AMC en 7 sections, toujours rattaché à un navire et un voyage du périmètre.
 */
@ApiTags('Noon Reports')
@Controller('noon-reports')
export class NoonController {
  constructor(private readonly noon: NoonService) {}

  @Get()
  @RequirePermissions('noon.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListNoonReportsQuery) {
    return this.noon.list(ctx, q);
  }

  /** Brouillon (Captain ou délégation explicite noon.create). */
  @Post()
  @RequirePermissions('noon.view', 'noon.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateNoonReportDto) {
    return this.noon.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('noon.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.noon.get(ctx, id);
  }

  /** Autosave (DRAFT : noon.create ; CORRECTION_REQUESTED : noon.create ou noon.correct). */
  @Patch(':id')
  @RequirePermissions('noon.view')
  @RequireAnyPermission('noon.create', 'noon.correct')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateNoonReportDto) {
    return this.noon.update(ctx, id, dto);
  }

  @Post(':id/submit')
  @RequirePermissions('noon.view', 'noon.submit')
  submit(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitNoonReportDto) {
    return this.noon.submit(ctx, id, dto.expectedVersion);
  }

  @Post(':id/acknowledge')
  @RequirePermissions('noon.view', 'noon.approve')
  acknowledge(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AcknowledgeNoonReportDto) {
    return this.noon.acknowledge(ctx, id, dto);
  }

  @Post(':id/request-correction')
  @RequirePermissions('noon.view', 'noon.approve')
  requestCorrection(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RequestCorrectionDto) {
    return this.noon.requestCorrection(ctx, id, dto);
  }

  /** Correction tracée : nouvelle révision figée + PDF, l'originale reste intacte. */
  @Post(':id/correct')
  @RequirePermissions('noon.view', 'noon.correct')
  correct(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectNoonReportDto) {
    return this.noon.correct(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermissions('noon.view', 'noon.approve')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveNoonReportDto) {
    return this.noon.archive(ctx, id, dto);
  }

  @Get(':id/revisions')
  @RequirePermissions('noon.view')
  revisions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.noon.listRevisions(ctx, id);
  }

  /**
   * GET /noon-reports/:id/pdf?revision=n&mode=download|preview — lien signé éphémère.
   * Aperçu : noon.view ; téléchargement : noon.export (vérifié dans le service).
   */
  @Get(':id/pdf')
  @RequirePermissions('noon.view')
  pdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { revision, mode } = NoonPdfQuerySchema.parse(q ?? {});
    return this.noon.pdfLink(ctx, id, revision, mode);
  }

  /** Suppression d'un brouillon jamais soumis (aucune révision figée n'existe encore). */
  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('noon.view')
  @RequireAnyPermission('noon.create', 'noon.correct')
  discard(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.noon.discardDraft(ctx, id);
  }

  @Get(':id/attachments')
  @RequirePermissions('noon.view')
  attachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.noon.listAttachments(ctx, id);
  }

  @Post(':id/attachments')
  @RequirePermissions('noon.view')
  @RequireAnyPermission('noon.create', 'noon.correct')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddNoonAttachmentDto) {
    return this.noon.addAttachment(ctx, id, dto);
  }
}
