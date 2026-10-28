import type { CsoDocument, CsoFolder, CsoLibrary, CsoVersion, PrincipalType, StoredFile } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import type { Db } from '../../prisma/prisma.service';
import { ActionMap, grantedActions } from './cso-acl.logic';

export function dateOnlyString(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export function presentLibrary(l: CsoLibrary, vessel?: { id: string; code: string; name: string } | null) {
  return { id: l.id, kind: l.kind, name: l.name, vessel: vessel ?? null };
}

export function presentFolder(f: CsoFolder, eff?: ActionMap) {
  return {
    id: f.id,
    libraryId: f.libraryId,
    parentId: f.parentId,
    name: f.name,
    depth: f.depth,
    status: f.status,
    inheritAcl: f.inheritAcl,
    archivedAt: f.archivedAt,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
    ...(eff ? { actions: grantedActions(eff) } : {}),
  };
}

export function presentFile(f: StoredFile | undefined | null) {
  if (!f) return null;
  return {
    originalName: f.originalName,
    kind: f.kind,
    mimeType: f.mimeType,
    extension: f.extension,
    sizeBytes: Number(f.sizeBytes),
    sha256: f.sha256,
    pageCount: f.pageCount,
    scanStatus: f.scanStatus,
  };
}

export function presentVersion(v: CsoVersion, users: Map<string, UserLabel>, file?: StoredFile | null) {
  return {
    id: v.id,
    documentId: v.documentId,
    versionNo: v.versionNo,
    status: v.status,
    changeNote: v.changeNote,
    isRestoration: v.isRestoration,
    lockVersion: v.lockVersion,
    submittedBy: users.get(v.submittedById) ?? { id: v.submittedById, displayName: null },
    submittedAt: v.submittedAt,
    decidedBy: v.decidedById ? users.get(v.decidedById) ?? { id: v.decidedById, displayName: null } : null,
    decidedAt: v.decidedAt,
    decisionComment: v.decisionComment,
    publishedAt: v.publishedAt,
    supersededAt: v.supersededAt,
    createdAt: v.createdAt,
    file: presentFile(file),
  };
}

export function presentDocumentSummary(
  d: CsoDocument,
  extra: {
    eff?: ActionMap;
    users?: Map<string, UserLabel>;
    category?: { id: string; code: string; name: string } | null;
    viaShare?: boolean;
  } = {},
) {
  return {
    id: d.id,
    libraryId: d.libraryId,
    folderId: d.folderId,
    vesselId: d.vesselId,
    reference: d.reference,
    title: d.title,
    description: d.description,
    status: d.status,
    category: extra.category ?? null,
    author: extra.users?.get(d.authorId) ?? { id: d.authorId, displayName: null },
    currentVersionId: d.currentVersionId,
    nextReviewOn: dateOnlyString(d.nextReviewOn),
    expiryOn: dateOnlyString(d.expiryOn),
    inheritAcl: d.inheritAcl,
    copiedFromId: d.copiedFromId,
    archivedAt: d.archivedAt,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    ...(extra.eff ? { actions: grantedActions(extra.eff) } : {}),
    ...(extra.viaShare ? { viaShare: true } : {}),
  };
}

export interface UserLabel {
  id: string;
  displayName: string | null;
}

export async function userLabels(db: Db, ids: (string | null | undefined)[]): Promise<Map<string, UserLabel>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map();
  const rows = await db.user.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } });
  return new Map(rows.map((r) => [r.id, r]));
}

export interface PrincipalLabel {
  principalType: PrincipalType;
  principalId: string;
  label: string | null;
}

/** Libellés des principaux (utilisateur, rôle, département) pour l'affichage des ACL. */
export async function principalLabels(db: Db, refs: { principalType: PrincipalType; principalId: string }[]) {
  const ids = (t: PrincipalType) => [...new Set(refs.filter((r) => r.principalType === t).map((r) => r.principalId))];
  const [users, roles, depts] = await Promise.all([
    ids('USER').length ? db.user.findMany({ where: { id: { in: ids('USER') } }, select: { id: true, displayName: true } }) : [],
    ids('ROLE').length ? db.role.findMany({ where: { id: { in: ids('ROLE') } }, select: { id: true, name: true } }) : [],
    ids('DEPARTMENT').length ? db.department.findMany({ where: { id: { in: ids('DEPARTMENT') } }, select: { id: true, name: true } }) : [],
  ]);
  const map = new Map<string, string>();
  users.forEach((u) => map.set(`USER:${u.id}`, u.displayName));
  roles.forEach((r) => map.set(`ROLE:${r.id}`, r.name));
  depts.forEach((d) => map.set(`DEPARTMENT:${d.id}`, d.name));
  return (type: PrincipalType, id: string) => map.get(`${type}:${id}`) ?? null;
}

/** Vérifie l'existence des principaux référencés (ACL, validateurs, ACL de champ). */
export async function assertPrincipalsExist(db: Db, refs: { principalType: PrincipalType; principalId: string }[]) {
  const label = await principalLabels(db, refs);
  const missing = refs.filter((r) => label(r.principalType, r.principalId) === null);
  if (missing.length) throw Errors.validation('Principal inconnu', { missing });
}

/** Violation d'unicité Prisma (P2002) ou SQL brut (23505). */
export function isUniqueViolation(e: unknown, target?: string): boolean {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    if (e.code === 'P2002') {
      if (!target) return true;
      const t = (e.meta?.target ?? '') as string | string[];
      return (Array.isArray(t) ? t.join(',') : String(t)).includes(target);
    }
    if (e.code === 'P2010') return String((e.meta as { code?: string } | undefined)?.code ?? e.message).includes('23505');
  }
  return /23505|unique constraint/i.test(String((e as Error)?.message ?? ''));
}
