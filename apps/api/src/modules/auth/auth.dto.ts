import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const LoginSchema = z.object({
  /** Email ou username (ADM-008) */
  identifier: z.string().trim().min(1).max(320),
  password: z.string().min(1).max(256),
  deviceLabel: z.string().trim().max(200).optional(),
});
export class LoginDto extends createZodDto(LoginSchema) {}

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(1).max(256),
});
export class ChangePasswordDto extends createZodDto(ChangePasswordSchema) {}

export const ForgotPasswordSchema = z.object({ identifier: z.string().trim().min(1).max(320) });
export class ForgotPasswordDto extends createZodDto(ForgotPasswordSchema) {}

export const ResetPasswordSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword: z.string().min(1).max(256),
});
export class ResetPasswordDto extends createZodDto(ResetPasswordSchema) {}

export const UpdateProfileSchema = z
  .object({
    displayName: z.string().trim().min(2).max(200).optional(),
    locale: z.enum(['fr', 'en']).optional(),
  })
  .strict();
export class UpdateProfileDto extends createZodDto(UpdateProfileSchema) {}
