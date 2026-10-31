/**
 * Règles métier PURES du module CSO (sans I/O) : automate des versions, formats de référence,
 * noms de fichiers ZIP (anti zip-slip), chemins d'import, échéances de rappel.
 */
import type { VersionStatus } from './cso-acl.logic';

// -----------------------------------------------------------------------------
// Automate des versions documentaires (CDC §12 — CSO-005/007/011)
// -----------------------------------------------------------------------------

/**
 * DRAFT -> PENDING_APPROVAL -> PUBLISHED | RETURNED | REJECTED ; l'ancienne version officielle
 * reste PUBLISHED tant que la nouvelle est en attente, puis passe SUPERSEDED à l'approbation.
 * Archivage d'un document : PUBLISHED -> SUPERSEDED, versions en cours -> CANCELLED.
 */
export const VERSION_TRANSITIONS: Record<VersionStatus, VersionStatus[]> = {
  DRAFT: ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL: ['PUBLISHED', 'RETURNED', 'REJECTED', 'CANCELLED'],
  RETURNED: ['PENDING_APPROVAL', 'CANCELLED'],
  REJECTED: [],
  PUBLISHED: ['SUPERSEDED'],
  SUPERSEDED: [],
  CANCELLED: [],
};

/** Statuts « en cours » (index partiel cso_versions_one_in_flight). */
export const IN_FLIGHT_VERSION: VersionStatus[] = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'];

export function canTransition(from: VersionStatus, to: VersionStatus): boolean {
  return VERSION_TRANSITIONS[from].includes(to);
}

export type VersionDecision = 'APPROVE' | 'REJECT' | 'RETURN';

export const DECISION_TARGET: Record<VersionDecision, VersionStatus> = {
  APPROVE: 'PUBLISHED',
  REJECT: 'REJECTED',
  RETURN: 'RETURNED',
};

// -----------------------------------------------------------------------------
// Références officielles (CSO-026) : {CAT} {VESSEL} {YYYY} {SEQ} {SEQ:n}
// -----------------------------------------------------------------------------

const TOKEN_RE = /\{([A-Z]+)(?::(\d{1,2}))?\}/g;
const ALLOWED_TOKENS = new Set(['CAT', 'VESSEL', 'YYYY', 'SEQ']);
/** Caractères autorisés dans une référence (aucun séparateur de chemin ni caractère de contrôle). */
export const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/ ]{0,118}[A-Za-z0-9]$/;

export function validateReferenceFormat(format: string): string | null {
  const tokens = [...format.matchAll(TOKEN_RE)];
  for (const t of tokens) {
    if (!ALLOWED_TOKENS.has(t[1])) return `Jeton inconnu {${t[1]}} (autorisés : {CAT} {VESSEL} {YYYY} {SEQ:n})`;
    if (t[2] !== undefined && t[1] !== 'SEQ') return `Le jeton {${t[1]}} n'accepte pas de longueur`;
    if (t[1] === 'SEQ' && t[2] !== undefined && (Number(t[2]) < 1 || Number(t[2]) > 10)) return 'Longueur {SEQ:n} entre 1 et 10';
  }
  if (tokens.filter((t) => t[1] === 'SEQ').length !== 1) return 'Le format doit contenir exactement un jeton {SEQ} ou {SEQ:n}';
  const literal = format.replace(TOKEN_RE, '');
  if (/[{}]/.test(literal)) return 'Accolade non appariée dans le format';
  if (!/^[A-Za-z0-9._\-/ ]*$/.test(literal)) return 'Caractères non autorisés dans le format (A-Z 0-9 . _ - / espace)';
  if (format.length > 120) return 'Format trop long (120 caractères max.)';
  return null;
}

export interface ReferenceParts {
  categoryCode: string;
  /** Code navire de la bibliothèque, ou FLEET pour la bibliothèque centrale */
  vesselCode: string;
  year: number;
}

/**
 * Clé de séquence : par catégorie, et par navire / année uniquement si le format les contient
 * (sinon deux navires partageraient la même référence pour un même numéro).
 */
export function referenceSequenceKey(format: string, parts: ReferenceParts): string {
  const hasVessel = /\{VESSEL\}/.test(format);
  const hasYear = /\{YYYY\}/.test(format);
  return `CSO-REF:${parts.categoryCode}:${hasVessel ? parts.vesselCode : '*'}:${hasYear ? parts.year : '*'}`;
}

export function renderReference(format: string, parts: ReferenceParts, seq: number): string {
  return format.replace(TOKEN_RE, (_m, token: string, len?: string) => {
    switch (token) {
      case 'CAT':
        return parts.categoryCode;
      case 'VESSEL':
        return parts.vesselCode;
      case 'YYYY':
        return String(parts.year);
      case 'SEQ':
        return String(seq).padStart(len ? Number(len) : 4, '0');
      default:
        return '';
    }
  });
}

export function normalizeReference(ref: string): string {
  return ref.normalize('NFC').replace(/\s+/g, ' ').trim();
}

// -----------------------------------------------------------------------------
// Champs standards obligatoires par catégorie (CSO-028) — le titre est toujours obligatoire
// -----------------------------------------------------------------------------

export const STANDARD_FIELDS = ['description', 'nextReviewOn', 'expiryOn', 'reference'] as const;
export type StandardField = (typeof STANDARD_FIELDS)[number];

export function missingStandardFields(required: string[], values: Partial<Record<StandardField, unknown>>): string[] {
  return required.filter((f) => {
    const v = values[f as StandardField];
    return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  });
}

// -----------------------------------------------------------------------------
// Noms dans les archives ZIP générées (anti zip-slip / path traversal)
// -----------------------------------------------------------------------------

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Un segment de chemin sûr : jamais vide, jamais "." / "..", sans séparateur ni caractère de contrôle. */
export function sanitizeZipSegment(name: string, fallback = 'element'): string {
  let s = (name ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (!s || s === '.' || s === '..') s = fallback;
  if (WINDOWS_RESERVED.test(s)) s = `_${s}`;
  return s.slice(0, 120);
}

/** Assemble un chemin relatif à partir de segments assainis (jamais absolu, jamais remontant). */
export function zipPath(segments: string[]): string {
  return segments.map((s) => sanitizeZipSegment(s)).join('/');
}

/** Évite les collisions de noms dans l'archive : "a.pdf", "a (2).pdf", ... */
export function uniqueZipName(used: Set<string>, path: string): string {
  const lower = (p: string) => p.toLowerCase();
  if (!used.has(lower(path))) {
    used.add(lower(path));
    return path;
  }
  const m = /^(.*?)(\.[A-Za-z0-9]{1,10})?$/.exec(path)!;
  for (let i = 2; ; i++) {
    const candidate = `${m[1]} (${i})${m[2] ?? ''}`;
    if (!used.has(lower(candidate))) {
      used.add(lower(candidate));
      return candidate;
    }
  }
}

/** Nom de fichier d'un document dans une archive : "<référence> - <titre> [vN].<ext>". */
export function documentFileName(doc: { reference: string | null; title: string }, ext: string, versionNo?: number): string {
  const base = doc.reference ? `${doc.reference} - ${doc.title}` : doc.title;
  const suffix = versionNo !== undefined ? ` (v${versionNo})` : '';
  const safeExt = /^[a-z0-9]{1,10}$/i.test(ext) ? `.${ext.toLowerCase()}` : '';
  return `${sanitizeZipSegment(base.slice(0, 100), 'document')}${suffix}${safeExt}`;
}

// -----------------------------------------------------------------------------
// Chemins des entrées d'un ZIP importé (CSO-033) — refus des chemins dangereux
// -----------------------------------------------------------------------------

export type ZipEntryCheck =
  | { ok: true; segments: string[]; isDirectory: boolean; ignored?: boolean }
  | { ok: false; reason: string };

const JUNK = [/^__MACOSX$/i, /^\.DS_Store$/i, /^Thumbs\.db$/i, /^desktop\.ini$/i];
export const MAX_ZIP_DEPTH = 20;

export function checkZipEntryPath(raw: string): ZipEntryCheck {
  if (!raw || raw.length > 1024) return { ok: false, reason: 'Nom d’entrée vide ou trop long' };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, reason: 'Caractères de contrôle dans le nom' };
  if (raw.includes('\\')) return { ok: false, reason: 'Séparateur « \\ » interdit' };
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) return { ok: false, reason: 'Chemin absolu interdit' };
  const isDirectory = raw.endsWith('/');
  const segments = raw.split('/').filter((s) => s.length > 0);
  if (segments.some((s) => s === '..')) return { ok: false, reason: 'Remontée de répertoire « .. » interdite' };
  const clean = segments.filter((s) => s !== '.');
  if (!clean.length) return { ok: false, reason: 'Nom d’entrée vide' };
  if (clean.length > MAX_ZIP_DEPTH) return { ok: false, reason: 'Arborescence trop profonde' };
  if (clean.some((s) => JUNK.some((re) => re.test(s)))) return { ok: true, segments: clean, isDirectory, ignored: true };
  if (clean.some((s) => s.length > 200)) return { ok: false, reason: 'Segment de chemin trop long' };
  return { ok: true, segments: clean, isDirectory };
}

/** Lien symbolique Unix dans les attributs externes (mode S_IFLNK). */
export function isSymlinkEntry(externalFileAttributes: number): boolean {
  const mode = (externalFileAttributes >>> 16) & 0o170000;
  return mode === 0o120000;
}

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  /** Ratio décompressé / compressé au-delà duquel une entrée volumineuse est suspecte (zip bomb) */
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxRatio: 200,
};

export function checkZipEntrySize(
  entry: { compressedSize: number; uncompressedSize: number },
  totalSoFar: number,
  limits: ZipLimits = DEFAULT_ZIP_LIMITS,
): string | null {
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    return `Fichier trop volumineux (max ${Math.round(limits.maxEntryBytes / 1048576)} Mo)`;
  }
  if (totalSoFar + entry.uncompressedSize > limits.maxTotalBytes) return 'Taille décompressée totale de l’archive dépassée';
  if (entry.uncompressedSize > 1024 * 1024 && entry.uncompressedSize / Math.max(entry.compressedSize, 1) > limits.maxRatio) {
    return 'Taux de compression anormal (archive suspecte de type « zip bomb »)';
  }
  return null;
}

// -----------------------------------------------------------------------------
// Rappels (CSO-012) : seuils 30 j / 7 j / dépassé ; attente d'approbation > 48 h
// -----------------------------------------------------------------------------

export type DueBucket = 'D30' | 'D7' | 'OVERDUE';

/** Jours civils entre aujourd'hui (UTC) et l'échéance (date @db.Date à minuit UTC). */
export function daysUntil(due: Date, now: Date): number {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const d = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  return Math.round((d - today) / 86_400_000);
}

export function dueBucket(due: Date, now: Date): DueBucket | null {
  const days = daysUntil(due, now);
  if (days < 0) return 'OVERDUE';
  if (days <= 7) return 'D7';
  if (days <= 30) return 'D30';
  return null;
}

export const PENDING_REMINDER_HOURS = 48;

/** Tranche de 48 h d'attente (relance toutes les 48 h, dédupliquée par tranche). */
export function pendingBucket(submittedAt: Date, now: Date): number | null {
  const hours = (now.getTime() - submittedAt.getTime()) / 3_600_000;
  if (hours < PENDING_REMINDER_HOURS) return null;
  return Math.floor(hours / PENDING_REMINDER_HOURS);
}

/** Échappement des métacaractères LIKE (recherche « contient » paramétrée). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// -----------------------------------------------------------------------------
// Pagination sur le flux des seuls éléments autorisés (audit #22)
// -----------------------------------------------------------------------------

/**
 * Le curseur est le nombre d'éléments VISIBLES déjà servis : il ne dépend jamais du nombre
 * d'éléments masqués intercalés dans le flux SQL (aucun oracle sur les documents non autorisés).
 */
export function pageOverVisible<T>(visible: T[], cursor: number, limit: number): { items: T[]; nextCursor: string | null } {
  const items = visible.slice(cursor, cursor + limit);
  return { items, nextCursor: visible.length > cursor + limit ? String(cursor + items.length) : null };
}

// -----------------------------------------------------------------------------
// Restauration (audit #10) : seule une version déjà approuvée peut être rétablie
// -----------------------------------------------------------------------------

export interface VersionLike {
  status: VersionStatus;
  versionNo: number;
  publishedAt: Date | null;
}

/** Dernière version approuvée (PUBLISHED / SUPERSEDED avec date de publication), sinon null. */
export function restorationSource<V extends VersionLike>(versions: V[]): V | null {
  const approved = versions.filter((v) => (v.status === 'PUBLISHED' || v.status === 'SUPERSEDED') && v.publishedAt !== null);
  approved.sort((a, b) => b.publishedAt!.getTime() - a.publishedAt!.getTime() || b.versionNo - a.versionNo);
  return approved[0] ?? null;
}

export type RestoreMode = 'APPROVAL' | 'DRAFT';

/**
 * Mode de restauration d'un document archivé (CSO-03) :
 *  - APPROVAL : déjà approuvé au moins une fois -> dernière version approuvée soumise à nouvelle approbation ;
 *  - DRAFT : archivé avant toute approbation -> retour en brouillon avec le dernier fichier déposé.
 *    Rien n'est soumis aux validateurs ni présenté comme déjà approuvé (audit #10) : le déposant le
 *    soumettra (ou l'annulera) lui-même.
 */
export function restorePlan<V extends VersionLike>(versions: V[]): { mode: RestoreMode; source: V } | null {
  const approved = restorationSource(versions);
  if (approved) return { mode: 'APPROVAL', source: approved };
  const last = versions.reduce<V | null>((best, v) => (!best || v.versionNo > best.versionNo ? v : best), null);
  return last ? { mode: 'DRAFT', source: last } : null;
}
