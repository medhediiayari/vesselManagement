import { z } from 'zod';

/** Pagination serveur cursor/limit (CDC §11.1) — limite max 200. */
export const PaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().uuid().optional(),
});
export type Pagination = z.infer<typeof PaginationSchema>;

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

/** Arguments Prisma pour une pagination par curseur sur `id`. */
export function cursorArgs(p: Pagination) {
  return {
    take: p.limit + 1,
    ...(p.cursor ? { cursor: { id: p.cursor }, skip: 1 } : {}),
  };
}

export function toPage<T extends { id: string }>(rows: T[], p: Pagination, total?: number): Page<T> {
  const hasMore = rows.length > p.limit;
  const items = hasMore ? rows.slice(0, p.limit) : rows;
  return { items, nextCursor: hasMore ? items[items.length - 1].id : null, total };
}

/** Tri whitelisté : jamais de champ arbitraire fourni par le client. */
export function sortSchema<T extends readonly [string, ...string[]]>(fields: T, defaultField: T[number]) {
  return z.object({
    sort: z.enum(fields).default(defaultField as never),
    order: z.enum(['asc', 'desc']).default('desc'),
  });
}

/** Booléen en query string ("true"/"false"/"1"/"0"). */
export const queryBool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true' || v === '1'));

/** Vrai si "YYYY-MM-DD" désigne un jour qui existe (rejette 30/02, mois 13…), au lieu d'un décalage silencieux. */
export function isExistingDate(s: string): boolean {
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Chaîne "YYYY-MM-DD" validée (jour existant), sans transformation — réutilisée par l'import. */
export const dateOnlyString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Format attendu AAAA-MM-JJ')
  .refine(isExistingDate, 'Date inexistante');

/** Date "YYYY-MM-DD" -> Date UTC minuit (colonnes @db.Date). */
export const dateOnly = dateOnlyString.transform((s) => new Date(`${s}T00:00:00.000Z`));

/** Décimal transmis en chaîne ou nombre — conservé en chaîne pour Prisma.Decimal (jamais float). */
export const decimalString = (opts: { min?: number; scale?: number } = {}) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim().replace(',', '.'))
    .refine((s) => /^-?\d+(\.\d+)?$/.test(s), 'Nombre décimal invalide')
    .refine((s) => opts.min === undefined || Number(s) >= opts.min, `Doit être ≥ ${opts.min}`)
    .refine(
      (s) => opts.scale === undefined || (s.split('.')[1]?.length ?? 0) <= opts.scale,
      `Au plus ${opts.scale} décimales`,
    );

/** Liste blanche ISO 4217 fournie par le runtime (audit ACH-11 : « ZZZ » était accepté). */
const ISO_CURRENCIES = new Set<string>(
  (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.('currency') ?? [],
);

export const isoCurrency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Code devise ISO 4217 attendu (ex. EUR, USD, TND)')
  .refine((c) => ISO_CURRENCIES.size === 0 || ISO_CURRENCIES.has(c), 'Devise inconnue (code ISO 4217 attendu, ex. EUR, USD, TND)');

export const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Code pays ISO 3166-1 alpha-2 attendu');
