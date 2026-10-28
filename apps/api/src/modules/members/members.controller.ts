import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  AddMemberDocumentDto,
  ArchiveMemberDocumentDto,
  ArchiveMemberDto,
  CreateMemberDto,
  DuplicateCheckDto,
  ListDocumentsQuery,
  ListMembersQuery,
  MemberStatsQuery,
  SelfUpdateDto,
  SetMemberPhotoDto,
  SetMemberStatusDto,
  UpdateMemberDto,
} from './members.dto';
import { MembersService } from './members.service';

/**
 * Libre-service (ADM-032..035) : fiche liée au compte connecté. Aucune permission module :
 * la personne n'accède qu'à SA fiche, et ne modifie que les champs ouverts par le Super Admin.
 * Déclaré avant MembersController pour que « me » ne soit pas lu comme un :id.
 */
@ApiTags('Members — Self-service')
@Controller('members/me')
export class MemberSelfController {
  constructor(private readonly members: MembersService) {}

  @Get()
  get(@Auth() ctx: AuthContext) {
    return this.members.getSelf(ctx);
  }

  @Patch()
  update(@Auth() ctx: AuthContext, @Body() dto: SelfUpdateDto) {
    return this.members.updateSelf(ctx, dto);
  }
}

@ApiTags('Members')
@Controller('members')
export class MembersController {
  constructor(private readonly members: MembersService) {}

  /** Liste paginée filtrée serveur par la visibilité ADM-070. */
  @Get()
  @RequirePermissions('members.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListMembersQuery) {
    return this.members.list(ctx, q);
  }

  /** Compteurs par statut et alertes certificats de la population visible (déclaré avant :id). */
  @Get('stats')
  @RequirePermissions('members.view')
  stats(@Auth() ctx: AuthContext, @Query() q: MemberStatsQuery) {
    return this.members.stats(ctx, q);
  }

  /** Création avec anti-doublon multicritère (409 DUPLICATE + candidats, sauf force + motif). */
  @Post()
  @RequirePermissions('members.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateMemberDto) {
    return this.members.create(ctx, dto);
  }

  /** Pré-contrôle des doublons (formulaire de création / correction). */
  @Post('duplicates/check')
  @HttpCode(200)
  @RequireAnyPermission('members.create', 'members.edit', 'members.import')
  checkDuplicates(@Auth() ctx: AuthContext, @Body() dto: DuplicateCheckDto) {
    return this.members.checkDuplicates(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('members.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.get(ctx, id);
  }

  @Get(':id/history')
  @RequirePermissions('members.view')
  @RequireAnyPermission('audit.view.members', 'members.personal_fields.manage')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.history(ctx, id);
  }

  /** Champs protégés (passeport, seaman book, naissance…) : members.personal_fields.manage vérifié dans le service. */
  @Patch(':id')
  @RequirePermissions('members.edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateMemberDto) {
    return this.members.update(ctx, id, dto);
  }

  @Post(':id/status')
  @RequirePermissions('members.edit')
  status(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetMemberStatusDto) {
    return this.members.setStatus(ctx, id, dto.status, dto.reason);
  }

  @Post(':id/archive')
  @RequirePermissions('members.edit')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveMemberDto) {
    return this.members.archive(ctx, id, dto.reason);
  }

  @Post(':id/restore')
  @RequirePermissions('members.edit')
  restore(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.members.restore(ctx, id);
  }

  @Put(':id/photo')
  @RequirePermissions('members.edit')
  photo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetMemberPhotoDto) {
    return this.members.setPhoto(ctx, id, dto.fileId);
  }

  @Get(':id/documents')
  @RequirePermissions('members.view')
  documents(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: ListDocumentsQuery) {
    return this.members.listDocuments(ctx, id, !!q.archived);
  }

  @Post(':id/documents')
  @RequirePermissions('members.edit')
  addDocument(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddMemberDocumentDto) {
    return this.members.addDocument(ctx, id, dto);
  }

  @Post(':id/documents/:documentId/archive')
  @RequirePermissions('members.edit')
  archiveDocument(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() dto: ArchiveMemberDocumentDto,
  ) {
    return this.members.archiveDocument(ctx, id, documentId, dto.reason);
  }

  /** Aperçu : members.view + ADM-070 (contrôlés par le resolver member_document). */
  @Get(':id/documents/:documentId/preview')
  @RequirePermissions('members.view')
  previewDocument(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.members.documentLink(ctx, id, documentId, 'preview');
  }

  /** Téléchargement : permission distincte (members.edit ou members.personal_fields.manage). */
  @Get(':id/documents/:documentId/download')
  @RequirePermissions('members.view')
  @RequireAnyPermission('members.edit', 'members.personal_fields.manage')
  downloadDocument(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('documentId', ParseUUIDPipe) documentId: string) {
    return this.members.documentLink(ctx, id, documentId, 'download');
  }
}
