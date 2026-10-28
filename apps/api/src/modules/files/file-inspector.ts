import { FileContext, FileKind } from '@prisma/client';
import { fromBuffer } from 'file-type';
import { Errors } from '../../common/errors';

export interface InspectedFile {
  kind: FileKind;
  mimeType: string;
  extension: string;
  safeName: string;
}

/** Types acceptés : détection par signature binaire (magic bytes), jamais par le seul nom. */
const DETECTED: Record<string, { kind: FileKind; mime: string; exts: string[] }> = {
  pdf: { kind: 'PDF', mime: 'application/pdf', exts: ['pdf'] },
  jpg: { kind: 'IMAGE', mime: 'image/jpeg', exts: ['jpg', 'jpeg'] },
  png: { kind: 'IMAGE', mime: 'image/png', exts: ['png'] },
  webp: { kind: 'IMAGE', mime: 'image/webp', exts: ['webp'] },
  tif: { kind: 'IMAGE', mime: 'image/tiff', exts: ['tif', 'tiff'] },
  xlsx: { kind: 'EXCEL', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', exts: ['xlsx'] },
  docx: { kind: 'WORD', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', exts: ['docx'] },
  zip: { kind: 'ZIP', mime: 'application/zip', exts: ['zip'] },
  // Excel 97-2003 (.xls) = conteneur OLE/CFB : accepté uniquement avec extension .xls
  cfb: { kind: 'EXCEL', mime: 'application/vnd.ms-excel', exts: ['xls'] },
};

/** Liste blanche par contexte d'usage. */
export const ALLOWED_KINDS: Record<FileContext, FileKind[]> = {
  CERTIFICATE: ['PDF', 'IMAGE'],
  CSO_DOCUMENT: ['PDF', 'IMAGE', 'WORD', 'EXCEL'],
  VESSEL_PHOTO: ['IMAGE'],
  VESSEL_ATTACHMENT: ['PDF', 'IMAGE', 'WORD', 'EXCEL'],
  MEMBER_PHOTO: ['IMAGE'],
  MEMBER_DOCUMENT: ['PDF', 'IMAGE', 'WORD'],
  PURCHASING: ['PDF', 'IMAGE', 'EXCEL', 'WORD'],
  VOYAGE: ['PDF', 'IMAGE', 'WORD', 'EXCEL'],
  CHARTER_PARTY: ['PDF', 'WORD', 'IMAGE'],
  NOON_REPORT: ['PDF', 'IMAGE'],
  IMPORT_SOURCE: ['EXCEL', 'CSV', 'ZIP'],
  EXPORT: ['ZIP', 'EXCEL', 'CSV', 'PDF'],
  GENERATED: ['PDF', 'EXCEL', 'CSV', 'ZIP'],
};

/** Extensions toujours refusées (exécutables, contenus actifs, HTML/SVG => XSS). */
const BLOCKED_EXT = new Set([
  'html', 'htm', 'xhtml', 'svg', 'svgz', 'js', 'mjs', 'exe', 'dll', 'bat', 'cmd', 'com', 'msi', 'ps1', 'sh',
  'vbs', 'jar', 'scr', 'hta', 'xlsm', 'xltm', 'docm', 'dotm', 'pptm', 'php', 'jsp', 'asp', 'aspx',
]);

export function sanitizeFileName(name: string): string {
  const base = (name ?? 'fichier').split(/[\\/]/).pop() ?? 'fichier';
  const cleaned = base
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return (cleaned || 'fichier').slice(0, 200);
}

function extensionOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name);
  return m ? m[1].toLowerCase() : '';
}

function looksLikeText(buf: Buffer): boolean {
  const sample = buf.subarray(0, Math.min(buf.length, 64 * 1024));
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample);
    return true;
  } catch {
    // Les CSV Excel Windows sont souvent en latin-1 : accepter si aucun octet de contrôle binaire
    return !sample.some((b) => b < 0x09 || (b > 0x0d && b < 0x20));
  }
}

/**
 * PDF : refuser le contenu actif (JavaScript, lancement d'application, Flash/RichMedia).
 * Les fichiers embarqués restent acceptés (factures Factur-X / PDF/A-3 contiennent un XML).
 */
function assertPdfIsPassive(buf: Buffer): void {
  const text = buf.toString('latin1');
  const active = ['/JavaScript', '/JS ', '/JS(', '/JS<', '/Launch', '/RichMedia'];
  const found = active.filter((t) => text.includes(t));
  if (found.length) {
    throw Errors.fileRejected('PDF refusé : contenu actif détecté (JavaScript / lancement / RichMedia)', {
      markers: found,
    });
  }
}

export async function inspectFile(buf: Buffer, originalName: string, context: FileContext): Promise<InspectedFile> {
  const safeName = sanitizeFileName(originalName);
  const ext = extensionOf(safeName);
  if (!buf.length) throw Errors.fileRejected('Fichier vide');
  if (BLOCKED_EXT.has(ext)) throw Errors.fileRejected(`Extension .${ext} interdite`);

  let result: InspectedFile | null = null;
  const detected = await fromBuffer(buf);
  if (detected) {
    const def = DETECTED[detected.ext];
    if (!def) {
      throw Errors.fileRejected(`Type de fichier non autorisé (${detected.mime})`, { detected: detected.mime });
    }
    if (!def.exts.includes(ext)) {
      throw Errors.fileRejected(
        `Extension .${ext || '?'} incohérente avec le contenu réel (${def.mime})`,
        { detected: def.mime, expectedExtensions: def.exts },
      );
    }
    result = { kind: def.kind, mimeType: def.mime, extension: ext, safeName };
  } else if (ext === 'csv' && looksLikeText(buf)) {
    result = { kind: 'CSV', mimeType: 'text/csv', extension: 'csv', safeName };
  }
  if (!result) throw Errors.fileRejected('Type de fichier non reconnu ou non autorisé');

  if (!ALLOWED_KINDS[context].includes(result.kind)) {
    throw Errors.fileRejected(`Type ${result.kind} non autorisé pour ce contexte (${context})`, {
      allowed: ALLOWED_KINDS[context],
    });
  }
  if (result.kind === 'PDF') assertPdfIsPassive(buf);
  return result;
}
