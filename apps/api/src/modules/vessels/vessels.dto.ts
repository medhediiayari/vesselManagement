import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, countryCode, decimalString } from '../../common/pagination';

/** Numéro OMI : 7 chiffres, le dernier est une clé de contrôle (somme pondérée 7..2 mod 10). */
export function isValidImo(imo: string): boolean {
  if (!/^\d{7}$/.test(imo)) return false;
  const digits = imo.split('').map(Number);
  const sum = digits.slice(0, 6).reduce((acc, d, i) => acc + d * (7 - i), 0);
  return sum % 10 === digits[6];
}

const imo = z
  .string()
  .trim()
  .transform((s) => s.replace(/^IMO\s*/i, ''))
  .refine(isValidImo, 'Numéro OMI invalide (7 chiffres avec clé de contrôle)');

const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const VesselBaseSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,16}$/, 'Code navire : 2 à 16 caractères A-Z 0-9 -'),
  name: z.string().trim().min(2).max(120),
  imoNumber: imo.nullable().optional(),
  mmsi: z.string().trim().regex(/^\d{9}$/, 'MMSI : 9 chiffres').nullable().optional(),
  callSign: optionalText(16),
  flag: countryCode.nullable().optional(),
  portOfRegistry: optionalText(120),
  vesselType: optionalText(80),
  managerName: optionalText(200),
  ownerName: optionalText(200),
  classSociety: optionalText(120),
  yearBuilt: z.number().int().min(1900).max(2100).nullable().optional(),
  builder: optionalText(200),
  grossTonnage: decimalString({ min: 0, scale: 2 }).nullable().optional(),
  netTonnage: decimalString({ min: 0, scale: 2 }).nullable().optional(),
  deadweight: decimalString({ min: 0, scale: 2 }).nullable().optional(),
  lengthOverall: decimalString({ min: 0, scale: 2 }).nullable().optional(),
  beam: decimalString({ min: 0, scale: 2 }).nullable().optional(),
  summerDraft: decimalString({ min: 0, scale: 2 }).nullable().optional(),
  timezone: z.string().trim().max(64).optional(),
  contactEmail: z.string().trim().toLowerCase().email().nullable().optional(),
  contactPhone: optionalText(64),
  notes: optionalText(5000),
});
export class CreateVesselDto extends createZodDto(VesselBaseSchema) {}
export class UpdateVesselDto extends createZodDto(VesselBaseSchema.partial()) {}

export class SetVesselStatusDto extends createZodDto(
  z.object({ status: z.enum(['ACTIVE', 'INACTIVE', 'LAID_UP', 'SOLD']), reason: z.string().trim().max(500).optional() }),
) {}

export class SetPhotoDto extends createZodDto(z.object({ fileId: z.string().uuid().nullable() })) {}

export class AddVesselAttachmentDto extends createZodDto(
  z.object({
    fileId: z.string().uuid(),
    category: z.string().trim().min(2).max(60),
    title: z.string().trim().min(2).max(200),
  }),
) {}

export const ListVesselsSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'LAID_UP', 'SOLD']).optional(),
});
export class ListVesselsQuery extends createZodDto(ListVesselsSchema) {}
