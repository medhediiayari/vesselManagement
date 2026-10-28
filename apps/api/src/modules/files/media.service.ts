import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

// Protection contre les « bombes de décompression » d'images
sharp.cache(false);
const MAX_INPUT_PIXELS = 120_000_000;
const THUMB_WIDTH = 480;

/** Métadonnées techniques et miniatures (images : sharp ; PDF : pdf-lib). */
@Injectable()
export class MediaService {
  private readonly logger = new Logger('Media');

  async imageInfo(buf: Buffer): Promise<{ width: number | null; height: number | null }> {
    const meta = await sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS }).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  }

  /** Miniature WebP ré-encodée (supprime les métadonnées EXIF/GPS de l'original). */
  async thumbnail(buf: Buffer): Promise<Buffer> {
    return sharp(buf, { limitInputPixels: MAX_INPUT_PIXELS, pages: 1 })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 78 })
      .toBuffer();
  }

  async pdfPageCount(buf: Buffer): Promise<number | null> {
    try {
      const doc = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
      return doc.getPageCount();
    } catch (e) {
      this.logger.warn(`Lecture PDF impossible (page count) : ${String(e)}`);
      return null;
    }
  }
}
