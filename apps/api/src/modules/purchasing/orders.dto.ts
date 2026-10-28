import { PoStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly, isoCurrency, queryBool } from '../../common/pagination';
import { csvEnum, expectedVersion, money, optText, positiveQty, reqText, unitPrice, unitText } from './purchasing.dto-helpers';

/** Allocation explicite ligne BC -> ligne PR (liens n:m, CDC §6.6), quantité exprimée dans l'unité de la ligne PR. */
export const AllocationSchema = z.object({ prLineId: z.string().uuid(), quantity: positiveQty });

/**
 * Ligne de BC : soit issue d'une ligne de devis SÉLECTIONNÉE (quotationLineId — désignation, unité, prix et
 * allocation par défaut repris de la RFQ / du devis), soit saisie manuellement depuis des lignes PR (allocations obligatoires).
 */
export const PoLineInputSchema = z.object({
  quotationLineId: z.string().uuid().optional(),
  designation: z.string().trim().min(1).max(500).optional(),
  reference: optText(200),
  unit: unitText.optional(),
  quantity: positiveQty,
  unitPrice: unitPrice.optional(),
  remarks: optText(1000),
  allocations: z.array(AllocationSchema).max(50).optional(),
});
export type PoLineInput = z.infer<typeof PoLineInputSchema>;

const OrderBodySchema = z.object({
  supplierId: z.string().uuid(),
  currency: isoCurrency.optional(),
  quotationId: z.string().uuid().optional(),
  expectedDeliveryDate: dateOnly.nullable().optional(),
  deliveryPort: optText(120),
  deliveryTerms: optText(500),
  paymentTerms: optText(250),
  notes: optText(5000),
  taxAmount: money.optional(),
  freightAmount: money.optional(),
  /** Motif obligatoire si purchasing.allowOverAllocation autorise un dépassement de la quantité approuvée */
  overAllocationReason: optText(500),
  lines: z.array(PoLineInputSchema).min(1).max(500),
});
export type OrderBody = z.infer<typeof OrderBodySchema>;

/** Création ; `issueNow` = « Créer et émettre » (BC émis au demandeur en un clic, sauf second regard requis). */
export class CreateOrderDto extends createZodDto(OrderBodySchema.extend({ issueNow: z.boolean().optional() })) {}
export class ReplaceOrderDto extends createZodDto(OrderBodySchema.extend({ expectedVersion })) {}

export class OrderVersionDto extends createZodDto(z.object({ expectedVersion, comment: optText(2000) })) {}
export class OrderRejectDto extends createZodDto(z.object({ expectedVersion, comment: reqText(3, 2000) })) {}
export class OrderReasonDto extends createZodDto(z.object({ expectedVersion, reason: reqText(3, 500) })) {}
export class OrderCloseDto extends createZodDto(z.object({ expectedVersion, reason: optText(500) })) {}

/** Transmission constatée hors plateforme (canal MANUAL), attribuée et auditée — jamais présumée. */
export class MarkOrderSentDto extends createZodDto(
  z.object({
    expectedVersion,
    channel: z.literal('MANUAL').default('MANUAL'),
    recipient: reqText(2, 300),
    note: optText(1000),
  }),
) {}

export const ReviseLineSchema = z.object({
  poLineId: z.string().uuid(),
  /** Nouvelle quantité contractuelle (≥ quantité déjà acceptée) */
  quantityOrdered: positiveQty.optional(),
  unitPrice: unitPrice.optional(),
  /** Annule le reliquat non accepté de la ligne */
  cancelRemaining: z.boolean().optional(),
  remarks: optText(1000),
  /** Remplace les allocations PR de la ligne */
  allocations: z.array(AllocationSchema).max(50).optional(),
});
export type ReviseLineInput = z.infer<typeof ReviseLineSchema>;

/** Avenant / révision de BC envoyé (CDC §6.6) : snapshot des quantités contractuelles précédentes + nouveau PDF. */
export class ReviseOrderDto extends createZodDto(
  z
    .object({
      expectedVersion,
      reason: reqText(3, 500),
      taxAmount: money.optional(),
      freightAmount: money.optional(),
      expectedDeliveryDate: dateOnly.nullable().optional(),
      lines: z.array(ReviseLineSchema).max(500).default([]),
      addLines: z.array(PoLineInputSchema).max(200).default([]),
      overAllocationReason: optText(500),
    })
    .refine(
      (v) => v.lines.length || v.addLines.length || v.taxAmount !== undefined || v.freightAmount !== undefined || v.expectedDeliveryDate !== undefined,
      'La révision ne contient aucune modification',
    ),
) {}
export type ReviseOrderInput = z.infer<typeof ReviseOrderDto.schema>;

export const ListOrdersSchema = PaginationSchema.extend({
  vesselId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  status: csvEnum(PoStatus),
  prId: z.string().uuid().optional(),
  /** BC envoyés / partiellement reçus dont la date de livraison attendue est dépassée */
  overdue: queryBool,
  /** BC avec un écart de réception à décider (écart OUVERT) */
  discrepancy: queryBool,
  search: z.string().trim().max(100).optional(),
});
export class ListOrdersQuery extends createZodDto(ListOrdersSchema) {}
export type ListOrdersFilters = z.infer<typeof ListOrdersSchema>;
