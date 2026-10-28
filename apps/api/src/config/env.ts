import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().default(4000),
  WEB_ORIGIN: z.string().default('http://localhost:3100'),
  APP_BASE_URL: z.string().default('http://localhost:3100'),
  COOKIE_SECURE: bool,
  /**
   * Proxys de confiance pour X-Forwarded-For (express « trust proxy ») : par défaut réseaux privés
   * uniquement (front Next.js / reverse proxy interne), jamais une IP publique usurpable.
   */
  TRUST_PROXY: z.string().default('loopback, linklocal, uniquelocal'),
  /** Documentation Swagger exposée (désactivée par défaut en production). */
  SWAGGER_ENABLED: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v === 'true' || v === '1')),
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().positive().default(720),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(60),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.string().url(),
  S3_PUBLIC_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool,
  S3_BUCKET_FILES: z.string().default('amc-files'),
  S3_BUCKET_QUARANTINE: z.string().default('amc-quarantine'),
  S3_BUCKET_EXPORTS: z.string().default('amc-exports'),
  FILE_DELIVERY_MODE: z.enum(['presigned', 'proxy']).default('presigned'),
  SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(10).max(900).default(60),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(50 * 1024 * 1024),

  AV_MODE: z.enum(['disabled', 'clamav']).default('disabled'),
  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  REDIS_URL: z.string().default('redis://localhost:6380'),
  WORKERS_ENABLED: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),

  EMAIL_MODE: z.enum(['smtp', 'disabled']).default('smtp'),
  SMTP_HOST: z.string().default('localhost'),
  SMTP_PORT: z.coerce.number().int().default(1025),
  SMTP_SECURE: bool,
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('AMC Platform <no-reply@amc.local>'),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Configuration validée au démarrage : l'API refuse de démarrer sur une config invalide. */
export function env(): Env {
  if (!cached) {
    const parsed = EnvSchema.safeParse(process.env);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      throw new Error(`Configuration invalide : ${issues}`);
    }
    cached = parsed.data;
  }
  return cached;
}
