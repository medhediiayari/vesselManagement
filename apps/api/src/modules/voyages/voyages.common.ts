import { Prisma, Voyage } from '@prisma/client';
import { Db } from '../../prisma/prisma.service';
import type { AccessService } from '../access/access.service';
import { AuthContext, can, canAccessVessel } from '../access/auth-context';
import { toFileDto } from '../files/files.service';

/** Types propriétaires de fichiers du module (resolvers enregistrés dans onModuleInit). */
export const OWNER_VOYAGE_FILE = 'voyage_file';
export const OWNER_CP_VERSION = 'cp_version';
export const OWNER_VOYAGE_INSTRUCTION = 'voyage_instruction';
export const OWNER_TASK_EVIDENCE = 'voyage_task_evidence';
export const OWNER_NOR_RECORD = 'nor_record';

/**
 * Filtre de périmètre des Charter Parties : CP du navire accessible, ou CP sans navire
 * rattachée à un voyage d'un navire accessible. Toute la flotte : aucun filtre.
 */
export function cpScopeWhere(ctx: AuthContext): Prisma.CharterPartyWhereInput {
  if (ctx.vesselScope.mode === 'ALL_FLEET') return {};
  const ids = ctx.vesselScope.vesselIds;
  return { OR: [{ vesselId: { in: ids } }, { vesselId: null, voyages: { some: { vesselId: { in: ids } } } }] };
}

export function canAccessCp(ctx: AuthContext, cp: { vesselId: string | null; voyages?: { vesselId: string }[] }): boolean {
  if (ctx.vesselScope.mode === 'ALL_FLEET') return true;
  if (cp.vesselId) return canAccessVessel(ctx, cp.vesselId);
  return (cp.voyages ?? []).some((v) => canAccessVessel(ctx, v.vesselId));
}

/**
 * Destinataires couverts par le périmètre d'une CP (même règle que canAccessCp) : « toute la
 * flotte », ou accès au navire de la CP / d'un voyage rattaché (CP sans navire). Indispensable
 * car NotificationsService ne contrôle pas le scope lorsque vesselId est null.
 */
export async function filterCpAudience(
  db: Db,
  cp: { vesselId: string | null; voyages: { vesselId: string }[] },
  userIds: string[],
): Promise<string[]> {
  const ids = [...new Set(userIds)];
  if (!ids.length) return [];
  const vesselIds = cp.vesselId ? [cp.vesselId] : [...new Set(cp.voyages.map((v) => v.vesselId))];
  const rows = await db.user.findMany({
    where: {
      id: { in: ids },
      OR: [{ vesselScope: 'ALL_FLEET' }, ...(vesselIds.length ? [{ vesselAccess: { some: { vesselId: { in: vesselIds } } } }] : [])],
    },
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

/** Masque le rattachement CP (confidentiel) aux utilisateurs sans charter_party.view. */
export function serializeVoyage<T extends Pick<Voyage, 'charterPartyId'>>(ctx: AuthContext, v: T): T & { charterPartyRestricted?: boolean } {
  if (can(ctx, 'charter_party.view')) return v;
  return { ...v, charterPartyId: null, charterPartyRestricted: v.charterPartyId !== null };
}

/** Fichiers d'un voyage (archivage logique : colonnes archived_at / archived_by_id, migration 0050). */
export async function loadVoyageFiles(db: Db, voyageId: string, includeArchived: boolean) {
  const rows = await db.voyageFile.findMany({
    where: { voyageId, ...(includeArchived ? {} : { archivedAt: null }) },
    orderBy: { createdAt: 'desc' },
  });
  if (!rows.length) return [];
  const [files, users] = await Promise.all([
    db.storedFile.findMany({ where: { id: { in: rows.map((r) => r.fileId) } } }),
    db.user.findMany({
      where: { id: { in: [...new Set(rows.flatMap((r) => [r.uploadedById, r.archivedById]).filter((x): x is string => !!x))] } },
      select: { id: true, displayName: true },
    }),
  ]);
  const name = (id: string | null) => (id ? users.find((u) => u.id === id)?.displayName ?? null : null);
  return rows.map((r) => {
    const f = files.find((x) => x.id === r.fileId);
    return {
      ...r,
      uploadedBy: name(r.uploadedById),
      archivedBy: name(r.archivedById),
      file: f ? toFileDto(f) : null,
    };
  });
}

/**
 * Masters / délégués à bord attendus pour un accusé de lecture : autorité de reporting du
 * navire (noon.submit + accès au navire) ET périmètre restreint à des navires désignés
 * (les comptes terre / Super Admin « toute la flotte » ne sont pas des Masters).
 */
export async function onboardMasters(access: AccessService, db: Db, vesselId: string): Promise<string[]> {
  const ids = await access.usersWithPermission('noon.submit', vesselId, db);
  if (!ids.length) return [];
  const rows = await db.user.findMany({ where: { id: { in: ids }, vesselScope: 'SELECTED' }, select: { id: true } });
  return rows.map((r) => r.id);
}

/** Libellés utilisateur (une seule requête, pas de N+1). */
export async function userLabels(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
  return new Map(rows.map((u) => [u.id, u.displayName]));
}
