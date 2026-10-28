import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { Errors } from '../../common/errors';

export interface SheetData {
  name: string;
  /** Lignes brutes (valeurs de cellules) ; index 0 = première ligne de la feuille */
  rows: unknown[][];
}

export type ParsedDate =
  | { kind: 'DATE'; value: string }
  | { kind: 'UNLIMITED' }
  | { kind: 'EMPTY' }
  | { kind: 'INVALID'; raw: string };

export interface ExportColumn {
  header: string;
  key: string;
  width?: number;
  /** Format Excel (ex. 'dd/mm/yyyy', '#,##0.00') */
  numFmt?: string;
}

const UNLIMITED_TOKENS = ['PERMANENT', 'PERMANENTE', 'ILLIMITE', 'ILLIMITÉ', 'ILLIMITEE', 'UNLIMITED', 'NO EXPIRY', 'N/E', 'P'];

/**
 * Lecture Excel (.xlsx et .xls via SheetJS) et écriture (.xlsx stylé via exceljs, CSV).
 * Normalisation des dates des fichiers AMC : texte JJ.MM.AAAA, dates Excel, PERMANENT, vides (CDC V1 §5.3).
 */
@Injectable()
export class ExcelService {
  readWorkbook(buffer: Buffer): SheetData[] {
    let wb: XLSX.WorkBook;
    try {
      wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, cellFormula: false, cellHTML: false, dense: false });
    } catch {
      throw Errors.fileRejected('Classeur Excel illisible ou protégé');
    }
    return wb.SheetNames.map((name) => {
      const sheet = wb.Sheets[name];
      const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: false });
      return { name, rows: rows.map((r) => (Array.isArray(r) ? r : [])) };
    });
  }

  /** Détecte la ligne d'en-tête : première ligne avec >= minFilled cellules texte. */
  detectHeaderRow(rows: unknown[][], minFilled = 3, scan = 15): number {
    for (let i = 0; i < Math.min(rows.length, scan); i++) {
      const filled = rows[i].filter((c) => typeof c === 'string' && c.trim().length > 0).length;
      if (filled >= minFilled) return i;
    }
    return 0;
  }

  static normalizeHeader(h: unknown): string {
    return String(h ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toUpperCase();
  }

  static parseDate(value: unknown): ParsedDate {
    if (value === null || value === undefined) return { kind: 'EMPTY' };
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) return { kind: 'INVALID', raw: String(value) };
      // SheetJS crée des dates locales : on recompose la date civile en UTC
      const y = value.getFullYear();
      const m = value.getMonth() + 1;
      const d = value.getDate();
      return { kind: 'DATE', value: `${y}-${pad(m)}-${pad(d)}` };
    }
    if (typeof value === 'number') {
      if (value < 1 || value > 80_000) return { kind: 'INVALID', raw: String(value) };
      const parsed = XLSX.SSF.parse_date_code(value);
      if (!parsed) return { kind: 'INVALID', raw: String(value) };
      return { kind: 'DATE', value: `${parsed.y}-${pad(parsed.m)}-${pad(parsed.d)}` };
    }
    const s = String(value).trim();
    if (!s || s === '-' || s === '—' || /^n\/?a$/i.test(s)) return { kind: 'EMPTY' };
    const upper = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
    if (UNLIMITED_TOKENS.includes(upper)) return { kind: 'UNLIMITED' };
    let m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
    if (m) {
      const day = Number(m[1]);
      const month = Number(m[2]);
      let year = Number(m[3]);
      if (year < 100) year += year >= 70 ? 1900 : 2000;
      return validDate(year, month, day) ? { kind: 'DATE', value: `${year}-${pad(month)}-${pad(day)}` } : { kind: 'INVALID', raw: s };
    }
    m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return validDate(y, mo, d) ? { kind: 'DATE', value: `${m[1]}-${m[2]}-${m[3]}` } : { kind: 'INVALID', raw: s };
    }
    return { kind: 'INVALID', raw: s };
  }

  static cellText(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 10);
    const s = String(value).replace(/\s+/g, ' ').trim();
    return s.length ? s : null;
  }

  async writeXlsx(sheets: { name: string; columns: ExportColumn[]; rows: Record<string, unknown>[] }[]): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'AMC Platform';
    wb.created = new Date();
    for (const s of sheets) {
      const ws = wb.addWorksheet(s.name.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
      ws.columns = s.columns.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 18, style: c.numFmt ? { numFmt: c.numFmt } : {} }));
      const header = ws.getRow(1);
      header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF10243A' } };
      header.alignment = { vertical: 'middle' };
      s.rows.forEach((r) => ws.addRow(r));
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: s.columns.length } };
    }
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  /** CSV UTF-8 avec BOM et séparateur « ; » (ouverture directe dans Excel FR). */
  writeCsv(columns: ExportColumn[], rows: Record<string, unknown>[]): Buffer {
    const esc = (v: unknown) => {
      if (v === null || v === undefined) return '';
      const s = v instanceof Date ? v.toISOString() : String(v);
      // Neutralise l'injection de formules (=, +, -, @) à l'ouverture dans un tableur
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const lines = [columns.map((c) => esc(c.header)).join(';'), ...rows.map((r) => columns.map((c) => esc(r[c.key])).join(';'))];
    return Buffer.from(`﻿${lines.join('\r\n')}`, 'utf8');
  }
}

function pad(n: number) {
  return String(n).padStart(2, '0');
}

function validDate(y: number, m: number, d: number) {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}
