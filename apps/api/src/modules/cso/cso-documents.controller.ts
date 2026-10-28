import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { queryBool } from '../../common/pagination';
import type { AuthContext } from '../access/auth-context';
import type { FileAccessLink } from '../files/files.service';
import { CsoDocumentsService } from './cso-documents.service';
import { CsoFoldersService } from './cso-folders.service';
import { CsoSearchService } from './cso-search.service';
import {
  ArchiveDto,
  CopyDocumentDto,
  CreateDocumentDto,
  ListDocumentsQuery,
  LockVersionDto,
  MoveDocumentDto,
  NewVersionDto,
  PutAclDto,
  ReferenceChangeDto,
  ReferenceDecisionDto,
  RestoreDocumentDto,
  SearchQuery,
  UpdateDocumentDto,
  VersionDecisionDto,
} from './cso.dto';

const LinkQuery = z.object({ redirect: queryBool });

/** Lien signé éphémère ; ?redirect=true => 302 vers l'URL signée. */
function respondLink(link: FileAccessLink, q: unknown, res: Response) {
  const { redirect } = LinkQuery.parse(q ?? {});
  res.setHeader('Cache-Control', 'no-store');
  if (redirect) {
    res.redirect(302, link.url);
    return;
  }
  return link;
}

@ApiTags('CSO — Documents')
@Controller('cso/documents')
export class CsoDocumentsController {
  constructor(
    private readonly documents: CsoDocumentsService,
    private readonly folders: CsoFoldersService,
  ) {}

  @Get()
  @RequirePermissions('cso.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListDocumentsQuery) {
    return this.documents.list(ctx, q);
  }

  /** Création : métadonnées + première version (fichier déposé en contexte CSO_DOCUMENT). */
  @Post()
  @RequirePermissions('cso.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateDocumentDto) {
    return this.documents.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('cso.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('cso.edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateDocumentDto) {
    return this.documents.update(ctx, id, dto);
  }

  @Get(':id/effective-access')
  @RequirePermissions('cso.view')
  effectiveAccess(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.effectiveAccess(ctx, id);
  }

  @Get(':id/versions')
  @RequirePermissions('cso.view')
  versions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listVersions(ctx, id);
  }

  /** Nouvelle version : l'officielle actuelle reste publiée pendant la validation (CSO-007). */
  @Post(':id/versions')
  @RequirePermissions('cso.edit')
  addVersion(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: NewVersionDto) {
    return this.documents.addVersion(ctx, id, dto);
  }

  @Get(':id/history')
  @RequirePermissions('cso.audit.view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.history(ctx, id);
  }

  @Get(':id/acl')
  @RequirePermissions('cso.folder.acl_manage')
  getAcl(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.folders.getAcl(ctx, 'document', id);
  }

  @Put(':id/acl')
  @RequirePermissions('cso.folder.acl_manage')
  putAcl(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PutAclDto) {
    return this.folders.putAcl(ctx, 'document', id, dto);
  }

  /** Demande de changement de référence officielle (approbation distincte — CSO-027). */
  @Post(':id/reference-change')
  @RequirePermissions('cso.edit')
  referenceChange(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReferenceChangeDto) {
    return this.documents.requestReferenceChange(ctx, id, dto);
  }

  @Get(':id/reference-changes')
  @RequirePermissions('cso.view')
  referenceChanges(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.documents.listReferenceChanges(ctx, id);
  }

  @Post(':id/copy')
  @RequirePermissions('cso.create')
  copy(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CopyDocumentDto) {
    return this.documents.copy(ctx, id, dto);
  }

  @Patch(':id/move')
  @RequirePermissions('cso.folder.move')
  move(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MoveDocumentDto) {
    return this.documents.move(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermissions('cso.edit')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveDto) {
    return this.documents.archive(ctx, id, dto);
  }

  @Post(':id/restore')
  @RequirePermissions('cso.restore')
  restore(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RestoreDocumentDto) {
    return this.documents.restore(ctx, id, dto);
  }

  /** Aperçu de la version officielle courante (droits revalidés + audit). */
  @Get(':id/preview')
  @RequireAnyPermission('cso.preview', 'cso.archive.view')
  async preview(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return respondLink(await this.documents.documentLink(ctx, id, 'preview'), q, res);
  }

  @Get(':id/download')
  @RequireAnyPermission('cso.download', 'cso.archive.download')
  async download(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return respondLink(await this.documents.documentLink(ctx, id, 'download'), q, res);
  }
}

@ApiTags('CSO — Versions')
@Controller('cso/versions')
export class CsoVersionsController {
  constructor(private readonly documents: CsoDocumentsService) {}

  /** Aperçu : version officielle (cso.preview) ou archivée (cso.archive.view) — CSO-008. */
  @Get(':id/preview')
  @RequireAnyPermission('cso.preview', 'cso.archive.view')
  async preview(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return respondLink(await this.documents.versionLink(ctx, id, 'preview'), q, res);
  }

  /** Téléchargement : cso.download (officielle) / cso.archive.download (archivée) — distinct de l'aperçu. */
  @Get(':id/download')
  @RequireAnyPermission('cso.download', 'cso.archive.download')
  async download(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return respondLink(await this.documents.versionLink(ctx, id, 'download'), q, res);
  }

  @Post(':id/submit')
  @RequirePermissions('cso.edit')
  submit(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LockVersionDto) {
    return this.documents.submitVersion(ctx, id, dto);
  }

  @Post(':id/cancel')
  @RequireAnyPermission('cso.create', 'cso.edit')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: LockVersionDto) {
    return this.documents.cancelVersion(ctx, id, dto);
  }

  /** POST /cso/versions/{id}/decision — APPROVE | REJECT | RETURN (jamais par le déposant). */
  @Post(':id/decision')
  @RequirePermissions('cso.approve')
  decide(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDecisionDto) {
    return this.documents.decide(ctx, id, dto);
  }
}

@ApiTags('CSO — Documents')
@Controller('cso')
export class CsoMiscController {
  constructor(
    private readonly documents: CsoDocumentsService,
    private readonly searchService: CsoSearchService,
  ) {}

  /** Recherche FTS + métadonnées, filtrée par ACL document et champ avant réponse (CSO-013). */
  @Get('search')
  @RequirePermissions('cso.view')
  search(@Auth() ctx: AuthContext, @Query() q: SearchQuery) {
    return this.searchService.search(ctx, q);
  }

  /** Versions et changements de référence que l'utilisateur peut décider. */
  @Get('approvals')
  @RequirePermissions('cso.approve')
  approvals(@Auth() ctx: AuthContext) {
    return this.documents.approvalsInbox(ctx);
  }

  @Post('reference-changes/:id/decision')
  @RequirePermissions('cso.approve')
  decideReference(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReferenceDecisionDto) {
    return this.documents.decideReferenceChange(ctx, id, dto);
  }
}
