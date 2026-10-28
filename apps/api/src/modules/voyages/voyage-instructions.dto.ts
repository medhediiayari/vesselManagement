import { InstructionStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema } from '../../common/pagination';
import { optionalText } from './voyages.dto';

/**
 * Champs structurés d'une instruction (notices, compliance checks, checklist Master, NOR/laytime
 * en texte…) : dictionnaire borné de valeurs simples ou de listes de libellés.
 */
const FieldValue = z.union([
  z.string().trim().max(5000),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.string().trim().min(1).max(500)).max(200),
]);
export const InstructionFieldsSchema = z
  .record(z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/, 'Clé de champ invalide'), FieldValue)
  .refine((o) => Object.keys(o).length <= 100, 'Au plus 100 champs structurés');

export class CreateInstructionDto extends createZodDto(
  z.object({
    voyageId: z.string().uuid(),
    title: z.string().trim().min(3).max(300),
    fields: InstructionFieldsSchema.optional(),
    notices: optionalText(20_000),
    /** PDF / document source (contexte VOYAGE) déposé via POST /files */
    fileId: z.string().uuid().optional(),
  }),
) {}

export class UpdateInstructionDto extends createZodDto(
  z.object({
    title: z.string().trim().min(3).max(300).optional(),
    fields: InstructionFieldsSchema.nullable().optional(),
    notices: optionalText(20_000),
    fileId: z.string().uuid().optional(),
  }),
) {}

export class IssueInstructionDto extends createZodDto(
  z.object({
    /** Générer un PDF depuis les champs structurés si aucun document source n'est joint */
    generatePdf: z.boolean().default(false),
    /** Créer les tâches de checklist depuis fields.masterChecklist (sans doublon de titre) */
    createChecklistTasks: z.boolean().default(false),
    comment: z.string().trim().max(2000).optional(),
  }),
) {}

export const ListInstructionsSchema = PaginationSchema.extend({
  voyageId: z.string().uuid().optional(),
  vesselId: z.string().uuid().optional(),
  status: z.nativeEnum(InstructionStatus).optional(),
});
export class ListInstructionsQuery extends createZodDto(ListInstructionsSchema) {}
