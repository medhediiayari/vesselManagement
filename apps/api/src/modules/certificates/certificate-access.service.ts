import { Injectable } from '@nestjs/common';
import { CertificateRequestKind, Prisma } from '@prisma/client';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, principalsOf, vesselWhere } from '../access/auth-context';
import { VISIBLE_ASSIGNMENT_STATUSES, assertMemberVisible, isMemberVisible, memberVisibilityWhere } from '../access/member-access';
import { NotificationsService } from '../notifications/notifications.service';
import { Actor, ValidatorRef, approvalPermissionFor, isEligibleValidator, isRequestSupervisor } from './certificate.logic';

/** Titulaire d'un certificat : suffisant pour toutes les décisions de visibilité. */
export interface CertificateSubjectRef {
  id: string;
  subjectKind: 'VESSEL' | 'MEMBER';
  vesselId: string | null;
  memberId: string | null;
}

export const CERT_VIEW = 'certificates.view';
export const MEMBER_CERT_VIEW = 'members.certificates.view';

export function actorOf(ctx: AuthContext): Actor {
  return { userId: ctx.userId, permissions: ctx.permissions, principals: principalsOf(ctx) };
}

/**
 * Formule d'autorisation des certificats (CDC §2.1, §4.6) :
 *  - VESSEL : `certificates.view` + navire dans le scope de l'utilisateur ;
 *  - MEMBER : `certificates.view` + `members.certificates.view` + fiche visible selon ADM-070
 *    (moindre privilège : jamais toute la carrière automatiquement).
 * Appliquée aux listes (filtre Prisma), au détail, aux fichiers, aux notifications et aux
 * destinataires de rappels (jamais de notification à un destinataire sans droit réel — CDC §9).
 */
@Injectable()
export class CertificateAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  canSeeMemberCertificates(ctx: AuthContext): boolean {
    return can(ctx, CERT_VIEW) && can(ctx, MEMBER_CERT_VIEW);
  }

  /** Filtre Prisma des certificats visibles par l'appelant (listes, recherche, compteurs). */
  visibleWhere(ctx: AuthContext): Prisma.CertificateWhereInput {
    const ors: Prisma.CertificateWhereInput[] = [];
    if (can(ctx, CERT_VIEW)) ors.push({ subjectKind: 'VESSEL', ...(vesselWhere(ctx) as Prisma.CertificateWhereInput) });
    if (this.canSeeMemberCertificates(ctx)) ors.push({ subjectKind: 'MEMBER', member: memberVisibilityWhere(ctx) });
    if (!ors.length) return { id: { in: [] } };
    return { OR: ors };
  }

  /** 403 si le certificat (déjà chargé) est hors des droits de l'appelant — revérifié à chaque appel (CERT-08). */
  async assertVisible(ctx: AuthContext, cert: CertificateSubjectRef, db: Db = this.prisma): Promise<void> {
    this.access.assertCan(ctx, CERT_VIEW);
    if (cert.subjectKind === 'VESSEL') {
      this.access.assertVesselAccess(ctx, cert.vesselId);
      return;
    }
    this.access.assertCan(ctx, MEMBER_CERT_VIEW);
    await assertMemberVisible(db, ctx, cert.memberId!);
  }

  async isVisible(ctx: AuthContext, cert: CertificateSubjectRef, db: Db = this.prisma): Promise<boolean> {
    if (!can(ctx, CERT_VIEW)) return false;
    if (cert.subjectKind === 'VESSEL') return ctx.vesselScope.mode === 'ALL_FLEET' || ctx.vesselScope.vesselIds.includes(cert.vesselId ?? '');
    if (!can(ctx, MEMBER_CERT_VIEW)) return false;
    return isMemberVisible(db, ctx, cert.memberId!);
  }

  /** L'appelant peut-il décider sur cette demande ? (scope vérifié séparément par assertVisible) */
  isEligible(
    ctx: AuthContext,
    request: { kind: CertificateRequestKind; requestedById: string; uploadedById?: string | null },
    validators: ValidatorRef[],
  ): boolean {
    return isEligibleValidator(actorOf(ctx), request, validators);
  }

  /** Annulation de supervision d'une demande d'autrui (validateur éligible ou administrateur des types). */
  isSupervisor(
    ctx: AuthContext,
    request: { kind: CertificateRequestKind; requestedById: string; uploadedById?: string | null },
    validators: ValidatorRef[],
  ): boolean {
    return isRequestSupervisor(actorOf(ctx), request, validators);
  }

  /** Filtre Prisma des demandes en attente que l'appelant peut valider (boîte « à approuver »). */
  approvableRequestsWhere(ctx: AuthContext): Prisma.CertificateApprovalRequestWhereInput {
    const ors: Prisma.CertificateApprovalRequestWhereInput[] = [];
    if (can(ctx, 'certificates.approve')) {
      const principals = principalsOf(ctx).map((p) => ({ principalType: p.type, principalId: p.id }));
      ors.push({
        kind: { not: 'ATTACHMENT' },
        certificate: { type: { OR: [{ validators: { none: {} } }, { validators: { some: { OR: principals } } }] } },
      });
    }
    if (can(ctx, 'certificates.attachments.approve')) {
      ors.push({ kind: 'ATTACHMENT', attachment: { uploadedById: { not: ctx.userId } } });
    }
    if (!ors.length) return { id: { in: [] } };
    return {
      AND: [
        { status: 'PENDING_APPROVAL', requestedById: { not: ctx.userId } },
        { certificate: { AND: [this.visibleWhere(ctx), { archivedAt: null }] } },
        { OR: ors },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Autres utilisateurs (validateurs, destinataires de notifications)
  // ---------------------------------------------------------------------------

  /** Parmi `userIds`, ceux qui peuvent réellement lire le certificat (permission + scope / ADM-070). */
  async filterReaders(db: Db, cert: CertificateSubjectRef, userIds: string[]): Promise<string[]> {
    const unique = [...new Set(userIds)];
    if (!unique.length) return [];
    const viewers = await this.access.usersWithPermission(
      CERT_VIEW,
      cert.subjectKind === 'VESSEL' ? cert.vesselId : null,
      db,
      unique,
    );
    if (cert.subjectKind === 'VESSEL' || !viewers.length) return viewers;
    const memberReaders = await this.access.usersWithPermission(MEMBER_CERT_VIEW, null, db, viewers);
    return this.filterUsersSeeingMember(db, cert.memberId!, memberReaders);
  }

  /** Équivalent de memberVisibilityWhere (ADM-070) évalué pour d'autres utilisateurs. */
  async filterUsersSeeingMember(db: Db, memberId: string, userIds: string[]): Promise<string[]> {
    if (!userIds.length) return [];
    const [crossVessel, assignments, users] = await Promise.all([
      this.access.usersWithPermission('members.cross_vessel.view', null, db, userIds),
      db.crewAssignment.findMany({
        where: { memberId, status: { in: [...VISIBLE_ASSIGNMENT_STATUSES] } },
        select: { vesselId: true },
      }),
      db.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, vesselScope: true, memberId: true, vesselAccess: { select: { vesselId: true } } },
      }),
    ]);
    const cross = new Set(crossVessel);
    const vessels = new Set(assignments.map((a) => a.vesselId));
    return users
      .filter(
        (u) =>
          cross.has(u.id) ||
          u.memberId === memberId ||
          (vessels.size > 0 && (u.vesselScope === 'ALL_FLEET' || u.vesselAccess.some((a) => vessels.has(a.vesselId)))),
      )
      .map((u) => u.id);
  }

  /**
   * Validateurs éligibles d'une demande (ADM-051/055) : permission d'approbation + accès au
   * certificat + désignés par la configuration du type (données). Le demandeur est exclu.
   */
  async eligibleValidatorIds(
    db: Db,
    cert: CertificateSubjectRef,
    request: { kind: CertificateRequestKind; requestedById: string; uploadedById?: string | null },
    validators: ValidatorRef[],
    excludeUserIds: string[] = [],
  ): Promise<string[]> {
    let ids = await this.access.usersWithPermission(
      approvalPermissionFor(request.kind),
      cert.subjectKind === 'VESSEL' ? cert.vesselId : null,
      db,
    );
    if (request.kind !== 'ATTACHMENT' && validators.length) {
      const designated = new Set(
        await this.notifications.resolvePrincipals(
          validators.map((v) => ({ type: v.principalType, id: v.principalId })),
          db,
        ),
      );
      ids = ids.filter((id) => designated.has(id));
    }
    const excluded = new Set([request.requestedById, ...(request.uploadedById ? [request.uploadedById] : []), ...excludeUserIds]);
    ids = ids.filter((id) => !excluded.has(id));
    return this.filterReaders(db, cert, ids);
  }

  /** Permission plateforme exigée des destinataires de notifications sur ce certificat. */
  readerPermission(cert: CertificateSubjectRef): string {
    return cert.subjectKind === 'VESSEL' ? CERT_VIEW : MEMBER_CERT_VIEW;
  }
}
