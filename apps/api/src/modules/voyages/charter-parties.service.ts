import { Injectable, OnModuleInit } from '@nestjs/common';
import { CharterParty, CpVersion, Prisma } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { creatorLabels } from '../../common/utils/creators';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService, toFileDto } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  CancelCharterPartyDto,
  CreateCharterPartyDto,
  ListCharterPartiesQuery,
  SubmitCpVersionDto,
  UpdateCharterPartyDto,
} from './charter-parties.dto';
import { OWNER_CP_VERSION, canAccessCp, cpScopeWhere, filterCpAudience, onboardMasters, userLabels } from './voyages.common';
import { escapeLike } from '../../common/utils/like';
import {
  CP_CONTRACT_FIELDS,
  CpContractField,
  buildCpClauses,
  clausesToCpData,
  cpReferenceKey,
  diffClauses,
  opposableVersion,
  pendingVersion,
  planCpApproval,
  validateNewCpVersion,
} from './voyages.logic';

type Clauses = Record<string, string | null>;

function contractFieldsOf(cp: CharterParty): Partial<Record<CpContractField, unknown>> {
  const out: Partial<Record<CpContractField, unknown>> = {};
  for (const f of CP_CONTRACT_FIELDS) out[f] = cp[f];
  return out;
}

/**
 * Charter Parties (CDC §7.2, V1 §10.1) — confidentielles (charter_party.view).
 * Clauses en texte contrôlé, jamais interprétées ni calculées (pas de laytime automatique).
 * Chaque nouvelle CP ou révision officielle est approuvée par un AUTRE utilisateur habilité ;
 * la version approuvée précédente reste opposable jusqu'à l'approbation de la suivante.
 */
@Injectable()
export class CharterPartiesService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    // PDF de CP : consultation = charter_party.view + périmètre ; téléchargement réservé aux
    // gestionnaires / approbateurs CP (document contractuel confidentiel).
    this.registry.register(OWNER_CP_VERSION, async (ctx, file, mode) => {
      this.access.assertCan(ctx, 'charter_party.view');
      if (mode === 'download' && !can(ctx, 'charter_party.manage') && !can(ctx, 'charter_party.approve')) {
        throw Errors.forbidden('Téléchargement d’une Charter Party réservé aux gestionnaires / approbateurs CP', {
          anyOf: ['charter_party.manage', 'charter_party.approve'],
        });
      }
      const version = await this.prisma.cpVersion.findUnique({
        where: { id: file.ownerId! },
        include: { charterParty: { select: { id: true, reference: true, vesselId: true, voyages: { select: { vesselId: true } } } } },
      });
      if (!version) throw Errors.notFound('Fichier');
      if (!canAccessCp(ctx, version.charterParty)) throw Errors.scopeDenied();
      return {
        module: 'voyages',
        entityType: 'cp_version',
        entityId: version.id,
        vesselId: version.charterParty.vesselId,
        downloadName: `CP-${version.charterParty.reference}-v${version.versionNo}.${file.extension}`.replace(/[^\w.-]+/g, '_'),
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  async getAccessible(ctx: AuthContext, id: string, db: Db = this.prisma) {
    const cp = await db.charterParty.findUnique({ where: { id }, include: { voyages: { select: { id: true, vesselId: true } } } });
    if (!cp) throw Errors.notFound('Charter Party');
    if (!canAccessCp(ctx, cp)) throw Errors.scopeDenied();
    return cp;
  }

  async list(ctx: AuthContext, q: ListCharterPartiesQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const where: Prisma.CharterPartyWhereInput = {
      AND: [
        cpScopeWhere(ctx),
        q.vesselId ? { vesselId: q.vesselId } : {},
        q.status ? { status: q.status } : {},
        q.voyageId ? { voyages: { some: { id: q.voyageId } } } : {},
        q.search
          ? {
              OR: [
                { reference: { contains: escapeLike(q.search), mode: 'insensitive' } },
                { charterer: { contains: escapeLike(q.search), mode: 'insensitive' } },
                { owner: { contains: escapeLike(q.search), mode: 'insensitive' } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.charterParty.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          vessel: { select: { id: true, code: true, name: true } },
          currentVersion: { select: { id: true, versionNo: true, kind: true, decidedAt: true } },
          voyages: { where: vesselWhere(ctx) as Prisma.VoyageWhereInput, select: { id: true, reference: true, status: true } },
          _count: { select: { versions: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.charterParty.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    const creators = await creatorLabels(this.prisma, page.items.map((cp) => cp.createdById));
    return { ...page, items: page.items.map((cp) => ({ ...cp, createdBy: creators.get(cp.createdById) ?? null })) };
  }

  async get(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    const cp = await this.prisma.charterParty.findUniqueOrThrow({
      where: { id },
      include: {
        vessel: { select: { id: true, code: true, name: true, imoNumber: true } },
        voyages: { where: vesselWhere(ctx) as Prisma.VoyageWhereInput, select: { id: true, reference: true, status: true, vesselId: true } },
      },
    });
    const [versions, creators] = await Promise.all([this.listVersions(ctx, id), creatorLabels(this.prisma, [cp.createdById])]);
    return {
      ...cp,
      createdBy: creators.get(cp.createdById) ?? null,
      versions,
      opposableVersion: opposableVersion(versions),
      pendingVersion: pendingVersion(versions),
      permissions: {
        manage: can(ctx, 'charter_party.manage'),
        approve: can(ctx, 'charter_party.approve'),
        editDraft: can(ctx, 'charter_party.manage') && cp.status === 'DRAFT',
      },
    };
  }

  async listVersions(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    const versions = await this.prisma.cpVersion.findMany({
      where: { charterPartyId: id },
      orderBy: { versionNo: 'desc' },
      include: { acknowledgements: { select: { userId: true, acknowledgedAt: true } } },
    });
    const [labels, files] = await Promise.all([
      userLabels(this.prisma, versions.flatMap((v) => [v.submittedById, v.decidedById])),
      this.prisma.storedFile.findMany({ where: { id: { in: versions.map((v) => v.fileId).filter((x): x is string => !!x) } } }),
    ]);
    return versions.map(({ acknowledgements, ...v }) => ({
      ...v,
      submittedBy: labels.get(v.submittedById) ?? null,
      decidedBy: v.decidedById ? labels.get(v.decidedById) ?? null : null,
      file: v.fileId ? (files.find((f) => f.id === v.fileId) ? toFileDto(files.find((f) => f.id === v.fileId)!) : null) : null,
      opposable: v.status === 'APPROVED' && !v.supersededAt,
      acknowledgementCount: acknowledgements.length,
      acknowledgedByMe: acknowledgements.find((a) => a.userId === ctx.userId)?.acknowledgedAt ?? null,
    }));
  }

  // ---------------------------------------------------------------------------
  // Création / brouillon
  // ---------------------------------------------------------------------------

  async create(ctx: AuthContext, dto: CreateCharterPartyDto) {
    if (dto.vesselId) {
      this.access.assertVesselAccess(ctx, dto.vesselId);
      if (!(await this.prisma.vessel.count({ where: { id: dto.vesselId } }))) throw Errors.notFound('Navire');
    } else if (ctx.vesselScope.mode !== 'ALL_FLEET') {
      // Une CP sans navire n'est pas cloisonnable : réservée aux utilisateurs « toute la flotte »
      throw Errors.validation('vesselId requis : votre périmètre est limité à certains navires');
    }
    await this.assertReferenceFree(dto.reference);
    return this.prisma.$transaction(async (tx) => {
      const cp = await tx.charterParty.create({
        data: { ...dto, status: 'DRAFT', createdById: ctx.userId } as Prisma.CharterPartyUncheckedCreateInput,
      });
      await this.audit.record(
        ctx,
        { action: 'charter_party.created', module: 'voyages', entityType: 'charter_party', entityId: cp.id, vesselId: cp.vesselId, after: cp },
        tx,
      );
      return cp;
    });
  }

  /** Modification directe limitée au brouillon : ensuite, toute modification passe par une version. */
  async update(ctx: AuthContext, id: string, dto: UpdateCharterPartyDto) {
    const before = await this.getAccessible(ctx, id);
    if (before.status !== 'DRAFT') {
      throw Errors.invalidState('Charter Party soumise ou approuvée : toute modification passe par une nouvelle version (avenant / révision)', {
        status: before.status,
      });
    }
    if (dto.reference && dto.reference !== before.reference) await this.assertReferenceFree(dto.reference, id);
    if (dto.vesselId !== undefined && dto.vesselId !== before.vesselId) {
      if (dto.vesselId) {
        this.access.assertVesselAccess(ctx, dto.vesselId);
        if (before.voyages.some((v) => v.vesselId !== dto.vesselId)) throw Errors.validation('Charter Party rattachée à un voyage d’un autre navire');
      } else if (ctx.vesselScope.mode !== 'ALL_FLEET') {
        throw Errors.validation('vesselId requis : votre périmètre est limité à certains navires');
      }
    }
    const laycanFrom = dto.laycanFrom !== undefined ? dto.laycanFrom : before.laycanFrom;
    const laycanTo = dto.laycanTo !== undefined ? dto.laycanTo : before.laycanTo;
    if (laycanFrom && laycanTo && laycanFrom > laycanTo) throw Errors.validation('Laycan : la date de début doit précéder la date de fin');

    return this.prisma.$transaction(async (tx) => {
      const res = await tx.charterParty.updateMany({ where: { id, status: 'DRAFT' }, data: dto as Prisma.CharterPartyUncheckedUpdateManyInput });
      if (res.count === 0) throw Errors.alreadyProcessed('Charter Party déjà soumise : modification impossible');
      const after = await tx.charterParty.findUniqueOrThrow({ where: { id } });
      const { voyages: _v, ...b } = before;
      const { updatedAt: _u1, ...bb } = b;
      const { updatedAt: _u2, ...aa } = after;
      await this.audit.record(
        ctx,
        { action: 'charter_party.updated', module: 'voyages', entityType: 'charter_party', entityId: id, vesselId: after.vesselId, ...diffFields(bb as never, aa as never) },
        tx,
      );
      return after;
    });
  }

  async cancel(ctx: AuthContext, id: string, dto: CancelCharterPartyDto) {
    const cp = await this.getAccessible(ctx, id);
    if (cp.status === 'CANCELLED') throw Errors.alreadyProcessed('Charter Party déjà annulée');
    return this.prisma.$transaction(async (tx) => {
      const pending = await tx.cpVersion.updateMany({ where: { charterPartyId: id, status: 'PENDING_APPROVAL' }, data: { status: 'CANCELLED', decidedById: ctx.userId, decidedAt: new Date(), decisionComment: dto.reason } });
      const res = await tx.charterParty.updateMany({ where: { id, status: { not: 'CANCELLED' } }, data: { status: 'CANCELLED' } });
      if (res.count === 0) throw Errors.alreadyProcessed('Charter Party déjà annulée');
      const openVoyages = await tx.voyage.count({ where: { charterPartyId: id, status: { in: ['DRAFT', 'PLANNED', 'ACTIVE'] } } });
      await this.audit.record(
        ctx,
        {
          action: 'charter_party.cancelled',
          module: 'voyages',
          entityType: 'charter_party',
          entityId: id,
          vesselId: cp.vesselId,
          before: { status: cp.status },
          after: { status: 'CANCELLED' },
          metadata: { reason: dto.reason, pendingVersionsCancelled: pending.count, openVoyagesLinked: openVoyages },
        },
        tx,
      );
      return tx.charterParty.findUniqueOrThrow({ where: { id } });
    });
  }

  /** Unicité sans casse ni espaces (audit FLT-16) : les références historiques ne sont pas réécrites. */
  private async assertReferenceFree(reference: string, excludeId?: string) {
    const key = cpReferenceKey(reference);
    const dup = await this.prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM charter_parties
      WHERE regexp_replace(upper(reference), '[[:space:]]', '', 'g') = ${key}
        ${excludeId ? Prisma.sql`AND id <> ${excludeId}::uuid` : Prisma.empty}
      LIMIT 1`);
    if (dup.length) throw Errors.duplicate('Une Charter Party avec cette référence existe déjà', { field: 'reference' });
  }

  // ---------------------------------------------------------------------------
  // Versions : soumission, approbation (autre utilisateur), refus, retrait
  // ---------------------------------------------------------------------------

  /**
   * Nouvelle version officielle (ORIGINAL / ADDENDUM / REVISION) en attente d'approbation.
   * Le snapshot `clauses` = valeurs en vigueur + modifications EXPLICITEMENT fournies.
   */
  async submitVersion(ctx: AuthContext, id: string, dto: SubmitCpVersionDto) {
    const cp = await this.getAccessible(ctx, id);
    if (cp.status === 'CANCELLED') throw Errors.invalidState('Charter Party annulée');
    const versions = await this.prisma.cpVersion.findMany({ where: { charterPartyId: id } });
    const err = validateNewCpVersion(versions, dto.kind);
    if (err) throw Errors.invalidState(err);

    const clauses = buildCpClauses(contractFieldsOf(cp), dto.changes as Partial<Record<CpContractField, unknown>> | undefined);
    if (clauses.laycanFrom && clauses.laycanTo && clauses.laycanFrom > clauses.laycanTo) {
      throw Errors.validation('Laycan : la date de début doit précéder la date de fin');
    }
    const current = opposableVersion(versions);
    const changedFields = diffClauses((current?.clauses as Clauses | null) ?? null, clauses);
    if (dto.kind !== 'ORIGINAL' && !changedFields.length && !dto.fileId) {
      throw Errors.business('Aucune clause modifiée ni document joint : version sans objet');
    }

    const version = await this.prisma.serializable(async (tx) => {
      const last = await tx.cpVersion.aggregate({ where: { charterPartyId: id }, _max: { versionNo: true } });
      const v = await tx.cpVersion.create({
        data: {
          charterPartyId: id,
          versionNo: (last._max.versionNo ?? 0) + 1,
          kind: dto.kind,
          summary: dto.summary ?? null,
          clauses: clauses as Prisma.InputJsonValue,
          status: 'PENDING_APPROVAL',
          submittedById: ctx.userId,
        },
      });
      if (dto.fileId) {
        await this.files.attach(ctx, dto.fileId, { type: OWNER_CP_VERSION, id: v.id, contexts: ['CHARTER_PARTY'], vesselId: cp.vesselId }, tx);
        await tx.cpVersion.update({ where: { id: v.id }, data: { fileId: dto.fileId } });
      }
      // Tant qu'aucune version n'est approuvée, la CP passe en attente ; sinon l'ancienne reste opposable
      if (!current) await tx.charterParty.update({ where: { id }, data: { status: 'PENDING_APPROVAL' } });
      await this.audit.record(
        ctx,
        {
          action: 'charter_party.version_submitted',
          module: 'voyages',
          entityType: 'cp_version',
          entityId: v.id,
          vesselId: cp.vesselId,
          after: { versionNo: v.versionNo, kind: v.kind, fileId: dto.fileId ?? null, summary: v.summary },
          metadata: { charterPartyId: id, reference: cp.reference, changedFields },
        },
        tx,
      );
      const approvers = await filterCpAudience(tx, cp, await this.access.usersWithPermission('charter_party.approve', cp.vesselId, tx));
      await this.notifications.notify(
        {
          userIds: approvers,
          excludeUserIds: [ctx.userId],
          type: 'charter_party.approval_requested',
          title: `Charter Party ${cp.reference} v${v.versionNo} (${v.kind}) à approuver`,
          body: `Soumise par ${ctx.displayName}. L’approbation doit être faite par un autre utilisateur habilité.`,
          module: 'voyages',
          entityType: 'charter_party',
          entityId: id,
          vesselId: cp.vesselId,
          link: `/charter-parties/${id}`,
          priority: 'HIGH',
          dedupeKey: `cp-version:${v.id}:submitted`,
          email: true,
          requiredPermission: 'charter_party.approve',
        },
        tx,
      );
      return v;
    });
    return { ...version, changedFields };
  }

  /**
   * Approbation (CDC §7.2, §12) — transaction SERIALIZABLE, dans cet ordre :
   * 1) superseded_at sur l'ancienne version opposable, 2) nouvelle version APPROVED,
   * 3) current_version_id + clauses en vigueur sur la CP. Auto-approbation interdite.
   */
  async approveVersion(ctx: AuthContext, id: string, versionId: string, comment?: string) {
    const cp = await this.getAccessible(ctx, id);
    if (cp.status === 'CANCELLED') throw Errors.invalidState('Charter Party annulée');
    const result = await this.prisma.serializable(async (tx) => {
      const versions = await tx.cpVersion.findMany({ where: { charterPartyId: id } });
      const plan = planCpApproval(versions, versionId, ctx.userId);
      if (!plan.ok) {
        if (plan.reason === 'NOT_FOUND') throw Errors.notFound('Version de Charter Party');
        if (plan.reason === 'SELF_APPROVAL') throw Errors.selfApproval();
        throw Errors.alreadyProcessed('Version déjà traitée');
      }
      const target = versions.find((v) => v.id === versionId)!;
      const previous = opposableVersion(versions);
      const now = new Date();
      for (const oldId of plan.supersedeIds) {
        await tx.cpVersion.updateMany({ where: { id: oldId, status: 'APPROVED', supersededAt: null }, data: { supersededAt: now } });
      }
      const res = await tx.cpVersion.updateMany({
        where: { id: versionId, status: 'PENDING_APPROVAL' },
        data: { status: 'APPROVED', decidedById: ctx.userId, decidedAt: now, decisionComment: comment ?? null },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Version déjà traitée');
      const clauses = (target.clauses as Clauses | null) ?? buildCpClauses(contractFieldsOf(cp), undefined);
      await tx.charterParty.update({
        where: { id },
        data: { currentVersionId: versionId, status: 'APPROVED', ...(clausesToCpData(clauses) as Prisma.CharterPartyUncheckedUpdateInput) },
      });
      await this.audit.record(
        ctx,
        {
          action: 'charter_party.version_approved',
          module: 'voyages',
          entityType: 'cp_version',
          entityId: versionId,
          vesselId: cp.vesselId,
          before: { currentVersionId: previous?.id ?? null, currentVersionNo: previous?.versionNo ?? null },
          after: { currentVersionId: versionId, currentVersionNo: target.versionNo },
          metadata: { charterPartyId: id, reference: cp.reference, kind: target.kind, superseded: plan.supersedeIds, comment },
        },
        tx,
      );
      await this.notifyApproved(ctx, cp, target, tx);
      return tx.cpVersion.findUniqueOrThrow({ where: { id: versionId } });
    });
    return result;
  }

  /** Masters (noon.submit sur le navire) : accusé de lecture attendu ; soumetteur informé. */
  private async notifyApproved(ctx: AuthContext, cp: { id: string; reference: string; vesselId: string | null; voyages: { vesselId: string }[] }, v: CpVersion, tx: Db) {
    const vesselIds = [...new Set([cp.vesselId, ...cp.voyages.map((x) => x.vesselId)].filter((x): x is string => !!x))];
    for (const vesselId of vesselIds) {
      const masters = await onboardMasters(this.access, tx, vesselId);
      await this.notifications.notify(
        {
          userIds: masters,
          type: 'charter_party.version_approved',
          title: `Charter Party ${cp.reference} v${v.versionNo} en vigueur — accusé de lecture attendu`,
          module: 'voyages',
          entityType: 'charter_party',
          entityId: cp.id,
          vesselId,
          link: `/charter-parties/${cp.id}`,
          dedupeKey: `cp-version:${v.id}:approved`,
          email: true,
          requiredPermission: 'charter_party.view',
        },
        tx,
      );
    }
    await this.notifications.notify(
      {
        userIds: await filterCpAudience(tx, cp, [v.submittedById]),
        excludeUserIds: [ctx.userId],
        type: 'charter_party.version_decided',
        title: `Charter Party ${cp.reference} v${v.versionNo} approuvée`,
        module: 'voyages',
        entityType: 'charter_party',
        entityId: cp.id,
        vesselId: cp.vesselId,
        link: `/charter-parties/${cp.id}`,
        dedupeKey: `cp-version:${v.id}:decided`,
        requiredPermission: 'charter_party.view',
      },
      tx,
    );
  }

  /** Refus par un autre utilisateur habilité ; la version opposable éventuelle reste en vigueur. */
  async rejectVersion(ctx: AuthContext, id: string, versionId: string, comment: string) {
    const cp = await this.getAccessible(ctx, id);
    return this.prisma.serializable(async (tx) => {
      const v = await tx.cpVersion.findFirst({ where: { id: versionId, charterPartyId: id } });
      if (!v) throw Errors.notFound('Version de Charter Party');
      if (v.status !== 'PENDING_APPROVAL') throw Errors.alreadyProcessed('Version déjà traitée');
      if (v.submittedById === ctx.userId) throw Errors.selfApproval();
      const res = await tx.cpVersion.updateMany({
        where: { id: versionId, status: 'PENDING_APPROVAL' },
        data: { status: 'REJECTED', decidedById: ctx.userId, decidedAt: new Date(), decisionComment: comment },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Version déjà traitée');
      await this.restoreCpStatus(id, tx);
      await this.audit.record(
        ctx,
        {
          action: 'charter_party.version_rejected',
          module: 'voyages',
          entityType: 'cp_version',
          entityId: versionId,
          vesselId: cp.vesselId,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'REJECTED' },
          metadata: { charterPartyId: id, versionNo: v.versionNo, comment },
        },
        tx,
      );
      await this.notifications.notify(
        {
          userIds: await filterCpAudience(tx, cp, [v.submittedById]),
          type: 'charter_party.version_decided',
          title: `Charter Party ${cp.reference} v${v.versionNo} refusée`,
          body: comment,
          module: 'voyages',
          entityType: 'charter_party',
          entityId: id,
          vesselId: cp.vesselId,
          link: `/charter-parties/${id}`,
          dedupeKey: `cp-version:${v.id}:decided`,
          email: true,
          requiredPermission: 'charter_party.view',
        },
        tx,
      );
      return tx.cpVersion.findUniqueOrThrow({ where: { id: versionId } });
    });
  }

  /** Retrait d'une version en attente par un gestionnaire CP (avant décision). */
  async withdrawVersion(ctx: AuthContext, id: string, versionId: string, reason: string) {
    const cp = await this.getAccessible(ctx, id);
    return this.prisma.serializable(async (tx) => {
      const v = await tx.cpVersion.findFirst({ where: { id: versionId, charterPartyId: id } });
      if (!v) throw Errors.notFound('Version de Charter Party');
      const res = await tx.cpVersion.updateMany({
        where: { id: versionId, status: 'PENDING_APPROVAL' },
        data: { status: 'CANCELLED', decidedById: ctx.userId, decidedAt: new Date(), decisionComment: reason },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Version déjà traitée');
      await this.restoreCpStatus(id, tx);
      await this.audit.record(
        ctx,
        {
          action: 'charter_party.version_withdrawn',
          module: 'voyages',
          entityType: 'cp_version',
          entityId: versionId,
          vesselId: cp.vesselId,
          before: { status: 'PENDING_APPROVAL' },
          after: { status: 'CANCELLED' },
          metadata: { charterPartyId: id, versionNo: v.versionNo, reason },
        },
        tx,
      );
      return tx.cpVersion.findUniqueOrThrow({ where: { id: versionId } });
    });
  }

  /** Sans version opposable, une CP dont la version a été refusée / retirée revient en brouillon. */
  private async restoreCpStatus(id: string, tx: Db) {
    const current = await tx.cpVersion.count({ where: { charterPartyId: id, status: 'APPROVED', supersededAt: null } });
    await tx.charterParty.updateMany({
      where: { id, status: { not: 'CANCELLED' } },
      data: { status: current ? 'APPROVED' : 'DRAFT' },
    });
  }

  // ---------------------------------------------------------------------------
  // Accusés de lecture du Master (CDC §7.2)
  // ---------------------------------------------------------------------------

  async acknowledge(ctx: AuthContext, id: string, versionId: string) {
    const cp = await this.getAccessible(ctx, id);
    const v = await this.prisma.cpVersion.findFirst({ where: { id: versionId, charterPartyId: id } });
    if (!v) throw Errors.notFound('Version de Charter Party');
    if (v.status !== 'APPROVED' || v.supersededAt) {
      throw Errors.invalidState('Seule la version en vigueur (approuvée, non remplacée) peut faire l’objet d’un accusé de lecture');
    }
    const existing = await this.prisma.cpAcknowledgement.findUnique({ where: { cpVersionId_userId: { cpVersionId: versionId, userId: ctx.userId } } });
    if (existing) return { ...existing, alreadyAcknowledged: true };
    return this.prisma.$transaction(async (tx) => {
      const ack = await tx.cpAcknowledgement.create({ data: { cpVersionId: versionId, userId: ctx.userId } });
      await this.audit.record(
        ctx,
        {
          action: 'charter_party.acknowledged',
          module: 'voyages',
          entityType: 'cp_version',
          entityId: versionId,
          vesselId: cp.vesselId,
          metadata: { charterPartyId: id, reference: cp.reference, versionNo: v.versionNo },
        },
        tx,
      );
      return { ...ack, alreadyAcknowledged: false };
    });
  }

  /** Qui a accusé lecture + Masters attendus (noon.submit sur le navire) n'ayant pas encore lu. */
  async listAcknowledgements(ctx: AuthContext, id: string, versionId: string) {
    const cp = await this.getAccessible(ctx, id);
    const v = await this.prisma.cpVersion.findFirst({ where: { id: versionId, charterPartyId: id }, select: { id: true, versionNo: true, status: true } });
    if (!v) throw Errors.notFound('Version de Charter Party');
    const acks = await this.prisma.cpAcknowledgement.findMany({ where: { cpVersionId: versionId }, orderBy: { acknowledgedAt: 'asc' } });
    const expected = cp.vesselId ? await onboardMasters(this.access, this.prisma, cp.vesselId) : [];
    const labels = await userLabels(this.prisma, [...acks.map((a) => a.userId), ...expected]);
    return {
      version: v,
      acknowledgements: acks.map((a) => ({ userId: a.userId, displayName: labels.get(a.userId) ?? null, acknowledgedAt: a.acknowledgedAt })),
      pendingMasters: expected
        .filter((u) => !acks.some((a) => a.userId === u))
        .map((u) => ({ userId: u, displayName: labels.get(u) ?? null })),
    };
  }

  /** Lien éphémère vers le PDF d'une version (resolver cp_version : droits revérifiés). */
  async versionFileLink(ctx: AuthContext, id: string, versionId: string, mode: 'preview' | 'download') {
    await this.getAccessible(ctx, id);
    const v = await this.prisma.cpVersion.findFirst({ where: { id: versionId, charterPartyId: id }, select: { fileId: true } });
    if (!v) throw Errors.notFound('Version de Charter Party');
    if (!v.fileId) throw Errors.notFound('Document de la version');
    return this.files.issueLink(ctx, v.fileId, mode);
  }
}
