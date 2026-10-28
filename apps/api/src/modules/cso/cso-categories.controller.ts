import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequirePermissions } from '../../common/decorators';
import { queryBool } from '../../common/pagination';
import type { AuthContext } from '../access/auth-context';
import { CsoCategoriesService } from './cso-categories.service';
import { CreateCategoryDto, CreateFieldDto, ListCategoriesQuery, PutFieldAclDto, UpdateCategoryDto, UpdateFieldDto } from './cso.dto';

@ApiTags('CSO — Catégories & champs')
@Controller('cso/categories')
export class CsoCategoriesController {
  constructor(private readonly categories: CsoCategoriesService) {}

  @Get()
  @RequirePermissions('cso.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListCategoriesQuery) {
    return this.categories.list(ctx, q);
  }

  @Post()
  @RequirePermissions('cso.categories.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateCategoryDto) {
    return this.categories.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('cso.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('cso.categories.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.categories.update(ctx, id, dto);
  }

  @Post(':id/deactivate')
  @RequirePermissions('cso.categories.manage')
  deactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.setActive(ctx, id, false);
  }

  @Post(':id/reactivate')
  @RequirePermissions('cso.categories.manage')
  reactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.setActive(ctx, id, true);
  }

  @Get(':id/fields')
  @RequirePermissions('cso.view')
  fields(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: Record<string, unknown>) {
    const { includeArchived } = z.object({ includeArchived: queryBool }).parse(q);
    return this.categories.listFields(ctx, id, !!includeArchived);
  }

  @Post(':id/fields')
  @RequirePermissions('cso.categories.manage')
  createField(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateFieldDto) {
    return this.categories.createField(ctx, id, dto);
  }
}

@ApiTags('CSO — Catégories & champs')
@Controller('cso/fields')
export class CsoFieldsController {
  constructor(private readonly categories: CsoCategoriesService) {}

  @Patch(':id')
  @RequirePermissions('cso.categories.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFieldDto) {
    return this.categories.updateField(ctx, id, dto);
  }

  /** Archivage sans perte (CSO-030) : valeurs conservées, champ en lecture seule. */
  @Post(':id/archive')
  @RequirePermissions('cso.categories.manage')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.setFieldArchived(ctx, id, true);
  }

  @Post(':id/reactivate')
  @RequirePermissions('cso.categories.manage')
  reactivate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.setFieldArchived(ctx, id, false);
  }

  @Get(':id/acl')
  @RequirePermissions('cso.categories.manage')
  getAcl(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.categories.getFieldAcl(ctx, id);
  }

  /** Visibilité / édition par user / rôle / département (CSO-031/032). */
  @Put(':id/acl')
  @RequirePermissions('cso.categories.manage')
  putAcl(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutFieldAclDto) {
    return this.categories.putFieldAcl(ctx, id, dto);
  }
}
