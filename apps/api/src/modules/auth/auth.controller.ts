import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { env } from '../../config/env';
import { AllowPendingPasswordChange, Auth, Public } from '../../common/decorators';
import { CSRF_COOKIE, SESSION_COOKIE } from '../../common/guards/auth.guard';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import {
  ChangePasswordDto,
  ForgotPasswordDto,
  LoginDto,
  ResetPasswordDto,
  UpdateProfileDto,
} from './auth.dto';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';

function cookieBase() {
  return { secure: env().COOKIE_SECURE, sameSite: 'lax' as const, path: '/' };
}

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly passwords: PasswordService,
  ) {}

  /** GET /auth/password-policy — règles à afficher avant saisie (public : page de réinitialisation, ADM-21). */
  @Public()
  @Get('password-policy')
  passwordPolicy() {
    return this.passwords.policy();
  }

  /** POST /auth/login — throttling IP en complément du verrouillage compte (CDC §12.3). */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request & { requestId?: string }, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.identifier, dto.password, dto.deviceLabel, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      requestId: req.requestId ?? null,
    });
    const maxAge = result.expiresAt.getTime() - Date.now();
    res.cookie(SESSION_COOKIE, result.sessionToken, { ...cookieBase(), httpOnly: true, maxAge });
    res.cookie(CSRF_COOKIE, result.csrfToken, { ...cookieBase(), httpOnly: false, maxAge });
    return { mustChangePassword: result.mustChangePassword, expiresAt: result.expiresAt };
  }

  @AllowPendingPasswordChange()
  @Post('logout')
  @HttpCode(204)
  async logout(@Auth() ctx: AuthContext, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(ctx);
    res.clearCookie(SESSION_COOKIE, cookieBase());
    res.clearCookie(CSRF_COOKIE, cookieBase());
  }

  @AllowPendingPasswordChange()
  @Get('me')
  me(@Auth() ctx: AuthContext) {
    return this.auth.me(ctx);
  }

  /** Mise à jour des préférences de compte (données de connexion uniquement, ADM-033). */
  @Patch('me')
  async updateMe(@Auth() ctx: AuthContext, @Body() dto: UpdateProfileDto) {
    const before = await this.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: { displayName: true, locale: true },
    });
    const after = await this.prisma.user.update({
      where: { id: ctx.userId },
      data: dto,
      select: { displayName: true, locale: true },
    });
    await this.audit.record(ctx, {
      action: 'user.profile_updated',
      module: 'admin',
      entityType: 'user',
      entityId: ctx.userId,
      before,
      after,
    });
    return after;
  }

  @AllowPendingPasswordChange()
  @Post('change-password')
  @HttpCode(204)
  changePassword(@Auth() ctx: AuthContext, @Body() dto: ChangePasswordDto) {
    return this.auth.changePassword(ctx, dto.currentPassword, dto.newPassword);
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('forgot')
  @HttpCode(202)
  async forgot(@Body() dto: ForgotPasswordDto, @Req() req: Request & { requestId?: string }) {
    await this.auth.forgotPassword(dto.identifier, {
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      requestId: req.requestId ?? null,
    });
    return { message: 'Si un compte avec e-mail vérifié correspond, un lien a été envoyé.' };
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('reset')
  @HttpCode(204)
  reset(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.newPassword);
  }

  /** Sessions de l'utilisateur courant (ADM-017/018). */
  @AllowPendingPasswordChange()
  @Get('sessions')
  sessions(@Auth() ctx: AuthContext) {
    return this.auth.listOwnSessions(ctx);
  }

  @AllowPendingPasswordChange()
  @Delete('sessions/:id')
  @HttpCode(204)
  revoke(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.revokeOwnSession(ctx, id);
  }
}
