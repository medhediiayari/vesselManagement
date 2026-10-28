import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

export type Tx = Prisma.TransactionClient;

/**
 * Conflit de sérialisation PostgreSQL (40001) : levé par une requête Prisma (P2034) ou par du SQL brut
 * ($queryRaw / $executeRaw -> P2010 avec meta.code 40001).
 */
export function isSerializationFailure(e: unknown): boolean {
  const err = e as { code?: string; meta?: { code?: string }; message?: string };
  if (err?.code === 'P2034' || err?.code === '40001') return true;
  if (err?.code === 'P2010' && (err.meta?.code === '40001' || /could not serialize/i.test(err.message ?? ''))) return true;
  return false;
}
/** Client utilisable hors transaction ou dans une transaction interactive. */
export type Db = PrismaClient | Tx;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({ log: [{ emit: 'stdout', level: 'warn' }, { emit: 'stdout', level: 'error' }] });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /**
   * Transaction SERIALIZABLE avec reprise automatique sur conflit de sérialisation (40001)
   * — utilisée pour les approbations et changements d'état concurrents (CDC §1.1).
   */
  async serializable<T>(fn: (tx: Tx) => Promise<T>, retries = 3): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.$transaction(fn, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 20_000,
        });
      } catch (e) {
        if (attempt < retries && isSerializationFailure(e)) continue;
        throw e;
      }
    }
  }
}
