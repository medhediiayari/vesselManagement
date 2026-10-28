import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { SCHEDULED_JOBS } from '../jobs/queues';
import { SchedulerRegistry } from '../jobs/scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CertificateAccessService } from './certificate-access.service';
import {
  REMINDER_NOTIFICATION_TYPES,
  REQUEST_KIND_LABELS,
  ReminderAlert,
  ReminderAlertKind,
  approvalPermissionFor,
  certificateLink,
  decideApprovalOverdue,
  decideCertificateReminders,
  isoDay,
  subjectLabel,
  utcDay,
} from './certificate.logic';

const BATCH = 200;

const CERT_SELECT = {
  id: true,
  subjectKind: true,
  vesselId: true,
  memberId: true,
  currentExpiryKind: true,
  currentExpiryOn: true,
  documentMissing: true,
  renewalStatus: true,
  renewalOwnerId: true,
  currentRevision: { select: { revisionNo: true, approvedAt: true } },
  vessel: { select: { name: true } },
  member: { select: { firstName: true, lastName: true } },
  type: {
    select: {
      name: true,
      requiresDocument: true,
      reminderPolicy: { include: { recipients: { select: { principalType: true, principalId: true } } } },
    },
  },
} satisfies Prisma.CertificateSelect;

export interface ReminderRunStats {
  [key: string]: unknown;
  asOf: string;
  certificatesScanned: number;
  certificatesWithoutPolicy: number;
  alerts: Record<ReminderAlertKind, number>;
  notificationsCreated: number;
  approvalReminders: number;
  escalations: number;
  errors: number;
}

/**
 * Rappels certificats (CDC §4.5, V1 §7.4 ; ADM-044..047, 056, 063, 065) — job planifié
 * `SCHEDULED_JOBS.CERTIFICATE_REMINDERS` (quotidien) et déclenchement manuel (recette).
 *  - échéance / expiration / date inconnue / pièce manquante selon la politique du type ;
 *  - validations en attente au-delà du délai : rappel aux validateurs éligibles + escalade unique ;
 *  - destinataires = principaux de la politique (+ responsable du renouvellement) filtrés sur
 *    leurs droits réels et le scope (navire / ADM-070) ; plateforme + e-mail ;
 *  - idempotent : clés de déduplication par (certificat, révision, nature, seuil / tranche).
 */
@Injectable()
export class CertificateRemindersService implements OnModuleInit {
  private readonly logger = new Logger('CertificateReminders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: SchedulerRegistry,
    private readonly notifications: NotificationsService,
    private readonly certAccess: CertificateAccessService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register(SCHEDULED_JOBS.CERTIFICATE_REMINDERS, () => this.run());
  }

  /** POST /certificates/reminders/run — exécution manuelle tracée (job_runs + audit). */
  async runManually(ctx: AuthContext) {
    const jobRun = await this.prisma.jobRun.create({
      data: { jobName: SCHEDULED_JOBS.CERTIFICATE_REMINDERS, status: 'RUNNING', detail: { manual: true, by: ctx.userId } },
    });
    try {
      const stats = await this.run();
      await this.prisma.jobRun.update({
        where: { id: jobRun.id },
        data: { status: stats.errors ? 'PARTIALLY_FAILED' : 'COMPLETED', finishedAt: new Date(), detail: stats as unknown as Prisma.InputJsonValue },
      });
      await this.audit.record(ctx, {
        action: 'certificate.reminders_triggered',
        module: 'certificates',
        entityType: 'job_run',
        entityId: jobRun.id,
        metadata: stats,
      });
      return { jobRunId: jobRun.id, ...stats };
    } catch (e) {
      await this.prisma.jobRun.update({
        where: { id: jobRun.id },
        data: { status: 'FAILED', finishedAt: new Date(), detail: { error: String(e).slice(0, 1000) } },
      });
      throw e;
    }
  }

  async run(now: Date = new Date()): Promise<ReminderRunStats> {
    const stats: ReminderRunStats = {
      asOf: isoDay(now),
      certificatesScanned: 0,
      certificatesWithoutPolicy: 0,
      alerts: { EXPIRY: 0, EXPIRED: 0, UNKNOWN_EXPIRY: 0, MISSING_DOCUMENT: 0 },
      notificationsCreated: 0,
      approvalReminders: 0,
      escalations: 0,
      errors: 0,
    };
    await this.certificateAlerts(utcDay(now), stats);
    await this.approvalAlerts(now, stats);
    await this.audit.system({ action: 'certificate.reminders_run', module: 'certificates', entityType: 'job', metadata: stats });
    this.logger.log(`Rappels certificats : ${JSON.stringify(stats)}`);
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Échéances, dates inconnues, pièces manquantes
  // ---------------------------------------------------------------------------

  private async certificateAlerts(today: Date, stats: ReminderRunStats) {
    const recipientsByPolicy = new Map<string, string[]>();
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.certificate.findMany({
        where: { archivedAt: null, currentRevisionId: { not: null } },
        select: CERT_SELECT,
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!batch.length) break;
      cursor = batch[batch.length - 1].id;

      for (const cert of batch) {
        stats.certificatesScanned++;
        const policy = cert.type.reminderPolicy;
        if (!policy || !cert.currentRevision || !cert.currentExpiryKind) {
          stats.certificatesWithoutPolicy++;
          continue;
        }
        const alerts = decideCertificateReminders(
          policy,
          {
            certificateId: cert.id,
            revisionNo: cert.currentRevision.revisionNo,
            expiryKind: cert.currentExpiryKind,
            expiryOn: cert.currentExpiryOn,
            documentMissing: cert.documentMissing,
            requiresDocument: cert.type.requiresDocument,
            renewalStatus: cert.renewalStatus,
            anchorDate: cert.currentRevision.approvedAt,
          },
          today,
        );
        if (!alerts.length) continue;
        try {
          let policyRecipients = recipientsByPolicy.get(policy.id);
          if (!policyRecipients) {
            policyRecipients = await this.notifications.resolvePrincipals(
              policy.recipients.map((r) => ({ type: r.principalType, id: r.principalId })),
            );
            recipientsByPolicy.set(policy.id, policyRecipients);
          }
          // Responsable du renouvellement : informé aussi (le suivi ne suspend jamais les alertes — CERT-02)
          const candidates = cert.renewalOwnerId ? [...policyRecipients, cert.renewalOwnerId] : policyRecipients;
          const readers = await this.certAccess.filterReaders(this.prisma, cert, candidates);
          if (!readers.length) continue;
          for (const alert of alerts) {
            const notified = await this.notifications.notify({
              userIds: readers,
              type: REMINDER_NOTIFICATION_TYPES[alert.kind],
              ...this.alertText(alert, cert.type.name, subjectLabel(cert), cert.renewalStatus === 'IN_PROGRESS'),
              module: 'certificates',
              entityType: 'certificate',
              entityId: cert.id,
              vesselId: cert.vesselId,
              link: certificateLink(cert.id),
              priority: alert.priority,
              mandatory: alert.kind === 'EXPIRY' || alert.kind === 'EXPIRED',
              dedupeKey: alert.dedupeKey,
              email: true,
              requiredPermission: this.certAccess.readerPermission(cert),
            });
            if (notified.length) {
              stats.alerts[alert.kind]++;
              stats.notificationsCreated += notified.length;
            }
          }
        } catch (e) {
          stats.errors++;
          this.logger.error(`Rappel certificat ${cert.id} en échec : ${String(e)}`);
        }
      }
    }
  }

  private alertText(alert: ReminderAlert, typeName: string, subject: string, renewalInProgress: boolean) {
    const label = `${typeName} — ${subject}`;
    const renewal = renewalInProgress ? ' Renouvellement en cours : le certificat actuel reste la référence officielle.' : '';
    switch (alert.kind) {
      case 'EXPIRY':
        return {
          title:
            alert.daysToExpiry === 0
              ? `Certificat expirant aujourd'hui : ${label}`
              : `Certificat expirant dans ${alert.daysToExpiry} jour(s) : ${label}`,
          body: `Échéance à anticiper.${renewal}`,
        };
      case 'EXPIRED':
        return {
          title: `Certificat expiré : ${label}`,
          body: `Expiré depuis ${alert.daysOverdue} jour(s).${renewal}`,
        };
      case 'UNKNOWN_EXPIRY':
        return {
          title: `Date d'expiration à compléter : ${label}`,
          body: "La date d'expiration du certificat est inconnue : complétez-la par une demande de correction (aucune alerte d'échéance n'est émise tant qu'elle est inconnue).",
        };
      case 'MISSING_DOCUMENT':
        return {
          title: `Document officiel manquant : ${label}`,
          body: 'Aucun document officiel validé pour la révision courante : déposez le scan pour validation.',
        };
    }
  }

  // ---------------------------------------------------------------------------
  // Validations en attente (ADM-056)
  // ---------------------------------------------------------------------------

  private async approvalAlerts(now: Date, stats: ReminderRunStats) {
    const pending = await this.prisma.certificateApprovalRequest.findMany({
      where: {
        status: 'PENDING_APPROVAL',
        submittedAt: { not: null },
        certificate: { archivedAt: null, type: { reminderPolicy: { approvalOverdueHours: { not: null } } } },
      },
      include: {
        attachment: { select: { uploadedById: true } },
        certificate: {
          select: {
            id: true,
            subjectKind: true,
            vesselId: true,
            memberId: true,
            vessel: { select: { name: true } },
            member: { select: { firstName: true, lastName: true } },
            type: {
              select: {
                name: true,
                validators: { select: { principalType: true, principalId: true } },
                reminderPolicy: { select: { approvalOverdueHours: true, escalationRoleId: true } },
              },
            },
          },
        },
      },
    });

    for (const req of pending) {
      const cert = req.certificate;
      const policy = cert.type.reminderPolicy!;
      const decision = decideApprovalOverdue({
        requestId: req.id,
        version: req.version,
        submittedAt: req.submittedAt!,
        now,
        overdueHours: policy.approvalOverdueHours,
        alreadyEscalated: !!req.escalatedAt,
        escalationConfigured: !!policy.escalationRoleId,
      });
      if (!decision.remind) continue;
      const label = `${cert.type.name} — ${subjectLabel(cert)}`;
      const hours = decision.remind.hoursPending;
      try {
        const validators = await this.certAccess.eligibleValidatorIds(
          this.prisma,
          cert,
          { kind: req.kind, requestedById: req.requestedById, uploadedById: req.attachment?.uploadedById },
          cert.type.validators,
        );
        const notified = await this.notifications.notify({
          userIds: validators,
          type: 'certificate.approval_overdue',
          title: `Approbation de certificat en attente depuis ${hours} h : ${label}`,
          body: `Demande de ${REQUEST_KIND_LABELS[req.kind]} (version ${req.version}) en attente de décision.`,
          module: 'certificates',
          entityType: 'certificate_request',
          entityId: req.id,
          vesselId: cert.vesselId,
          link: certificateLink(cert.id, req.id),
          priority: 'HIGH',
          mandatory: true,
          dedupeKey: decision.remind.dedupeKey,
          email: true,
          requiredPermission: approvalPermissionFor(req.kind),
        });
        if (notified.length) {
          stats.approvalReminders++;
          stats.notificationsCreated += notified.length;
          await this.prisma.certificateApprovalRequest.update({ where: { id: req.id }, data: { lastReminderAt: now } });
        }

        if (decision.escalate && policy.escalationRoleId) {
          await this.prisma.$transaction(async (tx) => {
            // Escalade unique, même si deux exécutions se chevauchent
            const claimed = await tx.certificateApprovalRequest.updateMany({
              where: { id: req.id, escalatedAt: null, status: 'PENDING_APPROVAL' },
              data: { escalatedAt: now },
            });
            if (!claimed.count) return;
            const candidates = await this.notifications.resolvePrincipals([{ type: 'ROLE', id: policy.escalationRoleId! }], tx);
            const readers = await this.certAccess.filterReaders(tx, cert, candidates.filter((id) => id !== req.requestedById));
            const escalated = await this.notifications.notify(
              {
                userIds: readers,
                type: 'certificate.approval_escalated',
                title: `Escalade : approbation de certificat en retard (${hours} h) — ${label}`,
                body: `La demande de ${REQUEST_KIND_LABELS[req.kind]} attend une décision au-delà du délai de ${policy.approvalOverdueHours} h.`,
                module: 'certificates',
                entityType: 'certificate_request',
                entityId: req.id,
                vesselId: cert.vesselId,
                link: certificateLink(cert.id, req.id),
                priority: 'CRITICAL',
                mandatory: true,
                dedupeKey: `certreq:${req.id}:escalation`,
                email: true,
                requiredPermission: this.certAccess.readerPermission(cert),
              },
              tx,
            );
            await this.audit.system(
              {
                action: 'certificate.approval_escalated',
                module: 'certificates',
                entityType: 'certificate_request',
                entityId: req.id,
                vesselId: cert.vesselId,
                metadata: { certificateId: cert.id, hoursPending: hours, escalationRoleId: policy.escalationRoleId, recipients: escalated.length },
              },
              tx,
            );
            stats.escalations++;
            stats.notificationsCreated += escalated.length;
          });
        }
      } catch (e) {
        stats.errors++;
        this.logger.error(`Rappel d'approbation ${req.id} en échec : ${String(e)}`);
      }
    }
  }
}
