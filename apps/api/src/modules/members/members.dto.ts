import { createZodDto } from 'nestjs-zod';
import { CREW_CATEGORY_KEYS } from '@amc/types';
import { z } from 'zod';
import { PaginationSchema, countryCode, dateOnly, queryBool } from '../../common/pagination';
import { normalizeRef } from './members.logic';

const uuid = z.string().uuid();

/** Texte facultatif : "" => null (effacement explicite), espaces normalisés. */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s.length ? s.replace(/\s+/g, ' ') : null))
    .nullable()
    .optional();

/** Identifiant officiel (matricule, passeport, livret) : majuscules sans espaces. */
const officialRef = z
  .string()
  .trim()
  .max(40)
  .transform((s) => normalizeRef(s))
  .refine((s) => s === null || s.length <= 32, '32 caractères maximum')
  .nullable()
  .optional();

const pastDate = dateOnly.refine((d) => d.getTime() <= Date.now(), 'Date dans le futur');

export const MemberDataSchema = z.object({
  amcRef: officialRef,
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  birthDate: pastDate.nullable().optional(),
  birthPlace: text(120),
  nationality: countryCode.nullable().optional(),
  gender: z.enum(['M', 'F', 'X']).nullable().optional(),
  email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
  phone: text(64),
  address: text(500),
  emergencyContactName: text(200),
  emergencyContactPhone: text(64),
  passportNumber: officialRef,
  passportCountry: countryCode.nullable().optional(),
  passportExpiry: dateOnly.nullable().optional(),
  seamanBookNumber: officialRef,
  seamanBookExpiry: dateOnly.nullable().optional(),
  rank: text(120),
  crewDepartment: z.enum(['DECK', 'ENGINE', 'CATERING', 'OTHER']).nullable().optional(),
  departmentId: uuid.nullable().optional(),
  notes: text(5000),
});
export type MemberData = z.infer<typeof MemberDataSchema>;

/** Valeurs de champs personnalisés : { clé du champ -> valeur | null } (ADM-036). */
const customFields = z.record(z.string().max(64), z.unknown()).optional();

/** Création forcée malgré un doublon potentiel : motif obligatoire, audité. */
const forceFields = {
  force: z.boolean().default(false),
  forceReason: z.string().trim().min(5).max(500).optional(),
};
const forceRefine = <T extends { force?: boolean; forceReason?: string }>(d: T) => !d.force || !!d.forceReason;
const forceMessage = { message: 'forceReason (5 caractères min.) requis lorsque force=true', path: ['forceReason'] };

export const CreateMemberSchema = MemberDataSchema.extend({
  status: z.enum(['AVAILABLE', 'ON_LEAVE', 'INACTIVE']).optional(),
  photoFileId: uuid.optional(),
  customFields,
  ...forceFields,
}).refine(forceRefine, forceMessage);
export class CreateMemberDto extends createZodDto(CreateMemberSchema) {}

export const UpdateMemberSchema = MemberDataSchema.partial()
  .extend({
    customFields,
    /** Verrou optimiste : valeur `updatedAt` lue par le client */
    expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
    ...forceFields,
  })
  .strict()
  .refine(forceRefine, forceMessage);
export class UpdateMemberDto extends createZodDto(UpdateMemberSchema) {}

/**
 * Libre-service (ADM-032..035) : seuls les champs autorisés par le paramètre
 * `members.selfEditableFields` sont acceptés (contrôle serveur, 403 sinon).
 */
export const SelfUpdateSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320).nullable().optional(),
    phone: text(64),
    address: text(500),
    emergencyContactName: text(200),
    emergencyContactPhone: text(64),
    customFields,
  })
  .passthrough();
export class SelfUpdateDto extends createZodDto(SelfUpdateSchema) {}

export class SetMemberStatusDto extends createZodDto(
  z.object({ status: z.enum(['AVAILABLE', 'ON_LEAVE', 'INACTIVE']), reason: z.string().trim().max(500).optional() }),
) {}

export class ArchiveMemberDto extends createZodDto(z.object({ reason: z.string().trim().min(3).max(500) })) {}

export class SetMemberPhotoDto extends createZodDto(z.object({ fileId: uuid.nullable() })) {}

export class AddMemberDocumentDto extends createZodDto(
  z.object({
    fileId: uuid,
    category: z.string().trim().min(2).max(60),
    title: z.string().trim().min(2).max(200),
  }),
) {}

export class ArchiveMemberDocumentDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}

export class DuplicateCheckDto extends createZodDto(
  z
    .object({
      amcRef: z.string().trim().max(40).optional(),
      firstName: z.string().trim().max(120).optional(),
      lastName: z.string().trim().max(120).optional(),
      birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      passportNumber: z.string().trim().max(40).optional(),
      passportCountry: countryCode.optional(),
      seamanBookNumber: z.string().trim().max(40).optional(),
      excludeMemberId: uuid.optional(),
    })
    .refine((d) => !!(d.amcRef || d.passportNumber || d.seamanBookNumber || (d.lastName && d.firstName) || d.birthDate), {
      message: 'Au moins un critère : matricule, passeport, seaman book, nom + prénom ou date de naissance',
    }),
) {}

export const MEMBER_SORT_FIELDS = ['lastName', 'createdAt', 'updatedAt', 'amcRef'] as const;

export const ListMembersSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ON_BOARD', 'AVAILABLE', 'ON_LEAVE', 'PLANNED_JOIN', 'INACTIVE']).optional(),
  rank: z.string().trim().max(120).optional(),
  crewDepartment: z.enum(['DECK', 'ENGINE', 'CATERING', 'OTHER']).optional(),
  /** Navire de l'affectation courante (PLANNED / ONBOARD) */
  vesselId: uuid.optional(),
  /** Catégorie d'équipage (rangs du référentiel) : officiers pont / machine, personnel pont, machine & cuisine */
  category: z.enum(CREW_CATEGORY_KEYS as [string, ...string[]]).optional(),
  /** true => certificats courants de chaque fiche (vue matrice), si members.certificates.view */
  withCertificates: queryBool,
  /** true => fiches archivées uniquement */
  archived: queryBool,
  sort: z.enum(MEMBER_SORT_FIELDS).default('lastName'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export class ListMembersQuery extends createZodDto(ListMembersSchema) {}

/** Compteurs de la population visible (même visibilité ADM-070 que la liste, fiches non archivées). */
export class MemberStatsQuery extends createZodDto(z.object({ vesselId: uuid.optional() })) {}

export class ListDocumentsQuery extends createZodDto(z.object({ archived: queryBool })) {}
