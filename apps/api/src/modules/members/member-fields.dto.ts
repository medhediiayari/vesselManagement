import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { queryBool } from '../../common/pagination';

const uuid = z.string().uuid();
const permissionKey = z.string().trim().min(3).max(80);

export class CreateSectionDto extends createZodDto(
  z.object({ name: z.string().trim().min(2).max(120), sortOrder: z.number().int().min(0).max(10_000).optional() }),
) {}

export class UpdateSectionDto extends createZodDto(
  z.object({ name: z.string().trim().min(2).max(120).optional(), sortOrder: z.number().int().min(0).max(10_000).optional() }).strict(),
) {}

/** Réordonnancement : identifiants dans l'ordre d'affichage voulu (ADM-038). */
export class ReorderDto extends createZodDto(
  z.object({ ids: z.array(uuid).min(1).max(500), sectionId: uuid.nullable().optional() }),
) {}

/** SELECT : { choices: [...], multiple?: boolean } ; aucun autre type n'accepte d'options. */
export const SelectOptionsSchema = z.object({
  choices: z
    .array(z.string().trim().min(1).max(120))
    .min(1)
    .max(200)
    .refine((c) => new Set(c).size === c.length, 'Choix en double'),
  multiple: z.boolean().optional(),
});

export const CreateFieldSchema = z
  .object({
    sectionId: uuid.nullable().optional(),
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,63}$/, 'Clé : 2 à 64 caractères a-z 0-9 _ (commence par une lettre)'),
    label: z.string().trim().min(2).max(120),
    type: z.enum(['TEXT', 'NUMBER', 'DATE', 'SELECT', 'BOOLEAN']),
    options: SelectOptionsSchema.nullable().optional(),
    required: z.boolean().default(false),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    /** Permission de consultation (null => members.view) */
    viewPermission: permissionKey.nullable().optional(),
    /** Permission d'édition (null => members.edit) */
    editPermission: permissionKey.nullable().optional(),
    selfEditable: z.boolean().default(false),
  })
  .refine((d) => (d.type === 'SELECT') === !!d.options, { message: 'options.choices requis pour SELECT uniquement', path: ['options'] });
export class CreateFieldDto extends createZodDto(CreateFieldSchema) {}

/** Clé et type immuables (valeurs existantes préservées, ADM-039). */
export class UpdateFieldDto extends createZodDto(
  z
    .object({
      sectionId: uuid.nullable().optional(),
      label: z.string().trim().min(2).max(120).optional(),
      options: SelectOptionsSchema.nullable().optional(),
      required: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(10_000).optional(),
      viewPermission: permissionKey.nullable().optional(),
      editPermission: permissionKey.nullable().optional(),
      selfEditable: z.boolean().optional(),
    })
    .strict(),
) {}

export class ListFieldsQuery extends createZodDto(z.object({ archived: queryBool })) {}
