import { Injectable, OnModuleInit } from '@nestjs/common';
import type { CsoDocument, CsoVersion, Prisma, StoredFile } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { FileAccessGrant, FileAccessMode, FileAccessRegistry } from '../files/file-access.registry';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { ActionMap, canAccessVersion, grantedActions } from './cso-acl.logic';
import { CsoAccessService, OWNER_CSO_VERSION } from './cso-access.service';
import { CsoFieldsService } from './cso-fields.service';
import { CsoFoldersService } from './cso-folders.service';
import {
  dateOnlyString,
  isUniqueViolation,
  presentDocumentSummary,
  presentLibrary,
  presentVersion,
  userLabels,
} from './cso-presenters';
import { DECISION_TARGET, IN_FLIGHT_VERSION, documentFileName, missingStandardFields, normalizeReference, restorePlan } from './cso-rules';
import { CsoWorkflowService } from './cso-workflow.service';
import type {
  ArchiveDto,
  CopyDocumentDto,
  CreateDocumentDto,
  ListDocumentsQuery,
  LockVersionDto,
  MoveDocumentDto,
  NewVersionDto,
  ReferenceChangeDto,
  ReferenceDecisionDto,
  RestoreDocumentDto,
  UpdateDocumentDto,
  VersionDecisionDto,
} from './cso.dto';

const DECIDED: CsoVersion['status'][] = ['PUBLISHED', 'REJECTED', 'RETURNED', 'CANCELLED', 'SUPERSEDED'];
const DECISION_AUDIT = { APPROVE: 'cso.version.approved', REJECT: 'cso.version.rejected', RETURN: 'cso.version.returned' } as const;

/**
 * Documents & versions CSO (CDC §5.2/§5.3, CSO-005/007..011/022/026/027) :
 * version immuable + approbation séparée du demandeur ; l'ancienne version officielle reste
 * PUBLISHED tant que la nouvelle est en attente ; publication = SUPERSEDED puis PUBLISHED
 * dans une même transaction sérialisable (index partiel « une seule publiée »).
 */
@Injectable()
export class CsoDocumentsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly csoAccess: CsoAccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly fields: CsoFieldsService,
    private readonly folders: CsoFoldersService,
    private readonly workflow: CsoWorkflowService,
    private readonly notifications: NotificationsService,
  ) {}

  /** Resolver d'accès aux fichiers des versions : droits revalidés à chaque preview / download (CSO-008). */
  onModuleInit(): void {
    this.registry.register(OWNER_CSO_VERSION, async (ctx, file, mode) => {
      const version = await this.prisma.csoVersion.findUnique({ where: { id: file.ownerId! } });
      if (!version) throw Errors.notFound('Version');
      return this.versionGrant(ctx, version, mode, file);
    });
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  /** Documents visibles d'un dossier (ACL + workflow + archives), pagination par curseur après filtrage. */
  async list(ctx: AuthContext, q: ListDocumentsQuery) {
    const { folder } = await this.csoAccess.assertFolder(ctx, q.folderId);
    const includeArchived = q.includeArchived && can(ctx, 'cso.archive.view');
    const rows = await this.prisma.csoDocument.findMany({
      where: { folderId: folder.id, ...(includeArchived ? {} : { status: { not: 'ARCHIVED' } }) },
      orderBy: [{ title: 'asc' }, { id: 'asc' }],
      take: 5000,
    });
    const { visible, eff, viaShare } = await this.csoAccess.filterVisibleDocuments(ctx, rows);
    const start = q.cursor ? visible.findIndex((d) => d.id === q.cursor) + 1 : 0;
    const page = visible.slice(start, start + q.limit + 1);
    const hasMore = page.length > q.limit;
    const items = hasMore ? page.slice(0, q.limit) : page;
    const [users, categories] = await Promise.all([
      userLabels(this.prisma, items.map((d) => d.authorId)),
      this.categoryMap(items.map((d) => d.categoryId)),
    ]);
    const versions = await this.prisma.csoVersion.findMany({
      where: { id: { in: items.map((d) => d.currentVersionId).filter((x): x is string => !!x) } },
    });
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: versions.map((v) => v.fileId) } } });
    const restoreModes = await this.workflow.restoreModes(items.filter((d) => d.status === 'ARCHIVED').map((d) => d.id), this.prisma);
    return {
      items: items.map((d) => {
        const cv = versions.find((v) => v.id === d.currentVersionId);
        const e = eff.get(d.id)!;
        const showCurrent = cv && canAccessVersion(e, d, cv, ctx.userId, 'meta');
        return {
          ...presentDocumentSummary(d, { eff: e, users, category: categories.get(d.categoryId ?? '') ?? null, viaShare: viaShare.has(d.id) }),
          currentVersion: showCurrent ? presentVersion(cv, users, files.find((f) => f.id === cv.fileId)) : null,
          ...(d.status === 'ARCHIVED' ? { restoreMode: restoreModes.get(d.id) ?? null } : {}),
        };
      }),
      nextCursor: hasMore ? items[items.length - 1].id : null,
      total: visible.length,
    };
  }

  private async categoryMap(ids: (string | null)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    const rows = unique.length
      ? await this.prisma.csoCategory.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, name: true, referenceMode: true } })
      : [];
    return new Map(rows.map((c) => [c.id, c]));
  }

  async get(ctx: AuthContext, id: string) {
    const { doc, folder, library, eff, viaShare } = await this.csoAccess.assertDocument(ctx, id);
    const [versions, pendingRef, categories, vessel] = await Promise.all([
      this.prisma.csoVersion.findMany({ where: { documentId: id }, orderBy: { versionNo: 'desc' } }),
      this.prisma.csoReferenceChangeRequest.findFirst({ where: { documentId: id, status: 'PENDING_APPROVAL' } }),
      this.categoryMap([doc.categoryId]),
      library.vesselId ? this.prisma.vessel.findUnique({ where: { id: library.vesselId }, select: { id: true, code: true, name: true } }) : null,
    ]);
    const visibleVersions = versions.filter((v) => canAccessVersion(eff, doc, v, ctx.userId, 'meta'));
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: visibleVersions.map((v) => v.fileId) } } });
    const users = await userLabels(this.prisma, [
      doc.authorId,
      ...visibleVersions.flatMap((v) => [v.submittedById, v.decidedById]),
      pendingRef?.requestedById,
    ]);
    const current = visibleVersions.find((v) => v.id === doc.currentVersionId && v.status === 'PUBLISHED');
    const inFlight = visibleVersions.find((v) => IN_FLIGHT_VERSION.includes(v.status));
    let copiedFrom: { id: string; reference: string | null; title: string } | null = null;
    if (doc.copiedFromId) {
      const src = await this.prisma.csoDocument.findUnique({ where: { id: doc.copiedFromId } });
      if (src && (await this.csoAccess.filterVisibleDocuments(ctx, [src])).visible.length) {
        copiedFrom = { id: src.id, reference: src.reference, title: src.title };
      }
    }
    const fileOf = (v: CsoVersion) => files.find((f) => f.id === v.fileId);
    return {
      ...presentDocumentSummary(doc, { eff, users, category: categories.get(doc.categoryId ?? '') ?? null, viaShare }),
      library: presentLibrary(library, vessel),
      folder: { id: folder.id, name: (await this.folderVisible(ctx, folder.id)) ? folder.name : null },
      breadcrumb: await this.folders.breadcrumb(ctx, { id: '', path: folder.path }),
      currentVersion: current ? presentVersion(current, users, fileOf(current)) : null,
      pendingVersion: inFlight ? presentVersion(inFlight, users, fileOf(inFlight)) : null,
      versions: visibleVersions.map((v) => presentVersion(v, users, fileOf(v))),
      // Document archivé : APPROVAL (nouvelle approbation) ou DRAFT (jamais approuvé — CSO-03)
      ...(doc.status === 'ARCHIVED' ? { restoreMode: restorePlan(versions)?.mode ?? null } : {}),
      customFields: await this.fields.visibleValues(ctx, doc, eff),
      pendingReferenceChange:
        pendingRef && (eff.edit || eff.approve || pendingRef.requestedById === ctx.userId)
          ? {
              id: pendingRef.id,
              oldReference: pendingRef.oldReference,
              newReference: pendingRef.newReference,
              reason: pendingRef.reason,
              requestedBy: users.get(pendingRef.requestedById) ?? null,
              createdAt: pendingRef.createdAt,
            }
          : null,
      copiedFrom,
    };
  }

  private async folderVisible(ctx: AuthContext, folderId: string): Promise<boolean> {
    try {
      await this.csoAccess.assertFolder(ctx, folderId);
      return true;
    } catch {
      return false;
    }
  }

  async effectiveAccess(ctx: AuthContext, id: string) {
    const { doc, eff, viaShare } = await this.csoAccess.assertDocument(ctx, id);
    return { documentId: doc.id, status: doc.status, actions: grantedActions(eff), map: eff, viaShare };
  }

  async listVersions(ctx: AuthContext, id: string) {
    return (await this.get(ctx, id)).versions;
  }

  /** Activité du document (audit CSO : consultations, modifications, décisions) — cso.audit.view. */
  async history(ctx: AuthContext, id: string) {
    const { doc, eff } = await this.csoAccess.assertDocument(ctx, id);
    const versionIds = (await this.prisma.csoVersion.findMany({ where: { documentId: id }, select: { id: true } })).map((v) => v.id);
    const events = await this.prisma.auditEvent.findMany({
      where: {
        module: 'cso',
        OR: [
          { entityType: 'cso_document', entityId: doc.id },
          { entityType: 'cso_version', entityId: { in: versionIds } },
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: 500,
      select: { id: true, occurredAt: true, actorLabel: true, action: true, result: true, before: true, after: true, metadata: true },
    });
    // Valeurs de champs personnalisés : uniquement celles des champs que le lecteur peut voir (audit #7b)
    const fieldEntries = (m: unknown): unknown[] => {
      const cf = (m as { customFields?: unknown } | null)?.customFields;
      return Array.isArray(cf) ? cf : [];
    };
    const extraIds = events
      .flatMap((e) => fieldEntries(e.metadata))
      .map((x) => (x as { fieldId?: unknown }).fieldId)
      .filter((x): x is string => typeof x === 'string');
    const canSee = await this.fields.auditFieldFilter(ctx, doc, eff, extraIds);
    return events.map((e) => {
      const m = e.metadata as Record<string, unknown> | null;
      if (!m || !Array.isArray(m.customFields)) return e;
      return { ...e, metadata: { ...m, customFields: m.customFields.filter((x) => canSee(x)) } };
    });
  }

  // ---------------------------------------------------------------------------
  // Création & métadonnées
  // ---------------------------------------------------------------------------

  async create(ctx: AuthContext, dto: CreateDocumentDto) {
    const { folder, library } = await this.csoAccess.assertFolder(ctx, dto.folderId, ['edit'], { requireActive: true });
    const category = await this.workflow.categoryFor(dto.categoryId, library);
    const missing = missingStandardFields(category?.requiredFields ?? [], {
      description: dto.description,
      nextReviewOn: dto.nextReviewOn,
      expiryOn: dto.expiryOn,
      reference: category?.referenceMode === 'AUTO' ? 'AUTO' : dto.reference,
    });
    if (missing.length) throw Errors.validation('Champs obligatoires manquants pour cette catégorie', { fields: missing });

    let created: { doc: CsoDocument; version: CsoVersion };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const reference = await this.workflow.resolveReference(category, library, dto.reference, tx);
        const doc = await tx.csoDocument.create({
          data: {
            libraryId: library.id,
            folderId: folder.id,
            vesselId: library.vesselId,
            categoryId: category?.id ?? null,
            reference,
            title: dto.title,
            description: dto.description ?? null,
            authorId: ctx.userId,
            status: 'DRAFT',
            nextReviewOn: dto.nextReviewOn ?? null,
            expiryOn: dto.expiryOn ?? null,
          },
        });
        const { eff } = await this.csoAccess.documentsAccess(ctx, [doc], tx);
        const changes = await this.fields.applyValues(ctx, doc, eff.get(doc.id)!, dto.customFields, { enforceRequired: true }, tx);
        const version = await this.workflow.createVersion(
          ctx,
          doc,
          { fileId: dto.fileId },
          { status: dto.submit ? 'PENDING_APPROVAL' : 'DRAFT', changeNote: dto.changeNote },
          tx,
        );
        await this.audit.record(
          ctx,
          {
            action: 'cso.document.created',
            module: 'cso',
            entityType: 'cso_document',
            entityId: doc.id,
            vesselId: doc.vesselId,
            after: {
              reference,
              title: doc.title,
              folderId: folder.id,
              categoryId: doc.categoryId,
              versionId: version.id,
              versionStatus: version.status,
              fileId: version.fileId,
            },
            metadata: { customFields: changes },
          },
          tx,
        );
        return { doc, version };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'reference')) throw Errors.duplicate('Référence déjà utilisée', { field: 'reference' });
      throw e;
    }
    if (created.version.status === 'PENDING_APPROVAL') await this.publishOrNotify(ctx, created.doc, created.version);
    return this.get(ctx, created.doc.id);
  }

  /** Édition des métadonnées (titre, description, dates, catégorie, champs) — auditée avec diff. */
  async update(ctx: AuthContext, id: string, dto: UpdateDocumentDto) {
    const { doc, library, eff } = await this.csoAccess.assertDocument(ctx, id, ['edit'], { requireNotArchived: true });
    if (dto.expectedUpdatedAt && doc.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime()) throw Errors.staleVersion();
    const categoryChanged = dto.categoryId !== undefined && dto.categoryId !== doc.categoryId;
    const category = await this.workflow.categoryFor(dto.categoryId === undefined ? doc.categoryId : dto.categoryId, library).catch((e) => {
      // Une catégorie devenue inactive n'empêche pas d'éditer le reste des métadonnées
      if (!categoryChanged && doc.categoryId) return null;
      throw e;
    });
    const next = {
      title: dto.title ?? doc.title,
      description: dto.description === undefined ? doc.description : dto.description,
      nextReviewOn: dto.nextReviewOn === undefined ? doc.nextReviewOn : dto.nextReviewOn,
      expiryOn: dto.expiryOn === undefined ? doc.expiryOn : dto.expiryOn,
      categoryId: dto.categoryId === undefined ? doc.categoryId : dto.categoryId,
    };
    if (category) {
      const missing = missingStandardFields(category.requiredFields, { ...next, reference: doc.reference });
      if (missing.length) throw Errors.validation('Champs obligatoires manquants pour cette catégorie', { fields: missing });
    }
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.csoDocument.updateMany({
        where: { id, status: { not: 'ARCHIVED' }, ...(dto.expectedUpdatedAt ? { updatedAt: dto.expectedUpdatedAt } : {}) },
        data: next,
      });
      if (!res.count) throw Errors.staleVersion();
      const changes = await this.fields.applyValues(
        ctx,
        { id, categoryId: next.categoryId },
        eff,
        dto.customFields,
        { enforceRequired: categoryChanged },
        tx,
      );
      const before = { ...pickMeta(doc) };
      const after = { ...pickMeta({ ...doc, ...next }) };
      const diff = diffFields(before, after);
      await this.audit.record(
        ctx,
        {
          action: 'cso.document.updated',
          module: 'cso',
          entityType: 'cso_document',
          entityId: id,
          vesselId: doc.vesselId,
          ...diff,
          metadata: changes.length ? { customFields: changes } : undefined,
        },
        tx,
      );
      return { id, updated: Object.keys(diff.after ?? {}), customFieldsUpdated: changes.map((c) => c.key) };
    });
  }

  // ---------------------------------------------------------------------------
  // Versions & approbation (CSO-005/006/007)
  // ---------------------------------------------------------------------------

  /** Nouvelle version : la version officielle actuelle reste PUBLISHED pendant la validation. */
  async addVersion(ctx: AuthContext, id: string, dto: NewVersionDto) {
    const { doc } = await this.csoAccess.assertDocument(ctx, id, ['edit'], { requireNotArchived: true });
    let version: CsoVersion;
    try {
      version = await this.prisma.$transaction(async (tx) => {
        const v = await this.workflow.createVersion(
          ctx,
          doc,
          { fileId: dto.fileId },
          { status: dto.submit ? 'PENDING_APPROVAL' : 'DRAFT', changeNote: dto.changeNote },
          tx,
        );
        await this.audit.record(
          ctx,
          {
            action: 'cso.version.created',
            module: 'cso',
            entityType: 'cso_version',
            entityId: v.id,
            vesselId: doc.vesselId,
            after: { documentId: doc.id, versionNo: v.versionNo, status: v.status, fileId: v.fileId, changeNote: v.changeNote },
          },
          tx,
        );
        return v;
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.invalidState('Une version est déjà en cours pour ce document');
      throw e;
    }
    if (version.status === 'PENDING_APPROVAL') return this.publishOrNotify(ctx, doc, version);
    return this.presentOne(version);
  }

  private async presentOne(v: CsoVersion) {
    const [users, file] = await Promise.all([
      userLabels(this.prisma, [v.submittedById, v.decidedById]),
      this.prisma.storedFile.findUnique({ where: { id: v.fileId } }),
    ]);
    return presentVersion(v, users, file);
  }

  private async loadVersion(id: string) {
    const v = await this.prisma.csoVersion.findUnique({ where: { id } });
    if (!v) throw Errors.notFound('Version');
    return v;
  }

  /** DRAFT / RETURNED -> PENDING_APPROVAL (soumetteur uniquement). */
  async submitVersion(ctx: AuthContext, versionId: string, dto: LockVersionDto) {
    const v = await this.loadVersion(versionId);
    const { doc } = await this.csoAccess.assertDocument(ctx, v.documentId, ['edit'], { requireNotArchived: true });
    if (v.submittedById !== ctx.userId) throw Errors.forbidden('Seul le déposant peut soumettre cette version');
    if (v.status !== 'DRAFT' && v.status !== 'RETURNED') throw Errors.invalidState(`Version ${v.status} : soumission impossible`);
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.csoVersion.updateMany({
        where: { id: v.id, status: { in: ['DRAFT', 'RETURNED'] }, lockVersion: dto.expectedLockVersion },
        data: { status: 'PENDING_APPROVAL', submittedAt: new Date(), lockVersion: { increment: 1 } },
      });
      if (!res.count) throw Errors.staleVersion();
      await this.audit.record(
        ctx,
        { action: 'cso.version.submitted', module: 'cso', entityType: 'cso_version', entityId: v.id, vesselId: doc.vesselId, before: { status: v.status }, after: { status: 'PENDING_APPROVAL' } },
        tx,
      );
      return tx.csoVersion.findUniqueOrThrow({ where: { id: v.id } });
    });
    return this.publishOrNotify(ctx, doc, updated);
  }

  /** Annulation de sa propre version en cours (brouillon, en attente, retournée). */
  async cancelVersion(ctx: AuthContext, versionId: string, dto: LockVersionDto) {
    const v = await this.loadVersion(versionId);
    const { doc } = await this.csoAccess.assertDocument(ctx, v.documentId);
    if (v.submittedById !== ctx.userId) throw Errors.forbidden('Seul le déposant peut annuler sa version');
    if (!IN_FLIGHT_VERSION.includes(v.status)) throw Errors.alreadyProcessed('Version déjà traitée');
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.csoVersion.updateMany({
        where: { id: v.id, status: { in: IN_FLIGHT_VERSION }, lockVersion: dto.expectedLockVersion },
        data: { status: 'CANCELLED', decidedAt: new Date(), decidedById: ctx.userId, decisionComment: 'Annulée par le déposant', lockVersion: { increment: 1 } },
      });
      if (!res.count) throw Errors.staleVersion();
      await this.audit.record(
        ctx,
        { action: 'cso.version.cancelled', module: 'cso', entityType: 'cso_version', entityId: v.id, vesselId: doc.vesselId, before: { status: v.status }, after: { status: 'CANCELLED' } },
        tx,
      );
      return tx.csoVersion.findUniqueOrThrow({ where: { id: v.id } });
    });
    await this.notifications.resolveForEntity('cso_document', doc.id, 'cso.version_pending');
    return this.presentOne(updated);
  }

  /**
   * Décision APPROVE | REJECT | RETURN. Validateur : cso.approve + ACL approve + scope + validateur
   * configuré du dossier (le plus proche) — jamais le déposant (même Super Admin). Concurrence :
   * transaction sérialisable + verrou optimiste (409 STALE_VERSION / ALREADY_PROCESSED).
   */
  /**
   * Version soumise : publication directe si l'auteur a `cso.self_approve` (Super Admin, CSO…) et le droit
   * d'approbation sur le dossier ; sinon notification des validateurs (circuit normal).
   * Règle métier en vigueur : les validateurs désignés du dossier ne sont pas exigés (CSO-05, à arbitrer).
   */
  private async publishOrNotify(ctx: AuthContext, doc: CsoDocument, version: CsoVersion) {
    if (can(ctx, 'cso.self_approve')) {
      try {
        return await this.decide(
          ctx,
          version.id,
          { decision: 'APPROVE', expectedLockVersion: version.lockVersion, comment: 'Publication directe (sans approbation)' },
          { selfApprove: true },
        );
      } catch {
        // ACL du dossier sans droit d'approbation : retour au circuit normal
      }
    }
    await this.workflow.notifyValidators(doc, version);
    return this.presentOne(version);
  }

  async decide(ctx: AuthContext, versionId: string, dto: VersionDecisionDto, opts: { selfApprove?: boolean } = {}) {
    const v = await this.loadVersion(versionId);
    const { doc, folder } = await this.csoAccess.assertDocument(ctx, v.documentId, ['approve']);
    if (v.status !== 'PENDING_APPROVAL') {
      if (DECIDED.includes(v.status)) throw Errors.alreadyProcessed('Version déjà traitée');
      throw Errors.invalidState(`Version ${v.status} : aucune décision attendue`);
    }
    if (v.submittedById === ctx.userId && !opts.selfApprove) throw Errors.selfApproval();
    if (doc.status === 'ARCHIVED') throw Errors.invalidState('Document archivé');
    const config = await this.csoAccess.validatorsFor(folder.path);
    if (!opts.selfApprove && !this.csoAccess.isEligibleValidator(ctx, config)) {
      throw Errors.forbidden('Vous n’êtes pas validateur désigné pour ce dossier');
    }
    const target = DECISION_TARGET[dto.decision];
    const updated = await this.prisma.serializable(async (tx) => {
      const now = new Date();
      if (dto.decision === 'APPROVE') {
        // L'ancienne version officielle passe SUPERSEDED AVANT la publication (index partiel unique)
        await tx.csoVersion.updateMany({
          where: { documentId: doc.id, status: 'PUBLISHED', id: { not: v.id } },
          data: { status: 'SUPERSEDED', supersededAt: now, lockVersion: { increment: 1 } },
        });
      }
      const res = await tx.csoVersion.updateMany({
        where: { id: v.id, status: 'PENDING_APPROVAL', lockVersion: dto.expectedLockVersion },
        data: {
          status: target,
          decidedById: ctx.userId,
          decidedAt: now,
          decisionComment: dto.comment ?? null,
          lockVersion: { increment: 1 },
          ...(dto.decision === 'APPROVE' ? { publishedAt: now } : {}),
        },
      });
      if (!res.count) {
        const cur = await tx.csoVersion.findUniqueOrThrow({ where: { id: v.id }, select: { status: true } });
        if (cur.status !== 'PENDING_APPROVAL') throw Errors.alreadyProcessed('Version déjà traitée');
        throw Errors.staleVersion();
      }
      const previous = await tx.csoVersion.findFirst({
        where: { documentId: doc.id, status: 'SUPERSEDED', supersededAt: now },
        select: { id: true, versionNo: true },
      });
      if (dto.decision === 'APPROVE') {
        await tx.csoDocument.update({ where: { id: doc.id }, data: { currentVersionId: v.id, status: 'PUBLISHED' } });
      }
      await this.audit.record(
        ctx,
        {
          action: DECISION_AUDIT[dto.decision],
          module: 'cso',
          entityType: 'cso_version',
          entityId: v.id,
          vesselId: doc.vesselId,
          before: { status: 'PENDING_APPROVAL', currentVersionId: doc.currentVersionId },
          after: {
            status: target,
            ...(dto.decision === 'APPROVE' ? { currentVersionId: v.id, supersededVersionId: previous?.id ?? null } : {}),
          },
          metadata: { documentId: doc.id, versionNo: v.versionNo, comment: dto.comment, isRestoration: v.isRestoration, selfApproved: !!opts.selfApprove },
        },
        tx,
      );
      return tx.csoVersion.findUniqueOrThrow({ where: { id: v.id } });
    });
    await this.notifications.resolveForEntity('cso_document', doc.id, 'cso.version_pending');
    // Publication directe : l'auteur est aussi le décideur, rien à lui notifier (CSO-12)
    if (!opts.selfApprove) await this.workflow.notifyDecision(doc, updated, dto.decision, dto.comment);
    return this.presentOne(updated);
  }

  /** Versions en attente que l'utilisateur peut effectivement décider (boîte de validation). */
  async approvalsInbox(ctx: AuthContext) {
    const pending = await this.prisma.csoVersion.findMany({
      where: { status: 'PENDING_APPROVAL', submittedById: { not: ctx.userId } },
      orderBy: { submittedAt: 'asc' },
      take: 500,
    });
    const docs = await this.prisma.csoDocument.findMany({ where: { id: { in: pending.map((v) => v.documentId) }, status: { not: 'ARCHIVED' } } });
    const { visible, eff } = await this.csoAccess.filterVisibleDocuments(ctx, docs);
    const folders = await this.prisma.csoFolder.findMany({ where: { id: { in: visible.map((d) => d.folderId) } }, select: { id: true, path: true } });
    const out = [];
    const users = await userLabels(this.prisma, pending.map((v) => v.submittedById));
    const validatorsCache = new Map<string, Awaited<ReturnType<CsoAccessService['validatorsFor']>>>();
    const eligibleIn = async (folderId: string, folderPath: string) => {
      if (!validatorsCache.has(folderId)) validatorsCache.set(folderId, await this.csoAccess.validatorsFor(folderPath));
      return this.csoAccess.isEligibleValidator(ctx, validatorsCache.get(folderId)!);
    };
    for (const d of visible) {
      const e = eff.get(d.id)!;
      if (!e.approve) continue;
      const path = folders.find((f) => f.id === d.folderId)!.path;
      if (!(await eligibleIn(d.folderId, path))) continue;
      const v = pending.find((p) => p.documentId === d.id)!;
      out.push({ document: presentDocumentSummary(d, { eff: e }), version: presentVersion(v, users) });
    }
    const refRequests = await this.prisma.csoReferenceChangeRequest.findMany({
      where: { status: 'PENDING_APPROVAL', requestedById: { not: ctx.userId } },
      take: 200,
    });
    const refDocs = await this.prisma.csoDocument.findMany({ where: { id: { in: refRequests.map((r) => r.documentId) }, status: { not: 'ARCHIVED' } } });
    const refVisible = await this.csoAccess.filterVisibleDocuments(ctx, refDocs);
    const refFolders = await this.prisma.csoFolder.findMany({ where: { id: { in: refVisible.visible.map((d) => d.folderId) } }, select: { id: true, path: true } });
    // Mêmes conditions que decideReferenceChange : approve + validateur désigné du dossier (CSO-07)
    const decidableRefDocs = new Set<string>();
    for (const d of refVisible.visible) {
      if (!refVisible.eff.get(d.id)!.approve) continue;
      const path = refFolders.find((f) => f.id === d.folderId)!.path;
      if (await eligibleIn(d.folderId, path)) decidableRefDocs.add(d.id);
    }
    return {
      versions: out,
      referenceChanges: refRequests
        .filter((r) => decidableRefDocs.has(r.documentId))
        .map((r) => ({ id: r.id, documentId: r.documentId, oldReference: r.oldReference, newReference: r.newReference, reason: r.reason, createdAt: r.createdAt })),
    };
  }

  // ---------------------------------------------------------------------------
  // Changement de référence officielle (CSO-027)
  // ---------------------------------------------------------------------------

  async requestReferenceChange(ctx: AuthContext, id: string, dto: ReferenceChangeDto) {
    const { doc } = await this.csoAccess.assertDocument(ctx, id, ['edit'], { requireNotArchived: true });
    const newReference = normalizeReference(dto.newReference);
    if (newReference === doc.reference) throw Errors.business('La nouvelle référence est identique à la référence actuelle');
    await this.workflow.assertReferenceAvailable(newReference, this.prisma, doc.id);
    try {
      const req = await this.prisma.$transaction(async (tx) => {
        const r = await tx.csoReferenceChangeRequest.create({
          data: { documentId: doc.id, oldReference: doc.reference, newReference, reason: dto.reason, requestedById: ctx.userId },
        });
        await this.audit.record(
          ctx,
          {
            action: 'cso.reference_change.requested',
            module: 'cso',
            entityType: 'cso_document',
            entityId: doc.id,
            vesselId: doc.vesselId,
            before: { reference: doc.reference },
            after: { requestedReference: newReference },
            metadata: { requestId: r.id, reason: dto.reason },
          },
          tx,
        );
        return r;
      });
      await this.notifyReferenceApprovers(doc, req.id, ctx.userId);
      return req;
    } catch (e) {
      if (isUniqueViolation(e)) throw Errors.conflict('Une demande de changement de référence est déjà en cours pour ce document');
      throw e;
    }
  }

  private async notifyReferenceApprovers(doc: CsoDocument, requestId: string, requesterId: string) {
    const folder = await this.prisma.csoFolder.findUniqueOrThrow({ where: { id: doc.folderId }, select: { path: true } });
    const config = await this.csoAccess.validatorsFor(folder.path);
    const candidates = await this.csoAccess.validatorCandidates(config, doc.vesselId);
    const allowed = await this.csoAccess.usersAllowedOnDocument(candidates, doc, 'approve', { validators: config, excludeUserIds: [requesterId] });
    if (!allowed.length) return;
    await this.notifications.notify({
      userIds: allowed,
      type: 'cso.reference_change_pending',
      title: `Changement de référence à approuver : ${doc.reference ?? doc.title}`,
      module: 'cso',
      entityType: 'cso_document',
      entityId: doc.id,
      vesselId: doc.vesselId,
      link: `/cso/documents/${doc.id}`,
      dedupeKey: `cso:refchange:${requestId}`,
      email: true,
      requiredPermission: 'cso.approve',
    });
  }

  /** Demandes de changement de référence : rédacteurs / validateurs ; un simple lecteur ne voit que les siennes (audit #28). */
  async listReferenceChanges(ctx: AuthContext, id: string) {
    const { eff } = await this.csoAccess.assertDocument(ctx, id);
    const privileged = eff.edit || eff.approve;
    const rows = await this.prisma.csoReferenceChangeRequest.findMany({
      where: { documentId: id, ...(privileged ? {} : { requestedById: ctx.userId }) },
      orderBy: { createdAt: 'desc' },
    });
    const users = await userLabels(this.prisma, rows.flatMap((r) => [r.requestedById, r.decidedById]));
    return rows.map((r) => ({ ...r, requestedBy: users.get(r.requestedById) ?? null, decidedBy: r.decidedById ? users.get(r.decidedById) ?? null : null }));
  }

  /** L'ancienne référence reste active jusqu'à l'approbation par un AUTRE acteur. */
  async decideReferenceChange(ctx: AuthContext, requestId: string, dto: ReferenceDecisionDto) {
    const req = await this.prisma.csoReferenceChangeRequest.findUnique({ where: { id: requestId } });
    if (!req) throw Errors.notFound('Demande de changement de référence');
    const { doc, folder } = await this.csoAccess.assertDocument(ctx, req.documentId, ['approve'], { requireNotArchived: true });
    if (req.status !== 'PENDING_APPROVAL') throw Errors.alreadyProcessed();
    if (req.requestedById === ctx.userId) throw Errors.selfApproval();
    const config = await this.csoAccess.validatorsFor(folder.path);
    if (!this.csoAccess.isEligibleValidator(ctx, config)) throw Errors.forbidden('Vous n’êtes pas validateur désigné pour ce dossier');
    try {
      return await this.prisma.serializable(async (tx) => {
        const now = new Date();
        const res = await tx.csoReferenceChangeRequest.updateMany({
          where: { id: req.id, status: 'PENDING_APPROVAL' },
          data: { status: dto.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedById: ctx.userId, decidedAt: now, decisionComment: dto.comment ?? null },
        });
        if (!res.count) throw Errors.alreadyProcessed();
        if (dto.decision === 'APPROVE') {
          await this.workflow.assertReferenceAvailable(req.newReference, tx, doc.id);
          await tx.csoDocument.update({ where: { id: doc.id }, data: { reference: req.newReference } });
        }
        await this.audit.record(
          ctx,
          {
            action: dto.decision === 'APPROVE' ? 'cso.document.reference_changed' : 'cso.reference_change.rejected',
            module: 'cso',
            entityType: 'cso_document',
            entityId: doc.id,
            vesselId: doc.vesselId,
            before: { reference: doc.reference },
            after: { reference: dto.decision === 'APPROVE' ? req.newReference : doc.reference },
            metadata: { requestId: req.id, requestedById: req.requestedById, comment: dto.comment },
          },
          tx,
        );
        return tx.csoReferenceChangeRequest.findUniqueOrThrow({ where: { id: req.id } });
      });
    } catch (e) {
      if (isUniqueViolation(e, 'reference')) throw Errors.duplicate('Référence déjà utilisée', { field: 'reference' });
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Copie (CSO-022), déplacement (CSO-009), archivage / restauration (CSO-010/011)
  // ---------------------------------------------------------------------------

  /**
   * Copie = nouveau document indépendant (référence et métadonnées propres, nouveau cycle
   * d'approbation, lien copiedFromId). Le blob est réutilisé (cloneReference), jamais dupliqué.
   * Exige le droit de téléchargement sur la source (une copie redistribue le contenu).
   */
  async copy(ctx: AuthContext, id: string, dto: CopyDocumentDto) {
    const src = await this.csoAccess.assertDocument(ctx, id, ['download'], { requireNotArchived: true });
    if (src.doc.status !== 'PUBLISHED' || !src.doc.currentVersionId) throw Errors.business('Seul un document publié peut être copié');
    const current = await this.prisma.csoVersion.findUniqueOrThrow({ where: { id: src.doc.currentVersionId } });
    const tgt = await this.csoAccess.assertFolder(ctx, dto.targetFolderId, ['edit'], { requireActive: true });
    const categoryId = dto.categoryId === undefined ? src.doc.categoryId : dto.categoryId;
    const category = await this.workflow.categoryFor(categoryId, tgt.library);
    const visibleValues = (await this.fields.visibleValues(ctx, src.doc, src.eff)).filter((f) => !f.archived && f.value !== null);

    let created: { doc: CsoDocument; version: CsoVersion };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const reference = await this.workflow.resolveReference(category, tgt.library, dto.reference, tx);
        const doc = await tx.csoDocument.create({
          data: {
            libraryId: tgt.library.id,
            folderId: tgt.folder.id,
            vesselId: tgt.library.vesselId,
            categoryId: category?.id ?? null,
            reference,
            title: dto.title ?? src.doc.title,
            description: src.doc.description,
            authorId: ctx.userId,
            status: 'DRAFT',
            nextReviewOn: src.doc.nextReviewOn,
            expiryOn: src.doc.expiryOn,
            copiedFromId: src.doc.id,
          },
        });
        // Seules les valeurs que le copieur voit sont reprises (catégorie inchangée)
        if (category?.id === src.doc.categoryId && visibleValues.length) {
          await tx.csoFieldValue.createMany({
            data: visibleValues.map((f) => ({ documentId: doc.id, fieldId: f.fieldId, value: f.value as Prisma.InputJsonValue, updatedById: ctx.userId })),
          });
        }
        const version = await this.workflow.createVersion(
          ctx,
          doc,
          { cloneFromFileId: current.fileId },
          { status: 'PENDING_APPROVAL', changeNote: `Copie de ${src.doc.reference ?? src.doc.title} (v${current.versionNo})` },
          tx,
        );
        const meta = { sourceDocumentId: src.doc.id, sourceVersionId: current.id, targetFolderId: tgt.folder.id };
        await this.audit.record(
          ctx,
          { action: 'cso.document.copied', module: 'cso', entityType: 'cso_document', entityId: doc.id, vesselId: doc.vesselId, after: { reference, title: doc.title, versionId: version.id }, metadata: meta },
          tx,
        );
        await this.audit.record(
          ctx,
          { action: 'cso.document.copy_made', module: 'cso', entityType: 'cso_document', entityId: src.doc.id, vesselId: src.doc.vesselId, metadata: { ...meta, copyDocumentId: doc.id } },
          tx,
        );
        return { doc, version };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'reference')) throw Errors.duplicate('Référence déjà utilisée', { field: 'reference' });
      throw e;
    }
    await this.publishOrNotify(ctx, created.doc, created.version);
    return this.get(ctx, created.doc.id);
  }

  /**
   * Déplacement : le document hérite des ACL du dossier cible (ses exceptions propres le suivent).
   * Inter-navires : droits requis des deux côtés (folder_move source + edit destination + scopes).
   */
  async move(ctx: AuthContext, id: string, dto: MoveDocumentDto) {
    const src = await this.csoAccess.assertDocument(ctx, id, ['folder_move'], { requireNotArchived: true });
    if (dto.expectedUpdatedAt && src.doc.updatedAt.getTime() !== dto.expectedUpdatedAt.getTime()) throw Errors.staleVersion();
    const tgt = await this.csoAccess.assertFolder(ctx, dto.targetFolderId, ['edit'], { requireActive: true });
    if (tgt.folder.id === src.doc.folderId) throw Errors.business('Le document est déjà dans ce dossier');
    const crossLibrary = tgt.library.id !== src.doc.libraryId;
    if (crossLibrary && src.doc.categoryId) {
      const cat = await this.prisma.csoCategory.findUniqueOrThrow({ where: { id: src.doc.categoryId } });
      this.workflow.assertCategoryCompatible(cat, tgt.library);
    }
    return this.prisma.$transaction(async (tx) => {
      const res = await tx.csoDocument.updateMany({
        where: { id, folderId: src.doc.folderId, status: { not: 'ARCHIVED' } },
        data: { folderId: tgt.folder.id, libraryId: tgt.library.id, vesselId: tgt.library.vesselId },
      });
      if (!res.count) throw Errors.staleVersion();
      if (crossLibrary) {
        await tx.$executeRaw`
          UPDATE files SET vessel_id = ${tgt.library.vesselId}::uuid
           WHERE owner_type = ${OWNER_CSO_VERSION}
             AND owner_id IN (SELECT id FROM cso_versions WHERE document_id = ${id}::uuid)`;
      }
      const before = { folderId: src.doc.folderId, libraryId: src.doc.libraryId, vesselId: src.doc.vesselId };
      const after = { folderId: tgt.folder.id, libraryId: tgt.library.id, vesselId: tgt.library.vesselId };
      await this.audit.record(ctx, { action: 'cso.document.moved', module: 'cso', entityType: 'cso_document', entityId: id, vesselId: src.doc.vesselId, before, after }, tx);
      if (crossLibrary && tgt.library.vesselId !== src.doc.vesselId) {
        await this.audit.record(ctx, { action: 'cso.document.moved_in', module: 'cso', entityType: 'cso_document', entityId: id, vesselId: tgt.library.vesselId, before, after }, tx);
      }
      return { id, ...after, crossLibrary };
    });
  }

  /** Archivage d'un document obsolète (aucune suppression) — cso.edit + ACL edit. */
  async archive(ctx: AuthContext, id: string, dto: ArchiveDto) {
    const { doc } = await this.csoAccess.assertDocument(ctx, id, ['edit'], { requireNotArchived: true });
    // Partages révoqués et notifications résolues par archiveDocuments (CSO-08/09)
    await this.prisma.$transaction((tx) => this.workflow.archiveDocuments(ctx, [doc], dto.reason, {}, tx));
    return { id, status: 'ARCHIVED' };
  }

  /**
   * Restauration : nouvelle approbation obligatoire avant republication (CSO-011) ; un document jamais
   * approuvé revient en brouillon avec son dernier fichier (CSO-03, `restoredAs: 'DRAFT'`).
   */
  async restore(ctx: AuthContext, id: string, dto: RestoreDocumentDto) {
    const { doc, folder } = await this.csoAccess.assertDocument(ctx, id, ['restore', 'view_archived']);
    if (doc.status !== 'ARCHIVED') throw Errors.invalidState('Document non archivé');
    if (folder.status !== 'ACTIVE') throw Errors.business('Le dossier du document est archivé : restaurer le dossier (restauration sélective)');
    const [res] = await this.prisma.$transaction((tx) => this.workflow.restoreDocuments(ctx, [doc], dto.reason, {}, tx));
    await this.workflow.notifyValidators(res.doc, res.version);
    return {
      id,
      status: res.doc.status,
      restoredAs: res.version.status === 'DRAFT' ? ('DRAFT' as const) : ('PENDING_APPROVAL' as const),
      pendingVersion: await this.presentOne(res.version),
    };
  }

  // ---------------------------------------------------------------------------
  // Aperçu / téléchargement (CSO-008/017) — droits revalidés à chaque demande, audités
  // ---------------------------------------------------------------------------

  async versionGrant(ctx: AuthContext, v: CsoVersion, mode: FileAccessMode, file?: StoredFile): Promise<FileAccessGrant> {
    const { doc, eff } = await this.csoAccess.assertDocument(ctx, v.documentId);
    if (!canAccessVersion(eff, doc, v, ctx.userId, mode)) this.throwVersionDenied(ctx, doc, v, mode, eff);
    const archived = v.status === 'SUPERSEDED' || doc.status === 'ARCHIVED';
    const ext = file?.extension ?? '';
    return {
      module: 'cso',
      entityType: 'cso_version',
      entityId: v.id,
      vesselId: doc.vesselId,
      downloadName: documentFileName(doc, ext, archived || v.status !== 'PUBLISHED' ? v.versionNo : undefined),
    };
  }

  private throwVersionDenied(ctx: AuthContext, doc: CsoDocument, v: CsoVersion, mode: FileAccessMode, _eff: ActionMap): never {
    const archived = v.status === 'SUPERSEDED' || doc.status === 'ARCHIVED';
    const perm =
      mode === 'download' ? (archived ? 'cso.archive.download' : 'cso.download') : archived ? 'cso.archive.view' : mode === 'meta' ? 'cso.view' : 'cso.preview';
    if (!can(ctx, perm)) throw Errors.forbidden(`Permission requise : ${perm}`, { permission: perm });
    throw Errors.aclDenied();
  }

  async versionLink(ctx: AuthContext, versionId: string, mode: 'preview' | 'download') {
    const v = await this.loadVersion(versionId);
    const file = await this.files.getOrThrow(v.fileId);
    // Un « aperçu » de Word / Excel… est servi en pièce jointe : il exige le droit de téléchargement (CSO-01)
    const authMode: FileAccessMode = mode === 'preview' && !isPreviewableKind(file.kind) ? 'download' : mode;
    const grant = await this.versionGrant(ctx, v, authMode, file);
    return this.files.issueLink(ctx, file, mode, grant);
  }

  /** Raccourci : version officielle courante d'un document. */
  async documentLink(ctx: AuthContext, id: string, mode: 'preview' | 'download') {
    const { doc } = await this.csoAccess.assertDocument(ctx, id);
    if (!doc.currentVersionId) throw Errors.notFound('Version officielle');
    return this.versionLink(ctx, doc.currentVersionId, mode);
  }
}

/** Formats affichables en ligne (même règle que FilesService.issueLink). */
function isPreviewableKind(kind: string | null | undefined): boolean {
  return kind === 'PDF' || kind === 'IMAGE';
}

function pickMeta(d: Pick<CsoDocument, 'title' | 'description' | 'nextReviewOn' | 'expiryOn' | 'categoryId'>) {
  return {
    title: d.title,
    description: d.description,
    nextReviewOn: dateOnlyString(d.nextReviewOn),
    expiryOn: dateOnlyString(d.expiryOn),
    categoryId: d.categoryId,
  };
}
