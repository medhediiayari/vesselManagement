/**
 * Échappe les jokers LIKE (`\`, `%`, `_`) avant un `contains` / `startsWith` Prisma, qui les transmet
 * tels quels à PostgreSQL (ADM-22) : `%` doit chercher un « % », pas « n'importe quoi ».
 */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Filtre `contains` insensible à la casse, jokers échappés. */
export function containsText(s: string) {
  return { contains: escapeLike(s), mode: 'insensitive' as const };
}
