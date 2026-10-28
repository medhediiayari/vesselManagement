import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { queryBool } from '../../common/pagination';
import type { AuthContext } from '../access/auth-context';
import {
  AddVesselAttachmentDto,
  CreateVesselDto,
  ListVesselsQuery,
  SetPhotoDto,
  SetVesselStatusDto,
  UpdateVesselDto,
} from './vessels.dto';
import { VesselsService } from './vessels.service';

@ApiTags('Fleet — Vessels')
@Controller('vessels')
export class VesselsController {
  constructor(private readonly vessels: VesselsService) {}

  @Get()
  @RequirePermissions('vessels.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListVesselsQuery) {
    return this.vessels.list(ctx, q);
  }

  @Post()
  @RequirePermissions('vessels.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateVesselDto) {
    return this.vessels.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('vessels.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vessels.get(ctx, id);
  }

  /** GET /vessels/{id}/workspace — synthèse des onglets autorisés */
  @Get(':id/workspace')
  @RequirePermissions('vessels.view')
  workspace(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vessels.workspace(ctx, id);
  }

  @Get(':id/history')
  @RequirePermissions('vessels.view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.vessels.history(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('vessels.edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVesselDto) {
    return this.vessels.update(ctx, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions('vessels.edit')
  status(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetVesselStatusDto) {
    return this.vessels.setStatus(ctx, id, dto.status, dto.reason);
  }

  @Put(':id/photo')
  @RequireAnyPermission('vessels.edit', 'vessel_documents.manage')
  photo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPhotoDto) {
    return this.vessels.setPhoto(ctx, id, dto.fileId);
  }

  @Get(':id/attachments')
  @RequirePermissions('vessels.view')
  attachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: Record<string, unknown>) {
    const { archived } = z.object({ archived: queryBool }).parse(q);
    return this.vessels.listAttachments(ctx, id, !!archived);
  }

  @Post(':id/attachments')
  @RequirePermissions('vessel_documents.manage')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddVesselAttachmentDto) {
    return this.vessels.addAttachment(ctx, id, dto);
  }

  @Post(':id/attachments/:attachmentId/archive')
  @RequirePermissions('vessel_documents.manage')
  archiveAttachment(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
  ) {
    return this.vessels.archiveAttachment(ctx, id, attachmentId);
  }
}
