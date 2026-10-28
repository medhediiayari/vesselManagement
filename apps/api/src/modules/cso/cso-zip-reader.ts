import * as yauzl from 'yauzl';
import { Errors } from '../../common/errors';
import { ZipLimits, checkZipEntryPath, checkZipEntrySize, isSymlinkEntry } from './cso-rules';

export interface ZipFileEntryInfo {
  index: number;
  rawName: string;
  segments: string[];
  uncompressedSize: number;
  compressedSize: number;
  /** Problème propre à l'entrée (taille, chiffrement) : ligne invalide, archive non rejetée */
  entryError?: string;
}

export type EntryVisitor = (entry: ZipFileEntryInfo, read: () => Promise<Buffer>) => Promise<void>;

/**
 * Parcours sûr d'un ZIP en mémoire (yauzl, entrées paresseuses) :
 *  - archive REJETÉE si : chemin absolu / « .. » / antislash (yauzl + contrôle propre), lien
 *    symbolique, nombre d'entrées excessif, taille décompressée totale dépassée, ratio de
 *    compression anormal (zip bomb) ;
 *  - entrée signalée invalide (sans rejet global) si : trop volumineuse ou chiffrée ;
 *  - lecture d'une entrée bornée (validateEntrySizes + coupure au-delà de la taille annoncée).
 * Les fichiers système (__MACOSX, .DS_Store, Thumbs.db) sont ignorés.
 */
export async function walkZip(buffer: Buffer, limits: ZipLimits, visit: EntryVisitor): Promise<{ directories: string[][]; ignored: number }> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false }, (err, z) =>
      err || !z ? reject(Errors.fileRejected(`Archive ZIP illisible : ${err?.message ?? 'inconnue'}`)) : resolve(z),
    ),
  );
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    throw Errors.fileRejected(`Archive refusée : trop d'entrées (${zip.entryCount}, max ${limits.maxEntries})`);
  }
  const directories: string[][] = [];
  let ignored = 0;
  let total = 0;
  let index = 0;

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      try {
        zip.close();
      } catch {
        /* déjà fermée */
      }
      reject(e instanceof Error && 'getStatus' in e ? e : Errors.fileRejected(`Archive refusée : ${String((e as Error)?.message ?? e)}`));
    };
    zip.on('error', fail);
    zip.on('end', () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const name = entry.fileName;
        const check = checkZipEntryPath(name);
        if (!check.ok) throw Errors.fileRejected(`Archive refusée : ${check.reason}`, { entry: name.slice(0, 200) });
        if (isSymlinkEntry(entry.externalFileAttributes)) throw Errors.fileRejected('Archive refusée : lien symbolique interdit', { entry: name.slice(0, 200) });
        if (check.ignored) {
          ignored++;
          return;
        }
        if (check.isDirectory) {
          directories.push(check.segments);
          return;
        }
        const sizeError = checkZipEntrySize(entry, total, limits);
        if (sizeError && !sizeError.startsWith('Fichier trop volumineux')) throw Errors.fileRejected(`Archive refusée : ${sizeError}`);
        total += entry.uncompressedSize;
        const info: ZipFileEntryInfo = {
          index: index++,
          rawName: name,
          segments: check.segments,
          uncompressedSize: entry.uncompressedSize,
          compressedSize: entry.compressedSize,
          entryError: sizeError ?? (entry.isEncrypted() ? 'Fichier chiffré : non importable' : undefined),
        };
        await visit(info, () => readEntry(zip, entry, limits.maxEntryBytes));
      })()
        .then(() => {
          if (!settled) zip.readEntry();
        })
        .catch(fail);
    });
    zip.readEntry();
  });
  return { directories, ignored };
}

function readEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err || !stream) return reject(Errors.fileRejected(`Entrée illisible : ${err?.message ?? 'inconnue'}`));
      const chunks: Buffer[] = [];
      let size = 0;
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes || size > entry.uncompressedSize) {
          stream.destroy(Errors.fileRejected('Entrée plus volumineuse qu’annoncé : archive suspecte'));
          return;
        }
        chunks.push(c);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });
  });
}
