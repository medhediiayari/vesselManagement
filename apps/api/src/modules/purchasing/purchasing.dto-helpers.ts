import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { dateOnly, decimalString } from '../../common/pagination';

/** Partie entière bornée pour tenir dans DECIMAL(18,s) (pas de dépassement => pas de 500). */
const fitsDecimal = (intDigits: number) => (s: string) => (s.replace('-', '').split('.')[0] ?? '').replace(/^0+/, '').length <= intDigits;

/** Quantité DECIMAL(18,3) strictement positive, en chaîne (jamais de float). */
export const positiveQty = decimalString({ min: 0, scale: 3 })
  .refine(fitsDecimal(12), 'Quantité trop grande')
  .refine((s) => new Prisma.Decimal(s).greaterThan(0), 'Doit être > 0');

/** Quantité DECIMAL(18,3) ≥ 0. */
export const nonNegativeQty = decimalString({ min: 0, scale: 3 }).refine(fitsDecimal(12), 'Quantité trop grande');

/** Montant DECIMAL(18,2) ≥ 0. */
export const money = decimalString({ min: 0, scale: 2 }).refine(fitsDecimal(14), 'Montant trop grand');

/** Montant DECIMAL(18,2) strictement positif (montant HT d'une facture — audit ACH-11). */
export const positiveMoney = money.refine((s) => new Prisma.Decimal(s).greaterThan(0), 'Doit être > 0');

/**
 * Date AAAA-MM-JJ non future (BL : date de livraison constatée — audit ACH-11). Tolérance d'un jour : un navire
 * à l'est de UTC peut déjà être au lendemain (même règle que la date d'une PR).
 */
export const pastOrTodayDate = dateOnly.refine((d) => {
  const now = new Date();
  return d.getTime() <= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86_400_000;
}, 'La date ne peut pas être dans le futur');

/** Prix unitaire DECIMAL(18,4) ≥ 0. */
export const unitPrice = decimalString({ min: 0, scale: 4 }).refine(fitsDecimal(12), 'Prix trop grand');

export const expectedVersion = z.number().int().min(1);

export const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

export const reqText = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Unité textuelle validée (pcs, L, bidon, m, kg…) — pas d'unité forcée (CDC §6.3). */
export const unitText = z.string().trim().min(1).max(32);

/** Horodatage ISO (avec fuseau) ou date seule AAAA-MM-JJ (=> fin de journée UTC). */
export const dateTimeOrDate = z
  .string()
  .trim()
  .refine((s) => /^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isNaN(Date.parse(s)), 'Date ou date-heure ISO attendue')
  .transform((s) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T23:59:59.000Z`) : new Date(s)));

/** Liste en query string : "A,B" ou ?x=A&x=B. */
export function csvEnum<T extends Record<string, string>>(e: T) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.nativeEnum(e)))
    .optional();
}

export const uuidList = z.array(z.string().uuid()).max(200);
