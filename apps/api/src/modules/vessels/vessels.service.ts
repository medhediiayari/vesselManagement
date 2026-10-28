import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, Vessel } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, canAccessVessel, vesselWhere } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService, toFileDto } from '../files/files.service';
import { poOwnFilter, prOwnFilter } from '../purchasing/purchasing-core.service';
import { AddVesselAttachmentDto, CreateVesselDto, ListVesselsQuery, UpdateVesselDto } from './vessels.dto';

export const OWNER_VESSEL_PHOTO = 'vessel_photo';
export const OWNER_VESSEL_ATTACHMENT = 'vessel_attachment';

function serializeVessel(v: Vessel) {
  return {
    ...v,
    grossTonnage: v.grossTonnage?.toString() ?? null,
    netTonnage: v.netTonnage?.toString() ?? null,
    deadweight: v.deadweight?.toString() ?? null,
    lengthOverall: v.lengthOverall?.toString() ?? null,
    beam: v.beam?.toString() ?? null,
    summerDraft: v.summerDraft?.toString() ?? null,
  };
}

/**
 * Référentiel Flotte (CDC §3.1). Toujours distinguer appartenance à la flotte et
 * accessibilité effective : toutes les lectures sont filtrées par le scope navire.
 */
@Injectable()
export class VesselsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
  ) {}

  onModuleInit(): void {
    const resolver = async (ctx: AuthContext, file: { ownerId: string | null; vesselId: string | null }, kind: string) => {
      this.access.assertCan(ctx, 'vessels.view');
      const vesselId =
        kind === OWNER_VESSEL_PHOTO
          ? file.ownerId
          : (await this.prisma.vesselAttachment.findUnique({ where: { id: file.ownerId! }, select: { vesselId: true } }))?.vesselId;
      if (!vesselId) throw Errors.notFound('Fichier');
      this.access.assertVesselAccess(ctx, vesselId);
      return { module: 'fleet' as const, entityType: kind, entityId: file.ownerId!, vesselId };
    };
    this.registry.register(OWNER_VESSEL_PHOTO, (ctx, file) => resolver(ctx, file, OWNER_VESSEL_PHOTO));
    this.registry.register(OWNER_VESSEL_ATTACHMENT, (ctx, file) => resolver(ctx, file, OWNER_VESSEL_ATTACHMENT));
  }

  async list(ctx: AuthContext, q: ListVesselsQuery) {
    const where: Prisma.VesselWhereInput = {
      AND: [
        ctx.vesselScope.mode === 'ALL_FLEET' ? {} : { id: { in: ctx.vesselScope.vesselIds } },
        q.status ? { status: q.status } : {},
        q.search
          ? {
              OR: [
                { name: { contains: q.search, mode: 'insensitive' } },
                { code: { contains: q.search.toUpperCase() } },
                { imoNumber: { contains: q.search } },
              ],
            }
          : {},
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.vessel.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], ...cursorArgs(q) }),
      this.prisma.vessel.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    return { ...page, items: page.items.map(serializeVessel) };
  }

  async getAccessible(ctx: AuthContext, id: string) {
    const vessel = await this.prisma.vessel.findUnique({ where: { id } });
    if (!vessel) throw Errors.notFound('Navire');
    this.access.assertVesselAccess(ctx, id);
    return vessel;
  }

  async get(ctx: AuthContext, id: string) {
    const vessel = await this.getAccessible(ctx, id);
    const photo = vessel.photoFileId ? await this.prisma.storedFile.findUnique({ where: { id: vessel.photoFileId } }) : null;
    return { ...serializeVessel(vessel), photo: photo ? toFileDto(photo) : null };
  }

  /** Création + bibliothèque CSO du navire. Anti-doublon IMO / MMSI / code (contraintes uniques). */
  async create(ctx: AuthContext, dto: CreateVesselDto) {
    await this.assertNoDuplicate(dto);
    const company = await this.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    const vessel = await this.prisma.$transaction(async (tx) => {
      const v = await tx.vessel.create({
        data: { ...dto, companyId: company.id, createdById: ctx.userId } as Prisma.VesselUncheckedCreateInput,
      });
      await tx.csoLibrary.create({ data: { kind: 'VESSEL', vesselId: v.id, name: `CSO — ${v.name}` } });
      await this.audit.record(ctx, { action: 'vessel.created', module: 'fleet', entityType: 'vessel', entityId: v.id, vesselId: v.id, after: serializeVessel(v) }, tx);
      return v;
    });
    return {
      ...serializeVessel(vessel),
      accessible: canAccessVessel(ctx, vessel.id),
    };
  }

  /** Toute modification d'information officielle est historisée (before/after). */
  async update(ctx: AuthContext, id: string, dto: UpdateVesselDto) {
    const before = await this.getAccessible(ctx, id);
    await this.assertNoDuplicate(dto, id);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.vessel.update({ where: { id }, data: dto as Prisma.VesselUncheckedUpdateInput });
      const diff = diffFields(serializeVessel(before) as never, serializeVessel(after) as never);
      await this.audit.record(ctx, { action: 'vessel.updated', module: 'fleet', entityType: 'vessel', entityId: id, vesselId: id, ...diff }, tx);
      return serializeVessel(after);
    });
  }

  /** Un navire désactivé/vendu reste dans les données historiques (jamais supprimé). */
  async setStatus(ctx: AuthContext, id: string, status: Vessel['status'], reason?: string) {
    const before = await this.getAccessible(ctx, id);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.vessel.update({ where: { id }, data: { status } });
      await this.audit.record(
        ctx,
        { action: 'vessel.status_changed', module: 'fleet', entityType: 'vessel', entityId: id, vesselId: id, before: { status: before.status }, after: { status }, metadata: { reason } },
        tx,
      );
      return serializeVessel(after);
    });
  }

  async setPhoto(ctx: AuthContext, id: string, fileId: string | null) {
    const before = await this.getAccessible(ctx, id);
    return this.prisma.$transaction(async (tx) => {
      if (fileId) {
        await this.files.attach(ctx, fileId, { type: OWNER_VESSEL_PHOTO, id, contexts: ['VESSEL_PHOTO'], vesselId: id }, tx);
      }
      const after = await tx.vessel.update({ where: { id }, data: { photoFileId: fileId } });
      await this.audit.record(
        ctx,
        { action: 'vessel.photo_changed', module: 'fleet', entityType: 'vessel', entityId: id, vesselId: id, before: { photoFileId: before.photoFileId }, after: { photoFileId: fileId } },
        tx,
      );
      return serializeVessel(after);
    });
  }

  async listAttachments(ctx: AuthContext, id: string, includeArchived: boolean) {
    await this.getAccessible(ctx, id);
    const rows = await this.prisma.vesselAttachment.findMany({
      where: { vesselId: id, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: { createdAt: 'desc' },
    });
    const files = await this.prisma.storedFile.findMany({ where: { id: { in: rows.map((r) => r.fileId) } } });
    return rows.map((r) => ({ ...r, file: toFileDto(files.find((f) => f.id === r.fileId)!) }));
  }

  async addAttachment(ctx: AuthContext, id: string, dto: AddVesselAttachmentDto) {
    await this.getAccessible(ctx, id);
    return this.prisma.$transaction(async (tx) => {
      const att = await tx.vesselAttachment.create({
        data: { vesselId: id, fileId: dto.fileId, category: dto.category, title: dto.title, uploadedById: ctx.userId },
      });
      await this.files.attach(
        ctx,
        dto.fileId,
        { type: OWNER_VESSEL_ATTACHMENT, id: att.id, contexts: ['VESSEL_ATTACHMENT', 'VESSEL_PHOTO'], vesselId: id },
        tx,
      );
      await this.audit.record(ctx, { action: 'vessel.attachment_added', module: 'fleet', entityType: 'vessel_attachment', entityId: att.id, vesselId: id, after: dto }, tx);
      return att;
    });
  }

  async archiveAttachment(ctx: AuthContext, vesselId: string, attachmentId: string) {
    await this.getAccessible(ctx, vesselId);
    const att = await this.prisma.vesselAttachment.findFirst({ where: { id: attachmentId, vesselId } });
    if (!att) throw Errors.notFound('Pièce jointe');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.vesselAttachment.update({ where: { id: attachmentId }, data: { archivedAt: new Date() } });
      await this.audit.record(ctx, { action: 'vessel.attachment_archived', module: 'fleet', entityType: 'vessel_attachment', entityId: attachmentId, vesselId }, tx);
      return updated;
    });
  }

  /**
   * Vessel Workspace (CDC §1.3) : synthèse par onglet, chaque section n'est calculée
   * que si l'utilisateur possède la permission du module correspondant.
   */
  async workspace(ctx: AuthContext, id: string) {
    const vessel = await this.get(ctx, id);
    const today = new Date();
    const in90 = new Date(Date.now() + 90 * 86_400_000);
    const sections: Record<string, unknown> = {};

    if (can(ctx, 'members.view') || can(ctx, 'vessel_crew.assign')) {
      const [onboard, planned] = await Promise.all([
        this.prisma.crewAssignment.count({ where: { vesselId: id, status: 'ONBOARD' } }),
        this.prisma.crewAssignment.count({ where: { vesselId: id, status: 'PLANNED' } }),
      ]);
      sections.crew = { onboard, planned };
    }
    if (can(ctx, 'certificates.view')) {
      const base = { vesselId: id, archivedAt: null, currentRevisionId: { not: null } } satisfies Prisma.CertificateWhereInput;
      const [total, expired, expiring, missingDoc, unknownExpiry, pending] = await Promise.all([
        this.prisma.certificate.count({ where: base }),
        this.prisma.certificate.count({ where: { ...base, currentExpiryKind: 'DATED', currentExpiryOn: { lt: today } } }),
        this.prisma.certificate.count({ where: { ...base, currentExpiryKind: 'DATED', currentExpiryOn: { gte: today, lte: in90 } } }),
        this.prisma.certificate.count({ where: { ...base, documentMissing: true, type: { requiresDocument: true } } }),
        this.prisma.certificate.count({ where: { ...base, currentExpiryKind: 'UNKNOWN' } }),
        this.prisma.certificateApprovalRequest.count({ where: { status: 'PENDING_APPROVAL', certificate: { vesselId: id } } }),
      ]);
      sections.certificates = { total, expired, expiringWithin90Days: expiring, documentMissing: missingDoc, expiryUnknown: unknownExpiry, pendingApprovals: pending };
    }
    if (can(ctx, 'cso.view')) {
      sections.cso = {
        publishedDocuments: await this.prisma.csoDocument.count({ where: { vesselId: id, status: 'PUBLISHED' } }),
      };
    }
    if (can(ctx, 'pr.view')) {
      const [openPr, openPo] = await Promise.all([
        // PR mère « Divisée » exclue (ses sous-PR sont comptées) ; « ses propres PR » sans pr.view_all
        this.prisma.purchaseRequest.count({ where: { vesselId: id, status: { notIn: ['CLOSED', 'CANCELLED', 'REJECTED', 'DRAFT', 'SPLIT'] }, ...prOwnFilter(ctx) } }),
        this.prisma.purchaseOrder.count({ where: { vesselId: id, status: { in: ['APPROVED', 'SENT', 'PARTIALLY_RECEIVED'] }, ...poOwnFilter(ctx) } }),
      ]);
      sections.purchasing = { openPurchaseRequests: openPr, openOrders: openPo };
    }
    if (can(ctx, 'voyages.view')) {
      const active = await this.prisma.voyage.findFirst({
        where: { vesselId: id, status: 'ACTIVE' },
        select: { id: true, reference: true, charterer: true, eta: true, laycanFrom: true, laycanTo: true },
      });
      const lastNoon = can(ctx, 'noon.view')
        ? await this.prisma.noonReport.findFirst({
            where: { vesselId: id, status: { not: 'DRAFT' } },
            orderBy: { reportDateUtc: 'desc' },
            select: { id: true, reportDateUtc: true, status: true, voyageId: true, latitude: true, longitude: true, nextPort: true, etaNextPort: true },
          })
        : null;
      // Position déclarée au dernier rapport soumis (décimaux transmis en chaîne)
      sections.voyages = {
        active,
        lastNoonReport: lastNoon && { ...lastNoon, latitude: lastNoon.latitude?.toString() ?? null, longitude: lastNoon.longitude?.toString() ?? null },
      };
    }
    return { vessel, sections };
  }

  /** Historique des informations officielles (audit restreint à l'entité navire). */
  async history(ctx: AuthContext, id: string) {
    await this.getAccessible(ctx, id);
    return this.prisma.auditEvent.findMany({
      where: { entityType: 'vessel', entityId: id, module: 'fleet' },
      orderBy: { occurredAt: 'desc' },
      take: 200,
      select: { id: true, occurredAt: true, actorLabel: true, action: true, before: true, after: true, metadata: true },
    });
  }

  /** Utilisé par les autres modules : filtre Prisma des navires accessibles. */
  scopeWhere(ctx: AuthContext, field = 'vesselId') {
    return vesselWhere(ctx, field);
  }

  private async assertNoDuplicate(dto: { imoNumber?: string | null; mmsi?: string | null; code?: string }, excludeId?: string) {
    const ors: Prisma.VesselWhereInput[] = [];
    if (dto.imoNumber) ors.push({ imoNumber: dto.imoNumber });
    if (dto.mmsi) ors.push({ mmsi: dto.mmsi });
    if (dto.code) ors.push({ code: dto.code });
    if (!ors.length) return;
    const dup = await this.prisma.vessel.findFirst({
      where: { OR: ors, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, name: true, imoNumber: true, mmsi: true, code: true },
    });
    if (dup) {
      const field = dto.imoNumber && dup.imoNumber === dto.imoNumber ? 'IMO' : dto.mmsi && dup.mmsi === dto.mmsi ? 'MMSI' : 'code';
      // Ne divulgue pas le navire existant s'il est hors périmètre : seulement le champ en conflit
      throw Errors.duplicate(`Un navire avec ce ${field} existe déjà`, { field });
    }
  }
}
