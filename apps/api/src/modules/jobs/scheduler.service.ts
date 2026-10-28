import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { QUEUES, SCHEDULED_JOBS } from './queues';

export type ScheduledHandler = () => Promise<Record<string, unknown> | void>;

/**
 * Registre des tâches planifiées (rappels certificats, CSO, achats, notices voyage…).
 * Les modules métier enregistrent leur handler ; BullMQ garantit une exécution unique
 * par occurrence même avec plusieurs instances API (jobId de répétition stable).
 */
@Injectable()
export class SchedulerRegistry {
  private readonly handlers = new Map<string, ScheduledHandler>();

  register(name: string, handler: ScheduledHandler) {
    this.handlers.set(name, handler);
  }

  get(name: string) {
    return this.handlers.get(name);
  }
}

const SCHEDULES: { name: string; pattern?: string; every?: number }[] = [
  { name: SCHEDULED_JOBS.CERTIFICATE_REMINDERS, pattern: '0 6 * * *' },
  { name: SCHEDULED_JOBS.CSO_REMINDERS, pattern: '15 6 * * *' },
  { name: SCHEDULED_JOBS.PURCHASING_FOLLOWUP, pattern: '30 6 * * *' },
  { name: SCHEDULED_JOBS.VOYAGE_NOTICES, pattern: '0 * * * *' },
  { name: SCHEDULED_JOBS.ORPHAN_FILES_CLEANUP, pattern: '0 3 * * *' },
];

@Injectable()
export class SchedulerBootstrap implements OnApplicationBootstrap {
  private readonly logger = new Logger('Scheduler');

  constructor(
    @InjectQueue(QUEUES.SCHEDULER) private readonly scheduler: Queue,
    @InjectQueue(QUEUES.FILES) private readonly files: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!env().WORKERS_ENABLED) return;
    for (const s of SCHEDULES) {
      if (s.name === SCHEDULED_JOBS.ORPHAN_FILES_CLEANUP) {
        await this.files.add('cleanup-orphans', {}, { repeat: { pattern: s.pattern, tz: 'UTC' }, jobId: s.name });
        continue;
      }
      await this.scheduler.add(s.name, {}, { repeat: { pattern: s.pattern, tz: 'UTC' }, jobId: s.name });
    }
    this.logger.log(`Tâches planifiées enregistrées : ${SCHEDULES.map((s) => s.name).join(', ')}`);
  }

  /** Déclenchement manuel (administration / tests de recette). */
  async runNow(name: string) {
    return this.scheduler.add(name, { manual: true }, { removeOnComplete: true });
  }
}

@Processor(QUEUES.SCHEDULER)
export class SchedulerProcessor extends WorkerHost {
  private readonly logger = new Logger('SchedulerWorker');

  constructor(
    private readonly registry: SchedulerRegistry,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    const handler = this.registry.get(job.name);
    if (!handler) {
      this.logger.warn(`Aucun handler pour la tâche ${job.name}`);
      return { skipped: true };
    }
    const run = await this.prisma.jobRun.create({ data: { jobName: job.name, status: 'RUNNING' } });
    try {
      const detail = (await handler()) ?? {};
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', finishedAt: new Date(), detail: detail as never },
      });
      return detail;
    } catch (e) {
      await this.prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', finishedAt: new Date(), detail: { error: String(e).slice(0, 1000) } },
      });
      throw e;
    }
  }
}
