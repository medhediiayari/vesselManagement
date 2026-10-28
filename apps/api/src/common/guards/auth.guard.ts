import { CanActivate, ExecutionContext, HttpStatus, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AppError, Errors } from '../errors';
import {
  ALLOW_PASSWORD_CHANGE_PENDING,
  ANY_PERMISSIONS_KEY,
  IS_PUBLIC_KEY,
  PERMISSIONS_KEY,
  SKIP_CSRF,
} from '../decorators';
import { safeEqual, sha256Hex } from '../utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../../modules/access/access.service';
import { SettingsService } from '../../modules/settings/settings.service';
import type { AuthContext } from '../../modules/access/auth-context';

export const SESSION_COOKIE = 'amc_sid';
export const CSRF_COOKIE = 'amc_csrf';
export const CSRF_HEADER = 'x-csrf-token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000;

export type AuthedRequest = Request & { auth?: AuthContext; requestId?: string };

/**
 * Guard global : session -> compte -> timeout d'inactivité -> CSRF -> permissions.
 * Les droits sont recalculés depuis la base à chaque requête (ADM-019) ; aucune décision
 * ne repose sur l'état du front (CDC §1.1).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
    if (!token) throw Errors.unauthenticated();

    const session = await this.prisma.session.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            displayName: true,
            email: true,
            status: true,
            lockedAt: true,
            mustChangePassword: true,
            memberId: true,
            vesselScope: true,
            departments: { where: { department: { status: 'ACTIVE' } }, select: { departmentId: true } },
          },
        },
      },
    });
    if (!session || session.revokedAt) throw Errors.unauthenticated('Session invalide ou révoquée');

    const now = Date.now();
    if (session.expiresAt.getTime() <= now) {
      await this.revoke(session.id, 'ABSOLUTE_EXPIRY');
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_EXPIRED', 'Session expirée');
    }
    const idleMinutes = await this.settings.get('auth.sessionIdleTimeoutMinutes');
    if (now - session.lastSeenAt.getTime() > idleMinutes * 60_000) {
      await this.revoke(session.id, 'IDLE_TIMEOUT');
      throw new AppError(HttpStatus.UNAUTHORIZED, 'SESSION_EXPIRED', "Session expirée après inactivité");
    }
    const user = session.user;
    if (user.status !== 'ACTIVE') {
      await this.revoke(session.id, 'ACCOUNT_DEACTIVATED');
      throw Errors.unauthenticated('Compte désactivé');
    }
    if (user.lockedAt) {
      await this.revoke(session.id, 'ACCOUNT_LOCKED');
      throw new AppError(HttpStatus.UNAUTHORIZED, 'ACCOUNT_LOCKED', 'Compte verrouillé');
    }

    // CSRF double-submit (cookies de session => protection requise, CDC §12.3)
    if (!SAFE_METHODS.has(req.method) && !this.reflector.getAllAndOverride<boolean>(SKIP_CSRF, targets)) {
      const header = req.header(CSRF_HEADER) ?? '';
      const cookie = (req.cookies as Record<string, string> | undefined)?.[CSRF_COOKIE] ?? '';
      if (!header || !cookie || !safeEqual(header, cookie)) {
        throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_INVALID', 'Jeton CSRF invalide');
      }
    }

    const [eff, scope] = await Promise.all([
      this.access.computeEffectivePermissions(user.id),
      this.access.computeVesselScope(user.id, user.vesselScope),
    ]);

    const auth: AuthContext = {
      userId: user.id,
      sessionId: session.id,
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      memberId: user.memberId,
      mustChangePassword: user.mustChangePassword,
      isSuperAdmin: eff.isSuperAdmin,
      roleIds: eff.roleIds,
      roleKeys: eff.roleKeys,
      departmentIds: user.departments.map((d) => d.departmentId),
      permissions: eff.permissions,
      deniedPermissions: eff.denied,
      vesselScope: scope,
      ip: req.ip ?? null,
      userAgent: req.header('user-agent') ?? null,
      requestId: req.requestId ?? null,
    };
    req.auth = auth;

    if (now - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
    }

    if (user.mustChangePassword && !this.reflector.getAllAndOverride<boolean>(ALLOW_PASSWORD_CHANGE_PENDING, targets)) {
      throw new AppError(
        HttpStatus.FORBIDDEN,
        'PASSWORD_CHANGE_REQUIRED',
        'Changement du mot de passe temporaire requis avant toute autre action',
      );
    }

    const all = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? [];
    const any = this.reflector.getAllAndOverride<string[]>(ANY_PERMISSIONS_KEY, targets) ?? [];
    const missing = all.filter((p) => !eff.permissions.has(p));
    const anyOk = any.length === 0 || any.some((p) => eff.permissions.has(p));
    if (missing.length || !anyOk) {
      // Journalisé par AllExceptionsFilter (refus 403 audités de façon centralisée)
      throw Errors.forbidden('Permission insuffisante', { missing: missing.length ? missing : any });
    }
    return true;
  }

  private async revoke(sessionId: string, reason: string): Promise<void> {
    await this.prisma.session.update({ where: { id: sessionId }, data: { revokedAt: new Date(), revokedReason: reason } });
  }
}
