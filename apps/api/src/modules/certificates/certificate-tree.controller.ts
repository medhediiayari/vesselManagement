import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CertificateTreeService } from './certificate-tree.service';
import { CreateCategoryDto, CreateFolderDto, FileCertificatesDto, UpdateCategoryDto, UpdateFolderDto } from './certificates.dto';

/** Dossiers de l'arborescence Certificats — lecture : certificates.view ; gestion : certificates.folders.manage. */
@ApiTags('Certificates — Arborescence')
@Controller('certificate-folders')
export class CertificateFoldersController {
  constructor(private readonly tree: CertificateTreeService) {}

  @Get()
  @RequirePermissions('certificates.view')
  list(@Auth() ctx: AuthContext) {
    return this.tree.listFolders(ctx);
  }

  /** Classement d'un lot de certificats (folderId null = retirer du dossier). */
  @Put('assignments')
  @RequirePermissions('certificates.view', 'certificates.folders.manage')
  file(@Auth() ctx: AuthContext, @Body() dto: FileCertificatesDto) {
    return this.tree.fileCertificates(ctx, dto);
  }

  @Post()
  @RequirePermissions('certificates.folders.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateFolderDto) {
    return this.tree.createFolder(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('certificates.folders.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateFolderDto) {
    return this.tree.updateFolder(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('certificates.folders.manage')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tree.deleteFolder(ctx, id);
  }
}

/** Catégories de l'arborescence — lecture : certificates.view ; gestion : certificates.categories.manage. */
@ApiTags('Certificates — Arborescence')
@Controller('certificate-categories')
export class CertificateCategoriesController {
  constructor(private readonly tree: CertificateTreeService) {}

  @Get()
  @RequirePermissions('certificates.view')
  list(@Auth() ctx: AuthContext) {
    return this.tree.listCategories(ctx);
  }

  @Post()
  @RequirePermissions('certificates.categories.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateCategoryDto) {
    return this.tree.createCategory(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('certificates.categories.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCategoryDto) {
    return this.tree.updateCategory(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('certificates.categories.manage')
  remove(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.tree.deleteCategory(ctx, id);
  }
}
