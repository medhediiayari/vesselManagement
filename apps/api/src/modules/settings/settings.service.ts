import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Paramètres système modifiables par le Super Admin (CDC §17.1 « à laisser configurables »).
 * Valeurs typées et validées ; défauts issus de l'environnement.
 */
export const SETTINGS_SCHEMAS = {
  'auth.sessionIdleTimeoutMinutes': z.number().int().min(5).max(24 * 60),
  'auth.maxFailedLogins': z.number().int().min(3).max(10),
  'auth.passwordMinLength': z.number().int().min(10).max(128),
  'members.selfEditableFields': z
    .array(z.enum(['email', 'phone', 'address', 'emergencyContactName', 'emergencyContactPhone']))
    .refine((v) => new Set(v).size === v.length, 'Chaque champ ne peut figurer qu’une fois'), // ADM-29
  // Plafonnée par la limite Multer (UPLOAD_MAX_BYTES) : au-delà, la valeur n'aurait aucun effet (ADM-20)
  'files.maxUploadBytes': z
    .number()
    .int()
    .min(1024 * 1024)
    .refine((v) => v <= env().UPLOAD_MAX_BYTES, () => ({
      message: `Au plus ${Math.floor(env().UPLOAD_MAX_BYTES / (1024 * 1024))} Mo (limite serveur fixée par l'environnement)`,
    })),
  'certificates.expiringSoonDays': z.number().int().min(1).max(365),
  'purchasing.allowOverAllocation': z.boolean(),
} as const;

export type SettingKey = keyof typeof SETTINGS_SCHEMAS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_SCHEMAS)[K]>;

function defaults(): { [K in SettingKey]: SettingValue<K> } {
  return {
    'auth.sessionIdleTimeoutMinutes': env().SESSION_IDLE_TIMEOUT_MINUTES,
    // ADM-014 : 5 échecs => verrouillage (non modifiable sous 3 pour la sécurité)
    'auth.maxFailedLogins': 5,
    'auth.passwordMinLength': 12,
    'members.selfEditableFields': ['phone', 'address', 'emergencyContactName', 'emergencyContactPhone'],
    'files.maxUploadBytes': env().UPLOAD_MAX_BYTES,
    'certificates.expiringSoonDays': 90,
    'purchasing.allowOverAllocation': false,
  };
}

@Injectable()
export class SettingsService {
  private cache = new Map<string, { value: unknown; at: number }>();
  private static readonly TTL_MS = 15_000;

  constructor(private readonly prisma: PrismaService) {}

  async get<K extends SettingKey>(key: K): Promise<SettingValue<K>> {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < SettingsService.TTL_MS) return hit.value as SettingValue<K>;
    const row = await this.prisma.systemSetting.findUnique({ where: { key } });
    let value = defaults()[key] as SettingValue<K>;
    if (row) {
      const parsed = SETTINGS_SCHEMAS[key].safeParse(row.value);
      if (parsed.success) value = parsed.data as SettingValue<K>;
    }
    this.cache.set(key, { value, at: Date.now() });
    return value;
  }

  /** Bornes dépendant de l'environnement, affichées dans l'écran Paramètres. */
  limits() {
    return { 'files.maxUploadBytes': { max: env().UPLOAD_MAX_BYTES } };
  }

  async all(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(SETTINGS_SCHEMAS) as SettingKey[]) out[k] = await this.get(k);
    return out;
  }

  async set<K extends SettingKey>(key: K, value: unknown, actorId: string): Promise<SettingValue<K>> {
    const parsed = SETTINGS_SCHEMAS[key].parse(value) as SettingValue<K>;
    await this.prisma.systemSetting.upsert({
      where: { key },
      create: { key, value: parsed as never, updatedById: actorId },
      update: { value: parsed as never, updatedById: actorId },
    });
    this.cache.delete(key);
    return parsed;
  }
}
