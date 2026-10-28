import { ExcelService } from '../documents/excel.service';
import {
  DUPLICATE_THRESHOLD,
  DuplicateReason,
  MemberIdentity,
  PROTECTED_MEMBER_FIELDS,
  cleanText,
  idKey,
  identityKeys,
  nameKey,
  normalizeRef,
  sameValue,
  scoreDuplicate,
  stripAccents,
  ymd,
} from './members.logic';

/**
 * Logique pure de l'import Excel Members (ADM-040..043, CDC V1 §5.3) :
 * suggestion de mapping par en-têtes normalisés, normalisation des cellules (dates JJ.MM.AAAA,
 * dates Excel, PERMANENT, vides), découpage de nom, référentiels (rangs, nationalités),
 * doublons internes au fichier, statut de ligne et diff valeurs courantes / import.
 */

// =============================================================================
// Cibles de mapping
// =============================================================================

export const MEMBER_IMPORT_FIELDS = [
  'amcRef',
  'lastName',
  'firstName',
  'birthDate',
  'birthPlace',
  'nationality',
  'gender',
  'email',
  'phone',
  'address',
  'emergencyContactName',
  'emergencyContactPhone',
  'passportNumber',
  'passportCountry',
  'passportExpiry',
  'seamanBookNumber',
  'seamanBookExpiry',
  'rank',
  'crewDepartment',
  'notes',
] as const;
export type MemberImportField = (typeof MEMBER_IMPORT_FIELDS)[number];

/** Cibles hors fiche : nom complet (découpé), dates d'embarquement, navire, colonne ignorée. */
export const EXTRA_IMPORT_TARGETS = ['fullName', 'joinDate', 'signOffDate', 'vessel', 'ignore'] as const;
export type ExtraImportTarget = (typeof EXTRA_IMPORT_TARGETS)[number];

export type CertificatePart = 'combined' | 'number' | 'expiry' | 'issued';

export type MappingTarget =
  | { kind: 'field'; field: MemberImportField }
  | { kind: 'extra'; target: Exclude<ExtraImportTarget, 'ignore'> }
  | { kind: 'certificate'; code: string; part: CertificatePart }
  | { kind: 'ignore' };

const CERT_TARGET_RE = /^certificate:([A-Z0-9_-]{1,40})(?::(number|expiry|issued))?$/i;

/** Analyse une cible textuelle : champ Member, `certificate:<CODE>[:number|expiry|issued]`, extra ou `ignore`. */
export function parseMappingTarget(raw: string): MappingTarget | null {
  const t = raw.trim();
  if (!t || t === 'ignore') return { kind: 'ignore' };
  if ((MEMBER_IMPORT_FIELDS as readonly string[]).includes(t)) return { kind: 'field', field: t as MemberImportField };
  if ((EXTRA_IMPORT_TARGETS as readonly string[]).includes(t)) return { kind: 'extra', target: t as Exclude<ExtraImportTarget, 'ignore'> };
  const m = CERT_TARGET_RE.exec(t);
  if (m) return { kind: 'certificate', code: m[1].toUpperCase(), part: (m[2]?.toLowerCase() as CertificatePart | undefined) ?? 'combined' };
  return null;
}

export function targetToString(t: MappingTarget): string {
  switch (t.kind) {
    case 'field':
      return t.field;
    case 'extra':
      return t.target;
    case 'certificate':
      return t.part === 'combined' ? `certificate:${t.code}` : `certificate:${t.code}:${t.part}`;
    default:
      return 'ignore';
  }
}

// =============================================================================
// En-têtes : normalisation et suggestion
// =============================================================================

/** "Date de naissance (JJ.MM.AAAA)" -> "DATE DE NAISSANCE" ; "N° Passeport" -> "N PASSEPORT". */
export function normalizeHeaderText(h: unknown): string {
  return ExcelService.normalizeHeader(h)
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function columnIndex(letter: string): number {
  let n = 0;
  for (const c of letter.toUpperCase()) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * Résout une clé de mapping en index de colonne : texte d'en-tête exact (normalisé, unique)
 * en priorité — « SAT » est un en-tête, pas la colonne SAT — sinon lettre de colonne (A, B, … AA).
 * Retourne -1 si inconnue, -2 si l'en-tête est ambigu (présent plusieurs fois).
 */
export function resolveColumnKey(key: string, headers: string[]): number {
  const nk = normalizeHeaderText(key);
  if (nk) {
    const matches = headers.map((h, i) => [normalizeHeaderText(h), i] as const).filter(([h]) => h === nk);
    if (matches.length === 1) return matches[0][1];
    if (matches.length > 1 && !/^[A-Z]{1,3}$/.test(key.trim())) return -2;
  }
  const k = key.trim().toUpperCase();
  if (/^[A-Z]{1,3}$/.test(k)) {
    const idx = columnIndex(k);
    if (idx < headers.length) return idx;
  }
  return -1;
}

const FIELD_SYNONYMS: Record<MemberImportField | Exclude<ExtraImportTarget, never>, string[]> = {
  lastName: ['NOM', 'NAME', 'LAST NAME', 'SURNAME', 'FAMILY NAME', 'NOM DE FAMILLE', 'NOMS'],
  firstName: ['PRENOM', 'PRENOMS', 'FIRST NAME', 'GIVEN NAME', 'GIVEN NAMES', 'FORENAME', 'FIRSTNAME'],
  fullName: [
    'NOM ET PRENOM', 'NOM PRENOM', 'NOMS ET PRENOMS', 'NOM ET PRENOMS', 'NOM PRENOMS', 'NOMS PRENOMS',
    'FULL NAME', 'FULLNAME', 'NAME AND SURNAME', 'NAME SURNAME', 'SURNAME AND NAME', 'SURNAME NAME', 'IDENTITE',
  ],
  birthDate: [
    'DATE NAISSANCE', 'DATE DE NAISSANCE', 'DATE NAISS', 'D NAISSANCE', 'NE LE', 'NEE LE', 'NAISSANCE',
    'DATE OF BIRTH', 'BIRTH DATE', 'BIRTHDATE', 'DOB', 'D O B',
  ],
  birthPlace: ['LIEU DE NAISSANCE', 'LIEU NAISSANCE', 'PLACE OF BIRTH', 'POB', 'BIRTH PLACE'],
  nationality: ['NATIONALITE', 'NATIONALITY', 'NAT'],
  gender: ['SEXE', 'GENRE', 'GENDER', 'SEX'],
  amcRef: [
    'MATRICULE', 'MAT', 'N MATRICULE', 'NO MATRICULE', 'MATRICULE AMC', 'AMC ID', 'ID AMC', 'AMC REF',
    'REF AMC', 'REFERENCE AMC', 'AMC', 'CODE AMC', 'ID',
  ],
  passportNumber: [
    'PASSEPORT', 'PASSPORT', 'N PASSEPORT', 'NO PASSEPORT', 'NUMERO PASSEPORT', 'PASSEPORT N', 'PASSEPORT NO',
    'PASSPORT NO', 'PASSPORT N', 'PASSPORT NUMBER', 'PASSPORT NR', 'N PASSPORT',
  ],
  passportCountry: ['PAYS PASSEPORT', 'PASSPORT COUNTRY', 'PAYS EMETTEUR PASSEPORT', 'PASSPORT ISSUING COUNTRY'],
  passportExpiry: [
    'EXPIRATION PASSEPORT', 'DATE EXPIRATION PASSEPORT', 'VALIDITE PASSEPORT', 'PASSEPORT EXPIRATION',
    'PASSEPORT VALIDITE', 'PASSPORT EXPIRY', 'PASSPORT EXP', 'PASSPORT EXPIRY DATE', 'PASSPORT VALIDITY',
  ],
  seamanBookNumber: [
    'SEAMAN BOOK', 'SEAMANS BOOK', 'SEAMAN S BOOK', 'SEAMAN BOOK NO', 'SEAMAN BOOK N', 'SEAMAN BOOK NUMBER',
    'LIVRET', 'LIVRET MARITIME', 'N LIVRET', 'NO LIVRET', 'LIVRET PROFESSIONNEL MARITIME', 'FASCICULE',
    'DISCHARGE BOOK', 'CDC', 'LIVRET MARIN',
  ],
  seamanBookExpiry: [
    'SEAMAN BOOK EXPIRY', 'SEAMAN BOOK EXP', 'SEAMANS BOOK EXPIRY', 'EXPIRATION LIVRET', 'VALIDITE LIVRET',
    'LIVRET EXPIRATION', 'LIVRET VALIDITE',
  ],
  rank: ['FONCTION', 'RANK', 'GRADE', 'POSTE', 'POSITION', 'CAPACITY', 'QUALITE', 'EMPLOI', 'FONCTION A BORD'],
  crewDepartment: ['SERVICE', 'DEPARTEMENT', 'DEPARTMENT', 'SPECIALITE'],
  phone: ['TEL', 'TELEPHONE', 'PHONE', 'MOBILE', 'GSM', 'PORTABLE', 'N TEL', 'NUMERO DE TELEPHONE', 'CONTACT'],
  email: ['EMAIL', 'E MAIL', 'MAIL', 'ADRESSE MAIL', 'ADRESSE EMAIL', 'COURRIEL'],
  address: ['ADRESSE', 'ADDRESS', 'DOMICILE'],
  emergencyContactName: ['CONTACT URGENCE', 'CONTACT D URGENCE', 'PERSONNE A CONTACTER', 'EMERGENCY CONTACT', 'NEXT OF KIN'],
  emergencyContactPhone: ['TEL URGENCE', 'TELEPHONE URGENCE', 'EMERGENCY PHONE', 'EMERGENCY CONTACT PHONE'],
  notes: ['OBSERVATION', 'OBSERVATIONS', 'REMARQUE', 'REMARQUES', 'REMARKS', 'COMMENTAIRE', 'COMMENTAIRES', 'NOTES', 'NOTE'],
  joinDate: [
    'EMBARQUEMENT', 'DATE EMBARQUEMENT', 'DATE D EMBARQUEMENT', 'DATE EMBARQ', 'EMBARQ', 'EMBARQUE LE',
    'SIGN ON', 'SIGN ON DATE', 'SIGNED ON', 'JOINING DATE', 'DATE OF JOINING', 'JOINED',
  ],
  signOffDate: [
    'DEBARQUEMENT', 'DATE DEBARQUEMENT', 'DATE DE DEBARQUEMENT', 'DATE DEBARQ', 'DEBARQ', 'DEBARQUE LE',
    'SIGN OFF', 'SIGN OFF DATE', 'SIGNED OFF', 'DATE OF SIGN OFF',
  ],
  vessel: ['NAVIRE', 'VESSEL', 'SHIP', 'BATEAU', 'NAVIRE ACTUEL'],
  ignore: ['N', 'NO', 'NUM', 'NUMERO', 'N O', 'ORDRE', 'N ORDRE', 'ITEM', 'S N', 'SN'],
};

/** Synonymes des colonnes certificats du fichier AMC (codes des types MEMBER du seed). */
export const CERTIFICATE_SYNONYMS: Record<string, string[]> = {
  SSO: ['SSO', 'SHIP SECURITY OFFICER'],
  SDSD: ['SDSD', 'DSD', 'DESIGNATED SECURITY DUTIES', 'SECURITY DUTIES'],
  SAT: ['SAT', 'SECURITY AWARENESS', 'SECURITY AWARENESS TRAINING'],
  GMDSS: ['GMDSS', 'GOC', 'ROC', 'GMDSS GOC', 'GMDSS ROC'],
  ARPA: ['ARPA', 'RADAR', 'RADAR ARPA', 'ARPA RADAR'],
  MEDICAL: [
    'MEDICAL', 'MEDICAL EXAM', 'MEDICAL EXAMINATION', 'MEDICAL CERTIFICATE', 'MEDICAL FITNESS', 'MEDICALE',
    'VISITE MEDICALE', 'CERTIFICAT MEDICAL', 'APTITUDE MEDICALE', 'APTITUDE',
  ],
  BST: ['BST', 'BASIC SAFETY', 'BASIC SAFETY TRAINING', 'STCW BASIC', 'FORMATION DE BASE', 'FORMATION BASE'],
  AFF: [
    'AFF', 'ADVANCED FIRE FIGHTING', 'ADVANCED FIREFIGHTING', 'FIRE FIGHTING', 'FIREFIGHTING', 'LUTTE INCENDIE',
    'LUTTE CONTRE L INCENDIE', 'INCENDIE',
  ],
  SRB: ['SRB', 'SEAMAN RECORD BOOK', 'SEAMANS RECORD BOOK', 'SEAMAN S RECORD BOOK'],
  ENDORS: ['ENDORS', 'ENDORSEMENT', 'ENDORSEMENTS', 'FLAG ENDORSEMENT', 'ENDOS', 'VISA PAVILLON'],
  COC: ['COC', 'CERTIFICATE OF COMPETENCY', 'BREVET', 'CERTIFICAT DE CAPACITE', 'CAPACITE', 'COMPETENCY'],
  PSCRB: ['PSCRB', 'SURVIVAL CRAFT', 'RESCUE BOAT', 'CANOT DE SAUVETAGE', 'EMBARCATIONS DE SAUVETAGE'],
  MFA: ['MFA', 'MEDICAL FIRST AID', 'FIRST AID', 'MEDICAL CARE', 'SECOURISME', 'PREMIERS SECOURS'],
};

const EXPIRY_TOKENS = new Set(['EXP', 'EXPIRY', 'EXPIRATION', 'EXPIRE', 'EXPIRES', 'VALIDITE', 'VALIDITY', 'VALID', 'ECHEANCE', 'FIN', 'UNTIL']);
const NUMBER_TOKENS = new Set(['N', 'NO', 'NUM', 'NUMERO', 'NUMBER', 'NR', 'REF']);
const ISSUE_TOKENS = new Set(['DELIVRANCE', 'DELIVRE', 'ISSUE', 'ISSUED', 'EMISSION', 'OBTENTION']);

const FIELD_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [target, syns] of Object.entries(FIELD_SYNONYMS)) for (const s of syns) if (!m.has(s)) m.set(s, target);
  return m;
})();

function containsSequence(tokens: string[], seq: string[]): number {
  outer: for (let i = 0; i + seq.length <= tokens.length; i++) {
    for (let j = 0; j < seq.length; j++) if (tokens[i + j] !== seq[j]) continue outer;
    return i;
  }
  return -1;
}

/**
 * Suggère une cible pour un en-tête : champ Member (synonymes FR/EN), puis colonne certificat
 * (code ou synonyme du type, suffixe EXP/N°/DELIVRANCE => partie), puis préfixe de champ.
 */
export function suggestTarget(header: unknown, certificateCodes: ReadonlySet<string>): string | null {
  const n = normalizeHeaderText(header);
  if (!n) return null;
  const exact = FIELD_INDEX.get(n);
  if (exact) return exact;

  const tokens = n.split(' ');
  let best: { code: string; at: number; len: number } | null = null;
  for (const code of certificateCodes) {
    for (const syn of [code, ...(CERTIFICATE_SYNONYMS[code] ?? [])]) {
      const seq = syn.split(' ');
      const at = containsSequence(tokens, seq);
      if (at >= 0 && (!best || seq.length > best.len)) best = { code, at, len: seq.length };
    }
  }
  if (best) {
    const b = best;
    const rest = tokens.filter((_, i) => i < b.at || i >= b.at + b.len);
    const part: CertificatePart = rest.some((t) => EXPIRY_TOKENS.has(t))
      ? 'expiry'
      : rest.some((t) => ISSUE_TOKENS.has(t))
        ? 'issued'
        : rest.some((t) => NUMBER_TOKENS.has(t))
          ? 'number'
          : 'combined';
    return part === 'combined' ? `certificate:${b.code}` : `certificate:${b.code}:${part}`;
  }

  // Préfixe : « DATE DE NAISSANCE JJ MM AAAA », « PASSEPORT EXP DATE »…
  let prefix: { target: string; len: number } | null = null;
  for (const [syn, target] of FIELD_INDEX) {
    if (target === 'ignore' || syn.length < 3) continue;
    if ((n.startsWith(`${syn} `) || n.endsWith(` ${syn}`)) && (!prefix || syn.length > prefix.len)) prefix = { target, len: syn.length };
  }
  if (prefix) {
    const hasExpiry = tokens.some((t) => EXPIRY_TOKENS.has(t));
    if (hasExpiry && prefix.target === 'passportNumber') return 'passportExpiry';
    if (hasExpiry && prefix.target === 'seamanBookNumber') return 'seamanBookExpiry';
    return prefix.target;
  }
  return null;
}

/** Mapping suggéré pour une feuille : { lettre de colonne -> cible } (une cible n'est proposée qu'une fois). */
export function suggestMapping(headers: string[], certificateCodes: ReadonlySet<string>): Record<string, string> {
  const used = new Set<string>();
  const out: Record<string, string> = {};
  headers.forEach((h, i) => {
    const target = suggestTarget(h, certificateCodes);
    if (!target) return;
    if (target !== 'ignore' && used.has(target)) return;
    used.add(target);
    out[columnLetter(i)] = target;
  });
  // fullName et lastName/firstName exclusifs : privilégier les colonnes séparées
  if (Object.values(out).includes('fullName') && Object.values(out).includes('lastName') && Object.values(out).includes('firstName')) {
    for (const [k, v] of Object.entries(out)) if (v === 'fullName') delete out[k];
  }
  return out;
}

/** Département par défaut déduit du nom de feuille (« OFFICIE PONT » -> DECK) lorsqu'il est univoque. */
export function suggestSheetDefaults(sheetName: string): { crewDepartment?: 'DECK' | 'ENGINE' | 'CATERING' } {
  const n = normalizeHeaderText(sheetName);
  const deck = /\b(PONT|DECK|MATLOT|MATELOT|MATELOTS|BOSUN|BOSCO)\b/.test(n);
  const engine = /\b(MACHINE|ENGINE|GRAISSEUR|GRAISSEURS|MECANICIEN|MECANICIENS|OILER|OILERS)\b/.test(n);
  const catering = /\b(COOK|CUISINE|CUISINIER|CATERING|STEWARD)\b/.test(n);
  const count = [deck, engine, catering].filter(Boolean).length;
  if (count !== 1) return {};
  return { crewDepartment: deck ? 'DECK' : engine ? 'ENGINE' : 'CATERING' };
}

/** En-têtes d'une feuille (1 ou 2 lignes ; 2 lignes => « GMDSS » fusionné + « EXP » = « GMDSS EXP »). */
export function buildHeaders(rows: unknown[][], headerIndex: number, headerRowCount: 1 | 2): string[] {
  const width = rows.reduce((w, r) => Math.max(w, r.length), 0);
  const top = rows[headerIndex] ?? [];
  const bottom = headerRowCount === 2 ? rows[headerIndex + 1] ?? [] : [];
  let carry = '';
  const headers: string[] = [];
  for (let i = 0; i < width; i++) {
    const t = ExcelService.cellText(top[i]) ?? '';
    if (t) carry = t;
    if (headerRowCount === 2) {
      const b = ExcelService.cellText(bottom[i]) ?? '';
      headers.push(b ? [t || carry, b].filter(Boolean).join(' ') : t);
    } else {
      headers.push(t);
    }
  }
  return headers;
}

/** Valeur de cellule sérialisable JSON (dates en AAAA-MM-JJ calendaires, jamais décalées par le fuseau). */
export function rawCellToJson(v: unknown): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    const p = ExcelService.parseDate(v);
    return p.kind === 'DATE' ? p.value : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  const s = String(v).trim();
  return s.length ? s : null;
}

// =============================================================================
// Normalisation des cellules
// =============================================================================

export type DateCellKind = 'birth' | 'expiry' | 'event';

export type DateCell =
  | { kind: 'DATE'; value: string }
  | { kind: 'UNLIMITED' }
  | { kind: 'EMPTY' }
  | { kind: 'INVALID'; raw: string; reason?: string };

/**
 * Date d'une cellule via ExcelService.parseDate (JJ.MM.AAAA, série Excel, PERMANENT -> UNLIMITED,
 * vide -> EMPTY) + garde-fous : une année seule (« 1985 ») n'est pas une série Excel.
 */
export function parseDateCell(value: unknown, kind: DateCellKind = 'event'): DateCell {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1900 && value <= 2100 && kind === 'birth') {
    return { kind: 'INVALID', raw: String(value), reason: 'année seule' };
  }
  const p = ExcelService.parseDate(value);
  if (p.kind === 'DATE' && kind === 'birth' && p.value > new Date().toISOString().slice(0, 10)) {
    return { kind: 'INVALID', raw: p.value, reason: 'date future' };
  }
  return p;
}

const ABSENT_TOKENS = new Set(['NON', 'NO', 'N', 'NEANT', 'AUCUN', 'AUCUNE', 'NONE', 'NIL', 'SANS', 'PAS', 'X NON']);
const PRESENT_TOKENS = new Set(['OUI', 'YES', 'Y', 'X', 'OK', '✓', '✔', 'V', 'VALIDE', 'VALID']);
const DATE_IN_TEXT = /(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/g;
const UNLIMITED_IN_TEXT = /\b(PERMANENT|PERMANENTE|ILLIMITE|ILLIMITEE|UNLIMITED|NO EXPIRY)\b/;

export type CertificateCell =
  | { present: false; warning?: string }
  | { present: true; number: string | null; expiry: DateCell; issued: string | null };

/**
 * Cellule « certificat » (colonne combinée) : date d'expiration, PERMANENT, numéro seul,
 * « numéro + date », « date délivrance - date expiration », OUI/X (présent, expiration inconnue).
 * Les nombres entiers 20000..80000 sont des séries Excel (1954..2119) ; les autres sont des numéros.
 */
export function parseCertificateCell(value: unknown): CertificateCell {
  if (value === null || value === undefined) return { present: false };
  if (value instanceof Date) {
    const p = ExcelService.parseDate(value);
    return p.kind === 'DATE' ? { present: true, number: null, expiry: p, issued: null } : { present: false };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= 20000 && value <= 80000) {
      return { present: true, number: null, expiry: ExcelService.parseDate(value), issued: null };
    }
    return { present: true, number: String(value), expiry: { kind: 'EMPTY' }, issued: null };
  }
  const s = cleanText(String(value));
  if (!s) return { present: false };
  const upper = stripAccents(s).toUpperCase();
  if (ABSENT_TOKENS.has(upper) || /^(-+|—|N\/?A)$/i.test(s)) return { present: false };
  if (PRESENT_TOKENS.has(upper)) return { present: true, number: null, expiry: { kind: 'EMPTY' }, issued: null };

  const direct = ExcelService.parseDate(s);
  if (direct.kind === 'DATE' || direct.kind === 'UNLIMITED') return { present: true, number: null, expiry: direct, issued: null };
  if (direct.kind === 'EMPTY') return { present: false };

  // Texte composite : extraire dates / PERMANENT, le reste est le numéro
  const dates: string[] = [];
  let rest = s.replace(DATE_IN_TEXT, (m) => {
    const p = ExcelService.parseDate(m);
    if (p.kind === 'DATE') dates.push(p.value);
    return ' ';
  });
  const unlimited = UNLIMITED_IN_TEXT.test(stripAccents(rest).toUpperCase());
  if (unlimited) rest = stripAccents(rest).toUpperCase().replace(UNLIMITED_IN_TEXT, ' ');
  rest = rest
    .replace(/N[°º]/g, ' ')
    .replace(/\b(EXP|EXPIRY|EXPIRATION|VALIDITE|VALID|UNTIL|DU|AU|LE|NO|NUM|DELIVRE|ISSUED)\b\.?/gi, ' ')
    .replace(/^[\s:;,/\-–—]+|[\s:;,/\-–—]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const number = /[A-Za-z0-9]/.test(rest) && /\d/.test(rest) ? rest.slice(0, 120) : null;
  if (!dates.length && !unlimited && !number) {
    return { present: false, warning: `Valeur « ${s.slice(0, 60)} » non reconnue (ni date, ni PERMANENT, ni numéro) : certificat ignoré` };
  }
  dates.sort();
  const expiry: DateCell = unlimited ? { kind: 'UNLIMITED' } : dates.length ? { kind: 'DATE', value: dates[dates.length - 1] } : { kind: 'EMPTY' };
  const issued = dates.length > 1 || (unlimited && dates.length === 1) ? dates[0] : null;
  return { present: true, number, expiry, issued };
}

// =============================================================================
// Référentiels : rangs, nationalités, genre, navires
// =============================================================================

export interface RankRef {
  code: string;
  name: string;
  crewDepartment: 'DECK' | 'ENGINE' | 'CATERING' | 'OTHER';
}

/** Abréviations usuelles (bord / crewing) -> codes des rangs du référentiel. */
const RANK_ALIASES: Record<string, string[]> = {
  MASTER: ['MASTER', 'CAPITAINE', 'CAPT', 'CAPTAIN', 'CDT', 'COMMANDANT', 'CPT'],
  C_OFF: ['CO', 'CHOFF', 'CHIEFOFFICER', 'CHIEFMATE', 'SECONDCAPITAINE', 'SECOND', 'CHIEFOFF', '1STOFFICER', '1STOFF', 'FIRSTOFFICER', 'SECONDCAPT'],
  '2_OFF': ['2O', '2NDOFF', '2NDOFFICER', 'SECONDOFFICER', 'LIEUTENANT', 'LTN', 'LT', '2NDMATE'],
  '3_OFF': ['3O', '3RDOFF', '3RDOFFICER', 'THIRDOFFICER', '3RDMATE'],
  BOSUN: ['BOSUN', 'BOSCO', 'MAITREDEQUIPAGE', 'MAITREEQUIPAGE', 'BOATSWAIN'],
  AB: ['AB', 'ABLESEAMAN', 'MATELOT', 'MATELOTQUALIFIE', 'ABS'],
  OS: ['OS', 'ORDINARYSEAMAN', 'MATELOTLEGER', 'NOVICE'],
  C_ENG: ['CE', 'CHENG', 'CHIEFENGINEER', 'CHEFMECANICIEN', 'CHEFMECANO', 'CHIEFENG'],
  '2_ENG': ['2E', '2NDENG', '2NDENGINEER', 'SECONDENGINEER', 'SECONDMECANICIEN', '2EMECANICIEN'],
  '3_ENG': ['3E', '3RDENG', '3RDENGINEER', 'THIRDENGINEER', 'TROISIEMEMECANICIEN', '3EMECANICIEN'],
  ELEC: ['ELEC', 'ELECTRICIAN', 'ELECTRICIEN', 'ETO', 'ELECTROTECHNICIEN'],
  OILER: ['OILER', 'GRAISSEUR', 'MOTORMAN'],
  WIPER: ['WIPER', 'NETTOYEUR'],
  COOK: ['COOK', 'CUISINIER', 'CHIEFCOOK', 'CHEFCUISINIER', 'CUISTOT'],
  STEWARD: ['STEWARD', 'MESSMAN', 'GARCON', 'SERVEUR'],
};

/** Rapproche une fonction saisie du référentiel des rangs (code, segments du libellé, abréviations). */
export function resolveRank(text: string, ranks: RankRef[]): RankRef | null {
  const k = idKey(text);
  if (!k) return null;
  for (const r of ranks) {
    if (idKey(r.code) === k) return r;
    if (idKey(r.name) === k) return r;
    if (r.name.split('/').some((seg) => idKey(seg) === k)) return r;
  }
  for (const [code, aliases] of Object.entries(RANK_ALIASES)) {
    if (aliases.includes(k)) {
      const r = ranks.find((x) => x.code === code);
      if (r) return r;
    }
  }
  return null;
}

const NATIONALITIES: Record<string, string[]> = {
  TN: ['TUNISIE', 'TUNISIEN', 'TUNISIENNE', 'TUNISIAN', 'TUNISIA', 'TUN'],
  FR: ['FRANCE', 'FRANCAIS', 'FRANCAISE', 'FRENCH', 'FRA'],
  MA: ['MAROC', 'MAROCAIN', 'MAROCAINE', 'MOROCCAN', 'MOROCCO', 'MAR'],
  DZ: ['ALGERIE', 'ALGERIEN', 'ALGERIENNE', 'ALGERIAN', 'ALGERIA', 'DZA'],
  LY: ['LIBYE', 'LIBYEN', 'LIBYENNE', 'LIBYAN', 'LIBYA', 'LBY'],
  EG: ['EGYPTE', 'EGYPTIEN', 'EGYPTIENNE', 'EGYPTIAN', 'EGYPT', 'EGY'],
  MR: ['MAURITANIE', 'MAURITANIEN', 'MAURITANIENNE', 'MAURITANIAN', 'MRT'],
  SN: ['SENEGAL', 'SENEGALAIS', 'SENEGALAISE', 'SENEGALESE', 'SEN'],
  CI: ['COTE D IVOIRE', 'COTEDIVOIRE', 'IVOIRIEN', 'IVOIRIENNE', 'IVORIAN', 'CIV'],
  CM: ['CAMEROUN', 'CAMEROUNAIS', 'CAMEROUNAISE', 'CAMEROON', 'CAMEROONIAN', 'CMR'],
  ML: ['MALI', 'MALIEN', 'MALIENNE', 'MALIAN', 'MLI'],
  GH: ['GHANA', 'GHANEEN', 'GHANEENNE', 'GHANAIAN', 'GHA'],
  NG: ['NIGERIA', 'NIGERIAN', 'NIGERIANE', 'NGA'],
  IT: ['ITALIE', 'ITALIEN', 'ITALIENNE', 'ITALIAN', 'ITALY', 'ITA'],
  ES: ['ESPAGNE', 'ESPAGNOL', 'ESPAGNOLE', 'SPANISH', 'SPAIN', 'ESP'],
  PT: ['PORTUGAL', 'PORTUGAIS', 'PORTUGAISE', 'PORTUGUESE', 'PRT'],
  GR: ['GRECE', 'GREC', 'GRECQUE', 'GREEK', 'GREECE', 'GRC'],
  MT: ['MALTE', 'MALTAIS', 'MALTAISE', 'MALTESE', 'MALTA', 'MLT'],
  TR: ['TURQUIE', 'TURC', 'TURQUE', 'TURKISH', 'TURKEY', 'TUR'],
  BE: ['BELGIQUE', 'BELGE', 'BELGIAN', 'BELGIUM', 'BEL'],
  PH: ['PHILIPPINES', 'PHILIPPIN', 'PHILIPPINE', 'FILIPINO', 'PHL'],
  IN: ['INDE', 'INDIEN', 'INDIENNE', 'INDIAN', 'INDIA', 'IND'],
  UA: ['UKRAINE', 'UKRAINIEN', 'UKRAINIENNE', 'UKRAINIAN', 'UKR'],
  RU: ['RUSSIE', 'RUSSE', 'RUSSIAN', 'RUSSIA', 'RUS'],
};
const NATIONALITY_INDEX: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [iso, names] of Object.entries(NATIONALITIES)) for (const n of names) m.set(n.replace(/\s+/g, ''), iso);
  return m;
})();

/** Nationalité -> ISO 3166-1 alpha-2 (contrainte CHECK en base). */
export function resolveCountry(text: string): string | null {
  const k = idKey(text);
  if (/^[A-Z]{2}$/.test(k)) return k;
  return NATIONALITY_INDEX.get(k) ?? null;
}

export function resolveGender(text: string): 'M' | 'F' | null {
  const k = idKey(text);
  if (['M', 'H', 'MALE', 'MASCULIN', 'HOMME', 'MAN'].includes(k)) return 'M';
  if (['F', 'FEMALE', 'FEMININ', 'FEMME', 'WOMAN'].includes(k)) return 'F';
  return null;
}

export function resolveCrewDepartment(text: string): 'DECK' | 'ENGINE' | 'CATERING' | 'OTHER' | null {
  const k = idKey(text);
  if (['DECK', 'PONT', 'D'].includes(k)) return 'DECK';
  if (['ENGINE', 'MACHINE', 'E', 'ENGINEROOM'].includes(k)) return 'ENGINE';
  if (['CATERING', 'CUISINE', 'HOTEL', 'GALLEY', 'C'].includes(k)) return 'CATERING';
  if (['OTHER', 'AUTRE'].includes(k)) return 'OTHER';
  return null;
}

export interface VesselRef {
  id: string;
  code: string;
  name: string;
  imoNumber: string | null;
}

export function resolveVessel(text: string, vessels: VesselRef[]): VesselRef | null {
  const k = idKey(text);
  if (!k) return null;
  return (
    vessels.find((v) => idKey(v.code) === k) ??
    vessels.find((v) => v.imoNumber && idKey(v.imoNumber) === k.replace(/^IMO/, '')) ??
    vessels.find((v) => idKey(v.name) === k) ??
    vessels.find((v) => idKey(v.name).replace(/^(MV|MT|MS|NM)/, '') === k.replace(/^(MV|MT|MS|NM)/, '')) ??
    null
  );
}

const NAME_PARTICLES = new Set(['BEN', 'BENT', 'BOU', 'EL', 'AL', 'ABDEL', 'ABD', 'AIT', 'OULD', 'DE', 'DU', 'DES', 'LE', 'LA', 'DA', 'DOS', 'DI', 'VAN', 'VON', 'MC', 'MAC', 'SIDI']);

/**
 * Découpe « NOM Prénom » : jetons initiaux en MAJUSCULES = nom ; sinon premier jeton (+ particules
 * BEN / EL / AIT…) = nom. `confident=false` => avertissement « vérifier le découpage ».
 */
export function splitFullName(full: string): { lastName: string; firstName: string; confident: boolean } | null {
  const tokens = cleanText(full).split(' ').filter(Boolean);
  if (tokens.length < 2) return null;
  const isUpper = (t: string) => t === t.toUpperCase() && t !== t.toLowerCase();
  let upperPrefix = 0;
  while (upperPrefix < tokens.length && isUpper(tokens[upperPrefix])) upperPrefix++;
  if (upperPrefix > 0 && upperPrefix < tokens.length) {
    return { lastName: tokens.slice(0, upperPrefix).join(' '), firstName: tokens.slice(upperPrefix).join(' '), confident: true };
  }
  let cut = 1;
  while (cut < tokens.length - 1 && NAME_PARTICLES.has(stripAccents(tokens[cut - 1]).toUpperCase())) cut++;
  return { lastName: tokens.slice(0, cut).join(' '), firstName: tokens.slice(cut).join(' '), confident: false };
}

// =============================================================================
// Normalisation d'une ligne
// =============================================================================

export interface NormalizedMember {
  amcRef?: string;
  lastName?: string;
  firstName?: string;
  birthDate?: string;
  birthPlace?: string;
  nationality?: string;
  gender?: string;
  email?: string;
  phone?: string;
  address?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  passportNumber?: string;
  passportCountry?: string;
  passportExpiry?: string;
  seamanBookNumber?: string;
  seamanBookExpiry?: string;
  rank?: string;
  crewDepartment?: 'DECK' | 'ENGINE' | 'CATERING' | 'OTHER';
  notes?: string;
}

export interface ImportedCertificate {
  code: string;
  number: string | null;
  expiryKind: 'DATED' | 'UNLIMITED' | 'UNKNOWN';
  expiryOn: string | null;
  issuedOn: string | null;
  /** Colonnes source (lettres) */
  columns: string[];
}

export interface ImportedAssignment {
  joinDate: string | null;
  signOffDate: string | null;
  vesselText: string | null;
}

export interface NormalizedRow {
  member: NormalizedMember;
  certificates: ImportedCertificate[];
  assignment: ImportedAssignment | null;
}

export interface RowIssue {
  column?: string;
  field?: string;
  message: string;
}

export interface ImportColumn {
  letter: string;
  header: string;
  target: MappingTarget;
}

export interface ImportRefData {
  ranks: RankRef[];
  certificateCodes: ReadonlySet<string>;
  defaults?: { rank?: string | null; crewDepartment?: 'DECK' | 'ENGINE' | 'CATERING' | 'OTHER' | null };
}

const MAX_LENGTHS: Partial<Record<MemberImportField, number>> = {
  amcRef: 32,
  lastName: 120,
  firstName: 120,
  birthPlace: 120,
  email: 320,
  phone: 64,
  address: 500,
  emergencyContactName: 200,
  emergencyContactPhone: 64,
  passportNumber: 32,
  seamanBookNumber: 32,
  rank: 120,
  notes: 5000,
};

const IDENTITY_TARGETS = new Set(['lastName', 'firstName', 'fullName', 'amcRef', 'passportNumber', 'seamanBookNumber']);

/** Ligne sans aucune valeur d'identité (séparateur, titre de section, ligne de total) : ignorée. */
export function isBlankRow(cells: Record<string, unknown>, columns: ImportColumn[]): boolean {
  return !columns.some((c) => {
    const key = c.target.kind === 'field' ? c.target.field : c.target.kind === 'extra' ? c.target.target : '';
    return IDENTITY_TARGETS.has(key) && ExcelService.cellText(cells[c.letter]) !== null;
  });
}

/** Normalise une ligne Excel selon le mapping : champs Member, certificats, embarquement. */
export function normalizeImportRow(
  cells: Record<string, unknown>,
  columns: ImportColumn[],
  ref: ImportRefData,
): { normalized: NormalizedRow; errors: RowIssue[]; warnings: RowIssue[] } {
  const member: NormalizedMember = {};
  const errors: RowIssue[] = [];
  const warnings: RowIssue[] = [];
  const certs = new Map<string, { number: string | null; expiry: DateCell | null; issued: string | null; columns: string[]; present: boolean }>();
  const assignment: ImportedAssignment = { joinDate: null, signOffDate: null, vesselText: null };
  let fullName: { value: string; column: string } | null = null;
  let rankFromColumn = false;
  let deptFromColumn = false;

  const cert = (code: string) => {
    let c = certs.get(code);
    if (!c) {
      c = { number: null, expiry: null, issued: null, columns: [], present: false };
      certs.set(code, c);
    }
    return c;
  };

  for (const col of columns) {
    const value = cells[col.letter];
    const t = col.target;
    if (t.kind === 'ignore') continue;

    if (t.kind === 'certificate') {
      const c = cert(t.code);
      if (t.part === 'combined') {
        const parsed = parseCertificateCell(value);
        if (!parsed.present) {
          if (parsed.warning) warnings.push({ column: col.letter, field: `certificate:${t.code}`, message: parsed.warning });
          continue;
        }
        c.present = true;
        c.columns.push(col.letter);
        c.number ??= parsed.number;
        if (parsed.expiry.kind !== 'EMPTY') c.expiry ??= parsed.expiry;
        c.issued ??= parsed.issued;
      } else if (t.part === 'number') {
        const s = ExcelService.cellText(value);
        if (s && !ABSENT_TOKENS.has(stripAccents(s).toUpperCase())) {
          c.present = true;
          c.columns.push(col.letter);
          c.number = s.slice(0, 120);
        }
      } else {
        const p = parseDateCell(value, 'expiry');
        if (p.kind === 'EMPTY') continue;
        if (p.kind === 'INVALID') {
          warnings.push({ column: col.letter, field: `certificate:${t.code}`, message: `${t.code} : date « ${p.raw} » non reconnue` });
          continue;
        }
        c.present = true;
        c.columns.push(col.letter);
        if (t.part === 'expiry') c.expiry = p;
        else if (p.kind === 'DATE') c.issued = p.value;
      }
      continue;
    }

    if (t.kind === 'extra') {
      if (t.target === 'fullName') {
        const s = ExcelService.cellText(value);
        if (s) fullName = { value: s, column: col.letter };
      } else if (t.target === 'vessel') {
        assignment.vesselText = ExcelService.cellText(value);
      } else {
        const p = parseDateCell(value, 'event');
        if (p.kind === 'DATE') assignment[t.target] = p.value;
        else if (p.kind === 'INVALID' || p.kind === 'UNLIMITED') {
          warnings.push({ column: col.letter, field: t.target, message: `Date « ${p.kind === 'INVALID' ? p.raw : 'PERMANENT'} » non reconnue : ignorée` });
        }
      }
      continue;
    }

    const field = t.field;
    switch (field) {
      case 'birthDate': {
        const p = parseDateCell(value, 'birth');
        if (p.kind === 'DATE') member.birthDate = p.value;
        else if (p.kind === 'INVALID') {
          errors.push({ column: col.letter, field, message: `Date de naissance invalide « ${p.raw} »${p.reason ? ` (${p.reason})` : ''}` });
        } else if (p.kind === 'UNLIMITED') errors.push({ column: col.letter, field, message: 'Date de naissance invalide (PERMANENT)' });
        break;
      }
      case 'passportExpiry':
      case 'seamanBookExpiry': {
        const p = parseDateCell(value, 'expiry');
        if (p.kind === 'DATE') member[field] = p.value;
        else if (p.kind !== 'EMPTY') {
          warnings.push({ column: col.letter, field, message: `Date d'expiration « ${p.kind === 'INVALID' ? p.raw : 'PERMANENT'} » non reconnue : ignorée` });
        }
        break;
      }
      case 'nationality':
      case 'passportCountry': {
        const s = ExcelService.cellText(value);
        if (!s) break;
        const iso = resolveCountry(s);
        if (iso) member[field] = iso;
        else warnings.push({ column: col.letter, field, message: `Pays « ${s} » non reconnu (code ISO à 2 lettres attendu) : ignoré` });
        break;
      }
      case 'gender': {
        const s = ExcelService.cellText(value);
        if (!s) break;
        const g = resolveGender(s);
        if (g) member.gender = g;
        else warnings.push({ column: col.letter, field, message: `Sexe « ${s} » non reconnu : ignoré` });
        break;
      }
      case 'crewDepartment': {
        const s = ExcelService.cellText(value);
        if (!s) break;
        const d = resolveCrewDepartment(s);
        if (d) {
          member.crewDepartment = d;
          deptFromColumn = true;
        } else warnings.push({ column: col.letter, field, message: `Service « ${s} » non reconnu (DECK/ENGINE/CATERING)` });
        break;
      }
      case 'email': {
        const s = ExcelService.cellText(value)?.toLowerCase();
        if (!s) break;
        if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length <= 320) member.email = s;
        else warnings.push({ column: col.letter, field, message: `E-mail « ${s} » invalide : ignoré` });
        break;
      }
      case 'amcRef':
      case 'passportNumber':
      case 'seamanBookNumber': {
        const s = ExcelService.cellText(typeof value === 'number' ? Math.trunc(value) : value);
        const v = normalizeRef(s);
        if (v) member[field] = v;
        break;
      }
      case 'rank': {
        const s = ExcelService.cellText(value);
        if (s) {
          member.rank = cleanText(s);
          rankFromColumn = true;
        }
        break;
      }
      default: {
        const s = ExcelService.cellText(typeof value === 'number' && field !== 'notes' ? String(value) : value);
        if (s) member[field] = cleanText(s);
      }
    }
  }

  // Nom complet -> nom / prénom (si colonnes séparées absentes)
  if (fullName && (!member.lastName || !member.firstName)) {
    const fn = fullName as { value: string; column: string };
    const split = splitFullName(fn.value);
    if (split) {
      member.lastName ??= split.lastName;
      member.firstName ??= split.firstName;
      if (!split.confident) {
        warnings.push({ column: fn.column, field: 'fullName', message: `Nom complet « ${fn.value} » découpé automatiquement (nom : ${split.lastName} / prénom : ${split.firstName}) : à vérifier` });
      }
    } else if (!member.lastName) {
      member.lastName = cleanText(fn.value);
    }
  }

  // Fonction : référentiel des rangs (le libellé officiel remplace l'abréviation)
  if (!member.rank && ref.defaults?.rank) member.rank = ref.defaults.rank;
  if (member.rank) {
    const r = resolveRank(member.rank, ref.ranks);
    if (r) {
      member.rank = r.name;
      if (!deptFromColumn) member.crewDepartment = r.crewDepartment;
    } else if (rankFromColumn) {
      warnings.push({ field: 'rank', message: `Fonction « ${member.rank} » absente du référentiel des rangs : conservée telle quelle` });
    }
  }
  if (!member.crewDepartment && ref.defaults?.crewDepartment) member.crewDepartment = ref.defaults.crewDepartment;

  errors.push(...validateNormalizedMember(member));

  const certificates: ImportedCertificate[] = [];
  for (const [code, c] of certs) {
    if (!c.present) continue;
    if (!ref.certificateCodes.has(code)) {
      warnings.push({ field: `certificate:${code}`, message: `Type de certificat ${code} inconnu ou inactif : ignoré` });
      continue;
    }
    const expiry = c.expiry;
    const cert: ImportedCertificate = {
      code,
      number: c.number,
      expiryKind: expiry?.kind === 'DATE' ? 'DATED' : expiry?.kind === 'UNLIMITED' ? 'UNLIMITED' : 'UNKNOWN',
      expiryOn: expiry?.kind === 'DATE' ? expiry.value : null,
      issuedOn: c.issued,
      columns: c.columns,
    };
    if (cert.expiryKind === 'UNKNOWN') {
      warnings.push({ field: `certificate:${code}`, message: `${code} : date d'expiration inconnue (EXPIRY_UNKNOWN)` });
    }
    certificates.push(cert);
  }

  const hasAssignment = assignment.joinDate || assignment.signOffDate || assignment.vesselText;
  if (assignment.joinDate && assignment.signOffDate && assignment.signOffDate < assignment.joinDate) {
    warnings.push({ field: 'signOffDate', message: 'Date de débarquement antérieure à l’embarquement : dates ignorées' });
    assignment.joinDate = null;
    assignment.signOffDate = null;
  }
  return { normalized: { member, certificates, assignment: hasAssignment ? assignment : null }, errors, warnings };
}

/** Contrôles bloquants d'une fiche normalisée (rejoués après correction opérateur). */
export function validateNormalizedMember(member: NormalizedMember): RowIssue[] {
  const errors: RowIssue[] = [];
  if (!member.lastName) errors.push({ field: 'lastName', message: 'Nom manquant' });
  if (!member.firstName) errors.push({ field: 'firstName', message: 'Prénom manquant' });
  for (const [field, max] of Object.entries(MAX_LENGTHS) as [MemberImportField, number][]) {
    const v = member[field];
    if (typeof v === 'string' && v.length > max) errors.push({ field, message: `${field} : ${max} caractères maximum` });
  }
  for (const f of ['birthDate', 'passportExpiry', 'seamanBookExpiry'] as const) {
    const v = member[f];
    if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) errors.push({ field: f, message: `${f} : date AAAA-MM-JJ attendue` });
  }
  if (member.birthDate && member.birthDate > new Date().toISOString().slice(0, 10)) {
    errors.push({ field: 'birthDate', message: 'Date de naissance dans le futur' });
  }
  for (const f of ['nationality', 'passportCountry'] as const) {
    const v = member[f];
    if (v && !/^[A-Z]{2}$/.test(v)) errors.push({ field: f, message: `${f} : code pays ISO à 2 lettres attendu` });
  }
  return errors;
}

/**
 * Applique les corrections opérateur (décision CORRECT) : null / "" retire la valeur,
 * identifiants normalisés, fonction rapprochée du référentiel. Retourne la fiche corrigée
 * et le journal { champ: { from, to } } (traçabilité ligne / opérateur).
 */
export function applyCorrections(
  member: NormalizedMember,
  corrections: Partial<Record<MemberImportField, string | null>>,
  ranks: RankRef[] = [],
): { member: NormalizedMember; changes: Record<string, { from: unknown; to: unknown }> } {
  const next: NormalizedMember = { ...member };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const [field, raw] of Object.entries(corrections) as [MemberImportField, string | null | undefined][]) {
    if (raw === undefined || !(MEMBER_IMPORT_FIELDS as readonly string[]).includes(field)) continue;
    const before = next[field];
    let value: string | null = raw === null ? null : cleanText(String(raw));
    if (value === '') value = null;
    if (value !== null) {
      if (field === 'amcRef' || field === 'passportNumber' || field === 'seamanBookNumber') value = normalizeRef(value);
      else if (field === 'nationality' || field === 'passportCountry') value = resolveCountry(value) ?? value.toUpperCase();
      else if (field === 'email') value = value.toLowerCase();
      else if (field === 'crewDepartment') value = resolveCrewDepartment(value) ?? value.toUpperCase();
      else if (field === 'rank') {
        const r = resolveRank(value, ranks);
        if (r) {
          value = r.name;
          if (!corrections.crewDepartment) next.crewDepartment = r.crewDepartment;
        }
      }
    }
    if (value === null) delete next[field];
    else (next as Record<string, string>)[field] = value;
    if ((before ?? null) !== (value ?? null)) changes[field] = { from: before ?? null, to: value };
  }
  return { member: next, changes };
}

export function identityOf(m: NormalizedMember): MemberIdentity {
  return {
    amcRef: m.amcRef ?? null,
    firstName: m.firstName ?? null,
    lastName: m.lastName ?? null,
    birthDate: m.birthDate ?? null,
    passportNumber: m.passportNumber ?? null,
    passportCountry: m.passportCountry ?? m.nationality ?? null,
    seamanBookNumber: m.seamanBookNumber ?? null,
  };
}

// =============================================================================
// Doublons internes au fichier & statut de ligne
// =============================================================================

export type StoredCandidate =
  | { kind: 'MEMBER'; memberId: string; score: number; reasons: DuplicateReason[]; archived?: boolean }
  | { kind: 'ROW'; rowId: string; sheetName: string; rowNumber: number; score: number; reasons: DuplicateReason[] };

export interface FileRowIdentity {
  id: string;
  sheetName: string;
  rowNumber: number;
  identity: MemberIdentity;
}

/** Paires de lignes du fichier qui désignent probablement la même personne (même seuil que la base). */
export function findInFileDuplicates(rows: FileRowIdentity[], threshold = DUPLICATE_THRESHOLD): Map<string, StoredCandidate[]> {
  const buckets = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = identityKeys(r.identity);
    const keys = [k.ref && `R:${k.ref}`, k.passport && `P:${k.passport}`, k.book && `S:${k.book}`, ...k.namePairs.map((p) => `N:${p}`), k.birthDate && `D:${k.birthDate}`];
    for (const key of keys) {
      if (!key) continue;
      const b = buckets.get(key);
      if (b) b.push(i);
      else buckets.set(key, [i]);
    }
  });
  const seen = new Set<string>();
  const out = new Map<string, StoredCandidate[]>();
  for (const idx of buckets.values()) {
    if (idx.length < 2) continue;
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const a = rows[idx[x]];
        const b = rows[idx[y]];
        const pair = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        const m = scoreDuplicate(a.identity, b.identity);
        if (m.score < threshold) continue;
        const push = (from: FileRowIdentity, to: FileRowIdentity) => {
          const list = out.get(from.id) ?? [];
          list.push({ kind: 'ROW', rowId: to.id, sheetName: to.sheetName, rowNumber: to.rowNumber, score: m.score, reasons: m.reasons });
          out.set(from.id, list);
        };
        push(a, b);
        push(b, a);
      }
    }
  }
  for (const list of out.values()) list.sort((p, q) => q.score - p.score);
  return out;
}

export type ImportRowStatusValue = 'VALID' | 'INVALID' | 'DUPLICATE_SUSPECTED';

export function computeRowStatus(errors: RowIssue[], candidates: StoredCandidate[]): ImportRowStatusValue {
  if (errors.length) return 'INVALID';
  if (candidates.length) return 'DUPLICATE_SUSPECTED';
  return 'VALID';
}

// =============================================================================
// Diff valeurs courantes / import (prévisualisation, décision UPDATE)
// =============================================================================

export interface FieldDiff {
  field: MemberImportField;
  current: unknown;
  imported: unknown;
  changed: boolean;
  protected: boolean;
}

function displayValue(v: unknown): unknown {
  if (v instanceof Date) return ymd(v);
  return v ?? null;
}

/** Compare uniquement les champs mappés et renseignés dans l'import (jamais d'effacement). */
export function computeImportDiff(current: Record<string, unknown>, imported: NormalizedMember): FieldDiff[] {
  const protectedSet = new Set<string>(PROTECTED_MEMBER_FIELDS);
  return (Object.keys(imported) as MemberImportField[])
    .filter((f) => imported[f] !== undefined && imported[f] !== null && imported[f] !== '')
    .map((field) => {
      const cur = displayValue(current[field]);
      const imp = imported[field];
      // Identifiants comparés sur leur clé (« AB 123 » = « AB123 ») ; autres champs à l'identique
      const changed = ['amcRef', 'passportNumber', 'seamanBookNumber'].includes(field) ? idKey(cur) !== idKey(imp) : !sameValue(cur, imp);
      return { field, current: cur, imported: imp, changed, protected: protectedSet.has(field) };
    });
}
