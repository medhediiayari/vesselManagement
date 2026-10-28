import { PrPriority, PrRevisionKind, PrStatus, RevisionLineAction } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly, queryBool } from '../../common/pagination';
import { csvEnum, expectedVersion, optText, positiveQty, reqText, unitText } from './purchasing.dto-helpers';

/** Ligne PR (formulaire FORM 41 : ITEM, Designation, Reference, Qty, ROB, Remarks — CDC §6.3). */
export const PrLineInputSchema = z.object({
  designation: reqText(1, 500),
  reference: optText(200),
  quantityRequested: positiveQty,
  unit: unitText,
  /** ROB : texte libre accepté si hétérogène */
  rob: optText(64),
  remarks: optText(1000),
  catalogItemId: z.string().uuid().nullable().optional(),
});

const PrHeaderSchema = z.object({
  departmentId: z.string().uuid().nullable().optional(),
  requestDate: dateOnly.optional(),
  category: reqText(2, 120),
  priority: z.nativeEnum(PrPriority).default('NORMAL'),
  neededBy: dateOnly.nullable().optional(),
  subject: reqText(2, 300),
  comment: optText(5000),
  // La référence du formulaire n'est pas saisie : elle vient du paramétrage Achats (purchasing.prFormRef)
});

export class CreatePrDto extends createZodDto(
  PrHeaderSchema.extend({
    vesselId: z.string().uuid(),
    lines: z.array(PrLineInputSchema).max(500).default([]),
  }),
) {}

export class UpdatePrDto extends createZodDto(
  PrHeaderSchema.partial().extend({ expectedVersion }),
) {}

/** Valeurs proposées au formulaire de création (référence de formulaire, prochaine escale du navire). */
export class PrFormDefaultsQuery extends createZodDto(z.object({ vesselId: z.string().uuid().optional() })) {}

/** Édition « tableur » des lignes tant que la PR est DRAFT : remplacement complet, renumérotation 1..n. */
export class ReplacePrLinesDto extends createZodDto(
  z.object({ expectedVersion, lines: z.array(PrLineInputSchema).max(500) }),
) {}

export class VersionDto extends createZodDto(z.object({ expectedVersion, comment: optText(2000) })) {}
export class ReasonDto extends createZodDto(z.object({ expectedVersion, reason: reqText(3, 500) })) {}
export class RejectDto extends createZodDto(z.object({ expectedVersion, comment: reqText(3, 2000) })) {}
export class CloseDto extends createZodDto(z.object({ expectedVersion, reason: optText(500) })) {}

export class CommentDto extends createZodDto(
  z.object({ body: reqText(1, 5000), revisionId: z.string().uuid().optional() }),
) {}

export class AttachmentDto extends createZodDto(
  z.object({ fileId: z.string().uuid(), title: optText(200) }),
) {}

/** Counter-PR (CDC §6.4, PUR-02) : actions par ligne KEEP / CHANGE / ADD / REMOVE + justification facultative. */
export const RevisionLineSchema = z.object({
  action: z.nativeEnum(RevisionLineAction),
  prLineId: z.string().uuid().optional(),
  quantity: positiveQty.optional(),
  designation: z.string().trim().max(500).optional(),
  reference: optText(200),
  unit: z.string().trim().max(32).optional(),
  remarks: optText(1000),
});

export class ProposeRevisionDto extends createZodDto(
  z.object({
    expectedVersion,
    kind: z.nativeEnum(PrRevisionKind).default('COUNTER_PR'),
    justification: optText(5000),
    lines: z.array(RevisionLineSchema).min(1).max(500),
  }),
) {}

export class RevisionDecisionDto extends createZodDto(
  z.object({
    expectedVersion,
    decision: z.enum(['ACCEPT', 'REJECT', 'REQUEST_CORRECTION']),
    comment: optText(5000),
  }),
) {}

export class WithdrawRevisionDto extends createZodDto(z.object({ expectedVersion, comment: optText(2000) })) {}

/**
 * Counter-PR appliquée directement par l'acheteur (refonte 22/10/2026) : lignes (CHANGE / ADD / REMOVE) et/ou
 * en-tête (date de besoin, priorité, objet, catégorie). Motif facultatif, demandeur notifié, avant/après conservé.
 */
export class ApplyCounterDto extends createZodDto(
  z.object({
    expectedVersion,
    /** Motif facultatif (décision AMC du 23/10/2026) */
    justification: optText(5000),
    lines: z.array(RevisionLineSchema).max(500).default([]),
    header: z
      .object({
        neededBy: dateOnly.nullable().optional(),
        priority: z.nativeEnum(PrPriority).optional(),
        subject: reqText(2, 300).optional(),
        category: reqText(2, 120).optional(),
      })
      .default({}),
  }),
) {}

/** Division en sous-PR : groupes de lignes entières (au moins deux non vides), libellé facultatif (ex. fournisseur visé). */
export class SplitPrDto extends createZodDto(
  z.object({
    expectedVersion,
    comment: optText(2000),
    groups: z
      .array(z.object({ lineIds: z.array(z.string().uuid()).max(500), label: optText(120) }))
      .min(2)
      .max(26),
  }),
) {}

export const ListPrSchema = PaginationSchema.extend({
  vesselId: z.string().uuid().optional(),
  requesterId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  category: z.string().trim().max(120).optional(),
  status: csvEnum(PrStatus),
  priority: csvEnum(PrPriority),
  /** PR non satisfaites dont la date needed_by est dépassée */
  overdue: queryBool,
  mine: queryBool,
  /** Recherche : numéro, objet ou désignation d'article */
  search: z.string().trim().max(100).optional(),
});
export class ListPrQuery extends createZodDto(ListPrSchema) {}
export type ListPrFilters = z.infer<typeof ListPrSchema>;

export class PdfQuery extends createZodDto(z.object({ download: queryBool })) {}
