import { ComplianceStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { dateOnly, isoCurrency } from '../../common/pagination';
import { money, nonNegativeQty, optText, positiveQty, reqText, unitPrice } from './purchasing.dto-helpers';

/** Saisie d'un devis fournisseur (CDC §6.5) — jamais écrasé : correction = retrait + nouveau devis. */
export class RecordQuotationDto extends createZodDto(
  z.object({
    supplierId: z.string().uuid(),
    reference: optText(120),
    receivedAt: z.string().datetime({ offset: true }).transform((s) => new Date(s)).optional(),
    currency: isoCurrency,
    validUntil: dateOnly.nullable().optional(),
    leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
    incoterm: z.string().trim().toUpperCase().max(16).nullable().optional(),
    deliveryTerms: optText(500),
    paymentTerms: optText(250),
    freightAmount: money.nullable().optional(),
    taxAmount: money.nullable().optional(),
    discountAmount: money.nullable().optional(),
    comments: optText(5000),
    /** PDF original du devis (dépôt POST /files contexte PURCHASING) */
    fileId: z.string().uuid().nullable().optional(),
    lines: z
      .array(
        z.object({
          rfqLineId: z.string().uuid(),
          isAvailable: z.boolean().default(true),
          quantityOffered: nonNegativeQty.nullable().optional(),
          unit: z.string().trim().max(32).nullable().optional(),
          unitPrice: unitPrice.nullable().optional(),
          leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
          compliance: z.nativeEnum(ComplianceStatus).default('COMPLIANT'),
          remarks: optText(1000),
        }),
      )
      .min(1)
      .max(500),
  }),
) {}

export class WithdrawQuotationDto extends createZodDto(z.object({ reason: reqText(3, 1000) })) {}

/** Sélection SÉPARÉE de la saisie (CHOIX RECOMMANDÉ RETENU §6.5) : permission quotation.evaluate + justification. */
export class CreateSelectionsDto extends createZodDto(
  z.object({
    justification: reqText(3, 5000),
    selections: z.array(z.object({ quotationLineId: z.string().uuid(), quantity: positiveQty })).min(1).max(500),
  }),
) {}

export class WithdrawSelectionDto extends createZodDto(z.object({ reason: reqText(3, 1000) })) {}
