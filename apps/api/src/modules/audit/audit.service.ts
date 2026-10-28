import { Injectable, Logger } from '@nestjs/common';
import { AuditResult, Prisma } from '@prisma/client';
import { Db, PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';

export type AuditModule =
  | 'admin'
  | 'auth'
  | 'fleet'
  | 'members'
  | 'certificates'
  | 'cso'
  | 'purchasing'
  | 'voyages'
  | 'noon'
  | 'platform';

export interface AuditInput {
  action: string;
  module: AuditModule;
  entityType: string;
  entityId?: string | null;
  vesselId?: string | null;
  result?: AuditResult;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** Clés jamais journalisées en clair (CDC §11.1 : logs sans mot de passe, tokens, secrets). */
const SENSITIVE_KEYS = /password|passwordhash|token|secret|tokenhash|csrf|cookie|authorization/i;
const MAX_STRING = 2_000;

export function maskSensitive(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth]';
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Prisma.Decimal.isDecimal(value)) return (value as Prisma.Decimal).toString();
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (Array.isArray(value)) return value.slice(0, 200).map((v) => maskSensitive(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[masqué]' : maskSensitive(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** Ne conserve que les champs modifiés entre deux états (lecture plus simple de l'audit). */
export function diffFields(before: Record<string, unknown> | null | undefined, after: Record<string, unknown> | null | undefined) {
  if (!before || !after) return { before, after };
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const vb = JSON.stringify(maskSensitive(before[key]));
    const va = JSON.stringify(maskSensitive(after[key]));
    if (vb !== va) {
      b[key] = before[key];
      a[key] = after[key];
    }
  }
  return { before: b, after: a };
}

/**
 * Audit Log transversal append-only (ADM-011). Écrit dans la transaction métier quand `db`
 * est une transaction : l'événement n'existe que si le changement est commité.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger('Audit');

  constructor(private readonly prisma: PrismaService) {}

  async record(ctx: AuthContext | null, input: AuditInput, db: Db = this.prisma): Promise<void> {
    await db.auditEvent.create({
      data: {
        actorId: ctx?.userId ?? null,
        actorLabel: ctx ? `${ctx.displayName} (${ctx.username})` : 'system',
        action: input.action,
        module: input.module,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        vesselId: input.vesselId ?? null,
        result: input.result ?? 'SUCCESS',
        before: toJson(input.before),
        after: toJson(input.after),
        metadata: toJson(input.metadata),
        ip: ctx?.ip ?? null,
        userAgent: ctx?.userAgent?.slice(0, 400) ?? null,
        // Contexte pré-session (login) : sessionId vide => null
        sessionId: ctx?.sessionId || null,
        requestId: ctx?.requestId || null,
      },
    });
  }

  /** Variante non bloquante (refus d'accès, consultations) : ne fait jamais échouer la requête. */
  recordAsync(ctx: AuthContext | null, input: AuditInput): void {
    this.record(ctx, input).catch((e) => this.logger.error(`Échec écriture audit ${input.action}: ${String(e)}`));
  }

  /** Événement système (jobs, rappels) sans acteur humain. */
  async system(input: AuditInput, db: Db = this.prisma): Promise<void> {
    await this.record(null, input, db);
  }
}

function toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (v === undefined || v === null) return Prisma.JsonNull;
  return maskSensitive(v) as Prisma.InputJsonValue;
}
