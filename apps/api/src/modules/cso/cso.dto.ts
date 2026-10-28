import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema, dateOnly, queryBool } from '../../common/pagination';
import { CSO_ACTIONS } from './cso-acl.logic';
import { REFERENCE_RE, STANDARD_FIELDS, validateReferenceFormat } from './cso-rules';

const uuid = z.string().uuid();
const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !/[\u0000-\u001f\u007f/\\]/.test(s), 'Caractères interdits dans le nom (/, \\, contrôle)')
  .refine((s) => s !== '.' && s !== '..', 'Nom de dossier invalide');
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();
const reference = z
  .string()
  .trim()
  .max(120)
  .regex(REFERENCE_RE, 'Référence invalide (A-Z 0-9 . _ - / espace, 2 à 120 caractères)');
const optionalDate = dateOnly.nullable().optional();
const uuidList = (max = 200) => z.array(uuid).max(max).default([]);
export const PrincipalSchema = z.object({
  principalType: z.enum(['USER', 'ROLE', 'DEPARTMENT']),
  principalId: uuid,
});

// -----------------------------------------------------------------------------
// Bibliothèques & dossiers
// -----------------------------------------------------------------------------

export class ListFoldersQuery extends createZodDto(
  z.object({
    libraryId: uuid.optional(),
    parentId: uuid.optional(),
    includeArchived: queryBool,
  }),
) {}

export class TreeQuery extends createZodDto(
  z.object({
    includeArchived: queryBool,
    maxDepth: z.coerce.number().int().min(1).max(50).default(50),
  }),
) {}

export class CreateFolderDto extends createZodDto(
  z
    .object({
      libraryId: uuid.optional(),
      parentId: uuid.optional(),
      name,
    })
    .refine((d) => !!d.libraryId || !!d.parentId, 'libraryId ou parentId requis'),
) {}

export class RenameFolderDto extends createZodDto(
  z.object({ name, expectedUpdatedAt: z.coerce.date().optional() }),
) {}

export class MoveFolderDto extends createZodDto(
  z
    .object({
      targetParentId: uuid.nullable().optional(),
      targetLibraryId: uuid.optional(),
      expectedUpdatedAt: z.coerce.date().optional(),
    })
    .refine((d) => !!d.targetParentId || !!d.targetLibraryId, 'targetParentId ou targetLibraryId requis'),
) {}

export class ArchiveDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}

export class RestoreFolderDto extends createZodDto(
  z.object({
    /** true : restaure aussi les sous-dossiers ; false : uniquement ce dossier */
    recursive: z.boolean().default(true),
    /** Restauration sélective : seuls ces documents (dans le périmètre restauré) sont restaurés */
    includeDocumentIds: z.array(uuid).max(2000).optional(),
    reason: z.string().trim().max(500).optional(),
  }),
) {}

export const AclEntryInputSchema = PrincipalSchema.extend({
  actions: z.array(z.enum(CSO_ACTIONS)).min(1).max(CSO_ACTIONS.length),
  effect: z.enum(['ALLOW', 'DENY']).default('ALLOW'),
});
export class PutAclDto extends createZodDto(
  z.object({
    inheritAcl: z.boolean(),
    entries: z.array(AclEntryInputSchema).max(200),
  }),
) {}

export class PutValidatorsDto extends createZodDto(z.object({ validators: z.array(PrincipalSchema).max(100) })) {}

// -----------------------------------------------------------------------------
// Catégories & champs
// -----------------------------------------------------------------------------

const referenceFormat = z
  .string()
  .trim()
  .max(120)
  .superRefine((f, c) => {
    const err = validateReferenceFormat(f);
    if (err) c.addIssue({ code: z.ZodIssueCode.custom, message: err });
  });

const CategoryBase = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,40}$/, 'Code : 2 à 40 caractères A-Z 0-9 _ -'),
  name: z.string().trim().min(2).max(200),
  scope: z.enum(['FLEET', 'VESSEL']).default('FLEET'),
  vesselId: uuid.nullable().optional(),
  referenceMode: z.enum(['AUTO', 'MANUAL']).default('AUTO'),
  referenceFormat: referenceFormat.nullable().optional(),
  requiredFields: z.array(z.enum(STANDARD_FIELDS)).max(STANDARD_FIELDS.length).default([]),
  sortOrder: z.number().int().min(0).max(10_000).default(0),
});
export class CreateCategoryDto extends createZodDto(
  CategoryBase.refine((d) => d.referenceMode === 'MANUAL' || !!d.referenceFormat, {
    message: 'Format de référence requis en mode AUTO',
    path: ['referenceFormat'],
  }).refine((d) => (d.scope === 'VESSEL') === !!d.vesselId, {
    message: 'vesselId requis pour une catégorie navire (et interdit pour une catégorie flotte)',
    path: ['vesselId'],
  }),
) {}
export class UpdateCategoryDto extends createZodDto(
  CategoryBase.omit({ code: true, scope: true, vesselId: true }).partial().extend({
    requiredFields: z.array(z.enum(STANDARD_FIELDS)).max(STANDARD_FIELDS.length).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    referenceMode: z.enum(['AUTO', 'MANUAL']).optional(),
  }),
) {}

export class ListCategoriesQuery extends createZodDto(
  z.object({ includeInactive: queryBool, vesselId: uuid.optional() }),
) {}

const FieldOptions = z.array(z.string().trim().min(1).max(120)).max(200);
export class CreateFieldDto extends createZodDto(
  z
    .object({
      key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/, 'Clé : minuscules, chiffres, _ (2 à 64)'),
      label: z.string().trim().min(1).max(120),
      type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']),
      options: FieldOptions.optional(),
      required: z.boolean().default(false),
      isConfidential: z.boolean().default(false),
      sortOrder: z.number().int().min(0).max(10_000).default(0),
    })
    .refine((d) => d.type !== 'SELECT' || (d.options?.length ?? 0) > 0, { message: 'Options requises pour un champ SELECT', path: ['options'] }),
) {}
export class UpdateFieldDto extends createZodDto(
  z.object({
    label: z.string().trim().min(1).max(120).optional(),
    options: FieldOptions.optional(),
    required: z.boolean().optional(),
    isConfidential: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
  }),
) {}

export class PutFieldAclDto extends createZodDto(
  z.object({
    entries: z
      .array(PrincipalSchema.extend({ canView: z.boolean().default(true), canEdit: z.boolean().default(false) }))
      .max(200),
  }),
) {}

// -----------------------------------------------------------------------------
// Documents & versions
// -----------------------------------------------------------------------------

/** Valeurs de champs personnalisés : clé du champ -> valeur (null = effacer). */
const CustomFields = z.record(z.string().max(64), z.union([z.string().max(5000), z.number(), z.boolean(), z.null()]));

export class CreateDocumentDto extends createZodDto(
  z.object({
    folderId: uuid,
    title: z.string().trim().min(1).max(300),
    description: optionalText(10_000),
    categoryId: uuid.nullable().optional(),
    /** Catégorie en mode MANUAL uniquement (ou document sans catégorie) */
    reference: reference.optional(),
    nextReviewOn: optionalDate,
    expiryOn: optionalDate,
    fileId: uuid,
    changeNote: z.string().trim().max(1000).optional(),
    /** false : version laissée en brouillon (DRAFT), à soumettre plus tard */
    submit: z.boolean().default(true),
    customFields: CustomFields.optional(),
  }),
) {}

export class UpdateDocumentDto extends createZodDto(
  z.object({
    title: z.string().trim().min(1).max(300).optional(),
    description: optionalText(10_000),
    categoryId: uuid.nullable().optional(),
    nextReviewOn: optionalDate,
    expiryOn: optionalDate,
    customFields: CustomFields.optional(),
    expectedUpdatedAt: z.coerce.date().optional(),
  }),
) {}

export class ListDocumentsQuery extends createZodDto(
  PaginationSchema.extend({
    folderId: uuid,
    includeArchived: queryBool,
  }),
) {}

export class NewVersionDto extends createZodDto(
  z.object({
    fileId: uuid,
    changeNote: z.string().trim().max(1000).optional(),
    submit: z.boolean().default(true),
  }),
) {}

export class LockVersionDto extends createZodDto(z.object({ expectedLockVersion: z.number().int().min(1) })) {}

export class VersionDecisionDto extends createZodDto(
  z
    .object({
      decision: z.enum(['APPROVE', 'REJECT', 'RETURN']),
      comment: z.string().trim().max(2000).optional(),
      expectedLockVersion: z.number().int().min(1),
    })
    .refine((d) => d.decision === 'APPROVE' || !!d.comment, { message: 'Commentaire obligatoire pour un rejet ou un retour', path: ['comment'] }),
) {}

export class ReferenceChangeDto extends createZodDto(
  z.object({ newReference: reference, reason: z.string().trim().min(3).max(500) }),
) {}

export class ReferenceDecisionDto extends createZodDto(
  z
    .object({ decision: z.enum(['APPROVE', 'REJECT']), comment: z.string().trim().max(2000).optional() })
    .refine((d) => d.decision === 'APPROVE' || !!d.comment, { message: 'Commentaire obligatoire pour un rejet', path: ['comment'] }),
) {}

export class CopyDocumentDto extends createZodDto(
  z.object({
    targetFolderId: uuid,
    title: z.string().trim().min(1).max(300).optional(),
    /** Référence (catégorie MANUAL) ; en mode AUTO une nouvelle référence est générée */
    reference: reference.optional(),
    categoryId: uuid.nullable().optional(),
  }),
) {}

export class MoveDocumentDto extends createZodDto(
  z.object({ targetFolderId: uuid, expectedUpdatedAt: z.coerce.date().optional() }),
) {}

export class RestoreDocumentDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}

// -----------------------------------------------------------------------------
// Partages (CSO-014..016)
// -----------------------------------------------------------------------------

export class CreateShareDto extends createZodDto(
  z
    .object({
      documentId: uuid,
      recipientUserIds: uuidList(100),
      recipientDepartmentIds: uuidList(50),
      message: z.string().trim().max(1000).optional(),
      allowDownload: z.boolean().default(false),
    })
    .refine((d) => d.recipientUserIds.length + d.recipientDepartmentIds.length > 0, 'Au moins un destinataire'),
) {}

export class SharedWithMeQuery extends createZodDto(PaginationSchema) {}

// -----------------------------------------------------------------------------
// Recherche (CSO-013)
// -----------------------------------------------------------------------------

export class SearchQuery extends createZodDto(
  z.object({
    q: z.string().trim().max(200).optional(),
    vesselId: uuid.optional(),
    libraryId: uuid.optional(),
    folderId: uuid.optional(),
    categoryId: uuid.optional(),
    status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
    authorId: uuid.optional(),
    from: dateOnly.optional(),
    to: dateOnly.optional(),
    /** Filtre sur un champ personnalisé (visibilité du champ vérifiée) */
    fieldId: uuid.optional(),
    fieldValue: z.string().trim().max(200).optional(),
    includeArchived: queryBool,
    limit: z.coerce.number().int().min(1).max(100).default(25),
    /** Curseur opaque (position dans le flux de candidats) */
    cursor: z.string().regex(/^\d{1,7}$/).optional(),
  }),
) {}

// -----------------------------------------------------------------------------
// ZIP (CSO-023) & import (CSO-033/034)
// -----------------------------------------------------------------------------

export class ZipRequestDto extends createZodDto(
  z
    .object({
      documentIds: uuidList(1000),
      folderIds: uuidList(100),
      includeArchived: z.boolean().default(false),
    })
    .refine((d) => d.documentIds.length + d.folderIds.length > 0, 'Sélection vide'),
) {}

export class CreateImportJobDto extends createZodDto(
  z.object({
    sourceFileId: uuid,
    metadataFileId: uuid.optional(),
    targetFolderId: uuid,
    /** Catégorie par défaut appliquée aux lignes sans catégorie */
    defaultCategoryId: uuid.optional(),
  }),
) {}

export class ImportRowsQuery extends createZodDto(
  PaginationSchema.extend({
    status: z.enum(['PENDING', 'VALID', 'INVALID', 'DUPLICATE_SUSPECTED', 'APPLIED', 'SKIPPED', 'FAILED']).optional(),
  }),
) {}

export class ImportDecisionsDto extends createZodDto(
  z.object({
    items: z
      .array(
        z
          .object({
            rowId: uuid,
            decision: z.enum(['CREATE', 'IGNORE', 'CREATE_INDEPENDENT', 'SUBMIT_NEW_VERSION']),
            /** Document cible (SUBMIT_NEW_VERSION) — doit figurer parmi les doublons proposés */
            targetDocumentId: uuid.optional(),
            /** Correction de métadonnées avant validation */
            title: z.string().trim().min(1).max(300).optional(),
            reference: reference.nullable().optional(),
          })
          .refine((d) => d.decision !== 'SUBMIT_NEW_VERSION' || !!d.targetDocumentId, {
            message: 'targetDocumentId requis pour SUBMIT_NEW_VERSION',
            path: ['targetDocumentId'],
          }),
      )
      .min(1)
      .max(2000),
  }),
) {}

