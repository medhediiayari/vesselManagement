import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationSchema } from '../../common/pagination';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{3,64}$/, 'Identifiant : 3 à 64 caractères a-z 0-9 . _ -');
const email = z.string().trim().toLowerCase().email().max(320);
const uuid = z.string().uuid();

export const VesselScopeSchema = z
  .object({
    mode: z.enum(['ALL_FLEET', 'SELECTED']),
    vesselIds: z.array(uuid).max(500).default([]),
  })
  .refine((v) => v.mode === 'ALL_FLEET' || v.vesselIds.length >= 0, 'vesselIds requis');

export const DepartmentsAssignmentSchema = z.object({
  primaryId: uuid.nullable().optional(),
  secondaryIds: z.array(uuid).max(50).default([]),
});

export const OverrideSchema = z.object({
  permissionKey: z.string().min(3).max(80),
  effect: z.enum(['ALLOW', 'DENY']),
  reason: z.string().trim().max(500).optional(),
});

/** Une permission au plus une fois : sinon violation d'unicité et 409 vague (ADM-27). */
const uniqueOverrides = (max: number) =>
  z
    .array(OverrideSchema)
    .max(max)
    .refine((o) => new Set(o.map((x) => x.permissionKey)).size === o.length, 'Chaque permission ne peut figurer qu’une fois');

export const CreateUserSchema = z.object({
  username,
  email: email.optional(),
  emailVerified: z.boolean().default(false),
  displayName: z.string().trim().min(2).max(200),
  jobTitle: z.string().trim().max(120).optional(),
  roleIds: z.array(uuid).max(20).default([]),
  vesselScope: VesselScopeSchema.default({ mode: 'SELECTED', vesselIds: [] }),
  departments: DepartmentsAssignmentSchema.optional(),
  memberId: uuid.optional(),
  overrides: uniqueOverrides(100).default([]),
});
export class CreateUserDto extends createZodDto(CreateUserSchema) {}

export const UpdateUserSchema = z
  .object({
    email: email.nullable().optional(),
    emailVerified: z.boolean().optional(),
    displayName: z.string().trim().min(2).max(200).optional(),
    jobTitle: z.string().trim().max(120).nullable().optional(),
    username: username.optional(),
  })
  .strict();
export class UpdateUserDto extends createZodDto(UpdateUserSchema) {}

export class SetRolesDto extends createZodDto(z.object({ roleIds: z.array(uuid).max(20) })) {}
export class SetOverridesDto extends createZodDto(z.object({ overrides: uniqueOverrides(200) })) {}
export class SetVesselScopeDto extends createZodDto(VesselScopeSchema) {}
export class SetDepartmentsDto extends createZodDto(DepartmentsAssignmentSchema) {}
export class LinkMemberDto extends createZodDto(z.object({ memberId: uuid.nullable() })) {}
export class ReasonDto extends createZodDto(z.object({ reason: z.string().trim().max(500).optional() })) {}

export const ListUsersSchema = PaginationSchema.extend({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['ACTIVE', 'DEACTIVATED', 'LOCKED']).optional(),
  roleId: uuid.optional(),
  departmentId: uuid.optional(),
});
export class ListUsersQuery extends createZodDto(ListUsersSchema) {}

const roleKey = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9_]{1,63}$/, 'Clé : majuscules, chiffres, _');

export const CreateRoleSchema = z.object({
  key: roleKey,
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional(),
  permissions: z.array(z.string().min(3).max(80)).max(300).default([]),
});
export class CreateRoleDto extends createZodDto(CreateRoleSchema) {}

export const UpdateRoleSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(500).nullable().optional(),
  permissions: z.array(z.string().min(3).max(80)).max(300).optional(),
});
export class UpdateRoleDto extends createZodDto(UpdateRoleSchema) {}

export const CreateDepartmentSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{2,32}$/),
  name: z.string().trim().min(2).max(120),
  primaryManagerId: uuid.nullable().optional(),
  deputyIds: z.array(uuid).max(20).default([]),
});
export class CreateDepartmentDto extends createZodDto(CreateDepartmentSchema) {}

export const UpdateDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  primaryManagerId: uuid.nullable().optional(),
  deputyIds: z.array(uuid).max(20).optional(),
});
export class UpdateDepartmentDto extends createZodDto(UpdateDepartmentSchema) {}

export class UpdateSettingDto extends createZodDto(z.object({ value: z.unknown() })) {}
