import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

const dateFmt = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

/** Dates civiles (@db.Date) : affichées en UTC pour éviter tout décalage d'un jour. */
export function fmtDate(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? '—' : dateFmt.format(d);
}

/** Horodatages : heure locale du navigateur. */
export function fmtDateTime(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  return Number.isNaN(d.getTime()) ? '—' : dateTimeFmt.format(d);
}

export function fmtRelative(v: string | Date | null | undefined): string {
  if (!v) return '—';
  const d = typeof v === 'string' ? new Date(v) : v;
  const diff = (d.getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' });
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 45) return rtf.format(Math.round(diff / 86400), 'day');
  return fmtDate(d);
}

/** Jours entre aujourd'hui (UTC) et une date civile. Négatif = passé. */
export function daysUntil(v: string | Date | null | undefined): number | null {
  if (!v) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  const today = new Date();
  const t0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((d.getTime() - t0) / 86_400_000);
}

/** Décimaux transmis en chaîne par l'API (jamais de float pour montants/quantités). */
export function fmtDecimal(v: string | number | null | undefined, maxFraction = 3): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return new Intl.NumberFormat('fr-FR', { maximumFractionDigits: maxFraction }).format(n);
}

export function fmtMoney(v: string | number | null | undefined, currency?: string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  if (!currency) return fmtDecimal(n, 2);
  try {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(n);
  } catch {
    return `${fmtDecimal(n, 2)} ${currency}`;
  }
}

export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('');
}
