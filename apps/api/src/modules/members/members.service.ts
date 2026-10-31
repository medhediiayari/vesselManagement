import { CREW_CATEGORIES, type CrewCategory } from '@amc/types';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { Member, MemberFieldDefinition, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { Db, PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, canAny, vesselWhere } from '../access/auth-context';
import { assertMemberVisible, isMemberVisible, memberVisibilityWhere } from '../access/member-access';
import { AuditService, diffFields } from '../audit/audit.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService, toFileDto } from '../files/files.service';
import { SettingsService } from '../settings/settings.service';
import { MemberDuplicatesService } from './member-duplicates.service';
import { escapeLike } from '../../common/utils/like';
import { creatorLabels } from '../../common/utils/creators';
import {
  CreateMemberDto,
  DuplicateCheckDto,
  ListMembersQuery,
  MemberStatsQuery,
  SelfUpdateDto,
  UpdateMemberDto,
  AddMemberDocumentDto,
} from './members.dto';
import {
  DuplicateCandidate,
  IDENTITY_FIELDS,
  ManualMemberStatus,
  MemberIdentity,
  OUT_OF_SCOPE_DUPLICATE_MESSAGE,
  PROTECTED_MEMBER_FIELDS,
  certificateValidity,
  changedProtectedFields,
  memberDataIssues,
  redactMemberAuditPayload,
  resolveManualStatus,
  sameValue,
  searchIdentifierKey,
  todayYmd,
  validateCustomFieldValue,
  ymd,
} from './members.logic';

export const OWNER_MEMBER_PHOTO = 'member_photo';
export const OWNER_MEMBER_DOCUMENT = 'member_document';

/** Permissions autorisant le téléchargement d'un document Member (distinctes de members.view, CERT-06/07). */
export const MEMBER_DOCUMENT_DOWNLOAD_PERMISSIONS = ['members.edit', 'members.personal_fields.manage'];

const VALIDITY_KEY = {
  VALID: 'valid',
  UNLIMITED: 'unlimited',
  EXPIRING_SOON: 'expiringSoon',
  EXPIRED: 'expired',
  EXPIRY_UNKNOWN: 'expiryUnknown',
  NOT_APPROVED: 'notApproved',
} as const;

function emptyCertificateSummary() {
  return { total: 0, valid: 0, unlimited: 0, expiringSoon: 0, expired: 0, expiryUnknown: 0, notApproved: 0, documentMissing: 0 };
}

export function serializeMember(m: Member) {
  return {
    ...m,
    birthDate: ymd(m.birthDate),
    passportExpiry: ymd(m.passportExpiry),
    seamanBookExpiry: ymd(m.seamanBookExpiry),
  };
}

export function identityOfMember(m: Partial<Record<(typeof IDENTITY_FIELDS)[number], unknown>>): MemberIdentity {
  const s = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? ymd(v) : String(v));
  return {
    amcRef: s(m.amcRef),
    firstName: s(m.firstName),
    lastName: s(m.lastName),
    birthDate: s(m.birthDate),
    passportNumber: s(m.passportNumber),
    passportCountry: s(m.passportCountry),
    seamanBookNumber: s(m.seamanBookNumber),
  };
}

type FieldDefWithSection = MemberFieldDefinition & { section: { id: string; name: string; sortOrder: number; archivedAt: Date | null } | null };

/**
 * Fiches Members (CDC §3.2, V1 §5.1). Visibilité ADM-070 appliquée à chaque lecture :
 * `memberVisibilityWhere(ctx)` pour les listes, `assertMemberVisible` pour chaque fiche.
 * Données personnelles protégées (PROTECTED_MEMBER_FIELDS) : `members.personal_fields.manage`.
 */
@Injectable()
export class MembersService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly settings: SettingsService,
    private readonly duplicates: MemberDuplicatesService,
  ) {}

  /**
   * Resolvers d'accès fichiers : photo et documents visibles avec members.view + ADM-070
   * (ou par la personne elle-même) ; téléchargement d'un document = members.edit ou
   * members.personal_fields.manage (permission distincte de la consultation).
   */
  onModuleInit(): void {
    this.registry.register(OWNER_MEMBER_PHOTO, async (ctx, file) => {
      const memberId = file.ownerId!;
      if (ctx.memberId !== memberId) {
        this.access.assertCan(ctx, 'members.view');
        await assertMemberVisible(this.prisma, ctx, memberId);
      }
      return { module: 'members', entityType: 'member_photo', entityId: memberId, vesselId: null };
    });
    this.registry.register(OWNER_MEMBER_DOCUMENT, async (ctx, file, mode) => {
      const doc = await this.prisma.memberDocument.findUnique({ where: { id: file.ownerId! } });
      if (!doc) throw Errors.notFound('Document');
      if (ctx.memberId !== doc.memberId) {
        this.access.assertCan(ctx, 'members.view');
        await assertMemberVisible(this.prisma, ctx, doc.memberId);
        if (mode === 'download' && !canAny(ctx, MEMBER_DOCUMENT_DOWNLOAD_PERMISSIONS)) {
          throw Errors.forbidden('Téléchargement des documents Member : permission members.edit ou members.personal_fields.manage requise', {
            anyOf: MEMBER_DOCUMENT_DOWNLOAD_PERMISSIONS,
          });
        }
      }
      return { module: 'members', entityType: 'member_document', entityId: doc.id, vesselId: null };
    });
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async list(ctx: AuthContext, q: ListMembersQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const and: Prisma.MemberWhereInput[] = [memberVisibilityWhere(ctx), q.archived ? { archivedAt: { not: null } } : { archivedAt: null }];
    if (q.status) and.push({ status: q.status });
    if (q.crewDepartment) and.push({ crewDepartment: q.crewDepartment });
    if (q.rank) and.push({ rank: { contains: escapeLike(q.rank), mode: 'insensitive' } });
    if (q.vesselId) and.push({ crewAssignments: { some: { vesselId: q.vesselId, status: { in: ['PLANNED', 'ONBOARD'] } } } });
    if (q.category) {
      // Catégorie = ensemble de rangs du référentiel ; la fiche porte le libellé officiel du rang
      const ranks = await this.prisma.rank.findMany({ where: { code: { in: [...CREW_CATEGORIES[q.category as CrewCategory].rankCodes] } }, select: { name: true } });
      and.push({ rank: { in: ranks.map((r) => r.name) } });
    }
    if (q.search) {
      const tokens = q.search.split(/\s+/).filter(Boolean).slice(0, 4).map(escapeLike);
      const idMatches = await this.identifierMatches(q.search);
      and.push({
        OR: [
          { AND: tokens.map((t) => ({ OR: [{ lastName: { contains: t, mode: 'insensitive' as const } }, { firstName: { contains: t, mode: 'insensitive' as const } }] })) },
          ...(idMatches.length ? [{ id: { in: idMatches } }] : []),
        ],
      });
    }
    const where: Prisma.MemberWhereInput = { AND: and };
    const fullCareer = can(ctx, 'members.cross_vessel.view');
    const [rows, total] = await Promise.all([
      this.prisma.member.findMany({
        where,
        orderBy: [{ [q.sort]: q.order } as Prisma.MemberOrderByWithRelationInput, { id: 'asc' }],
        ...cursorArgs(q),
        select: {
          id: true, amcRef: true, firstName: true, lastName: true, birthDate: true, nationality: true, rank: true,
          crewDepartment: true, status: true, photoFileId: true, archivedAt: true, updatedAt: true,
          seamanBookNumber: true, seamanBookExpiry: true,
          crewAssignments: {
            where: { status: { in: ['PLANNED', 'ONBOARD'] }, ...(fullCareer ? {} : (vesselWhere(ctx) as Prisma.CrewAssignmentWhereInput)) },
            select: {
              id: true, status: true, rank: true, plannedJoinDate: true, actualJoinDate: true, plannedSignOffDate: true,
              vessel: { select: { id: true, code: true, name: true } },
            },
          },
        },
      }),
      this.prisma.member.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    const certificates = await this.memberCertificates(ctx, page.items.map((m) => m.id));
    return {
      ...page,
      // Colonnes de la vue matrice : types Members actifs, dans l'ordre du référentiel
      ...(q.withCertificates && certificates
        ? {
            certificateTypes: await this.prisma.certificateType.findMany({
              where: { subjectKind: 'MEMBER', isActive: true },
              orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
              select: { id: true, code: true, name: true, category: true },
            }),
          }
        : {}),
      items: page.items.map(({ crewAssignments, ...m }) => ({
        ...m,
        birthDate: ymd(m.birthDate),
        seamanBookExpiry: ymd(m.seamanBookExpiry),
        currentAssignments: crewAssignments.map((a) => ({
          ...a,
          plannedJoinDate: ymd(a.plannedJoinDate),
          actualJoinDate: ymd(a.actualJoinDate),
          plannedSignOffDate: ymd(a.plannedSignOffDate),
        })),
        // Absent sans members.certificates.view (même règle que la fiche détaillée)
        ...(certificates ? { certificateSummary: certificates.summary.get(m.id) ?? emptyCertificateSummary() } : {}),
        ...(q.withCertificates && certificates ? { certificates: certificates.items.get(m.id) ?? [] } : {}),
      })),
    };
  }

  /**
   * Certificats courants d'une page de fiches : répartition par validité (même calcul que la fiche détaillée)
   * et liste par type (vue matrice). « Document manquant » ne compte que pour les types qui exigent un document.
   */
  private async memberCertificates(ctx: AuthContext, memberIds: string[]) {
    if (!can(ctx, 'members.certificates.view')) return null;
    const summary = new Map<string, ReturnType<typeof emptyCertificateSummary>>();
    const items = new Map<string, { id: string; typeCode: string; validity: string; expiryKind: string | null; expiryOn: string | null }[]>();
    if (!memberIds.length) return { summary, items };
    const [soonDays, certs] = await Promise.all([
      this.settings.get('certificates.expiringSoonDays'),
      this.prisma.certificate.findMany({
        where: { memberId: { in: memberIds }, archivedAt: null },
        select: {
          id: true, memberId: true, currentRevisionId: true, currentExpiryKind: true, currentExpiryOn: true, documentMissing: true,
          type: { select: { code: true, requiresDocument: true } },
        },
      }),
    ]);
    const today = todayYmd();
    for (const c of certs) {
      const sum = summary.get(c.memberId!) ?? emptyCertificateSummary();
      const v = certificateValidity(c.currentRevisionId ? c.currentExpiryKind : null, c.currentExpiryOn, today, Number(soonDays));
      sum.total += 1;
      sum[VALIDITY_KEY[v]] += 1;
      if (c.documentMissing && c.type.requiresDocument) sum.documentMissing += 1;
      summary.set(c.memberId!, sum);
      const list = items.get(c.memberId!) ?? [];
      list.push({ id: c.id, typeCode: c.type.code, validity: v, expiryKind: c.currentExpiryKind, expiryOn: ymd(c.currentExpiryOn) });
      items.set(c.memberId!, list);
    }
    return { summary, items };
  }

  /** Compteurs de la population visible : statuts des fiches actives et alertes certificats (si autorisé). */
  async stats(ctx: AuthContext, q: MemberStatsQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const where: Prisma.MemberWhereInput = {
      AND: [
        memberVisibilityWhere(ctx),
        { archivedAt: null },
        q.vesselId ? { crewAssignments: { some: { vesselId: q.vesselId, status: { in: ['PLANNED', 'ONBOARD'] } } } } : {},
      ],
    };
    const groups = await this.prisma.member.groupBy({ by: ['status'], where, _count: { _all: true } });
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g._count._all]));
    const total = groups.reduce((n, g) => n + g._count._all, 0);
    // Seuil paramétré (non sensible) : sert aussi à qualifier passeport et seaman book côté écran
    const soonDays = Number(await this.settings.get('certificates.expiringSoonDays'));
    if (!can(ctx, 'members.certificates.view')) return { total, byStatus, expiringSoonDays: soonDays };

    const today = new Date(`${todayYmd()}T00:00:00.000Z`);
    const limit = new Date(today.getTime() + soonDays * 86_400_000);
    const current: Prisma.CertificateWhereInput = { subjectKind: 'MEMBER', archivedAt: null, currentRevisionId: { not: null }, member: where };
    const [expired, expiringSoon, documentMissing, membersConcerned] = await Promise.all([
      this.prisma.certificate.count({ where: { ...current, currentExpiryKind: 'DATED', currentExpiryOn: { lt: today } } }),
      this.prisma.certificate.count({ where: { ...current, currentExpiryKind: 'DATED', currentExpiryOn: { gte: today, lte: limit } } }),
      this.prisma.certificate.count({ where: { ...current, documentMissing: true, type: { requiresDocument: true } } }),
      this.prisma.member.count({
        where: {
          AND: [where, { certificates: { some: { archivedAt: null, currentRevisionId: { not: null }, currentExpiryKind: 'DATED', currentExpiryOn: { lte: limit } } } }],
        },
      }),
    ]);
    return { total, byStatus, expiringSoonDays: soonDays, certificates: { expired, expiringSoon, documentMissing, membersConcerned } };
  }

  async get(ctx: AuthContext, id: string) {
    await assertMemberVisible(this.prisma, ctx, id);
    return this.buildDetail(ctx, id, ctx.memberId === id);
  }

  /** Fiche complète : identité, contacts, documents officiels, champs personnalisés, affectations, compte lié. */
  private async buildDetail(ctx: AuthContext, id: string, self: boolean) {
    const member = await this.prisma.member.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, username: true, email: true, displayName: true, status: true, lastLoginAt: true } },
        fieldValues: true,
        _count: { select: { documents: { where: { archivedAt: null } } } },
      },
    });
    if (!member) throw Errors.notFound('Member');
    // ADM-070 : historique complet pour Crew/HR transversal ou la personne elle-même, sinon navires du périmètre
    const fullCareer = self || can(ctx, 'members.cross_vessel.view');
    const [assignments, department, photo, defs] = await Promise.all([
      this.prisma.crewAssignment.findMany({
        where: { memberId: id, ...(fullCareer ? {} : (vesselWhere(ctx) as Prisma.CrewAssignmentWhereInput)) },
        include: { vessel: { select: { id: true, code: true, name: true } }, voyage: { select: { id: true, reference: true } } },
      }),
      member.departmentId
        ? this.prisma.department.findUnique({ where: { id: member.departmentId }, select: { id: true, code: true, name: true, status: true } })
        : null,
      member.photoFileId ? this.prisma.storedFile.findUnique({ where: { id: member.photoFileId } }) : null,
      this.activeFieldDefs(),
    ]);

    // Auteur de chaque affectation : ne pas annuler le travail d'un autre sans le savoir
    const creators = await creatorLabels(this.prisma, assignments.map((a) => a.createdById));
    const assignmentDto = assignments
      .map((a) => ({
        id: a.id,
        vessel: a.vessel,
        voyage: a.voyage,
        rank: a.rank,
        position: a.position,
        status: a.status,
        plannedJoinDate: ymd(a.plannedJoinDate),
        actualJoinDate: ymd(a.actualJoinDate),
        plannedSignOffDate: ymd(a.plannedSignOffDate),
        actualSignOffDate: ymd(a.actualSignOffDate),
        joinPort: a.joinPort,
        signOffPort: a.signOffPort,
        relievesAssignmentId: a.relievesAssignmentId,
        createdAt: a.createdAt,
        createdBy: a.createdById ? (creators.get(a.createdById) ?? null) : null,
        updatedAt: a.updatedAt,
      }))
      .sort((x, y) => (y.actualJoinDate ?? y.plannedJoinDate ?? '').localeCompare(x.actualJoinDate ?? x.plannedJoinDate ?? ''));

    const valueByField = new Map(member.fieldValues.map((v) => [v.fieldId, v]));
    const sections = new Map<string, { id: string | null; name: string; sortOrder: number; fields: unknown[] }>();
    for (const d of defs) {
      if (!this.canViewField(ctx, d, self)) continue;
      const key = d.section?.id ?? '__none__';
      if (!sections.has(key)) {
        sections.set(key, { id: d.section?.id ?? null, name: d.section?.name ?? 'Informations complémentaires', sortOrder: d.section?.sortOrder ?? -1, fields: [] });
      }
      sections.get(key)!.fields.push({
        id: d.id,
        key: d.key,
        label: d.label,
        type: d.type,
        options: d.options,
        required: d.required,
        value: valueByField.get(d.id)?.value ?? null,
        updatedAt: valueByField.get(d.id)?.updatedAt ?? null,
        editable: !member.archivedAt && (self ? d.selfEditable : this.canEditField(ctx, d)),
      });
    }

    let certificates: unknown[] | undefined;
    if (self || can(ctx, 'members.certificates.view')) {
      const soonDays = await this.settings.get('certificates.expiringSoonDays');
      const today = todayYmd();
      const certs = await this.prisma.certificate.findMany({
        where: { memberId: id, archivedAt: null },
        select: {
          id: true, currentNumber: true, currentExpiryKind: true, currentExpiryOn: true, documentMissing: true, currentRevisionId: true,
          type: { select: { code: true, name: true, category: true, sortOrder: true, requiresDocument: true } },
          requests: { where: { status: { in: ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] } }, select: { id: true, kind: true, status: true, version: true } },
        },
      });
      certificates = certs
        .sort((a, b) => a.type.sortOrder - b.type.sortOrder)
        .map((c) => ({
          id: c.id,
          type: { code: c.type.code, name: c.type.name, category: c.type.category },
          number: c.currentNumber,
          expiryKind: c.currentExpiryKind,
          expiryOn: ymd(c.currentExpiryOn),
          validity: certificateValidity(c.currentRevisionId ? c.currentExpiryKind : null, c.currentExpiryOn, today, soonDays),
          // Justificatif facultatif pour ce type : pas de signal « document manquant »
          documentMissing: c.documentMissing && c.type.requiresDocument,
          openRequests: c.requests,
        }));
    }

    const showLogin = can(ctx, 'users.view') || can(ctx, 'members.link_user') || self;
    const { user, fieldValues: _fv, _count, ...rest } = member;
    return {
      ...serializeMember(rest as Member),
      department,
      photo: photo ? toFileDto(photo) : null,
      linkedUser: user
        ? {
            id: user.id,
            displayName: user.displayName,
            status: user.status,
            ...(showLogin ? { username: user.username, email: user.email, lastLoginAt: user.lastLoginAt } : {}),
          }
        : null,
      customFields: [...sections.values()].sort((a, b) => a.sortOrder - b.sortOrder),
      currentAssignments: assignmentDto.filter((a) => a.status === 'PLANNED' || a.status === 'ONBOARD'),
      assignmentHistory: assignmentDto.filter((a) => a.status === 'COMPLETED' || a.status === 'CANCELLED'),
      assignmentScope: fullCareer ? 'FULL' : 'ACCESSIBLE_VESSELS',
      documentsCount: _count.documents,
      certificates,
      protectedFields: PROTECTED_MEMBER_FIELDS,
      permissions: {
        canEdit: !member.archivedAt && can(ctx, 'members.edit'),
        canEditProtected: !member.archivedAt && can(ctx, 'members.personal_fields.manage'),
        canAssign: can(ctx, 'vessel_crew.assign'),
        canDownloadDocuments: self || canAny(ctx, MEMBER_DOCUMENT_DOWNLOAD_PERMISSIONS),
      },
    };
  }

  /**
   * Historique des modifications de la fiche (audit, before/after), filtré pour le lecteur :
   * champs protégés masqués sans members.personal_fields.manage, valeurs de champs personnalisés
   * masquées selon leur permission de consultation, candidats doublons hors périmètre anonymisés.
   */
  async history(ctx: AuthContext, id: string) {
    await assertMemberVisible(this.prisma, ctx, id);
    const [events, defs] = await Promise.all([
      this.prisma.auditEvent.findMany({
        where: { module: 'members', entityType: 'member', entityId: id },
        orderBy: { occurredAt: 'desc' },
        take: 200,
        select: { id: true, occurredAt: true, actorLabel: true, action: true, before: true, after: true, metadata: true },
      }),
      this.prisma.memberFieldDefinition.findMany(),
    ]);
    const self = ctx.memberId === id;
    const defByKey = new Map(defs.map((d) => [d.key, d]));
    const opts = {
      canViewProtected: can(ctx, 'members.personal_fields.manage'),
      canViewCustomField: (key: string) => {
        const d = defByKey.get(key);
        return !!d && this.canViewField(ctx, d, self);
      },
    };
    type Meta = { candidates?: { memberId?: string; visible?: boolean; message?: string }[]; corrections?: unknown } & Record<string, unknown>;
    const candidateIds = events.flatMap((e) => ((e.metadata as Meta | null)?.candidates ?? []).map((c) => c.memberId).filter((x): x is string => !!x));
    const visibleIds = await this.duplicates.visibleIds(ctx, candidateIds);
    return events.map((e) => {
      const before = redactMemberAuditPayload(e.before, opts);
      const after = redactMemberAuditPayload(e.after, opts);
      let metadata = e.metadata as Meta | null;
      const redacted = [...before.redacted, ...after.redacted];
      if (metadata && typeof metadata === 'object') {
        metadata = { ...metadata };
        if (metadata.corrections) {
          const c = redactMemberAuditPayload(metadata.corrections, opts);
          metadata.corrections = c.value;
          redacted.push(...c.redacted.map((f) => `corrections.${f}`));
        }
        if (Array.isArray(metadata.candidates)) {
          metadata.candidates = metadata.candidates.map((c) =>
            c.memberId && visibleIds.has(c.memberId) ? c : { visible: false, message: OUT_OF_SCOPE_DUPLICATE_MESSAGE },
          );
        }
      }
      return { ...e, before: before.value, after: after.value, metadata, redactedFields: [...new Set(redacted)] };
    });
  }

  /** Pré-contrôle des doublons avant saisie (même moteur que la création et l'import). */
  async checkDuplicates(ctx: AuthContext, dto: DuplicateCheckDto) {
    const candidates = await this.duplicates.find(identityOfMember(dto), { excludeIds: dto.excludeMemberId ? [dto.excludeMemberId] : [] });
    return { candidates: await this.duplicates.present(ctx, candidates) };
  }

  // ---------------------------------------------------------------------------
  // Création / modification
  // ---------------------------------------------------------------------------

  /**
   * Création avec détection multicritère des doublons (ADM-042) : 409 DUPLICATE avec les
   * candidats, sauf `force` + motif (audité). Un matricule AMC déjà attribué n'est jamais forçable.
   */
  async create(ctx: AuthContext, dto: CreateMemberDto) {
    const { customFields, photoFileId, force, forceReason, status, ...data } = dto;
    this.assertMemberData(data);
    const prot = changedProtectedFields({}, data);
    if (prot.length) this.assertProtected(ctx, prot);
    if (data.departmentId) await this.assertDepartmentAssignable(data.departmentId);

    const candidates = await this.duplicates.find(identityOfMember(data));
    await this.guardDuplicates(ctx, candidates, force);

    const company = await this.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const created = await this.prisma.$transaction(async (tx) => {
      let m = await tx.member.create({
        data: { ...data, companyId: company.id, createdById: ctx.userId, status: status ?? 'AVAILABLE' } as Prisma.MemberUncheckedCreateInput,
      });
      if (photoFileId) {
        await this.files.attach(ctx, photoFileId, { type: OWNER_MEMBER_PHOTO, id: m.id, contexts: ['MEMBER_PHOTO'] }, tx);
        m = await tx.member.update({ where: { id: m.id }, data: { photoFileId } });
      }
      const custom = await this.writeCustomFields(tx, ctx, m.id, customFields ?? {}, 'staff', true);
      await this.audit.record(
        ctx,
        {
          action: 'member.created',
          module: 'members',
          entityType: 'member',
          entityId: m.id,
          after: { ...serializeMember(m), customFields: custom.after },
          metadata: candidates.length
            ? { forcedDuplicate: true, reason: forceReason, candidates: candidates.map((c) => ({ memberId: c.memberId, score: c.score, reasons: c.reasons })) }
            : undefined,
        },
        tx,
      );
      return m;
    });
    const visibleCandidates = await this.duplicates.visibleIds(ctx, candidates.map((c) => c.memberId));
    return {
      ...serializeMember(created),
      // ADM-070 : une fiche sans affectation n'est visible que des profils Crew/HR transversaux
      visible: await isMemberVisible(this.prisma, ctx, created.id),
      // Seules les fiches visibles sont citées ; une ressemblance hors périmètre n'est jamais identifiée
      forcedDuplicateOf: candidates.filter((c) => visibleCandidates.has(c.memberId)).map((c) => c.memberId),
      forcedOverHiddenDuplicate: candidates.some((c) => !visibleCandidates.has(c.memberId)),
    };
  }

  /** Modification avec diff before/after audité ; champs protégés et doublons revérifiés. */
  async update(ctx: AuthContext, id: string, dto: UpdateMemberDto) {
    await assertMemberVisible(this.prisma, ctx, id);
    const before = await this.prisma.member.findUniqueOrThrow({ where: { id } });
    if (before.archivedAt) throw Errors.invalidState('Fiche archivée : la restaurer avant toute modification');
    const { customFields, expectedUpdatedAt, force, forceReason, ...patch } = dto;
    if (expectedUpdatedAt && new Date(expectedUpdatedAt).getTime() !== before.updatedAt.getTime()) throw Errors.staleVersion();
    this.assertMemberData(
      {
        birthDate: patch.birthDate !== undefined ? patch.birthDate : before.birthDate,
        passportExpiry: patch.passportExpiry !== undefined ? patch.passportExpiry : before.passportExpiry,
        seamanBookExpiry: patch.seamanBookExpiry !== undefined ? patch.seamanBookExpiry : before.seamanBookExpiry,
        nationality: patch.nationality !== undefined ? patch.nationality : before.nationality,
        passportCountry: patch.passportCountry !== undefined ? patch.passportCountry : before.passportCountry,
      },
      patch,
    );

    const prot = changedProtectedFields(before as unknown as Record<string, unknown>, patch);
    if (prot.length) this.assertProtected(ctx, prot);
    if (patch.departmentId && patch.departmentId !== before.departmentId) await this.assertDepartmentAssignable(patch.departmentId);

    let newCandidates: DuplicateCandidate[] = [];
    const p = patch as Record<string, unknown>;
    const identityChanged = IDENTITY_FIELDS.some((f) => p[f] !== undefined && !sameValue((before as Record<string, unknown>)[f], p[f]));
    if (identityChanged) {
      const next = identityOfMember({ ...before, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) });
      const [after, prev] = await Promise.all([
        this.duplicates.find(next, { excludeIds: [id] }),
        this.duplicates.find(identityOfMember(before), { excludeIds: [id] }),
      ]);
      const known = new Set(prev.map((c) => c.memberId));
      newCandidates = after.filter((c) => !known.has(c.memberId));
      await this.guardDuplicates(ctx, newCandidates, force);
    }

    return this.prisma.$transaction(async (tx) => {
      // updatedAt explicite : la version avance aussi pour une modification des seuls champs personnalisés
      const res = await tx.member.updateMany({
        where: { id, updatedAt: before.updatedAt },
        data: { ...(patch as Prisma.MemberUncheckedUpdateManyInput), updatedAt: new Date() },
      });
      if (res.count === 0) throw Errors.staleVersion();
      const after = await tx.member.findUniqueOrThrow({ where: { id } });
      const custom = await this.writeCustomFields(tx, ctx, id, customFields ?? {}, 'staff', false);
      const diff = diffFields(serializeMember(before) as never, serializeMember(after) as never);
      delete (diff.before as Record<string, unknown> | undefined)?.updatedAt;
      delete (diff.after as Record<string, unknown> | undefined)?.updatedAt;
      await this.audit.record(
        ctx,
        {
          action: 'member.updated',
          module: 'members',
          entityType: 'member',
          entityId: id,
          before: { ...diff.before, ...(Object.keys(custom.before).length ? { customFields: custom.before } : {}) },
          after: { ...diff.after, ...(Object.keys(custom.after).length ? { customFields: custom.after } : {}) },
          metadata: newCandidates.length
            ? { forcedDuplicate: true, reason: forceReason, candidates: newCandidates.map((c) => ({ memberId: c.memberId, score: c.score, reasons: c.reasons })) }
            : undefined,
        },
        tx,
      );
      return serializeMember(after);
    });
  }

  /** Statut administratif manuel (AVAILABLE / ON_LEAVE / INACTIVE) ; ON_BOARD / PLANNED_JOIN suivent les affectations. */
  async setStatus(ctx: AuthContext, id: string, target: ManualMemberStatus, reason?: string) {
    await assertMemberVisible(this.prisma, ctx, id);
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.member.findUniqueOrThrow({ where: { id } });
      if (m.archivedAt) throw Errors.invalidState('Fiche archivée');
      const active = await this.activeAssignments(tx, id);
      const r = resolveManualStatus(target, active);
      if (!r.ok) throw Errors.invalidState(r.reason, active);
      if (r.status === m.status) return serializeMember(m);
      const res = await tx.member.updateMany({ where: { id, status: m.status }, data: { status: r.status } });
      if (res.count === 0) throw Errors.staleVersion();
      await this.audit.record(
        ctx,
        { action: 'member.status_changed', module: 'members', entityType: 'member', entityId: id, before: { status: m.status }, after: { status: r.status }, metadata: { reason, requested: target } },
        tx,
      );
      return serializeMember(await tx.member.findUniqueOrThrow({ where: { id } }));
    });
  }

  /** Archivage (jamais de suppression) : refusé tant qu'une affectation PLANNED / ONBOARD existe. */
  async archive(ctx: AuthContext, id: string, reason: string) {
    await assertMemberVisible(this.prisma, ctx, id);
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.member.findUniqueOrThrow({ where: { id } });
      if (m.archivedAt) throw Errors.alreadyProcessed('Fiche déjà archivée');
      const active = await this.activeAssignments(tx, id);
      if (active.onboard || active.planned) {
        throw Errors.invalidState('Affectation en cours ou planifiée : débarquer / annuler avant archivage', active);
      }
      const updated = await tx.member.update({ where: { id }, data: { archivedAt: new Date() } });
      await this.audit.record(ctx, { action: 'member.archived', module: 'members', entityType: 'member', entityId: id, metadata: { reason } }, tx);
      return serializeMember(updated);
    });
  }

  async restore(ctx: AuthContext, id: string) {
    await assertMemberVisible(this.prisma, ctx, id);
    return this.prisma.$transaction(async (tx) => {
      const m = await tx.member.findUniqueOrThrow({ where: { id } });
      if (!m.archivedAt) throw Errors.alreadyProcessed('Fiche non archivée');
      const updated = await tx.member.update({ where: { id }, data: { archivedAt: null } });
      await this.audit.record(ctx, { action: 'member.restored', module: 'members', entityType: 'member', entityId: id, before: { archivedAt: m.archivedAt } }, tx);
      return serializeMember(updated);
    });
  }

  // ---------------------------------------------------------------------------
  // Libre-service (ADM-032..035)
  // ---------------------------------------------------------------------------

  async getSelf(ctx: AuthContext) {
    if (!ctx.memberId) throw Errors.notFound('Fiche Member liée à votre compte');
    const detail = await this.buildDetail(ctx, ctx.memberId, true);
    const defs = await this.activeFieldDefs();
    return {
      ...detail,
      selfEditableFields: await this.settings.get('members.selfEditableFields'),
      selfEditableCustomFields: defs.filter((d) => d.selfEditable).map((d) => d.key),
    };
  }

  /** Mise à jour immédiate et auditée des seules coordonnées ouvertes au libre-service par le Super Admin. */
  async updateSelf(ctx: AuthContext, dto: SelfUpdateDto) {
    if (!ctx.memberId) throw Errors.notFound('Fiche Member liée à votre compte');
    const id = ctx.memberId;
    const { customFields, ...rest } = dto as SelfUpdateDto & Record<string, unknown>;
    const keys = Object.keys(rest).filter((k) => (rest as Record<string, unknown>)[k] !== undefined);
    const allowed = new Set<string>(await this.settings.get('members.selfEditableFields'));
    const denied = keys.filter((k) => !allowed.has(k));
    if (denied.length) {
      throw Errors.forbidden('Champs non modifiables en libre-service (données officielles tenues par Members)', { fields: denied, allowed: [...allowed] });
    }
    const before = await this.prisma.member.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Member');
    if (before.archivedAt) throw Errors.invalidState('Fiche archivée');
    const data = Object.fromEntries(keys.map((k) => [k, (rest as Record<string, unknown>)[k]]));
    await this.prisma.$transaction(async (tx) => {
      const after = keys.length ? await tx.member.update({ where: { id }, data }) : before;
      const custom = await this.writeCustomFields(tx, ctx, id, customFields ?? {}, 'self', false);
      const diff = diffFields(serializeMember(before) as never, serializeMember(after) as never);
      delete (diff.before as Record<string, unknown> | undefined)?.updatedAt;
      delete (diff.after as Record<string, unknown> | undefined)?.updatedAt;
      await this.audit.record(
        ctx,
        {
          action: 'member.self_updated',
          module: 'members',
          entityType: 'member',
          entityId: id,
          before: { ...diff.before, ...(Object.keys(custom.before).length ? { customFields: custom.before } : {}) },
          after: { ...diff.after, ...(Object.keys(custom.after).length ? { customFields: custom.after } : {}) },
        },
        tx,
      );
    });
    return this.getSelf(ctx);
  }

  // ---------------------------------------------------------------------------
  // Photo & documents (module Files)
  // ---------------------------------------------------------------------------

  async setPhoto(ctx: AuthContext, id: string, fileId: string | null) {
    await assertMemberVisible(this.prisma, ctx, id);
    const before = await this.prisma.member.findUniqueOrThrow({ where: { id } });
    if (before.archivedAt) throw Errors.invalidState('Fiche archivée');
    return this.prisma.$transaction(async (tx) => {
      if (fileId) await this.files.attach(ctx, fileId, { type: OWNER_MEMBER_PHOTO, id, contexts: ['MEMBER_PHOTO'] }, tx);
      const after = await tx.member.update({ where: { id }, data: { photoFileId: fileId } });
      await this.audit.record(
        ctx,
        { action: 'member.photo_changed', module: 'members', entityType: 'member', entityId: id, before: { photoFileId: before.photoFileId }, after: { photoFileId: fileId } },
        tx,
      );
      return serializeMember(after);
    });
  }

  async listDocuments(ctx: AuthContext, id: string, includeArchived: boolean) {
    await assertMemberVisible(this.prisma, ctx, id);
    const rows = await this.prisma.memberDocument.findMany({
      where: { memberId: id, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: 'desc' },
    });
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: rows.map((r) => r.fileId) } } });
    const byId = new Map(files.map((f) => [f.id, f]));
    return rows.map((r) => ({ ...r, file: byId.has(r.fileId) ? toFileDto(byId.get(r.fileId)!) : null }));
  }

  async addDocument(ctx: AuthContext, id: string, dto: AddMemberDocumentDto) {
    await assertMemberVisible(this.prisma, ctx, id);
    const m = await this.prisma.member.findUniqueOrThrow({ where: { id }, select: { archivedAt: true } });
    if (m.archivedAt) throw Errors.invalidState('Fiche archivée');
    return this.prisma.$transaction(async (tx) => {
      const doc = await tx.memberDocument.create({
        data: { memberId: id, fileId: dto.fileId, category: dto.category, title: dto.title, uploadedById: ctx.userId },
      });
      const file = await this.files.attach(ctx, dto.fileId, { type: OWNER_MEMBER_DOCUMENT, id: doc.id, contexts: ['MEMBER_DOCUMENT'] }, tx);
      await this.audit.record(
        ctx,
        { action: 'member.document_added', module: 'members', entityType: 'member_document', entityId: doc.id, after: { memberId: id, ...dto, fileName: file.originalName, sha256: file.sha256 } },
        tx,
      );
      return { ...doc, file: toFileDto(file) };
    });
  }

  async archiveDocument(ctx: AuthContext, id: string, documentId: string, reason?: string) {
    await assertMemberVisible(this.prisma, ctx, id);
    const doc = await this.prisma.memberDocument.findFirst({ where: { id: documentId, memberId: id } });
    if (!doc) throw Errors.notFound('Document');
    if (doc.archivedAt) throw Errors.alreadyProcessed('Document déjà archivé');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.memberDocument.update({ where: { id: documentId }, data: { archivedAt: new Date() } });
      await this.audit.record(
        ctx,
        { action: 'member.document_archived', module: 'members', entityType: 'member_document', entityId: documentId, metadata: { memberId: id, reason } },
        tx,
      );
      return updated;
    });
  }

  /** Lien éphémère (preview / download) : droits revérifiés par le resolver `member_document` + audit. */
  async documentLink(ctx: AuthContext, id: string, documentId: string, mode: 'preview' | 'download') {
    const doc = await this.prisma.memberDocument.findFirst({ where: { id: documentId, memberId: id } });
    if (!doc) throw Errors.notFound('Document');
    const file = await this.files.getOrThrow(doc.fileId);
    return this.files.issueLink(ctx, file, mode);
  }

  // ---------------------------------------------------------------------------
  // Champs personnalisés (valeurs) — ADM-036..039
  // ---------------------------------------------------------------------------

  private activeFieldDefs(db: Db = this.prisma): Promise<FieldDefWithSection[]> {
    return db.memberFieldDefinition.findMany({
      where: { archivedAt: null, OR: [{ sectionId: null }, { section: { archivedAt: null } }] },
      include: { section: { select: { id: true, name: true, sortOrder: true, archivedAt: true } } },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Champ visible : permission dédiée (défaut members.view) ; pour sa propre fiche, champs non restreints ou self-editables. */
  private canViewField(ctx: AuthContext, d: MemberFieldDefinition, self: boolean): boolean {
    if (self && (d.selfEditable || !d.viewPermission)) return true;
    return can(ctx, d.viewPermission ?? 'members.view');
  }

  private canEditField(ctx: AuthContext, d: MemberFieldDefinition): boolean {
    return can(ctx, d.editPermission ?? 'members.edit') && this.canViewField(ctx, d, false);
  }

  /**
   * Écrit les valeurs de champs personnalisés (null = effacement) après contrôle de type et de
   * permission d'édition par champ. `enforceRequired` (création) : champs obligatoires éditables requis.
   */
  private async writeCustomFields(
    tx: Tx,
    ctx: AuthContext,
    memberId: string,
    values: Record<string, unknown>,
    mode: 'staff' | 'self',
    enforceRequired: boolean,
  ): Promise<{ before: Record<string, unknown>; after: Record<string, unknown> }> {
    const keys = Object.keys(values);
    const result = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
    const errors: { key: string; message: string }[] = [];
    if (enforceRequired && mode === 'staff') {
      const required = await tx.memberFieldDefinition.findMany({
        where: { required: true, archivedAt: null, OR: [{ sectionId: null }, { section: { archivedAt: null } }] },
      });
      for (const d of required) {
        if (this.canEditField(ctx, d) && (values[d.key] === undefined || values[d.key] === null || values[d.key] === '')) {
          errors.push({ key: d.key, message: `${d.label} : champ obligatoire` });
        }
      }
    }
    if (!keys.length) {
      if (errors.length) throw Errors.validation('Champs personnalisés invalides', { errors });
      return result;
    }
    const defs = await tx.memberFieldDefinition.findMany({
      where: { key: { in: keys } },
      include: { section: { select: { archivedAt: true } } },
    });
    const byKey = new Map(defs.map((d) => [d.key, d]));
    const forbidden: string[] = [];
    const writes: { def: MemberFieldDefinition; value: unknown }[] = [];
    for (const key of keys) {
      const def = byKey.get(key);
      if (!def) {
        errors.push({ key, message: 'Champ personnalisé inconnu' });
        continue;
      }
      if (def.archivedAt || def.section?.archivedAt) {
        errors.push({ key, message: `${def.label} : champ archivé (non modifiable)` });
        continue;
      }
      const allowed = mode === 'self' ? def.selfEditable : this.canEditField(ctx, def);
      if (!allowed) {
        forbidden.push(key);
        continue;
      }
      const v = validateCustomFieldValue(def, values[key]);
      if (!v.ok) errors.push({ key, message: v.message });
      else writes.push({ def, value: v.value });
    }
    if (forbidden.length) throw Errors.forbidden('Champs personnalisés non modifiables avec vos droits', { fields: forbidden });
    if (errors.length) throw Errors.validation('Champs personnalisés invalides', { errors });

    const existing = await tx.memberFieldValue.findMany({ where: { memberId, fieldId: { in: writes.map((w) => w.def.id) } } });
    const current = new Map(existing.map((e) => [e.fieldId, e.value]));
    for (const w of writes) {
      const prev = current.get(w.def.id) ?? null;
      if (sameValue(prev, w.value)) continue;
      if (w.value === null) {
        await tx.memberFieldValue.deleteMany({ where: { memberId, fieldId: w.def.id } });
      } else {
        await tx.memberFieldValue.upsert({
          where: { memberId_fieldId: { memberId, fieldId: w.def.id } },
          create: { memberId, fieldId: w.def.id, value: w.value as Prisma.InputJsonValue, updatedById: ctx.userId },
          update: { value: w.value as Prisma.InputJsonValue, updatedById: ctx.userId },
        });
      }
      result.before[w.def.key] = prev;
      result.after[w.def.key] = w.value;
    }
    return result;
  }

  // ---------------------------------------------------------------------------

  /**
   * Fiches dont le matricule, le passeport ou le seaman book contient la saisie, comparés sans
   * espaces ni ponctuation des deux côtés (audit FLT-04 : la reprise a stocké « TG 2384 »).
   * Même normalisation que la détection des doublons (member-duplicates.service.ts).
   */
  private async identifierMatches(search: string): Promise<string[]> {
    const key = searchIdentifierKey(search);
    if (!key) return [];
    const pattern = `%${key}%`;
    const rows = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM members
      WHERE regexp_replace(upper(coalesce(amc_ref, '')), '[^A-Z0-9]', '', 'g') LIKE ${pattern}
         OR regexp_replace(upper(coalesce(passport_number, '')), '[^A-Z0-9]', '', 'g') LIKE ${pattern}
         OR regexp_replace(upper(coalesce(seaman_book_number, '')), '[^A-Z0-9]', '', 'g') LIKE ${pattern}
      LIMIT 5000`);
    return rows.map((r) => r.id);
  }

  /**
   * Mêmes contrôles que l'import (audit FLT-13). En modification, seuls les champs envoyés sont
   * jugés : une donnée reprise incohérente ne bloque pas la correction d'un autre champ.
   */
  private assertMemberData(
    m: { birthDate?: Date | null; passportExpiry?: Date | null; seamanBookExpiry?: Date | null; nationality?: string | null; passportCountry?: string | null },
    patch?: Record<string, unknown>,
  ) {
    let issues = memberDataIssues({
      birthDate: ymd(m.birthDate),
      passportExpiry: ymd(m.passportExpiry),
      seamanBookExpiry: ymd(m.seamanBookExpiry),
      nationality: m.nationality,
      passportCountry: m.passportCountry,
    });
    if (patch) {
      const sent = (f: string) => patch[f] !== undefined;
      issues = issues.filter((i) => sent(i.field) || ((i.field === 'passportExpiry' || i.field === 'seamanBookExpiry') && sent('birthDate')));
    }
    if (issues.length) {
      throw Errors.validation(issues.map((i) => i.message).join(' ; '), issues.map((i) => ({ path: i.field, message: i.message })));
    }
  }

  private assertProtected(ctx: AuthContext, fields: string[]) {
    if (!can(ctx, 'members.personal_fields.manage')) {
      throw Errors.forbidden('Données personnelles protégées : permission members.personal_fields.manage requise', {
        permission: 'members.personal_fields.manage',
        fields,
      });
    }
  }

  /** 409 DUPLICATE avec candidats, sauf force (motif validé par le DTO) ; matricule identique jamais forçable. */
  private async guardDuplicates(ctx: AuthContext, candidates: DuplicateCandidate[], force: boolean) {
    if (!candidates.length) return;
    const sameRef = candidates.filter((c) => c.reasons.includes('AMC_REF'));
    if (sameRef.length) {
      throw Errors.duplicate('Matricule AMC déjà attribué à une autre fiche : enregistrement impossible, même forcé', {
        reason: 'AMC_REF',
        candidates: await this.duplicates.present(ctx, sameRef),
      });
    }
    if (!force) {
      throw Errors.duplicate(
        'Doublon potentiel : une fiche ressemblante existe déjà. Vérifiez les candidats ou confirmez avec force=true et un motif.',
        { candidates: await this.duplicates.present(ctx, candidates) },
      );
    }
  }

  private async assertDepartmentAssignable(departmentId: string) {
    const dep = await this.prisma.department.findUnique({ where: { id: departmentId }, select: { status: true } });
    if (!dep) throw Errors.notFound('Département');
    if (dep.status !== 'ACTIVE') throw Errors.business('Département inactif : nouvelle affectation impossible (ADM-028)');
  }

  private async activeAssignments(db: Db, memberId: string) {
    const [onboard, planned] = await Promise.all([
      db.crewAssignment.count({ where: { memberId, status: 'ONBOARD' } }),
      db.crewAssignment.count({ where: { memberId, status: 'PLANNED' } }),
    ]);
    return { onboard, planned };
  }
}
