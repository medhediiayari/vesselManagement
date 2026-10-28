import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuditService } from '../audit/audit.service';
import { SCHEDULED_JOBS } from '../jobs/queues';
import { SchedulerRegistry } from '../jobs/scheduler.service';
import { NotificationsService } from '../notifications/notifications.service';
import { LINKS } from './purchasing.constants';
import { PR_NOT_ORDERED_STATUSES } from './purchasing.logic';

/**
 * Relances Achats planifiées (SCHEDULED_JOBS.PURCHASING_FOLLOWUP, 06:30 UTC) :
 *  - PR dont la date needed_by est dépassée et non (entièrement) commandées ;
 *  - BC envoyés / partiellement reçus en retard sur la date de livraison attendue ;
 *  - BC partiellement reçus avec écarts ouverts.
 * Destinataires : acheteurs du navire (bc.create / variances.manage), filtrés sur droits réels + scope ;
 * clés de déduplication => une seule alerte par événement.
 */
@Injectable()
export class PurchasingFollowupService implements OnModuleInit {
  private readonly logger = new Logger('PurchasingFollowup');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
    private readonly scheduler: SchedulerRegistry,
    private readonly audit: AuditService,
  ) {}

  onModuleInit(): void {
    this.scheduler.register(SCHEDULED_JOBS.PURCHASING_FOLLOWUP, () => this.run());
  }

  async run(now = new Date()): Promise<Record<string, number>> {
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const cache = new Map<string, string[]>();
    const usersFor = async (permission: string, vesselId: string) => {
      const k = `${permission}:${vesselId}`;
      if (!cache.has(k)) cache.set(k, await this.access.usersWithPermission(permission, vesselId));
      return cache.get(k)!;
    };
    const stats = { overduePrs: 0, latePos: 0, posWithOpenVariances: 0, notifications: 0 };

    const prs = await this.prisma.purchaseRequest.findMany({
      where: { neededBy: { lt: today }, status: { in: [...PR_NOT_ORDERED_STATUSES] } },
      select: { id: true, number: true, subject: true, vesselId: true, neededBy: true, status: true },
    });
    for (const pr of prs) {
      stats.overduePrs++;
      const userIds = [...new Set([...(await usersFor('bc.create', pr.vesselId)), ...(await usersFor('pr.approve', pr.vesselId))])];
      const due = pr.neededBy!.toISOString().slice(0, 10);
      const n = await this.notifications.notify({
        userIds,
        type: 'purchasing.pr_overdue',
        title: `PR ${pr.number} : besoin au ${due} non commandé (${pr.status})`,
        body: pr.subject,
        module: 'purchasing',
        entityType: 'purchase_request',
        entityId: pr.id,
        vesselId: pr.vesselId,
        link: LINKS.pr(pr.id),
        priority: 'HIGH',
        dedupeKey: `pr:${pr.id}:overdue:${due}`,
        email: true,
        requiredPermission: 'pr.view',
      });
      stats.notifications += n.length;
    }

    const late = await this.prisma.purchaseOrder.findMany({
      where: { status: { in: ['SENT', 'PARTIALLY_RECEIVED'] }, expectedDeliveryDate: { lt: today } },
      select: { id: true, number: true, vesselId: true, expectedDeliveryDate: true, status: true, supplier: { select: { name: true } } },
    });
    for (const po of late) {
      stats.latePos++;
      const userIds = [...new Set([...(await usersFor('bc.create', po.vesselId)), ...(await usersFor('variances.manage', po.vesselId))])];
      const due = po.expectedDeliveryDate!.toISOString().slice(0, 10);
      const n = await this.notifications.notify({
        userIds,
        type: 'purchasing.po_late',
        title: `BC ${po.number} (${po.supplier.name}) : livraison attendue le ${due} non soldée`,
        body: `Statut : ${po.status}`,
        module: 'purchasing',
        entityType: 'purchase_order',
        entityId: po.id,
        vesselId: po.vesselId,
        link: LINKS.po(po.id),
        priority: 'HIGH',
        dedupeKey: `po:${po.id}:late:${due}`,
        email: true,
        requiredPermission: 'bc.view',
      });
      stats.notifications += n.length;
    }

    const withVariances = await this.prisma.purchaseOrder.findMany({
      where: { status: 'PARTIALLY_RECEIVED', variances: { some: { status: { in: ['OPEN', 'IN_PROGRESS'] } } } },
      select: { id: true, number: true, vesselId: true, _count: { select: { variances: { where: { status: { in: ['OPEN', 'IN_PROGRESS'] } } } } } },
    });
    for (const po of withVariances) {
      stats.posWithOpenVariances++;
      const userIds = await usersFor('variances.manage', po.vesselId);
      const open = po._count.variances;
      const n = await this.notifications.notify({
        userIds,
        type: 'purchasing.po_open_variances',
        title: `BC ${po.number} partiellement reçu : ${open} écart(s) ouvert(s) à traiter`,
        module: 'purchasing',
        entityType: 'purchase_order',
        entityId: po.id,
        vesselId: po.vesselId,
        link: LINKS.po(po.id),
        dedupeKey: `po:${po.id}:open-variances:${open}:${today.toISOString().slice(0, 7)}`,
        email: true,
        requiredPermission: 'receiving.view',
      });
      stats.notifications += n.length;
    }

    await this.audit.system({ action: 'purchasing.followup_run', module: 'purchasing', entityType: 'job', entityId: SCHEDULED_JOBS.PURCHASING_FOLLOWUP, metadata: stats });
    this.logger.log(`Relances achats : ${JSON.stringify(stats)}`);
    return stats;
  }
}
