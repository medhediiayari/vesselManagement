import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { VoyageOpsService } from './voyage-ops.service';
import {
  AddVoyageFileDto,
  ArchiveVoyageFileDto,
  CompleteTaskDto,
  CreateNoticeDto,
  CreateNorDto,
  CreateTaskDto,
  FileLinkQuerySchema,
  GenerateNoticeDraftDto,
  ListVoyageFilesSchema,
  MarkNoticeSentDto,
  ReasonDto,
  UpdateNoticeDto,
  UpdateNorDto,
  UpdateTaskDto,
} from './voyages.dto';

/**
 * Exécution d'un voyage (CDC §7.4) : tâches / checklist, notices & NOR, fichiers.
 * Les notices ne sont JAMAIS envoyées automatiquement : brouillon → validation → marquage manuel.
 */
@ApiTags('Voyages — Tasks, Notices, NOR, Files')
@Controller('voyages')
export class VoyageOpsController {
  constructor(private readonly ops: VoyageOpsService) {}

  // ----- Tâches / checklist

  @Get(':id/tasks')
  @RequirePermissions('voyages.view')
  tasks(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.listTasks(ctx, id);
  }

  @Post(':id/tasks')
  @RequirePermissions('voyages.edit')
  createTask(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateTaskDto) {
    return this.ops.createTask(ctx, id, dto);
  }

  @Patch(':id/tasks/:taskId')
  @RequirePermissions('voyages.edit')
  updateTask(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: UpdateTaskDto) {
    return this.ops.updateTask(ctx, id, taskId, dto);
  }

  /** Cocher : voyages.edit, Master (noon.submit) ou responsable désigné — contrôlé dans le service. */
  @Post(':id/tasks/:taskId/complete')
  @RequirePermissions('voyages.view')
  completeTask(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: CompleteTaskDto) {
    return this.ops.completeTask(ctx, id, taskId, dto);
  }

  @Post(':id/tasks/:taskId/reopen')
  @RequirePermissions('voyages.edit')
  reopenTask(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReasonDto) {
    return this.ops.reopenTask(ctx, id, taskId, dto.reason);
  }

  @Post(':id/tasks/:taskId/cancel')
  @RequirePermissions('voyages.edit')
  cancelTask(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('taskId', ParseUUIDPipe) taskId: string, @Body() dto: ReasonDto) {
    return this.ops.cancelTask(ctx, id, taskId, dto.reason);
  }

  // ----- Notices

  @Get(':id/notices')
  @RequirePermissions('voyages.view')
  notices(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.listNotices(ctx, id);
  }

  @Post(':id/notices')
  @RequirePermissions('voyages.edit')
  createNotice(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateNoticeDto) {
    return this.ops.createNotice(ctx, id, dto);
  }

  @Patch(':id/notices/:noticeId')
  @RequirePermissions('voyages.edit')
  updateNotice(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('noticeId', ParseUUIDPipe) noticeId: string, @Body() dto: UpdateNoticeDto) {
    return this.ops.updateNotice(ctx, id, noticeId, dto);
  }

  /** Génère le brouillon d'e-mail (texte à valider, aucun envoi). */
  @Post(':id/notices/:noticeId/draft')
  @RequirePermissions('voyages.edit')
  generateDraft(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('noticeId', ParseUUIDPipe) noticeId: string, @Body() dto: GenerateNoticeDraftDto) {
    return this.ops.generateDraft(ctx, id, noticeId, dto.overwrite);
  }

  /** Brouillon prêt à copier dans la messagerie (to / subject / body). */
  @Get(':id/notices/:noticeId/email')
  @RequirePermissions('voyages.view')
  email(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('noticeId', ParseUUIDPipe) noticeId: string) {
    return this.ops.emailDraft(ctx, id, noticeId);
  }

  @Post(':id/notices/:noticeId/validate')
  @RequirePermissions('voyages.edit')
  validateNotice(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('noticeId', ParseUUIDPipe) noticeId: string) {
    return this.ops.validateNotice(ctx, id, noticeId);
  }

  @Post(':id/notices/:noticeId/mark-sent')
  @RequirePermissions('voyages.edit')
  markSent(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('noticeId', ParseUUIDPipe) noticeId: string, @Body() dto: MarkNoticeSentDto) {
    return this.ops.markSent(ctx, id, noticeId, dto);
  }

  @Post(':id/notices/:noticeId/cancel')
  @RequirePermissions('voyages.edit')
  cancelNotice(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('noticeId', ParseUUIDPipe) noticeId: string, @Body() dto: ReasonDto) {
    return this.ops.cancelNotice(ctx, id, noticeId, dto.reason);
  }

  // ----- NOR (enregistrées par les services terre ou le Master)

  @Get(':id/nor')
  @RequirePermissions('voyages.view')
  nor(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.ops.listNor(ctx, id);
  }

  @Post(':id/nor')
  @RequirePermissions('voyages.view')
  @RequireAnyPermission('voyages.edit', 'noon.submit')
  createNor(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateNorDto) {
    return this.ops.createNor(ctx, id, dto);
  }

  @Patch(':id/nor/:norId')
  @RequirePermissions('voyages.view')
  @RequireAnyPermission('voyages.edit', 'noon.submit')
  updateNor(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('norId', ParseUUIDPipe) norId: string, @Body() dto: UpdateNorDto) {
    return this.ops.updateNor(ctx, id, norId, dto);
  }

  @Get(':id/nor/:norId/file')
  @RequirePermissions('voyages.view')
  norFile(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('norId', ParseUUIDPipe) norId: string, @Query() q: unknown) {
    const { mode } = FileLinkQuerySchema.parse(q ?? {});
    return this.ops.norFileLink(ctx, id, norId, mode);
  }

  // ----- Fichiers

  @Get(':id/files')
  @RequirePermissions('voyages.view')
  files(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown) {
    const { archived } = ListVoyageFilesSchema.parse(q ?? {});
    return this.ops.listFiles(ctx, id, !!archived);
  }

  @Post(':id/files')
  @RequirePermissions('voyages.edit')
  addFile(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddVoyageFileDto) {
    return this.ops.addFile(ctx, id, dto);
  }

  @Post(':id/files/:fileRowId/archive')
  @RequirePermissions('voyages.edit')
  archiveFile(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('fileRowId', ParseUUIDPipe) fileRowId: string, @Body() dto: ArchiveVoyageFileDto) {
    return this.ops.setFileArchived(ctx, id, fileRowId, true, dto.reason);
  }

  @Post(':id/files/:fileRowId/unarchive')
  @RequirePermissions('voyages.edit')
  unarchiveFile(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('fileRowId', ParseUUIDPipe) fileRowId: string, @Body() dto: ArchiveVoyageFileDto) {
    return this.ops.setFileArchived(ctx, id, fileRowId, false, dto.reason);
  }
}
