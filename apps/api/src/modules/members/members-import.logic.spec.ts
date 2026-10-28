import {
  ImportColumn,
  RankRef,
  applyCorrections,
  buildHeaders,
  computeImportDiff,
  computeRowStatus,
  findInFileDuplicates,
  identityOf,
  isBlankRow,
  normalizeImportRow,
  parseCertificateCell,
  parseDateCell,
  parseMappingTarget,
  resolveColumnKey,
  resolveCountry,
  resolveRank,
  splitFullName,
  suggestMapping,
  suggestSheetDefaults,
  suggestTarget,
} from './member-import.logic';
import { rankCandidates, scoreDuplicate } from './members.logic';

const CODES = new Set(['SSO', 'SDSD', 'SAT', 'GMDSS', 'ARPA', 'MEDICAL', 'BST', 'AFF', 'SRB', 'ENDORS', 'COC', 'PSCRB', 'MFA']);
const RANKS: RankRef[] = [
  { code: 'MASTER', name: 'Master / Capitaine', crewDepartment: 'DECK' },
  { code: 'C_OFF', name: 'Chief Officer / Second capitaine', crewDepartment: 'DECK' },
  { code: 'BOSUN', name: 'Bosun / Maître d’équipage', crewDepartment: 'DECK' },
  { code: 'OILER', name: 'Oiler / Graisseur', crewDepartment: 'ENGINE' },
  { code: 'COOK', name: 'Cook / Cuisinier', crewDepartment: 'CATERING' },
];
/** 2027-03-15 en numéro de série Excel (base 1899-12-30). */
const SERIAL_2027_03_15 = 46461;

const col = (letter: string, target: string): ImportColumn => ({ letter, header: target, target: parseMappingTarget(target)! });

describe('Suggestion de mapping par en-têtes normalisés', () => {
  it.each([
    ['NOM', 'lastName'],
    ['Prénom', 'firstName'],
    ['NOM ET PRENOM', 'fullName'],
    ['Nom & Prénom', 'fullName'],
    ['DATE NAISSANCE', 'birthDate'],
    ['Date de naissance (JJ.MM.AAAA)', 'birthDate'],
    ['MATRICULE', 'amcRef'],
    ['AMC ID', 'amcRef'],
    ['PASSEPORT', 'passportNumber'],
    ['N° Passeport', 'passportNumber'],
    ['Expiration passeport', 'passportExpiry'],
    ['SEAMAN BOOK', 'seamanBookNumber'],
    ["Seaman's book", 'seamanBookNumber'],
    ['LIVRET', 'seamanBookNumber'],
    ['FONCTION', 'rank'],
    ['RANK', 'rank'],
    ['EMBARQUEMENT', 'joinDate'],
    ['Date de débarquement', 'signOffDate'],
    ['N°', 'ignore'],
  ])('%s -> %s', (header, expected) => {
    expect(suggestTarget(header, CODES)).toBe(expected);
  });

  it.each([
    ['SSO', 'certificate:SSO'],
    ['SDSD', 'certificate:SDSD'],
    ['SAT', 'certificate:SAT'],
    ['GMDSS', 'certificate:GMDSS'],
    ['GMDSS EXP', 'certificate:GMDSS:expiry'],
    ['N° GMDSS', 'certificate:GMDSS:number'],
    ['ARPA', 'certificate:ARPA'],
    ['MEDICAL', 'certificate:MEDICAL'],
    ['MEDICAL EXAM', 'certificate:MEDICAL'],
    ['Visite médicale', 'certificate:MEDICAL'],
    ['MEDICAL FIRST AID', 'certificate:MFA'],
    ['BST', 'certificate:BST'],
    ['Basic Safety Training', 'certificate:BST'],
    ['AFF', 'certificate:AFF'],
    ['Firefighting', 'certificate:AFF'],
    ['SRB', 'certificate:SRB'],
    ['ENDORSEMENT', 'certificate:ENDORS'],
    ['BST date de délivrance', 'certificate:BST:issued'],
  ])('certificat %s -> %s', (header, expected) => {
    expect(suggestTarget(header, CODES)).toBe(expected);
  });

  it('analyse les cibles de mapping (aller-retour des suggestions)', () => {
    expect(parseMappingTarget('certificate:GMDSS:expiry')).toEqual({ kind: 'certificate', code: 'GMDSS', part: 'expiry' });
    expect(parseMappingTarget('certificate:sso')).toEqual({ kind: 'certificate', code: 'SSO', part: 'combined' });
    expect(parseMappingTarget('passportNumber')).toEqual({ kind: 'field', field: 'passportNumber' });
    expect(parseMappingTarget('joinDate')).toEqual({ kind: 'extra', target: 'joinDate' });
    expect(parseMappingTarget('')).toEqual({ kind: 'ignore' });
    expect(parseMappingTarget('password')).toBeNull();
  });

  it('ne propose pas un type de certificat absent du référentiel', () => {
    expect(suggestTarget('SSO', new Set(['BST']))).toBeNull();
  });

  it('propose chaque cible une seule fois et privilégie NOM / PRENOM séparés', () => {
    const m = suggestMapping(['N°', 'NOM ET PRENOM', 'NOM', 'PRENOM', 'MEDICAL', 'MEDICAL EXAM', 'SSO'], CODES);
    expect(m).toEqual({ A: 'ignore', C: 'lastName', D: 'firstName', E: 'certificate:MEDICAL', G: 'certificate:SSO' });
  });

  it('feuilles AMC hétérogènes : département par défaut seulement si univoque', () => {
    expect(suggestSheetDefaults('OFFICIE PONT')).toEqual({ crewDepartment: 'DECK' });
    expect(suggestSheetDefaults('BOSUN DECK RATING')).toEqual({ crewDepartment: 'DECK' });
    expect(suggestSheetDefaults('OFFICIE MATLOT')).toEqual({ crewDepartment: 'DECK' });
    expect(suggestSheetDefaults('LES GRAISSEURS - COOK')).toEqual({});
  });

  it('en-têtes sur deux lignes (cellule fusionnée au-dessus)', () => {
    const rows = [
      ['NOM', 'PRENOM', 'GMDSS', null],
      [null, null, 'N°', 'EXP'],
    ];
    const headers = buildHeaders(rows, 0, 2);
    expect(headers).toEqual(['NOM', 'PRENOM', 'GMDSS N°', 'GMDSS EXP']);
    expect(suggestMapping(headers, CODES)).toEqual({ A: 'lastName', B: 'firstName', C: 'certificate:GMDSS:number', D: 'certificate:GMDSS:expiry' });
  });

  it('résout une clé de mapping : en-tête prioritaire sur la lettre de colonne', () => {
    const headers = ['NOM', 'PRENOM', 'SAT', 'NOM'];
    expect(resolveColumnKey('SAT', headers)).toBe(2);
    expect(resolveColumnKey('B', headers)).toBe(1);
    expect(resolveColumnKey('prénom', headers)).toBe(1);
    expect(resolveColumnKey('Nom', headers)).toBe(-2);
    expect(resolveColumnKey('Z', headers)).toBe(-1);
  });
});

describe('Normalisation des cellules (CDC V1 §5.3)', () => {
  it('date texte JJ.MM.AAAA', () => {
    expect(parseCertificateCell('15.03.2027')).toEqual({ present: true, number: null, expiry: { kind: 'DATE', value: '2027-03-15' }, issued: null });
  });

  it('date Excel (numéro de série)', () => {
    expect(parseCertificateCell(SERIAL_2027_03_15)).toEqual({ present: true, number: null, expiry: { kind: 'DATE', value: '2027-03-15' }, issued: null });
    expect(parseDateCell(SERIAL_2027_03_15, 'expiry')).toEqual({ kind: 'DATE', value: '2027-03-15' });
  });

  it('PERMANENT -> UNLIMITED', () => {
    expect(parseCertificateCell('PERMANENT')).toMatchObject({ present: true, expiry: { kind: 'UNLIMITED' } });
    expect(parseCertificateCell('permanente')).toMatchObject({ present: true, expiry: { kind: 'UNLIMITED' } });
  });

  it('cellule vide -> pas de certificat', () => {
    expect(parseCertificateCell(null)).toEqual({ present: false });
    expect(parseCertificateCell('   ')).toEqual({ present: false });
    expect(parseCertificateCell('-')).toEqual({ present: false });
    expect(parseCertificateCell('NON')).toEqual({ present: false });
  });

  it('texte composite : numéro + dates (délivrance / expiration)', () => {
    expect(parseCertificateCell('N° GM-4521 exp 15.03.2027')).toEqual({
      present: true,
      number: 'GM-4521',
      expiry: { kind: 'DATE', value: '2027-03-15' },
      issued: null,
    });
    expect(parseCertificateCell('01/02/2022 - 01/02/2027')).toMatchObject({ expiry: { kind: 'DATE', value: '2027-02-01' }, issued: '2022-02-01' });
    expect(parseCertificateCell('OUI')).toEqual({ present: true, number: null, expiry: { kind: 'EMPTY' }, issued: null });
    expect(parseCertificateCell('EN COURS')).toMatchObject({ present: false, warning: expect.stringContaining('non reconnue') });
  });

  it('date de naissance : année seule et date future refusées', () => {
    expect(parseDateCell(1985, 'birth')).toMatchObject({ kind: 'INVALID', reason: 'année seule' });
    expect(parseDateCell('01.01.2099', 'birth')).toMatchObject({ kind: 'INVALID', reason: 'date future' });
    expect(parseDateCell('02.04.1985', 'birth')).toEqual({ kind: 'DATE', value: '1985-04-02' });
  });

  it('référentiels : rangs, nationalités', () => {
    expect(resolveRank('GRAISSEUR', RANKS)?.code).toBe('OILER');
    expect(resolveRank('C/O', RANKS)?.code).toBe('C_OFF');
    expect(resolveRank('Capitaine', RANKS)?.code).toBe('MASTER');
    expect(resolveRank('Pilote', RANKS)).toBeNull();
    expect(resolveCountry('Tunisienne')).toBe('TN');
    expect(resolveCountry('tn')).toBe('TN');
    expect(resolveCountry('Atlantide')).toBeNull();
  });

  it('découpage du nom complet', () => {
    expect(splitFullName('BEN SALAH Mohamed Ali')).toEqual({ lastName: 'BEN SALAH', firstName: 'Mohamed Ali', confident: true });
    expect(splitFullName('BEN SALAH MOHAMED')).toEqual({ lastName: 'BEN SALAH', firstName: 'MOHAMED', confident: false });
    expect(splitFullName('DUPONT')).toBeNull();
  });
});

describe('Normalisation d’une ligne', () => {
  const columns = [
    col('A', 'ignore'),
    col('B', 'fullName'),
    col('C', 'birthDate'),
    col('D', 'amcRef'),
    col('E', 'passportNumber'),
    col('F', 'rank'),
    col('G', 'certificate:SSO'),
    col('H', 'certificate:MEDICAL'),
    col('I', 'certificate:BST'),
    col('J', 'certificate:GMDSS:number'),
    col('K', 'certificate:GMDSS:expiry'),
    col('L', 'certificate:ARPA'),
    col('M', 'joinDate'),
    col('N', 'nationality'),
  ];

  it('normalise identité, fonction et certificats (date texte, série Excel, PERMANENT, vide)', () => {
    const { normalized, errors, warnings } = normalizeImportRow(
      {
        A: 12,
        B: 'BEN SALAH Mohamed',
        C: '02.04.1985',
        D: 1234,
        E: 'tn 123 456',
        F: 'graisseur',
        G: 'PERMANENT',
        H: '15.03.2027',
        I: SERIAL_2027_03_15,
        J: 'GOC-778',
        K: null,
        L: '',
        M: '01.08.2026',
        N: 'Tunisien',
      },
      columns,
      { ranks: RANKS, certificateCodes: CODES },
    );
    expect(errors).toEqual([]);
    expect(normalized.member).toEqual({
      lastName: 'BEN SALAH',
      firstName: 'Mohamed',
      birthDate: '1985-04-02',
      amcRef: '1234',
      passportNumber: 'TN123456',
      rank: 'Oiler / Graisseur',
      crewDepartment: 'ENGINE',
      nationality: 'TN',
    });
    const byCode = Object.fromEntries(normalized.certificates.map((c) => [c.code, c]));
    expect(byCode.SSO).toMatchObject({ expiryKind: 'UNLIMITED', expiryOn: null, number: null });
    expect(byCode.MEDICAL).toMatchObject({ expiryKind: 'DATED', expiryOn: '2027-03-15' });
    expect(byCode.BST).toMatchObject({ expiryKind: 'DATED', expiryOn: '2027-03-15' });
    // numéro présent, expiration vide => UNKNOWN (jamais UNLIMITED)
    expect(byCode.GMDSS).toMatchObject({ number: 'GOC-778', expiryKind: 'UNKNOWN', expiryOn: null });
    // cellule vide => aucun certificat créé
    expect(byCode.ARPA).toBeUndefined();
    expect(normalized.assignment).toEqual({ joinDate: '2026-08-01', signOffDate: null, vesselText: null });
    expect(warnings.some((w) => w.message.includes('GMDSS') && w.message.includes('inconnue'))).toBe(true);
  });

  it('ligne invalide : nom manquant, date de naissance illisible', () => {
    const { errors } = normalizeImportRow({ B: 'X', C: '32.13.1980' }, [col('B', 'firstName'), col('C', 'birthDate')], { ranks: RANKS, certificateCodes: CODES });
    expect(errors.map((e) => e.field).sort()).toEqual(['birthDate', 'lastName']);
  });

  it('ligne de séparation sans identité ignorée', () => {
    expect(isBlankRow({ A: 'OFFICIERS PONT', B: null }, [col('B', 'lastName'), col('C', 'certificate:SSO')])).toBe(true);
    expect(isBlankRow({ B: 'DUPONT' }, [col('B', 'lastName')])).toBe(false);
  });

  it('corrections opérateur : normalisation et journal from/to', () => {
    const { member, changes } = applyCorrections({ lastName: 'DUPONT' }, { firstName: 'Jean', passportNumber: 'ab 12', rank: 'Cook' }, RANKS);
    expect(member).toEqual({ lastName: 'DUPONT', firstName: 'Jean', passportNumber: 'AB12', rank: 'Cook / Cuisinier', crewDepartment: 'CATERING' });
    expect(changes.firstName).toEqual({ from: null, to: 'Jean' });
  });
});

describe('Détection des doublons (ADM-042)', () => {
  const existing = [
    { id: 'm1', lastName: 'Ben Salah', firstName: 'Mohamed', birthDate: '1985-04-02', passportNumber: 'TN123456', passportCountry: 'TN' },
    { id: 'm2', lastName: 'Trabelsi', firstName: 'Ali', birthDate: '1990-01-01', passportNumber: 'X999' },
    { id: 'm3', lastName: 'Dupont', firstName: 'Jean', amcRef: 'AMC-0042' },
  ];

  it('par passeport (normalisé), même sans nom identique', () => {
    const r = scoreDuplicate({ lastName: 'B. Salah', firstName: 'M.', passportNumber: 'tn 123-456' }, existing[0]);
    expect(r.score).toBe(90);
    expect(r.reasons).toContain('PASSPORT');
  });

  it('passeport identique mais pays émetteurs différents : signal faible', () => {
    const r = scoreDuplicate({ passportNumber: 'TN123456', passportCountry: 'MA' }, existing[0]);
    expect(r).toEqual({ score: 35, reasons: ['PASSPORT_OTHER_COUNTRY'] });
  });

  it('par nom + prénom + date de naissance (accents, casse, tirets)', () => {
    const r = scoreDuplicate({ lastName: 'BEN-SALAH', firstName: 'MOHAMED', birthDate: '1985-04-02' }, existing[0]);
    expect(r).toEqual({ score: 80, reasons: ['NAME_BIRTHDATE'] });
    expect(scoreDuplicate({ lastName: 'Mohamed', firstName: 'Ben Salah', birthDate: '1985-04-02' }, existing[0]).reasons).toEqual(['NAME_SWAPPED_BIRTHDATE']);
    expect(scoreDuplicate({ lastName: 'Ben Salah', firstName: 'Mohammed', birthDate: '1985-04-02' }, existing[0]).reasons).toEqual(['NAME_SIMILAR_BIRTHDATE']);
  });

  it('homonyme avec date de naissance différente : rapprochement manuel (seuil)', () => {
    const r = scoreDuplicate({ lastName: 'Ben Salah', firstName: 'Mohamed', birthDate: '1979-12-31' }, existing[0]);
    expect(r).toEqual({ score: 30, reasons: ['NAME_BIRTHDATE_DIFFERS'] });
  });

  it('matricule AMC identique et classement des candidats', () => {
    const c = rankCandidates({ amcRef: 'amc 0042', lastName: 'Martin', firstName: 'Paul' }, existing);
    expect(c[0]).toMatchObject({ memberId: 'm3', score: 100 });
    expect(c[0].reasons).toEqual(expect.arrayContaining(['AMC_REF', 'IDENTITY_MISMATCH']));
    expect(rankCandidates({ lastName: 'Inconnu', firstName: 'Zoé', birthDate: '2000-01-01' }, existing)).toEqual([]);
  });

  it('doublons internes au fichier (passeport, nom + naissance)', () => {
    const rows = [
      { id: 'r1', sheetName: 'OFFICIE PONT', rowNumber: 2, identity: { lastName: 'Ali', firstName: 'Karim', birthDate: '1980-05-05', passportNumber: 'P1' } },
      { id: 'r2', sheetName: 'BOSUN DECK RATING', rowNumber: 7, identity: { lastName: 'ALI', firstName: 'KARIM', birthDate: '1980-05-05' } },
      { id: 'r3', sheetName: 'LES GRAISSEURS - COOK', rowNumber: 3, identity: { lastName: 'Autre', firstName: 'Nom', passportNumber: 'p 1' } },
      { id: 'r4', sheetName: 'OFFICIE PONT', rowNumber: 9, identity: { lastName: 'Seul', firstName: 'Unique' } },
    ];
    const d = findInFileDuplicates(rows);
    expect(d.get('r1')!.map((c) => (c.kind === 'ROW' ? c.rowId : '')).sort()).toEqual(['r2', 'r3']);
    expect(d.get('r2')![0]).toMatchObject({ kind: 'ROW', rowId: 'r1', score: 80, sheetName: 'OFFICIE PONT', rowNumber: 2 });
    expect(d.get('r3')![0]).toMatchObject({ rowId: 'r1', score: 90 });
    expect(d.has('r4')).toBe(false);
  });

  it('statut de ligne et diff valeurs courantes / import', () => {
    expect(computeRowStatus([{ message: 'Nom manquant' }], [])).toBe('INVALID');
    expect(computeRowStatus([], [{ kind: 'MEMBER', memberId: 'm1', score: 90, reasons: ['PASSPORT'] }])).toBe('DUPLICATE_SUSPECTED');
    expect(computeRowStatus([], [])).toBe('VALID');
    const diff = computeImportDiff(
      { lastName: 'Ben Salah', passportNumber: 'TN123456', birthDate: new Date('1985-04-02T00:00:00.000Z'), phone: null },
      { lastName: 'Ben Salah', passportNumber: 'TN 123456', birthDate: '1985-04-03', phone: '+216 20 000 000' },
    );
    expect(diff).toEqual([
      { field: 'lastName', current: 'Ben Salah', imported: 'Ben Salah', changed: false, protected: false },
      { field: 'passportNumber', current: 'TN123456', imported: 'TN 123456', changed: false, protected: true },
      { field: 'birthDate', current: '1985-04-02', imported: '1985-04-03', changed: true, protected: true },
      { field: 'phone', current: null, imported: '+216 20 000 000', changed: true, protected: false },
    ]);
    expect(identityOf({ lastName: 'A', firstName: 'B', nationality: 'TN', passportNumber: 'P' })).toMatchObject({ passportCountry: 'TN' });
  });
});
