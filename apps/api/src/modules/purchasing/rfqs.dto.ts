import { RfqStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly } from '../../common/pagination';
import { csvEnum, dateTimeOrDate, optText, positiveQty, reqText, uuidList } from './purchasing.dto-helpers';

export class CreateRfqDto extends createZodDto(
  z.object({
    title: reqText(2, 300),
    /** Lignes PR à consulter (une ou plusieurs PR compatibles d'un même navire) ; quantité par défaut = reste à commander */
    lines: z
      .array(z.object({ prLineId: z.string().uuid(), quantity: positiveQty.optional(), remarks: optText(1000) }))
      .min(1)
      .max(500),
    supplierIds: uuidList.default([]),
    deadline: dateTimeOrDate.nullable().optional(),
    deliveryPort: optText(120),
    deliveryTerms: optText(500),
    notes: optText(5000),
  }),
) {}

export class UpdateRfqDto extends createZodDto(
  z.object({
    title: reqText(2, 300).optional(),
    deadline: dateTimeOrDate.nullable().optional(),
    deliveryPort: optText(120),
    deliveryTerms: optText(500),
    notes: optText(5000),
  }),
) {}

export class AddRfqSuppliersDto extends createZodDto(z.object({ supplierIds: uuidList.min(1) })) {}

/** Envoi constaté hors plateforme (téléphone, e-mail personnel, remise en main propre) : canal MANUAL déclaré. */
export class MarkRfqSentDto extends createZodDto(
  z.object({
    channel: z.literal('MANUAL').default('MANUAL'),
    recipient: reqText(2, 300),
    note: optText(1000),
  }),
) {}

export class RfqReasonDto extends createZodDto(z.object({ reason: reqText(3, 500) })) {}
export class RfqCommentDto extends createZodDto(z.object({ comment: optText(1000) })) {}

export const ListRfqSchema = PaginationSchema.extend({
  vesselId: z.string().uuid().optional(),
  status: csvEnum(RfqStatus),
  prId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  search: z.string().trim().max(100).optional(),
  /** Période de création (dates civiles incluses) */
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export class ListRfqQuery extends createZodDto(ListRfqSchema) {}

/** Compteurs des RFQ du périmètre (tuiles de la liste). */
export class RfqStatsQuery extends createZodDto(z.object({ vesselId: z.string().uuid().optional() })) {}
