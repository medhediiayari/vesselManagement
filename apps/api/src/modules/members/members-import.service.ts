import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ImportJob, ImportRow, ImportRowDecision, ImportRowStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError, Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, canAccessVessel } from '../access/auth-context';
import { assertMemberVisible, isMemberVisible, memberVisibilityWhere } from '../access/member-access';
import { AuditService, diffFields } from '../audit/audit.service';
import { ExcelService, SheetData } from '../documents/excel.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CrewAssignmentsService } from './crew-assignments.service';
import { MemberDuplicatesService } from './member-duplicates.service';
import {
  FieldDiff,
  ImportColumn,
  ImportedCertificate,
  MemberImportField,
  NormalizedMember,
  NormalizedRow,
  RankRef,
  RowIssue,
  StoredCandidate,
  VesselRef,
  applyCorrections,
  buildHeaders,
  columnLetter,
  computeImportDiff,
  computeRowStatus,
  findInFileDuplicates,
  identityOf,
  isBlankRow,
  normalizeImportRow,
  parseMappingTarget,
  rawCellToJson,
  resolveColumnKey,
  resolveVessel,
  suggestMapping,
  suggestSheetDefaults,
  targetToString,
  validateNormalizedMember,
} from './member-import.logic';
import {
  CreateImportJobDto,
  ListImportJobsQuery,
  ListImportRowsQuery,
  RowDecisionDto,
  SetImportMappingDto,
} from './members-import.dto';
import {
  DUPLICATE_REASON_LABELS,
  IdentityRecord,
  MemberIdentity,
  OUT_OF_SCOPE_DUPLICATE_MESSAGE,
  PROTECTED_MEMBER_FIELDS,
  STRONG_DUPLICATE_THRESHOLD,
  changedProtectedFields,
  dateFromYmd,
  identityKeys,
  partitionCandidates,
  rankCandidates,
  scoreDuplicate,
  todayYmd,
  ymd,
} from './members.logic';
import { serializeMember } from './members.service';

export const OWNER_MEMBER_IMPORT_SOURCE = 'member_import_source';
export const OWNER_IMPORT_REPORT = 'import_report';
/** Un commit « COMMITTING » plus ancien est considéré interrompu et peut être repris. */
const STALE_COMMIT_MS = 15 * 60_000;
const OPEN_REQUEST_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'RETURNED'] as const;

interface DiscoveredColumn {
  letter: string;
  index: number;
  header: string;
  samples: string[];
  suggested: string | null;
}

interface DiscoveredSheet {
  name: string;
  rowCount: number;
  headerRow: number;
  headerRowCount: 1 | 2;
  columns: DiscoveredColumn[];
  suggestedMapping: Record<string, string>;
  suggestedDefaults: { crewDepartment?: string };
  suggestedInclude: boolean;
}

interface AppliedSheetMapping {
  name: string;
  include: boolean;
  headerRow: number;
  headerRowCount: 1 | 2;
  columns: { letter: string; header: string; target: string }[];
  defaults?: { rank?: string; crewDepartment?: string; vesselId?: string };
}

interface JobOptions {
  sheets: DiscoveredSheet[];
  mapping?: AppliedSheetMapping[];
  createAssignments?: boolean;
  defaultVesselId?: string | null;
}

interface CertificateOutcome {
  code: string;
  result: 'REQUEST_CREATED' | 'SKIPPED';
  certificateId?: string;
  requestId?: string;
  reason?: string;
}

interface AssignmentOutcome {
  result: 'CREATED' | 'SKIPPED';
  assignmentId?: string;
  status?: string;
  reason?: string;
}

interface RowOutcome {
  memberId: string;
  action: 'CREATED' | 'UPDATED';
  changedFields: string[];
  certificates: CertificateOutcome[];
  assignment?: AssignmentOutcome;
}

type StoredNormalized = NormalizedRow & {
  vesselId?: string | null;
  vesselLabel?: string | null;
  decisionReason?: string | null;
  corrections?: Record<string, { from: unknown; to: unknown }>;
  outcome?: RowOutcome;
};

interface CommitRun {
  created: number;
  updated: number;
  ignored: number;
  skippedInvalid: number;
  failed: number;
  alreadyApplied: number;
  certificateRequests: number;
  certificatesSkipped: number;
  assignments: number;
}

interface CertTypeRef {
  id: string;
  code: string;
  name: string;
}

const MEMBER_DIFF_SELECT = {
  id: true, amcRef: true, firstName: true, lastName: true, birthDate: true, birthPlace: true, nationality: true, gender: true,
  email: true, phone: true, address: true, emergencyContactName: true, emergencyContactPhone: true, passportNumber: true,
  passportCountry: true, passportExpiry: true, seamanBookNumber: true, seamanBookExpiry: true, rank: true, crewDepartment: true,
  notes: true, status: true, archivedAt: true,
} satisfies Prisma.MemberSelect;

const asJson = (v: unknown) => v as Prisma.InputJsonValue;

/** Convertit une fiche normalisée (dates AAAA-MM-JJ) en données Prisma. */
function toMemberData(m: Partial<NormalizedMember>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === undefined) continue;
    out[k] = k === 'birthDate' || k === 'passportExpiry' || k === 'seamanBookExpiry' ? dateFromYmd(v as string) : v;
  }
  return out;
}

function errorMessage(e: unknown): string {
  if (e instanceof AppError) {
    const r = e.getResponse() as { message?: string };
    return (r.message ?? e.message).slice(0, 1000);
  }
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = JSON.stringify(e.meta?.target ?? '');
    if (target.includes('amc_ref') || target.includes('amcRef')) return 'Matricule AMC déjà attribué à une autre fiche';
    return 'Conflit d’unicité en base (donnée déjà présente)';
  }
  return 'Erreur technique lors de l’application de la ligne (voir journaux serveur)';
}

/**
 * Import Excel Members avancé (ADM-040..043, CDC V1 §5.3) :
 * dépôt -> découverte des feuilles + mapping suggéré -> mapping par feuille -> prévisualisation
 * (normalisation, doublons base + fichier) -> décisions explicites par ligne -> commit idempotent
 * (sous-transaction par ligne) -> rapport XLSX. Certificats importés en demandes PENDING_APPROVAL
 * (contrat ARCHITECTURE §4), jamais approuvés automatiquement.
 */
@Injectable()
export class MembersImportService implements OnModuleInit {
  private readonly logger = new Logger('MembersImport');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly excel: ExcelService,
    private readonly notifications: NotificationsService,
    private readonly duplicates: MemberDuplicatesService,
    private readonly crew: CrewAssignmentsService,
  ) {}

  /** Fichier source d'un import : members.import ET créateur du job (même isolation que les lignes). */
  onModuleInit(): void {
    this.registry.register(OWNER_MEMBER_IMPORT_SOURCE, async (ctx, file) => {
      this.access.assertCan(ctx, 'members.import');
      const job = await this.loadOwn(ctx, file.ownerId!);
      return { module: 'members', entityType: 'import_job', entityId: job.id, vesselId: job.vesselId, forceAttachment: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Création & découverte
  // ---------------------------------------------------------------------------

  async createJob(ctx: AuthContext, dto: CreateImportJobDto) {
    const file = await this.files.getOrThrow(dto.sourceFileId);
    if (file.context !== 'IMPORT_SOURCE') throw Errors.validation('Fichier attendu dans le contexte IMPORT_SOURCE');
    if (file.kind !== 'EXCEL' && file.kind !== 'CSV') throw Errors.fileRejected('Classeur .xlsx, .xls ou .csv attendu');
    if (file.uploadedById !== ctx.userId) throw Errors.forbidden('Fichier déposé par un autre utilisateur');
    if (file.ownerId) throw Errors.conflict('Fichier déjà utilisé par un import', { importJobId: file.ownerId });
    if (dto.vesselId) await this.assertVessel(ctx, dto.vesselId);

    const sheets = this.excel.readWorkbook(await this.files.readBuffer(file));
    const certTypes = await this.certificateTypes();
    const codes = new Set(certTypes.keys());
    const discovered = sheets.map((s) => this.discoverSheet(s, codes));
    if (!discovered.some((s) => s.rowCount > 0)) throw Errors.fileRejected('Classeur vide : aucune ligne de données');

    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.importJob.create({
        data: {
          kind: 'MEMBERS',
          status: 'QUEUED',
          phase: 'MAPPING',
          sourceFileId: file.id,
          vesselId: dto.vesselId ?? null,
          options: asJson({ sheets: discovered } satisfies JobOptions),
          createdById: ctx.userId,
        },
      });
      await this.files.attach(ctx, file.id, { type: OWNER_MEMBER_IMPORT_SOURCE, id: j.id, contexts: ['IMPORT_SOURCE'] }, tx);
      await this.audit.record(
        ctx,
        {
          action: 'member_import.created',
          module: 'members',
          entityType: 'import_job',
          entityId: j.id,
          after: { sourceFileId: file.id, fileName: file.originalName, sha256: file.sha256, sheets: discovered.map((s) => ({ name: s.name, rows: s.rowCount })) },
        },
        tx,
      );
      return j;
    });
    return this.presentJob(job);
  }

  private discoverSheet(s: SheetData, codes: ReadonlySet<string>): DiscoveredSheet {
    const headerIdx = s.rows.length ? this.excel.detectHeaderRow(s.rows) : 0;
    const headers = buildHeaders(s.rows, headerIdx, 1);
    const data = s.rows.slice(headerIdx + 1);
    const suggestedMapping = suggestMapping(headers, codes);
    const columns: DiscoveredColumn[] = headers
      .map((header, index) => {
        const letter = columnLetter(index);
        const samples = data
          .map((r) => rawCellToJson(r[index]))
          .filter((v) => v !== null)
          .slice(0, 3)
          .map((v) => String(v).slice(0, 60));
        return { letter, index, header, samples, suggested: suggestedMapping[letter] ?? null };
      })
      .filter((c) => c.header || c.samples.length);
    const targets = Object.values(suggestedMapping);
    return {
      name: s.name,
      rowCount: data.length,
      headerRow: headerIdx + 1,
      headerRowCount: 1,
      columns,
      suggestedMapping,
      suggestedDefaults: suggestSheetDefaults(s.name),
      suggestedInclude: data.length > 0 && (targets.includes('fullName') || (targets.includes('lastName') && targets.includes('firstName'))),
    };
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  /** Imports de l'utilisateur courant uniquement. */
  async listJobs(ctx: AuthContext, q: ListImportJobsQuery) {
    const rows = await this.prisma.importJob.findMany({
      where: { kind: 'MEMBERS', createdById: ctx.userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      include: { createdBy: { select: { id: true, displayName: true } } },
      ...cursorArgs(q),
    });
    const page = toPage(rows, q);
    const files = await this.prisma.storedFile.findMany({
      where: { id: { in: page.items.map((j) => j.sourceFileId) } },
      select: { id: true, originalName: true },
    });
    return {
      ...page,
      items: page.items.map((j) => ({
        id: j.id,
        status: j.status,
        phase: j.phase,
        sourceFile: files.find((f) => f.id === j.sourceFileId) ?? null,
        summary: j.summary,
        createdBy: j.createdBy,
        createdAt: j.createdAt,
        finishedAt: j.finishedAt,
      })),
    };
  }

  async getJob(ctx: AuthContext, id: string) {
    return this.presentJob(await this.loadOwn(ctx, id));
  }

  private async presentJob(job: ImportJob) {
    const opts = job.options as unknown as JobOptions;
    const [file, creator, byStatus, byDecision] = await Promise.all([
      this.prisma.storedFile.findUnique({ where: { id: job.sourceFileId }, select: { id: true, originalName: true, sizeBytes: true, sha256: true } }),
      this.prisma.user.findUnique({ where: { id: job.createdById }, select: { id: true, displayName: true } }),
      this.prisma.importRow.groupBy({ by: ['status'], where: { jobId: job.id }, _count: { _all: true } }),
      this.prisma.importRow.groupBy({ by: ['decision'], where: { jobId: job.id }, _count: { _all: true } }),
    ]);
    const pendingDuplicates = await this.prisma.importRow.count({ where: { jobId: job.id, status: 'DUPLICATE_SUSPECTED', decision: 'PENDING' } });
    return {
      id: job.id,
      kind: job.kind,
      status: job.status,
      phase: job.phase,
      sourceFile: file ? { ...file, sizeBytes: Number(file.sizeBytes) } : null,
      vesselId: job.vesselId,
      sheets: opts.sheets,
      mapping: opts.mapping ?? null,
      createAssignments: !!opts.createAssignments,
      defaultVesselId: opts.defaultVesselId ?? null,
      summary: job.summary,
      counts: {
        byStatus: Object.fromEntries(byStatus.map((g) => [g.status, g._count._all])),
        byDecision: Object.fromEntries(byDecision.map((g) => [g.decision, g._count._all])),
        pendingDuplicateDecisions: pendingDuplicates,
      },
      canCommit: job.status !== 'CANCELLED' && (job.phase === 'PREVIEW_READY' || job.phase === 'COMMITTED') && pendingDuplicates === 0,
      errorMessage: job.errorMessage,
      createdBy: creator,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  }

  // ---------------------------------------------------------------------------
  // Mapping & prévisualisation
  // ---------------------------------------------------------------------------

  /**
   * Applique le mapping par feuille, normalise chaque ligne et détecte les doublons
   * (base ET fichier, multicritère avec score). Remplace la prévisualisation précédente
   * tant qu'aucune ligne n'a été appliquée.
   */
  async setMapping(ctx: AuthContext, id: string, dto: SetImportMappingDto) {
    const job = await this.loadOwn(ctx, id);
    this.assertNotCancelled(job);
    if (job.phase !== 'MAPPING' && job.phase !== 'PREVIEW_READY') {
      throw Errors.invalidState('Mapping non modifiable : la validation (commit) a déjà eu lieu');
    }
    if (await this.prisma.importRow.count({ where: { jobId: id, status: 'APPLIED' } })) {
      throw Errors.invalidState('Des lignes ont déjà été appliquées : mapping figé');
    }
    const opts = job.options as unknown as JobOptions;
    const file = await this.files.getOrThrow(job.sourceFileId);
    const workbook = this.excel.readWorkbook(await this.files.readBuffer(file));
    const [certTypes, ranks, vessels] = await Promise.all([
      this.certificateTypes(),
      this.prisma.rank.findMany({ where: { isActive: true }, orderBy: { sortOrder: 'asc' }, select: { code: true, name: true, crewDepartment: true } }),
      this.prisma.vessel.findMany({ select: { id: true, code: true, name: true, imoNumber: true } }),
    ]);
    const codes = new Set(certTypes.keys());

    // ---- Validation du mapping
    const issues: string[] = [];
    const applied: AppliedSheetMapping[] = [];
    const prepared: { sheet: SheetData; mapping: AppliedSheetMapping; columns: ImportColumn[]; headerIdx: number }[] = [];
    let certificateColumns = false;
    const seenNames = new Set<string>();
    for (const sm of dto.sheets) {
      if (seenNames.has(sm.name)) {
        issues.push(`Feuille « ${sm.name} » mentionnée deux fois`);
        continue;
      }
      seenNames.add(sm.name);
      const sheet = workbook.find((s) => s.name === sm.name);
      if (!sheet || !opts.sheets.some((s) => s.name === sm.name)) {
        issues.push(`Feuille « ${sm.name} » introuvable dans le classeur`);
        continue;
      }
      const headerIdx = sm.headerRow - 1;
      if (headerIdx >= sheet.rows.length) {
        issues.push(`Feuille « ${sm.name} » : ligne d'en-tête ${sm.headerRow} au-delà des données`);
        continue;
      }
      const headers = buildHeaders(sheet.rows, headerIdx, sm.headerRowCount);
      const columns: ImportColumn[] = [];
      const usedTargets = new Set<string>();
      const usedColumns = new Set<number>();
      for (const [key, rawTarget] of Object.entries(sm.mapping)) {
        const target = parseMappingTarget(rawTarget);
        if (!target) {
          issues.push(`Feuille « ${sm.name} » : cible « ${rawTarget} » inconnue (colonne ${key})`);
          continue;
        }
        if (target.kind === 'ignore') continue;
        const idx = resolveColumnKey(key, headers);
        if (idx < 0) {
          issues.push(`Feuille « ${sm.name} » : colonne « ${key} » ${idx === -2 ? 'ambiguë (en-tête en double : utiliser la lettre)' : 'introuvable'}`);
          continue;
        }
        if (usedColumns.has(idx)) {
          issues.push(`Feuille « ${sm.name} » : colonne ${columnLetter(idx)} mappée deux fois`);
          continue;
        }
        if (target.kind === 'certificate') {
          certificateColumns = true;
          if (!codes.has(target.code)) {
            issues.push(`Feuille « ${sm.name} » : type de certificat ${target.code} inconnu, inactif ou non MEMBER`);
            continue;
          }
        }
        const t = targetToString(target);
        if (usedTargets.has(t)) {
          issues.push(`Feuille « ${sm.name} » : cible ${t} mappée sur plusieurs colonnes`);
          continue;
        }
        usedTargets.add(t);
        usedColumns.add(idx);
        columns.push({ letter: columnLetter(idx), header: headers[idx] ?? '', target });
      }
      const mappingRecord: AppliedSheetMapping = {
        name: sm.name,
        include: sm.include,
        headerRow: sm.headerRow,
        headerRowCount: sm.headerRowCount,
        columns: columns.map((c) => ({ letter: c.letter, header: c.header, target: targetToString(c.target) })),
        defaults: sm.defaults,
      };
      applied.push(mappingRecord);
      if (!sm.include) continue;
      const hasNames = usedTargets.has('fullName') || (usedTargets.has('lastName') && usedTargets.has('firstName'));
      if (!hasNames) issues.push(`Feuille « ${sm.name} » : mapper NOM et PRENOM (ou une colonne NOM ET PRENOM)`);
      if (sm.defaults?.vesselId) {
        if (!canAccessVessel(ctx, sm.defaults.vesselId) || !vessels.some((v) => v.id === sm.defaults!.vesselId)) {
          issues.push(`Feuille « ${sm.name} » : navire par défaut inconnu ou hors périmètre`);
        }
      }
      prepared.push({ sheet, mapping: mappingRecord, columns, headerIdx });
    }
    if (!prepared.length && !issues.length) issues.push('Aucune feuille incluse dans l’import');
    if (issues.length) throw Errors.validation('Mapping invalide', { issues });
    if (certificateColumns && !can(ctx, 'certificates.create')) {
      throw Errors.forbidden('Import des certificats : permission certificates.create requise (ou retirer les colonnes certificats)', {
        permission: 'certificates.create',
      });
    }
    if (dto.createAssignments && !can(ctx, 'vessel_crew.assign')) {
      throw Errors.forbidden('Création des affectations : permission vessel_crew.assign requise', { permission: 'vessel_crew.assign' });
    }
    if (dto.defaultVesselId) await this.assertVessel(ctx, dto.defaultVesselId);

    // ---- Normalisation des lignes
    const rankRefs: RankRef[] = ranks;
    const vesselRefs: VesselRef[] = vessels;
    type Draft = { id: string; sheetName: string; rowNumber: number; raw: Record<string, unknown>; normalized: StoredNormalized; errors: RowIssue[]; warnings: RowIssue[] };
    const drafts: Draft[] = [];
    const perSheet: Record<string, { rows: number; blank: number }> = {};
    for (const p of prepared) {
      const stats = (perSheet[p.mapping.name] = { rows: 0, blank: 0 });
      const start = p.headerIdx + p.mapping.headerRowCount;
      const width = p.sheet.rows.reduce((w, r) => Math.max(w, r.length), 0);
      for (let i = start; i < p.sheet.rows.length; i++) {
        const row = p.sheet.rows[i];
        const cells: Record<string, unknown> = {};
        const raw: Record<string, unknown> = {};
        for (let c = 0; c < width; c++) {
          const letter = columnLetter(c);
          cells[letter] = row[c] ?? null;
          const j = rawCellToJson(row[c]);
          if (j !== null) raw[letter] = j;
        }
        if (isBlankRow(cells, p.columns)) {
          stats.blank++;
          continue;
        }
        stats.rows++;
        const { normalized, errors, warnings } = normalizeImportRow(cells, p.columns, {
          ranks: rankRefs,
          certificateCodes: codes,
          defaults: { rank: p.mapping.defaults?.rank ?? null, crewDepartment: (p.mapping.defaults?.crewDepartment as NormalizedMember['crewDepartment']) ?? null },
        });
        const stored: StoredNormalized = { ...normalized };
        if (normalized.assignment) {
          const v = normalized.assignment.vesselText ? resolveVessel(normalized.assignment.vesselText, vesselRefs) : null;
          if (normalized.assignment.vesselText && !v) {
            warnings.push({ field: 'vessel', message: `Navire « ${normalized.assignment.vesselText} » non reconnu (code, nom ou IMO)` });
          }
          const vesselId = v?.id ?? p.mapping.defaults?.vesselId ?? dto.defaultVesselId ?? job.vesselId ?? null;
          stored.vesselId = vesselId;
          stored.vesselLabel = vesselId ? vesselRefs.find((x) => x.id === vesselId)?.name ?? null : null;
          if (dto.createAssignments && normalized.assignment.joinDate) {
            if (!vesselId) warnings.push({ field: 'vessel', message: 'Navire non déterminé : l’affectation ne sera pas créée' });
            else if (!canAccessVessel(ctx, vesselId)) warnings.push({ field: 'vessel', message: 'Navire hors de votre périmètre : l’affectation ne sera pas créée' });
          }
        }
        drafts.push({ id: randomUUID(), sheetName: p.mapping.name, rowNumber: i + 1, raw, normalized: stored, errors, warnings });
      }
    }

    // ---- Doublons : base (toutes fiches, archivées comprises) + fichier
    const identities = drafts.map((d) => identityOf(d.normalized.member));
    const records = await this.duplicates.loadCandidates(identities);
    const index = this.indexRecords(records);
    const inFile = findInFileDuplicates(drafts.map((d, i) => ({ id: d.id, sheetName: d.sheetName, rowNumber: d.rowNumber, identity: identities[i] })));
    const rows = drafts.map((d, i) => {
      const memberCands: StoredCandidate[] = rankCandidates(identities[i], this.lookup(index, identities[i]), { limit: 5 }).map((c) => ({
        kind: 'MEMBER',
        memberId: c.memberId,
        score: c.score,
        reasons: c.reasons,
        archived: c.archived,
      }));
      const candidates = [...memberCands, ...(inFile.get(d.id) ?? []).slice(0, 5)];
      return { ...d, candidates, status: computeRowStatus(d.errors, candidates) as ImportRowStatus };
    });

    const summary = this.previewSummary(rows, perSheet);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.importRow.deleteMany({ where: { jobId: id } });
        for (let i = 0; i < rows.length; i += 500) {
          await tx.importRow.createMany({
            data: rows.slice(i, i + 500).map((r) => ({
              id: r.id,
              jobId: id,
              sheetName: r.sheetName.slice(0, 120),
              rowNumber: r.rowNumber,
              raw: asJson(r.raw),
              normalized: asJson(r.normalized),
              errors: asJson(r.errors),
              warnings: asJson(r.warnings),
              duplicateCandidates: asJson(r.candidates),
              status: r.status,
            })),
          });
        }
        const nextOptions: JobOptions = { ...opts, mapping: applied, createAssignments: dto.createAssignments, defaultVesselId: dto.defaultVesselId ?? null };
        await tx.importJob.update({
          where: { id },
          data: { phase: 'PREVIEW_READY', options: asJson(nextOptions), summary: asJson({ preview: summary }), errorMessage: null },
        });
        await this.audit.record(
          ctx,
          {
            action: 'member_import.mapped',
            module: 'members',
            entityType: 'import_job',
            entityId: id,
            after: { mapping: applied, createAssignments: dto.createAssignments },
            metadata: { summary },
          },
          tx,
        );
      },
      { timeout: 120_000 },
    );
    return { job: await this.presentJob(await this.loadOwn(ctx, id)), summary };
  }

  private previewSummary(
    rows: { sheetName: string; status: ImportRowStatus; normalized: StoredNormalized; candidates: StoredCandidate[] }[],
    perSheet: Record<string, { rows: number; blank: number }>,
  ) {
    const count = (list: typeof rows, s: ImportRowStatus) => list.filter((r) => r.status === s).length;
    const certs = rows.flatMap((r) => r.normalized.certificates);
    const byCode: Record<string, number> = {};
    certs.forEach((c) => (byCode[c.code] = (byCode[c.code] ?? 0) + 1));
    return {
      totalRows: rows.length,
      valid: count(rows, 'VALID'),
      invalid: count(rows, 'INVALID'),
      duplicateSuspected: count(rows, 'DUPLICATE_SUSPECTED'),
      blankRowsIgnored: Object.values(perSheet).reduce((s, p) => s + p.blank, 0),
      existingMemberMatches: rows.filter((r) => r.candidates.some((c) => c.kind === 'MEMBER')).length,
      inFileDuplicates: rows.filter((r) => r.candidates.some((c) => c.kind === 'ROW')).length,
      sheets: Object.entries(perSheet).map(([name, p]) => {
        const list = rows.filter((r) => r.sheetName === name);
        return { name, rows: p.rows, blank: p.blank, valid: count(list, 'VALID'), invalid: count(list, 'INVALID'), duplicateSuspected: count(list, 'DUPLICATE_SUSPECTED') };
      }),
      certificates: {
        total: certs.length,
        byCode,
        dated: certs.filter((c) => c.expiryKind === 'DATED').length,
        unlimited: certs.filter((c) => c.expiryKind === 'UNLIMITED').length,
        unknownExpiry: certs.filter((c) => c.expiryKind === 'UNKNOWN').length,
        expired: certs.filter((c) => c.expiryKind === 'DATED' && c.expiryOn! < todayYmd()).length,
      },
      assignmentsDetected: rows.filter((r) => r.normalized.assignment?.joinDate).length,
    };
  }

  // ---------------------------------------------------------------------------
  // Lignes & décisions
  // ---------------------------------------------------------------------------

  async listRows(ctx: AuthContext, id: string, q: ListImportRowsQuery) {
    const job = await this.loadOwn(ctx, id);
    const where: Prisma.ImportRowWhereInput = {
      jobId: id,
      ...(q.status ? { status: q.status } : {}),
      ...(q.decision ? { decision: q.decision } : {}),
      ...(q.sheet ? { sheetName: q.sheet } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.importRow.findMany({ where, orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }, { id: 'asc' }], ...cursorArgs(q) }),
      this.prisma.importRow.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    return { ...page, items: await this.presentRows(ctx, job, page.items) };
  }

  async getRow(ctx: AuthContext, id: string, rowId: string) {
    const job = await this.loadOwn(ctx, id);
    const row = await this.prisma.importRow.findFirst({ where: { id: rowId, jobId: id } });
    if (!row) throw Errors.notFound('Ligne d’import');
    return (await this.presentRows(ctx, job, [row]))[0];
  }

  /**
   * Ligne présentée avec en-têtes, candidats enrichis et diff valeurs courantes / import.
   * Valeurs courantes d'une fiche existante affichées seulement si elle est visible (ADM-070).
   */
  private async presentRows(ctx: AuthContext, job: ImportJob, rows: ImportRow[]) {
    const opts = job.options as unknown as JobOptions;
    const headerOf = (sheet: string, letter: string) =>
      opts.mapping?.find((m) => m.name === sheet)?.columns.find((c) => c.letter === letter)?.header ??
      opts.sheets.find((s) => s.name === sheet)?.columns.find((c) => c.letter === letter)?.header ??
      '';
    const memberIds = new Set<string>();
    for (const r of rows) {
      ((r.duplicateCandidates ?? []) as unknown as StoredCandidate[]).forEach((c) => c.kind === 'MEMBER' && memberIds.add(c.memberId));
      if (r.decisionTargetId) memberIds.add(r.decisionTargetId);
    }
    const visible = memberIds.size
      ? await this.prisma.member.findMany({ where: { AND: [{ id: { in: [...memberIds] } }, memberVisibilityWhere(ctx)] }, select: MEMBER_DIFF_SELECT })
      : [];
    const byId = new Map(visible.map((m) => [m.id, m]));
    const deciders = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.decidedById).filter((x): x is string => !!x) } },
      select: { id: true, displayName: true },
    });
    const summaryOf = (m: (typeof visible)[number]) => ({
      id: m.id, amcRef: m.amcRef, lastName: m.lastName, firstName: m.firstName, birthDate: ymd(m.birthDate),
      passportNumber: m.passportNumber, seamanBookNumber: m.seamanBookNumber, rank: m.rank, status: m.status, archived: !!m.archivedAt,
    });
    const visibleIds = new Set(byId.keys());
    return rows.map((r) => {
      const n = (r.normalized ?? { member: {}, certificates: [], assignment: null }) as unknown as StoredNormalized;
      const stored = (r.duplicateCandidates ?? []) as unknown as StoredCandidate[];
      const memberCands = stored.filter((c): c is Extract<StoredCandidate, { kind: 'MEMBER' }> => c.kind === 'MEMBER');
      // ADM-070 : fiches invisibles réduites à une mention générique (ni id, ni score, ni raisons)
      const { visible: shown, hiddenMatch } = partitionCandidates(memberCands, visibleIds);
      const candidates = [
        ...shown.map((c) => {
          const m = byId.get(c.memberId)!;
          return {
            ...c,
            reasonLabels: c.reasons.map((x) => DUPLICATE_REASON_LABELS[x]),
            visible: true,
            member: summaryOf(m),
            diff: computeImportDiff(m as unknown as Record<string, unknown>, n.member),
          };
        }),
        ...(hiddenMatch ? [{ kind: 'MEMBER' as const, visible: false, message: OUT_OF_SCOPE_DUPLICATE_MESSAGE }] : []),
        ...stored.filter((c) => c.kind === 'ROW').map((c) => ({ ...c, reasonLabels: c.reasons.map((x) => DUPLICATE_REASON_LABELS[x]) })),
      ];
      const target = r.decisionTargetId ? byId.get(r.decisionTargetId) : undefined;
      return {
        id: r.id,
        sheetName: r.sheetName,
        rowNumber: r.rowNumber,
        status: r.status,
        decision: r.decision,
        decisionTargetId: r.decisionTargetId,
        decisionTarget: target ? summaryOf(target) : null,
        decisionTargetDiff: target ? computeImportDiff(target as unknown as Record<string, unknown>, n.member) : null,
        decisionReason: n.decisionReason ?? null,
        decidedBy: deciders.find((d) => d.id === r.decidedById) ?? null,
        decidedAt: r.decidedAt,
        appliedEntityId: r.appliedEntityId,
        appliedAt: r.appliedAt,
        errorMessage: r.errorMessage,
        raw: Object.entries((r.raw ?? {}) as Record<string, unknown>).map(([column, value]) => ({ column, header: headerOf(r.sheetName, column), value })),
        normalized: n,
        errors: r.errors ?? [],
        warnings: r.warnings ?? [],
        candidates,
      };
    });
  }

  /**
   * Décision explicite de l'opérateur (ADM-041) : CREATE (motif obligatoire si doublon suspecté),
   * UPDATE (fiche cible visible, members.edit, champs protégés => personal_fields.manage),
   * IGNORE, CORRECT (corrections puis réévaluation : erreurs + doublons).
   */
  async decideRow(ctx: AuthContext, jobId: string, rowId: string, dto: RowDecisionDto) {
    const job = await this.loadOwn(ctx, jobId);
    this.assertNotCancelled(job);
    if (job.phase === 'MAPPING') throw Errors.invalidState('Prévisualisation absente : définir le mapping d’abord');
    if (job.phase === 'COMMITTING' && !this.isStale(job)) throw Errors.invalidState('Validation (commit) en cours : réessayez à la fin');
    const row = await this.prisma.importRow.findFirst({ where: { id: rowId, jobId } });
    if (!row) throw Errors.notFound('Ligne d’import');
    if (row.status === 'APPLIED') throw Errors.alreadyProcessed('Ligne déjà appliquée');

    const n = row.normalized as unknown as StoredNormalized;
    let errors = (row.errors ?? []) as unknown as RowIssue[];
    let candidates = (row.duplicateCandidates ?? []) as unknown as StoredCandidate[];
    let normalized: StoredNormalized = n;
    let decision: ImportRowDecision = dto.decision;
    let targetId: string | null = null;
    const metadata: Record<string, unknown> = { jobId, previousDecision: row.decision, reason: dto.reason };

    switch (dto.decision) {
      case 'IGNORE':
        break;
      case 'CREATE': {
        if (errors.length) throw Errors.business('Ligne invalide : la corriger (CORRECT) avant de créer la fiche', { errors });
        this.assertCanCreateMember(ctx, n.member);
        this.assertCanImportCertificates(ctx, n.certificates);
        const sameRef = candidates.find((c) => c.kind === 'MEMBER' && c.reasons.includes('AMC_REF'));
        if (sameRef) throw Errors.conflict('Matricule AMC déjà attribué à une fiche existante : choisir UPDATE ou IGNORE');
        if (candidates.length && !dto.reason) throw Errors.validation('Motif requis pour créer une fiche malgré un doublon potentiel');
        normalized = { ...n, decisionReason: dto.reason ?? null };
        break;
      }
      case 'UPDATE': {
        if (!can(ctx, 'members.edit')) throw Errors.forbidden('Mise à jour d’une fiche existante : permission members.edit requise', { permission: 'members.edit' });
        if (errors.length) throw Errors.business('Ligne invalide : la corriger (CORRECT) avant mise à jour', { errors });
        this.assertCanImportCertificates(ctx, n.certificates);
        targetId = dto.targetMemberId!;
        await assertMemberVisible(this.prisma, ctx, targetId);
        const target = await this.prisma.member.findUniqueOrThrow({ where: { id: targetId } });
        if (target.archivedAt) throw Errors.invalidState('Fiche cible archivée : la restaurer avant mise à jour');
        const other = await this.prisma.importRow.findFirst({
          where: { jobId, decision: 'UPDATE', decisionTargetId: targetId, id: { not: rowId }, status: { notIn: ['SKIPPED'] } },
          select: { sheetName: true, rowNumber: true },
        });
        if (other) throw Errors.conflict(`La ligne ${other.sheetName} #${other.rowNumber} met déjà à jour cette fiche`, other);
        const diff = computeImportDiff(target as unknown as Record<string, unknown>, n.member).filter((d) => d.changed);
        this.assertProtectedDiff(ctx, diff);
        await this.assertAmcRefFree(diff, targetId);
        metadata.targetIsCandidate = candidates.some((c) => c.kind === 'MEMBER' && c.memberId === targetId);
        metadata.changedFields = diff.map((d) => d.field);
        normalized = { ...n, decisionReason: dto.reason ?? null };
        break;
      }
      case 'CORRECT': {
        const ranks = await this.prisma.rank.findMany({ where: { isActive: true }, select: { code: true, name: true, crewDepartment: true } });
        const corrections = dto.corrections as Partial<Record<MemberImportField, string | null>>;
        const protectedCorrected = Object.keys(corrections).filter((k) => (PROTECTED_MEMBER_FIELDS as readonly string[]).includes(k));
        if (protectedCorrected.length && !can(ctx, 'members.personal_fields.manage')) {
          throw Errors.forbidden('Données personnelles protégées : permission members.personal_fields.manage requise', { fields: protectedCorrected });
        }
        const { member, changes } = applyCorrections(n.member, corrections, ranks);
        const corrected = new Set(Object.keys(corrections));
        const kept = errors.filter((e) => !e.field || !corrected.has(e.field));
        const fresh = validateNormalizedMember(member);
        errors = [...fresh, ...kept.filter((e) => !fresh.some((f) => f.field === e.field && f.message === e.message) && !this.isRevalidatedError(e))];
        candidates = await this.recomputeCandidates(jobId, rowId, identityOf(member));
        const status = computeRowStatus(errors, candidates);
        // CORRECT sur une ligne valide = création avec données corrigées : mêmes contrôles que CREATE
        if (status === 'VALID') {
          this.assertCanCreateMember(ctx, member);
          this.assertCanImportCertificates(ctx, n.certificates);
        }
        decision = status === 'VALID' ? 'CORRECT' : 'PENDING';
        normalized = { ...n, member, corrections: { ...(n.corrections ?? {}), ...changes }, decisionReason: dto.reason ?? null };
        metadata.corrections = changes;
        metadata.resultingStatus = status;
        break;
      }
    }

    const baseStatus = computeRowStatus(errors, candidates) as ImportRowStatus;
    const updated = await this.prisma.$transaction(async (tx) => {
      const res = await tx.importRow.updateMany({
        where: { id: rowId, status: { not: 'APPLIED' } },
        data: {
          decision,
          decisionTargetId: targetId,
          decidedById: ctx.userId,
          decidedAt: new Date(),
          status: baseStatus,
          errorMessage: null,
          normalized: asJson(normalized),
          errors: asJson(errors),
          duplicateCandidates: asJson(candidates),
        },
      });
      if (res.count === 0) throw Errors.alreadyProcessed('Ligne déjà appliquée');
      await this.audit.record(
        ctx,
        { action: 'member_import.row_decided', module: 'members', entityType: 'import_row', entityId: rowId, after: { decision, targetMemberId: targetId, status: baseStatus }, metadata },
        tx,
      );
      return tx.importRow.findUniqueOrThrow({ where: { id: rowId } });
    });
    return (await this.presentRows(ctx, job, [updated]))[0];
  }

  /** Erreurs recalculées par validateNormalizedMember (remplacées par la nouvelle validation). */
  private isRevalidatedError(e: RowIssue): boolean {
    return !e.column && (e.message === 'Nom manquant' || e.message === 'Prénom manquant' || /caractères maximum|AAAA-MM-JJ attendue|dans le futur|ISO à 2 lettres/.test(e.message));
  }

  private async recomputeCandidates(jobId: string, rowId: string, identity: MemberIdentity): Promise<StoredCandidate[]> {
    const dbCands: StoredCandidate[] = (await this.duplicates.find(identity, { limit: 5 })).map((c) => ({
      kind: 'MEMBER', memberId: c.memberId, score: c.score, reasons: c.reasons, archived: c.archived,
    }));
    const others = await this.prisma.importRow.findMany({
      where: { jobId, id: { not: rowId }, status: { notIn: ['SKIPPED'] } },
      select: { id: true, sheetName: true, rowNumber: true, normalized: true },
    });
    const rowCands: StoredCandidate[] = [];
    for (const o of others) {
      const m = scoreDuplicate(identity, identityOf(((o.normalized ?? {}) as unknown as StoredNormalized).member ?? {}));
      if (m.score >= 30) rowCands.push({ kind: 'ROW', rowId: o.id, sheetName: o.sheetName, rowNumber: o.rowNumber, score: m.score, reasons: m.reasons });
    }
    return [...dbCands, ...rowCands.sort((a, b) => b.score - a.score).slice(0, 5)];
  }

  // ---------------------------------------------------------------------------
  // Commit (idempotent, sous-transaction par ligne)
  // ---------------------------------------------------------------------------

  /**
   * Applique les décisions. Reprise sûre : les lignes APPLIED sont ignorées, chaque ligne est
   * appliquée (fiche + certificats + affectation + statut APPLIED) dans SA transaction ; une
   * interruption n'applique jamais une ligne à moitié ni deux fois.
   */
  async commit(ctx: AuthContext, id: string) {
    const job = await this.loadOwn(ctx, id);
    this.assertNotCancelled(job);
    if (job.phase === 'MAPPING') throw Errors.invalidState('Prévisualisation requise avant validation');
    const pending = await this.prisma.importRow.findMany({
      where: { jobId: id, status: 'DUPLICATE_SUSPECTED', decision: 'PENDING' },
      select: { id: true, sheetName: true, rowNumber: true },
      take: 50,
    });
    if (pending.length) {
      const total = await this.prisma.importRow.count({ where: { jobId: id, status: 'DUPLICATE_SUSPECTED', decision: 'PENDING' } });
      throw Errors.business(`${total} ligne(s) en doublon potentiel sans décision explicite : décider CREATE / UPDATE / IGNORE / CORRECT avant validation`, {
        count: total,
        rows: pending,
      });
    }
    const now = new Date();
    const lock = await this.prisma.importJob.updateMany({
      where: {
        id,
        status: { not: 'CANCELLED' },
        OR: [{ phase: { in: ['PREVIEW_READY', 'COMMITTED'] } }, { phase: 'COMMITTING', startedAt: { lt: new Date(now.getTime() - STALE_COMMIT_MS) } }],
      },
      data: { phase: 'COMMITTING', status: 'RUNNING', startedAt: now, errorMessage: null },
    });
    if (lock.count === 0) throw Errors.conflict('Validation déjà en cours pour cet import');
    await this.audit.record(ctx, { action: 'member_import.commit_started', module: 'members', entityType: 'import_job', entityId: id });

    const run: CommitRun = { created: 0, updated: 0, ignored: 0, skippedInvalid: 0, failed: 0, alreadyApplied: 0, certificateRequests: 0, certificatesSkipped: 0, assignments: 0 };
    const certTypesUsed = new Set<string>();
    let fatal: string | null = null;
    try {
      const certTypes = await this.certificateTypes();
      const company = await this.prisma.company.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
      const opts = job.options as unknown as JobOptions;
      const rows = await this.prisma.importRow.findMany({ where: { jobId: id }, orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }] });
      const appliedMap = new Map(rows.filter((r) => r.status === 'APPLIED' && r.appliedEntityId).map((r) => [r.id, r.appliedEntityId!]));

      for (const row of rows) {
        if (row.status === 'APPLIED') {
          run.alreadyApplied++;
          continue;
        }
        if (row.decision === 'IGNORE') {
          if (row.status !== 'SKIPPED') await this.prisma.importRow.update({ where: { id: row.id }, data: { status: 'SKIPPED', errorMessage: null } });
          run.ignored++;
          continue;
        }
        let decision: 'CREATE' | 'UPDATE' | 'CORRECT';
        if (row.decision === 'PENDING') {
          const rowErrors = (row.errors ?? []) as unknown as RowIssue[];
          const rowCandidates = (row.duplicateCandidates ?? []) as unknown as StoredCandidate[];
          if (row.status === 'INVALID' || rowErrors.length) {
            if (row.status !== 'SKIPPED') {
              await this.prisma.importRow.update({ where: { id: row.id }, data: { status: 'SKIPPED', errorMessage: 'Ligne invalide non corrigée : non importée' } });
            }
            run.skippedInvalid++;
            continue;
          }
          // Doublon suspecté sans décision : bloqué en amont (contrôle avant verrou) — jamais de création implicite
          if (rowCandidates.length) continue;
          // Ligne valide sans doublon (y compris reprise d'une ligne FAILED) : création non ambiguë
          decision = 'CREATE';
        } else if (row.decision === 'CREATE' || row.decision === 'UPDATE' || row.decision === 'CORRECT') {
          decision = row.decision;
        } else {
          continue;
        }
        if (row.status === 'INVALID' || ((row.errors ?? []) as unknown as RowIssue[]).length) {
          await this.prisma.importRow.update({ where: { id: row.id }, data: { status: 'SKIPPED', errorMessage: 'Ligne invalide : non importée' } });
          run.skippedInvalid++;
          continue;
        }
        try {
          const outcome = await this.applyRow(ctx, job, opts, row, decision, certTypes, company.id, appliedMap);
          if (!outcome) {
            run.alreadyApplied++;
            continue;
          }
          appliedMap.set(row.id, outcome.memberId);
          if (outcome.action === 'CREATED') run.created++;
          else run.updated++;
          for (const c of outcome.certificates) {
            if (c.result === 'REQUEST_CREATED') {
              run.certificateRequests++;
              certTypesUsed.add(c.code);
            } else run.certificatesSkipped++;
          }
          if (outcome.assignment?.result === 'CREATED') run.assignments++;
        } catch (e) {
          run.failed++;
          const message = errorMessage(e);
          if (!(e instanceof AppError)) this.logger.error(`Import ${id} ligne ${row.sheetName}#${row.rowNumber} : ${String(e)}`);
          await this.prisma.importRow.update({ where: { id: row.id }, data: { status: 'FAILED', errorMessage: message } });
          await this.audit.record(ctx, {
            action: 'member_import.row_failed',
            module: 'members',
            entityType: 'import_row',
            entityId: row.id,
            result: 'FAILURE',
            metadata: { jobId: id, sheet: row.sheetName, rowNumber: row.rowNumber, decision, error: message },
          });
        }
      }
    } catch (e) {
      fatal = errorMessage(e);
      this.logger.error(`Import ${id} interrompu : ${String(e)}`);
    }

    const status = fatal ? (run.created + run.updated ? 'PARTIALLY_FAILED' : 'FAILED') : run.failed ? 'PARTIALLY_FAILED' : 'COMPLETED';
    const previous = (job.summary ?? {}) as Record<string, unknown>;
    const thisRun = { ...run, status, at: new Date().toISOString(), by: ctx.userId };
    const finished = await this.prisma.importJob.update({
      where: { id },
      data: {
        phase: 'COMMITTED',
        status,
        finishedAt: new Date(),
        errorMessage: fatal,
        // Dernier passage + historique de toutes les exécutions (reprises comprises)
        summary: asJson({ ...previous, commit: thisRun, commitRuns: [...((previous.commitRuns as unknown[]) ?? []), thisRun] }),
      },
    });
    await this.audit.record(ctx, {
      action: 'member_import.committed',
      module: 'members',
      entityType: 'import_job',
      entityId: id,
      result: status === 'COMPLETED' ? 'SUCCESS' : 'FAILURE',
      after: { status },
      metadata: { ...run, fatal },
    });
    if (run.certificateRequests) await this.notifyValidators(ctx, id, run.certificateRequests, certTypesUsed);
    return { job: await this.presentJob(finished), run };
  }

  private async applyRow(
    ctx: AuthContext,
    job: ImportJob,
    opts: JobOptions,
    row: ImportRow,
    decision: 'CREATE' | 'UPDATE' | 'CORRECT',
    certTypes: Map<string, CertTypeRef>,
    companyId: string,
    appliedMap: Map<string, string>,
  ): Promise<RowOutcome | null> {
    const n = row.normalized as unknown as StoredNormalized;
    const candidates = (row.duplicateCandidates ?? []) as unknown as StoredCandidate[];
    const importMeta = { importJobId: job.id, importRowId: row.id, sheet: row.sheetName, rowNumber: row.rowNumber };
    return this.prisma.$transaction(
      async (tx) => {
        const fresh = await tx.importRow.findUniqueOrThrow({ where: { id: row.id }, select: { status: true } });
        if (fresh.status === 'APPLIED') return null;
        // Droits revérifiés à l'application de CHAQUE ligne (ils ont pu changer depuis la décision)
        this.assertCanImportCertificates(ctx, n.certificates);

        let memberId: string;
        let action: RowOutcome['action'];
        let changedFields: string[];
        if (decision === 'UPDATE') {
          if (!can(ctx, 'members.edit')) throw Errors.forbidden('Permission members.edit requise pour mettre à jour une fiche');
          if (!row.decisionTargetId) throw Errors.validation('Fiche cible manquante');
          await assertMemberVisible(tx, ctx, row.decisionTargetId);
          const current = await tx.member.findUniqueOrThrow({ where: { id: row.decisionTargetId } });
          if (current.archivedAt) throw Errors.invalidState('Fiche cible archivée');
          const diff = computeImportDiff(current as unknown as Record<string, unknown>, n.member).filter((d) => d.changed);
          this.assertProtectedDiff(ctx, diff);
          await this.assertAmcRefFree(diff, current.id, tx);
          const data = toMemberData(Object.fromEntries(diff.map((d) => [d.field, d.imported])) as NormalizedMember);
          if (Object.keys(data).length) {
            const after = await tx.member.update({ where: { id: current.id }, data: data as Prisma.MemberUncheckedUpdateInput });
            const d = diffFields(serializeMember(current) as never, serializeMember(after) as never);
            delete (d.before as Record<string, unknown> | undefined)?.updatedAt;
            delete (d.after as Record<string, unknown> | undefined)?.updatedAt;
            await this.audit.record(
              ctx,
              { action: 'member.updated', module: 'members', entityType: 'member', entityId: current.id, before: d.before, after: d.after, metadata: { ...importMeta, decision } },
              tx,
            );
          }
          memberId = current.id;
          action = 'UPDATED';
          changedFields = diff.map((d) => d.field);
        } else {
          this.assertCanCreateMember(ctx, n.member);
          const identity = identityOf(n.member);
          const known = new Set<string>();
          for (const c of candidates) {
            if (c.kind === 'MEMBER') known.add(c.memberId);
            else if (appliedMap.has(c.rowId)) known.add(appliedMap.get(c.rowId)!);
          }
          const strong = rankCandidates(identity, await this.duplicates.loadCandidates([identity], tx), { threshold: STRONG_DUPLICATE_THRESHOLD });
          if (strong.some((c) => c.reasons.includes('AMC_REF'))) throw Errors.duplicate('Matricule AMC déjà attribué à une autre fiche');
          const unexpected = strong.filter((c) => !known.has(c.memberId));
          if (unexpected.length) {
            throw Errors.duplicate('Nouveau doublon détecté depuis la prévisualisation : relancer l’analyse ou décider UPDATE / IGNORE', {
              candidates: unexpected.map((c) => ({ memberId: c.memberId, score: c.score, reasons: c.reasons })),
            });
          }
          const m = await tx.member.create({
            data: { ...toMemberData(n.member), companyId, createdById: ctx.userId, status: 'AVAILABLE' } as Prisma.MemberUncheckedCreateInput,
          });
          await this.audit.record(
            ctx,
            {
              action: 'member.created',
              module: 'members',
              entityType: 'member',
              entityId: m.id,
              after: serializeMember(m),
              metadata: {
                ...importMeta,
                decision,
                ...(candidates.length
                  ? { forcedDuplicate: true, reason: n.decisionReason, candidates: candidates.map((c) => ({ ...c })) }
                  : {}),
                corrections: n.corrections,
              },
            },
            tx,
          );
          memberId = m.id;
          action = 'CREATED';
          changedFields = Object.keys(n.member);
        }

        const certificates = await this.applyCertificates(tx, ctx, row, memberId, n.certificates, certTypes);
        const assignment = opts.createAssignments ? await this.applyAssignment(tx, ctx, row, memberId, n) : undefined;
        const outcome: RowOutcome = { memberId, action, changedFields, certificates, assignment };
        await tx.importRow.update({
          where: { id: row.id },
          data: {
            status: 'APPLIED',
            decision: decision === 'CREATE' && row.decision === 'PENDING' ? 'CREATE' : row.decision,
            decidedById: row.decidedById ?? ctx.userId,
            decidedAt: row.decidedAt ?? new Date(),
            appliedEntityId: memberId,
            appliedAt: new Date(),
            errorMessage: null,
            normalized: asJson({ ...n, outcome }),
          },
        });
        await this.audit.record(
          ctx,
          {
            action: 'member_import.row_applied',
            module: 'members',
            entityType: 'import_row',
            entityId: row.id,
            after: { memberId, action, changedFields },
            metadata: {
              ...importMeta,
              decision,
              implicitDecision: row.decision === 'PENDING',
              certificates: certificates.map((c) => `${c.code}:${c.result}`),
              assignment: assignment?.result,
            },
          },
          tx,
        );
        return outcome;
      },
      { timeout: 30_000 },
    );
  }

  /**
   * Contrat Members ⇄ Certificates (ARCHITECTURE §4) : certificat (si absent pour member+type),
   * demande CREATE PENDING_APPROVAL version 1 soumise, version immuable v1 ; jamais approuvée ici.
   * Demande de données déjà ouverte => ignoré + avertissement ; identique à la révision courante => ignoré.
   */
  private async applyCertificates(
    tx: Tx,
    ctx: AuthContext,
    row: ImportRow,
    memberId: string,
    certs: ImportedCertificate[],
    certTypes: Map<string, CertTypeRef>,
  ): Promise<CertificateOutcome[]> {
    const out: CertificateOutcome[] = [];
    for (const c of certs) {
      const type = certTypes.get(c.code);
      if (!type) {
        out.push({ code: c.code, result: 'SKIPPED', reason: 'Type de certificat inconnu ou inactif' });
        continue;
      }
      let cert = await tx.certificate.findFirst({
        where: { subjectKind: 'MEMBER', memberId, typeId: type.id, archivedAt: null },
        orderBy: { createdAt: 'desc' },
      });
      if (cert) {
        const open = await tx.certificateApprovalRequest.findFirst({
          where: { certificateId: cert.id, status: { in: [...OPEN_REQUEST_STATUSES] }, kind: { not: 'ATTACHMENT' } },
          select: { id: true, status: true },
        });
        if (open) {
          out.push({ code: c.code, result: 'SKIPPED', certificateId: cert.id, requestId: open.id, reason: `Demande déjà ouverte (${open.status}) pour ce certificat : import non appliqué` });
          continue;
        }
        if (
          cert.currentRevisionId &&
          (cert.currentNumber ?? null) === (c.number ?? null) &&
          cert.currentExpiryKind === c.expiryKind &&
          ymd(cert.currentExpiryOn) === c.expiryOn
        ) {
          out.push({ code: c.code, result: 'SKIPPED', certificateId: cert.id, reason: 'Identique à la révision officielle courante' });
          continue;
        }
      } else {
        cert = await tx.certificate.create({
          data: { subjectKind: 'MEMBER', memberId, typeId: type.id, createdById: ctx.userId, documentMissing: true },
        });
      }
      const now = new Date();
      const request = await tx.certificateApprovalRequest.create({
        data: { certificateId: cert.id, kind: 'CREATE', status: 'PENDING_APPROVAL', version: 1, requestedById: ctx.userId, submittedAt: now },
      });
      await tx.certificateRequestVersion.create({
        data: {
          requestId: request.id,
          versionNo: 1,
          certificateNumber: c.number,
          issuedOn: dateFromYmd(c.issuedOn),
          expiryKind: c.expiryKind,
          expiryOn: c.expiryKind === 'DATED' ? dateFromYmd(c.expiryOn) : null,
          changeNote: `Import Excel Members — feuille ${row.sheetName} ligne ${row.rowNumber}`.slice(0, 500),
          createdById: ctx.userId,
        },
      });
      await this.audit.record(
        ctx,
        {
          action: 'certificate.request_imported',
          module: 'certificates',
          entityType: 'certificate_approval_request',
          entityId: request.id,
          after: { certificateId: cert.id, memberId, type: c.code, kind: 'CREATE', status: 'PENDING_APPROVAL', version: 1, number: c.number, expiryKind: c.expiryKind, expiryOn: c.expiryOn, issuedOn: c.issuedOn },
          metadata: { importJobId: row.jobId, importRowId: row.id, sourceColumns: c.columns },
        },
        tx,
      );
      out.push({ code: c.code, result: 'REQUEST_CREATED', certificateId: cert.id, requestId: request.id });
    }
    return out;
  }

  /**
   * Historique d'embarquement importé (option createAssignments) : COMPLETED si débarqué,
   * ONBOARD si embarqué sans débarquement passé, PLANNED si la date est future. Idempotent
   * (même marin + navire + date d'embarquement), jamais deux ONBOARD simultanés.
   */
  private async applyAssignment(tx: Tx, ctx: AuthContext, row: ImportRow, memberId: string, n: StoredNormalized): Promise<AssignmentOutcome | undefined> {
    const a = n.assignment;
    if (!a?.joinDate) return undefined;
    if (!n.vesselId) return { result: 'SKIPPED', reason: 'Navire non déterminé' };
    if (!can(ctx, 'vessel_crew.assign') || !canAccessVessel(ctx, n.vesselId)) {
      return { result: 'SKIPPED', reason: 'Permission vessel_crew.assign ou accès au navire manquant' };
    }
    // ADM-070 : une affectation ne doit pas rendre visible une fiche hors périmètre (même règle que la planification)
    if (!(await isMemberVisible(tx, ctx, memberId))) {
      return { result: 'SKIPPED', reason: 'Fiche hors de votre périmètre (ADM-070) : affectation non créée' };
    }
    const join = dateFromYmd(a.joinDate)!;
    const exists = await tx.crewAssignment.findFirst({
      where: { memberId, vesselId: n.vesselId, OR: [{ actualJoinDate: join }, { plannedJoinDate: join }] },
      select: { id: true },
    });
    if (exists) return { result: 'SKIPPED', assignmentId: exists.id, reason: 'Affectation déjà enregistrée' };
    const today = todayYmd();
    const status = a.signOffDate && a.signOffDate <= today ? 'COMPLETED' : a.joinDate <= today ? 'ONBOARD' : 'PLANNED';
    if (status === 'ONBOARD') {
      const onboard = await tx.crewAssignment.count({ where: { memberId, status: 'ONBOARD' } });
      if (onboard) return { result: 'SKIPPED', reason: 'Marin déjà embarqué sur un navire : affectation non créée' };
    }
    if (status !== 'COMPLETED') {
      const active = await tx.crewAssignment.count({ where: { memberId, vesselId: n.vesselId, status: { in: ['PLANNED', 'ONBOARD'] } } });
      if (active) return { result: 'SKIPPED', reason: 'Affectation active déjà présente sur ce navire' };
    }
    const member = await tx.member.findUniqueOrThrow({ where: { id: memberId }, select: { rank: true } });
    const signOff = dateFromYmd(a.signOffDate);
    const created = await tx.crewAssignment.create({
      data: {
        memberId,
        vesselId: n.vesselId,
        rank: n.member.rank ?? member.rank ?? 'Non renseigné',
        status,
        plannedJoinDate: join,
        actualJoinDate: status === 'PLANNED' ? null : join,
        plannedSignOffDate: status === 'COMPLETED' ? null : signOff,
        actualSignOffDate: status === 'COMPLETED' ? signOff : null,
        notes: `Importée (Excel) — feuille ${row.sheetName} ligne ${row.rowNumber}`,
        createdById: ctx.userId,
      },
    });
    await this.audit.record(
      ctx,
      {
        action: 'crew_assignment.imported',
        module: 'fleet',
        entityType: 'crew_assignment',
        entityId: created.id,
        vesselId: n.vesselId,
        after: { memberId, status, joinDate: a.joinDate, signOffDate: a.signOffDate },
        metadata: { importJobId: row.jobId, importRowId: row.id },
      },
      tx,
    );
    if (status !== 'COMPLETED') await this.crew.syncMemberStatus(tx, ctx, memberId, { assignmentId: created.id, event: 'IMPORTED' });
    return { result: 'CREATED', assignmentId: created.id, status };
  }

  /** Notifie les validateurs éligibles des demandes de certificats créées par l'import (jamais le demandeur). */
  private async notifyValidators(ctx: AuthContext, jobId: string, count: number, codes: Set<string>) {
    try {
      const validators = await this.prisma.certificateTypeValidator.findMany({
        where: { type: { code: { in: [...codes] } } },
        select: { principalType: true, principalId: true },
      });
      const principals = validators.map((v) => ({ type: v.principalType, id: v.principalId }));
      const userIds = principals.length ? undefined : await this.access.usersWithPermission('certificates.approve', null);
      this.notifications.notifyAsync({
        principals,
        userIds,
        type: 'certificate.approval_requested',
        title: `Import Members : ${count} demande(s) de certificat à approuver`,
        body: `Types : ${[...codes].sort().join(', ')}. Données importées depuis Excel, scans à ajouter ultérieurement.`,
        module: 'certificates',
        entityType: 'import_job',
        entityId: jobId,
        link: '/certificates/approvals',
        priority: 'NORMAL',
        dedupeKey: `member-import:${jobId}:${count}:${Date.now()}`,
        requiredPermission: 'certificates.approve',
        excludeUserIds: [ctx.userId],
      });
    } catch (e) {
      this.logger.warn(`Notification des validateurs impossible pour l'import ${jobId} : ${String(e)}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Annulation & rapport
  // ---------------------------------------------------------------------------

  async cancel(ctx: AuthContext, id: string, reason?: string) {
    const job = await this.loadOwn(ctx, id);
    if (job.status === 'CANCELLED') throw Errors.alreadyProcessed('Import déjà annulé');
    if (job.phase === 'COMMITTING' && !this.isStale(job)) throw Errors.invalidState('Validation en cours : annulation impossible');
    const updated = await this.prisma.$transaction(async (tx) => {
      const j = await tx.importJob.update({ where: { id }, data: { status: 'CANCELLED', finishedAt: new Date() } });
      await this.audit.record(ctx, { action: 'member_import.cancelled', module: 'members', entityType: 'import_job', entityId: id, metadata: { reason, phase: job.phase } }, tx);
      return j;
    });
    return this.presentJob(updated);
  }

  /** Rapport XLSX (résumé, lignes, certificats) stocké en EXPORT puis lien signé éphémère. */
  async report(ctx: AuthContext, id: string) {
    const job = await this.loadOwn(ctx, id);
    const opts = job.options as unknown as JobOptions;
    const rows = await this.prisma.importRow.findMany({ where: { jobId: id }, orderBy: [{ sheetName: 'asc' }, { rowNumber: 'asc' }] });
    const users = await this.prisma.user.findMany({
      where: { id: { in: [job.createdById, ...rows.map((r) => r.decidedById).filter((x): x is string => !!x)] } },
      select: { id: true, displayName: true },
    });
    const userName = (uid: string | null) => (uid ? users.find((u) => u.id === uid)?.displayName ?? uid : '');
    const file = await this.prisma.storedFile.findUnique({ where: { id: job.sourceFileId }, select: { originalName: true, sha256: true } });
    const issues = (v: unknown) => ((v ?? []) as RowIssue[]).map((i) => (i.column ? `[${i.column}] ${i.message}` : i.message)).join(' | ');

    const statusCounts: Record<string, number> = {};
    rows.forEach((r) => (statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1));
    const summary = (job.summary ?? {}) as { preview?: Record<string, unknown>; commit?: Record<string, unknown> };
    const summaryRows: Record<string, unknown>[] = [
      { key: 'Import', value: job.id },
      { key: 'Fichier source', value: file?.originalName ?? job.sourceFileId },
      { key: 'SHA-256', value: file?.sha256 ?? '' },
      { key: 'Créé par', value: userName(job.createdById) },
      { key: 'Créé le', value: job.createdAt.toISOString() },
      { key: 'Statut', value: job.status },
      { key: 'Phase', value: job.phase },
      { key: 'Terminé le', value: job.finishedAt?.toISOString() ?? '' },
      { key: 'Feuilles importées', value: (opts.mapping ?? []).filter((m) => m.include).map((m) => m.name).join(', ') },
      { key: 'Création des affectations', value: opts.createAssignments ? 'Oui' : 'Non' },
      ...Object.entries(statusCounts).map(([k, v]) => ({ key: `Lignes ${k}`, value: v })),
      ...((summary as { commitRuns?: Record<string, unknown>[] }).commitRuns ?? []).flatMap((runInfo, i) =>
        Object.entries(runInfo)
          .filter(([k]) => k !== 'by')
          .map(([k, v]) => ({ key: `Commit n°${i + 1} — ${k}`, value: v as unknown })),
      ),
      ...(job.errorMessage ? [{ key: 'Erreur', value: job.errorMessage }] : []),
    ];

    // ADM-070 : le rapport ne détaille que les fiches existantes visibles du demandeur
    const candidateIds = rows.flatMap((r) =>
      ((r.duplicateCandidates ?? []) as unknown as StoredCandidate[]).flatMap((c) => (c.kind === 'MEMBER' ? [c.memberId] : [])),
    );
    const visibleIds = new Set(
      candidateIds.length
        ? (await this.prisma.member.findMany({ where: { AND: [{ id: { in: [...new Set(candidateIds)] } }, memberVisibilityWhere(ctx)] }, select: { id: true } })).map((m) => m.id)
        : [],
    );
    const lineRows = rows.map((r) => {
      const n = (r.normalized ?? { member: {} }) as unknown as StoredNormalized;
      const stored = (r.duplicateCandidates ?? []) as unknown as StoredCandidate[];
      const { visible: shown, hiddenMatch } = partitionCandidates(
        stored.filter((c): c is Extract<StoredCandidate, { kind: 'MEMBER' }> => c.kind === 'MEMBER'),
        visibleIds,
      );
      const cands = [
        ...shown.map((c) => `fiche ${c.memberId.slice(0, 8)} (${c.score} : ${c.reasons.join('+')})`),
        ...(hiddenMatch ? ['fiche existante hors périmètre (contacter Crewing)'] : []),
        ...stored.flatMap((c) => (c.kind === 'ROW' ? [`ligne ${c.sheetName}#${c.rowNumber} (${c.score} : ${c.reasons.join('+')})`] : [])),
      ].join(' ; ');
      return {
        sheet: r.sheetName,
        row: r.rowNumber,
        lastName: n.member?.lastName ?? '',
        firstName: n.member?.firstName ?? '',
        amcRef: n.member?.amcRef ?? '',
        birthDate: n.member?.birthDate ?? '',
        passport: n.member?.passportNumber ?? '',
        status: r.status,
        decision: r.decision,
        decidedBy: userName(r.decidedById),
        decidedAt: r.decidedAt?.toISOString() ?? '',
        reason: n.decisionReason ?? '',
        member: r.appliedEntityId ?? r.decisionTargetId ?? '',
        action: n.outcome?.action ?? '',
        changed: n.outcome?.changedFields.join(', ') ?? '',
        duplicates: cands,
        errors: issues(r.errors),
        warnings: issues(r.warnings),
        message: r.errorMessage ?? '',
      };
    });
    const certRows = rows.flatMap((r) => {
      const n = (r.normalized ?? { member: {}, certificates: [] }) as unknown as StoredNormalized;
      return (n.certificates ?? []).map((c) => {
        const o = n.outcome?.certificates.find((x) => x.code === c.code);
        return {
          sheet: r.sheetName,
          row: r.rowNumber,
          name: `${n.member?.lastName ?? ''} ${n.member?.firstName ?? ''}`.trim(),
          code: c.code,
          number: c.number ?? '',
          expiry: c.expiryKind === 'DATED' ? c.expiryOn : c.expiryKind === 'UNLIMITED' ? 'PERMANENT' : 'INCONNUE',
          issued: c.issuedOn ?? '',
          result: o ? (o.result === 'REQUEST_CREATED' ? 'Demande créée (en attente d’approbation)' : `Ignoré : ${o.reason ?? ''}`) : r.status === 'APPLIED' ? '' : 'Non appliqué',
        };
      });
    });

    const buffer = await this.excel.writeXlsx([
      { name: 'Résumé', columns: [{ header: 'Élément', key: 'key', width: 34 }, { header: 'Valeur', key: 'value', width: 70 }], rows: summaryRows },
      {
        name: 'Lignes',
        columns: [
          { header: 'Feuille', key: 'sheet', width: 22 },
          { header: 'Ligne', key: 'row', width: 8 },
          { header: 'Nom', key: 'lastName' },
          { header: 'Prénom', key: 'firstName' },
          { header: 'Matricule', key: 'amcRef', width: 14 },
          { header: 'Naissance', key: 'birthDate', width: 12 },
          { header: 'Passeport', key: 'passport', width: 14 },
          { header: 'Statut', key: 'status', width: 20 },
          { header: 'Décision', key: 'decision', width: 12 },
          { header: 'Décidé par', key: 'decidedBy', width: 24 },
          { header: 'Décidé le', key: 'decidedAt', width: 22 },
          { header: 'Motif', key: 'reason', width: 30 },
          { header: 'Fiche Member', key: 'member', width: 38 },
          { header: 'Action', key: 'action', width: 10 },
          { header: 'Champs écrits', key: 'changed', width: 40 },
          { header: 'Doublons suspectés', key: 'duplicates', width: 60 },
          { header: 'Erreurs', key: 'errors', width: 60 },
          { header: 'Avertissements', key: 'warnings', width: 60 },
          { header: 'Message', key: 'message', width: 50 },
        ],
        rows: lineRows,
      },
      {
        name: 'Certificats',
        columns: [
          { header: 'Feuille', key: 'sheet', width: 22 },
          { header: 'Ligne', key: 'row', width: 8 },
          { header: 'Member', key: 'name', width: 30 },
          { header: 'Type', key: 'code', width: 10 },
          { header: 'Numéro', key: 'number', width: 20 },
          { header: 'Expiration', key: 'expiry', width: 14 },
          { header: 'Délivrance', key: 'issued', width: 14 },
          { header: 'Résultat', key: 'result', width: 60 },
        ],
        rows: certRows,
      },
    ]);
    const fileName = `rapport-import-members-${job.createdAt.toISOString().slice(0, 10)}-${job.id.slice(0, 8)}.xlsx`;
    const stored = await this.files.storeGenerated(
      buffer,
      fileName,
      'EXCEL',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'EXPORT',
      null,
      ctx.userId,
      { type: OWNER_IMPORT_REPORT, id: job.id },
    );
    await this.audit.record(ctx, {
      action: 'member_import.report_generated',
      module: 'members',
      entityType: 'import_job',
      entityId: id,
      metadata: { fileId: stored.id, rows: rows.length },
    });
    const link = await this.files.issueLink(ctx, stored, 'download', {
      module: 'members',
      entityType: 'import_job',
      entityId: job.id,
      vesselId: null,
      downloadName: fileName,
      forceAttachment: true,
    });
    return { fileId: stored.id, ...link };
  }

  // ---------------------------------------------------------------------------

  /**
   * Un import (lignes brutes : passeports, dates de naissance…) n'est accessible qu'à son créateur :
   * 404 pour tout autre utilisateur, même titulaire de members.import (isolation des jobs).
   */
  private async loadOwn(ctx: AuthContext, id: string): Promise<ImportJob> {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job || job.kind !== 'MEMBERS' || job.createdById !== ctx.userId) throw Errors.notFound('Import');
    if (job.vesselId) this.access.assertVesselAccess(ctx, job.vesselId);
    return job;
  }

  /** Création d'une fiche par import : members.create + données protégées => members.personal_fields.manage. */
  private assertCanCreateMember(ctx: AuthContext, member: NormalizedMember) {
    if (!can(ctx, 'members.create')) {
      throw Errors.forbidden('Création de fiche par import : permission members.create requise', { permission: 'members.create' });
    }
    const prot = changedProtectedFields({}, member as Record<string, unknown>);
    if (prot.length && !can(ctx, 'members.personal_fields.manage')) {
      throw Errors.forbidden('Données personnelles protégées : permission members.personal_fields.manage requise', { fields: prot });
    }
  }

  private assertCanImportCertificates(ctx: AuthContext, certificates: ImportedCertificate[] | undefined) {
    if (certificates?.length && !can(ctx, 'certificates.create')) {
      throw Errors.forbidden('Import des certificats : permission certificates.create requise', { permission: 'certificates.create' });
    }
  }

  private assertNotCancelled(job: ImportJob) {
    if (job.status === 'CANCELLED') throw Errors.invalidState('Import annulé');
  }

  private isStale(job: ImportJob): boolean {
    return !!job.startedAt && job.startedAt.getTime() < Date.now() - STALE_COMMIT_MS;
  }

  private async assertVessel(ctx: AuthContext, vesselId: string) {
    this.access.assertVesselAccess(ctx, vesselId);
    if (!(await this.prisma.vessel.count({ where: { id: vesselId } }))) throw Errors.notFound('Navire');
  }

  private async certificateTypes(): Promise<Map<string, CertTypeRef>> {
    const types = await this.prisma.certificateType.findMany({
      where: { subjectKind: 'MEMBER', isActive: true },
      select: { id: true, code: true, name: true },
    });
    return new Map(types.map((t) => [t.code.toUpperCase(), t]));
  }

  /** Champs protégés modifiés par une mise à jour importée : members.personal_fields.manage requis. */
  private assertProtectedDiff(ctx: AuthContext, diff: FieldDiff[]) {
    const prot = diff.filter((d) => d.changed && d.protected).map((d) => d.field);
    if (prot.length && !can(ctx, 'members.personal_fields.manage')) {
      throw Errors.forbidden('Données personnelles protégées : permission members.personal_fields.manage requise', { fields: prot });
    }
  }

  private async assertAmcRefFree(diff: FieldDiff[], memberId: string, db: Tx | PrismaService = this.prisma) {
    const ref = diff.find((d) => d.field === 'amcRef' && d.changed)?.imported as string | undefined;
    if (!ref) return;
    const other = await db.member.findFirst({ where: { amcRef: { equals: ref, mode: 'insensitive' }, id: { not: memberId } }, select: { id: true } });
    // Pas d'identifiant en retour : la fiche concurrente peut être hors périmètre (ADM-070)
    if (other) throw Errors.duplicate('Matricule AMC déjà attribué à une autre fiche');
  }

  /** Index en mémoire des fiches candidates par clé normalisée (évite un scoring N x M). */
  private indexRecords(records: IdentityRecord[]): Map<string, IdentityRecord[]> {
    const idx = new Map<string, IdentityRecord[]>();
    const add = (k: string, r: IdentityRecord) => {
      const l = idx.get(k);
      if (l) l.push(r);
      else idx.set(k, [r]);
    };
    for (const r of records) {
      const k = identityKeys(r);
      if (k.ref) add(`R:${k.ref}`, r);
      if (k.passport) add(`P:${k.passport}`, r);
      if (k.book) add(`S:${k.book}`, r);
      k.namePairs.slice(0, 1).forEach((p) => add(`N:${p}`, r));
      if (k.birthDate) add(`D:${k.birthDate}`, r);
    }
    return idx;
  }

  private lookup(idx: Map<string, IdentityRecord[]>, probe: MemberIdentity): IdentityRecord[] {
    const k = identityKeys(probe);
    const keys = [k.ref && `R:${k.ref}`, k.passport && `P:${k.passport}`, k.book && `S:${k.book}`, ...k.namePairs.map((p) => `N:${p}`), k.birthDate && `D:${k.birthDate}`];
    const seen = new Map<string, IdentityRecord>();
    for (const key of keys) if (key) (idx.get(key) ?? []).forEach((r) => seen.set(r.id, r));
    return [...seen.values()];
  }
}

