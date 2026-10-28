import { ConsumptionBasis, LoadingCondition, NoonReportType, NoonStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly } from '../../common/pagination';
import { NOON_NUMERIC_RULES, NoonDecimalField, checkDecimal, checkUtcOffset } from './noon.logic';

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const isoDateTime = z
  .string()
  .datetime({ offset: true, message: 'Date/heure ISO 8601 avec fuseau attendue (ex. 2026-02-10T11:00:00Z)' })
  .transform((s) => new Date(s));

const expectedVersion = z.number({ required_error: 'expectedVersion requis (verrou optimiste)' }).int().min(1);

/** Décimal transmis en chaîne / nombre, contrôlé par les règles de plage (jamais float en base). */
const noonDecimal = (field: NoonDecimalField) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => String(v).trim().replace(',', '.'))
    .superRefine((s, ctx) => {
      const err = checkDecimal(s, NOON_NUMERIC_RULES[field]);
      if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
    })
    .nullable()
    .optional();

const utcOffset = z
  .number()
  .int()
  .superRefine((v, ctx) => {
    const err = checkUtcOffset(v);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, message: err });
  });

/** Les 7 sections du formulaire AMC (CDC §8.2). */
const NoonSectionsSchema = z.object({
  // 1. General Information
  reportType: z.nativeEnum(NoonReportType),
  reportDateUtc: isoDateTime,
  utcOffsetMinutes: utcOffset,
  reference: optionalText(80),
  masterName: optionalText(200),
  // 2. Position & Weather
  latitude: noonDecimal('latitude'),
  longitude: noonDecimal('longitude'),
  windDirection: optionalText(16),
  windForceBeaufort: z.number().int().min(0, 'Beaufort 0 à 12').max(12, 'Beaufort 0 à 12').nullable().optional(),
  windSpeedKnots: noonDecimal('windSpeedKnots'),
  weatherConditions: optionalText(200),
  seaState: optionalText(60),
  swellDirection: optionalText(16),
  swellHeightM: noonDecimal('swellHeightM'),
  visibility: optionalText(60),
  // 3. Navigation & Course
  courseDeg: noonDecimal('courseDeg'),
  speedKnots: noonDecimal('speedKnots'),
  distanceSinceLastNm: noonDecimal('distanceSinceLastNm'),
  distanceRemainingNm: noonDecimal('distanceRemainingNm'),
  nextPort: optionalText(120),
  etaNextPort: isoDateTime.nullable().optional(),
  // 4. Engine & Fuel — base explicite : jamais de cumul aveugle (CDC §8.3)
  consumptionBasis: z.nativeEnum(ConsumptionBasis),
  meRpm: noonDecimal('meRpm'),
  foConsumptionMt: noonDecimal('foConsumptionMt'),
  doConsumptionMt: noonDecimal('doConsumptionMt'),
  lubeOilConsumptionL: noonDecimal('lubeOilConsumptionL'),
  runningHours: noonDecimal('runningHours'),
  foRobMt: noonDecimal('foRobMt'),
  doRobMt: noonDecimal('doRobMt'),
  loRobL: noonDecimal('loRobL'),
  // 5. Ballast & Cargo
  ballastWaterM3: noonDecimal('ballastWaterM3'),
  loadingCondition: z.nativeEnum(LoadingCondition).nullable().optional(),
  cargoType: optionalText(200),
  cargoQuantityMt: noonDecimal('cargoQuantityMt'),
  // 6. Incidents & Remarks
  incidents: optionalText(10_000),
  remarks: optionalText(10_000),
  // 7. Maintenance & Observations
  maintenanceDone: optionalText(10_000),
  maintenancePlanned: optionalText(10_000),
  deviations: optionalText(10_000),
  additionalNotes: optionalText(10_000),
});

/** Création d'un brouillon : navire + voyage, type, date UTC, décalage local et base de consommation explicites. */
export const CreateNoonReportSchema = NoonSectionsSchema.partial()
  .required({ reportType: true, reportDateUtc: true, utcOffsetMinutes: true, consumptionBasis: true })
  .extend({
    voyageId: z.string().uuid(),
    /** Facultatif : contrôlé contre le navire du voyage */
    vesselId: z.string().uuid().optional(),
  });
export class CreateNoonReportDto extends createZodDto(CreateNoonReportSchema) {}

export const NoonChangesSchema = NoonSectionsSchema.partial();
export type NoonChanges = z.infer<typeof NoonChangesSchema>;

/** Autosave (DRAFT / CORRECTION_REQUESTED) avec verrou optimiste. */
export class UpdateNoonReportDto extends createZodDto(NoonChangesSchema.extend({ expectedVersion })) {}

export class SubmitNoonReportDto extends createZodDto(z.object({ expectedVersion })) {}

export class AcknowledgeNoonReportDto extends createZodDto(
  z.object({
    expectedVersion: expectedVersion.optional(),
    /** Accusé de lecture notifié à l'auteur (option, CDC §8.3) */
    readReceipt: z.boolean().default(false),
    comment: z.string().trim().max(2000).optional(),
  }),
) {}

export class RequestCorrectionDto extends createZodDto(
  z.object({ comment: z.string().trim().min(3, 'Commentaire requis').max(2000), expectedVersion: expectedVersion.optional() }),
) {}

/** Correction tracée : nouvelle révision, l'originale reste intacte. */
export class CorrectNoonReportDto extends createZodDto(
  z.object({
    expectedVersion,
    reason: z.string().trim().min(3, 'Motif de correction requis').max(1000),
    changes: NoonChangesSchema.optional(),
  }),
) {}

export class ArchiveNoonReportDto extends createZodDto(
  z.object({ expectedVersion: expectedVersion.optional(), reason: z.string().trim().max(1000).optional() }),
) {}

export class AddNoonAttachmentDto extends createZodDto(z.object({ fileId: z.string().uuid() })) {}

export const ListNoonReportsSchema = PaginationSchema.extend({
  vesselId: z.string().uuid().optional(),
  voyageId: z.string().uuid().optional(),
  status: z.nativeEnum(NoonStatus).optional(),
  reportType: z.nativeEnum(NoonReportType).optional(),
  /** Bornes sur la date UTC du rapport (AAAA-MM-JJ, incluses) */
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export class ListNoonReportsQuery extends createZodDto(ListNoonReportsSchema) {}

export const NoonPdfQuerySchema = z.object({
  revision: z.coerce.number().int().min(1).optional(),
  mode: z.enum(['preview', 'download']).default('download'),
});
