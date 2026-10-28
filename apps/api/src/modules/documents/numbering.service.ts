import { Injectable } from '@nestjs/common';
import { Db, PrismaService } from '../../prisma/prisma.service';

/**
 * Numérotation métier atomique (PR, RFQ, BC, réceptions, voyages, références CSO).
 * UPSERT ... RETURNING : sûr en concurrence, sans trou visible dans une même transaction.
 */
@Injectable()
export class NumberingService {
  constructor(private readonly prisma: PrismaService) {}

  async next(key: string, db: Db = this.prisma): Promise<number> {
    const rows = await db.$queryRaw<{ value: number }[]>`
      INSERT INTO number_sequences (key, next_value, updated_at)
      VALUES (${key}, 2, now())
      ON CONFLICT (key) DO UPDATE SET next_value = number_sequences.next_value + 1, updated_at = now()
      RETURNING next_value - 1 AS value`;
    return Number(rows[0].value);
  }

  /** Ex. format('PR', 'ISK', 2026, 323) => "ISK-PR-2026-0323" */
  async nextFormatted(kind: string, scope: string, db: Db = this.prisma, pad = 4): Promise<string> {
    const year = new Date().getUTCFullYear();
    const seq = await this.next(`${kind}:${scope}:${year}`, db);
    return `${scope}-${kind}-${year}-${String(seq).padStart(pad, '0')}`;
  }
}
