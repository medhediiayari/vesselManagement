import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnlyString } from '../../common/pagination';

const uuid = z.string().uuid();

export class CreateImportJobDto extends createZodDto(
  z.object({
    /** Fichier déposé via POST /files (context IMPORT_SOURCE, .xlsx / .xls / .csv) */
    sourceFileId: uuid,
    /** Navire par défaut des dates d'embarquement importées (facultatif) */
    vesselId: uuid.optional(),
  }),
) {}

export const SheetMappingSchema = z.object({
  name: z.string().min(1).max(120),
  include: z.boolean().default(true),
  /** Ligne d'en-tête (1 = première ligne non vide de la feuille) */
  headerRow: z.number().int().min(1).max(1000),
  /** 2 => en-têtes sur deux lignes (ex. « GMDSS » fusionné au-dessus de « N° » / « EXP ») */
  headerRowCount: z.union([z.literal(1), z.literal(2)]).default(1),
  /** { en-tête ou lettre de colonne -> champ Member | certificate:<CODE>[:number|expiry|issued] | fullName | joinDate | signOffDate | vessel | ignore } */
  mapping: z.record(z.string().min(1).max(200), z.string().trim().max(80)),
  defaults: z
    .object({
      rank: z.string().trim().min(1).max(120).optional(),
      crewDepartment: z.enum(['DECK', 'ENGINE', 'CATERING', 'OTHER']).optional(),
      vesselId: uuid.optional(),
    })
    .optional(),
});
export type SheetMapping = z.infer<typeof SheetMappingSchema>;

export class SetImportMappingDto extends createZodDto(
  z.object({
    sheets: z.array(SheetMappingSchema).min(1).max(50),
    /** Crée l'historique d'affectations depuis les dates EMBARQUEMENT / DEBARQUEMENT (vessel_crew.assign requis) */
    createAssignments: z.boolean().default(false),
    defaultVesselId: uuid.optional(),
  }),
) {}

// Jour existant exigé (30/02 refusé) : la chaîne est conservée telle quelle (audit FLT-03)
const dateOrNull = dateOnlyString.nullable().optional();
const textOrNull = (max: number) => z.string().trim().max(max).nullable().optional();
const isoOrNull = z.string().trim().regex(/^[A-Za-z]{2}$/, 'Code pays ISO à 2 lettres').nullable().optional();

/** Corrections opérateur (décision CORRECT) : valeur normalisée ; null retire la valeur importée. */
export const CorrectionsSchema = z
  .object({
    amcRef: textOrNull(32),
    lastName: textOrNull(120),
    firstName: textOrNull(120),
    birthDate: dateOrNull,
    birthPlace: textOrNull(120),
    nationality: isoOrNull,
    gender: z.enum(['M', 'F', 'X']).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    phone: textOrNull(64),
    address: textOrNull(500),
    emergencyContactName: textOrNull(200),
    emergencyContactPhone: textOrNull(64),
    passportNumber: textOrNull(32),
    passportCountry: isoOrNull,
    passportExpiry: dateOrNull,
    seamanBookNumber: textOrNull(32),
    seamanBookExpiry: dateOrNull,
    rank: textOrNull(120),
    crewDepartment: z.enum(['DECK', 'ENGINE', 'CATERING', 'OTHER']).nullable().optional(),
    notes: textOrNull(5000),
  })
  .strict()
  .refine((c) => Object.values(c).some((v) => v !== undefined), 'Au moins une correction');

export class RowDecisionDto extends createZodDto(
  z
    .object({
      decision: z.enum(['CREATE', 'UPDATE', 'IGNORE', 'CORRECT']),
      targetMemberId: uuid.optional(),
      /** Motif (obligatoire pour créer malgré un doublon potentiel) */
      reason: z.string().trim().min(3).max(500).optional(),
      corrections: CorrectionsSchema.optional(),
    })
    .refine((d) => d.decision !== 'UPDATE' || !!d.targetMemberId, { message: 'targetMemberId requis pour UPDATE', path: ['targetMemberId'] })
    .refine((d) => d.decision !== 'CORRECT' || !!d.corrections, { message: 'corrections requises pour CORRECT', path: ['corrections'] }),
) {}

export class ListImportRowsQuery extends createZodDto(
  PaginationSchema.extend({
    status: z.enum(['PENDING', 'VALID', 'INVALID', 'DUPLICATE_SUSPECTED', 'APPLIED', 'SKIPPED', 'FAILED']).optional(),
    decision: z.enum(['PENDING', 'CREATE', 'UPDATE', 'IGNORE', 'CORRECT']).optional(),
    sheet: z.string().max(120).optional(),
  }),
) {}

export class ListImportJobsQuery extends createZodDto(PaginationSchema) {}

export class CancelImportDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}
