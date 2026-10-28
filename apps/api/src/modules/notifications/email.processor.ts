import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUES } from '../jobs/queues';
import { EmailService } from './email.service';

/** Worker e-mail : un échec relance le job (backoff exponentiel), statut tracé à chaque tentative. */
@Processor(QUEUES.EMAIL)
export class EmailProcessor extends WorkerHost {
  constructor(private readonly email: EmailService) {
    super();
  }

  async process(job: Job<{ deliveryId: string }>): Promise<void> {
    const res = await this.email.deliver(job.data.deliveryId);
    if (res.status === 'FAILED') throw new Error(res.error ?? 'Échec envoi e-mail');
  }
}
