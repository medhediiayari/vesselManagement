import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { env } from '../../config/env';
import { QUEUES } from './queues';
import { SchedulerBootstrap, SchedulerProcessor, SchedulerRegistry } from './scheduler.service';

@Global()
@Module({
  imports: [
    BullModule.forRoot({
      connection: { url: env().REDIS_URL, maxRetriesPerRequest: null },
      prefix: 'amc',
    }),
    BullModule.registerQueue(
      { name: QUEUES.EMAIL },
      { name: QUEUES.SCHEDULER },
      { name: QUEUES.FILES },
      { name: QUEUES.IMPORTS },
      { name: QUEUES.EXPORTS },
    ),
  ],
  providers: [SchedulerRegistry, SchedulerBootstrap, ...(env().WORKERS_ENABLED ? [SchedulerProcessor] : [])],
  exports: [SchedulerRegistry, SchedulerBootstrap, BullModule],
})
export class JobsModule {}
