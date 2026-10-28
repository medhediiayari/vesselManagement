import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, countryCode, dateOnly, queryBool } from '../../common/pagination';
import { VALIDITY_STATUSES } from './certificate.logic';

const uuid = z.string().uuid();
/** Texte facultatif : chaîne vide => null (effacement explicite). */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable()
    .optional();

const subjectKind = z.enum(['VESSEL', 'MEMBER']);
const expiryKind = z.enum(['DATED', 'UNLIMITED', 'UNKNOWN']);
const principalType = z.enum(['USER', 'ROLE', 'DEPARTMENT']);
const renewalStatus = z.enum(['NOT_STARTED', 'IN_PROGRESS', 'COMPLETED']);
const approvalStatus = z.enum(['DRAFT', 'PENDING_APPROVAL', 'RETURNED', 'REJECTED', 'APPROVED', 'CANCELLED']);
const requestKind = z.enum(['CREATE', 'RENEWAL', 'CORRECTION', 'ATTACHMENT']);

/** Liste séparée par des virgules en query string ("EXPIRED,EXPIRING_SOON"). */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).max(values.length))
    .optional();

// =============================================================================
// Données de certificat (version de demande / révision) — CDC §4.2
// =============================================================================

const dataFields = {
  certificateNumber: text(120),
  issuer: text(200),
  authority: text(200),
  country: countryCode.nullable().optional(),
  placeOfIssue: text(120),
  issuedOn: dateOnly.nullable().optional(),
  validFrom: dateOnly.nullable().optional(),
  expiryKind,
  expiryOn: dateOnly.nullable().optional(),
  remarks: text(5000),
};

/** Contrôle précoce DATED <-> expiryOn (le service revalide sur les données fusionnées). */
function refineExpiry(v: { expiryKind?: string; expiryOn?: Date | null }, ctx: z.RefinementCtx) {
  if (v.expiryKind === 'DATED' && v.expiryOn === null) {
    ctx.addIssue({ code: 'custom', path: ['expiryOn'], message: "Date d'expiration requise pour un certificat daté" });
  }
  if (v.expiryKind && v.expiryKind !== 'DATED' && v.expiryOn) {
    ctx.addIssue({ code: 'custom', path: ['expiryOn'], message: "Pas de date d'expiration pour UNLIMITED / UNKNOWN (ADM-062)" });
  }
}

const changeNote = z.string().trim().max(500).optional();

export const CreateCertificateSchema = z
  .object({
    subjectKind,
    vesselId: uuid.optional(),
    memberId: uuid.optional(),
    typeId: uuid,
    ...dataFields,
    /** Pièce déposée via POST /files (context CERTIFICATE) — facultative (ADM-064) */
    fileId: uuid.nullable().optional(),
    changeNote,
    /** Soumettre immédiatement à approbation (sinon brouillon) */
    submit: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    if (v.subjectKind === 'VESSEL' && (!v.vesselId || v.memberId)) {
      ctx.addIssue({ code: 'custom', path: ['vesselId'], message: 'Certificat navire : vesselId requis, memberId interdit' });
    }
    if (v.subjectKind === 'MEMBER' && (!v.memberId || v.vesselId)) {
      ctx.addIssue({ code: 'custom', path: ['memberId'], message: 'Certificat Member : memberId requis, vesselId interdit' });
    }
    if (v.expiryKind === 'DATED' && !v.expiryOn) {
      ctx.addIssue({ code: 'custom', path: ['expiryOn'], message: "Date d'expiration requise pour un certificat daté" });
    }
    refineExpiry(v, ctx);
  });
export class CreateCertificateDto extends createZodDto(CreateCertificateSchema) {}

/** Renouvellement : nouvelles dates obligatoires ; l'émetteur / l'autorité sont repris s'ils sont omis. */
export const RenewCertificateSchema = z
  .object({ ...dataFields, fileId: uuid.nullable().optional(), changeNote, submit: z.boolean().default(false) })
  .superRefine((v, ctx) => {
    if (v.expiryKind === 'DATED' && !v.expiryOn) {
      ctx.addIssue({ code: 'custom', path: ['expiryOn'], message: "Date d'expiration requise pour un certificat daté" });
    }
    refineExpiry(v, ctx);
  });
export class RenewCertificateDto extends createZodDto(RenewCertificateSchema) {}

/** Correction : patch sur la révision courante ; motif obligatoire (traçabilité CDC §4.6). */
export const CorrectionSchema = z
  .object({
    ...dataFields,
    expiryKind: expiryKind.optional(),
    fileId: uuid.nullable().optional(),
    changeNote: z.string().trim().min(3, 'Motif de correction obligatoire').max(500),
    submit: z.boolean().default(false),
  })
  .superRefine(refineExpiry);
export class CorrectionDto extends createZodDto(CorrectionSchema) {}

/** Modification par le demandeur (ADM-057/058) : chaque appel crée une version immuable. */
export const UpdateRequestSchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    ...dataFields,
    expiryKind: expiryKind.optional(),
    /** undefined = pièce inchangée ; null = retirer la pièce proposée ; uuid = nouvelle pièce */
    fileId: uuid.nullable().optional(),
    changeNote,
  })
  .superRefine(refineExpiry);
export class UpdateRequestDto extends createZodDto(UpdateRequestSchema) {}

export class SubmitRequestDto extends createZodDto(z.object({ expectedVersion: z.number().int().min(1).optional() })) {}

export const DecisionSchema = z
  .object({
    decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
    comment: z.string().trim().max(4000).optional(),
    /** Version vue par le validateur : une version périmée est refusée (409 STALE_VERSION, ADM-058) */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine((v, ctx) => {
    if (v.decision !== 'APPROVE' && !v.comment) {
      ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Commentaire obligatoire pour un refus ou un retour (ADM-052)' });
    }
  });
export class DecisionDto extends createZodDto(DecisionSchema) {}

export class CancelRequestDto extends createZodDto(
  z.object({
    reason: z.string().trim().min(3, "Motif d'annulation obligatoire (ADM-059)").max(1000),
    expectedVersion: z.number().int().min(1).optional(),
  }),
) {}

export class DuplicateRequestDto extends createZodDto(z.object({ changeNote })) {}

export class AddAttachmentDto extends createZodDto(
  z.object({
    fileId: uuid,
    note: z.string().trim().max(500).optional(),
    /** Soumettre immédiatement (exige certificates.submit) ; false = brouillon à soumettre ensuite */
    submit: z.boolean().default(true),
  }),
) {}

export class SetRenewalDto extends createZodDto(
  z.object({
    status: renewalStatus,
    ownerId: uuid.nullable().optional(),
    dueOn: dateOnly.nullable().optional(),
  }),
) {}

export class AddCommentDto extends createZodDto(z.object({ body: z.string().trim().min(1).max(4000) })) {}

export class ArchiveCertificateDto extends createZodDto(
  z.object({ reason: z.string().trim().min(3, "Motif d'archivage obligatoire").max(500) }),
) {}

// =============================================================================
// Listes
// =============================================================================

export const ListCertificatesSchema = PaginationSchema.extend({
  subjectKind: subjectKind.optional(),
  vesselId: uuid.optional(),
  /** Plusieurs navires (liste séparée par des virgules) : certificats navires + marins affectés */
  vesselIds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => (v === undefined ? undefined : (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean)))
    .pipe(z.array(uuid).max(200).optional()),
  /** "me" : certificats dont je suis responsable du renouvellement */
  renewalOwner: z.enum(['me']).optional(),
  memberId: uuid.optional(),
  /** Certificats des marins affectés (PLANNED / ONBOARD) à ce navire */
  crewVesselId: uuid.optional(),
  typeId: uuid.optional(),
  category: z.string().trim().max(60).optional(),
  validity: csvEnum(VALIDITY_STATUSES),
  expiringWithinDays: z.coerce.number().int().min(0).max(3650).optional(),
  renewalStatus: renewalStatus.optional(),
  documentMissing: queryBool,
  pendingApproval: queryBool,
  hasCurrentRevision: queryBool,
  archived: queryBool,
  /** Inclure les certificats sans révision ni demande ouverte (création refusée / annulée) */
  includeAbandoned: queryBool,
  search: z.string().trim().max(100).optional(),
  sort: z.enum(['expiryOn', 'updatedAt', 'createdAt']).default('expiryOn'),
  order: z.enum(['asc', 'desc']).default('asc'),
});
export class ListCertificatesQuery extends createZodDto(ListCertificatesSchema) {}

export class ComplianceQuery extends createZodDto(
  z.object({ vesselId: uuid.optional(), subjectKind: subjectKind.optional() }),
) {}

export const ListRequestsSchema = PaginationSchema.extend({
  status: csvEnum(approvalStatus.options),
  kind: requestKind.optional(),
  certificateId: uuid.optional(),
  /** Mes demandes */
  mine: queryBool,
  /** Demandes en attente que je peux valider */
  toApprove: queryBool,
});
export class ListRequestsQuery extends createZodDto(ListRequestsSchema) {}

// =============================================================================
// Configuration : types, validateurs, politiques de rappel (ADM-044..047, 051)
// =============================================================================

export const PrincipalSchema = z.object({ principalType, principalId: uuid });
export type PrincipalInput = z.infer<typeof PrincipalSchema>;

const typeFields = {
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{2,40}$/, 'Code : 2 à 40 caractères A-Z 0-9 _ -'),
  name: z.string().trim().min(2).max(200),
  subjectKind,
  category: z.string().trim().min(2).max(60),
  description: text(2000),
  defaultValidityMonths: z.number().int().min(1).max(600).nullable().optional(),
  requiresDocument: z.boolean(),
  allowMultiple: z.boolean(),
  reminderPolicyId: uuid.nullable().optional(),
  isActive: z.boolean(),
  sortOrder: z.number().int().min(0).max(100_000),
};

export class CreateCertificateTypeDto extends createZodDto(
  z.object({
    ...typeFields,
    requiresDocument: typeFields.requiresDocument.default(true),
    allowMultiple: typeFields.allowMultiple.default(false),
    isActive: typeFields.isActive.default(true),
    sortOrder: typeFields.sortOrder.default(0),
    validators: z.array(PrincipalSchema).max(100).default([]),
  }),
) {}

export class UpdateCertificateTypeDto extends createZodDto(z.object(typeFields).partial().strict()) {}

export class SetPrincipalsDto extends createZodDto(z.object({ principals: z.array(PrincipalSchema).max(200) })) {}

export class ListCertificateTypesQuery extends createZodDto(
  z.object({
    subjectKind: subjectKind.optional(),
    active: queryBool,
    category: z.string().trim().max(60).optional(),
  }),
) {}

const optionalDays = (max: number) => z.number().int().min(1).max(max).nullable().optional();

const policyFields = {
  name: z.string().trim().min(2).max(120),
  /** Seuils en jours avant échéance (ex. 90/60/30/7) — positifs, dédupliqués, triés */
  thresholdsDays: z
    .array(z.number().int().min(1).max(3650))
    .max(20)
    .transform((a) => [...new Set(a)].sort((x, y) => y - x)),
  frequency: z.enum(['AT_THRESHOLDS', 'DAILY', 'WEEKLY', 'CUSTOM']),
  customIntervalDays: optionalDays(365),
  postExpiryIntervalDays: optionalDays(365),
  postExpiryMaxReminders: z.number().int().min(0).max(1000).nullable().optional(),
  unknownExpiryIntervalDays: optionalDays(365),
  missingDocumentIntervalDays: optionalDays(365),
  approvalOverdueHours: z.number().int().min(1).max(24 * 90).nullable().optional(),
  escalationRoleId: uuid.nullable().optional(),
};

export class CreateReminderPolicyDto extends createZodDto(
  z
    .object({
      ...policyFields,
      thresholdsDays: policyFields.thresholdsDays.default([90, 60, 30, 7]),
      frequency: policyFields.frequency.default('AT_THRESHOLDS'),
      recipients: z.array(PrincipalSchema).max(200).default([]),
    })
    .superRefine((v, ctx) => {
      if (v.frequency === 'CUSTOM' && !v.customIntervalDays) {
        ctx.addIssue({ code: 'custom', path: ['customIntervalDays'], message: 'Intervalle requis pour la fréquence personnalisée' });
      }
    }),
) {}

export class UpdateReminderPolicyDto extends createZodDto(z.object(policyFields).partial().strict()) {}
