import { inspectFile, sanitizeFileName } from './file-inspector';

const PDF = Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');

/** Contrôles de dépôt (CDC §1.1, §12.3) : type réel, liste blanche par contexte, contenu actif refusé. */
describe('inspectFile', () => {
  it('accepte un PDF pour un certificat', async () => {
    const r = await inspectFile(PDF, 'certificat.pdf', 'CERTIFICATE');
    expect(r).toMatchObject({ kind: 'PDF', mimeType: 'application/pdf', extension: 'pdf' });
  });

  it('refuse une extension incohérente avec le contenu (PNG nommé .pdf)', async () => {
    await expect(inspectFile(PNG, 'faux.pdf', 'CERTIFICATE')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
  });

  it('refuse le HTML et le SVG (XSS), quel que soit le contexte', async () => {
    await expect(inspectFile(Buffer.from('<html></html>'), 'a.html', 'CSO_DOCUMENT')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
    await expect(inspectFile(Buffer.from('<svg/>'), 'a.svg', 'VESSEL_PHOTO')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
  });

  it('refuse un PDF contenant du JavaScript', async () => {
    const active = Buffer.concat([PDF, Buffer.from('\n/OpenAction << /S /JavaScript /JS (app.alert(1)) >>')]);
    await expect(inspectFile(active, 'actif.pdf', 'CERTIFICATE')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
  });

  it('applique la liste blanche par contexte (PDF interdit comme photo navire)', async () => {
    await expect(inspectFile(PDF, 'photo.pdf', 'VESSEL_PHOTO')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
  });

  it('accepte un CSV texte uniquement en import', async () => {
    const csv = Buffer.from('NOM;PRENOM\nDEMO;Marin\n');
    await expect(inspectFile(csv, 'equipage.csv', 'IMPORT_SOURCE')).resolves.toMatchObject({ kind: 'CSV' });
    await expect(inspectFile(csv, 'equipage.csv', 'CERTIFICATE')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
  });

  it('refuse un fichier vide', async () => {
    await expect(inspectFile(Buffer.alloc(0), 'vide.pdf', 'CERTIFICATE')).rejects.toMatchObject({ code: 'FILE_REJECTED' });
  });
});

describe('sanitizeFileName', () => {
  it('neutralise les chemins et caractères de contrôle (path traversal)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\rapport<1>.pdf')).toBe('rapport_1_.pdf');
    expect(sanitizeFileName('...cache.pdf')).toBe('cache.pdf');
  });

  it('conserve les accents français', () => {
    expect(sanitizeFileName('Échéancier-été.pdf')).toBe('Échéancier-été.pdf');
  });
});
