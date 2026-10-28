import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { CsoDocument } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { SCHEDULED_JOBS } from '../jobs/queues';
import { SchedulerRegistry } from '../jobs/scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CsoAccessService } from './cso-access.service';
import { PENDING_REMINDER_HOURS, daysUntil, dueBucket, pendingBucket } from './cso-rules';

const BUCKET_LABEL = { D30: 'dans moins de 30 jours', D7: 'dans moins de 7 jours', OVERDUE: 'dépassée' } as const;
const DATE_LABEL = { nextReviewOn: 'Révision', expiryOn: 'Expiration' } as const;

/**
 * Rappels CSO (CSO-012) — tâche planifiée SCHEDULED_JOBS.CSO_REMINDERS :
 *  - dates de prochaine révision et d'expiration (alertes distinctes) à 30 j, 7 j et dépassées ;
 *  - versions en attente d'approbation depuis plus de 48 h (relance toutes les 48 h).
 * Destinataires : auteur + validateurs du dossier, filtrés sur leurs droits RÉELS (permission,
 * scope navire, ACL du document) ; déduplication par clé (document, date, seuil).
 */
@Injectable()
export class CsoRemindersService implements OnModuleInit {
  private readonly logger = new Logger('CsoReminders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    private readonly csoAccess: CsoAccessService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register(SCHEDULED_JOBS.CSO_REMINDERS, () => this.run());
  }

  async run(now = new Date()): Promise<Record<string, unknown>> {
    const ctxCache = new Map<string, AuthContext | null>();
    const stats = { reviewReminders: 0, expiryReminders: 0, pendingReminders: 0, documentsScanned: 0, versionsScanned: 0 };
    const horizon = new Date(now.getTime() + 31 * 86_400_000);

    // 1. Échéances de révision / expiration des documents publiés
    const docs = await this.prisma.csoDocument.findMany({
      where: { status: 'PUBLISHED', OR: [{ nextReviewOn: { lte: horizon } }, { expiryOn: { lte: horizon } }] },
    });
    stats.documentsScanned = docs.length;
    for (const doc of docs) {
      for (const field of ['nextReviewOn', 'expiryOn'] as const) {
        const due = doc[field];
        if (!due) continue;
        const bucket = dueBucket(due, now);
        if (!bucket) continue;
        try {
          const recipients = await this.recipients(doc, 'view', ctxCache);
          if (!recipients.length) continue;
          const days = daysUntil(due, now);
          const notified = await this.notifications.notify({
            userIds: recipients,
            type: field === 'expiryOn' ? 'cso.document_expiry' : 'cso.document_review',
            title: `${DATE_LABEL[field]} ${BUCKET_LABEL[bucket]} : ${doc.reference ?? doc.title}`,
            body: `${DATE_LABEL[field]} prévue le ${due.toISOString().slice(0, 10)} (${days >= 0 ? `J-${days}` : `dépassée de ${-days} j`}).`,
            module: 'cso',
            entityType: 'cso_document',
            entityId: doc.id,
            vesselId: doc.vesselId,
            link: `/cso/documents/${doc.id}`,
            priority: bucket === 'OVERDUE' ? 'HIGH' : bucket === 'D7' ? 'NORMAL' : 'LOW',
            dedupeKey: `cso:${doc.id}:${field}:${due.toISOString().slice(0, 10)}:${bucket}`,
            email: bucket !== 'D30',
            requiredPermission: 'cso.view',
          });
          if (field === 'expiryOn') stats.expiryReminders += notified.length;
          else stats.reviewReminders += notified.length;
        } catch (e) {
          this.logger.error(`Rappel ${field} ${doc.id} : ${String(e)}`);
        }
      }
    }

    // 2. Versions en attente d'approbation > 48 h
    const pending = await this.prisma.csoVersion.findMany({
      where: { status: 'PENDING_APPROVAL', submittedAt: { lte: new Date(now.getTime() - PENDING_REMINDER_HOURS * 3_600_000) } },
      include: { document: true },
    });
    stats.versionsScanned = pending.length;
    for (const v of pending) {
      const slot = pendingBucket(v.submittedAt!, now);
      if (slot === null || v.document.status === 'ARCHIVED') continue;
      try {
        const doc = v.document;
        const folder = await this.prisma.csoFolder.findUniqueOrThrow({ where: { id: doc.folderId }, select: { path: true } });
        const config = await this.csoAccess.validatorsFor(folder.path);
        const candidates = await this.csoAccess.validatorCandidates(config, doc.vesselId);
        const validators = await this.csoAccess.usersAllowedOnDocument(
          candidates,
          doc,
          'approve',
          { validators: config, excludeUserIds: [v.submittedById] },
          this.prisma,
          ctxCache,
        );
        const author = await this.csoAccess.usersAllowedOnDocument([doc.authorId, v.submittedById], doc, 'view', {}, this.prisma, ctxCache);
        const hours = Math.floor((now.getTime() - v.submittedAt!.getTime()) / 3_600_000);
        const common = {
          module: 'cso',
          entityType: 'cso_document',
          entityId: doc.id,
          vesselId: doc.vesselId,
          link: `/cso/documents/${doc.id}`,
          dedupeKey: `cso:version:${v.id}:pending48h:${slot}`,
          email: true,
        };
        if (validators.length) {
          stats.pendingReminders += (
            await this.notifications.notify({
              ...common,
              userIds: validators,
              type: 'cso.version_pending_reminder',
              title: `Approbation en attente depuis ${hours} h : ${doc.reference ?? doc.title} (v${v.versionNo})`,
              priority: 'HIGH',
              requiredPermission: 'cso.approve',
            })
          ).length;
        }
        if (author.length) {
          stats.pendingReminders += (
            await this.notifications.notify({
              ...common,
              userIds: author,
              type: 'cso.version_pending_author',
              title: `Votre version v${v.versionNo} attend une approbation depuis ${hours} h : ${doc.reference ?? doc.title}`,
              priority: 'NORMAL',
              requiredPermission: 'cso.view',
            })
          ).length;
        }
      } catch (e) {
        this.logger.error(`Relance version ${v.id} : ${String(e)}`);
      }
    }
    return stats;
  }

  /** Auteur + validateurs applicables, filtrés sur le droit réel de voir le document. */
  private async recipients(doc: CsoDocument, action: 'view', cache: Map<string, AuthContext | null>): Promise<string[]> {
    const folder = await this.prisma.csoFolder.findUniqueOrThrow({ where: { id: doc.folderId }, select: { path: true } });
    const config = await this.csoAccess.validatorsFor(folder.path);
    const validators = config ? await this.csoAccess.validatorCandidates(config, doc.vesselId) : [];
    return this.csoAccess.usersAllowedOnDocument([doc.authorId, ...validators], doc, action, {}, this.prisma, cache);
  }
}
