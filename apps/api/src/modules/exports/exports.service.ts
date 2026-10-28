import { Injectable } from '@nestjs/common';
import { ExportFormat, Prisma } from '@prisma/client';
import { VALIDITY_LABELS } from '@amc/types';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { memberVisibilityWhere } from '../access/member-access';
import { AuditService } from '../audit/audit.service';
import { AUDIT_PERMISSION_BY_MODULE, auditScopeWhere } from '../audit/audit.controller';
import { ExcelService, ExportColumn } from '../documents/excel.service';
import { FilesService } from '../files/files.service';
import { SettingsService } from '../settings/settings.service';

export type ExportResource = 'certificates' | 'vessels' | 'audit';
const MAX_ROWS = 20_000;

function validity(kind: string | null, expiry: Date | null, soonDays: number): string {
  if (!kind) return '';
  if (kind === 'UNLIMITED') return VALIDITY_LABELS.UNLIMITED;
  if (kind === 'UNKNOWN') return VALIDITY_LABELS.EXPIRY_UNKNOWN;
  if (!expiry) return '';
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const days = Math.round((expiry.getTime() - today) / 86_400_000);
  if (days < 0) return VALIDITY_LABELS.EXPIRED;
  if (days <= soonDays) return VALIDITY_LABELS.EXPIRING_SOON;
  return VALIDITY_LABELS.VALID;
}

const d = (v: Date | null | undefined) => (v ? v.toISOString().slice(0, 10) : '');

/**
 * Exports CSV / XLSX (CDC §9) : permission dédiée `reports.export` + permission de lecture du module,
 * filtrage par scope navire / ADM-070 identique aux écrans, audit de l'export et de ses filtres.
 * Le fichier est stocké dans le bucket `amc-exports` (expiration automatique) et réservé au demandeur.
 */
@Injectable()
export class ExportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excel: ExcelService,
    private readonly files: FilesService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async create(ctx: AuthContext, resource: ExportResource, format: 'CSV' | 'XLSX', filters: Record<string, string | undefined>) {
    if (!can(ctx, 'reports.export')) throw Errors.forbidden('Permission requise : reports.export');
    const job = await this.prisma.exportJob.create({
      data: { format: format as ExportFormat, module: resource, resource, params: filters as Prisma.InputJsonValue, status: 'RUNNING', requestedById: ctx.userId },
    });
    try {
      const { columns, rows, module, vesselId } = await this.collect(ctx, resource, filters);
      const stamp = new Date().toISOString().slice(0, 10);
      const name = `AMC-${resource}-${stamp}.${format === 'CSV' ? 'csv' : 'xlsx'}`;
      const buffer = format === 'CSV' ? this.excel.writeCsv(columns, rows) : await this.excel.writeXlsx([{ name: resource, columns, rows }]);
      const file = await this.files.storeGenerated(
        buffer,
        name,
        format === 'CSV' ? 'CSV' : 'EXCEL',
        format === 'CSV' ? 'text/csv' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'EXPORT',
        null,
        ctx.userId,
        { type: 'export_job', id: job.id },
      );
      const done = await this.prisma.exportJob.update({
        where: { id: job.id },
        data: { status: 'COMPLETED', fileId: file.id, itemCount: rows.length, finishedAt: new Date() },
      });
      await this.audit.record(ctx, {
        action: 'export.generated',
        module: module as never,
        entityType: 'export_job',
        entityId: job.id,
        vesselId,
        metadata: { resource, format, filters, rows: rows.length, sha256: file.sha256 },
      });
      return { ...done, link: await this.files.issueLink(ctx, file, 'download') };
    } catch (e) {
      await this.prisma.exportJob.update({
        where: { id: job.id },
        data: { status: 'FAILED', error: String((e as Error).message ?? e).slice(0, 900), finishedAt: new Date() },
      });
      throw e;
    }
  }

  list(ctx: AuthContext) {
    return this.prisma.exportJob.findMany({ where: { requestedById: ctx.userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async link(ctx: AuthContext, id: string) {
    const job = await this.prisma.exportJob.findFirst({ where: { id, requestedById: ctx.userId } });
    if (!job) throw Errors.notFound('Export');
    if (!job.fileId) throw Errors.invalidState('Export non disponible');
    return this.files.issueLink(ctx, job.fileId, 'download');
  }

  private async collect(ctx: AuthContext, resource: ExportResource, f: Record<string, string | undefined>) {
    if (resource === 'vessels') {
      if (!can(ctx, 'vessels.view')) throw Errors.forbidden('Permission requise : vessels.view');
      const rows = await this.prisma.vessel.findMany({
        where: ctx.vesselScope.mode === 'ALL_FLEET' ? {} : { id: { in: ctx.vesselScope.vesselIds } },
        orderBy: { name: 'asc' },
        take: MAX_ROWS,
      });
      const columns: ExportColumn[] = [
        { header: 'Code', key: 'code', width: 10 },
        { header: 'Navire', key: 'name', width: 26 },
        { header: 'IMO', key: 'imoNumber', width: 12 },
        { header: 'MMSI', key: 'mmsi', width: 12 },
        { header: 'Indicatif', key: 'callSign', width: 12 },
        { header: 'Pavillon', key: 'flag', width: 10 },
        { header: 'Type', key: 'vesselType', width: 22 },
        { header: 'Classe', key: 'classSociety', width: 18 },
        { header: 'Statut', key: 'status', width: 12 },
        { header: 'GT', key: 'grossTonnage', width: 10 },
        { header: 'DWT', key: 'deadweight', width: 10 },
      ];
      return {
        module: 'fleet',
        vesselId: null,
        columns,
        rows: rows.map((v) => ({ ...v, grossTonnage: v.grossTonnage?.toString() ?? '', deadweight: v.deadweight?.toString() ?? '' })),
      };
    }

    if (resource === 'certificates') {
      if (!can(ctx, 'certificates.view')) throw Errors.forbidden('Permission requise : certificates.view');
      const branches: Prisma.CertificateWhereInput[] = [{ subjectKind: 'VESSEL', ...vesselWhere(ctx) }];
      if (can(ctx, 'members.certificates.view')) branches.push({ subjectKind: 'MEMBER', member: memberVisibilityWhere(ctx) });
      if (f.vesselId && ctx.vesselScope.mode === 'SELECTED' && !ctx.vesselScope.vesselIds.includes(f.vesselId)) throw Errors.scopeDenied();
      const rows = await this.prisma.certificate.findMany({
        where: {
          AND: [
            { OR: branches },
            f.includeArchived === 'true' ? {} : { archivedAt: null },
            f.vesselId ? { vesselId: f.vesselId } : {},
            f.subjectKind === 'VESSEL' || f.subjectKind === 'MEMBER' ? { subjectKind: f.subjectKind } : {},
            { currentRevisionId: { not: null } },
          ],
        },
        include: {
          type: { select: { code: true, name: true, category: true, requiresDocument: true } },
          vessel: { select: { code: true, name: true } },
          member: { select: { amcRef: true, firstName: true, lastName: true } },
          currentRevision: { select: { issuer: true, issuedOn: true } },
        },
        orderBy: [{ currentExpiryOn: 'asc' }],
        take: MAX_ROWS,
      });
      const soon = await this.settings.get('certificates.expiringSoonDays');
      const columns: ExportColumn[] = [
        { header: 'Titulaire', key: 'subject', width: 28 },
        { header: 'Type', key: 'type', width: 10 },
        { header: 'Certificat', key: 'typeName', width: 36 },
        { header: 'Catégorie', key: 'category', width: 14 },
        { header: 'Numéro', key: 'number', width: 18 },
        { header: 'Émetteur', key: 'issuer', width: 24 },
        { header: 'Délivré le', key: 'issuedOn', width: 12 },
        { header: 'Échéance', key: 'expiry', width: 12 },
        { header: 'Validité', key: 'validity', width: 18 },
        { header: 'Renouvellement', key: 'renewal', width: 16 },
        { header: 'Document officiel', key: 'document', width: 18 },
        { header: 'Archivé', key: 'archived', width: 10 },
      ];
      return {
        module: 'certificates',
        vesselId: f.vesselId ?? null,
        columns,
        rows: rows.map((c) => ({
          subject: c.vessel ? `${c.vessel.name} (${c.vessel.code})` : c.member ? `${c.member.lastName} ${c.member.firstName}${c.member.amcRef ? ` (${c.member.amcRef})` : ''}` : '',
          type: c.type.code,
          typeName: c.type.name,
          category: c.type.category,
          number: c.currentNumber ?? '',
          issuer: c.currentRevision?.issuer ?? '',
          issuedOn: d(c.currentRevision?.issuedOn),
          expiry: c.currentExpiryKind === 'DATED' ? d(c.currentExpiryOn) : c.currentExpiryKind === 'UNLIMITED' ? 'Illimité' : 'Inconnue',
          validity: validity(c.currentExpiryKind, c.currentExpiryOn, soon),
          renewal: c.renewalStatus === 'IN_PROGRESS' ? 'En cours' : c.renewalStatus === 'COMPLETED' ? 'Terminé' : '',
          document: !c.documentMissing ? 'Présent' : c.type.requiresDocument ? 'Manquant' : 'Non exigé',
          archived: c.archivedAt ? 'Oui' : 'Non',
        })),
      };
    }

    // Journal d'audit : mêmes règles que GET /audit (module + scope navire)
    const readable = Object.entries(AUDIT_PERMISSION_BY_MODULE).filter(([, p]) => can(ctx, p)).map(([m]) => m);
    if (!readable.length) throw Errors.forbidden("Aucun droit de lecture d'audit");
    if (f.module && !readable.includes(f.module)) throw Errors.forbidden(`Lecture de l'audit ${f.module} non autorisée`);
    const rows = await this.prisma.auditEvent.findMany({
      where: {
        AND: [
          { module: f.module ? f.module : { in: readable } },
          auditScopeWhere(ctx),
          f.from || f.to ? { occurredAt: { gte: f.from ? new Date(f.from) : undefined, lte: f.to ? new Date(f.to) : undefined } } : {},
          f.action ? { action: { startsWith: f.action } } : {},
        ],
      },
      orderBy: { occurredAt: 'desc' },
      take: MAX_ROWS,
    });
    return {
      module: 'admin',
      vesselId: null,
      columns: [
        { header: 'Date (UTC)', key: 'occurredAt', width: 22 },
        { header: 'Acteur', key: 'actorLabel', width: 28 },
        { header: 'Module', key: 'module', width: 12 },
        { header: 'Action', key: 'action', width: 30 },
        { header: 'Objet', key: 'entityType', width: 18 },
        { header: 'Identifiant', key: 'entityId', width: 38 },
        { header: 'Résultat', key: 'result', width: 10 },
        { header: 'IP', key: 'ip', width: 16 },
        { header: 'Avant', key: 'before', width: 40 },
        { header: 'Après', key: 'after', width: 40 },
      ] as ExportColumn[],
      rows: rows.map((e) => ({
        ...e,
        occurredAt: e.occurredAt.toISOString(),
        before: e.before ? JSON.stringify(e.before).slice(0, 30_000) : '',
        after: e.after ? JSON.stringify(e.after).slice(0, 30_000) : '',
      })),
    };
  }
}
