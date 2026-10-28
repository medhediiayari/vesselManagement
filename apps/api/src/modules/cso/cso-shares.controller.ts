import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CreateShareDto, SharedWithMeQuery } from './cso.dto';
import { CsoSharesService } from './cso-shares.service';

/** Partages internes CSO (CSO-014..016) — aucun lien public. */
@ApiTags('CSO — Partages')
@Controller('cso')
export class CsoSharesController {
  constructor(private readonly shares: CsoSharesService) {}

  @Post('shares')
  @RequirePermissions('cso.view', 'cso.share')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateShareDto) {
    return this.shares.create(ctx, dto);
  }

  @Get('shared-with-me')
  @RequirePermissions('cso.view')
  sharedWithMe(@Auth() ctx: AuthContext, @Query() q: SharedWithMeQuery) {
    return this.shares.sharedWithMe(ctx, q);
  }

  @Get('documents/:id/shares')
  @RequireAnyPermission('cso.share', 'cso.revoke')
  list(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shares.listForDocument(ctx, id);
  }

  @Delete('shares/:id')
  @RequirePermissions('cso.revoke')
  revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shares.revoke(ctx, id);
  }

  @Post('documents/:id/shares/revoke-all')
  @RequirePermissions('cso.revoke')
  revokeAll(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.shares.revokeAll(ctx, id);
  }
}
