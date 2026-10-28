import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FileContext, FileKind, StoredFile } from '@prisma/client';
import { Queue } from 'bullmq';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { env } from '../../config/env';
import { Errors } from '../../common/errors';
import { safeEqual, sha256Hex } from '../../common/utils/crypto';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { DEFAULT_JOB_OPTIONS, QUEUES } from '../jobs/queues';
import { SettingsService } from '../settings/settings.service';
import { AntivirusService } from './antivirus.service';
import { FileAccessGrant, FileAccessMode, FileAccessRegistry } from './file-access.registry';
import { inspectFile, sanitizeFileName } from './file-inspector';
import { MediaService } from './media.service';
import { StorageService, contentDisposition } from './storage.service';

/** Permission métier requise (en plus de files.upload) pour déposer dans un contexte. */
const UPLOAD_PERMISSIONS: Record<FileContext, string[]> = {
  CERTIFICATE: ['certificates.create', 'certificates.edit'],
  CSO_DOCUMENT: ['cso.create', 'cso.edit', 'cso.import'],
  VESSEL_PHOTO: ['vessels.edit', 'vessel_documents.manage'],
  VESSEL_ATTACHMENT: ['vessel_documents.manage'],
  MEMBER_PHOTO: ['members.edit', 'members.create'],
  MEMBER_DOCUMENT: ['members.edit'],
  PURCHASING: ['pr.create', 'pr.edit', 'rfq.manage', 'quotation.record', 'bc.create', 'receiving.record', 'invoice.manage'],
  VOYAGE: ['voyages.edit', 'instructions.manage', 'noon.create'],
  CHARTER_PARTY: ['charter_party.manage'],
  NOON_REPORT: ['noon.create', 'noon.correct'],
  IMPORT_SOURCE: ['members.import', 'cso.import'],
  EXPORT: [],
  GENERATED: [],
};

/** Contextes où le navire est obligatoire au dépôt (scope vérifié dès l'upload). */
const VESSEL_REQUIRED: FileContext[] = ['VESSEL_PHOTO', 'VESSEL_ATTACHMENT', 'PURCHASING', 'NOON_REPORT'];

export interface FileDto {
  id: string;
  originalName: string;
  mimeType: string;
  kind: FileKind;
  extension: string;
  sizeBytes: number;
  sha256: string;
  scanStatus: StoredFile['scanStatus'];
  context: FileContext;
  vesselId: string | null;
  width: number | null;
  height: number | null;
  pageCount: number | null;
  hasThumbnail: boolean;
  attached: boolean;
  createdAt: Date;
}

export function toFileDto(f: StoredFile): FileDto {
  return {
    id: f.id,
    originalName: f.originalName,
    mimeType: f.mimeType,
    kind: f.kind,
    extension: f.extension,
    sizeBytes: Number(f.sizeBytes),
    sha256: f.sha256,
    scanStatus: f.scanStatus,
    context: f.context,
    vesselId: f.vesselId,
    width: f.width,
    height: f.height,
    pageCount: f.pageCount,
    hasThumbnail: !!f.thumbnailKey,
    attached: !!f.ownerId,
    createdAt: f.createdAt,
  };
}

export interface FileAccessLink {
  url: string;
  expiresAt: Date;
  fileName: string;
  mimeType: string;
  disposition: 'inline' | 'attachment';
}

/** Durée de vie d'un dépôt non rattaché à un objet métier avant nettoyage. */
export const ORPHAN_TTL_HOURS = 24;
const PROXY_SECRET = process.env.FILE_TOKEN_SECRET ?? randomBytes(32).toString('hex');

@Injectable()
export class FilesService {
  private readonly logger = new Logger('Files');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly antivirus: AntivirusService,
    private readonly media: MediaService,
    private readonly registry: FileAccessRegistry,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly settings: SettingsService,
    @InjectQueue(QUEUES.FILES) private readonly queue: Queue,
  ) {}

  // ---------------------------------------------------------------------------
  // Dépôt
  // ---------------------------------------------------------------------------

  /**
   * Dépôt d'un fichier (PDF, Excel, image…) : contrôle droits + scope, taille, type réel,
   * SHA-256, puis stockage MinIO (quarantaine si antivirus actif). Le fichier reste
   * « non rattaché » jusqu'à son lien avec un objet métier (attach()).
   */
  async upload(
    ctx: AuthContext,
    file: { buffer: Buffer; originalname: string; size: number },
    context: FileContext,
    vesselId?: string | null,
  ): Promise<FileDto> {
    if (context === 'EXPORT' || context === 'GENERATED') throw Errors.forbidden('Contexte réservé au serveur');
    this.access.assertCan(ctx, 'files.upload');
    const required = UPLOAD_PERMISSIONS[context];
    if (required.length && !required.some((p) => can(ctx, p))) {
      throw Errors.forbidden(`Dépôt ${context} non autorisé`, { anyOf: required });
    }
    if (VESSEL_REQUIRED.includes(context) && !vesselId) throw Errors.validation('vesselId requis pour ce contexte');
    if (vesselId) {
      this.access.assertVesselAccess(ctx, vesselId);
      const exists = await this.prisma.vessel.count({ where: { id: vesselId } });
      if (!exists) throw Errors.notFound('Navire');
    }

    const max = await this.settings.get('files.maxUploadBytes');
    if (file.size > max) throw Errors.fileRejected(`Fichier trop volumineux (max ${Math.round(max / 1048576)} Mo)`);

    const inspected = await inspectFile(file.buffer, file.originalname, context);
    return this.store(ctx.userId, file.buffer, inspected, context, vesselId ?? null, ctx);
  }

  /**
   * Stockage d'un fichier produit par le serveur (PDF BC, Noon Report, exports).
   * `owner` rattache immédiatement le fichier à son objet métier (le resolver d'accès s'applique).
   */
  async storeGenerated(
    buffer: Buffer,
    fileName: string,
    kind: FileKind,
    mimeType: string,
    context: 'GENERATED' | 'EXPORT',
    vesselId: string | null,
    actorId: string | null,
    owner?: { type: string; id: string },
    db: Db = this.prisma,
  ): Promise<StoredFile> {
    const id = randomUUID();
    const safeName = sanitizeFileName(fileName);
    const ext = /\.([a-z0-9]+)$/i.exec(safeName)?.[1]?.toLowerCase() ?? 'bin';
    const bucket = context === 'EXPORT' ? this.storage.buckets.exports : this.storage.buckets.files;
    const objectKey = `${context.toLowerCase()}/${datePrefix()}/${id}.${ext}`;
    const sha256 = sha256Hex(buffer);
    await this.storage.put(bucket, objectKey, buffer, mimeType, { sha256 });
    return db.storedFile.create({
      data: {
        id,
        bucket,
        objectKey,
        ownerType: owner?.type ?? null,
        ownerId: owner?.id ?? null,
        attachedAt: owner ? new Date() : null,
        originalName: safeName,
        extension: ext,
        mimeType,
        kind,
        sizeBytes: BigInt(buffer.length),
        sha256,
        // Généré par le serveur : pas d'analyse antivirus nécessaire, statut explicite
        scanStatus: 'SKIPPED',
        scanDetail: 'Généré par la plateforme',
        scannedAt: new Date(),
        context,
        vesselId,
        uploadedById: actorId,
        retentionUntil: context === 'EXPORT' ? new Date(Date.now() + 2 * 86_400_000) : null,
      },
    });
  }

  private async store(
    userId: string,
    buffer: Buffer,
    inspected: Awaited<ReturnType<typeof inspectFile>>,
    context: FileContext,
    vesselId: string | null,
    ctx: AuthContext,
  ): Promise<FileDto> {
    const id = randomUUID();
    const sha256 = sha256Hex(buffer);
    // Clé objet générée : aucun nom fourni par l'utilisateur => pas de path traversal
    const objectKey = `${context.toLowerCase()}/${datePrefix()}/${id}.${inspected.extension}`;
    const avEnabled = this.antivirus.enabled;
    const bucket = avEnabled ? this.storage.buckets.quarantine : this.storage.buckets.files;

    let width: number | null = null;
    let height: number | null = null;
    let pageCount: number | null = null;
    let thumbnailKey: string | null = null;
    if (inspected.kind === 'IMAGE') {
      try {
        ({ width, height } = await this.media.imageInfo(buffer));
      } catch {
        throw Errors.fileRejected('Image illisible ou corrompue');
      }
    }
    if (inspected.kind === 'PDF') pageCount = await this.media.pdfPageCount(buffer);

    await this.storage.put(bucket, objectKey, buffer, inspected.mimeType, { sha256, 'uploaded-by': userId });

    // Miniature immédiate seulement si le fichier n'est pas en quarantaine
    if (inspected.kind === 'IMAGE' && !avEnabled) thumbnailKey = await this.makeThumbnail(buffer, id);

    const row = await this.prisma.storedFile.create({
      data: {
        id,
        bucket,
        objectKey,
        originalName: inspected.safeName,
        extension: inspected.extension,
        mimeType: inspected.mimeType,
        kind: inspected.kind,
        sizeBytes: BigInt(buffer.length),
        sha256,
        scanStatus: avEnabled ? 'PENDING' : 'SKIPPED',
        scanDetail: avEnabled ? null : 'Antivirus désactivé (AV_MODE=disabled)',
        scannedAt: avEnabled ? null : new Date(),
        context,
        vesselId,
        width,
        height,
        pageCount,
        thumbnailKey,
        uploadedById: userId,
      },
    });
    await this.audit.record(ctx, {
      action: 'file.uploaded',
      module: 'platform',
      entityType: 'file',
      entityId: id,
      vesselId,
      after: { originalName: row.originalName, kind: row.kind, sizeBytes: buffer.length, sha256, context, scanStatus: row.scanStatus },
    });
    if (avEnabled) {
      await this.queue.add('scan', { fileId: id }, { ...DEFAULT_JOB_OPTIONS, jobId: `scan-${id}` });
    }
    return toFileDto(row);
  }

  async makeThumbnail(buffer: Buffer, fileId: string): Promise<string | null> {
    try {
      const thumb = await this.media.thumbnail(buffer);
      const key = `thumbnails/${fileId}.webp`;
      await this.storage.put(this.storage.buckets.files, key, thumb, 'image/webp');
      return key;
    } catch (e) {
      this.logger.warn(`Miniature impossible pour ${fileId}: ${String(e)}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Rattachement à un objet métier
  // ---------------------------------------------------------------------------

  /**
   * Rattache un fichier déposé à son propriétaire logique (une seule fois — trigger DB).
   * Seul l'auteur du dépôt peut le rattacher ; le contexte et le navire doivent concorder.
   */
  async attach(
    ctx: AuthContext,
    fileId: string,
    owner: { type: string; id: string; contexts: FileContext[]; vesselId?: string | null },
    db: Db = this.prisma,
  ): Promise<StoredFile> {
    const file = await db.storedFile.findUnique({ where: { id: fileId } });
    if (!file || file.deletedAt) throw Errors.notFound('Fichier');
    if (file.uploadedById !== ctx.userId) throw Errors.forbidden('Fichier déposé par un autre utilisateur');
    if (file.ownerId) throw Errors.conflict('Fichier déjà rattaché à un autre objet');
    if (!owner.contexts.includes(file.context)) {
      throw Errors.validation(`Contexte de fichier ${file.context} incompatible (attendu : ${owner.contexts.join(', ')})`);
    }
    if (file.scanStatus === 'INFECTED') throw Errors.fileRejected('Fichier infecté : rattachement interdit');
    if (owner.vesselId && file.vesselId && file.vesselId !== owner.vesselId) {
      throw Errors.validation('Le fichier a été déposé pour un autre navire');
    }
    return db.storedFile.update({
      where: { id: fileId },
      data: { ownerType: owner.type, ownerId: owner.id, attachedAt: new Date(), vesselId: owner.vesselId ?? file.vesselId },
    });
  }

  /**
   * Nouvelle référence logique vers le même blob (copie de document CSO, restauration) :
   * le contenu n'est pas dupliqué ; le blob n'est jamais supprimé tant qu'une ligne le référence.
   */
  async cloneReference(
    fileId: string,
    owner: { type: string; id: string; vesselId?: string | null },
    actorId: string,
    db: Db = this.prisma,
  ): Promise<StoredFile> {
    const src = await db.storedFile.findUniqueOrThrow({ where: { id: fileId } });
    const { id: _id, ownerId: _o, ownerType: _t, attachedAt: _a, createdAt: _c, ...rest } = src;
    return db.storedFile.create({
      data: {
        ...rest,
        id: randomUUID(),
        ownerType: owner.type,
        ownerId: owner.id,
        attachedAt: new Date(),
        vesselId: owner.vesselId ?? src.vesselId,
        uploadedById: actorId,
      },
    });
  }

  async getOrThrow(fileId: string, db: Db = this.prisma): Promise<StoredFile> {
    const f = await db.storedFile.findUnique({ where: { id: fileId } });
    if (!f || f.deletedAt) throw Errors.notFound('Fichier');
    return f;
  }

  // ---------------------------------------------------------------------------
  // Accès (preview / download) — droits revérifiés à chaque demande
  // ---------------------------------------------------------------------------

  /** Résout l'autorisation via le resolver du propriétaire (ou l'auteur pour un dépôt non rattaché). */
  async authorize(ctx: AuthContext, file: StoredFile, mode: FileAccessMode): Promise<FileAccessGrant> {
    if (!file.ownerType || !file.ownerId) {
      if (file.uploadedById === ctx.userId) {
        return { module: 'platform', entityType: 'file', entityId: file.id, vesselId: file.vesselId };
      }
      throw Errors.forbidden('Fichier non rattaché');
    }
    if (file.context === 'EXPORT') {
      if (file.uploadedById !== ctx.userId) throw Errors.forbidden('Export réservé à son demandeur');
      return { module: 'platform', entityType: 'export', entityId: file.ownerId, vesselId: null };
    }
    const resolver = this.registry.get(file.ownerType);
    if (!resolver) throw Errors.forbidden(`Aucune règle d'accès pour ${file.ownerType}`);
    return resolver(ctx, file, mode);
  }

  /**
   * Émet un lien éphémère après autorisation + audit. `grant` peut être fourni par un
   * module métier qui a déjà fait ses contrôles (route dédiée /certificates/:id/download…).
   */
  async issueLink(
    ctx: AuthContext,
    fileOrId: StoredFile | string,
    mode: 'preview' | 'download' | 'thumbnail',
    grant?: FileAccessGrant,
  ): Promise<FileAccessLink> {
    const file = typeof fileOrId === 'string' ? await this.getOrThrow(fileOrId) : fileOrId;
    const previewable = file.kind === 'PDF' || file.kind === 'IMAGE';
    // Un « aperçu » d'un format non affichable (Word, Excel…) est servi en pièce jointe :
    // il est donc autorisé comme un téléchargement (droit distinct de la consultation).
    const authMode: FileAccessMode = mode === 'preview' && !previewable ? 'download' : mode;
    const g = grant ?? (await this.authorize(ctx, file, authMode));
    if (file.scanStatus === 'PENDING') throw Errors.fileNotAvailable('Analyse antivirus en cours : fichier pas encore disponible');
    if (file.scanStatus === 'INFECTED') throw Errors.fileNotAvailable('Fichier en quarantaine (menace détectée)');
    if (file.scanStatus === 'ERROR') throw Errors.fileNotAvailable("Analyse antivirus en échec : fichier indisponible");

    const disposition: 'inline' | 'attachment' =
      mode === 'download' || g.forceAttachment || !previewable ? 'attachment' : 'inline';
    const fileName = g.downloadName ?? file.originalName;

    let bucket = file.bucket;
    let key = file.objectKey;
    let mimeType = file.mimeType;
    if (mode === 'thumbnail') {
      if (!file.thumbnailKey) throw Errors.notFound('Miniature');
      bucket = this.storage.buckets.files;
      key = file.thumbnailKey;
      mimeType = 'image/webp';
    }

    await this.audit.record(ctx, {
      action: authMode === 'download' ? 'file.download' : mode === 'thumbnail' ? 'file.thumbnail' : 'file.preview',
      module: g.module,
      entityType: g.entityType,
      entityId: g.entityId,
      vesselId: g.vesselId ?? file.vesselId,
      metadata: { fileId: file.id, fileName, sha256: file.sha256, disposition },
    });

    if (env().FILE_DELIVERY_MODE === 'proxy') {
      const ttl = env().SIGNED_URL_TTL_SECONDS;
      const exp = Math.floor(Date.now() / 1000) + ttl;
      const token = this.signProxyToken({ f: file.id, m: mode, d: disposition, n: fileName, exp });
      return {
        url: `/api/v1/files/stream/${token}`,
        expiresAt: new Date(exp * 1000),
        fileName,
        mimeType,
        disposition,
      };
    }
    const { url, expiresAt } = await this.storage.presignGet(bucket, key, {
      disposition,
      fileName: mode === 'thumbnail' ? `${file.id}.webp` : fileName,
      contentType: mimeType,
    });
    return { url, expiresAt, fileName, mimeType, disposition };
  }

  // ---------------------------------------------------------------------------
  // Mode proxy (MinIO non exposé au navigateur) : jeton HMAC à durée de vie courte
  // ---------------------------------------------------------------------------

  private signProxyToken(payload: { f: string; m: string; d: string; n: string; exp: number }): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', PROXY_SECRET).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  async openProxyStream(token: string) {
    const [body, sig] = token.split('.');
    if (!body || !sig) throw Errors.forbidden('Jeton invalide');
    const expected = createHmac('sha256', PROXY_SECRET).update(body).digest('base64url');
    if (!safeEqual(sig, expected)) throw Errors.forbidden('Jeton invalide');
    const p = JSON.parse(Buffer.from(body, 'base64url').toString()) as { f: string; m: string; d: 'inline' | 'attachment'; n: string; exp: number };
    if (p.exp < Date.now() / 1000) throw Errors.forbidden('Lien expiré');
    const file = await this.getOrThrow(p.f);
    const bucket = p.m === 'thumbnail' ? this.storage.buckets.files : file.bucket;
    const key = p.m === 'thumbnail' ? file.thumbnailKey! : file.objectKey;
    const obj = await this.storage.stream(bucket, key);
    return {
      stream: obj.body,
      contentType: p.m === 'thumbnail' ? 'image/webp' : file.mimeType,
      contentLength: obj.contentLength,
      disposition: contentDisposition(p.d, p.n),
    };
  }

  /** Lecture serveur d'un fichier (imports Excel/ZIP, génération ZIP) — après contrôles métier. */
  async readBuffer(file: StoredFile): Promise<Buffer> {
    if (file.scanStatus === 'PENDING' || file.scanStatus === 'INFECTED' || file.scanStatus === 'ERROR') {
      throw Errors.fileNotAvailable(`Fichier indisponible (statut antivirus ${file.scanStatus})`);
    }
    return this.storage.buffer(file.bucket, file.objectKey);
  }

  async readStream(file: StoredFile) {
    if (file.scanStatus === 'PENDING' || file.scanStatus === 'INFECTED' || file.scanStatus === 'ERROR') {
      throw Errors.fileNotAvailable(`Fichier indisponible (statut antivirus ${file.scanStatus})`);
    }
    return (await this.storage.stream(file.bucket, file.objectKey)).body;
  }

  /** Dépôts de l'utilisateur non encore rattachés (reprise d'un formulaire). */
  listPendingUploads(ctx: AuthContext) {
    return this.prisma.storedFile
      .findMany({
        where: { uploadedById: ctx.userId, ownerId: null, deletedAt: null, context: { notIn: ['EXPORT', 'GENERATED'] } },
        orderBy: { createdAt: 'desc' },
        take: 50,
      })
      .then((rows) => rows.map(toFileDto));
  }
}

function datePrefix(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
