import { PortCallType, VoyageStatus } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, countryCode, dateOnly, decimalString, queryBool } from '../../common/pagination';

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Texte facultatif : chaîne vide => null (jamais de valeur inventée). */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

/** Horodatage ISO 8601 avec fuseau (stocké en UTC). */
export const isoDateTime = z
  .string()
  .datetime({ offset: true, message: 'Date/heure ISO 8601 attendue (ex. 2026-04-22T08:00:00Z)' })
  .transform((s) => new Date(s));

export const expectedVersion = z.number({ required_error: 'expectedVersion requis (verrou optimiste)' }).int().min(1);

/** Décimal ≥ 0 limité à la précision de la colonne (pas de dépassement numérique en base). */
const quantity = (intDigits: number, scale: number) =>
  decimalString({ min: 0, scale }).refine((s) => (s.split('.')[0].replace('-', '').length ?? 0) <= intDigits, `Au plus ${intDigits} chiffres avant la virgule`);

const laycanOrder = (v: { laycanFrom?: Date | null; laycanTo?: Date | null }) => !v.laycanFrom || !v.laycanTo || v.laycanFrom <= v.laycanTo;
const laycanMessage = { message: 'Laycan : la date de début doit précéder la date de fin', path: ['laycanTo'] };

// -----------------------------------------------------------------------------
// Voyages (CDC §7.1)
// -----------------------------------------------------------------------------

const VoyageFieldsSchema = z.object({
  charterer: optionalText(200),
  broker: optionalText(200),
  /** Rattachement principal à une CP (facultatif en DRAFT, CDC §7.2) */
  charterPartyId: z.string().uuid().nullable().optional(),
  description: optionalText(5000),
  laycanFrom: dateOnly.nullable().optional(),
  laycanTo: dateOnly.nullable().optional(),
  etd: isoDateTime.nullable().optional(),
  eta: isoDateTime.nullable().optional(),
  atd: isoDateTime.nullable().optional(),
  ata: isoDateTime.nullable().optional(),
  notes: optionalText(10000),
});

export const CreateVoyageSchema = VoyageFieldsSchema.extend({ vesselId: z.string().uuid() }).refine(laycanOrder, laycanMessage);
export class CreateVoyageDto extends createZodDto(CreateVoyageSchema) {}

export const UpdateVoyageSchema = VoyageFieldsSchema.extend({ expectedVersion }).refine(laycanOrder, laycanMessage);
export class UpdateVoyageDto extends createZodDto(UpdateVoyageSchema) {}

export class VoyageCommandDto extends createZodDto(
  z.object({ expectedVersion, comment: z.string().trim().max(2000).optional() }),
) {}

export class PlanVoyageDto extends createZodDto(
  z.object({
    expectedVersion,
    comment: z.string().trim().max(2000).optional(),
    /** Rattacher la CP au passage DRAFT -> PLANNED */
    charterPartyId: z.string().uuid().optional(),
  }),
) {}

export class CancelVoyageDto extends createZodDto(
  z.object({ expectedVersion, reason: z.string().trim().min(3, 'Motif requis').max(2000) }),
) {}

export const ListVoyagesSchema = PaginationSchema.extend({
  vesselId: z.string().uuid().optional(),
  status: z.nativeEnum(VoyageStatus).optional(),
  charterer: z.string().trim().max(200).optional(),
  search: z.string().trim().max(100).optional(),
  /** Période (AAAA-MM-JJ) recoupant laycan / ETD-ETA / dates réelles */
  from: dateOnly.optional(),
  to: dateOnly.optional(),
});
export class ListVoyagesQuery extends createZodDto(ListVoyagesSchema) {}

// -----------------------------------------------------------------------------
// Escales & agents (CDC §7.1, V1 §10.1)
// -----------------------------------------------------------------------------

const PortFieldsSchema = z.object({
  type: z.nativeEnum(PortCallType),
  portName: z.string().trim().min(2).max(120),
  country: countryCode.nullable().optional(),
  unlocode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}[A-Z0-9]{3}$/, 'UN/LOCODE : 5 caractères (ex. TNGAE)')
    .nullable()
    .optional(),
  berth: optionalText(120),
  agentId: z.string().uuid().nullable().optional(),
  eta: isoDateTime.nullable().optional(),
  ata: isoDateTime.nullable().optional(),
  etd: isoDateTime.nullable().optional(),
  atd: isoDateTime.nullable().optional(),
  cargoOperations: optionalText(5000),
  notes: optionalText(5000),
});
export class CreatePortDto extends createZodDto(PortFieldsSchema) {}
export class UpdatePortDto extends createZodDto(PortFieldsSchema.partial()) {}
export class ReorderPortsDto extends createZodDto(
  z.object({ portIds: z.array(z.string().uuid()).min(1).max(100) }),
) {}

const AgentFieldsSchema = z.object({
  /** Ex. LOAD_AGENT, DISCHARGE_AGENT, PROTECTING_AGENT */
  role: z.string().trim().toUpperCase().regex(/^[A-Z0-9_ -]{2,40}$/, 'Rôle : 2 à 40 caractères'),
  name: z.string().trim().min(2).max(200),
  city: optionalText(120),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  phone: optionalText(64),
  address: optionalText(500),
  notes: optionalText(5000),
});
export class CreateAgentDto extends createZodDto(AgentFieldsSchema) {}
export class UpdateAgentDto extends createZodDto(AgentFieldsSchema.partial()) {}

// -----------------------------------------------------------------------------
// Cargaisons (min / max / réel en MT, stowage factor + unité, option)
// -----------------------------------------------------------------------------

const CargoFieldsSchema = z.object({
  commodity: z.string().trim().min(2).max(200),
  description: optionalText(5000),
  qtyMinMt: quantity(11, 3).nullable().optional(),
  qtyMaxMt: quantity(11, 3).nullable().optional(),
  qtyActualMt: quantity(11, 3).nullable().optional(),
  unit: z.string().trim().min(1).max(16).optional(),
  /** Ex. "owners option" — texte, jamais interprété */
  quantityOption: optionalText(120),
  stowageFactor: quantity(7, 3).nullable().optional(),
  stowageFactorUnit: optionalText(32),
  isDangerous: z.boolean().optional(),
  documentation: optionalText(5000),
  notes: optionalText(5000),
});
export class CreateCargoDto extends createZodDto(CargoFieldsSchema) {}
export class UpdateCargoDto extends createZodDto(CargoFieldsSchema.partial()) {}

// -----------------------------------------------------------------------------
// Tâches / checklist (CDC §7.4)
// -----------------------------------------------------------------------------

const TaskFieldsSchema = z.object({
  title: z.string().trim().min(2).max(300),
  description: optionalText(5000),
  category: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/, 'Catégorie : 2 à 40 caractères A-Z 0-9 _').optional(),
  portId: z.string().uuid().nullable().optional(),
  assigneeId: z.string().uuid().nullable().optional(),
  dueAt: isoDateTime.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});
export class CreateTaskDto extends createZodDto(TaskFieldsSchema) {}
export class UpdateTaskDto extends createZodDto(TaskFieldsSchema.partial()) {}
export class CompleteTaskDto extends createZodDto(
  z.object({
    comment: z.string().trim().max(2000).optional(),
    /** Preuve (contexte VOYAGE) déposée via POST /files */
    evidenceFileId: z.string().uuid().optional(),
  }),
) {}
export class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().min(3, 'Motif requis').max(2000) })) {}

// -----------------------------------------------------------------------------
// Notices & NOR (CDC §7.4 : brouillon + validation humaine, aucun envoi automatique)
// -----------------------------------------------------------------------------

const NoticeFieldsSchema = z.object({
  portId: z.string().uuid().nullable().optional(),
  /** Ex. FIXING, DAILY, ETA_NOTICE, 12H_DEFINITE */
  kind: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,40}$/, 'Type : 2 à 40 caractères A-Z 0-9 _'),
  scheduleLabel: optionalText(120),
  dueAt: isoDateTime.nullable().optional(),
  recipients: optionalText(1000),
  draftBody: optionalText(20_000),
});
export class CreateNoticeDto extends createZodDto(NoticeFieldsSchema) {}
export class UpdateNoticeDto extends createZodDto(NoticeFieldsSchema.partial()) {}
export class GenerateNoticeDraftDto extends createZodDto(z.object({ overwrite: z.boolean().default(false) })) {}
export class MarkNoticeSentDto extends createZodDto(
  z.object({
    /** Heure réelle de l'envoi effectué hors plateforme (défaut : maintenant) */
    sentAt: isoDateTime.optional(),
    channel: z.string().trim().max(60).optional(),
    comment: z.string().trim().max(2000).optional(),
  }),
) {}

const NorFieldsSchema = z.object({
  portId: z.string().uuid(),
  tenderedAt: isoDateTime,
  acceptedAt: isoDateTime.nullable().optional(),
  acceptedBy: optionalText(200),
  remarks: optionalText(5000),
  fileId: z.string().uuid().optional(),
});
export class CreateNorDto extends createZodDto(NorFieldsSchema) {}
export class UpdateNorDto extends createZodDto(NorFieldsSchema.omit({ portId: true }).partial()) {}

// -----------------------------------------------------------------------------
// Fichiers voyage
// -----------------------------------------------------------------------------

export class AddVoyageFileDto extends createZodDto(
  z.object({
    fileId: z.string().uuid(),
    category: z.string().trim().toUpperCase().regex(/^[A-Z0-9_ -]{2,60}$/, 'Catégorie : 2 à 60 caractères'),
    title: z.string().trim().min(2).max(200),
  }),
) {}

export const ListVoyageFilesSchema = z.object({ archived: queryBool });

/** Lien éphémère vers un document (preview inline / download). */
export const FileLinkQuerySchema = z.object({ mode: z.enum(['preview', 'download']).default('preview') });

export class ArchiveVoyageFileDto extends createZodDto(z.object({ reason: z.string().trim().max(1000).optional() })) {}
