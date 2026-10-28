import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { QUEUES } from '../jobs/queues';
import { CSO_ZIP_JOB, CsoZipService } from './cso-zip.service';

/**
 * Worker de la file « exports » pour les archives CSO (job « cso-zip »). Enregistré uniquement si
 * WORKERS_ENABLED. Un job d'un autre module reçu ici est rejeté (relance BullMQ) plutôt qu'acquitté,
 * afin de ne jamais le perdre si un autre worker partage la file.
 */
@Processor(QUEUES.EXPORTS)
export class CsoZipProcessor extends WorkerHost {
  private readonly logger = new Logger('CsoZipWorker');

  constructor(private readonly zip: CsoZipService) {
    super();
  }

  async process(job: Job<{ jobId?: string }>): Promise<unknown> {
    if (job.name !== CSO_ZIP_JOB) {
      throw new Error(`Job ${job.name} non géré par le worker CSO (file partagée « ${QUEUES.EXPORTS} »)`);
    }
    if (!job.data.jobId) return { skipped: true };
    this.logger.log(`Génération ZIP ${job.data.jobId}`);
    return this.zip.process(job.data.jobId);
  }
}
