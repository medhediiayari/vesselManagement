import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Readable } from 'node:stream';
import { env } from '../../config/env';

export interface PresignOptions {
  disposition: 'inline' | 'attachment';
  fileName: string;
  contentType: string;
  ttlSeconds?: number;
}

/**
 * Accès MinIO (S3 compatible). Les buckets sont privés : aucune URL publique durable.
 * Deux clients : `internal` (opérations serveur) et `signer` (signature des URLs
 * éphémères pour l'endpoint vu par le navigateur — aucune connexion réseau).
 */
@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger('Storage');
  private readonly internal: S3Client;
  private readonly signer: S3Client;

  readonly buckets = {
    files: env().S3_BUCKET_FILES,
    quarantine: env().S3_BUCKET_QUARANTINE,
    exports: env().S3_BUCKET_EXPORTS,
  };

  constructor() {
    const e = env();
    const common = {
      region: e.S3_REGION,
      forcePathStyle: e.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: e.S3_ACCESS_KEY, secretAccessKey: e.S3_SECRET_KEY },
    };
    this.internal = new S3Client({ ...common, endpoint: e.S3_ENDPOINT });
    this.signer = new S3Client({ ...common, endpoint: e.S3_PUBLIC_ENDPOINT });
  }

  async onModuleInit(): Promise<void> {
    for (const bucket of Object.values(this.buckets)) {
      try {
        await this.internal.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (e) {
        this.logger.error(`Bucket MinIO "${bucket}" inaccessible (lancer npm run infra:up) : ${String(e)}`);
      }
    }
  }

  /** Vérifie l'accessibilité du bucket officiel (lève une erreur si MinIO est indisponible). */
  async ping(): Promise<void> {
    await this.internal.send(new HeadBucketCommand({ Bucket: this.buckets.files }));
  }

  async put(bucket: string, key: string, body: Buffer, contentType: string, metadata: Record<string, string> = {}) {
    await this.internal.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        Metadata: metadata,
      }),
    );
  }

  async copy(srcBucket: string, key: string, dstBucket: string, dstKey = key) {
    await this.internal.send(
      new CopyObjectCommand({ Bucket: dstBucket, Key: dstKey, CopySource: `${srcBucket}/${encodeURI(key)}` }),
    );
  }

  async remove(bucket: string, key: string) {
    await this.internal.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async exists(bucket: string, key: string): Promise<boolean> {
    try {
      await this.internal.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  async stream(bucket: string, key: string): Promise<{ body: Readable; contentLength?: number; contentType?: string }> {
    const res = await this.internal.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return {
      body: res.Body as Readable,
      contentLength: res.ContentLength,
      contentType: res.ContentType,
    };
  }

  async buffer(bucket: string, key: string): Promise<Buffer> {
    const { body } = await this.stream(bucket, key);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  /** URL GET signée courte (TTL par défaut SIGNED_URL_TTL_SECONDS, 60 s). */
  async presignGet(bucket: string, key: string, opts: PresignOptions): Promise<{ url: string; expiresAt: Date }> {
    const ttl = opts.ttlSeconds ?? env().SIGNED_URL_TTL_SECONDS;
    const url = await getSignedUrl(
      this.signer,
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(opts.disposition, opts.fileName),
        ResponseContentType: opts.contentType,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: ttl },
    );
    return { url, expiresAt: new Date(Date.now() + ttl * 1000) };
  }
}

/** En-tête Content-Disposition RFC 6266 (nom ASCII de repli + nom UTF-8). */
export function contentDisposition(kind: 'inline' | 'attachment', fileName: string): string {
  const ascii = fileName.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
