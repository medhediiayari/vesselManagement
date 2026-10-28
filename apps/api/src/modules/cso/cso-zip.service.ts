import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { CsoDocument, CsoFolder, CsoVersion, ExportJob } from '@prisma/client';
import archiver from 'archiver';
import { Queue } from 'bullmq';
import { once } from 'node:events';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { FilesService } from '../files/files.service';
import { DEFAULT_JOB_OPTIONS, QUEUES } from '../jobs/queues';
import { canAccessVersion } from './cso-acl.logic';
import { CsoAccessService, OWNER_EXPORT_JOB } from './cso-access.service';
import { documentFileName, sanitizeZipSegment, uniqueZipName, zipPath } from './cso-rules';
import type { ZipRequestDto } from './cso.dto';

export const CSO_ZIP_JOB = 'cso-zip';
/** Taille maximale des fichiers sources d'une archive (mémoire du worker). */
export const MAX_ZIP_SOURCE_BYTES = 512 * 1024 * 1024;
const ARCHIVE_DIR = '_versions_archivees';

interface ZipEntryPlan {
  path: string;
  fileId: string;
  documentId: string;
  versionId: string;
  sizeBytes: number;
  date: Date;
}

interface ZipParams {
  documentIds: string[];
  folderIds: string[];
  includeArchived: boolean;
}

/**
 * Téléchargement ZIP multi-documents / dossiers (CSO-023, CDC §5.3) : traitement asynchrone
 * (ExportJob + file BullMQ « exports »), droits revalidés PAR FICHIER au moment de la génération
 * (versions archivées uniquement avec droits archives), éléments non autorisés exclus sans
 * jamais être nommés (seul excludedCount est restitué), arborescence conservée, noms assainis
 * (anti zip-slip). Demande et contenu effectif audités.
 */
@Injectable()
export class CsoZipService {
  private readonly logger = new Logger('CsoZip');

  constructor(
    private readonly prisma: PrismaService,
    private readonly csoAccess: CsoAccessService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    @InjectQueue(QUEUES.EXPORTS) private readonly queue: Queue,
  ) {}

  async request(ctx: AuthContext, dto: ZipRequestDto) {
    const params: ZipParams = {
      documentIds: [...new Set(dto.documentIds)],
      folderIds: [...new Set(dto.folderIds)],
      includeArchived: dto.includeArchived,
    };
    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.exportJob.create({
        data: { format: 'ZIP', module: 'cso', resource: 'cso_documents', params: params as never, status: 'QUEUED', requestedById: ctx.userId },
      });
      await this.audit.record(
        ctx,
        { action: 'cso.zip.requested', module: 'cso', entityType: 'export_job', entityId: j.id, metadata: { ...params } },
        tx,
      );
      return j;
    });
    await this.queue.add(CSO_ZIP_JOB, { jobId: job.id }, { ...DEFAULT_JOB_OPTIONS, attempts: 3, jobId: `${CSO_ZIP_JOB}-${job.id}` });
    return this.present(job);
  }

  /** Statut + lien signé éphémère (demandeur uniquement ; téléchargement audité). */
  async status(ctx: AuthContext, jobId: string) {
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.module !== 'cso' || job.requestedById !== ctx.userId) throw Errors.notFound('Export');
    const ready = (job.status === 'COMPLETED' || job.status === 'PARTIALLY_FAILED') && !!job.fileId;
    const link = ready
      ? await this.files.issueLink(ctx, job.fileId!, 'download', {
          module: 'cso',
          entityType: 'export_job',
          entityId: job.id,
          vesselId: null,
        })
      : null;
    return { ...this.present(job), link };
  }

  async listMine(ctx: AuthContext) {
    const jobs = await this.prisma.exportJob.findMany({
      where: { requestedById: ctx.userId, module: 'cso' },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs.map((j) => this.present(j));
  }

  private present(j: ExportJob) {
    return {
      id: j.id,
      status: j.status,
      format: j.format,
      itemCount: j.itemCount,
      excludedCount: j.excludedCount,
      error: j.error,
      createdAt: j.createdAt,
      finishedAt: j.finishedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Worker
  // ---------------------------------------------------------------------------

  /** Traitement idempotent : un job terminé n'est jamais régénéré. */
  async process(jobId: string): Promise<Record<string, unknown>> {
    const job = await this.prisma.exportJob.findUnique({ where: { id: jobId } });
    if (!job || job.module !== 'cso') return { skipped: true };
    if (['COMPLETED', 'PARTIALLY_FAILED', 'FAILED', 'CANCELLED'].includes(job.status)) return { skipped: true, status: job.status };
    await this.prisma.exportJob.update({ where: { id: jobId }, data: { status: 'RUNNING' } });

    // Droits du demandeur recalculés depuis la base au moment de la génération
    const ctx = await this.csoAccess.contextForUser(job.requestedById);
    if (!ctx) return this.fail(job, null, 'Compte demandeur inactif ou verrouillé');
    const params = job.params as unknown as ZipParams;
    try {
      const plan = await this.plan(ctx, params);
      const total = plan.entries.reduce((s, e) => s + e.sizeBytes, 0);
      if (total > MAX_ZIP_SOURCE_BYTES) {
        return this.fail(job, ctx, `Sélection trop volumineuse (${Math.round(total / 1048576)} Mo, max ${MAX_ZIP_SOURCE_BYTES / 1048576} Mo)`);
      }
      if (!plan.entries.length) return this.fail(job, ctx, 'Aucun fichier autorisé dans la sélection', plan.excluded);
      const { buffer, included, failed } = await this.build(plan.entries);
      const stamp = new Date().toISOString().slice(0, 10);
      const file = await this.files.storeGenerated(
        buffer,
        `CSO-${stamp}-${job.id.slice(0, 8)}.zip`,
        'ZIP',
        'application/zip',
        'EXPORT',
        null,
        job.requestedById,
        { type: OWNER_EXPORT_JOB, id: job.id },
      );
      const status = failed.length ? 'PARTIALLY_FAILED' : 'COMPLETED';
      await this.prisma.$transaction(async (tx) => {
        await tx.exportJob.update({
          where: { id: job.id },
          data: { status, fileId: file.id, itemCount: included.length, excludedCount: plan.excluded + failed.length, finishedAt: new Date(), error: failed.length ? `${failed.length} fichier(s) indisponible(s)` : null },
        });
        await this.audit.record(
          ctx,
          {
            action: 'cso.zip.generated',
            module: 'cso',
            entityType: 'export_job',
            entityId: job.id,
            metadata: {
              fileId: file.id,
              sha256: file.sha256,
              documentIds: [...new Set(included.map((e) => e.documentId))],
              versionIds: included.map((e) => e.versionId),
              excludedCount: plan.excluded,
              failedCount: failed.length,
            },
          },
          tx,
        );
      });
      return { status, items: included.length, excluded: plan.excluded, failed: failed.length };
    } catch (e) {
      this.logger.error(`ZIP ${job.id} en échec : ${String(e)}`);
      return this.fail(job, ctx, 'Génération de l’archive impossible');
    }
  }

  private async fail(job: ExportJob, ctx: AuthContext | null, message: string, excluded?: number) {
    await this.prisma.exportJob.update({
      where: { id: job.id },
      data: { status: 'FAILED', error: message.slice(0, 1000), finishedAt: new Date(), excludedCount: excluded ?? null },
    });
    const input = { action: 'cso.zip.failed', module: 'cso' as const, entityType: 'export_job', entityId: job.id, result: 'FAILURE' as const, metadata: { message } };
    if (ctx) await this.audit.record(ctx, input);
    else await this.audit.system(input);
    return { status: 'FAILED', error: message };
  }

  /**
   * Plan de l'archive : filtrage par fichier. Documents isolés à la racine, dossiers sélectionnés
   * avec leur arborescence (élaguée sous tout dossier invisible). Versions archivées dans un
   * sous-dossier dédié, uniquement si includeArchived ET droits archives.
   */
  private async plan(ctx: AuthContext, params: ZipParams): Promise<{ entries: ZipEntryPlan[]; excluded: number }> {
    const entries: ZipEntryPlan[] = [];
    const usedNames = new Set<string>();
    const usedVersions = new Set<string>();
    let excluded = 0;

    const addDocuments = async (docs: CsoDocument[], folderSegments: Map<string, string[]>) => {
      const candidates = docs.filter((d) => params.includeArchived || d.status !== 'ARCHIVED');
      const { visible, eff } = await this.csoAccess.filterVisibleDocuments(ctx, candidates);
      excluded += candidates.length - visible.length;
      if (!visible.length) return;
      const versions = await this.prisma.csoVersion.findMany({
        where: {
          documentId: { in: visible.map((d) => d.id) },
          status: { in: params.includeArchived ? ['PUBLISHED', 'SUPERSEDED'] : ['PUBLISHED'] },
        },
        orderBy: { versionNo: 'desc' },
      });
      const files = await this.prisma.storedFile.findMany({ where: { id: { in: versions.map((v) => v.fileId) } } });
      for (const d of visible) {
        const e = eff.get(d.id)!;
        for (const v of versions.filter((x) => x.documentId === d.id)) {
          if (usedVersions.has(v.id)) continue;
          if (!canAccessVersion(e, d, v as CsoVersion, ctx.userId, 'download')) {
            excluded++;
            continue;
          }
          const file = files.find((f) => f.id === v.fileId);
          if (!file || file.deletedAt) {
            excluded++;
            continue;
          }
          const official = v.status === 'PUBLISHED' && d.status === 'PUBLISHED';
          const segments = [...(folderSegments.get(d.folderId) ?? []), ...(official ? [] : [ARCHIVE_DIR])];
          const name = documentFileName(d, file.extension, official ? undefined : v.versionNo);
          const path = uniqueZipName(usedNames, segments.length ? `${zipPath(segments)}/${name}` : name);
          usedVersions.add(v.id);
          entries.push({ path, fileId: file.id, documentId: d.id, versionId: v.id, sizeBytes: Number(file.sizeBytes), date: v.publishedAt ?? v.createdAt });
        }
      }
    };

    // Documents sélectionnés individuellement (racine de l'archive)
    if (params.documentIds.length) {
      const docs = await this.prisma.csoDocument.findMany({ where: { id: { in: params.documentIds } } });
      excluded += params.documentIds.length - docs.length;
      await addDocuments(docs, new Map());
    }

    // Dossiers sélectionnés : arborescence conservée sous le nom du dossier
    for (const folderId of params.folderIds) {
      const root = await this.prisma.csoFolder.findUnique({ where: { id: folderId } });
      if (!root || (!params.includeArchived && root.status !== 'ACTIVE')) {
        excluded++;
        continue;
      }
      const subtree = await this.prisma.csoFolder.findMany({
        where: { path: { startsWith: root.path }, ...(params.includeArchived ? {} : { status: 'ACTIVE' }) },
        orderBy: { depth: 'asc' },
      });
      const fEff = await this.csoAccess.foldersAccess(ctx, subtree);
      const segments = new Map<string, string[]>();
      for (const f of subtree as CsoFolder[]) {
        const visible = this.csoAccess.folderVisible(f, fEff.get(f.id)!);
        const parentSegs = f.id === root.id ? [] : f.parentId ? segments.get(f.parentId) : undefined;
        if (!visible || parentSegs === undefined) {
          if (f.id === root.id || (f.parentId && segments.has(f.parentId))) excluded++;
          continue;
        }
        segments.set(f.id, [...parentSegs, sanitizeZipSegment(f.name, 'dossier')]);
      }
      if (!segments.size) continue;
      const docs = await this.prisma.csoDocument.findMany({ where: { folderId: { in: [...segments.keys()] } } });
      await addDocuments(docs, segments);
    }
    return { entries, excluded };
  }

  /** Flux MinIO -> archiver, un fichier à la fois ; un fichier illisible est compté en échec. */
  private async build(entries: ZipEntryPlan[]): Promise<{ buffer: Buffer; included: ZipEntryPlan[]; failed: ZipEntryPlan[] }> {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const chunks: Buffer[] = [];
    archive.on('data', (c: Buffer) => chunks.push(c));
    const ended = new Promise<void>((resolve, reject) => {
      archive.on('end', () => resolve());
      archive.on('error', reject);
    });
    const included: ZipEntryPlan[] = [];
    const failed: ZipEntryPlan[] = [];
    for (const e of entries) {
      let stream;
      try {
        const file = await this.files.getOrThrow(e.fileId);
        stream = await this.files.readStream(file);
      } catch {
        failed.push(e);
        continue;
      }
      archive.append(stream, { name: e.path, date: e.date });
      await once(archive, 'entry');
      included.push(e);
    }
    await archive.finalize();
    await ended;
    return { buffer: Buffer.concat(chunks), included, failed };
  }
}
