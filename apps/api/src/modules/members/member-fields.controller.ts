import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CreateFieldDto, CreateSectionDto, ListFieldsQuery, ReorderDto, UpdateFieldDto, UpdateSectionDto } from './member-fields.dto';
import { MemberFieldsService } from './member-fields.service';

/**
 * Configuration des sections / champs personnalisés Members (ADM-036..039).
 * Lecture : utilisateurs Members (formulaires) ; écriture : members.fields.manage.
 */
@ApiTags('Members — Custom fields')
@Controller('members/custom-fields')
export class MemberFieldsController {
  constructor(private readonly fields: MemberFieldsService) {}

  @Get()
  @RequireAnyPermission('members.view', 'members.fields.manage')
  list(@Auth() ctx: AuthContext, @Query() q: ListFieldsQuery) {
    return this.fields.listSections(ctx, !!q.archived);
  }

  @Post('sections')
  @RequirePermissions('members.fields.manage')
  createSection(@Auth() ctx: AuthContext, @Body() dto: CreateSectionDto) {
    return this.fields.createSection(ctx, dto);
  }

  @Put('sections/order')
  @RequirePermissions('members.fields.manage')
  reorderSections(@Auth() ctx: AuthContext, @Body() dto: ReorderDto) {
    return this.fields.reorderSections(ctx, dto.ids);
  }

  @Patch('sections/:id')
  @RequirePermissions('members.fields.manage')
  updateSection(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSectionDto) {
    return this.fields.updateSection(ctx, id, dto);
  }

  @Post('sections/:id/archive')
  @RequirePermissions('members.fields.manage')
  archiveSection(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fields.setSectionArchived(ctx, id, true);
  }

  @Post('sections/:id/reactivate')
  @RequirePermissions('members.fields.manage')
  reactivateSection(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fields.setSectionArchived(ctx, id, false);
  }

  @Post('fields')
  @RequirePermissions('members.fields.manage')
  createField(@Auth() ctx: AuthContext, @Body() dto: CreateFieldDto) {
    return this.fields.createField(ctx, dto);
  }

  /** Ordre des champs d'une section (sectionId) ou des champs hors section (sectionId null). */
  @Put('fields/order')
  @RequirePermissions('members.fields.manage')
  reorderFields(@Auth() ctx: AuthContext, @Body() dto: ReorderDto) {
    return this.fields.reorderFields(ctx, dto.sectionId ?? null, dto.ids);
  }

  @Patch('fields/:id')
  @RequirePermissions('members.fields.manage')
  updateField(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFieldDto) {
    return this.fields.updateField(ctx, id, dto);
  }

  @Post('fields/:id/archive')
  @RequirePermissions('members.fields.manage')
  archiveField(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fields.setFieldArchived(ctx, id, true);
  }

  @Post('fields/:id/reactivate')
  @RequirePermissions('members.fields.manage')
  reactivateField(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.fields.setFieldArchived(ctx, id, false);
  }
}
