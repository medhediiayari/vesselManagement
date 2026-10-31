import type { Db } from '../../prisma/prisma.service';

/** Auteur d'un élément, affiché tel quel : nom et rôles, pour savoir qui l'a créé avant d'y toucher. */
export interface CreatorLabel {
  id: string;
  name: string;
  roles: string[];
}

/** Libellés « nom + rôles » des créateurs, en une seule requête (pas de N+1). */
export async function creatorLabels(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, CreatorLabel>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, displayName: true, roles: { select: { role: { select: { name: true } } } } },
  });
  return new Map(
    rows.map((u) => [u.id, { id: u.id, name: u.displayName, roles: u.roles.map((r) => r.role.name).sort((a, b) => a.localeCompare(b, 'fr')) }]),
  );
}
