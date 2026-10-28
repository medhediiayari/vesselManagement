import { Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { env } from '../../config/env';
import { Auth, RequirePermissions } from '../../common/decorators';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { SchedulerBootstrap } from '../jobs/scheduler.service';
import { SCHEDULED_JOBS } from '../jobs/queues';
import { StorageService } from '../files/storage.service';

/**
 * État d'exploitation (CDC §13.2 runbooks) : dépendances, derniers jobs, e-mails, antivirus,
 * volumétrie des fichiers. Aucune donnée métier ni secret n'est exposé.
 */
@ApiTags('Admin — System')
@Controller('system')
export class SystemController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly scheduler: SchedulerBootstrap,
    private readonly audit: AuditService,
  ) {}

  @Get('status')
  @RequirePermissions('settings.manage')
  async status() {
    const checks: Record<string, string> = {};
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      checks.database = 'up';
    } catch {
      checks.database = 'down';
    }
    try {
      await this.storage.ping();
      checks.objectStorage = 'up';
    } catch {
      checks.objectStorage = 'down';
    }
    const [jobs, emails, scans, files, failedEmails, migrations] = await Promise.all([
      this.prisma.$queryRaw<{ job_name: string; status: string; started_at: Date; finished_at: Date | null; detail: unknown }[]>`
        SELECT DISTINCT ON (job_name) job_name, status, started_at, finished_at, detail
        FROM job_runs ORDER BY job_name, started_at DESC`,
      this.prisma.emailDelivery.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.storedFile.groupBy({ by: ['scanStatus'], where: { deletedAt: null }, _count: { _all: true } }),
      this.prisma.storedFile.groupBy({ by: ['kind'], where: { deletedAt: null }, _count: { _all: true }, _sum: { sizeBytes: true } }),
      this.prisma.emailDelivery.findMany({
        where: { status: 'FAILED' },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, toAddress: true, subject: true, attempts: true, lastError: true, createdAt: true },
      }),
      this.prisma.$queryRaw<{ migration_name: string; finished_at: Date | null }[]>`
        SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY started_at`,
    ]);
    return {
      checks,
      configuration: {
        antivirus: env().AV_MODE,
        email: env().EMAIL_MODE,
        fileDelivery: env().FILE_DELIVERY_MODE,
        signedUrlTtlSeconds: env().SIGNED_URL_TTL_SECONDS,
        workersEnabled: env().WORKERS_ENABLED,
        buckets: this.storage.buckets,
      },
      scheduledJobs: Object.values(SCHEDULED_JOBS).map((name) => {
        const last = jobs.find((j) => j.job_name === name);
        return { name, lastRun: last ?? null };
      }),
      emails: Object.fromEntries(emails.map((e) => [e.status, e._count._all])),
      failedEmails,
      fileScans: Object.fromEntries(scans.map((s) => [s.scanStatus, s._count._all])),
      filesByKind: files.map((f) => ({ kind: f.kind, count: f._count._all, bytes: Number(f._sum.sizeBytes ?? 0) })),
      migrations,
    };
  }

  /** Déclenchement manuel d'une tâche planifiée (recette / reprise après incident). */
  @Post('jobs/:name/run')
  @RequirePermissions('settings.manage')
  async run(@Auth() ctx: AuthContext, @Param('name') name: string) {
    if (!(Object.values(SCHEDULED_JOBS) as string[]).includes(name) || name === SCHEDULED_JOBS.ORPHAN_FILES_CLEANUP) {
      throw Errors.validation('Tâche inconnue ou non déclenchable');
    }
    const job = await this.scheduler.runNow(name);
    await this.audit.record(ctx, { action: 'system.job_triggered', module: 'admin', entityType: 'job', entityId: name });
    return { queued: true, jobId: job.id };
  }
}
