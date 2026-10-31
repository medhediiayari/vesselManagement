import { CharterPartyType, CpStatus, CpVersionKind } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly } from '../../common/pagination';
import { optionalText } from './voyages.dto';
import { normalizeCpReference } from './voyages.logic';

/** Date de signature : jamais dans le futur (tolérance d'un jour pour les fuseaux, audit FLT-16). */
const cpDate = dateOnly.refine((d) => d.getTime() <= Date.now() + 86_400_000, 'Date de la Charter Party dans le futur');

/**
 * Champs contractuels (CDC §7.2) : texte contrôlé stocké UNIQUEMENT lorsqu'il est fourni
 * explicitement ; aucun paramètre financier n'est déduit ni calculé (pas de laytime automatique).
 */
const CpContractSchema = z.object({
  cpType: z.nativeEnum(CharterPartyType),
  cpDate: cpDate.nullable().optional(),
  charterer: optionalText(200),
  owner: optionalText(200),
  broker: optionalText(200),
  signatories: optionalText(500),
  laycanFrom: dateOnly.nullable().optional(),
  laycanTo: dateOnly.nullable().optional(),
  loadPorts: optionalText(500),
  dischargePorts: optionalText(500),
  cargoDescription: optionalText(10_000),
  norClause: optionalText(20_000),
  laytimeClause: optionalText(20_000),
  freightTerms: optionalText(20_000),
  demurrageTerms: optionalText(20_000),
  otherClauses: optionalText(50_000),
});

const laycanOrder = (v: { laycanFrom?: Date | null; laycanTo?: Date | null }) => !v.laycanFrom || !v.laycanTo || v.laycanFrom <= v.laycanTo;
const laycanMessage = { message: 'Laycan : la date de début doit précéder la date de fin', path: ['laycanTo'] };

const reference = z.string().trim().min(2).max(80).transform(normalizeCpReference);

export const CreateCharterPartySchema = CpContractSchema.extend({
  reference,
  vesselId: z.string().uuid().nullable().optional(),
}).refine(laycanOrder, laycanMessage);
export class CreateCharterPartyDto extends createZodDto(CreateCharterPartySchema) {}

/** Modification directe : uniquement tant qu'aucune version n'a été approuvée (brouillon). */
export const UpdateCharterPartySchema = CpContractSchema.partial()
  .extend({ reference: reference.optional(), vesselId: z.string().uuid().nullable().optional() })
  .refine(laycanOrder, laycanMessage);
export class UpdateCharterPartyDto extends createZodDto(UpdateCharterPartySchema) {}

export const CpChangesSchema = CpContractSchema.partial().refine(laycanOrder, laycanMessage);

export class SubmitCpVersionDto extends createZodDto(
  z.object({
    kind: z.nativeEnum(CpVersionKind),
    /** PDF du contrat / avenant (contexte CHARTER_PARTY) déposé via POST /files */
    fileId: z.string().uuid().optional(),
    summary: optionalText(2000),
    /** Clauses modifiées par cette version (seules les clés présentes sont modifiées) */
    changes: CpChangesSchema.optional(),
  }),
) {}

export class ApproveCpVersionDto extends createZodDto(z.object({ comment: z.string().trim().max(2000).optional() })) {}
export class RejectCpVersionDto extends createZodDto(
  z.object({ comment: z.string().trim().min(3, 'Commentaire requis').max(2000) }),
) {}
export class CancelCharterPartyDto extends createZodDto(z.object({ reason: z.string().trim().min(3, 'Motif requis').max(2000) })) {}

export const ListCharterPartiesSchema = PaginationSchema.extend({
  vesselId: z.string().uuid().optional(),
  voyageId: z.string().uuid().optional(),
  status: z.nativeEnum(CpStatus).optional(),
  search: z.string().trim().max(100).optional(),
});
export class ListCharterPartiesQuery extends createZodDto(ListCharterPartiesSchema) {}
