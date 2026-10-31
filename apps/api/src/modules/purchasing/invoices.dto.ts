import { InvoiceStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly, isoCurrency } from '../../common/pagination';
import { csvEnum, money, optText, positiveMoney, reqText } from './purchasing.dto-helpers';

/** Facture fournisseur (CDC §6.7) : fichier original, montants, devise, BC liés — paiement / comptabilité hors V1. */
export class CreateInvoiceDto extends createZodDto(
  z
    .object({
      supplierId: z.string().uuid(),
      number: reqText(1, 80),
      invoiceDate: dateOnly,
      dueDate: dateOnly.nullable().optional(),
      currency: isoCurrency,
      /** Montant hors taxes (> 0 — audit ACH-11) */
      amount: positiveMoney,
      taxAmount: money.default('0'),
      fileId: z.string().uuid().nullable().optional(),
      reviewNotes: optText(5000),
      /** BC liés ; montant imputé obligatoire si plusieurs BC (somme = montant TTC) */
      orders: z
        .array(z.object({ poId: z.string().uuid(), amount: money.optional() }))
        .min(1)
        .max(50),
    })
    .refine((v) => !v.dueDate || v.dueDate.getTime() >= v.invoiceDate.getTime(), {
      message: 'L’échéance ne peut pas précéder la date de la facture',
      path: ['dueDate'],
    }),
) {}

export class InvoiceStatusDto extends createZodDto(
  z.object({
    status: z.enum(['UNDER_REVIEW', 'MATCHED', 'DISPUTED', 'APPROVED', 'CANCELLED']),
    notes: optText(5000),
  }),
) {}

export const ListInvoicesSchema = PaginationSchema.extend({
  supplierId: z.string().uuid().optional(),
  vesselId: z.string().uuid().optional(),
  poId: z.string().uuid().optional(),
  status: csvEnum(InvoiceStatus),
  search: z.string().trim().max(80).optional(),
});
export class ListInvoicesQuery extends createZodDto(ListInvoicesSchema) {}
