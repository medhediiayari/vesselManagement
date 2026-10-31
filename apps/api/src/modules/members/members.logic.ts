import type { CrewAssignmentStatus, CustomFieldType, ExpiryKind, MemberStatus, Prisma } from '@prisma/client';

/**
 * Règles pures du module Members (sans accès base) : normalisation des identifiants,
 * détection multicritère des doublons (ADM-042), synchronisation du statut Member avec
 * les affectations (CDC V1 §5.2), champs protégés et validation des champs personnalisés.
 * Testées unitairement (members.logic.spec.ts).
 */

// =============================================================================
// Normalisation
// =============================================================================

const LIGATURES: Record<string, string> = {
  Œ: 'OE', œ: 'oe', Æ: 'AE', æ: 'ae', ß: 'ss', Ø: 'O', ø: 'o', Ł: 'L', ł: 'l', Đ: 'D', đ: 'd',
};

/** Retire accents et ligatures (aligné sur `unaccent` PostgreSQL pour l'alphabet latin courant). */
export function stripAccents(s: string): string {
  return s
    .replace(/[ŒœÆæßØøŁłĐđ]/g, (c) => LIGATURES[c] ?? c)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Clé de comparaison d'un nom : lettres A-Z uniquement (« Ben-Salah » = « BEN SALAH » = « BENSALAH »). */
export function nameKey(v: string | null | undefined): string {
  if (!v) return '';
  return stripAccents(v).toUpperCase().replace(/[^A-Z]/g, '');
}

/** Clé de comparaison d'un identifiant (matricule, passeport, livret) : A-Z 0-9 uniquement. */
export function idKey(v: unknown): string {
  if (v === null || v === undefined) return '';
  return stripAccents(String(v)).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Forme stockée d'un identifiant officiel : majuscules, sans espaces. */
export function normalizeRef(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().toUpperCase().replace(/\s+/g, '');
  return s.length ? s : null;
}

/**
 * Clé de recherche d'un identifiant officiel : majuscules, lettres et chiffres seulement
 * (« tg 2384 », « TG-2384 » → « TG2384 »). null si trop courte pour être discriminante.
 */
export function searchIdentifierKey(v: string): string | null {
  const k = stripAccents(v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return k.length >= 2 ? k : null;
}

export function cleanText(v: string): string {
  return v.replace(/\s+/g, ' ').trim();
}

/** Date (colonne @db.Date, minuit UTC) -> "AAAA-MM-JJ". */
export function ymd(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function dateFromYmd(s: string | null | undefined): Date | null {
  return s ? new Date(`${s}T00:00:00.000Z`) : null;
}

export function todayYmd(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// =============================================================================
// Détection des doublons (ADM-042, CDC §3.2 / V1 §5.3)
// =============================================================================

export interface MemberIdentity {
  amcRef?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  /** AAAA-MM-JJ */
  birthDate?: string | null;
  passportNumber?: string | null;
  passportCountry?: string | null;
  seamanBookNumber?: string | null;
}

export interface IdentityRecord extends MemberIdentity {
  id: string;
  archived?: boolean;
}

export type DuplicateReason =
  | 'AMC_REF'
  | 'PASSPORT'
  | 'PASSPORT_OTHER_COUNTRY'
  | 'SEAMAN_BOOK'
  | 'NAME_BIRTHDATE'
  | 'NAME_SWAPPED_BIRTHDATE'
  | 'NAME_SIMILAR_BIRTHDATE'
  | 'NAME_NO_BIRTHDATE'
  | 'NAME_BIRTHDATE_DIFFERS'
  | 'IDENTITY_MISMATCH'
  | 'AMC_REF_DIFFERS';

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  AMC_REF: 'Même matricule AMC',
  PASSPORT: 'Même numéro de passeport',
  PASSPORT_OTHER_COUNTRY: 'Même numéro de passeport (pays émetteur différent)',
  SEAMAN_BOOK: 'Même numéro de seaman book',
  NAME_BIRTHDATE: 'Mêmes nom, prénom et date de naissance',
  NAME_SWAPPED_BIRTHDATE: 'Nom / prénom inversés, même date de naissance',
  NAME_SIMILAR_BIRTHDATE: 'Nom très proche, même date de naissance',
  NAME_NO_BIRTHDATE: 'Mêmes nom et prénom (date de naissance non comparable)',
  NAME_BIRTHDATE_DIFFERS: 'Mêmes nom et prénom, date de naissance différente',
  IDENTITY_MISMATCH: 'Attention : identifiant identique mais nom différent',
  AMC_REF_DIFFERS: 'Attention : matricules AMC différents',
};

/** Score à partir duquel une ressemblance est signalée (rapprochement manuel requis). */
export const DUPLICATE_THRESHOLD = 30;
/** Score « forte présomption » (même personne quasi certaine). */
export const STRONG_DUPLICATE_THRESHOLD = 70;

export interface DuplicateMatch {
  score: number;
  reasons: DuplicateReason[];
}

/** Distance de Levenshtein (noms courts : coût négligeable). */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

/**
 * Score multicritère entre deux identités (0..100) + raisons lisibles.
 * Le passeport n'est unique que par pays émetteur : deux pays connus différents => signal faible.
 */
export function scoreDuplicate(a: MemberIdentity, b: MemberIdentity): DuplicateMatch {
  const reasons: DuplicateReason[] = [];
  let score = 0;
  const add = (r: DuplicateReason, s: number) => {
    reasons.push(r);
    score = Math.max(score, s);
  };

  const refA = idKey(a.amcRef);
  const refB = idKey(b.amcRef);
  if (refA && refA === refB) add('AMC_REF', 100);

  const passA = idKey(a.passportNumber);
  const passB = idKey(b.passportNumber);
  if (passA && passA === passB) {
    const ca = a.passportCountry?.toUpperCase();
    const cb = b.passportCountry?.toUpperCase();
    if (ca && cb && ca !== cb) add('PASSPORT_OTHER_COUNTRY', 35);
    else add('PASSPORT', 90);
  }

  const bookA = idKey(a.seamanBookNumber);
  const bookB = idKey(b.seamanBookNumber);
  if (bookA && bookA === bookB) add('SEAMAN_BOOK', 85);

  const la = nameKey(a.lastName);
  const fa = nameKey(a.firstName);
  const lb = nameKey(b.lastName);
  const fb = nameKey(b.firstName);
  const namesKnown = !!(la && fa && lb && fb);
  const sameName = namesKnown && la === lb && fa === fb;
  const swapped = namesKnown && !sameName && la === fb && fa === lb;
  const bothDob = !!(a.birthDate && b.birthDate);
  const sameDob = bothDob && a.birthDate === b.birthDate;

  if (sameName || swapped) {
    if (sameDob) add(sameName ? 'NAME_BIRTHDATE' : 'NAME_SWAPPED_BIRTHDATE', sameName ? 80 : 75);
    else if (!bothDob) add('NAME_NO_BIRTHDATE', 45);
    else add('NAME_BIRTHDATE_DIFFERS', 30);
  } else if (sameDob && namesKnown) {
    const sim = Math.max(similarity(la + fa, lb + fb), similarity(la + fa, fb + lb));
    if (sim >= 0.85) add('NAME_SIMILAR_BIRTHDATE', 60);
  }

  if (score > 0) {
    const strongId = reasons.some((r) => r === 'AMC_REF' || r === 'PASSPORT' || r === 'SEAMAN_BOOK');
    if (strongId && namesKnown && !sameName && !swapped) {
      const sim = Math.max(similarity(la + fa, lb + fb), similarity(la + fa, fb + lb));
      if (sim < 0.6) reasons.push('IDENTITY_MISMATCH');
    }
    if (refA && refB && refA !== refB) reasons.push('AMC_REF_DIFFERS');
  }
  return { score, reasons };
}

export interface DuplicateCandidate {
  memberId: string;
  score: number;
  reasons: DuplicateReason[];
  archived: boolean;
}

/** Classe les fiches existantes ressemblant à `probe` (score >= seuil), meilleur score d'abord. */
export function rankCandidates(
  probe: MemberIdentity,
  records: IdentityRecord[],
  opts: { excludeIds?: Iterable<string>; threshold?: number; limit?: number } = {},
): DuplicateCandidate[] {
  const exclude = new Set(opts.excludeIds ?? []);
  const threshold = opts.threshold ?? DUPLICATE_THRESHOLD;
  return records
    .filter((r) => !exclude.has(r.id))
    .map((r) => ({ memberId: r.id, archived: !!r.archived, ...scoreDuplicate(probe, r) }))
    .filter((c) => c.score >= threshold)
    .sort((x, y) => y.score - x.score)
    .slice(0, opts.limit ?? 10);
}

/** Mention générique d'un doublon hors périmètre : ni identifiant, ni score, ni raisons (pas d'oracle d'identité). */
export const OUT_OF_SCOPE_DUPLICATE_MESSAGE =
  'Doublon possible avec une fiche hors de votre périmètre : contacter le service Crewing avant toute création';

/**
 * ADM-070 : sépare les candidats visibles (détaillés) des invisibles, réduits à un simple
 * indicateur `hiddenMatch` — la création reste bloquée sans révéler date de naissance / passeport.
 */
export function partitionCandidates<T extends { memberId: string }>(candidates: T[], visibleIds: ReadonlySet<string>): { visible: T[]; hiddenMatch: boolean } {
  return {
    visible: candidates.filter((c) => visibleIds.has(c.memberId)),
    hiddenMatch: candidates.some((c) => !visibleIds.has(c.memberId)),
  };
}

/** Clés de recherche (pré-filtrage SQL) d'une identité. */
export function identityKeys(p: MemberIdentity) {
  const last = nameKey(p.lastName);
  const first = nameKey(p.firstName);
  return {
    ref: idKey(p.amcRef),
    passport: idKey(p.passportNumber),
    book: idKey(p.seamanBookNumber),
    namePairs: last && first ? [`${last}|${first}`, `${first}|${last}`] : [],
    birthDate: p.birthDate ?? '',
  };
}

export const IDENTITY_FIELDS = [
  'amcRef',
  'firstName',
  'lastName',
  'birthDate',
  'passportNumber',
  'passportCountry',
  'seamanBookNumber',
] as const;

// =============================================================================
// Champs protégés (CDC §2.1 field_acl_allowed, V1 §5.1)
// =============================================================================

/**
 * Données personnelles / officielles dont la saisie ou la modification exige
 * `members.personal_fields.manage` : matricule, naissance, nationalité, genre,
 * passeport et seaman book. Les coordonnées (téléphone, adresse, contact d'urgence…),
 * la fonction et les notes relèvent de `members.edit`.
 */
export const PROTECTED_MEMBER_FIELDS = [
  'amcRef',
  'birthDate',
  'birthPlace',
  'nationality',
  'gender',
  'passportNumber',
  'passportCountry',
  'passportExpiry',
  'seamanBookNumber',
  'seamanBookExpiry',
] as const;
export type ProtectedMemberField = (typeof PROTECTED_MEMBER_FIELDS)[number];

function comparable(v: unknown): unknown {
  if (v instanceof Date) return ymd(v);
  if (v === undefined || v === '') return null;
  return v;
}

export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

/** Champs protégés présents dans `patch` dont la valeur diffère de l'état courant. */
export function changedProtectedFields(before: Record<string, unknown>, patch: Record<string, unknown>): ProtectedMemberField[] {
  return PROTECTED_MEMBER_FIELDS.filter((f) => patch[f] !== undefined && !sameValue(before[f], patch[f]));
}

/**
 * Historique d'une fiche : masque, pour un lecteur donné, les champs protégés (sans
 * members.personal_fields.manage) et les valeurs de champs personnalisés qu'il ne peut pas voir.
 * S'applique à before / after et aux corrections d'import ({ champ: { from, to } }).
 */
export function redactMemberAuditPayload(
  payload: unknown,
  opts: { canViewProtected: boolean; canViewCustomField: (key: string) => boolean },
): { value: unknown; redacted: string[] } {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { value: payload, redacted: [] };
  const out: Record<string, unknown> = {};
  const redacted: string[] = [];
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (!opts.canViewProtected && (PROTECTED_MEMBER_FIELDS as readonly string[]).includes(k)) {
      redacted.push(k);
      continue;
    }
    if (k === 'customFields' && v && typeof v === 'object' && !Array.isArray(v)) {
      const visible: Record<string, unknown> = {};
      for (const [ck, cv] of Object.entries(v as Record<string, unknown>)) {
        if (opts.canViewCustomField(ck)) visible[ck] = cv;
        else redacted.push(`customFields.${ck}`);
      }
      if (Object.keys(visible).length) out.customFields = visible;
      continue;
    }
    out[k] = v;
  }
  return { value: out, redacted };
}

/** Champs de contact pouvant être ouverts au libre-service (ADM-033/035). */
export const SELF_EDITABLE_CANDIDATES = ['email', 'phone', 'address', 'emergencyContactName', 'emergencyContactPhone'] as const;

// =============================================================================
// Contrôles de données communs saisie manuelle / import (audit FLT-13)
// =============================================================================

/** Naissance au plus tôt (une fiche née en 1850 est une erreur de saisie). */
export const MIN_BIRTH_DATE = '1900-01-01';

// Codes de région Unicode qui ne sont pas des pays (ZZ = inconnu, EU / UN = organisations…)
const NON_COUNTRY_REGIONS = new Set(['ZZ', 'EU', 'EZ', 'UN', 'QO', 'XA', 'XB']);
const regionNames = (() => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region', fallback: 'none' });
  } catch {
    return null;
  }
})();

/** Code pays ISO 3166-1 alpha-2 attribué (« XX » refusé). */
export function isKnownCountry(code: string | null | undefined): boolean {
  if (!code || !/^[A-Z]{2}$/.test(code) || NON_COUNTRY_REGIONS.has(code)) return false;
  // Runtime sans données ICU : seul le format est contrôlable
  if (!regionNames) return true;
  try {
    return !!regionNames.of(code);
  } catch {
    return false;
  }
}

export interface MemberDataInput {
  birthDate?: string | null;
  passportExpiry?: string | null;
  seamanBookExpiry?: string | null;
  nationality?: string | null;
  passportCountry?: string | null;
}

/**
 * Règles bloquantes partagées par `MemberDataSchema` (création / modification) et l'import Excel :
 * naissance entre 1900 et aujourd'hui, pays ISO attribués, pièces d'identité expirant après la naissance.
 * Dates en « AAAA-MM-JJ ».
 */
export function memberDataIssues(m: MemberDataInput, today = todayYmd()): { field: keyof MemberDataInput; message: string }[] {
  const issues: { field: keyof MemberDataInput; message: string }[] = [];
  if (m.birthDate) {
    if (m.birthDate < MIN_BIRTH_DATE) issues.push({ field: 'birthDate', message: `Date de naissance antérieure à ${MIN_BIRTH_DATE.slice(0, 4)} : à vérifier` });
    if (m.birthDate > today) issues.push({ field: 'birthDate', message: 'Date de naissance dans le futur' });
  }
  for (const f of ['nationality', 'passportCountry'] as const) {
    const v = m[f];
    if (v && !isKnownCountry(v)) issues.push({ field: f, message: `Code pays « ${v} » inconnu (ISO 3166-1 à 2 lettres, ex. TN, FR)` });
  }
  if (m.birthDate) {
    if (m.passportExpiry && m.passportExpiry <= m.birthDate) {
      issues.push({ field: 'passportExpiry', message: 'Expiration du passeport antérieure à la date de naissance' });
    }
    if (m.seamanBookExpiry && m.seamanBookExpiry <= m.birthDate) {
      issues.push({ field: 'seamanBookExpiry', message: 'Expiration du seaman book antérieure à la date de naissance' });
    }
  }
  return issues;
}

// =============================================================================
// Affectations & statut Member (CDC V1 §5.2, CDC §12)
// =============================================================================

/** Automate des affectations : transitions pilotées par commandes (plan / join / sign-off / cancel). */
export const CREW_TRANSITIONS: Record<CrewAssignmentStatus, CrewAssignmentStatus[]> = {
  PLANNED: ['ONBOARD', 'CANCELLED'],
  ONBOARD: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function canTransitionCrew(from: CrewAssignmentStatus, to: CrewAssignmentStatus): boolean {
  return CREW_TRANSITIONS[from].includes(to);
}

/**
 * Personnes à bord d'un navire à une date (audit FLT-02) : embarquement confirmé <= date et
 * débarquement réel >= date. Un débarquement absent n'est admis que pour ONBOARD : une
 * affectation COMPLETED sans date de débarquement n'est plus comptée « toujours à bord ».
 */
export function onboardAtDateWhere(vesselId: string, date: Date): Prisma.CrewAssignmentWhereInput {
  return {
    vesselId,
    status: { in: ['ONBOARD', 'COMPLETED'] },
    actualJoinDate: { lte: date },
    OR: [{ status: 'ONBOARD', actualSignOffDate: null }, { actualSignOffDate: { gte: date } }],
  };
}

/**
 * Audit FLT-24 : un marin encore à bord d'un autre navire ne peut pas être planifié avec un
 * embarquement prévu déjà passé (l'embarquement serait ensuite refusé).
 */
export function planBlockedByOnboardElsewhere(plannedJoinYmd: string | null, today: string, onboardElsewhere: boolean): boolean {
  return onboardElsewhere && !!plannedJoinYmd && plannedJoinYmd < today;
}

export interface ActiveAssignments {
  onboard: number;
  planned: number;
}

/**
 * Statut Member déduit des affectations actives : ON_BOARD si embarqué, PLANNED_JOIN si
 * une affectation est planifiée, sinon AVAILABLE après débarquement / annulation.
 * ON_LEAVE et INACTIVE (statuts administratifs manuels) sont conservés sans affectation active.
 */
export function deriveMemberStatus(current: MemberStatus, active: ActiveAssignments): MemberStatus {
  if (active.onboard > 0) return 'ON_BOARD';
  if (active.planned > 0) return current === 'ON_LEAVE' ? 'ON_LEAVE' : 'PLANNED_JOIN';
  if (current === 'ON_BOARD' || current === 'PLANNED_JOIN') return 'AVAILABLE';
  return current;
}

export type ManualMemberStatus = 'AVAILABLE' | 'ON_LEAVE' | 'INACTIVE';

/**
 * Changement manuel de statut administratif : ON_BOARD / PLANNED_JOIN sont réservés aux
 * affectations. Retourne le statut à stocker, ou un motif de refus.
 */
export function resolveManualStatus(
  target: ManualMemberStatus,
  active: ActiveAssignments,
): { ok: true; status: MemberStatus } | { ok: false; reason: string } {
  if (active.onboard > 0) {
    return { ok: false, reason: 'Membre embarqué : enregistrer le débarquement avant de changer son statut' };
  }
  if (active.planned > 0) {
    if (target === 'INACTIVE') {
      return { ok: false, reason: 'Affectation planifiée en cours : l’annuler avant de rendre la fiche inactive' };
    }
    return { ok: true, status: target === 'AVAILABLE' ? 'PLANNED_JOIN' : 'ON_LEAVE' };
  }
  return { ok: true, status: target };
}

// =============================================================================
// Champs personnalisés (ADM-036..039)
// =============================================================================

export interface CustomFieldDef {
  key: string;
  label: string;
  type: CustomFieldType;
  options: unknown;
  required: boolean;
}

export type CustomFieldJson = string | number | boolean | string[];

export function selectChoices(options: unknown): { choices: string[]; multiple: boolean } {
  const o = (options ?? {}) as { choices?: unknown; multiple?: unknown };
  const choices = Array.isArray(o.choices) ? o.choices.filter((c): c is string => typeof c === 'string') : [];
  return { choices, multiple: o.multiple === true };
}

/** Valide et normalise une valeur de champ personnalisé selon son type ; null = effacement. */
export function validateCustomFieldValue(
  def: CustomFieldDef,
  value: unknown,
): { ok: true; value: CustomFieldJson | null } | { ok: false; message: string } {
  const empty = value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  if (empty) {
    return def.required ? { ok: false, message: `${def.label} : champ obligatoire` } : { ok: true, value: null };
  }
  switch (def.type) {
    case 'TEXT': {
      if (typeof value !== 'string' && typeof value !== 'number') return { ok: false, message: `${def.label} : texte attendu` };
      const s = String(value).trim();
      if (s.length > 2000) return { ok: false, message: `${def.label} : 2000 caractères maximum` };
      return { ok: true, value: s };
    }
    case 'NUMBER': {
      const n = typeof value === 'number' ? value : Number(String(value).trim().replace(',', '.'));
      if (!Number.isFinite(n)) return { ok: false, message: `${def.label} : nombre attendu` };
      return { ok: true, value: n };
    }
    case 'DATE': {
      const s = String(value).trim();
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
      if (!m) return { ok: false, message: `${def.label} : date AAAA-MM-JJ attendue` };
      const d = new Date(`${s}T00:00:00.000Z`);
      if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
        return { ok: false, message: `${def.label} : date invalide` };
      }
      return { ok: true, value: s };
    }
    case 'BOOLEAN': {
      if (typeof value === 'boolean') return { ok: true, value };
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' };
      return { ok: false, message: `${def.label} : booléen attendu` };
    }
    case 'SELECT': {
      const { choices, multiple } = selectChoices(def.options);
      if (multiple) {
        const arr = Array.isArray(value) ? value : [value];
        if (!arr.every((v) => typeof v === 'string' && choices.includes(v))) {
          return { ok: false, message: `${def.label} : valeur hors liste (${choices.join(', ')})` };
        }
        if (def.required && !arr.length) return { ok: false, message: `${def.label} : champ obligatoire` };
        return { ok: true, value: [...new Set(arr as string[])] };
      }
      if (typeof value !== 'string' || !choices.includes(value)) {
        return { ok: false, message: `${def.label} : valeur hors liste (${choices.join(', ')})` };
      }
      return { ok: true, value };
    }
    default:
      return { ok: false, message: `${def.label} : type non géré` };
  }
}

// =============================================================================
// Validité calculée d'un certificat (synthèse sur la fiche — ARCHITECTURE §4)
// =============================================================================

export type CertificateValidity = 'VALID' | 'EXPIRING_SOON' | 'EXPIRED' | 'UNLIMITED' | 'EXPIRY_UNKNOWN' | 'NOT_APPROVED';

export function certificateValidity(
  kind: ExpiryKind | null,
  expiryOn: Date | null,
  today: string,
  soonDays: number,
): CertificateValidity {
  if (!kind) return 'NOT_APPROVED';
  if (kind === 'UNLIMITED') return 'UNLIMITED';
  if (kind === 'UNKNOWN' || !expiryOn) return 'EXPIRY_UNKNOWN';
  const exp = ymd(expiryOn)!;
  if (exp < today) return 'EXPIRED';
  const limit = new Date(`${today}T00:00:00.000Z`);
  limit.setUTCDate(limit.getUTCDate() + soonDays);
  return exp <= limit.toISOString().slice(0, 10) ? 'EXPIRING_SOON' : 'VALID';
}
