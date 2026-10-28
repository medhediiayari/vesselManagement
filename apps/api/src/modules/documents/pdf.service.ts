import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';

/** Charte AMC (CDC V1 §2.3) */
const NAVY = '#10243A';
const ACTION = '#176CBA';
const TEAL = '#11A3A4';
const MUTED = '#5B6B7B';
const LINE = '#D5DCE4';

export interface PdfMeta {
  title: string;
  subtitle?: string;
  reference?: string;
  /** Lignes affichées sous le titre (navire, date, statut…) */
  meta?: [string, string][];
  author?: string;
  confidential?: boolean;
}

export interface PdfTableColumn {
  header: string;
  key: string;
  width: number;
  align?: 'left' | 'right' | 'center';
}

type Doc = PDFKit.PDFDocument;

/**
 * Générateur PDF commun (BC/PO, Noon Report 7 sections, rapports de réception, certificats…).
 * Les documents produits sont stockés dans MinIO via FilesService.storeGenerated().
 * Polices standard PDF (WinAnsi) : couvre les caractères français.
 */
@Injectable()
export class PdfService {
  async render(meta: PdfMeta, body: (b: PdfBuilder) => void | Promise<void>): Promise<Buffer> {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 110, bottom: 60, left: 42, right: 42 },
      bufferPages: true,
      info: { Title: meta.title, Author: meta.author ?? 'AMC Platform', Creator: 'AMC Platform', Producer: 'AMC Platform' },
    });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve, reject) => {
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });

    const builder = new PdfBuilder(doc);
    doc.on('pageAdded', () => drawHeader(doc, meta));
    drawHeader(doc, meta);
    await body(builder);

    const range = doc.bufferedPageRange();
    const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - 40;
      // Le pied de page est sous la marge basse : la neutraliser évite qu'pdfkit ajoute une page blanche
      const bottomMargin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.save();
      doc.moveTo(42, y - 8).lineTo(doc.page.width - 42, y - 8).strokeColor(LINE).lineWidth(0.5).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
      doc.text(`Généré le ${generatedAt}${meta.author ? ` par ${meta.author}` : ''} — AMC Platform`, 42, y, {
        lineBreak: false,
      });
      doc.text(`Page ${i - range.start + 1} / ${range.count}`, doc.page.width - 142, y, { width: 100, align: 'right', lineBreak: false });
      doc.restore();
      doc.page.margins.bottom = bottomMargin;
    }
    doc.end();
    return done;
  }
}

function drawHeader(doc: Doc, meta: PdfMeta) {
  const w = doc.page.width;
  doc.save();
  doc.rect(0, 0, w, 78).fill(NAVY);
  doc.rect(0, 78, w, 3).fill(TEAL);
  doc.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(9).text('AFRICA MARINE COMPANY', 42, 18, { lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(16).text(meta.title, 42, 32, { width: w - 230, lineBreak: false, ellipsis: true });
  if (meta.subtitle) doc.font('Helvetica').fontSize(9).fillColor('#C9D6E3').text(meta.subtitle, 42, 54, { width: w - 230, lineBreak: false });
  if (meta.reference) {
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF').text(meta.reference, w - 222, 30, { width: 180, align: 'right' });
  }
  if (meta.confidential) {
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFB4B4').text('CONFIDENTIEL', w - 222, 52, { width: 180, align: 'right' });
  }
  doc.restore();
  doc.font('Helvetica').fontSize(9).fillColor('#1B2733');
  doc.x = doc.page.margins.left;
  doc.y = 94;
  if (meta.meta?.length) {
    // Bandeau de 3 métadonnées maximum (navire, date, statut…) ; le reste va dans le corps
    const colW = (w - 84) / 3;
    meta.meta.slice(0, 3).forEach(([label, value], i) => {
      const x = 42 + i * colW;
      doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, 92, { width: colW - 8, lineBreak: false });
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1B2733').text(value || '—', x, 100, { width: colW - 8, lineBreak: false, ellipsis: true });
    });
    doc.y = 116;
    doc.x = 42;
  }
}

export class PdfBuilder {
  constructor(readonly doc: Doc) {}

  private get contentWidth() {
    return this.doc.page.width - this.doc.page.margins.left - this.doc.page.margins.right;
  }

  private ensureSpace(h: number) {
    if (this.doc.y + h > this.doc.page.height - this.doc.page.margins.bottom) this.doc.addPage();
  }

  section(title: string, index?: number) {
    this.ensureSpace(40);
    const d = this.doc;
    d.moveDown(0.6);
    const y = d.y;
    d.rect(42, y, this.contentWidth, 18).fill('#EAF2FA');
    d.rect(42, y, 3, 18).fill(ACTION);
    d.fillColor(NAVY).font('Helvetica-Bold').fontSize(10).text(`${index ? `${index}. ` : ''}${title}`, 52, y + 5, { lineBreak: false });
    d.y = y + 24;
    d.x = 42;
    d.font('Helvetica').fontSize(9).fillColor('#1B2733');
    return this;
  }

  /** Grille clé / valeur (2 ou 3 colonnes). */
  fields(pairs: [string, string | number | null | undefined][], columns = 2) {
    const d = this.doc;
    const colW = this.contentWidth / columns;
    for (let i = 0; i < pairs.length; i += columns) {
      const row = pairs.slice(i, i + columns);
      const heights = row.map(([, v]) => d.font('Helvetica').fontSize(9).heightOfString(fmt(v), { width: colW - 10 }));
      const h = Math.max(...heights) + 14;
      this.ensureSpace(h);
      const y = d.y;
      row.forEach(([label, value], j) => {
        const x = 42 + j * colW;
        d.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: colW - 10 });
        d.font('Helvetica').fontSize(9).fillColor('#1B2733').text(fmt(value), x, y + 9, { width: colW - 10 });
      });
      d.y = y + h;
      d.x = 42;
    }
    return this;
  }

  paragraph(label: string, text: string | null | undefined) {
    const d = this.doc;
    const body = fmt(text);
    const h = d.font('Helvetica').fontSize(9).heightOfString(body, { width: this.contentWidth }) + 16;
    this.ensureSpace(Math.min(h, 200));
    d.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), 42, d.y, { width: this.contentWidth });
    d.font('Helvetica').fontSize(9).fillColor('#1B2733').text(body, 42, d.y + 2, { width: this.contentWidth });
    d.moveDown(0.5);
    d.x = 42;
    return this;
  }

  table(columns: PdfTableColumn[], rows: Record<string, unknown>[]) {
    const d = this.doc;
    const total = columns.reduce((s, c) => s + c.width, 0);
    const scale = this.contentWidth / total;
    const cols = columns.map((c) => ({ ...c, w: c.width * scale }));
    const drawHead = () => {
      this.ensureSpace(22);
      const y = d.y;
      d.rect(42, y, this.contentWidth, 16).fill(NAVY);
      let x = 42;
      cols.forEach((c) => {
        d.fillColor('#FFFFFF').font('Helvetica-Bold').fontSize(7.5).text(c.header, x + 4, y + 4.5, { width: c.w - 8, align: c.align ?? 'left', lineBreak: false });
        x += c.w;
      });
      d.y = y + 16;
    };
    drawHead();
    rows.forEach((r, idx) => {
      const heights = cols.map((c) => d.font('Helvetica').fontSize(8).heightOfString(fmt(r[c.key] as never), { width: c.w - 8 }));
      const h = Math.max(...heights, 9) + 7;
      if (d.y + h > d.page.height - d.page.margins.bottom) {
        d.addPage();
        drawHead();
      }
      const y = d.y;
      if (idx % 2 === 1) d.rect(42, y, this.contentWidth, h).fill('#F5F8FB');
      let x = 42;
      cols.forEach((c) => {
        d.fillColor('#1B2733').font('Helvetica').fontSize(8).text(fmt(r[c.key] as never), x + 4, y + 3.5, { width: c.w - 8, align: c.align ?? 'left' });
        x += c.w;
      });
      d.y = y + h;
      d.moveTo(42, d.y).lineTo(42 + this.contentWidth, d.y).strokeColor(LINE).lineWidth(0.4).stroke();
    });
    d.x = 42;
    d.moveDown(0.4);
    return this;
  }

  note(text: string) {
    this.ensureSpace(30);
    this.doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED).text(text, 42, this.doc.y + 4, { width: this.contentWidth });
    this.doc.x = 42;
    return this;
  }

  /** Bloc de signature / attribution (pas de signature cryptographique en V1, CDC §17). */
  signatures(blocks: { label: string; name?: string | null; date?: string | null }[]) {
    this.ensureSpace(70);
    const d = this.doc;
    const w = this.contentWidth / blocks.length;
    const y = d.y + 10;
    blocks.forEach((b, i) => {
      const x = 42 + i * w;
      d.font('Helvetica').fontSize(7).fillColor(MUTED).text(b.label.toUpperCase(), x, y, { width: w - 12 });
      d.font('Helvetica-Bold').fontSize(9).fillColor('#1B2733').text(b.name ?? '—', x, y + 10, { width: w - 12 });
      d.font('Helvetica').fontSize(8).fillColor(MUTED).text(b.date ?? '', x, y + 22, { width: w - 12 });
      d.moveTo(x, y + 50).lineTo(x + w - 16, y + 50).strokeColor(LINE).stroke();
    });
    d.y = y + 58;
    d.x = 42;
    return this;
  }
}

function fmt(v: string | number | null | undefined | Date): string {
  if (v === null || v === undefined || v === '') return '—';
  if (v instanceof Date) return v.toISOString().slice(0, 16).replace('T', ' ');
  return String(v);
}
