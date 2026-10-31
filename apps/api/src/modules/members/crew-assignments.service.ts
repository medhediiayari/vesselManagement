import { Injectable } from '@nestjs/common';
import { CrewAssignment, CrewAssignmentStatus, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { creatorLabels } from '../../common/utils/creators';
import { AuthContext, can, canAccessVessel, vesselWhere } from '../access/auth-context';
import { isMemberVisible, memberVisibilityWhere } from '../access/member-access';
import { AuditService, diffFields } from '../audit/audit.service';
import {
  CertificateCheckQuery,
  JoinAssignmentDto,
  ListAssignmentsQuery,
  SignOffAssignmentDto,
  UpdateAssignmentDto,
} from './crew-assignments.dto';
import {
  crewCertificateAlerts,
  crewCertificateAuditSummary,
  crewCertificateWarningMessages,
  crewCheckEnd,
  type CrewCertificateAlert,
} from './crew-certificates.logic';
import {
  CREW_TRANSITIONS,
  canTransitionCrew,
  deriveMemberStatus,
  onboardAtDateWhere,
  planBlockedByOnboardElsewhere,
  todayYmd,
  ymd,
} from './members.logic';

const ASSIGNMENT_INCLUDE = {
  vessel: { select: { id: true, code: true, name: true } },
  voyage: { select: { id: true, reference: true } },
  member: { select: { id: true, amcRef: true, firstName: true, lastName: true, nationality: true, rank: true, crewDepartment: true, status: true, photoFileId: true } },
} satisfies Prisma.CrewAssignmentInclude;

type AssignmentWithRefs = Prisma.CrewAssignmentGetPayload<{ include: typeof ASSIGNMENT_INCLUDE }>;

export function presentAssignment(a: CrewAssignment | AssignmentWithRefs) {
  return {
    ...a,
    plannedJoinDate: ymd(a.plannedJoinDate),
    actualJoinDate: ymd(a.actualJoinDate),
    plannedSignOffDate: ymd(a.plannedSignOffDate),
    actualSignOffDate: ymd(a.actualSignOffDate),
  };
}

/** Certificats d'un marin : `certificates.view` + `members.certificates.view` (formule de CertificateAccessService). */
function canSeeMemberCertificates(ctx: AuthContext): boolean {
  return can(ctx, 'certificates.view') && can(ctx, 'members.certificates.view');
}

const CERTIFICATE_CHECK_DENIED = 'Permissions certificates.view et members.certificates.view requises pour ce contrôle';

const DEPARTMENT_ORDER: Record<string, number> = { DECK: 0, ENGINE: 1, CATERING: 2, OTHER: 3 };

export interface PlanInput {
  memberId: string;
  vesselId: string;
  rank: string;
  position?: string | null;
  plannedJoinDate?: Date | null;
  plannedSignOffDate?: Date | null;
  joinPort?: string | null;
  voyageId?: string | null;
  relievesAssignmentId?: string | null;
  notes?: string | null;
}

/**
 * Affectations Member <-> Vessel (CDC V1 §5.2) : modèle temporel piloté par commandes
 * plan (PLANNED) -> join (ONBOARD) -> sign-off (COMPLETED) | cancel (CANCELLED).
 * Permission `vessel_crew.assign` + scope navire ; statut Member synchronisé dans la même
 * transaction ; index partiel `crew_assignments_one_onboard` traduit en 409 explicite.
 */
@Injectable()
export class CrewAssignmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
  ) {}

  async list(ctx: AuthContext, q: ListAssignmentsQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const and: Prisma.CrewAssignmentWhereInput[] = [vesselWhere(ctx) as Prisma.CrewAssignmentWhereInput];
    if (q.vesselId) and.push({ vesselId: q.vesselId });
    if (q.memberId) and.push({ memberId: q.memberId });
    if (q.status) and.push({ status: q.status });
    if (q.to) {
      and.push({ OR: [{ actualJoinDate: { lte: q.to } }, { actualJoinDate: null, plannedJoinDate: { lte: q.to } }, { actualJoinDate: null, plannedJoinDate: null }] });
    }
    if (q.from) {
      and.push({
        OR: [
          { actualSignOffDate: { gte: q.from } },
          { status: 'ONBOARD' },
          { actualSignOffDate: null, plannedSignOffDate: { gte: q.from } },
          { actualSignOffDate: null, plannedSignOffDate: null, status: { not: 'COMPLETED' } },
        ],
      });
    }
    const where: Prisma.CrewAssignmentWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.crewAssignment.findMany({ where, include: ASSIGNMENT_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], ...cursorArgs(q) }),
      this.prisma.crewAssignment.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    return { ...page, items: await this.withCreators(page.items.map(presentAssignment)) };
  }

  async get(ctx: AuthContext, id: string) {
    const a = await this.prisma.crewAssignment.findUnique({ where: { id }, include: ASSIGNMENT_INCLUDE });
    if (!a) throw Errors.notFound('Affectation');
    this.access.assertVesselAccess(ctx, a.vesselId);
    const [withCreator] = await this.withCreators([presentAssignment(a)]);
    return withCreator;
  }

  /**
   * Prévisualisation (avant confirmation) des certificats du marin expirés ou expirant avant la fin
   * de la période : mêmes contrôles de périmètre que plan() (navire + fiche ADM-070) ; sans droit de
   * lecture des certificats de marins, aucune donnée n'est renvoyée.
   */
  async certificateCheck(ctx: AuthContext, q: CertificateCheckQuery) {
    this.access.assertVesselAccess(ctx, q.vesselId);
    const exists = await this.prisma.member.count({ where: { id: q.memberId } });
    if (!exists) throw Errors.notFound('Member');
    if (!(await isMemberVisible(this.prisma, ctx, q.memberId))) {
      throw Errors.scopeDenied('Fiche Member hors de votre périmètre (ADM-070) : affectation réservée au service Crewing transversal');
    }
    await this.assertVoyage(q.voyageId, q.vesselId);
    if (!canSeeMemberCertificates(ctx)) return { available: false as const, reason: CERTIFICATE_CHECK_DENIED };
    const check = await this.memberCertificateAlerts(q.memberId, q.plannedSignOffDate ?? null, q.voyageId ?? null);
    return { available: true as const, end: ymd(check.end), items: check.items, counts: check.counts };
  }

  /** Planification (PLANNED) : navire actif du périmètre et fiche visible (ADM-070). */
  async plan(ctx: AuthContext, dto: PlanInput) {
    this.access.assertVesselAccess(ctx, dto.vesselId);
    const vessel = await this.prisma.vessel.findUnique({ where: { id: dto.vesselId }, select: { id: true, status: true } });
    if (!vessel) throw Errors.notFound('Navire');
    if (vessel.status === 'SOLD' || vessel.status === 'INACTIVE') throw Errors.business('Navire vendu ou inactif : aucune nouvelle affectation');
    const member = await this.prisma.member.findUnique({ where: { id: dto.memberId } });
    if (!member) throw Errors.notFound('Member');
    // ADM-070 : fiche visible (affectation active sur un navire du périmètre, ou members.cross_vessel.view) ;
    // aucune exemption « créateur » : une affectation ne doit pas servir à rendre une fiche visible
    if (!(await isMemberVisible(this.prisma, ctx, member.id))) {
      throw Errors.scopeDenied('Fiche Member hors de votre périmètre (ADM-070) : affectation réservée au service Crewing transversal');
    }
    if (member.archivedAt) throw Errors.invalidState('Fiche archivée : la restaurer avant toute affectation');
    if (member.status === 'INACTIVE') throw Errors.business('Fiche inactive : la réactiver avant toute affectation');
    await this.assertVoyage(dto.voyageId, dto.vesselId);
    await this.assertRelief(dto.relievesAssignmentId, dto.vesselId, dto.memberId);
    const existing = await this.prisma.crewAssignment.findFirst({
      where: { memberId: dto.memberId, vesselId: dto.vesselId, status: { in: ['PLANNED', 'ONBOARD'] } },
      select: { id: true, status: true },
    });
    if (existing) {
      throw Errors.conflict('Ce marin a déjà une affectation planifiée ou en cours sur ce navire', { assignmentId: existing.id, status: existing.status });
    }
    const onboardElsewhere = await this.prisma.crewAssignment.findFirst({
      where: { memberId: dto.memberId, status: 'ONBOARD', vesselId: { not: dto.vesselId } },
      include: { vessel: { select: { name: true } } },
    });
    if (planBlockedByOnboardElsewhere(ymd(dto.plannedJoinDate), todayYmd(), !!onboardElsewhere)) {
      const where = canAccessVessel(ctx, onboardElsewhere!.vesselId) ? `sur ${onboardElsewhere!.vessel.name}` : 'sur un autre navire';
      throw Errors.business(
        `Ce marin est encore à bord ${where} et la date d'embarquement prévue est déjà passée : enregistrez d'abord son débarquement, ou choisissez une date à venir`,
        { reason: 'MEMBER_ONBOARD_ELSEWHERE' },
      );
    }
    const warnings = await this.overlapWarnings(ctx, dto);
    // Certificats : recalculés côté serveur (jamais repris du client), tracés dans l'audit même si
    // l'appelant ne peut pas les lire ; renvoyés dans les warnings seulement s'il en a le droit
    const certCheck = await this.memberCertificateAlerts(dto.memberId, dto.plannedSignOffDate ?? null, dto.voyageId ?? null);
    const certificateWarnings = canSeeMemberCertificates(ctx) ? crewCertificateWarningMessages(certCheck.items, certCheck.end) : [];

    const created = await this.prisma.$transaction(async (tx) => {
      const a = await tx.crewAssignment.create({
        data: {
          memberId: dto.memberId,
          vesselId: dto.vesselId,
          rank: dto.rank,
          position: dto.position ?? null,
          status: 'PLANNED',
          plannedJoinDate: dto.plannedJoinDate ?? null,
          plannedSignOffDate: dto.plannedSignOffDate ?? null,
          joinPort: dto.joinPort ?? null,
          voyageId: dto.voyageId ?? null,
          relievesAssignmentId: dto.relievesAssignmentId ?? null,
          notes: dto.notes ?? null,
          createdById: ctx.userId,
        },
        include: ASSIGNMENT_INCLUDE,
      });
      await this.audit.record(
        ctx,
        {
          action: 'crew_assignment.planned',
          module: 'fleet',
          entityType: 'crew_assignment',
          entityId: a.id,
          vesselId: a.vesselId,
          after: presentAssignment(a),
          metadata: this.certificateAuditMetadata(ctx, certCheck),
        },
        tx,
      );
      await this.syncMemberStatus(tx, ctx, a.memberId, { assignmentId: a.id, event: 'PLANNED' });
      return a;
    });
    return { ...presentAssignment(created), warnings: [...warnings, ...certificateWarnings], certificateWarnings };
  }

  /** Modification d'une affectation PLANNED / ONBOARD (dates prévues, rang, voyage, relève…). */
  async update(ctx: AuthContext, id: string, dto: UpdateAssignmentDto) {
    const a = await this.loadAccessible(ctx, id);
    if (a.status !== 'PLANNED' && a.status !== 'ONBOARD') throw Errors.invalidState(`Affectation ${a.status} : modification impossible`);
    const { expectedUpdatedAt, ...patch } = dto;
    if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== a.updatedAt.getTime()) throw Errors.staleVersion();
    const join = patch.plannedJoinDate === undefined ? a.plannedJoinDate : patch.plannedJoinDate;
    const off = patch.plannedSignOffDate === undefined ? a.plannedSignOffDate : patch.plannedSignOffDate;
    if (join && off && off < join) throw Errors.validation('Débarquement prévu antérieur à l’embarquement prévu');
    if (patch.voyageId) await this.assertVoyage(patch.voyageId, a.vesselId);
    if (patch.relievesAssignmentId) await this.assertRelief(patch.relievesAssignmentId, a.vesselId, a.memberId, a.id);
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crewAssignment.updateMany({ where: { id, updatedAt: a.updatedAt, status: a.status }, data: { ...patch, updatedAt: new Date() } });
      if (res.count === 0) throw Errors.staleVersion();
      const after = await tx.crewAssignment.findUniqueOrThrow({ where: { id }, include: ASSIGNMENT_INCLUDE });
      const diff = diffFields(presentAssignment(a) as never, presentAssignment(after) as never);
      await this.audit.record(
        ctx,
        { action: 'crew_assignment.updated', module: 'fleet', entityType: 'crew_assignment', entityId: id, vesselId: a.vesselId, before: diff.before, after: diff.after },
        tx,
      );
      return presentAssignment(after);
    });
  }

  /** Embarquement confirmé (PLANNED -> ONBOARD). Un marin ne peut être à bord que d'un seul navire (index partiel). */
  async join(ctx: AuthContext, id: string, dto: JoinAssignmentDto) {
    const a = await this.loadAccessible(ctx, id);
    this.assertTransition(a.status, 'ONBOARD');
    this.assertNotFuture(dto.actualJoinDate, 'Date d’embarquement');
    // Audit FLT-05 : aucun embarquement sur un navire vendu ou inactif
    const vessel = await this.prisma.vessel.findUnique({ where: { id: a.vesselId }, select: { status: true } });
    if (vessel?.status === 'SOLD' || vessel?.status === 'INACTIVE') {
      throw Errors.business('Navire vendu ou inactif : embarquement impossible. Annulez cette affectation planifiée.');
    }
    await this.assertNotOnboardElsewhere(ctx, a.memberId, a.id);
    const certCheck = await this.memberCertificateAlerts(a.memberId, a.plannedSignOffDate, a.voyageId);
    const certificateWarnings = canSeeMemberCertificates(ctx) ? crewCertificateWarningMessages(certCheck.items, certCheck.end) : [];
    try {
      return await this.prisma.$transaction(async (tx) => {
        const relieved: string[] = [];
        if (dto.signOffRelieved) {
          if (!a.relievesAssignmentId) throw Errors.validation('Aucune affectation relevée sur cette affectation');
          const r = await tx.crewAssignment.findUnique({ where: { id: a.relievesAssignmentId } });
          if (r && r.status === 'ONBOARD') {
            if (r.actualJoinDate && dto.actualJoinDate < r.actualJoinDate) throw Errors.validation('Relève antérieure à l’embarquement de la personne relevée');
            const res = await tx.crewAssignment.updateMany({
              where: { id: r.id, status: 'ONBOARD' },
              data: { status: 'COMPLETED', actualSignOffDate: dto.actualJoinDate, signOffPort: dto.joinPort ?? r.signOffPort },
            });
            if (res.count === 1) {
              relieved.push(r.id);
              await this.audit.record(
                ctx,
                {
                  action: 'crew_assignment.signed_off',
                  module: 'fleet',
                  entityType: 'crew_assignment',
                  entityId: r.id,
                  vesselId: r.vesselId,
                  before: { status: 'ONBOARD' },
                  after: { status: 'COMPLETED', actualSignOffDate: ymd(dto.actualJoinDate) },
                  metadata: { relievedBy: a.id },
                },
                tx,
              );
              await this.syncMemberStatus(tx, ctx, r.memberId, { assignmentId: r.id, event: 'SIGNED_OFF' });
            }
          }
        }
        const res = await tx.crewAssignment.updateMany({
          where: { id, status: 'PLANNED' },
          data: { status: 'ONBOARD', actualJoinDate: dto.actualJoinDate, joinPort: dto.joinPort ?? a.joinPort },
        });
        if (res.count === 0) throw Errors.alreadyProcessed('Affectation déjà traitée par un autre utilisateur');
        const after = await tx.crewAssignment.findUniqueOrThrow({ where: { id }, include: ASSIGNMENT_INCLUDE });
        await this.audit.record(
          ctx,
          {
            action: 'crew_assignment.joined',
            module: 'fleet',
            entityType: 'crew_assignment',
            entityId: id,
            vesselId: a.vesselId,
            before: { status: 'PLANNED' },
            after: { status: 'ONBOARD', actualJoinDate: ymd(dto.actualJoinDate), joinPort: after.joinPort },
            metadata:
              relieved.length || certCheck.items.length
                ? { ...(relieved.length ? { relievedAssignmentIds: relieved } : {}), ...this.certificateAuditMetadata(ctx, certCheck) }
                : undefined,
          },
          tx,
        );
        await this.syncMemberStatus(tx, ctx, a.memberId, { assignmentId: id, event: 'JOINED' });
        return { ...presentAssignment(after), relievedAssignmentIds: relieved, warnings: certificateWarnings, certificateWarnings };
      });
    } catch (e) {
      throw (await this.translateOnboardConflict(ctx, e, a.memberId)) ?? e;
    }
  }

  /** Débarquement (ONBOARD -> COMPLETED) ; statut Member recalculé (AVAILABLE ou PLANNED_JOIN). */
  async signOff(ctx: AuthContext, id: string, dto: SignOffAssignmentDto) {
    const a = await this.loadAccessible(ctx, id);
    this.assertTransition(a.status, 'COMPLETED');
    this.assertNotFuture(dto.actualSignOffDate, 'Date de débarquement');
    if (a.actualJoinDate && dto.actualSignOffDate < a.actualJoinDate) throw Errors.validation('Débarquement antérieur à l’embarquement');
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.crewAssignment.updateMany({
        where: { id, status: 'ONBOARD' },
        data: {
          status: 'COMPLETED',
          actualSignOffDate: dto.actualSignOffDate,
          signOffPort: dto.signOffPort ?? a.signOffPort,
          notes: dto.notes === undefined ? undefined : dto.notes,
        },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Affectation déjà traitée par un autre utilisateur');
      const after = await tx.crewAssignment.findUniqueOrThrow({ where: { id }, include: ASSIGNMENT_INCLUDE });
      await this.audit.record(
        ctx,
        {
          action: 'crew_assignment.signed_off',
          module: 'fleet',
          entityType: 'crew_assignment',
          entityId: id,
          vesselId: a.vesselId,
          before: { status: 'ONBOARD' },
          after: { status: 'COMPLETED', actualSignOffDate: ymd(dto.actualSignOffDate), signOffPort: after.signOffPort },
        },
        tx,
      );
      await this.syncMemberStatus(tx, ctx, a.memberId, { assignmentId: id, event: 'SIGNED_OFF' });
      return presentAssignment(after);
    });
  }

  /** Annulation d'une affectation planifiée (motif obligatoire, conservé dans les notes et l'audit). */
  async cancel(ctx: AuthContext, id: string, reason: string) {
    const a = await this.loadAccessible(ctx, id);
    this.assertTransition(a.status, 'CANCELLED');
    return this.prisma.$transaction(async (tx) => {
      const notes = [a.notes, `Annulée le ${todayYmd()} : ${reason}`].filter(Boolean).join('\n');
      const res = await tx.crewAssignment.updateMany({ where: { id, status: 'PLANNED' }, data: { status: 'CANCELLED', notes } });
      if (res.count === 0) throw Errors.alreadyProcessed('Affectation déjà traitée par un autre utilisateur');
      const after = await tx.crewAssignment.findUniqueOrThrow({ where: { id }, include: ASSIGNMENT_INCLUDE });
      await this.audit.record(
        ctx,
        { action: 'crew_assignment.cancelled', module: 'fleet', entityType: 'crew_assignment', entityId: id, vesselId: a.vesselId, before: { status: 'PLANNED' }, after: { status: 'CANCELLED' }, metadata: { reason } },
        tx,
      );
      await this.syncMemberStatus(tx, ctx, a.memberId, { assignmentId: id, event: 'CANCELLED' });
      return presentAssignment(after);
    });
  }

  /**
   * Crew roster d'un navire. Sans date : équipage embarqué + planifié. Avec `date` : personnes
   * effectivement à bord ce jour-là (embarquement confirmé <= date <= débarquement réel ou en cours),
   * et, pour une date future, les arrivées planifiées couvrant la date. L'historique ne confère pas
   * l'accès à la fiche (`memberAccessible`).
   */
  async roster(ctx: AuthContext, vesselId: string, date?: Date) {
    this.access.assertVesselAccess(ctx, vesselId);
    const vessel = await this.prisma.vessel.findUnique({ where: { id: vesselId }, select: { id: true, code: true, name: true, status: true } });
    if (!vessel) throw Errors.notFound('Navire');
    const today = todayYmd();
    const dateStr = date ? ymd(date)! : null;
    const onboardWhere: Prisma.CrewAssignmentWhereInput = date ? onboardAtDateWhere(vesselId, date) : { vesselId, status: 'ONBOARD' };
    const plannedWhere: Prisma.CrewAssignmentWhereInput | null = !date
      ? { vesselId, status: 'PLANNED' }
      : dateStr! >= today
        ? { vesselId, status: 'PLANNED', plannedJoinDate: { lte: date }, OR: [{ plannedSignOffDate: null }, { plannedSignOffDate: { gte: date } }] }
        : null;
    const [onboard, planned, ranks] = await Promise.all([
      this.prisma.crewAssignment.findMany({ where: onboardWhere, include: ASSIGNMENT_INCLUDE }),
      plannedWhere ? this.prisma.crewAssignment.findMany({ where: plannedWhere, include: ASSIGNMENT_INCLUDE }) : Promise.resolve([] as AssignmentWithRefs[]),
      this.prisma.rank.findMany({ select: { code: true, name: true, sortOrder: true, crewDepartment: true } }),
    ]);
    const memberIds = [...new Set([...onboard, ...planned].map((a) => a.memberId))];
    const visible = new Set(
      (await this.prisma.member.findMany({ where: { AND: [{ id: { in: memberIds } }, memberVisibilityWhere(ctx)] }, select: { id: true } })).map((m) => m.id),
    );
    const rankInfo = (rank: string) => {
      const k = rank.trim().toLowerCase();
      return ranks.find((r) => r.code.toLowerCase() === k || r.name.toLowerCase() === k || r.name.toLowerCase().split('/').some((s) => s.trim() === k));
    };
    const sortKey = (a: AssignmentWithRefs) => {
      const r = rankInfo(a.rank);
      return [DEPARTMENT_ORDER[r?.crewDepartment ?? a.member.crewDepartment ?? 'OTHER'] ?? 9, r?.sortOrder ?? 999, a.member.lastName] as const;
    };
    const creators = await creatorLabels(this.prisma, [...onboard, ...planned].map((a) => a.createdById));
    const sorted = (list: AssignmentWithRefs[]) =>
      [...list]
        .sort((x, y) => {
          const [a1, b1, c1] = sortKey(x);
          const [a2, b2, c2] = sortKey(y);
          return a1 - a2 || b1 - b2 || c1.localeCompare(c2);
        })
        .map((a) => ({
          ...presentAssignment(a),
          createdBy: a.createdById ? (creators.get(a.createdById) ?? null) : null,
          memberAccessible: visible.has(a.memberId),
        }));
    return {
      vessel,
      date: dateStr,
      onboard: sorted(onboard),
      planned: sorted(planned),
      counts: { onboard: onboard.length, planned: planned.length },
    };
  }

  /**
   * Recalcule le statut Member depuis ses affectations actives (dans la transaction appelante)
   * et l'audite s'il change. Utilisé aussi par l'import Excel.
   */
  async syncMemberStatus(tx: Tx, ctx: AuthContext, memberId: string, cause: Record<string, unknown>) {
    const m = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { status: true } });
    const [onboard, planned] = await Promise.all([
      tx.crewAssignment.count({ where: { memberId, status: 'ONBOARD' } }),
      tx.crewAssignment.count({ where: { memberId, status: 'PLANNED' } }),
    ]);
    const next = deriveMemberStatus(m.status, { onboard, planned });
    if (next !== m.status) {
      await tx.member.update({ where: { id: memberId }, data: { status: next } });
      await this.audit.record(
        ctx,
        { action: 'member.status_synced', module: 'members', entityType: 'member', entityId: memberId, before: { status: m.status }, after: { status: next }, metadata: cause },
        tx,
      );
    }
    return next;
  }

  /** Traduit la violation de l'index partiel « un seul ONBOARD par marin » en 409 lisible. */
  async translateOnboardConflict(ctx: AuthContext, e: unknown, memberId: string) {
    const isUnique =
      (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') ||
      /crew_assignments_one_onboard/.test((e as { message?: string })?.message ?? '');
    if (!isUnique) return null;
    return this.onboardConflict(ctx, memberId);
  }

  // ---------------------------------------------------------------------------

  private async onboardConflict(ctx: AuthContext, memberId: string, excludeId?: string) {
    const current = await this.prisma.crewAssignment.findFirst({
      where: { memberId, status: 'ONBOARD', ...(excludeId ? { id: { not: excludeId } } : {}) },
      include: { vessel: { select: { id: true, code: true, name: true } } },
    });
    const visibleVessel = current && canAccessVessel(ctx, current.vesselId) ? current.vessel : null;
    return Errors.conflict(
      `Ce marin est déjà embarqué sur ${visibleVessel ? `le navire ${visibleVessel.name} (${visibleVessel.code})` : 'un autre navire'} : enregistrer son débarquement avant un nouvel embarquement`,
      { reason: 'MEMBER_ALREADY_ONBOARD', assignmentId: visibleVessel ? current?.id : undefined, vessel: visibleVessel },
    );
  }

  private async assertNotOnboardElsewhere(ctx: AuthContext, memberId: string, assignmentId: string) {
    const count = await this.prisma.crewAssignment.count({ where: { memberId, status: 'ONBOARD', id: { not: assignmentId } } });
    if (count) throw await this.onboardConflict(ctx, memberId, assignmentId);
  }

  /** Ajoute `createdBy` (nom + rôles) : savoir qui a planifié avant d'annuler ou de modifier. */
  private async withCreators<T extends { createdById: string | null }>(rows: T[]) {
    const labels = await creatorLabels(this.prisma, rows.map((r) => r.createdById));
    return rows.map((r) => ({ ...r, createdBy: r.createdById ? (labels.get(r.createdById) ?? null) : null }));
  }

  /**
   * Certificats courants du marin (non archivés, révision courante présente — mêmes critères que le
   * contrôle voyage) confrontés à la fin de période : débarquement prévu, ou fin estimée du voyage
   * (ETA, sinon fin de laycan) si elle est plus tardive.
   */
  private async memberCertificateAlerts(memberId: string, plannedSignOffDate: Date | null, voyageId: string | null) {
    const [voyage, certs] = await Promise.all([
      voyageId ? this.prisma.voyage.findUnique({ where: { id: voyageId }, select: { eta: true, laycanTo: true } }) : null,
      this.prisma.certificate.findMany({
        where: { memberId, subjectKind: 'MEMBER', archivedAt: null, currentRevisionId: { not: null } },
        select: { id: true, currentNumber: true, currentExpiryKind: true, currentExpiryOn: true, type: { select: { name: true, code: true } } },
      }),
    ]);
    const end = crewCheckEnd(plannedSignOffDate, voyage);
    return { end, ...crewCertificateAlerts(certs, end, new Date()) };
  }

  /** Métadonnées d'audit : liste courte des alertes certificats (aucune alerte -> undefined). */
  private certificateAuditMetadata(ctx: AuthContext, check: { end: Date | null; items: CrewCertificateAlert[] }) {
    if (!check.items.length) return undefined;
    return {
      certificateWarnings: crewCertificateAuditSummary(check.items),
      certificateCheckEnd: ymd(check.end),
      certificateWarningsShown: canSeeMemberCertificates(ctx),
    };
  }

  private async loadAccessible(ctx: AuthContext, id: string) {
    const a = await this.prisma.crewAssignment.findUnique({ where: { id } });
    if (!a) throw Errors.notFound('Affectation');
    this.access.assertVesselAccess(ctx, a.vesselId);
    return a;
  }

  private assertTransition(from: CrewAssignmentStatus, to: CrewAssignmentStatus) {
    if (!canTransitionCrew(from, to)) {
      throw Errors.invalidState(`Transition ${from} -> ${to} interdite`, { from, to, allowed: CREW_TRANSITIONS[from] });
    }
  }

  /** Les faits (embarquement / débarquement) ne sont pas saisis par anticipation (tolérance J+1 fuseaux). */
  private assertNotFuture(d: Date, label: string) {
    const limit = new Date(`${todayYmd()}T00:00:00.000Z`);
    limit.setUTCDate(limit.getUTCDate() + 1);
    if (d > limit) throw Errors.validation(`${label} dans le futur : à confirmer le jour effectif`);
  }

  private async assertVoyage(voyageId: string | null | undefined, vesselId: string) {
    if (!voyageId) return;
    const v = await this.prisma.voyage.findUnique({ where: { id: voyageId }, select: { vesselId: true } });
    if (!v) throw Errors.notFound('Voyage');
    if (v.vesselId !== vesselId) throw Errors.validation('Le voyage appartient à un autre navire');
  }

  private async assertRelief(relievesId: string | null | undefined, vesselId: string, memberId: string, selfId?: string) {
    if (!relievesId) return;
    if (relievesId === selfId) throw Errors.validation('Une affectation ne peut pas se relever elle-même');
    const r = await this.prisma.crewAssignment.findUnique({ where: { id: relievesId }, select: { vesselId: true, memberId: true, status: true } });
    if (!r) throw Errors.notFound('Affectation relevée');
    if (r.vesselId !== vesselId) throw Errors.validation('La relève doit concerner le même navire');
    if (r.memberId === memberId) throw Errors.validation('Un marin ne peut pas se relever lui-même');
    if (r.status !== 'ONBOARD' && r.status !== 'PLANNED') throw Errors.business('L’affectation relevée est terminée ou annulée');
  }

  /** Chevauchements avec d'autres affectations actives du marin (avertissement, non bloquant). */
  private async overlapWarnings(ctx: AuthContext, dto: PlanInput): Promise<string[]> {
    const others = await this.prisma.crewAssignment.findMany({
      where: { memberId: dto.memberId, status: { in: ['PLANNED', 'ONBOARD'] }, vesselId: { not: dto.vesselId } },
      include: { vessel: { select: { name: true } } },
    });
    const start = dto.plannedJoinDate ? ymd(dto.plannedJoinDate)! : '0000-01-01';
    const end = dto.plannedSignOffDate ? ymd(dto.plannedSignOffDate)! : '9999-12-31';
    return others
      .filter((o) => {
        const oStart = ymd(o.actualJoinDate ?? o.plannedJoinDate) ?? '0000-01-01';
        const oEnd = ymd(o.actualSignOffDate ?? o.plannedSignOffDate) ?? '9999-12-31';
        return oStart <= end && start <= oEnd;
      })
      .map((o) => {
        const where = canAccessVessel(ctx, o.vesselId) ? `sur ${o.vessel.name}` : 'sur un autre navire';
        return o.status === 'ONBOARD'
          ? `Marin actuellement embarqué ${where} : prévoir son débarquement avant l'embarquement`
          : `Période chevauchant une autre affectation planifiée ${where}`;
      });
  }
}
