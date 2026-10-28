import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CsoFoldersService } from './cso-folders.service';
import {
  ArchiveDto,
  CreateFolderDto,
  ListFoldersQuery,
  MoveFolderDto,
  PutAclDto,
  PutValidatorsDto,
  RenameFolderDto,
  RestoreFolderDto,
  TreeQuery,
} from './cso.dto';

@ApiTags('CSO — Bibliothèques')
@Controller('cso/libraries')
export class CsoLibrariesController {
  constructor(private readonly folders: CsoFoldersService) {}

  /** Bibliothèques atteignables : centrale (flotte) + navires du scope (CSO-002). */
  @Get()
  @RequirePermissions('cso.view')
  list(@Auth() ctx: AuthContext) {
    return this.folders.listLibraries(ctx);
  }

  /** Arbre des dossiers VISIBLES de la bibliothèque (zones non autorisées absentes — CDC §5.6). */
  @Get(':id/tree')
  @RequirePermissions('cso.view')
  tree(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: TreeQuery) {
    return this.folders.libraryTree(ctx, id, q);
  }
}

@ApiTags('CSO — Dossiers')
@Controller('cso/folders')
export class CsoFoldersController {
  constructor(private readonly folders: CsoFoldersService) {}

  @Get()
  @RequirePermissions('cso.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListFoldersQuery) {
    return this.folders.listFolders(ctx, q);
  }

  @Post()
  @RequirePermissions('cso.folder.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateFolderDto) {
    return this.folders.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('cso.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.folders.getFolder(ctx, id);
  }

  @Get(':id/tree')
  @RequirePermissions('cso.view')
  tree(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: TreeQuery) {
    return this.folders.folderTree(ctx, id, q);
  }

  @Get(':id/breadcrumb')
  @RequirePermissions('cso.view')
  async breadcrumb(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return (await this.folders.getFolder(ctx, id)).breadcrumb;
  }

  /** Actions effectives de l'utilisateur sur le dossier (pilotage de l'UI). */
  @Get(':id/effective-access')
  @RequirePermissions('cso.view')
  effectiveAccess(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.folders.effectiveAccess(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('cso.folder.rename')
  rename(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenameFolderDto) {
    return this.folders.rename(ctx, id, dto);
  }

  /** PATCH /cso/folders/{id}/move — recalcul de tous les descendants ; inter-navires : droits source ET destination. */
  @Patch(':id/move')
  @RequirePermissions('cso.folder.move')
  move(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveFolderDto) {
    return this.folders.move(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermissions('cso.folder.archive')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveDto) {
    return this.folders.archive(ctx, id, dto);
  }

  @Post(':id/restore')
  @RequirePermissions('cso.restore')
  restore(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RestoreFolderDto) {
    return this.folders.restore(ctx, id, dto);
  }

  @Get(':id/acl')
  @RequirePermissions('cso.folder.acl_manage')
  getAcl(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.folders.getAcl(ctx, 'folder', id);
  }

  @Put(':id/acl')
  @RequirePermissions('cso.folder.acl_manage')
  putAcl(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutAclDto) {
    return this.folders.putAcl(ctx, 'folder', id, dto);
  }

  @Get(':id/validators')
  @RequirePermissions('cso.view')
  getValidators(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.folders.getValidators(ctx, id);
  }

  /** Validateurs par dossier : administration CSO (cso.categories.manage) + acl_manage sur le dossier. */
  @Put(':id/validators')
  @RequirePermissions('cso.categories.manage', 'cso.folder.acl_manage')
  putValidators(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutValidatorsDto) {
    return this.folders.putValidators(ctx, id, dto);
  }
}
