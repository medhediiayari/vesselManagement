import { Injectable } from '@nestjs/common';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage, type Pagination } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CsoAccessService } from './cso-access.service';
import type { CreateShareDto } from './cso.dto';

const SHARE_SELECT = {
  id: true,
  documentId: true,
  sharedById: true,
  recipientUserId: true,
  recipientDepartmentId: true,
  message: true,
  allowDownload: true,
  createdAt: true,
  revokedAt: true,
  revokedById: true,
} as const;

/**
 * Partage interne authentifié (CSO-014..016) : jamais de lien public. Un partage n'accorde que
 * la consultation (et le téléchargement si autorisé ET si le destinataire possède cso.download) ;
 * il ne contourne jamais le scope navire, la permission module ni un DENY explicite
 * (évalué par CsoAccessService). Révocation ciblée ou globale, instantanée.
 */
@Injectable()
export class CsoSharesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CsoAccessService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  async create(ctx: AuthContext, dto: CreateShareDto) {
    const { doc, eff } = await this.access.assertDocument(ctx, dto.documentId, ['view', 'share'], { requireNotArchived: true });
    if (doc.status !== 'PUBLISHED') throw Errors.business('Seul un document publié peut être partagé');
    // On ne partage pas plus que ce que l'on possède soi-même
    if (dto.allowDownload && !eff.download) {
      throw Errors.forbidden('Vous ne pouvez pas autoriser un téléchargement dont vous ne disposez pas');
    }
    const userIds = [...new Set(dto.recipientUserIds)].filter((id) => id !== ctx.userId);
    const deptIds = [...new Set(dto.recipientDepartmentIds)];
    const [users, depts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds }, status: 'ACTIVE' }, select: { id: true } }),
      this.prisma.department.findMany({ where: { id: { in: deptIds }, status: 'ACTIVE' }, select: { id: true, name: true } }),
    ]);
    if (users.length !== userIds.length) throw Errors.validation('Destinataire inconnu ou inactif');
    if (depts.length !== deptIds.length) throw Errors.validation('Département inconnu ou inactif');
    if (!userIds.length && !deptIds.length) throw Errors.validation('Au moins un destinataire autre que vous-même');

    const shares = await this.prisma.$transaction(async (tx) => {
      const out = [];
      for (const recipient of [
        ...userIds.map((id) => ({ recipientUserId: id })),
        ...deptIds.map((id) => ({ recipientDepartmentId: id })),
      ]) {
        const existing = await tx.csoShare.findFirst({ where: { documentId: doc.id, revokedAt: null, ...recipient } });
        out.push(
          existing
            ? await tx.csoShare.update({
                where: { id: existing.id },
                data: { allowDownload: dto.allowDownload, message: dto.message ?? existing.message, sharedById: ctx.userId },
                select: SHARE_SELECT,
              })
            : await tx.csoShare.create({
                data: { documentId: doc.id, sharedById: ctx.userId, message: dto.message ?? null, allowDownload: dto.allowDownload, ...recipient },
                select: SHARE_SELECT,
              }),
        );
      }
      await this.audit.record(
        ctx,
        {
          action: 'cso.document_shared',
          module: 'cso',
          entityType: 'cso_document',
          entityId: doc.id,
          vesselId: doc.vesselId,
          after: { recipientUserIds: userIds, recipientDepartmentIds: deptIds, allowDownload: dto.allowDownload },
        },
        tx,
      );
      return out;
    });

    // Notification app + e-mail uniquement aux destinataires qui peuvent effectivement voir le document
    const candidates = await this.notifications.resolvePrincipals([
      ...userIds.map((id) => ({ type: 'USER' as const, id })),
      ...deptIds.map((id) => ({ type: 'DEPARTMENT' as const, id })),
    ]);
    const allowed = await this.access.usersAllowedOnDocument(candidates, doc, 'view', { excludeUserIds: [ctx.userId] });
    if (allowed.length) {
      await this.notifications.notify({
        userIds: allowed,
        type: 'cso.shared',
        title: `Document CSO partagé avec vous : ${doc.title}`,
        body: `${ctx.displayName} vous a partagé « ${doc.title} »${doc.reference ? ` (${doc.reference})` : ''}.${dto.message ? `\n${dto.message}` : ''}`,
        module: 'cso',
        entityType: 'cso_document',
        entityId: doc.id,
        vesselId: doc.vesselId,
        link: `/cso/documents/${doc.id}`,
        dedupeKey: `cso-share:${doc.id}:${shares.map((s) => s.id).sort().join(',').slice(0, 120)}`,
        email: true,
        requiredPermission: 'cso.view',
      });
    }
    return { shares, notifiedUsers: allowed.length };
  }

  /** Partages d'un document (actifs et révoqués) — visibles par qui peut partager / révoquer. */
  async listForDocument(ctx: AuthContext, documentId: string) {
    const { eff } = await this.access.assertDocument(ctx, documentId, ['view']);
    const shares = await this.prisma.csoShare.findMany({ where: { documentId }, orderBy: { createdAt: 'desc' }, select: SHARE_SELECT });
    if (!eff.share && !shares.some((s) => s.sharedById === ctx.userId)) throw Errors.aclDenied();
    return this.decorate(shares);
  }

  /** Révocation ciblée : l'auteur du partage, ou un utilisateur cso.revoke disposant du droit de partage. */
  async revoke(ctx: AuthContext, shareId: string) {
    const share = await this.prisma.csoShare.findUnique({ where: { id: shareId } });
    if (!share) throw Errors.notFound('Partage');
    const { doc, eff } = await this.access.assertDocument(ctx, share.documentId, ['view']);
    if (share.sharedById !== ctx.userId && !eff.share) throw Errors.aclDenied();
    if (share.revokedAt) throw Errors.alreadyProcessed('Partage déjà révoqué');
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.csoShare.updateMany({
        where: { id: shareId, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: ctx.userId },
      });
      if (res.count !== 1) throw Errors.alreadyProcessed('Partage déjà révoqué');
      await this.audit.record(
        ctx,
        { action: 'cso.share_revoked', module: 'cso', entityType: 'cso_document', entityId: doc.id, vesselId: doc.vesselId, metadata: { shareId } },
        tx,
      );
      return tx.csoShare.findUniqueOrThrow({ where: { id: shareId }, select: SHARE_SELECT });
    });
    return updated;
  }

  /** Révocation globale instantanée de tous les partages actifs d'un document (droits indépendants intacts). */
  async revokeAll(ctx: AuthContext, documentId: string) {
    const { doc } = await this.access.assertDocument(ctx, documentId, ['view', 'share']);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.csoShare.updateMany({
        where: { documentId, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: ctx.userId },
      });
      await this.audit.record(
        ctx,
        { action: 'cso.shares_revoked_all', module: 'cso', entityType: 'cso_document', entityId: doc.id, vesselId: doc.vesselId, metadata: { count: res.count } },
        tx,
      );
      return { revoked: res.count };
    });
  }

  /** « Partagés avec moi » : partages actifs dont le document reste effectivement visible. */
  async sharedWithMe(ctx: AuthContext, p: Pagination) {
    const rows = await this.prisma.csoShare.findMany({
      where: {
        revokedAt: null,
        OR: [{ recipientUserId: ctx.userId }, ...(ctx.departmentIds.length ? [{ recipientDepartmentId: { in: ctx.departmentIds } }] : [])],
        document: { status: 'PUBLISHED' },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...cursorArgs(p),
      select: {
        ...SHARE_SELECT,
        document: {
          select: {
            id: true,
            libraryId: true,
            folderId: true,
            status: true,
            authorId: true,
            inheritAcl: true,
            title: true,
            reference: true,
            vesselId: true,
            updatedAt: true,
            currentVersionId: true,
          },
        },
      },
    });
    const page = toPage(rows, p);
    const { visible, eff } = await this.access.filterVisibleDocuments(ctx, page.items.map((r) => r.document));
    const visibleIds = new Set(visible.map((d) => d.id));
    const [sharers, currentVersions] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: [...new Set(page.items.map((r) => r.sharedById))] } },
        select: { id: true, displayName: true },
      }),
      this.prisma.csoVersion.findMany({
        where: { id: { in: visible.map((d) => d.currentVersionId).filter((x): x is string => !!x) } },
        select: { id: true, fileId: true },
      }),
    ]);
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: currentVersions.map((v) => v.fileId) } }, select: { id: true, kind: true } });
    // Type du fichier officiel : l'aperçu n'est proposé que pour un PDF / une image (CSO-14)
    const kindOf = (versionId: string | null) => {
      const v = currentVersions.find((x) => x.id === versionId);
      return (v && files.find((f) => f.id === v.fileId)?.kind) ?? null;
    };
    return {
      nextCursor: page.nextCursor,
      items: page.items
        .filter((r) => visibleIds.has(r.documentId))
        .map((r) => ({
          id: r.id,
          message: r.message,
          allowDownload: r.allowDownload,
          canDownload: !!eff.get(r.documentId)?.download,
          canPreview: !!eff.get(r.documentId)?.preview,
          createdAt: r.createdAt,
          sharedBy: sharers.find((u) => u.id === r.sharedById) ?? null,
          document: {
            id: r.document.id,
            title: r.document.title,
            reference: r.document.reference,
            vesselId: r.document.vesselId,
            updatedAt: r.document.updatedAt,
            fileKind: kindOf(r.document.currentVersionId),
          },
        })),
    };
  }

  private async decorate<T extends { sharedById: string; recipientUserId: string | null; recipientDepartmentId: string | null; revokedById: string | null }>(shares: T[]) {
    const userIds = [...new Set(shares.flatMap((s) => [s.sharedById, s.recipientUserId, s.revokedById]).filter((x): x is string => !!x))];
    const deptIds = [...new Set(shares.map((s) => s.recipientDepartmentId).filter((x): x is string => !!x))];
    const [users, depts] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, displayName: true } }),
      this.prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }),
    ]);
    const u = new Map(users.map((x) => [x.id, x.displayName]));
    const dn = new Map(depts.map((x) => [x.id, x.name]));
    return shares.map((s) => ({
      ...s,
      sharedByName: u.get(s.sharedById) ?? null,
      recipientName: s.recipientUserId ? u.get(s.recipientUserId) ?? null : s.recipientDepartmentId ? dn.get(s.recipientDepartmentId) ?? null : null,
      revokedByName: s.revokedById ? u.get(s.revokedById) ?? null : null,
    }));
  }
}
