import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { QUEUES } from '../jobs/queues';
import { NotificationsService } from '../notifications/notifications.service';
import { AntivirusService } from './antivirus.service';
import { FilesService, ORPHAN_TTL_HOURS } from './files.service';
import { StorageService } from './storage.service';

/**
 * Worker fichiers :
 *  - scan : quarantaine -> analyse clamd -> promotion vers le bucket officiel (ou maintien en quarantaine)
 *  - cleanup-orphans : dépôts jamais rattachés au-delà de 24 h (traçé dans l'audit)
 */
@Processor(QUEUES.FILES)
export class FilesProcessor extends WorkerHost {
  private readonly logger = new Logger('FilesWorker');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly antivirus: AntivirusService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<{ fileId?: string }>): Promise<unknown> {
    if (job.name === 'scan' && job.data.fileId) return this.scan(job.data.fileId, job);
    if (job.name === 'cleanup-orphans') return this.cleanupOrphans();
    return null;
  }

  private async scan(fileId: string, job: Job) {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file || file.scanStatus !== 'PENDING') return { skipped: true };
    const buffer = await this.storage.buffer(file.bucket, file.objectKey);

    let verdict;
    try {
      verdict = await this.antivirus.scan(buffer);
    } catch (e) {
      // Retry BullMQ ; après la dernière tentative le statut passe à ERROR (fichier indisponible)
      const isLastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      if (isLastAttempt) {
        await this.prisma.storedFile.update({
          where: { id: fileId },
          data: { scanStatus: 'ERROR', scanDetail: String(e).slice(0, 400), scannedAt: new Date() },
        });
      }
      throw e;
    }

    if (verdict.status === 'INFECTED') {
      await this.prisma.storedFile.update({
        where: { id: fileId },
        data: { scanStatus: 'INFECTED', scanDetail: verdict.detail, scannedAt: new Date() },
      });
      await this.audit.system({
        action: 'file.infected',
        module: 'platform',
        entityType: 'file',
        entityId: fileId,
        vesselId: file.vesselId,
        result: 'FAILURE',
        metadata: { signature: verdict.detail, sha256: file.sha256 },
      });
      if (file.uploadedById) {
        await this.notifications.notify({
          userIds: [file.uploadedById],
          type: 'file.infected',
          title: `Fichier « ${file.originalName} » mis en quarantaine`,
          body: `Menace détectée : ${verdict.detail}. Le fichier ne sera pas utilisable.`,
          module: 'platform',
          entityType: 'file',
          entityId: fileId,
          priority: 'HIGH',
          requiredPermission: 'files.upload',
          email: true,
        });
      }
      return { status: 'INFECTED' };
    }

    // Sain (ou SKIPPED) : promotion quarantaine -> bucket officiel, clé objet inchangée
    if (file.bucket === this.storage.buckets.quarantine) {
      await this.storage.copy(file.bucket, file.objectKey, this.storage.buckets.files);
      await this.storage.remove(file.bucket, file.objectKey);
    }
    const thumbnailKey = file.kind === 'IMAGE' ? await this.files.makeThumbnail(buffer, file.id) : null;
    await this.prisma.storedFile.update({
      where: { id: fileId },
      data: {
        bucket: this.storage.buckets.files,
        scanStatus: verdict.status,
        scanDetail: verdict.detail,
        scannedAt: new Date(),
        thumbnailKey,
      },
    });
    return { status: verdict.status };
  }

  private async cleanupOrphans() {
    const cutoff = new Date(Date.now() - ORPHAN_TTL_HOURS * 3_600_000);
    const orphans = await this.prisma.storedFile.findMany({
      where: { ownerId: null, deletedAt: null, createdAt: { lt: cutoff }, context: { notIn: ['EXPORT', 'GENERATED'] } },
      take: 500,
    });
    for (const f of orphans) {
      try {
        await this.storage.remove(f.bucket, f.objectKey);
        if (f.thumbnailKey) await this.storage.remove(this.storage.buckets.files, f.thumbnailKey);
        await this.prisma.storedFile.update({ where: { id: f.id }, data: { deletedAt: new Date() } });
        await this.audit.system({
          action: 'file.orphan_purged',
          module: 'platform',
          entityType: 'file',
          entityId: f.id,
          vesselId: f.vesselId,
          metadata: { originalName: f.originalName, sha256: f.sha256, uploadedById: f.uploadedById },
        });
      } catch (e) {
        this.logger.warn(`Purge orphelin ${f.id} impossible : ${String(e)}`);
      }
    }
    return { purged: orphans.length };
  }
}
