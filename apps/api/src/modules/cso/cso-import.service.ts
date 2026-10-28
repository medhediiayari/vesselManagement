import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { CsoCategory, CsoDocument, CsoFolder, CsoLibrary, CsoVersion, ImportJob, ImportRow, Prisma, StoredFile } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AppError, Errors } from '../../common/errors';
import { sha256Hex } from '../../common/utils/crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService } from '../audit/audit.service';
import { ExcelService } from '../documents/excel.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { inspectFile } from '../files/file-inspector';
import { FilesService } from '../files/files.service';
import { SettingsService } from '../settings/settings.service';
import { CsoAccessService, OWNER_CSO_IMPORT, OWNER_CSO_VERSION } from './cso-access.service';
import { DEFAULT_ZIP_LIMITS, REFERENCE_RE, ZipLimits, normalizeReference } from './cso-rules';
import { walkZip } from './cso-zip-reader';
import { CsoWorkflowService } from './cso-workflow.service';
import type { CreateImportJobDto, ImportDecisionsDto, ImportRowsQuery } from './cso.dto';

/** Reprise : un commit « RUNNING » sans activité depuis ce délai peut être repris. */
const STALE_COMMIT_MS = 15 * 60_000;

interface NormalizedRow {
  path: string;
  folderSegments: string[];
  fileName: string;
  entryIndex: number | null;
  sha256: string | null;
  sizeBytes: number;
  kind: string | null;
  title: string;
  reference: string | null;
  categoryId: string | null;
  description: string | null;
  nextReviewOn: string | null;
  expiryOn: string | null;
}

interface DuplicateCandidate {
  documentId: string;
  reference: string | null;
  title: string;
  status: string;
  folderName: string | null;
  versionCount: number;
  currentVersionNo: number | null;
  reasons: ('REFERENCE' | 'SAME_NAME_IN_FOLDER' | 'CONTENT_HASH')[];
}

interface MetaRow {
  rowNumber: number;
  path: string | null;
  title: string | null;
  reference: string | null;
  category: string | null;
  description: string | null;
  nextReviewOn: unknown;
  expiryOn: unknown;
}

const HEADER_ALIASES: Record<keyof Omit<MetaRow, 'rowNumber'>, string[]> = {
  path: ['CHEMIN', 'PATH', 'FICHIER', 'FILE', 'FILENAME', 'FILE NAME', 'NOM DU FICHIER', 'NOM FICHIER'],
  title: ['TITRE', 'TITLE', 'INTITULE'],
  reference: ['REFERENCE', 'REF'],
  category: ['CATEGORIE', 'CATEGORY', 'CODE CATEGORIE', 'TYPE'],
  description: ['DESCRIPTION', 'OBJET'],
  nextReviewOn: ['PROCHAINE REVISION', 'NEXT REVIEW', 'REVISION', 'DATE DE REVISION', 'DATE REVISION'],
  expiryOn: ['EXPIRATION', 'EXPIRY', 'EXPIRY DATE', 'DATE D EXPIRATION', 'DATE EXPIRATION'],
};

const normKey = (p: string) => p.replace(/^\.?\/+/, '').replace(/\/+/g, '/').trim().toLowerCase();

/**
 * Import en masse CSO (CSO-033/034, CDC §5.5) : fichier unique ou ZIP arborescent + Excel de
 * métadonnées -> lignes de prévisualisation avec détection de doublons (référence, nom dans le
 * dossier, empreinte SHA-256, versions existantes) -> décisions opérateur IGNORE /
 * CREATE_INDEPENDENT / SUBMIT_NEW_VERSION -> commit idempotent et reprenable (lignes APPLIED
 * jamais rejouées). L'import ne publie jamais : toute version créée est PENDING_APPROVAL.
 */
@Injectable()
export class CsoImportService implements OnModuleInit {
  private readonly logger = new Logger('CsoImport');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly csoAccess: CsoAccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly excel: ExcelService,
    private readonly settings: SettingsService,
    private readonly workflow: CsoWorkflowService,
  ) {}

  /** Fichiers source d'un import : accessibles au seul opérateur de l'import (cso.import). */
  onModuleInit(): void {
    this.registry.register(OWNER_CSO_IMPORT, async (ctx, file) => {
      const job = await this.prisma.importJob.findUnique({ where: { id: file.ownerId! } });
      if (!job || job.createdById !== ctx.userId) throw Errors.forbidden('Fichier d’import réservé à son opérateur');
      this.access.assertCan(ctx, 'cso.import');
      return { module: 'cso', entityType: 'cso_import_job', entityId: job.id, vesselId: job.vesselId };
    });
  }

  private async limits(): Promise<ZipLimits> {
    const maxEntryBytes = await this.settings.get('files.maxUploadBytes');
    return { ...DEFAULT_ZIP_LIMITS, maxEntryBytes: Math.min(Number(maxEntryBytes) || DEFAULT_ZIP_LIMITS.maxEntryBytes, DEFAULT_ZIP_LIMITS.maxEntryBytes) };
  }

  // ---------------------------------------------------------------------------
  // Création + analyse (prévisualisation)
  // ---------------------------------------------------------------------------

  async create(ctx: AuthContext, dto: CreateImportJobDto) {
    const { folder, library } = await this.csoAccess.assertFolder(ctx, dto.targetFolderId, ['folder_create', 'edit'], { requireActive: true });
    const source = await this.ownUpload(ctx, dto.sourceFileId);
    const sourceOk = (source.context === 'IMPORT_SOURCE' && source.kind === 'ZIP') || source.context === 'CSO_DOCUMENT';
    if (!sourceOk) throw Errors.validation('Source attendue : ZIP (contexte IMPORT_SOURCE) ou document (contexte CSO_DOCUMENT)');
    let metadata: StoredFile | null = null;
    if (dto.metadataFileId) {
      metadata = await this.ownUpload(ctx, dto.metadataFileId);
      if (metadata.context !== 'IMPORT_SOURCE' || metadata.kind !== 'EXCEL') throw Errors.validation('Métadonnées attendues : classeur Excel (contexte IMPORT_SOURCE)');
    }
    const defaultCategory = await this.workflow.categoryFor(dto.defaultCategoryId, library);

    const job = await this.prisma.$transaction(async (tx) => {
      const j = await tx.importJob.create({
        data: {
          kind: 'CSO_DOCUMENTS',
          status: 'RUNNING',
          phase: 'MAPPING',
          sourceFileId: source.id,
          metadataFileId: metadata?.id ?? null,
          vesselId: library.vesselId,
          targetFolderId: folder.id,
          options: { defaultCategoryId: defaultCategory?.id ?? null },
          createdById: ctx.userId,
          startedAt: new Date(),
        },
      });
      const owner = { type: OWNER_CSO_IMPORT, id: j.id, contexts: ['IMPORT_SOURCE', 'CSO_DOCUMENT'] as const, vesselId: library.vesselId };
      await this.files.attach(ctx, source.id, { ...owner, contexts: [...owner.contexts] }, tx);
      if (metadata) await this.files.attach(ctx, metadata.id, { ...owner, contexts: ['IMPORT_SOURCE'] }, tx);
      await this.audit.record(
        ctx,
        {
          action: 'cso.import.created',
          module: 'cso',
          entityType: 'cso_import_job',
          entityId: j.id,
          vesselId: library.vesselId,
          after: { sourceFileId: source.id, sourceName: source.originalName, metadataFileId: metadata?.id ?? null, targetFolderId: folder.id },
        },
        tx,
      );
      return j;
    });

    try {
      await this.analyze(ctx, job, folder, library, defaultCategory);
    } catch (e) {
      const message = e instanceof AppError ? (e.getResponse() as { message?: string }).message ?? 'Analyse impossible' : 'Analyse impossible';
      await this.prisma.importJob.update({ where: { id: job.id }, data: { status: 'FAILED', errorMessage: message.slice(0, 1000), finishedAt: new Date() } });
      await this.audit.record(ctx, { action: 'cso.import.analysis_failed', module: 'cso', entityType: 'cso_import_job', entityId: job.id, vesselId: library.vesselId, result: 'FAILURE', metadata: { message } });
      if (e instanceof AppError) throw e;
      this.logger.error(`Analyse import ${job.id} : ${String(e)}`);
      throw Errors.business('Analyse de l’import impossible');
    }
    return this.get(ctx, job.id);
  }

  private async ownUpload(ctx: AuthContext, fileId: string): Promise<StoredFile> {
    const f = await this.files.getOrThrow(fileId);
    if (f.uploadedById !== ctx.userId) throw Errors.forbidden('Fichier déposé par un autre utilisateur');
    if (f.ownerId) throw Errors.conflict('Fichier déjà rattaché');
    return f;
  }

  private async analyze(ctx: AuthContext, job: ImportJob, target: CsoFolder, library: CsoLibrary, defaultCategory: CsoCategory | null) {
    const source = await this.files.getOrThrow(job.sourceFileId);
    const meta = job.metadataFileId ? this.readMetadata(await this.files.readBuffer(await this.files.getOrThrow(job.metadataFileId))) : [];
    const metaByPath = new Map<string, MetaRow>();
    const metaByName = new Map<string, MetaRow[]>();
    for (const m of meta) {
      if (!m.path) continue;
      metaByPath.set(normKey(m.path), m);
      const base = normKey(m.path).split('/').pop()!;
      metaByName.set(base, [...(metaByName.get(base) ?? []), m]);
    }
    const usedMeta = new Set<number>();

    // 1. Entrées (ZIP ou fichier unique) + inspection du contenu réel
    interface Entry {
      index: number | null;
      segments: string[];
      size: number;
      compressed: number;
      sha256: string | null;
      kind: string | null;
      error: string | null;
    }
    const entries: Entry[] = [];
    let ignored = 0;
    let directories = 0;
    if (source.kind === 'ZIP') {
      const res = await walkZip(await this.files.readBuffer(source), await this.limits(), async (info, read) => {
        if (info.entryError) {
          entries.push({ index: info.index, segments: info.segments, size: info.uncompressedSize, compressed: info.compressedSize, sha256: null, kind: null, error: info.entryError });
          return;
        }
        const buf = await read();
        let kind: string | null = null;
        let error: string | null = null;
        try {
          kind = (await inspectFile(buf, info.segments[info.segments.length - 1], 'CSO_DOCUMENT')).kind;
        } catch (e) {
          error = e instanceof AppError ? ((e.getResponse() as { message?: string }).message ?? 'Fichier refusé') : 'Fichier refusé';
        }
        entries.push({ index: info.index, segments: info.segments, size: buf.length, compressed: info.compressedSize, sha256: sha256Hex(buf), kind, error });
      });
      ignored = res.ignored;
      directories = res.directories.length;
    } else {
      entries.push({ index: null, segments: [source.originalName], size: Number(source.sizeBytes), compressed: Number(source.sizeBytes), sha256: source.sha256, kind: source.kind, error: null });
    }
    if (!entries.length) throw Errors.fileRejected('Archive vide : aucun fichier importable');

    // 2. Normalisation + métadonnées + contrôles
    const categories = await this.prisma.csoCategory.findMany({ where: { isActive: true } });
    const rows: { raw: Prisma.InputJsonValue; normalized: NormalizedRow; errors: string[]; warnings: string[] }[] = [];
    const seenRefs = new Map<string, number>();
    const seenHashes = new Map<string, number>();
    for (const [i, e] of entries.entries()) {
      const path = e.segments.join('/');
      const fileName = e.segments[e.segments.length - 1];
      const errors: string[] = e.error ? [e.error] : [];
      const warnings: string[] = [];
      let m = metaByPath.get(normKey(path));
      if (!m) {
        const byName = metaByName.get(fileName.toLowerCase());
        if (byName?.length === 1) m = byName[0];
        else if (byName && byName.length > 1) warnings.push('Plusieurs lignes Excel pour ce nom de fichier : préciser le chemin');
      }
      if (m) usedMeta.add(m.rowNumber);

      const folderSegments = e.segments.slice(0, -1).map((s) => s.trim());
      if (folderSegments.some((s) => !s || s.length > 200 || /[\u0000-\u001f\u007f]/.test(s))) errors.push('Nom de dossier invalide dans le chemin');

      let categoryId = defaultCategory?.id ?? null;
      if (m?.category) {
        const wanted = m.category.trim().toLowerCase();
        const cat = categories.find((c) => c.code.toLowerCase() === wanted || c.name.toLowerCase() === wanted);
        if (!cat) errors.push(`Catégorie « ${m.category} » inconnue ou désactivée`);
        else if (cat.scope === 'VESSEL' && cat.vesselId !== library.vesselId) errors.push(`Catégorie « ${cat.name} » réservée à un autre navire`);
        else categoryId = cat.id;
      }
      const category = categories.find((c) => c.id === categoryId) ?? null;

      let reference = m?.reference ? normalizeReference(m.reference) : null;
      if (reference && !REFERENCE_RE.test(reference)) {
        errors.push('Référence invalide');
        reference = null;
      }
      if (!reference && category?.referenceMode === 'MANUAL') errors.push('Référence obligatoire (catégorie en mode manuel)');
      if (reference) {
        const prev = seenRefs.get(reference.toLowerCase());
        if (prev !== undefined) errors.push(`Référence en double dans l’import (ligne ${prev})`);
        else seenRefs.set(reference.toLowerCase(), i + 1);
      }
      const dates: Record<'nextReviewOn' | 'expiryOn', string | null> = { nextReviewOn: null, expiryOn: null };
      for (const k of ['nextReviewOn', 'expiryOn'] as const) {
        const parsed = ExcelService.parseDate(m?.[k] ?? null);
        if (parsed.kind === 'DATE') dates[k] = parsed.value;
        else if (parsed.kind === 'INVALID') errors.push(`Date invalide (${k}) : ${parsed.raw}`);
        else if (parsed.kind === 'UNLIMITED') warnings.push(`${k} « permanent » : laissé vide`);
      }
      const description = m?.description ?? null;
      for (const f of category?.requiredFields ?? []) {
        if (f === 'description' && !description) errors.push('Description obligatoire pour cette catégorie');
        if ((f === 'nextReviewOn' || f === 'expiryOn') && !dates[f]) errors.push(`${f} obligatoire pour cette catégorie`);
        if (f === 'reference' && !reference && category?.referenceMode !== 'AUTO') errors.push('Référence obligatoire pour cette catégorie');
      }
      if (e.sha256) {
        const prev = seenHashes.get(e.sha256);
        if (prev !== undefined) warnings.push(`Contenu identique à la ligne ${prev} de l’import`);
        else seenHashes.set(e.sha256, i + 1);
      }
      const title = (m?.title ?? fileName.replace(/\.[A-Za-z0-9]{1,10}$/, '')).slice(0, 300) || fileName;
      rows.push({
        raw: { path, sizeBytes: e.size, compressedSize: e.compressed, metadataRow: m?.rowNumber ?? null },
        normalized: {
          path,
          folderSegments,
          fileName,
          entryIndex: e.index,
          sha256: e.sha256,
          sizeBytes: e.size,
          kind: e.kind,
          title,
          reference,
          categoryId,
          description,
          nextReviewOn: dates.nextReviewOn,
          expiryOn: dates.expiryOn,
        },
        errors,
        warnings,
      });
    }

    // 3. Doublons (uniquement des documents visibles par l'opérateur ; jamais de fuite)
    const withDupes = await this.detectDuplicates(ctx, target, rows);

    // 4. Persistance des lignes + passage en prévisualisation
    const counts = { VALID: 0, INVALID: 0, DUPLICATE_SUSPECTED: 0 };
    await this.prisma.$transaction(
      async (tx) => {
        const data = withDupes.map((r, i) => {
          const status = r.errors.length ? 'INVALID' : r.candidates.length ? 'DUPLICATE_SUSPECTED' : 'VALID';
          counts[status]++;
          return {
            jobId: job.id,
            sheetName: source.kind === 'ZIP' ? 'ZIP' : 'FILE',
            rowNumber: i + 1,
            raw: r.raw,
            normalized: r.normalized as unknown as Prisma.InputJsonValue,
            errors: r.errors.length ? r.errors : undefined,
            warnings: r.warnings.length ? r.warnings : undefined,
            duplicateCandidates: r.candidates.length ? (r.candidates as unknown as Prisma.InputJsonValue) : undefined,
            status: status as ImportRow['status'],
            decision: (status === 'VALID' ? 'CREATE' : 'PENDING') as ImportRow['decision'],
          };
        });
        for (let i = 0; i < data.length; i += 500) await tx.importRow.createMany({ data: data.slice(i, i + 500) });
        const summary = {
          entries: entries.length,
          directories,
          ignoredSystemEntries: ignored,
          valid: counts.VALID,
          invalid: counts.INVALID,
          duplicatesSuspected: counts.DUPLICATE_SUSPECTED,
          metadataRows: meta.length,
          unmatchedMetadataRows: meta.filter((m) => !usedMeta.has(m.rowNumber)).map((m) => m.rowNumber),
        };
        await tx.importJob.update({ where: { id: job.id }, data: { phase: 'PREVIEW_READY', status: 'QUEUED', summary } });
        await this.audit.record(
          ctx,
          { action: 'cso.import.analyzed', module: 'cso', entityType: 'cso_import_job', entityId: job.id, vesselId: job.vesselId, metadata: summary },
          tx,
        );
      },
      { timeout: 60_000 },
    );
  }

  private readMetadata(buffer: Buffer): MetaRow[] {
    const sheets = this.excel.readWorkbook(buffer);
    const sheet = sheets.find((s) => s.rows.length > 1);
    if (!sheet) return [];
    const headerIdx = this.excel.detectHeaderRow(sheet.rows, 2);
    const headers = sheet.rows[headerIdx].map((h) => ExcelService.normalizeHeader(h).replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim());
    const col = (k: keyof typeof HEADER_ALIASES) => headers.findIndex((h) => HEADER_ALIASES[k].includes(h));
    const idx = Object.fromEntries((Object.keys(HEADER_ALIASES) as (keyof typeof HEADER_ALIASES)[]).map((k) => [k, col(k)])) as Record<keyof typeof HEADER_ALIASES, number>;
    if (idx.path < 0) throw Errors.validation('Classeur de métadonnées : colonne « Chemin » / « Fichier » introuvable');
    const out: MetaRow[] = [];
    for (let r = headerIdx + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r];
      const get = (k: keyof typeof HEADER_ALIASES) => (idx[k] >= 0 ? row[idx[k]] : null);
      const path = ExcelService.cellText(get('path'));
      if (!path) continue;
      out.push({
        rowNumber: r + 1,
        path: path.replace(/\\/g, '/'),
        title: ExcelService.cellText(get('title')),
        reference: ExcelService.cellText(get('reference')),
        category: ExcelService.cellText(get('category')),
        description: ExcelService.cellText(get('description')),
        nextReviewOn: get('nextReviewOn'),
        expiryOn: get('expiryOn'),
      });
    }
    return out;
  }

  private async detectDuplicates<T extends { normalized: NormalizedRow; errors: string[] }>(ctx: AuthContext, target: CsoFolder, rows: T[]) {
    const refs = rows.map((r) => r.normalized.reference).filter((x): x is string => !!x);
    const hashes = rows.map((r) => r.normalized.sha256).filter((x): x is string => !!x);
    const [byRef, hashFiles] = await Promise.all([
      refs.length ? this.prisma.csoDocument.findMany({ where: { OR: refs.map((r) => ({ reference: { equals: r, mode: 'insensitive' as const } })) } }) : [],
      hashes.length ? this.prisma.storedFile.findMany({ where: { sha256: { in: hashes }, ownerType: OWNER_CSO_VERSION }, select: { sha256: true, ownerId: true } }) : [],
    ]);
    const hashVersions = hashFiles.length
      ? await this.prisma.csoVersion.findMany({ where: { id: { in: hashFiles.map((f) => f.ownerId!).filter(Boolean) } }, select: { id: true, documentId: true, fileId: true } })
      : [];
    const byHashDocs = hashVersions.length ? await this.prisma.csoDocument.findMany({ where: { id: { in: hashVersions.map((v) => v.documentId) } } }) : [];

    // Dossiers existants correspondant aux chemins (même nom, actifs) sous la cible
    const folderFor = new Map<string, string | null>();
    const resolveFolder = async (segments: string[]) => {
      const key = segments.join('/').toLowerCase();
      if (folderFor.has(key)) return folderFor.get(key)!;
      let parentId: string | null = target.id;
      for (const s of segments) {
        const child: { id: string } | null = await this.prisma.csoFolder.findFirst({
          where: { parentId, status: 'ACTIVE', name: { equals: s, mode: 'insensitive' } },
          select: { id: true },
        });
        parentId = child?.id ?? null;
        if (!parentId) break;
      }
      folderFor.set(key, parentId);
      return parentId;
    };
    const sameName: CsoDocument[] = [];
    const rowFolder: (string | null)[] = [];
    for (const r of rows) {
      const fid = await resolveFolder(r.normalized.folderSegments);
      rowFolder.push(fid);
      if (fid) {
        const docs = await this.prisma.csoDocument.findMany({
          where: { folderId: fid, title: { equals: r.normalized.title, mode: 'insensitive' }, status: { not: 'ARCHIVED' } },
        });
        sameName.push(...docs);
      }
    }

    const all = [...new Map([...byRef, ...byHashDocs, ...sameName].map((d) => [d.id, d])).values()];
    const { visible } = await this.csoAccess.filterVisibleDocuments(ctx, all);
    const visibleIds = new Set(visible.map((d) => d.id));
    const versionsAll = visible.length
      ? await this.prisma.csoVersion.findMany({ where: { documentId: { in: visible.map((d) => d.id) } }, select: { documentId: true, versionNo: true, id: true } })
      : [];
    const folders = await this.prisma.csoFolder.findMany({ where: { id: { in: visible.map((d) => d.folderId) } } });
    const fEff = await this.csoAccess.foldersAccess(ctx, folders);

    return rows.map((r, i) => {
      const n = r.normalized;
      const reasons = new Map<string, Set<DuplicateCandidate['reasons'][number]>>();
      const add = (id: string, reason: DuplicateCandidate['reasons'][number]) => reasons.set(id, (reasons.get(id) ?? new Set()).add(reason));
      if (n.reference) {
        for (const d of byRef.filter((x) => x.reference?.toLowerCase() === n.reference!.toLowerCase())) {
          if (visibleIds.has(d.id)) add(d.id, 'REFERENCE');
          else if (!r.errors.includes('Référence déjà utilisée')) r.errors.push('Référence déjà utilisée');
        }
      }
      if (n.sha256) {
        const fileOwners = hashFiles.filter((f) => f.sha256 === n.sha256).map((f) => f.ownerId);
        for (const v of hashVersions.filter((x) => fileOwners.includes(x.id))) if (visibleIds.has(v.documentId)) add(v.documentId, 'CONTENT_HASH');
      }
      if (rowFolder[i]) {
        for (const d of sameName.filter((x) => x.folderId === rowFolder[i] && x.title.toLowerCase() === n.title.toLowerCase())) {
          if (visibleIds.has(d.id)) add(d.id, 'SAME_NAME_IN_FOLDER');
        }
      }
      const candidates: DuplicateCandidate[] = [...reasons.entries()].map(([id, rs]) => {
        const d = visible.find((x) => x.id === id)!;
        const vs = versionsAll.filter((v) => v.documentId === id);
        const cur = vs.find((v) => v.id === d.currentVersionId);
        const f = folders.find((x) => x.id === d.folderId);
        return {
          documentId: d.id,
          reference: d.reference,
          title: d.title,
          status: d.status,
          folderName: f && this.csoAccess.folderVisible(f, fEff.get(f.id)!) ? f.name : null,
          versionCount: vs.length,
          currentVersionNo: cur?.versionNo ?? null,
          reasons: [...rs],
        };
      });
      return { ...r, candidates };
    });
  }

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  private async loadOwn(ctx: AuthContext, id: string): Promise<ImportJob> {
    const job = await this.prisma.importJob.findUnique({ where: { id } });
    if (!job || job.kind !== 'CSO_DOCUMENTS' || job.createdById !== ctx.userId) throw Errors.notFound('Import');
    if (job.vesselId) this.access.assertVesselAccess(ctx, job.vesselId);
    return job;
  }

  async list(ctx: AuthContext) {
    const jobs = await this.prisma.importJob.findMany({
      where: { kind: 'CSO_DOCUMENTS', createdById: ctx.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return jobs;
  }

  async get(ctx: AuthContext, id: string) {
    const job = await this.loadOwn(ctx, id);
    const grouped = await this.prisma.importRow.groupBy({ by: ['status'], where: { jobId: id }, _count: { _all: true } });
    const pendingDecisions = await this.prisma.importRow.count({ where: { jobId: id, status: 'DUPLICATE_SUSPECTED', decision: 'PENDING' } });
    return {
      ...job,
      rowCounts: Object.fromEntries(grouped.map((g) => [g.status, g._count._all])),
      pendingDecisions,
    };
  }

  async rows(ctx: AuthContext, id: string, q: ImportRowsQuery) {
    await this.loadOwn(ctx, id);
    const where = { jobId: id, ...(q.status ? { status: q.status } : {}) };
    const rows = await this.prisma.importRow.findMany({
      where,
      orderBy: [{ rowNumber: 'asc' }, { id: 'asc' }],
      take: q.limit + 1,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null, total: await this.prisma.importRow.count({ where }) };
  }

  // ---------------------------------------------------------------------------
  // Décisions opérateur (CSO-034)
  // ---------------------------------------------------------------------------

  async decide(ctx: AuthContext, id: string, dto: ImportDecisionsDto) {
    const job = await this.loadOwn(ctx, id);
    if (job.phase !== 'PREVIEW_READY' && !(job.phase === 'COMMITTING' && job.status !== 'RUNNING')) {
      throw Errors.invalidState('Import non modifiable dans cet état');
    }
    const rows = await this.prisma.importRow.findMany({ where: { jobId: id, id: { in: dto.items.map((i) => i.rowId) } } });
    for (const item of dto.items) {
      const row = rows.find((r) => r.id === item.rowId);
      if (!row) throw Errors.notFound('Ligne d’import');
      if (row.status === 'APPLIED' || row.status === 'SKIPPED') throw Errors.alreadyProcessed(`Ligne ${row.rowNumber} déjà traitée`);
      if (row.status === 'INVALID' && item.decision !== 'IGNORE') throw Errors.validation(`Ligne ${row.rowNumber} invalide : seule la décision IGNORE est possible`);
      if (item.decision === 'CREATE' && row.status === 'DUPLICATE_SUSPECTED') {
        throw Errors.validation(`Ligne ${row.rowNumber} : doublon suspecté, choisir IGNORE, CREATE_INDEPENDENT ou SUBMIT_NEW_VERSION`);
      }
      if (item.decision === 'SUBMIT_NEW_VERSION') {
        const candidates = (row.duplicateCandidates as unknown as DuplicateCandidate[] | null) ?? [];
        if (!candidates.some((c) => c.documentId === item.targetDocumentId)) {
          throw Errors.validation(`Ligne ${row.rowNumber} : le document cible doit figurer parmi les doublons proposés`);
        }
        await this.csoAccess.assertDocument(ctx, item.targetDocumentId!, ['edit'], { requireNotArchived: true });
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      for (const item of dto.items) {
        const row = rows.find((r) => r.id === item.rowId)!;
        const normalized = { ...(row.normalized as unknown as NormalizedRow) };
        if (item.title) normalized.title = item.title;
        if (item.reference !== undefined) normalized.reference = item.reference ? normalizeReference(item.reference) : null;
        await tx.importRow.update({
          where: { id: row.id },
          data: {
            decision: item.decision,
            decisionTargetId: item.decision === 'SUBMIT_NEW_VERSION' ? item.targetDocumentId! : null,
            decidedById: ctx.userId,
            decidedAt: now,
            normalized: normalized as unknown as Prisma.InputJsonValue,
            ...(row.status === 'FAILED' ? { errorMessage: null } : {}),
          },
        });
      }
      await this.audit.record(
        ctx,
        {
          action: 'cso.import.decisions',
          module: 'cso',
          entityType: 'cso_import_job',
          entityId: id,
          vesselId: job.vesselId,
          metadata: { items: dto.items.map((i) => ({ rowId: i.rowId, decision: i.decision, targetDocumentId: i.targetDocumentId ?? null })) },
        },
        tx,
      );
    });
    return this.get(ctx, id);
  }

  // ---------------------------------------------------------------------------
  // Commit idempotent et reprenable
  // ---------------------------------------------------------------------------

  /**
   * Lance (ou reprend) l'application des décisions en arrière-plan. Garde anti double exécution :
   * prise de verrou conditionnelle sur le job (RUNNING), et chaque ligne n'est marquée APPLIED
   * qu'une seule fois dans la transaction qui crée le document / la version.
   */
  async commit(ctx: AuthContext, id: string) {
    const job = await this.loadOwn(ctx, id);
    if (job.phase !== 'PREVIEW_READY' && job.phase !== 'COMMITTING') throw Errors.invalidState('Import non prêt ou déjà appliqué');
    const pending = await this.prisma.importRow.count({ where: { jobId: id, status: 'DUPLICATE_SUSPECTED', decision: 'PENDING' } });
    if (pending) throw Errors.business(`${pending} doublon(s) en attente de décision`, { pendingDecisions: pending });
    const stale = new Date(Date.now() - STALE_COMMIT_MS);
    const claimed = await this.prisma.importJob.updateMany({
      where: { id, phase: { in: ['PREVIEW_READY', 'COMMITTING'] }, OR: [{ status: { not: 'RUNNING' } }, { startedAt: { lt: stale } }] },
      data: { status: 'RUNNING', phase: 'COMMITTING', startedAt: new Date(), errorMessage: null },
    });
    if (!claimed.count) throw Errors.conflict('Import déjà en cours d’application');
    await this.audit.record(ctx, { action: 'cso.import.commit_started', module: 'cso', entityType: 'cso_import_job', entityId: id, vesselId: job.vesselId });
    void this.runCommit(ctx, id).catch(async (e) => {
      this.logger.error(`Commit import ${id} : ${String(e)}`);
      await this.prisma.importJob
        .update({ where: { id }, data: { status: 'FAILED', errorMessage: String((e as Error)?.message ?? e).slice(0, 1000), finishedAt: new Date() } })
        .catch(() => undefined);
    });
    return this.get(ctx, id);
  }

  private async runCommit(ctx: AuthContext, id: string) {
    const job = await this.prisma.importJob.findUniqueOrThrow({ where: { id } });
    // Droits revalidés au moment de l'application
    const { folder: target, library } = await this.csoAccess.assertFolder(ctx, job.targetFolderId!, ['folder_create', 'edit'], { requireActive: true });
    const rows = await this.prisma.importRow.findMany({
      where: { jobId: id, status: { notIn: ['APPLIED', 'SKIPPED'] } },
      orderBy: { rowNumber: 'asc' },
    });
    const stats = { applied: 0, skipped: 0, failed: 0, alreadyApplied: 0 };
    const folderCache = new Map<string, CsoFolder>();
    const toNotify: { doc: CsoDocument; version: CsoVersion }[] = [];

    const work: ImportRow[] = [];
    for (const row of rows) {
      if (row.status === 'INVALID' || row.decision === 'IGNORE' || row.decision === 'PENDING') {
        if (row.status === 'INVALID' || row.decision === 'IGNORE') {
          const res = await this.prisma.importRow.updateMany({ where: { id: row.id, status: { notIn: ['APPLIED', 'SKIPPED'] } }, data: { status: 'SKIPPED' } });
          stats.skipped += res.count;
        }
        continue;
      }
      work.push(row);
    }

    const processRow = async (row: ImportRow, content: Buffer | null) => {
      try {
        const r = await this.applyRow(ctx, job, row, content, target, library, folderCache);
        if (r) {
          stats.applied++;
          toNotify.push(r);
        } else stats.alreadyApplied++;
      } catch (e) {
        stats.failed++;
        const message = e instanceof AppError ? ((e.getResponse() as { message?: string }).message ?? 'Erreur') : String((e as Error)?.message ?? e);
        await this.prisma.importRow.updateMany({ where: { id: row.id, status: { not: 'APPLIED' } }, data: { status: 'FAILED', errorMessage: message.slice(0, 1000) } });
      }
    };

    const source = await this.files.getOrThrow(job.sourceFileId);
    if (source.kind === 'ZIP') {
      const byIndex = new Map(work.map((r) => [(r.normalized as unknown as NormalizedRow).entryIndex, r]));
      await walkZip(await this.files.readBuffer(source), await this.limits(), async (info, read) => {
        const row = byIndex.get(info.index);
        if (!row) return;
        byIndex.delete(info.index);
        await processRow(row, info.entryError ? null : await read());
      });
      for (const row of byIndex.values()) await processRow(row, null);
    } else {
      for (const row of work) await processRow(row, null);
    }

    for (const n of toNotify) await this.workflow.notifyValidators(n.doc, n.version);
    const remainingFailed = await this.prisma.importRow.count({ where: { jobId: id, status: 'FAILED' } });
    const summary = { ...((job.summary as Record<string, unknown> | null) ?? {}), commit: { ...stats, remainingFailed, at: new Date().toISOString() } };
    await this.prisma.importJob.update({
      where: { id },
      data: {
        status: remainingFailed ? 'PARTIALLY_FAILED' : 'COMPLETED',
        // Des lignes en échec laissent l'import reprenable (nouveau commit = seules ces lignes)
        phase: remainingFailed ? 'COMMITTING' : 'COMMITTED',
        finishedAt: new Date(),
        summary: summary as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(ctx, {
      action: 'cso.import.committed',
      module: 'cso',
      entityType: 'cso_import_job',
      entityId: id,
      vesselId: job.vesselId,
      result: remainingFailed ? 'FAILURE' : 'SUCCESS',
      metadata: { ...stats, remainingFailed, createdDocumentIds: toNotify.map((n) => n.doc.id), versionIds: toNotify.map((n) => n.version.id) },
    });
  }

  /** Applique une ligne. Retourne null si une autre exécution l'a déjà appliquée (aucun doublon). */
  private async applyRow(
    ctx: AuthContext,
    job: ImportJob,
    row: ImportRow,
    content: Buffer | null,
    target: CsoFolder,
    library: CsoLibrary,
    folderCache: Map<string, CsoFolder>,
  ): Promise<{ doc: CsoDocument; version: CsoVersion } | null> {
    const n = row.normalized as unknown as NormalizedRow;
    const source = await this.files.getOrThrow(job.sourceFileId);
    // Fichier de la version : dépôt contrôlé via FilesService (inspection, SHA-256, antivirus, audit)
    // ou, pour une source à fichier unique, nouvelle référence au même blob.
    const fileSource = async (): Promise<{ fileId: string } | { cloneFromFileId: string }> => {
      if (source.kind !== 'ZIP') return { cloneFromFileId: source.id };
      if (!content) throw Errors.fileRejected('Entrée introuvable ou illisible dans l’archive');
      const uploaded = await this.files.upload(ctx, { buffer: content, originalname: n.fileName, size: content.length }, 'CSO_DOCUMENT', library.vesselId);
      return { fileId: uploaded.id };
    };
    const claim = async (tx: Prisma.TransactionClient, entityId: string) => {
      const res = await tx.importRow.updateMany({
        where: { id: row.id, status: { notIn: ['APPLIED', 'SKIPPED'] } },
        data: { status: 'APPLIED', appliedEntityId: entityId, appliedAt: new Date(), errorMessage: null },
      });
      if (!res.count) throw new AlreadyApplied();
    };

    try {
      if (row.decision === 'SUBMIT_NEW_VERSION') {
        const { doc } = await this.csoAccess.assertDocument(ctx, row.decisionTargetId!, ['edit'], { requireNotArchived: true });
        const file = await fileSource();
        return await this.prisma.$transaction(async (tx) => {
          const version = await this.workflow.createVersion(ctx, doc, file, { status: 'PENDING_APPROVAL', changeNote: `Import ${job.id.slice(0, 8)} — ${n.path}`.slice(0, 1000) }, tx);
          await claim(tx, version.id);
          await this.audit.record(
            ctx,
            {
              action: 'cso.version.created',
              module: 'cso',
              entityType: 'cso_version',
              entityId: version.id,
              vesselId: doc.vesselId,
              after: { documentId: doc.id, versionNo: version.versionNo, status: version.status, fileId: version.fileId },
              metadata: { importJobId: job.id, importRowId: row.id, decision: row.decision },
            },
            tx,
          );
          return { doc, version };
        });
      }

      // CREATE / CREATE_INDEPENDENT
      const folder = await this.ensureFolder(ctx, job, target, library, n.folderSegments, folderCache);
      await this.csoAccess.assertFolder(ctx, folder.id, ['edit'], { requireActive: true });
      const category = await this.workflow.categoryFor(n.categoryId, library);
      const file = await fileSource();
      return await this.prisma.$transaction(async (tx) => {
        // Unicité vérifiée selon catégorie / scope ; une référence existante fournie est conservée (reprise d'historique)
        const reference = await this.workflow.resolveReference(category, library, n.reference, tx, { allowProvidedInAuto: true });
        const doc = await tx.csoDocument.create({
          data: {
            id: randomUUID(),
            libraryId: library.id,
            folderId: folder.id,
            vesselId: library.vesselId,
            categoryId: category?.id ?? null,
            reference,
            title: n.title,
            description: n.description,
            authorId: ctx.userId,
            status: 'DRAFT',
            nextReviewOn: n.nextReviewOn ? new Date(`${n.nextReviewOn}T00:00:00.000Z`) : null,
            expiryOn: n.expiryOn ? new Date(`${n.expiryOn}T00:00:00.000Z`) : null,
          },
        });
        const version = await this.workflow.createVersion(ctx, doc, file, { status: 'PENDING_APPROVAL', changeNote: `Import ${job.id.slice(0, 8)}` }, tx);
        await claim(tx, doc.id);
        await this.audit.record(
          ctx,
          {
            action: 'cso.document.created',
            module: 'cso',
            entityType: 'cso_document',
            entityId: doc.id,
            vesselId: doc.vesselId,
            after: { reference, title: doc.title, folderId: folder.id, categoryId: doc.categoryId, versionId: version.id, versionStatus: version.status },
            metadata: { importJobId: job.id, importRowId: row.id, decision: row.decision, path: n.path },
          },
          tx,
        );
        return { doc, version };
      });
    } catch (e) {
      if (e instanceof AlreadyApplied) return null;
      throw e;
    }
  }

  /** Recrée l'arborescence du ZIP sous le dossier cible (dossiers existants réutilisés si visibles). */
  private async ensureFolder(
    ctx: AuthContext,
    job: ImportJob,
    target: CsoFolder,
    library: CsoLibrary,
    segments: string[],
    cache: Map<string, CsoFolder>,
  ): Promise<CsoFolder> {
    let parent = target;
    const walked: string[] = [];
    for (const raw of segments) {
      const name = raw.trim().slice(0, 200);
      walked.push(name.toLowerCase());
      const key = walked.join('/');
      const cached = cache.get(key);
      if (cached) {
        parent = cached;
        continue;
      }
      const existing = await this.prisma.csoFolder.findFirst({ where: { parentId: parent.id, status: 'ACTIVE', name: { equals: name, mode: 'insensitive' } } });
      if (existing) {
        await this.csoAccess.assertFolder(ctx, existing.id, [], { requireActive: true });
        parent = existing;
      } else {
        await this.csoAccess.assertFolder(ctx, parent.id, ['folder_create'], { requireActive: true });
        const p = parent;
        parent = await this.prisma.$transaction(async (tx) => {
          const id = randomUUID();
          const f = await tx.csoFolder.create({
            data: { id, libraryId: library.id, parentId: p.id, name, path: `${p.path}${id}/`, depth: p.depth + 1, createdById: ctx.userId },
          });
          await this.audit.record(
            ctx,
            { action: 'cso.folder.created', module: 'cso', entityType: 'cso_folder', entityId: id, vesselId: library.vesselId, after: { name, parentId: p.id }, metadata: { importJobId: job.id } },
            tx,
          );
          return f;
        });
      }
      cache.set(key, parent);
    }
    return parent;
  }
}

class AlreadyApplied extends Error {
  constructor() {
    super('Ligne déjà appliquée');
  }
}
