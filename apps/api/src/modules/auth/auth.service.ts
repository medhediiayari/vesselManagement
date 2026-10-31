import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { Errors } from '../../common/errors';
import { randomToken, sha256Hex } from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { EmailService } from '../notifications/email.service';
import { SettingsService } from '../settings/settings.service';
import { invalidateResetTokens, PasswordService } from './password.service';

export interface LoginResult {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  mustChangePassword: boolean;
}

interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
}

/**
 * Message unique pour tout échec (identifiant inconnu, mot de passe faux, compte désactivé ou verrouillé) :
 * aucune énumération des comptes. Le verrouillage (ADM-014) est rappelé sans être confirmé.
 */
const GENERIC_LOGIN_ERROR =
  'Identifiant ou mot de passe incorrect. Après plusieurs échecs, le compte est verrouillé : seul un administrateur peut le débloquer.';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly email: EmailService,
  ) {}

  /** Connexion email OU username (ADM-008) ; verrouillage après N échecs (ADM-014). */
  async login(identifier: string, password: string, deviceLabel: string | undefined, meta: RequestMeta): Promise<LoginResult> {
    const ident = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: ident }, { email: ident }] },
    });

    if (!user) {
      await this.passwords.burn(password);
      await this.audit.system({
        action: 'auth.login_failed',
        module: 'auth',
        entityType: 'user',
        result: 'DENIED',
        metadata: { reason: 'UNKNOWN_IDENTIFIER', ip: meta.ip },
      });
      throw Errors.unauthenticated(GENERIC_LOGIN_ERROR);
    }

    const actor = this.pseudoCtx(user, meta);
    if (user.lockedAt) {
      await this.passwords.burn(password);
      await this.audit.record(actor, {
        action: 'auth.login_failed',
        module: 'auth',
        entityType: 'user',
        entityId: user.id,
        result: 'DENIED',
        metadata: { reason: 'LOCKED' },
      });
      // Réponse identique à un échec ordinaire : ne confirme pas l'existence du compte
      throw Errors.unauthenticated(GENERIC_LOGIN_ERROR);
    }

    const ok = await this.passwords.verify(user.passwordHash, password);
    if (!ok || user.status !== 'ACTIVE') {
      const maxFailed = await this.settings.get('auth.maxFailedLogins');
      await this.prisma.$transaction(async (tx) => {
        // Incrément atomique : des tentatives parallèles ne peuvent pas « perdre » d'échecs
        const updated = ok
          ? { failedLogins: user.failedLogins }
          : await tx.user.update({ where: { id: user.id }, data: { failedLogins: { increment: 1 } }, select: { failedLogins: true } });
        const failed = updated.failedLogins;
        const lock = !ok && failed >= maxFailed;
        if (lock) {
          await tx.user.updateMany({ where: { id: user.id, lockedAt: null }, data: { lockedAt: new Date() } });
          await tx.session.updateMany({
            where: { userId: user.id, revokedAt: null },
            data: { revokedAt: new Date(), revokedReason: 'ACCOUNT_LOCKED' },
          });
        }
        await this.audit.record(
          actor,
          {
            action: lock ? 'auth.account_locked' : 'auth.login_failed',
            module: 'auth',
            entityType: 'user',
            entityId: user.id,
            result: 'DENIED',
            metadata: { reason: ok ? 'DEACTIVATED' : 'BAD_PASSWORD', failedLogins: failed },
          },
          tx,
        );
      });
      throw Errors.unauthenticated(GENERIC_LOGIN_ERROR);
    }

    const sessionToken = randomToken(32);
    const csrfToken = randomToken(24);
    const expiresAt = new Date(Date.now() + env().SESSION_ABSOLUTE_TTL_HOURS * 3_600_000);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lastLoginAt: new Date() } });
      const session = await tx.session.create({
        data: {
          userId: user.id,
          tokenHash: sha256Hex(sessionToken),
          deviceLabel: deviceLabel ?? describeDevice(meta.userAgent),
          userAgent: meta.userAgent?.slice(0, 400) ?? null,
          ip: meta.ip,
          fingerprint: meta.userAgent ? sha256Hex(meta.userAgent).slice(0, 32) : null,
          expiresAt,
        },
      });
      await this.audit.record(
        { ...actor, sessionId: session.id },
        { action: 'auth.login', module: 'auth', entityType: 'session', entityId: session.id },
        tx,
      );
    });
    return { sessionToken, csrfToken, expiresAt, mustChangePassword: user.mustChangePassword };
  }

  async logout(ctx: AuthContext): Promise<void> {
    await this.prisma.session.update({
      where: { id: ctx.sessionId },
      data: { revokedAt: new Date(), revokedReason: 'LOGOUT', revokedById: ctx.userId },
    });
    await this.audit.record(ctx, { action: 'auth.logout', module: 'auth', entityType: 'session', entityId: ctx.sessionId });
  }

  /** Remplacement du mot de passe (temporaire ou non) ; révoque les autres sessions. */
  async changePassword(ctx: AuthContext, currentPassword: string, newPassword: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: ctx.userId } });
    if (!(await this.passwords.verify(user.passwordHash, currentPassword))) {
      await this.audit.record(ctx, {
        action: 'auth.password_change_failed',
        module: 'auth',
        entityType: 'user',
        entityId: user.id,
        result: 'DENIED',
      });
      throw Errors.validation('Mot de passe actuel incorrect');
    }
    if (currentPassword === newPassword) throw Errors.validation("Le nouveau mot de passe doit différer de l'actuel");
    await this.passwords.assertPolicy(newPassword, { username: user.username, email: user.email });
    const hash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: hash, mustChangePassword: false, passwordChangedAt: new Date() },
      });
      await invalidateResetTokens(tx, user.id);
      await tx.session.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: ctx.sessionId } },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_CHANGED' },
      });
      await this.audit.record(
        ctx,
        {
          action: user.mustChangePassword ? 'auth.temporary_password_replaced' : 'auth.password_changed',
          module: 'auth',
          entityType: 'user',
          entityId: user.id,
        },
        tx,
      );
    });
  }

  /**
   * Lien de réinitialisation à usage unique vers email VÉRIFIÉ (ADM-009).
   * Réponse identique que l'utilisateur existe ou non (anti-énumération).
   * N'efface jamais un verrouillage : seul un admin déverrouille (ADM-015). Compte verrouillé : aucun lien,
   * le titulaire est prévenu par e-mail de contacter un administrateur (réponse HTTP inchangée).
   * Chaque nouvelle demande invalide les liens précédents.
   */
  async forgotPassword(identifier: string, meta: RequestMeta): Promise<void> {
    const ident = identifier.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { OR: [{ username: ident }, { email: ident }], status: 'ACTIVE' },
    });
    if (!user || !user.email || !user.emailVerifiedAt) {
      await this.audit.system({
        action: 'auth.reset_requested_ignored',
        module: 'auth',
        entityType: 'user',
        entityId: user?.id ?? null,
        result: 'DENIED',
        metadata: { reason: user ? 'NO_VERIFIED_EMAIL' : 'UNKNOWN', ip: meta.ip },
      });
      return;
    }
    if (user.lockedAt) {
      await this.email.sendNow({
        to: user.email,
        subject: 'AMC — Compte verrouillé',
        text: `Bonjour ${user.displayName},\n\nUne réinitialisation du mot de passe a été demandée pour votre compte AMC.\nVotre compte est verrouillé : contactez un administrateur, qui vous remettra un mot de passe temporaire.\n\nSi vous n'êtes pas à l'origine de cette demande, prévenez votre administrateur.`,
      });
      await this.audit.system({
        action: 'auth.reset_requested_ignored',
        module: 'auth',
        entityType: 'user',
        entityId: user.id,
        result: 'DENIED',
        metadata: { reason: 'LOCKED', ip: meta.ip },
      });
      return;
    }
    const token = randomToken(32);
    await this.prisma.$transaction(async (tx) => {
      await invalidateResetTokens(tx, user.id);
      await tx.passwordResetToken.create({
        data: { userId: user.id, tokenHash: sha256Hex(token), expiresAt: new Date(Date.now() + 60 * 60_000) },
      });
    });
    const link = `${env().APP_BASE_URL}/reset-password?token=${encodeURIComponent(token)}`;
    await this.email.sendNow({
      to: user.email,
      subject: 'AMC — Réinitialisation de votre mot de passe',
      text: `Bonjour ${user.displayName},\n\nUn lien de réinitialisation a été demandé pour votre compte AMC.\nIl est valable 1 heure et utilisable une seule fois :\n${link}\n\nSi vous n'êtes pas à l'origine de cette demande, ignorez ce message.`,
    });
    await this.audit.system({ action: 'auth.reset_link_sent', module: 'auth', entityType: 'user', entityId: user.id });
  }

  async resetPassword(token: string, newPassword: string): Promise<void> {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: sha256Hex(token) },
      include: { user: true },
    });
    if (!row || row.usedAt || row.expiresAt < new Date() || row.user.status !== 'ACTIVE') {
      throw Errors.validation('Lien de réinitialisation invalide ou expiré');
    }
    // Le porteur du lien prouve qu'il détient la boîte : on peut lui dire pourquoi (ADM-04)
    if (row.user.lockedAt) throw Errors.business('Compte verrouillé : contactez un administrateur');
    await this.passwords.assertPolicy(newPassword, { username: row.user.username, email: row.user.email });
    const hash = await this.passwords.hash(newPassword);
    await this.prisma.$transaction(async (tx) => {
      const consumed = await tx.passwordResetToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) throw Errors.validation('Lien déjà utilisé');
      // Verrou posé entre la lecture et l'écriture : on ne remplace pas le mot de passe
      const updated = await tx.user.updateMany({
        where: { id: row.userId, lockedAt: null },
        data: { passwordHash: hash, mustChangePassword: false, passwordChangedAt: new Date() },
      });
      if (updated.count !== 1) throw Errors.business('Compte verrouillé : contactez un administrateur');
      await invalidateResetTokens(tx, row.userId);
      await tx.session.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: 'PASSWORD_RESET' },
      });
      await this.audit.system(
        { action: 'auth.password_reset_by_link', module: 'auth', entityType: 'user', entityId: row.userId },
        tx,
      );
    });
  }

  /** Profil + droits effectifs (indications UI ; le serveur reste l'autorité). */
  async me(ctx: AuthContext) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: ctx.userId },
      select: {
        id: true,
        username: true,
        email: true,
        emailVerifiedAt: true,
        displayName: true,
        jobTitle: true,
        locale: true,
        mustChangePassword: true,
        lastLoginAt: true,
        vesselScope: true,
        memberId: true,
        roles: { select: { role: { select: { id: true, key: true, name: true } } } },
        departments: { select: { isPrimary: true, department: { select: { id: true, code: true, name: true, status: true } } } },
      },
    });
    const vessels = await this.prisma.vessel.findMany({
      where: ctx.vesselScope.mode === 'ALL_FLEET' ? {} : { id: { in: ctx.vesselScope.vesselIds } },
      select: { id: true, code: true, name: true, imoNumber: true, status: true },
      orderBy: { name: 'asc' },
    });
    return {
      ...user,
      roles: user.roles.map((r) => r.role),
      departments: user.departments.map((d) => ({ ...d.department, isPrimary: d.isPrimary })),
      permissions: [...ctx.permissions].sort(),
      isSuperAdmin: ctx.isSuperAdmin,
      accessibleVessels: vessels,
      sessionId: ctx.sessionId,
    };
  }

  async listOwnSessions(ctx: AuthContext) {
    const sessions = await this.prisma.session.findMany({
      where: { userId: ctx.userId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true, deviceLabel: true, userAgent: true, ip: true, createdAt: true, lastSeenAt: true, expiresAt: true },
    });
    return sessions.map((s) => ({ ...s, current: s.id === ctx.sessionId }));
  }

  async revokeOwnSession(ctx: AuthContext, sessionId: string): Promise<void> {
    const res = await this.prisma.session.updateMany({
      where: { id: sessionId, userId: ctx.userId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: ctx.userId, revokedReason: 'USER_REVOKED' },
    });
    if (res.count === 0) throw Errors.notFound('Session');
    await this.audit.record(ctx, { action: 'auth.session_revoked', module: 'auth', entityType: 'session', entityId: sessionId });
  }

  private pseudoCtx(user: { id: string; username: string; displayName: string; email: string | null }, meta: RequestMeta): AuthContext {
    return {
      userId: user.id,
      sessionId: '',
      username: user.username,
      displayName: user.displayName,
      email: user.email,
      memberId: null,
      mustChangePassword: false,
      isSuperAdmin: false,
      roleIds: [],
      roleKeys: [],
      departmentIds: [],
      permissions: new Set(),
      deniedPermissions: new Set(),
      vesselScope: { mode: 'SELECTED', vesselIds: [] },
      ip: meta.ip,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    };
  }
}

function describeDevice(ua: string | null): string {
  if (!ua) return 'Appareil inconnu';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ` · ${os}` : ''}`;
}
