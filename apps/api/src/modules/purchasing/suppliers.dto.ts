import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, countryCode, isoCurrency, queryBool } from '../../common/pagination';
import { optText } from './purchasing.dto-helpers';

const email = z.string().trim().toLowerCase().email().max(320);

export const SupplierBaseSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9-]{2,32}$/, 'Code fournisseur : 2 à 32 caractères A-Z 0-9 -'),
  name: z.string().trim().min(2).max(200),
  legalName: optText(250),
  email: email.nullable().optional(),
  phone: optText(64),
  address: optText(500),
  country: countryCode.nullable().optional(),
  currency: isoCurrency.nullable().optional(),
  paymentTerms: optText(250),
  taxId: optText(64),
  notes: optText(5000),
});
export class CreateSupplierDto extends createZodDto(SupplierBaseSchema) {}
export class UpdateSupplierDto extends createZodDto(SupplierBaseSchema.omit({ code: true }).partial()) {}

export class SetSupplierActiveDto extends createZodDto(
  z.object({ isActive: z.boolean(), reason: z.string().trim().max(500).optional() }),
) {}

export const SupplierContactSchema = z.object({
  name: z.string().trim().min(2).max(200),
  email: email.nullable().optional(),
  phone: optText(64),
  role: optText(120),
  isPrimary: z.boolean().default(false),
});
export class CreateSupplierContactDto extends createZodDto(SupplierContactSchema) {}
export class UpdateSupplierContactDto extends createZodDto(SupplierContactSchema.partial()) {}

export const ListSuppliersSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  active: queryBool,
  country: countryCode.optional(),
  currency: isoCurrency.optional(),
});
export class ListSuppliersQuery extends createZodDto(ListSuppliersSchema) {}
