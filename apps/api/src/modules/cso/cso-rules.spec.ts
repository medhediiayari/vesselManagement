import {
  DEFAULT_ZIP_LIMITS,
  VERSION_TRANSITIONS,
  canTransition,
  checkZipEntryPath,
  checkZipEntrySize,
  documentFileName,
  dueBucket,
  escapeLike,
  isSymlinkEntry,
  missingStandardFields,
  pageOverVisible,
  pendingBucket,
  referenceSequenceKey,
  renderReference,
  restorationSource,
  restorePlan,
  sanitizeZipSegment,
  uniqueZipName,
  validateReferenceFormat,
  zipPath,
} from './cso-rules';

describe('CSO — automate des versions', () => {
  it('ancienne officielle reste PUBLISHED jusqu’à SUPERSEDED ; états terminaux figés', () => {
    expect(canTransition('PENDING_APPROVAL', 'PUBLISHED')).toBe(true);
    expect(canTransition('PUBLISHED', 'SUPERSEDED')).toBe(true);
    expect(canTransition('DRAFT', 'PUBLISHED')).toBe(false); // jamais de publication sans approbation
    expect(canTransition('RETURNED', 'PENDING_APPROVAL')).toBe(true);
    for (const terminal of ['REJECTED', 'SUPERSEDED', 'CANCELLED'] as const) {
      expect(VERSION_TRANSITIONS[terminal]).toHaveLength(0);
    }
  });
});

describe('CSO — références (CSO-026)', () => {
  const parts = { categoryCode: 'SSP', vesselCode: 'ISK', year: 2026 };

  it('valide les formats', () => {
    expect(validateReferenceFormat('CSO-SSP-{VESSEL}-{YYYY}-{SEQ:3}')).toBeNull();
    expect(validateReferenceFormat('CSO-{CAT}-{SEQ}')).toBeNull();
    expect(validateReferenceFormat('CSO-{FOO}-{SEQ}')).toMatch(/inconnu/);
    expect(validateReferenceFormat('CSO-{YYYY}')).toMatch(/SEQ/);
    expect(validateReferenceFormat('CSO-{SEQ}-{SEQ}')).toMatch(/SEQ/);
    expect(validateReferenceFormat('CSO-{YYYY:2}-{SEQ}')).toMatch(/longueur/);
    expect(validateReferenceFormat('CSO<script>{SEQ}')).toMatch(/Caractères/);
  });

  it('rend les jetons et complète la séquence', () => {
    expect(renderReference('CSO-SSP-{VESSEL}-{YYYY}-{SEQ:3}', parts, 7)).toBe('CSO-SSP-ISK-2026-007');
    expect(renderReference('CSO-{CAT}-{SEQ}', parts, 12)).toBe('CSO-SSP-0012');
  });

  it('clé de séquence par catégorie, navire et année seulement si présents dans le format', () => {
    expect(referenceSequenceKey('CSO-SSP-{VESSEL}-{YYYY}-{SEQ:3}', parts)).toBe('CSO-REF:SSP:ISK:2026');
    expect(referenceSequenceKey('CSO-DRL-{YYYY}-{SEQ:4}', parts)).toBe('CSO-REF:SSP:*:2026');
    expect(referenceSequenceKey('CSO-{SEQ}', parts)).toBe('CSO-REF:SSP:*:*');
  });

  it('champs standards obligatoires manquants', () => {
    expect(missingStandardFields(['description', 'expiryOn'], { description: '  ', expiryOn: new Date() })).toEqual(['description']);
  });
});

describe('CSO — noms ZIP (anti zip-slip)', () => {
  it('neutralise séparateurs, remontées et noms réservés', () => {
    expect(sanitizeZipSegment('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(sanitizeZipSegment('..')).toBe('element');
    expect(sanitizeZipSegment('  .hidden ')).toBe('hidden');
    expect(sanitizeZipSegment('C:\\Windows')).toBe('C__Windows');
    expect(sanitizeZipSegment('CON')).toBe('_CON');
    expect(sanitizeZipSegment('a\u0000b')).toBe('ab');
    expect(zipPath(['Dossier', '..', 'x/y'])).toBe('Dossier/element/x_y');
  });

  it('évite les collisions', () => {
    const used = new Set<string>();
    expect(uniqueZipName(used, 'A/doc.pdf')).toBe('A/doc.pdf');
    expect(uniqueZipName(used, 'A/DOC.pdf')).toBe('A/DOC (2).pdf');
    expect(uniqueZipName(used, 'A/doc.pdf')).toBe('A/doc (3).pdf');
  });

  it('nom de document', () => {
    expect(documentFileName({ reference: 'CSO-SSP-ISK-2026-001', title: 'Plan / sûreté' }, 'pdf')).toBe('CSO-SSP-ISK-2026-001 - Plan _ sûreté.pdf');
    expect(documentFileName({ reference: null, title: 'Plan' }, 'pdf', 2)).toBe('Plan (v2).pdf');
    expect(documentFileName({ reference: null, title: 'x' }, '../exe')).toBe('x');
  });
});

describe('CSO — entrées ZIP importées', () => {
  it('refuse chemins absolus, remontées, antislash et caractères de contrôle', () => {
    expect(checkZipEntryPath('/etc/passwd').ok).toBe(false);
    expect(checkZipEntryPath('C:/x.pdf').ok).toBe(false);
    expect(checkZipEntryPath('a/../../x.pdf').ok).toBe(false);
    expect(checkZipEntryPath('a\\x.pdf').ok).toBe(false);
    expect(checkZipEntryPath('a/\u0001.pdf').ok).toBe(false);
  });

  it('accepte une arborescence normale et ignore les fichiers système', () => {
    expect(checkZipEntryPath('SSP/Annexes/plan.pdf')).toEqual({ ok: true, segments: ['SSP', 'Annexes', 'plan.pdf'], isDirectory: false });
    expect(checkZipEntryPath('SSP/')).toEqual({ ok: true, segments: ['SSP'], isDirectory: true });
    expect(checkZipEntryPath('__MACOSX/SSP/._plan.pdf')).toMatchObject({ ok: true, ignored: true });
    expect(checkZipEntryPath('./a/b.pdf')).toMatchObject({ ok: true, segments: ['a', 'b.pdf'] });
  });

  it('détecte liens symboliques, entrées trop volumineuses et zip bombs', () => {
    expect(isSymlinkEntry((0o120777 << 16) >>> 0)).toBe(true);
    expect(isSymlinkEntry((0o100644 << 16) >>> 0)).toBe(false);
    expect(checkZipEntrySize({ compressedSize: 10, uncompressedSize: DEFAULT_ZIP_LIMITS.maxEntryBytes + 1 }, 0)).toMatch(/volumineux/);
    expect(checkZipEntrySize({ compressedSize: 1000, uncompressedSize: 10 * 1024 * 1024 }, 0)).toMatch(/zip bomb/);
    expect(checkZipEntrySize({ compressedSize: 100, uncompressedSize: 100 }, DEFAULT_ZIP_LIMITS.maxTotalBytes)).toMatch(/totale/);
    expect(checkZipEntrySize({ compressedSize: 900_000, uncompressedSize: 1_000_000 }, 0)).toBeNull();
  });
});

describe('CSO — rappels (CSO-012)', () => {
  const now = new Date('2026-10-11T08:00:00Z');
  it('tranches 30 j / 7 j / dépassé', () => {
    expect(dueBucket(new Date('2026-12-31'), now)).toBeNull();
    expect(dueBucket(new Date('2026-11-05'), now)).toBe('D30');
    expect(dueBucket(new Date('2026-10-18'), now)).toBe('D7');
    expect(dueBucket(new Date('2026-10-11'), now)).toBe('D7');
    expect(dueBucket(new Date('2026-10-10'), now)).toBe('OVERDUE');
  });

  it('relance d’approbation toutes les 48 h', () => {
    expect(pendingBucket(new Date('2026-10-10T08:00:00Z'), now)).toBeNull();
    expect(pendingBucket(new Date('2026-10-09T07:00:00Z'), now)).toBe(1);
    expect(pendingBucket(new Date('2026-10-07T07:00:00Z'), now)).toBe(2);
  });

  it('échappe les métacaractères LIKE', () => {
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

describe('CSO — curseur de recherche sans oracle (audit #22)', () => {
  it('le curseur ne compte que les éléments visibles', () => {
    const visible = ['a', 'b', 'c', 'd', 'e'];
    expect(pageOverVisible(visible, 0, 2)).toEqual({ items: ['a', 'b'], nextCursor: '2' });
    expect(pageOverVisible(visible, 2, 2)).toEqual({ items: ['c', 'd'], nextCursor: '4' });
    expect(pageOverVisible(visible, 4, 2)).toEqual({ items: ['e'], nextCursor: null });
  });

  it('deux flux SQL différant seulement par des éléments masqués donnent les mêmes curseurs', () => {
    const sql1 = ['a', 'x', 'b', 'c'];
    const sql2 = ['a', 'b', 'y', 'z', 'w', 'c'];
    const hidden = new Set(['x', 'y', 'z', 'w']);
    const p1 = pageOverVisible(sql1.filter((i) => !hidden.has(i)), 0, 2);
    const p2 = pageOverVisible(sql2.filter((i) => !hidden.has(i)), 0, 2);
    expect(p1).toEqual(p2);
  });
});

describe('CSO — source de restauration (audit #10)', () => {
  const v = (versionNo: number, status: string, publishedAt: string | null) => ({ versionNo, status: status as never, publishedAt: publishedAt ? new Date(publishedAt) : null });

  it('ne retient que la dernière version déjà approuvée', () => {
    const src = restorationSource([v(1, 'SUPERSEDED', '2026-01-01'), v(2, 'SUPERSEDED', '2026-03-01'), v(3, 'REJECTED', null), v(4, 'CANCELLED', null)]);
    expect(src?.versionNo).toBe(2);
  });

  it('jamais de repli sur une version non approuvée (brouillon, rejetée, annulée)', () => {
    expect(restorationSource([v(1, 'REJECTED', null), v(2, 'CANCELLED', null), v(3, 'DRAFT', null)])).toBeNull();
    expect(restorationSource([])).toBeNull();
  });

  it('CSO-03 : document jamais approuvé -> restauration en brouillon avec le dernier fichier', () => {
    const plan = restorePlan([v(1, 'CANCELLED', null), v(3, 'CANCELLED', null), v(2, 'RETURNED', null)]);
    expect(plan?.mode).toBe('DRAFT');
    expect(plan?.source.versionNo).toBe(3);
  });

  it('CSO-03 : document déjà approuvé -> nouvelle approbation de la dernière version approuvée', () => {
    const plan = restorePlan([v(1, 'SUPERSEDED', '2026-01-01'), v(2, 'CANCELLED', null)]);
    expect(plan).toEqual({ mode: 'APPROVAL', source: expect.objectContaining({ versionNo: 1 }) });
    expect(restorePlan([])).toBeNull();
  });
});
