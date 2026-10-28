import { Injectable } from '@nestjs/common';
import { Prisma, type PrStatus } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';
import { memberVisibilityWhere } from '../access/member-access';
import { canAccessVersion } from '../cso/cso-acl.logic';
import { CsoAccessService } from '../cso/cso-access.service';
import { SettingsService } from '../settings/settings.service';
import { poOwnFilter, prOwnFilter } from '../purchasing/purchasing-core.service';
import { cpScopeWhere } from '../voyages/voyages.common';

const DAY = 86_400_000;
/** Borne du parcours CSO : au-delà, les compteurs sont signalés comme partiels (`truncated`). */
const CSO_SCAN = 2000;
const PR_OPEN: PrStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'REVISED', 'APPROVED', 'SOURCING', 'PARTIALLY_ORDERED'];

function utcToday(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}

/**
 * Tableau de bord global ou filtré par navire (CDC §9) : chaque bloc n'est calculé
 * que si l'utilisateur possède la permission du module, et toujours dans son scope navire.
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly csoAccess: CsoAccessService,
  ) {}

  /** Intersection navires demandés ∩ scope ; null = toute la flotte accessible (ALL_FLEET). */
  private resolveVessels(ctx: AuthContext, requested: string[]): string[] | null {
    const scope = ctx.vesselScope.mode === 'ALL_FLEET' ? null : ctx.vesselScope.vesselIds;
    if (!requested.length) return scope;
    if (scope) {
      const out = requested.filter((id) => scope.includes(id));
      if (out.length !== requested.length) throw Errors.scopeDenied();
      return out;
    }
    return requested;
  }

  async overview(ctx: AuthContext, requestedVesselIds: string[]) {
    const vessels = this.resolveVessels(ctx, requestedVesselIds);
    const vesselIn = vessels ? { in: vessels } : undefined;
    const today = utcToday();
    const result: Record<string, unknown> = { generatedAt: new Date().toISOString(), vesselFilter: vessels };

    if (can(ctx, 'certificates.view')) result.certificates = await this.certificates(ctx, vesselIn, today);
    result.approvals = await this.approvals(ctx, vesselIn);
    if (can(ctx, 'pr.view') || can(ctx, 'bc.view')) result.purchasing = await this.purchasing(ctx, vesselIn, today);
    if (can(ctx, 'voyages.view')) result.voyages = await this.voyages(ctx, vesselIn, today);
    if (can(ctx, 'cso.view')) result.cso = await this.cso(ctx, vesselIn, today);
    result.myTasks = await this.myTasks(ctx, vesselIn);
    return result;
  }

  private certificateWhere(ctx: AuthContext, vesselIn: { in: string[] } | undefined): Prisma.CertificateWhereInput {
    const vesselBranch: Prisma.CertificateWhereInput = { subjectKind: 'VESSEL', ...(vesselIn ? { vesselId: vesselIn } : {}) };
    const branches: Prisma.CertificateWhereInput[] = [vesselBranch];
    // Certificats Members : uniquement avec la permission dédiée et selon ADM-070 ; pas de filtre navire explicite
    if (can(ctx, 'members.certificates.view') && !vesselIn) {
      branches.push({ subjectKind: 'MEMBER', member: memberVisibilityWhere(ctx) });
    } else if (can(ctx, 'members.certificates.view') && vesselIn) {
      branches.push({
        subjectKind: 'MEMBER',
        member: { AND: [memberVisibilityWhere(ctx), { crewAssignments: { some: { vesselId: vesselIn, status: { in: ['PLANNED', 'ONBOARD'] } } } }] },
      });
    }
    return { archivedAt: null, currentRevisionId: { not: null }, OR: branches };
  }

  private async certificates(ctx: AuthContext, vesselIn: { in: string[] } | undefined, today: Date) {
    const base = this.certificateWhere(ctx, vesselIn);
    const dated = (from: Date | null, to: Date | null): Prisma.CertificateWhereInput => ({
      AND: [base, { currentExpiryKind: 'DATED', currentExpiryOn: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } }],
    });
    const plus = (d: number) => new Date(today.getTime() + d * DAY);
    const soon = Number(await this.settings.get('certificates.expiringSoonDays'));
    const [expired, in30, in60, in90, expiringSoon, valid, unlimited, missing, unknown, renewal, pending] = await Promise.all([
      this.prisma.certificate.count({ where: dated(null, today) }),
      this.prisma.certificate.count({ where: dated(today, plus(31)) }),
      this.prisma.certificate.count({ where: dated(plus(31), plus(61)) }),
      this.prisma.certificate.count({ where: dated(plus(61), plus(91)) }),
      // Mêmes bornes que les filtres de validité de l'explorateur (seuil « expire bientôt » paramétré)
      this.prisma.certificate.count({ where: dated(today, plus(soon + 1)) }),
      this.prisma.certificate.count({ where: dated(plus(soon + 1), null) }),
      this.prisma.certificate.count({ where: { AND: [base, { currentExpiryKind: 'UNLIMITED' }] } }),
      // Aligné sur /certificates/compliance : seuls les types exigeant un document comptent comme « manquant »
      this.prisma.certificate.count({ where: { AND: [base, { documentMissing: true, type: { requiresDocument: true } }] } }),
      this.prisma.certificate.count({ where: { AND: [base, { currentExpiryKind: 'UNKNOWN' }] } }),
      this.prisma.certificate.count({ where: { AND: [base, { renewalStatus: 'IN_PROGRESS' }] } }),
      this.prisma.certificateApprovalRequest.count({ where: { status: 'PENDING_APPROVAL', certificate: base } }),
    ]);

    // Horizon des échéances : expirés (≤ 30 j de retard) et à venir (≤ 90 j)
    const horizonRows = await this.prisma.certificate.findMany({
      where: dated(plus(-30), plus(91)),
      orderBy: { currentExpiryOn: 'asc' },
      take: 60,
      select: {
        id: true,
        subjectKind: true,
        currentExpiryOn: true,
        renewalStatus: true,
        documentMissing: true,
        type: { select: { code: true, name: true } },
        vessel: { select: { id: true, code: true, name: true } },
        member: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    const horizon = horizonRows.map((c) => ({
      id: c.id,
      subjectKind: c.subjectKind,
      typeCode: c.type.code,
      typeName: c.type.name,
      subject: c.vessel ? `${c.vessel.name}` : c.member ? `${c.member.lastName} ${c.member.firstName}` : '—',
      vesselCode: c.vessel?.code ?? null,
      expiryOn: c.currentExpiryOn,
      daysLeft: c.currentExpiryOn ? Math.round((c.currentExpiryOn.getTime() - today.getTime()) / DAY) : null,
      renewalStatus: c.renewalStatus,
      documentMissing: c.documentMissing,
    }));
    return {
      expired,
      expiringWithin30: in30,
      expiring31to60: in60,
      expiring61to90: in90,
      // Partition des certificats courants selon les statuts de validité de l'explorateur
      validity: { valid, expiringSoon, expired, unlimited, expiryUnknown: unknown },
      documentMissing: missing,
      expiryUnknown: unknown,
      renewalInProgress: renewal,
      pendingApprovals: pending,
      expiringSoonDays: soon,
      horizon,
    };
  }

  /** Validations en attente qui concernent l'utilisateur (hors ses propres demandes : self-approval interdit). */
  private async approvals(ctx: AuthContext, vesselIn: { in: string[] } | undefined) {
    const out: Record<string, number> = {};
    if (can(ctx, 'certificates.approve')) {
      out.certificates = await this.prisma.certificateApprovalRequest.count({
        where: {
          status: 'PENDING_APPROVAL',
          requestedById: { not: ctx.userId },
          certificate: this.certificateWhere(ctx, vesselIn),
        },
      });
    }
    if (can(ctx, 'cso.approve')) {
      // Versions en attente sur des documents où l'utilisateur dispose réellement de l'action « approve » (ACL)
      const pending = await this.prisma.csoVersion.findMany({
        where: {
          status: 'PENDING_APPROVAL',
          submittedById: { not: ctx.userId },
          document: vesselIn ? { OR: [{ vesselId: vesselIn }, { vesselId: null }] } : ctx.vesselScope.mode === 'ALL_FLEET' ? {} : { OR: [{ vesselId: { in: ctx.vesselScope.vesselIds } }, { vesselId: null }] },
        },
        select: { document: { select: { id: true, libraryId: true, folderId: true, status: true, authorId: true, inheritAcl: true } } },
        take: 500,
      });
      const docs = [...new Map(pending.map((p) => [p.document.id, p.document])).values()];
      const { eff } = await this.csoAccess.documentsAccess(ctx, docs);
      out.csoDocuments = pending.filter((p) => eff.get(p.document.id)?.approve).length;
    }
    const scopeVessel = vesselIn ?? (ctx.vesselScope.mode === 'ALL_FLEET' ? undefined : { in: ctx.vesselScope.vesselIds });
    if (can(ctx, 'pr.approve')) {
      out.purchaseRequests = await this.prisma.purchaseRequest.count({
        where: { status: { in: ['SUBMITTED', 'UNDER_REVIEW', 'REVISED'] }, requesterId: { not: ctx.userId }, ...(scopeVessel ? { vesselId: scopeVessel } : {}) },
      });
    }
    if (can(ctx, 'bc.approve')) {
      out.purchaseOrders = await this.prisma.purchaseOrder.count({
        where: { status: 'APPROVAL_PENDING', createdById: { not: ctx.userId }, ...(scopeVessel ? { vesselId: scopeVessel } : {}) },
      });
    }
    if (can(ctx, 'charter_party.approve') && can(ctx, 'charter_party.view')) {
      out.charterParties = await this.prisma.cpVersion.count({
        where: { status: 'PENDING_APPROVAL', submittedById: { not: ctx.userId }, charterParty: cpScopeWhere(ctx) },
      });
    }
    return out;
  }

  private async purchasing(ctx: AuthContext, vesselIn: { in: string[] } | undefined, today: Date) {
    const scopeVessel = vesselIn ?? (ctx.vesselScope.mode === 'ALL_FLEET' ? undefined : { in: ctx.vesselScope.vesselIds });
    const vw = scopeVessel ? { vesselId: scopeVessel } : {};
    // « Ses propres PR » (sans pr.view_all) : mêmes filtres que les listes Achats
    const prw = { ...vw, ...prOwnFilter(ctx) };
    const pow = { ...vw, ...poOwnFilter(ctx) };
    const [byStatus, lateOrders, partialOrders, openVariances, overduePr, recent] = await Promise.all([
      can(ctx, 'pr.view') ? this.prisma.purchaseRequest.groupBy({ by: ['status'], where: prw, _count: { _all: true } }) : Promise.resolve([]),
      can(ctx, 'bc.view')
        ? this.prisma.purchaseOrder.count({ where: { ...pow, status: { in: ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] }, expectedDeliveryDate: { lt: today } } })
        : Promise.resolve(0),
      can(ctx, 'bc.view') ? this.prisma.purchaseOrder.count({ where: { ...pow, status: 'PARTIALLY_RECEIVED' } }) : Promise.resolve(0),
      can(ctx, 'receiving.view') ? this.prisma.variance.count({ where: { status: { in: ['OPEN', 'IN_PROGRESS'] }, po: pow } }) : Promise.resolve(0),
      can(ctx, 'pr.view') ? this.prisma.purchaseRequest.count({ where: { ...prw, neededBy: { lt: today }, status: { in: PR_OPEN } } }) : Promise.resolve(0),
      // Dernières PR du périmètre (même filtre navire que la liste /purchase-requests)
      can(ctx, 'pr.view')
        ? this.prisma.purchaseRequest.findMany({
            where: prw,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 5,
            select: {
              id: true,
              number: true,
              subject: true,
              status: true,
              priority: true,
              neededBy: true,
              createdAt: true,
              vessel: { select: { id: true, code: true, name: true } },
              _count: { select: { lines: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    return {
      purchaseRequestsByStatus: Object.fromEntries((byStatus as { status: string; _count: { _all: number } }[]).map((r) => [r.status, r._count._all])),
      overduePurchaseRequests: overduePr,
      lateOrders,
      partiallyReceivedOrders: partialOrders,
      openVariances,
      recentPurchaseRequests: recent.map(({ _count, ...pr }) => ({
        ...pr,
        lineCount: _count.lines,
        overdue: !!pr.neededBy && pr.neededBy < today && PR_OPEN.includes(pr.status),
      })),
    };
  }

  private async voyages(ctx: AuthContext, vesselIn: { in: string[] } | undefined, today: Date) {
    const scopeVessel = vesselIn ?? (ctx.vesselScope.mode === 'ALL_FLEET' ? undefined : { in: ctx.vesselScope.vesselIds });
    const vw = scopeVessel ? { vesselId: scopeVessel } : {};
    const active = await this.prisma.voyage.findMany({
      where: { status: 'ACTIVE', ...vw },
      select: {
        id: true,
        reference: true,
        charterer: true,
        eta: true,
        laycanFrom: true,
        laycanTo: true,
        vessel: { select: { id: true, code: true, name: true } },
        ports: { orderBy: { sequence: 'asc' }, select: { portName: true, eta: true, ata: true, atd: true } },
        noonReports: can(ctx, 'noon.view')
          ? { where: { status: { not: 'DRAFT' } }, orderBy: { reportDateUtc: 'desc' }, take: 1, select: { reportDateUtc: true } }
          : false,
      },
      orderBy: { eta: 'asc' },
      take: 20,
    });
    const threshold = Date.now() - 30 * 3_600_000;
    const items = active.map((v) => {
      const last = (v.noonReports as { reportDateUtc: Date }[] | undefined)?.[0]?.reportDateUtc ?? null;
      // Itinéraire déclaré : escale en cours = arrivée constatée (ATA) sans départ (ATD)
      const alongside = v.ports.find((p) => p.ata && !p.atd) ?? null;
      const next = v.ports.find((p) => !p.ata) ?? null;
      return {
        id: v.id,
        reference: v.reference,
        charterer: v.charterer,
        eta: v.eta,
        laycanFrom: v.laycanFrom,
        laycanTo: v.laycanTo,
        vessel: v.vessel,
        departurePort: v.ports[0]?.portName ?? null,
        arrivalPort: v.ports.length > 1 ? v.ports[v.ports.length - 1].portName : null,
        alongsidePort: alongside?.portName ?? null,
        nextPort: next ? { name: next.portName, eta: next.eta } : null,
        lastNoonReportAt: last,
        noonReportMissing: can(ctx, 'noon.view') ? !last || last.getTime() < threshold : null,
      };
    });
    const [planned, completedLast90Days] = await Promise.all([
      this.prisma.voyage.count({ where: { status: 'PLANNED', ...vw } }),
      this.prisma.voyage.count({ where: { status: 'COMPLETED', closedAt: { gte: new Date(today.getTime() - 90 * DAY) }, ...vw } }),
    ]);
    return { active: items, planned, completedLast90Days, noonReportsMissing: items.filter((i) => i.noonReportMissing).length };
  }

  /**
   * Bibliothèque CSO : uniquement les documents que l'utilisateur peut voir (scope navire + ACL + règles
   * de visibilité des brouillons). Une version en attente n'est comptée que si ses métadonnées lui sont accessibles.
   */
  private async cso(ctx: AuthContext, vesselIn: { in: string[] } | undefined, today: Date) {
    const scope: Prisma.CsoDocumentWhereInput = vesselIn
      ? { OR: [{ vesselId: vesselIn }, { vesselId: null }] }
      : ctx.vesselScope.mode === 'ALL_FLEET'
        ? {}
        : { OR: [{ vesselId: { in: ctx.vesselScope.vesselIds } }, { vesselId: null }] };
    const docs = await this.prisma.csoDocument.findMany({
      where: { AND: [scope, { status: { not: 'ARCHIVED' } }] },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: CSO_SCAN,
    });
    const { visible, eff } = await this.csoAccess.filterVisibleDocuments(ctx, docs);
    const byId = new Map(visible.map((d) => [d.id, d]));
    const pendingVersions = visible.length
      ? await this.prisma.csoVersion.findMany({
          where: { documentId: { in: [...byId.keys()] }, status: 'PENDING_APPROVAL' },
          select: { documentId: true, status: true, submittedById: true },
        })
      : [];
    const pending = new Set(
      pendingVersions.filter((v) => canAccessVersion(eff.get(v.documentId)!, byId.get(v.documentId)!, v, ctx.userId, 'meta')).map((v) => v.documentId),
    );
    const reviewLimit = new Date(today.getTime() + 31 * DAY);
    const recent = visible.slice(0, 5);
    const [categories, vessels] = await Promise.all([
      this.prisma.csoCategory.findMany({
        where: { id: { in: recent.map((d) => d.categoryId).filter((x): x is string => !!x) } },
        select: { id: true, code: true, name: true },
      }),
      this.prisma.vessel.findMany({
        where: { id: { in: recent.map((d) => d.vesselId).filter((x): x is string => !!x) } },
        select: { id: true, code: true, name: true },
      }),
    ]);
    return {
      published: visible.filter((d) => d.status === 'PUBLISHED' && !pending.has(d.id)).length,
      pendingApproval: pending.size,
      draft: visible.filter((d) => d.status === 'DRAFT' && !pending.has(d.id)).length,
      reviewDue: visible.filter((d) => d.nextReviewOn && d.nextReviewOn < reviewLimit).length,
      expired: visible.filter((d) => d.expiryOn && d.expiryOn < today).length,
      truncated: docs.length === CSO_SCAN,
      recent: recent.map((d) => ({
        id: d.id,
        reference: d.reference,
        title: d.title,
        status: d.status,
        pendingApproval: pending.has(d.id),
        category: categories.find((c) => c.id === d.categoryId) ?? null,
        vessel: vessels.find((v) => v.id === d.vesselId) ?? null,
        updatedAt: d.updatedAt,
      })),
    };
  }

  private async myTasks(ctx: AuthContext, vesselIn: { in: string[] } | undefined) {
    const [renewals, voyageTasks, myRequestsReturned] = await Promise.all([
      can(ctx, 'certificates.view')
        ? this.prisma.certificateRenewalTask.count({ where: { ownerId: ctx.userId, status: { not: 'COMPLETED' }, certificate: this.certificateWhere(ctx, vesselIn) } })
        : Promise.resolve(0),
      can(ctx, 'voyages.view')
        ? this.prisma.voyageTask.count({ where: { assigneeId: ctx.userId, status: 'OPEN' } })
        : Promise.resolve(0),
      this.prisma.certificateApprovalRequest.count({ where: { requestedById: ctx.userId, status: 'RETURNED' } }),
    ]);
    return { certificateRenewals: renewals, voyageTasks, returnedCertificateRequests: myRequestsReturned };
  }
}
