import { DeliveryNoteStatus, ItemCondition, ReceiptStatus, VarianceStatus, VarianceType } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly, isoCurrency } from '../../common/pagination';
import { csvEnum, nonNegativeQty, optText, positiveQty, reqText, unitPrice, unitText, uuidList } from './purchasing.dto-helpers';

/** BL — ce que le fournisseur DÉCLARE livrer (jamais une preuve de réception physique, CDC §6.7). */
export class CreateDeliveryNoteDto extends createZodDto(
  z.object({
    poId: z.string().uuid(),
    number: reqText(1, 80),
    deliveryDate: dateOnly,
    /** Scan du BL (dépôt POST /files contexte PURCHASING) */
    fileId: z.string().uuid().nullable().optional(),
    notes: optText(5000),
    lines: z
      .array(z.object({ poLineId: z.string().uuid(), quantityOnNote: nonNegativeQty, unit: z.string().trim().min(1).max(32).optional() }))
      .min(1)
      .max(500),
  }),
) {}

/**
 * BL saisi à bord en réponse à un BC (refonte 22/10/2026) : BL et réception en une seule étape.
 *  - `allReceived` : tout le reste à recevoir du BC est déclaré reçu (réponse « conforme » après un fichier joint) ;
 *  - sinon `lines` : quantités reçues par ligne de BC (0 / absente = non reçue) + remarque ;
 *  - `extraItems` : articles reçus qui ne figurent pas sur le BC (information, sans alerte ni blocage) ;
 *  - `fileIds` : BL scanné / Excel / photos (dépôt POST /files, contexte PURCHASING).
 * En-tête Idempotency-Key obligatoire (pas de double comptage en cas de renvoi).
 */
export class OnboardDeliveryDto extends createZodDto(
  z.object({
    poId: z.string().uuid(),
    /** N° du BL fournisseur ; à défaut, une référence plateforme est attribuée */
    number: optText(80),
    deliveryDate: dateOnly.optional(),
    allReceived: z.boolean().default(false),
    lines: z.array(z.object({ poLineId: z.string().uuid(), quantity: nonNegativeQty, remarks: optText(1000) })).max(500).default([]),
    extraItems: z
      .array(z.object({ designation: reqText(1, 500), reference: optText(200), quantity: positiveQty, unit: unitText, remarks: optText(1000) }))
      .max(100)
      .default([]),
    fileIds: uuidList.max(10).default([]),
    notes: optText(5000),
  }),
) {}

/** Décision sur un écart de réception : attendre le reliquat (le BC reste ouvert pour un prochain BL). */
export class AwaitRemainderDto extends createZodDto(z.object({ comment: optText(2000) })) {}

/**
 * Correction fournisseur par BC complémentaire : reliquats de plusieurs lignes reportés sur UN nouveau BC
 * (même fournisseur ou un autre), lignes PR d'origine conservées ; `issueNow` émet le BC immédiatement.
 */
export class ComplementaryForOrderDto extends createZodDto(
  z.object({
    reason: reqText(3, 500),
    originalOrderVersion: z.number().int().min(1),
    supplierId: z.string().uuid().optional(),
    currency: isoCurrency.optional(),
    expectedDeliveryDate: dateOnly.nullable().optional(),
    deliveryPort: optText(120),
    deliveryTerms: optText(500),
    notes: optText(5000),
    issueNow: z.boolean().default(true),
    lines: z
      .array(z.object({ poLineId: z.string().uuid(), quantity: positiveQty.optional(), unitPrice: unitPrice.optional() }))
      .min(1)
      .max(200),
  }),
) {}

export class CancelDeliveryNoteDto extends createZodDto(z.object({ reason: reqText(3, 500) })) {}

/** Réception physique à bord (PUR-04/05) : reçu = accepté + rejeté ; en-tête Idempotency-Key obligatoire. */
export class CreateReceiptDto extends createZodDto(
  z.object({
    poId: z.string().uuid(),
    deliveryNoteId: z.string().uuid().nullable().optional(),
    receivedAt: z
      .string()
      .datetime({ offset: true })
      .transform((s) => new Date(s))
      .optional(),
    responsibleName: optText(200),
    notes: optText(5000),
    /** Preuves (photos, PV) déposées en contexte PURCHASING */
    evidenceFileIds: uuidList.max(20).default([]),
    lines: z
      .array(
        z.object({
          poLineId: z.string().uuid(),
          deliveryNoteLineId: z.string().uuid().nullable().optional(),
          qtyReceived: nonNegativeQty,
          qtyAccepted: nonNegativeQty,
          qtyRejected: nonNegativeQty.default('0'),
          condition: z.nativeEnum(ItemCondition).default('GOOD'),
          remarks: optText(1000),
        }),
      )
      .min(1)
      .max(500),
  }),
) {}

export class ValidateReceiptDto extends createZodDto(z.object({ comment: optText(2000) })) {}

export const ListDeliveryNotesSchema = PaginationSchema.extend({
  poId: z.string().uuid().optional(),
  vesselId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  status: csvEnum(DeliveryNoteStatus),
  search: z.string().trim().max(80).optional(),
});
export class ListDeliveryNotesQuery extends createZodDto(ListDeliveryNotesSchema) {}

export const ListReceiptsSchema = PaginationSchema.extend({
  poId: z.string().uuid().optional(),
  vesselId: z.string().uuid().optional(),
  status: csvEnum(ReceiptStatus),
});
export class ListReceiptsQuery extends createZodDto(ListReceiptsSchema) {}

export const ListVariancesSchema = PaginationSchema.extend({
  poId: z.string().uuid().optional(),
  vesselId: z.string().uuid().optional(),
  status: csvEnum(VarianceStatus),
  type: csvEnum(VarianceType),
  assignedToId: z.string().uuid().optional(),
});
export class ListVariancesQuery extends createZodDto(ListVariancesSchema) {}

export class AssignVarianceDto extends createZodDto(z.object({ assignedToId: z.string().uuid(), comment: optText(2000) })) {}
export class ResolveVarianceDto extends createZodDto(z.object({ resolution: reqText(3, 5000) })) {}
export class VarianceCommentDto extends createZodDto(z.object({ comment: optText(2000) })) {}

/** BC complémentaire pour le reliquat d'une ligne (lien conservé avec les lignes PR d'origine, V1 §8.4). */
export class ComplementaryOrderDto extends createZodDto(
  z.object({
    reason: reqText(3, 500),
    supplierId: z.string().uuid().optional(),
    currency: isoCurrency.optional(),
    unitPrice,
    quantity: positiveQty.optional(),
    expectedDeliveryDate: dateOnly.nullable().optional(),
    deliveryPort: optText(120),
    deliveryTerms: optText(500),
    notes: optText(5000),
    /** Version du BC d'origine (avenant d'annulation du reliquat) */
    originalOrderVersion: z.number().int().min(1),
  }),
) {}
