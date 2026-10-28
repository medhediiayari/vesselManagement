/**
 * Reprise initiale de la matrice d'équipage AMC (classeur « BD-Classeur1 -AMC »), usage ponctuel.
 *
 *   npm run import:crew-matrix -w @amc/api -- "<classeur.xlsx>" [--apply] [--vessel ISK] [--report <rapport.json>]
 *
 * Sans --apply : simulation (aucune écriture) + rapport des anomalies.
 * Décisions validées avec AMC (15/10/2026) :
 *  - une fiche par marin : lignes regroupées par seaman book (sinon par nom), chaque ligne = un contrat ;
 *  - certificats enregistrés en « reprise initiale » validée (révision courante, tracée dans l'audit),
 *    justificatif PDF facultatif : « Document requis » désactivé pour les types Members ;
 *  - personne n'est mis « à bord » : chaque contrat devient une affectation terminée (historique) ;
 *  - feuille « OFFICIE MATLOT » = officiers MACHINE (faute de frappe dans le classeur) ;
 *  - « Sso/Sdsd/Sat » : SSO pour Master / Chief Mate, SDSD pour les autres ; « Srb » = PSCRB ;
 *    « Medical care » = type distinct de « Medical first aid ».
 * Idempotent : fiches rapprochées par seaman book puis nom ; certificat existant du même type conservé ;
 * affectation existante (même navire, même date d'embarquement) ignorée ; champs déjà renseignés jamais écrasés.
 */
import 'reflect-metadata';
import { Prisma, PrismaClient, type CrewDepartment, type ExpiryKind, type MemberStatus } from '@prisma/client';
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as XLSX from 'xlsx';
import { ExcelService } from '../src/modules/documents/excel.service';
import { splitFullName } from '../src/modules/members/member-import.logic';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--') && /\.xlsx?$/i.test(a));
const APPLY = args.includes('--apply');
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] ?? null : null);
const vesselCode = option('--vessel') ?? 'ISK';
const reportPath = option('--report');
if (!file) {
  console.error('Usage : import-crew-matrix.ts <classeur.xlsx> [--apply] [--vessel ISK] [--report rapport.json]');
  process.exit(2);
}
const SOURCE = basename(file);

// ---------------------------------------------------------------------------- Référentiels
const NEW_RANKS: [string, string, CrewDepartment][] = [
  ['DECK_CADET', 'Deck Cadet / Élève officier pont', 'DECK'],
  ['ENG_CADET', 'Engine Cadet / Élève officier machine', 'ENGINE'],
  ['DECK_RATING', 'Deck Rating / Personnel pont', 'DECK'],
  ['ENGINE_RATING', 'Engine Rating / Personnel machine', 'ENGINE'],
  ['CH_COOK', 'Chief Cook / Chef cuisinier', 'CATERING'],
];

/** Fonctions du classeur (normalisées : majuscules, sans espaces ni ponctuation) -> code du référentiel. */
const DUTY_TO_RANK: Record<string, string> = {
  MASTER: 'MASTER',
  CHMATE: 'C_OFF',
  SDMATE: '2_OFF',
  DECKCADET: 'DECK_CADET',
  CHENG: 'C_ENG',
  CHENGINEER: 'C_ENG',
  SDENG: '2_ENG',
  THIRDENG: '3_ENG',
  THIRDENGINEER: '3_ENG',
  '3RDENG': '3_ENG',
  TRAINEERENGOFIICIE: 'ENG_CADET',
  BOSUN: 'BOSUN',
  AB: 'AB',
  OS: 'OS',
  OSDECK: 'OS',
  DECKRATING: 'DECK_RATING',
  DR: 'DECK_RATING',
  DRA: 'DECK_RATING',
  DRF: 'DECK_RATING',
  OILER: 'OILER',
  ENGRATING: 'ENGINE_RATING',
  ENGINERATING: 'ENGINE_RATING',
  ERATING: 'ENGINE_RATING',
  ER: 'ENGINE_RATING',
  ERA: 'ENGINE_RATING',
  ERF: 'ENGINE_RATING',
  ABENGINE: 'ENGINE_RATING',
  ELECTRICIAN: 'ELEC',
  COOK: 'COOK',
  CHCOOK: 'CH_COOK',
};

type CertKey = 'SECURITY' | 'GMDSS' | 'ARPA' | 'MEDCARE' | 'MFA' | 'AFF' | 'PSCRB' | 'BST' | 'ENDORS' | 'COC' | 'MEDICAL';
type ColKey = 'name' | 'duty' | 'sb' | 'emb' | 'debar' | 'remark' | 'contact' | 'email' | 'birth' | 'passport' | 'salary' | `cert:${CertKey}`;

/** En-têtes du classeur -> colonnes (repérées par libellé : les feuilles ne commencent pas à la même colonne). */
const HEADERS: Record<string, ColKey> = {
  'NAME & SURNAME': 'name',
  DUTY: 'duty',
  'SSO/SDSD/SAT': 'cert:SECURITY',
  'GMDSS ENDORSEMENT': 'cert:GMDSS',
  ARPA: 'cert:ARPA',
  'MEDICAL CARE': 'cert:MEDCARE',
  'MEDICAL FISRST AID': 'cert:MFA',
  'MEDICAL FIRST AID': 'cert:MFA',
  'ADVANCED FIRE FIGHTING': 'cert:AFF',
  SRB: 'cert:PSCRB',
  BST: 'cert:BST',
  ENDORSEMENT: 'cert:ENDORS',
  'CERTIFICAT DE COMPETENCY': 'cert:COC',
  'MEDICAL EXAM': 'cert:MEDICAL',
  "SEAMAN'S BOOK": 'sb',
  'DATE EMB': 'emb',
  'DATE DEBAR': 'debar',
  'SALAIRE BRUT': 'salary',
  'SALAIRE DECLARE': 'salary',
  CONJE: 'salary',
  REMARQUE: 'remark',
  CONTACT: 'contact',
  EMAIL: 'email',
  'DATE AND PLACE OF BIRTH': 'birth',
  PASSPORT: 'passport',
};

const SHEETS: { match: RegExp; label: string }[] = [
  { match: /OFFICIE\s*PONT/i, label: 'Officiers pont' },
  { match: /OFFICIE\s*MATLOT/i, label: 'Officiers machine' },
  { match: /BOSUN/i, label: 'Personnel pont' },
  { match: /GRAISSEUR|COOK/i, label: 'Machine & cuisine' },
];

// ---------------------------------------------------------------------------- Normalisation
const report = {
  source: SOURCE,
  mode: APPLY ? 'APPLY' : 'DRY_RUN',
  rows: 0,
  persons: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  certificatesCreated: 0,
  certificatesSkippedExisting: 0,
  assignmentsCreated: 0,
  assignmentsSkippedExisting: 0,
  warnings: [] as { where: string; message: string }[],
};
const warn = (where: string, message: string) => report.warnings.push({ where, message });

/** Le classeur contient des caractères perdus (U+FFFD) : restauration des mots connus. */
function repairText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/ENGAG�E/gi, 'ENGAGÉE')
    .replace(/EXPIR�E/gi, 'EXPIRÉE')
    .replace(/\s�\s/g, ' à ')
    .replace(/�/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
const text = (v: unknown): string => (v === null || v === undefined ? '' : repairText(String(v)));
const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
/** Clé de seaman book / passeport : zéros de tête ignorés (« BI 00624 » = « BI 0624 », « GA 100 » = « GA 0100 »). */
const docKey = (s: string | null) => (s ? compact(s).replace(/(^|[A-Z])0+(?=\d)/g, '$1') : null);
const isPlaceholder = (s: string) => /^[.\-–—_\s]*$/.test(s) || /^N\/?A$/i.test(s);
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, sep: string, ch: string) => sep + ch.toUpperCase());

/** Date + texte libre dans une même cellule (« 14.04.2026 RADES », « TUZLA 25/02/2023 », « 31.05..2019 »). */
function dateAndPlace(v: unknown): { date: string | null; place: string | null; raw: string } {
  if (v instanceof Date || typeof v === 'number') {
    const p = ExcelService.parseDate(v);
    return { date: p.kind === 'DATE' ? p.value : null, place: null, raw: String(v) };
  }
  const raw = text(v);
  if (!raw || isPlaceholder(raw)) return { date: null, place: null, raw };
  const m = raw.match(/(\d{1,2})\s*[./-]+\s*(\d{1,2})\s*[./-]+\s*(\d{2,4})/);
  if (!m) return { date: null, place: raw, raw };
  const p = ExcelService.parseDate(`${m[1]}.${m[2]}.${m[3]}`);
  const place = raw.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
  return { date: p.kind === 'DATE' ? p.value : null, place: place || null, raw };
}

type CertValue = { kind: 'DATED'; expiryOn: string } | { kind: 'UNLIMITED' } | { kind: 'NOTE'; note: string };
function certValue(v: unknown): CertValue | null {
  if (v instanceof Date || typeof v === 'number') {
    const p = ExcelService.parseDate(v);
    return p.kind === 'DATE' ? { kind: 'DATED', expiryOn: p.value } : null;
  }
  const s = text(v);
  if (!s || isPlaceholder(s)) return null;
  const up = s.toUpperCase();
  if (/^PERMANEN/.test(up) || /ILLIMIT|UNLIMITED/.test(up)) return { kind: 'UNLIMITED' };
  if (/EXEMPTION/.test(up)) return { kind: 'NOTE', note: s };
  const d = dateAndPlace(s);
  if (d.date && !d.place) return { kind: 'DATED', expiryOn: d.date };
  return { kind: 'NOTE', note: s };
}

function normalizePhone(v: unknown): string | null {
  const s = text(v).replace(/\s+/g, '').replace(/\//g, ' / ');
  return s && !isPlaceholder(s) ? s.slice(0, 64) : null;
}
function normalizeEmail(v: unknown): { email: string | null; note: string | null } {
  const s = text(v).toLowerCase().replace(/\s+/g, '');
  if (!s) return { email: null, note: null };
  const fixed = s.replace(/,/g, '.');
  return /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(fixed) ? { email: fixed, note: null } : { email: null, note: `E-mail illisible dans le classeur : ${s}` };
}

// ---------------------------------------------------------------------------- Lecture du classeur
interface Row {
  sheet: string;
  sheetLabel: string;
  excelRow: number;
  name: string;
  duty: string;
  rankCode: string | null;
  sbNumber: string | null;
  sbExpiry: string | null;
  emb: ReturnType<typeof dateAndPlace>;
  debar: ReturnType<typeof dateAndPlace>;
  remark: string;
  phone: string | null;
  email: ReturnType<typeof normalizeEmail>;
  birth: ReturnType<typeof dateAndPlace>;
  ppNumber: string | null;
  ppExpiry: string | null;
  certs: Partial<Record<CertKey, CertValue>>;
}

function readWorkbook(path: string): Row[] {
  const wb = XLSX.readFile(path, { cellDates: true });
  const rows: Row[] = [];
  for (const sheetName of wb.SheetNames) {
    const conf = SHEETS.find((s) => s.match.test(sheetName));
    if (!conf) {
      warn(sheetName, 'Feuille non reconnue : ignorée');
      continue;
    }
    const ws = wb.Sheets[sheetName];
    const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
    const cell = (r: number, c: number) => ws[XLSX.utils.encode_cell({ r, c })]?.v;
    // Ligne d'en-tête : celle qui contient « Name & Surname »
    let headerRow = -1;
    for (let r = range.s.r; r <= Math.min(range.e.r, range.s.r + 20) && headerRow < 0; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) if (text(cell(r, c)).toUpperCase() === 'NAME & SURNAME') headerRow = r;
    }
    if (headerRow < 0) {
      warn(sheetName, 'En-tête « Name & Surname » introuvable : feuille ignorée');
      continue;
    }
    const cols = new Map<ColKey, number>();
    for (let c = range.s.c; c <= range.e.c; c++) {
      const h = text(cell(headerRow, c)).toUpperCase().replace(/\s+/g, ' ');
      const key = HEADERS[h];
      if (key && !cols.has(key)) cols.set(key, c);
    }
    const col = (k: ColKey) => cols.get(k);
    const at = (r: number, k: ColKey, offset = 0) => (col(k) === undefined ? undefined : cell(r, col(k)! + offset));
    // Colonnes connues : en-têtes reconnus + « Expiry date » placée sous le seaman book et le passeport
    const known = new Set<number>([...cols.values(), ...(['sb', 'passport'] as ColKey[]).flatMap((k) => (col(k) === undefined ? [] : [col(k)! + 1]))]);
    let unlabeled = 0;

    for (let r = headerRow + 2; r <= range.e.r; r++) {
      const name = text(at(r, 'name')).toUpperCase();
      if (!name || isPlaceholder(name)) continue;
      const excelRow = r + 1;
      const where = `${sheetName.trim()} L${excelRow}`;
      const duty = text(at(r, 'duty')).toUpperCase();
      const rankCode = DUTY_TO_RANK[compact(duty)] ?? null;
      if (!rankCode) warn(where, `Fonction « ${duty || '(vide)'} » hors référentiel : conservée telle quelle`);
      for (let c = range.s.c; c <= range.e.c; c++) if (!known.has(c) && text(cell(r, c))) unlabeled++;
      if (text(at(r, 'salary'))) warn(where, 'Données salariales présentes : non importées (aucun champ prévu)');
      const sb = text(at(r, 'sb'));
      const pp = text(at(r, 'passport'));
      const certs: Row['certs'] = {};
      for (const [k] of cols) {
        if (!k.startsWith('cert:')) continue;
        const v = certValue(at(r, k));
        if (v) certs[k.slice(5) as CertKey] = v;
      }
      const sbExpiry = dateAndPlace(at(r, 'sb', 1));
      const ppExpiry = dateAndPlace(at(r, 'passport', 1));
      rows.push({
        sheet: sheetName.trim(),
        sheetLabel: conf.label,
        excelRow,
        name: name.replace(/\s+/g, ' '),
        duty,
        rankCode,
        sbNumber: sb && !isPlaceholder(sb) ? sb.toUpperCase().slice(0, 32) : null,
        sbExpiry: sbExpiry.date,
        emb: dateAndPlace(at(r, 'emb')),
        debar: dateAndPlace(at(r, 'debar')),
        remark: text(at(r, 'remark')),
        phone: normalizePhone(at(r, 'contact')),
        email: normalizeEmail(at(r, 'email')),
        birth: dateAndPlace(at(r, 'birth')),
        ppNumber: pp && !isPlaceholder(pp) ? pp.toUpperCase().slice(0, 32) : null,
        ppExpiry: ppExpiry.date,
        certs,
      });
    }
    if (unlabeled) warn(sheetName.trim(), `${unlabeled} valeur(s) dans des colonnes sans en-tête : ignorées`);
  }
  return rows;
}

// ---------------------------------------------------------------------------- Regroupement par personne
function lev(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
const sortedTokens = (n: string) => n.split(' ').filter(Boolean).sort().join(' ');
/** Même personne : mêmes mots dans un autre ordre, ou orthographe proche (≤ 3 lettres d'écart). */
const samePerson = (a: string, b: string) => sortedTokens(a) === sortedTokens(b) || lev(sortedTokens(a), sortedTokens(b)) <= 3 || lev(a, b) <= 3;

function groupPersons(rows: Row[]): Row[][] {
  const groups: Row[][] = [];
  for (const row of rows) {
    const key = docKey(row.sbNumber);
    const pp = docKey(row.ppNumber);
    const where = `${row.sheet} L${row.excelRow}`;
    // 1) même seaman book ou même passeport, et même personne (orthographe proche, mots inversés)
    let g = groups.find((grp) => grp.some((x) => ((key && docKey(x.sbNumber) === key) || (pp && docKey(x.ppNumber) === pp)) && samePerson(x.name, row.name)));
    // 2) même nom (mêmes mots), seaman book absent d'un côté ou identique
    g ??= groups.find((grp) => grp.some((x) => sortedTokens(x.name) === sortedTokens(row.name) && (!key || !x.sbNumber || docKey(x.sbNumber) === key)));
    if (!g) {
      const sbClash = key ? groups.find((grp) => grp.some((x) => docKey(x.sbNumber) === key)) : undefined;
      if (sbClash) warn(where, `Seaman book ${row.sbNumber} déjà porté par ${sbClash[0].name} : deux fiches distinctes, à vérifier`);
      const nameClash = groups.find((grp) => grp.some((x) => sortedTokens(x.name) === sortedTokens(row.name)));
      if (nameClash) warn(where, `Homonyme de ${nameClash[0].name} avec un autre seaman book : deux fiches distinctes, à vérifier`);
      groups.push([row]);
    } else g.push(row);
  }
  for (const g of groups) {
    const names = [...new Set(g.map((x) => x.name))];
    if (names.length > 1) warn(`${g[0].sheet} L${g[0].excelRow}`, `Orthographes regroupées (même seaman book) : ${names.join(' / ')}`);
  }
  return groups;
}

/** Valeur de la ligne la plus récente (date d'embarquement) qui la renseigne. */
const latestFirst = (g: Row[]) => [...g].sort((a, b) => (b.emb.date ?? '0000').localeCompare(a.emb.date ?? '0000') || b.excelRow - a.excelRow);
function pick<T>(g: Row[], f: (r: Row) => T | null | undefined): T | null {
  for (const r of latestFirst(g)) {
    const v = f(r);
    if (v !== null && v !== undefined && v !== '') return v;
  }
  return null;
}

function statusFromRemark(remark: string): MemberStatus {
  const r = remark.toUpperCase();
  if (/INAPTE/.test(r)) return 'INACTIVE';
  if (/CONJ|CONG/.test(r)) return 'ON_LEAVE';
  return 'AVAILABLE';
}

// ---------------------------------------------------------------------------- Programme
async function main() {
  const rows = readWorkbook(file!);
  report.rows = rows.length;
  const groups = groupPersons(rows);
  report.persons = groups.length;

  const admin = await prisma.user.findFirstOrThrow({ where: { username: (process.env.SEED_ADMIN_USERNAME ?? 'admin').toLowerCase() } });
  const actorLabel = `${admin.displayName} (${admin.username}) — reprise ${SOURCE}`;
  const company = await prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
  const vessel = await prisma.vessel.findFirstOrThrow({ where: { code: vesselCode } });

  // --- Référentiels (rangs, types de certificats) ---
  if (APPLY) {
    const maxSort = (await prisma.rank.aggregate({ _max: { sortOrder: true } }))._max.sortOrder ?? 0;
    for (const [i, [code, name, crewDepartment]] of NEW_RANKS.entries()) {
      await prisma.rank.upsert({ where: { code }, create: { code, name, crewDepartment, sortOrder: maxSort + 1 + i }, update: {} });
    }
    const mfa = await prisma.certificateType.findUniqueOrThrow({ where: { code: 'MFA' }, include: { validators: true } });
    if (mfa.name !== 'Medical First Aid') await prisma.certificateType.update({ where: { id: mfa.id }, data: { name: 'Medical First Aid' } });
    const medcare = await prisma.certificateType.upsert({
      where: { code: 'MEDCARE' },
      create: {
        code: 'MEDCARE',
        name: 'Medical Care',
        subjectKind: 'MEMBER',
        category: mfa.category,
        defaultValidityMonths: mfa.defaultValidityMonths,
        reminderPolicyId: mfa.reminderPolicyId,
        sortOrder: mfa.sortOrder,
        requiresDocument: false,
        validators: { create: mfa.validators.map((v) => ({ principalType: v.principalType, principalId: v.principalId })) },
      },
      update: {},
    });
    // Justificatif facultatif pour les certificats des marins (décision AMC)
    const relaxed = await prisma.certificateType.updateMany({ where: { subjectKind: 'MEMBER', requiresDocument: true }, data: { requiresDocument: false } });
    await prisma.auditEvent.create({
      data: {
        actorId: admin.id,
        actorLabel,
        action: 'certificate_type.initial_load_settings',
        module: 'certificates',
        entityType: 'certificate_type',
        entityId: medcare.id,
        metadata: { source: SOURCE, createdTypes: ['MEDCARE'], renamed: { MFA: 'Medical First Aid' }, requiresDocumentDisabled: relaxed.count, ranksAdded: NEW_RANKS.map((r) => r[0]) },
      },
    });
  }
  const ranks = new Map((await prisma.rank.findMany()).map((r) => [r.code, r]));
  for (const [code, name, crewDepartment] of NEW_RANKS) if (!ranks.has(code)) ranks.set(code, { code, name, crewDepartment } as never);
  const types = new Map((await prisma.certificateType.findMany({ where: { subjectKind: 'MEMBER' } })).map((t) => [t.code, t]));

  const preview: Record<string, unknown>[] = [];
  const existing = await prisma.member.findMany({ select: { id: true, firstName: true, lastName: true, seamanBookNumber: true } });

  for (const g of groups) {
    const latest = latestFirst(g)[0];
    const where = `${latest.sheet} L${latest.excelRow}`;
    const split = splitFullName(latest.name);
    if (!split) {
      warn(where, `Nom « ${latest.name} » non découpable : ligne ignorée`);
      continue;
    }
    if (latest.name.split(' ').length > 3) warn(where, `Nom long « ${latest.name} » : découpage nom/prénom à vérifier (${split.lastName} / ${split.firstName})`);
    const rankCode = pick(g, (r) => r.rankCode);
    const rank = rankCode ? ranks.get(rankCode) : undefined;
    const sb = pick(g, (r) => r.sbNumber);
    const birth = pick(g, (r) => (r.birth.date || r.birth.place ? r.birth : null));
    const email = pick(g, (r) => r.email.email);
    const remark = latest.remark;

    const notes: string[] = [];
    for (const r of latestFirst(g)) {
      if (r.remark) notes.push(`Remarque (${r.sheet} L${r.excelRow}) : ${r.remark}`);
      if (r.email.note) notes.push(r.email.note);
      for (const [k, v] of Object.entries(r.certs)) if (v?.kind === 'NOTE') notes.push(`${k === 'SECURITY' ? 'Sûreté' : k} : ${v.note}`);
      if (!r.rankCode && r.duty) notes.push(`Fonction d'origine : ${r.duty}`);
    }
    const memberData = {
      lastName: split.lastName.slice(0, 120),
      firstName: titleCase(split.firstName).slice(0, 120),
      birthDate: birth?.date ? new Date(`${birth.date}T00:00:00Z`) : null,
      birthPlace: birth?.place ? titleCase(birth.place.replace(/^(AT|À|A)\s+/i, '')).slice(0, 120) : null,
      phone: pick(g, (r) => r.phone),
      email,
      passportNumber: pick(g, (r) => r.ppNumber),
      passportExpiry: (() => {
        const v = pick(g, (r) => (r.ppNumber ? r.ppExpiry : null));
        return v ? new Date(`${v}T00:00:00Z`) : null;
      })(),
      seamanBookNumber: sb,
      seamanBookExpiry: (() => {
        const v = pick(g, (r) => (r.sbNumber ? r.sbExpiry : null));
        return v ? new Date(`${v}T00:00:00Z`) : null;
      })(),
      rank: rank?.name ?? (latest.duty || null),
      crewDepartment: (rank?.crewDepartment ?? null) as CrewDepartment | null,
      status: statusFromRemark(remark),
      notes: [`Reprise ${SOURCE} (${[...new Set(g.map((r) => r.sheetLabel))].join(', ')})`, ...[...new Set(notes)]].join('\n').slice(0, 5000),
    };

    // Rapprochement avec une fiche existante : seaman book, sinon nom exact
    const match = existing.find(
      (m) =>
        (sb && m.seamanBookNumber && docKey(m.seamanBookNumber) === docKey(sb) && samePerson(`${m.lastName} ${m.firstName}`.toUpperCase(), latest.name)) ||
        `${m.lastName} ${m.firstName}`.toUpperCase() === `${memberData.lastName} ${memberData.firstName}`.toUpperCase(),
    );

    // Certificats : valeur de la ligne la plus récente qui renseigne chaque type
    const certs: { code: string; value: Exclude<CertValue, { kind: 'NOTE' }> }[] = [];
    for (const key of ['SECURITY', 'GMDSS', 'ARPA', 'MEDCARE', 'MFA', 'AFF', 'PSCRB', 'BST', 'ENDORS', 'COC', 'MEDICAL'] as CertKey[]) {
      const v = pick(g, (r) => (r.certs[key] && r.certs[key]!.kind !== 'NOTE' ? (r.certs[key] as Exclude<CertValue, { kind: 'NOTE' }>) : null));
      if (!v) continue;
      const code = key === 'SECURITY' ? (rankCode === 'MASTER' || rankCode === 'C_OFF' ? 'SSO' : 'SDSD') : key;
      // MEDCARE est créé par --apply : en simulation il n'existe pas encore
      if (!types.has(code) && code !== 'MEDCARE') {
        warn(where, `Type de certificat ${code} absent du référentiel : ignoré`);
        continue;
      }
      certs.push({ code, value: v });
    }
    // Contrats : une affectation terminée par ligne datée (embarquement et/ou débarquement)
    const contractKey = (r: Row) => `${r.emb.date ?? ''}|${r.emb.date ? '' : r.debar.date ?? ''}`;
    const contracts = [...g]
      .filter((r) => r.emb.date || r.debar.date)
      .sort((a, b) => (a.emb.date ?? a.debar.date!).localeCompare(b.emb.date ?? b.debar.date!))
      .filter((r, i, all) => all.findIndex((x) => contractKey(x) === contractKey(r)) === i);
    for (const r of g) {
      const w = `${r.sheet} L${r.excelRow}`;
      if (!r.emb.date && r.emb.raw) warn(w, `Date d'embarquement « ${r.emb.raw} » illisible`);
      if (!r.emb.date && r.debar.date) warn(w, `Débarquement du ${r.debar.date} sans date d'embarquement : contrat repris, embarquement non renseigné`);
      if (r.emb.date && r.debar.date && r.debar.date < r.emb.date) warn(w, `Débarquement (${r.debar.date}) antérieur à l'embarquement (${r.emb.date}) : débarquement ignoré`);
    }

    if (!APPLY) {
      if (preview.length < 8) {
        preview.push({
          rows: g.map((r) => `${r.sheet} L${r.excelRow}`),
          ...memberData,
          birthDate: memberData.birthDate?.toISOString().slice(0, 10) ?? null,
          certificates: certs.map((c) => `${c.code}:${c.value.kind === 'DATED' ? c.value.expiryOn : c.value.kind}`),
          contracts: contracts.map((r) => `${r.emb.date ?? '?'}${r.emb.place ? ` ${r.emb.place}` : ''} -> ${r.debar.date ?? '?'}${r.debar.place ? ` ${r.debar.place}` : ''}`),
        });
      }
      if (match) report.updated++;
      else report.created++;
      report.certificatesCreated += certs.length;
      report.assignmentsCreated += contracts.length;
      continue;
    }

    await prisma.$transaction(async (tx) => {
      let memberId: string;
      if (match) {
        // Jamais d'écrasement : seuls les champs vides de la fiche existante sont complétés
        const current = await tx.member.findUniqueOrThrow({ where: { id: match.id } });
        const patch: Prisma.MemberUpdateInput = {};
        for (const [k, v] of Object.entries(memberData)) {
          if (k === 'status' || k === 'notes' || v === null) continue;
          if ((current as Record<string, unknown>)[k] === null) (patch as Record<string, unknown>)[k] = v;
        }
        memberId = match.id;
        if (Object.keys(patch).length) {
          await tx.member.update({ where: { id: memberId }, data: patch });
          await tx.auditEvent.create({ data: { actorId: admin.id, actorLabel, action: 'member.initial_load_completed', module: 'members', entityType: 'member', entityId: memberId, after: JSON.parse(JSON.stringify(patch)), metadata: { source: SOURCE } } });
          report.updated++;
        } else report.unchanged++;
      } else {
        const created = await tx.member.create({ data: { ...memberData, companyId: company.id, createdById: admin.id } });
        memberId = created.id;
        existing.push({ id: memberId, firstName: created.firstName, lastName: created.lastName, seamanBookNumber: created.seamanBookNumber });
        await tx.auditEvent.create({
          data: { actorId: admin.id, actorLabel, action: 'member.initial_load_created', module: 'members', entityType: 'member', entityId: memberId, metadata: { source: SOURCE, rows: g.map((r) => `${r.sheet} L${r.excelRow}`) } },
        });
        report.created++;
      }

      for (const c of certs) {
        const type = types.get(c.code)!;
        const already = await tx.certificate.findFirst({ where: { memberId, typeId: type.id, archivedAt: null } });
        if (already) {
          report.certificatesSkippedExisting++;
          continue;
        }
        const expiryKind: ExpiryKind = c.value.kind;
        const expiryOn = c.value.kind === 'DATED' ? new Date(`${c.value.expiryOn}T00:00:00Z`) : null;
        const now = new Date();
        const cert = await tx.certificate.create({ data: { subjectKind: 'MEMBER', memberId, typeId: type.id, createdById: admin.id } });
        const data = { expiryKind, expiryOn, remarks: `Reprise ${SOURCE}` };
        const request = await tx.certificateApprovalRequest.create({
          data: {
            certificateId: cert.id,
            kind: 'CREATE',
            status: 'APPROVED',
            version: 1,
            requestedById: admin.id,
            submittedAt: now,
            decidedById: admin.id,
            decidedAt: now,
            decisionComment: `Reprise initiale — ${SOURCE}`,
            versions: { create: { versionNo: 1, ...data, createdById: admin.id, changeNote: 'Reprise initiale' } },
            decisions: { create: { versionNo: 1, deciderId: admin.id, decision: 'APPROVE', comment: 'Reprise initiale' } },
          },
        });
        const rev = await tx.certificateRevision.create({
          data: { certificateId: cert.id, revisionNo: 1, ...data, lifecycle: 'CURRENT', approvedRequestId: request.id, approvedById: admin.id, approvedAt: now },
        });
        await tx.certificate.update({
          where: { id: cert.id },
          data: { currentRevisionId: rev.id, currentExpiryKind: expiryKind, currentExpiryOn: expiryOn, documentMissing: true },
        });
        await tx.auditEvent.create({
          data: { actorId: admin.id, actorLabel, action: 'certificate.initial_load', module: 'certificates', entityType: 'certificate', entityId: cert.id, after: { type: c.code, expiryKind, expiryOn: c.value.kind === 'DATED' ? c.value.expiryOn : null }, metadata: { source: SOURCE, memberId } },
        });
        report.certificatesCreated++;
      }

      for (const r of contracts) {
        const join = r.emb.date ? new Date(`${r.emb.date}T00:00:00Z`) : null;
        const signOff = r.debar.date && (!r.emb.date || r.debar.date >= r.emb.date) ? new Date(`${r.debar.date}T00:00:00Z`) : null;
        const already = await tx.crewAssignment.findFirst({ where: { memberId, vesselId: vessel.id, ...(join ? { actualJoinDate: join } : { actualJoinDate: null, actualSignOffDate: signOff }) } });
        if (already) {
          report.assignmentsSkippedExisting++;
          continue;
        }
        const rowRank = r.rankCode ? ranks.get(r.rankCode)?.name : null;
        const a = await tx.crewAssignment.create({
          data: {
            memberId,
            vesselId: vessel.id,
            rank: (rowRank ?? (r.duty || memberData.rank || 'Non renseigné')).slice(0, 120),
            position: r.duty && rowRank && compact(r.duty) !== compact(rowRank) ? r.duty.slice(0, 120) : null,
            status: 'COMPLETED',
            actualJoinDate: join,
            actualSignOffDate: signOff,
            joinPort: r.emb.place ? titleCase(r.emb.place).slice(0, 120) : null,
            signOffPort: r.debar.place ? titleCase(r.debar.place).slice(0, 120) : null,
            notes: [`Reprise ${SOURCE} (${r.sheet} L${r.excelRow})`, !join && 'embarquement non renseigné dans le classeur', !signOff && 'débarquement non renseigné dans le classeur'].filter(Boolean).join(' — '),
            createdById: admin.id,
          },
        });
        await tx.auditEvent.create({
          data: { actorId: admin.id, actorLabel, action: 'crew_assignment.initial_load', module: 'members', entityType: 'crew_assignment', entityId: a.id, vesselId: vessel.id, metadata: { source: SOURCE, memberId } },
        });
        report.assignmentsCreated++;
      }
    }, { timeout: 60_000 });
  }

  if (APPLY) {
    await prisma.auditEvent.create({
      data: { actorId: admin.id, actorLabel, action: 'members.initial_load', module: 'members', entityType: 'import', metadata: { ...report, warnings: report.warnings.length } },
    });
  }
  if (reportPath) writeFileSync(reportPath, JSON.stringify({ ...report, preview }, null, 2), 'utf8');
  const { warnings, ...summary } = report;
  console.log(JSON.stringify(summary, null, 2));
  console.log(`${warnings.length} avertissement(s)${reportPath ? ` — détail : ${reportPath}` : ''}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
