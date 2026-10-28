import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  ApproveCpVersionDto,
  CancelCharterPartyDto,
  CreateCharterPartyDto,
  ListCharterPartiesQuery,
  RejectCpVersionDto,
  SubmitCpVersionDto,
  UpdateCharterPartyDto,
} from './charter-parties.dto';
import { CharterPartiesService } from './charter-parties.service';
import { FileLinkQuerySchema, ReasonDto } from './voyages.dto';

/**
 * Charter Parties (CDC §7.2, §11 « POST /charter-parties ») — confidentielles : toute route
 * exige charter_party.view (+ manage / approve selon l'action).
 */
@ApiTags('Voyages — Charter Parties')
@Controller('charter-parties')
export class CharterPartiesController {
  constructor(private readonly cps: CharterPartiesService) {}

  @Get()
  @RequirePermissions('charter_party.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListCharterPartiesQuery) {
    return this.cps.list(ctx, q);
  }

  @Post()
  @RequirePermissions('charter_party.view', 'charter_party.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateCharterPartyDto) {
    return this.cps.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('charter_party.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cps.get(ctx, id);
  }

  /** Brouillon uniquement ; ensuite toute modification passe par une version. */
  @Patch(':id')
  @RequirePermissions('charter_party.view', 'charter_party.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCharterPartyDto) {
    return this.cps.update(ctx, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('charter_party.view', 'charter_party.manage')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelCharterPartyDto) {
    return this.cps.cancel(ctx, id, dto);
  }

  // ----- Versions (ORIGINAL / ADDENDUM / REVISION)

  @Get(':id/versions')
  @RequirePermissions('charter_party.view')
  versions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.cps.listVersions(ctx, id);
  }

  @Post(':id/versions')
  @RequirePermissions('charter_party.view', 'charter_party.manage')
  submitVersion(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SubmitCpVersionDto) {
    return this.cps.submitVersion(ctx, id, dto);
  }

  /** Approbation par un AUTRE utilisateur habilité (auto-approbation interdite). */
  @Post(':id/versions/:versionId/approve')
  @RequirePermissions('charter_party.view', 'charter_party.approve')
  approve(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: ApproveCpVersionDto,
  ) {
    return this.cps.approveVersion(ctx, id, versionId, dto.comment);
  }

  @Post(':id/versions/:versionId/reject')
  @RequirePermissions('charter_party.view', 'charter_party.approve')
  reject(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: RejectCpVersionDto,
  ) {
    return this.cps.rejectVersion(ctx, id, versionId, dto.comment);
  }

  @Post(':id/versions/:versionId/withdraw')
  @RequirePermissions('charter_party.view', 'charter_party.manage')
  withdraw(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('versionId', ParseUUIDPipe) versionId: string,
    @Body() dto: ReasonDto,
  ) {
    return this.cps.withdrawVersion(ctx, id, versionId, dto.reason);
  }

  /** Accusé de lecture (Master) de la version en vigueur. */
  @Post(':id/versions/:versionId/acknowledge')
  @RequirePermissions('charter_party.view')
  acknowledge(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.cps.acknowledge(ctx, id, versionId);
  }

  @Get(':id/versions/:versionId/acknowledgements')
  @RequirePermissions('charter_party.view')
  acknowledgements(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string) {
    return this.cps.listAcknowledgements(ctx, id, versionId);
  }

  /** PDF de la version : preview (view) ; download réservé à manage / approve (resolver cp_version). */
  @Get(':id/versions/:versionId/file')
  @RequirePermissions('charter_party.view')
  file(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('versionId', ParseUUIDPipe) versionId: string, @Query() q: unknown) {
    const { mode } = FileLinkQuerySchema.parse(q ?? {});
    return this.cps.versionFileLink(ctx, id, versionId, mode);
  }
}
