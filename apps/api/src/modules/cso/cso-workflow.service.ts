import { Injectable, Logger } from '@nestjs/common';
import type { CsoCategory, CsoDocument, CsoLibrary, CsoVersion, CsoVersionStatus } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Errors } from '../../common/errors';
import { Db, PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { NumberingService } from '../documents/numbering.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CsoAccessService, OWNER_CSO_VERSION } from './cso-access.service';
import { normalizeReference, referenceSequenceKey, renderReference, restorationSource } from './cso-rules';

/**
 * Cycle de vie documentaire partagé (création de version, références, notifications) :
 * utilisé par les documents, la restauration de dossiers et l'import en masse.
 * Une version n'est jamais publiée sans approbation distincte (CSO-005/007/011, import CSO-034).
 */
@Injectable()
export class CsoWorkflowService {
  private readonly logger = new Logger('CsoWorkflow');

  constructor(
    private readonly prisma: PrismaService,
    private readonly files: FilesService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly csoAccess: CsoAccessService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------------------
  // Catégories & références (CSO-025/026)
  // ---------------------------------------------------------------------------

  /** Catégorie active et compatible avec la bibliothèque (flotte, ou navire de la bibliothèque). */
  async categoryFor(categoryId: string | null | undefined, library: CsoLibrary, db: Db = this.prisma): Promise<CsoCategory | null> {
    if (!categoryId) return null;
    const cat = await db.csoCategory.findUnique({ where: { id: categoryId } });
    if (!cat) throw Errors.notFound('Catégorie');
    if (!cat.isActive) throw Errors.business('Catégorie désactivée');
    this.assertCategoryCompatible(cat, library);
    return cat;
  }

  assertCategoryCompatible(cat: Pick<CsoCategory, 'scope' | 'vesselId' | 'name'>, library: Pick<CsoLibrary, 'vesselId'>): void {
    if (cat.scope === 'VESSEL' && cat.vesselId !== library.vesselId) {
      throw Errors.business(`La catégorie « ${cat.name} » est réservée à un autre navire`);
    }
  }

  async assertReferenceAvailable(reference: string, db: Db = this.prisma, excludeDocumentId?: string): Promise<void> {
    const [doc, pending] = await Promise.all([
      db.csoDocument.findFirst({
        where: { reference: { equals: reference, mode: 'insensitive' }, ...(excludeDocumentId ? { id: { not: excludeDocumentId } } : {}) },
        select: { id: true },
      }),
      db.csoReferenceChangeRequest.findFirst({
        where: { newReference: { equals: reference, mode: 'insensitive' }, status: 'PENDING_APPROVAL' },
        select: { id: true },
      }),
    ]);
    // Ne divulgue jamais le document existant (il peut être hors des droits du demandeur)
    if (doc || pending) throw Errors.duplicate('Référence déjà utilisée', { field: 'reference' });
  }

  /** Génère la prochaine référence AUTO (séquence atomique par catégorie [+ navire] [+ année]). */
  async generateReference(category: CsoCategory, library: CsoLibrary, db: Db): Promise<string> {
    if (!category.referenceFormat) throw Errors.business(`Format de référence non configuré pour « ${category.name} »`);
    const vesselCode = library.vesselId
      ? (await db.vessel.findUniqueOrThrow({ where: { id: library.vesselId }, select: { code: true } })).code
      : 'FLEET';
    const parts = { categoryCode: category.code, vesselCode, year: new Date().getUTCFullYear() };
    const key = referenceSequenceKey(category.referenceFormat, parts);
    for (let attempt = 0; attempt < 50; attempt++) {
      const seq = await this.numbering.next(key, db);
      const ref = renderReference(category.referenceFormat, parts, seq);
      try {
        await this.assertReferenceAvailable(ref, db);
        return ref;
      } catch {
        // Référence déjà prise (saisie manuelle / import) : numéro suivant
      }
    }
    throw Errors.conflict('Impossible de générer une référence unique : vérifier le format de la catégorie');
  }

  /**
   * Référence d'un nouveau document :
   *  - catégorie AUTO : générée (une référence fournie n'est acceptée que pour un import d'existant) ;
   *  - catégorie MANUAL : obligatoire, unique ;
   *  - sans catégorie : facultative, unique si fournie.
   */
  async resolveReference(
    category: CsoCategory | null,
    library: CsoLibrary,
    provided: string | null | undefined,
    db: Db,
    opts: { allowProvidedInAuto?: boolean } = {},
  ): Promise<string | null> {
    const ref = provided ? normalizeReference(provided) : null;
    if (category?.referenceMode === 'AUTO') {
      if (ref && !opts.allowProvidedInAuto) {
        throw Errors.validation('Référence générée automatiquement pour cette catégorie : ne pas la saisir', { field: 'reference' });
      }
      if (ref) {
        await this.assertReferenceAvailable(ref, db);
        return ref;
      }
      return this.generateReference(category, library, db);
    }
    if (category?.referenceMode === 'MANUAL' && !ref) {
      throw Errors.validation('Référence obligatoire pour cette catégorie (mode manuel)', { field: 'reference' });
    }
    if (ref) await this.assertReferenceAvailable(ref, db);
    return ref;
  }

  // ---------------------------------------------------------------------------
  // Versions (CSO-007)
  // ---------------------------------------------------------------------------

  async nextVersionNo(documentId: string, db: Db): Promise<number> {
    const last = await db.csoVersion.findFirst({ where: { documentId }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } });
    return (last?.versionNo ?? 0) + 1;
  }

  async assertNoInFlight(documentId: string, db: Db): Promise<void> {
    const inFlight = await db.csoVersion.findFirst({
      where: { documentId, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] } },
      select: { id: true, versionNo: true, status: true },
    });
    if (inFlight) {
      throw Errors.invalidState(`Une version est déjà en cours (v${inFlight.versionNo}, ${inFlight.status}) : la traiter ou l'annuler d'abord`, {
        versionId: inFlight.id,
      });
    }
  }

  /**
   * Crée une version à partir d'un fichier déposé (attach) ou d'un blob existant (cloneReference :
   * copie, restauration). Le blob n'est jamais dupliqué ni écrasé.
   */
  async createVersion(
    ctx: AuthContext,
    doc: Pick<CsoDocument, 'id' | 'vesselId'>,
    source: { fileId: string } | { cloneFromFileId: string },
    opts: { status: Extract<CsoVersionStatus, 'DRAFT' | 'PENDING_APPROVAL'>; changeNote?: string | null; isRestoration?: boolean },
    db: Db,
  ): Promise<CsoVersion> {
    await this.assertNoInFlight(doc.id, db);
    const versionId = randomUUID();
    let fileId: string;
    if ('fileId' in source) {
      const file = await this.files.attach(
        ctx,
        source.fileId,
        { type: OWNER_CSO_VERSION, id: versionId, contexts: ['CSO_DOCUMENT'], vesselId: doc.vesselId },
        db,
      );
      if (file.vesselId && file.vesselId !== doc.vesselId && doc.vesselId === null) {
        throw Errors.validation('Fichier déposé pour un navire : non rattachable à la bibliothèque centrale');
      }
      fileId = file.id;
    } else {
      const clone = await this.files.cloneReference(
        source.cloneFromFileId,
        { type: OWNER_CSO_VERSION, id: versionId, vesselId: doc.vesselId },
        ctx.userId,
        db,
      );
      fileId = clone.id;
    }
    const now = new Date();
    return db.csoVersion.create({
      data: {
        id: versionId,
        documentId: doc.id,
        versionNo: await this.nextVersionNo(doc.id, db),
        fileId,
        status: opts.status,
        changeNote: opts.changeNote ?? null,
        isRestoration: opts.isRestoration ?? false,
        submittedById: ctx.userId,
        submittedAt: opts.status === 'PENDING_APPROVAL' ? now : null,
      },
    });
  }

  /**
   * Dernier blob APPROUVÉ (publié ou remplacé) d'un document — seule base admissible d'une restauration.
   * Jamais de repli sur une version non approuvée (brouillon, rejetée, annulée…) : sinon une restauration
   * pourrait faire valider un contenu qui n'a jamais été approuvé (audit sécurité #10).
   */
  async lastOfficialVersion(documentId: string, db: Db): Promise<CsoVersion | null> {
    return restorationSource(await db.csoVersion.findMany({ where: { documentId } }));
  }

  /** Documents restaurables : ceux qui ont au moins une version déjà approuvée. */
  async restorableIds(documentIds: string[], db: Db): Promise<Set<string>> {
    if (!documentIds.length) return new Set();
    const rows = await db.csoVersion.findMany({
      where: { documentId: { in: documentIds }, status: { in: ['PUBLISHED', 'SUPERSEDED'] }, publishedAt: { not: null } },
      select: { documentId: true },
      distinct: ['documentId'],
    });
    return new Set(rows.map((r) => r.documentId));
  }

  // ---------------------------------------------------------------------------
  // Archivage / restauration (CSO-010/011/019/020) — jamais de suppression
  // ---------------------------------------------------------------------------

  /**
   * Archive des documents : la version officielle devient SUPERSEDED (plus aucun contenu officiel),
   * les versions et changements de référence en cours sont annulés. Un événement d'audit par document.
   */
  async archiveDocuments(
    ctx: AuthContext,
    docs: CsoDocument[],
    reason: string | undefined,
    meta: Record<string, unknown>,
    db: Db,
  ): Promise<void> {
    if (!docs.length) return;
    const ids = docs.map((d) => d.id);
    const now = new Date();
    await db.csoVersion.updateMany({
      where: { documentId: { in: ids }, status: 'PUBLISHED' },
      data: { status: 'SUPERSEDED', supersededAt: now, lockVersion: { increment: 1 } },
    });
    await db.csoVersion.updateMany({
      where: { documentId: { in: ids }, status: { in: ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] } },
      data: { status: 'CANCELLED', decidedAt: now, decidedById: ctx.userId, decisionComment: 'Annulée : document archivé', lockVersion: { increment: 1 } },
    });
    await db.csoReferenceChangeRequest.updateMany({
      where: { documentId: { in: ids }, status: 'PENDING_APPROVAL' },
      data: { status: 'CANCELLED', decidedAt: now, decidedById: ctx.userId, decisionComment: 'Annulée : document archivé' },
    });
    await db.csoDocument.updateMany({ where: { id: { in: ids } }, data: { status: 'ARCHIVED', archivedAt: now, archivedById: ctx.userId } });
    for (const d of docs) {
      await this.audit.record(
        ctx,
        {
          action: 'cso.document.archived',
          module: 'cso',
          entityType: 'cso_document',
          entityId: d.id,
          vesselId: d.vesselId,
          before: { status: d.status },
          after: { status: 'ARCHIVED' },
          metadata: { reason, ...meta },
        },
        db,
      );
    }
  }

  /**
   * Restaure des documents archivés : statut DRAFT (non officiel) + version de restauration
   * PENDING_APPROVAL réutilisant le dernier blob officiel — nouvelle approbation obligatoire (CSO-011/020).
   */
  async restoreDocuments(
    ctx: AuthContext,
    docs: CsoDocument[],
    reason: string | undefined,
    meta: Record<string, unknown>,
    db: Db,
  ): Promise<{ doc: CsoDocument; version: CsoVersion }[]> {
    const out: { doc: CsoDocument; version: CsoVersion }[] = [];
    for (const d of docs) {
      const source = await this.lastOfficialVersion(d.id, db);
      if (!source) {
        throw Errors.business(`Document ${d.reference ?? d.title} jamais approuvé : restauration impossible (aucune version officielle à rétablir)`, {
          documentId: d.id,
        });
      }
      const version = await this.createVersion(
        ctx,
        d,
        { cloneFromFileId: source.fileId },
        { status: 'PENDING_APPROVAL', isRestoration: true, changeNote: `Restauration de la version v${source.versionNo}` },
        db,
      );
      const updated = await db.csoDocument.update({ where: { id: d.id }, data: { status: 'DRAFT', archivedAt: null, archivedById: null } });
      await this.audit.record(
        ctx,
        {
          action: 'cso.document.restored',
          module: 'cso',
          entityType: 'cso_document',
          entityId: d.id,
          vesselId: d.vesselId,
          before: { status: d.status },
          after: { status: 'DRAFT', restorationVersionId: version.id, sourceVersionNo: source.versionNo },
          metadata: { reason, ...meta },
        },
        db,
      );
      out.push({ doc: updated, version });
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Notifications (destinataires filtrés sur leurs droits réels, ACL comprise)
  // ---------------------------------------------------------------------------

  /** Informe les validateurs éligibles (dossier le plus proche, ACL approve, jamais le soumetteur). */
  async notifyValidators(doc: CsoDocument, version: Pick<CsoVersion, 'id' | 'versionNo' | 'submittedById' | 'isRestoration'>): Promise<void> {
    try {
      const folder = await this.prisma.csoFolder.findUniqueOrThrow({ where: { id: doc.folderId }, select: { path: true } });
      const config = await this.csoAccess.validatorsFor(folder.path);
      const candidates = await this.csoAccess.validatorCandidates(config, doc.vesselId);
      const allowed = await this.csoAccess.usersAllowedOnDocument(candidates, doc, 'approve', {
        validators: config,
        excludeUserIds: [version.submittedById],
      });
      if (!allowed.length) return;
      await this.notifications.notify({
        userIds: allowed,
        type: 'cso.version_pending',
        title: `${version.isRestoration ? 'Restauration' : 'Version'} à approuver : ${doc.reference ?? doc.title} (v${version.versionNo})`,
        body: doc.title,
        module: 'cso',
        entityType: 'cso_document',
        entityId: doc.id,
        vesselId: doc.vesselId,
        link: `/cso/documents/${doc.id}`,
        priority: 'NORMAL',
        dedupeKey: `cso:version:${version.id}:pending`,
        email: true,
        requiredPermission: 'cso.approve',
      });
    } catch (e) {
      this.logger.error(`Notification validateurs échouée (${doc.id}) : ${String(e)}`);
    }
  }

  /** Informe le soumetteur de la décision (s'il garde le droit de voir le document). */
  async notifyDecision(doc: CsoDocument, version: Pick<CsoVersion, 'id' | 'versionNo' | 'submittedById'>, decision: string, comment?: string | null) {
    try {
      const allowed = await this.csoAccess.usersAllowedOnDocument([version.submittedById], doc, 'view');
      if (!allowed.length) return;
      const label = decision === 'APPROVE' ? 'approuvée et publiée' : decision === 'REJECT' ? 'rejetée' : 'retournée pour correction';
      await this.notifications.notify({
        userIds: allowed,
        type: `cso.version_${decision.toLowerCase()}`,
        title: `Version v${version.versionNo} ${label} : ${doc.reference ?? doc.title}`,
        body: comment ?? undefined,
        module: 'cso',
        entityType: 'cso_document',
        entityId: doc.id,
        vesselId: doc.vesselId,
        link: `/cso/documents/${doc.id}`,
        priority: decision === 'APPROVE' ? 'NORMAL' : 'HIGH',
        dedupeKey: `cso:version:${version.id}:decision`,
        email: true,
        requiredPermission: 'cso.view',
      });
    } catch (e) {
      this.logger.error(`Notification décision échouée (${doc.id}) : ${String(e)}`);
    }
  }
}
