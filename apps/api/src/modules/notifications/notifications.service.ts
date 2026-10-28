import { Injectable, Logger } from '@nestjs/common';
import { NotificationPriority, PrincipalType } from '@prisma/client';
import { env } from '../../config/env';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { EmailService } from './email.service';

export interface Principal {
  type: PrincipalType;
  id: string;
}

export interface NotifyInput {
  /** Destinataires directs et/ou principaux (rôles, départements) à résoudre */
  userIds?: string[];
  principals?: Principal[];
  type: string;
  title: string;
  body?: string;
  module: string;
  entityType?: string;
  entityId?: string;
  vesselId?: string | null;
  /** Lien interne (deep link) — l'accès reste revérifié à l'ouverture */
  link?: string;
  priority?: NotificationPriority;
  /** Clé de déduplication par utilisateur (ex. cert:<id>:expiry:30) */
  dedupeKey?: string;
  mandatory?: boolean;
  /** Envoi e-mail en plus de la notification plateforme */
  email?: boolean;
  /**
   * Permission que le destinataire doit posséder (avec accès au navire `vesselId`) :
   * jamais de notification à un destinataire sans droit réel (CDC §9).
   */
  requiredPermission: string;
  /** Exclure certains utilisateurs (ex. le demandeur lui-même) */
  excludeUserIds?: string[];
}

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger('Notifications');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly email: EmailService,
  ) {}

  /** Résout users / rôles / départements (actifs) en identifiants utilisateurs dédupliqués. */
  async resolvePrincipals(principals: Principal[], db: Db = this.prisma): Promise<string[]> {
    const ids = new Set<string>();
    const roleIds = principals.filter((p) => p.type === 'ROLE').map((p) => p.id);
    const deptIds = principals.filter((p) => p.type === 'DEPARTMENT').map((p) => p.id);
    principals.filter((p) => p.type === 'USER').forEach((p) => ids.add(p.id));
    if (roleIds.length) {
      const rows = await db.userRole.findMany({ where: { roleId: { in: roleIds } }, select: { userId: true } });
      rows.forEach((r) => ids.add(r.userId));
    }
    if (deptIds.length) {
      const rows = await db.departmentMembership.findMany({
        where: { departmentId: { in: deptIds }, department: { status: 'ACTIVE' } },
        select: { userId: true },
      });
      rows.forEach((r) => ids.add(r.userId));
    }
    return [...ids];
  }

  /**
   * Crée les notifications plateforme (+ e-mails) pour les destinataires AUTORISÉS uniquement.
   * Déduplication par (user, dedupeKey). Retourne les destinataires effectivement notifiés.
   */
  async notify(input: NotifyInput, db: Db = this.prisma): Promise<string[]> {
    const candidates = new Set<string>(input.userIds ?? []);
    if (input.principals?.length) (await this.resolvePrincipals(input.principals, db)).forEach((id) => candidates.add(id));
    input.excludeUserIds?.forEach((id) => candidates.delete(id));
    if (!candidates.size) return [];

    // Filtrage sur droits réels + scope navire (même si membre du département destinataire)
    const allowed = await this.access.usersWithPermission(
      input.requiredPermission,
      input.vesselId ?? null,
      db,
      [...candidates],
    );
    if (!allowed.length) return [];

    const notified: string[] = [];
    for (const userId of allowed) {
      if (input.dedupeKey) {
        const exists = await db.notification.findUnique({
          where: { userId_dedupeKey: { userId, dedupeKey: input.dedupeKey } },
          select: { id: true },
        });
        if (exists) continue;
      }
      const n = await db.notification.create({
        data: {
          userId,
          type: input.type,
          title: input.title.slice(0, 250),
          body: input.body ?? null,
          priority: input.priority ?? 'NORMAL',
          module: input.module,
          entityType: input.entityType ?? null,
          entityId: input.entityId ?? null,
          vesselId: input.vesselId ?? null,
          link: input.link ?? null,
          dedupeKey: input.dedupeKey ?? null,
          isMandatory: input.mandatory ?? false,
        },
        include: { user: { select: { email: true, displayName: true, status: true } } },
      });
      notified.push(userId);
      if (input.email && n.user.email) {
        const url = input.link ? `${env().APP_BASE_URL}${input.link}` : env().APP_BASE_URL;
        await this.email.queueEmail(
          {
            to: n.user.email,
            subject: `AMC — ${input.title}`.slice(0, 300),
            text: `Bonjour ${n.user.displayName},\n\n${input.title}\n${input.body ?? ''}\n\nOuvrir dans la plateforme (connexion requise) : ${url}\n\n— Plateforme AMC`,
            notificationId: n.id,
          },
          db,
        );
      }
    }
    return notified;
  }

  /** Variante non bloquante pour les effets secondaires après commit. */
  notifyAsync(input: NotifyInput): void {
    this.notify(input).catch((e) => this.logger.error(`Notification ${input.type} échouée: ${String(e)}`));
  }

  async list(ctx: AuthContext, opts: { unreadOnly?: boolean; limit: number; cursor?: string }) {
    const items = await this.prisma.notification.findMany({
      where: { userId: ctx.userId, ...(opts.unreadOnly ? { readAt: null } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
      include: { deliveries: { select: { status: true, sentAt: true, lastError: true } } },
    });
    const hasMore = items.length > opts.limit;
    const page = hasMore ? items.slice(0, opts.limit) : items;
    return { items: page, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  async unreadCount(ctx: AuthContext) {
    const [unread, urgent] = await Promise.all([
      this.prisma.notification.count({ where: { userId: ctx.userId, readAt: null } }),
      this.prisma.notification.count({
        where: { userId: ctx.userId, readAt: null, priority: { in: ['HIGH', 'CRITICAL'] } },
      }),
    ]);
    return { unread, urgent };
  }

  async markRead(ctx: AuthContext, id: string, read: boolean) {
    const n = await this.prisma.notification.findFirst({ where: { id, userId: ctx.userId } });
    if (!n) throw Errors.notFound('Notification');
    return this.prisma.notification.update({ where: { id }, data: { readAt: read ? new Date() : null } });
  }

  async markAllRead(ctx: AuthContext) {
    // Les alertes obligatoires restent visibles (resolvedAt) même lues (CDC V1 §12.1)
    const res = await this.prisma.notification.updateMany({
      where: { userId: ctx.userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { updated: res.count };
  }

  /** Clôture des alertes obligatoires liées à une entité une fois la cause résolue. */
  async resolveForEntity(entityType: string, entityId: string, typePrefix?: string, db: Db = this.prisma) {
    await db.notification.updateMany({
      where: { entityType, entityId, resolvedAt: null, ...(typePrefix ? { type: { startsWith: typePrefix } } : {}) },
      data: { resolvedAt: new Date() },
    });
  }
}
