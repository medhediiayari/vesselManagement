import { Injectable, OnModuleInit } from '@nestjs/common';
import { Prisma, VoyageInstruction } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { Db, PrismaService } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import { PdfService } from '../documents/pdf.service';
import { FileAccessRegistry } from '../files/file-access.registry';
import { FilesService, toFileDto } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateInstructionDto, IssueInstructionDto, ListInstructionsQuery, UpdateInstructionDto } from './voyage-instructions.dto';
import { OWNER_VOYAGE_INSTRUCTION, onboardMasters, userLabels } from './voyages.common';
import { VoyagesService } from './voyages.service';

type FieldsJson = Record<string, string | number | boolean | null | string[]>;

function fmtDate(d: Date | null | undefined, withTime = true): string | null {
  if (!d) return null;
  return withTime ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : d.toISOString().slice(0, 10);
}

/**
 * Voyage Instructions (CDC §7.1, V1 §10.1) : document officiel versionné du voyage
 * (PDF source facultatif, champs structurés, notices). Une seule version ISSUED par voyage
 * (index partiel) : l'émission remplace la précédente (SUPERSEDED) dans la même transaction.
 * Le Captain voit les instructions émises de ses navires et en accuse lecture.
 */
@Injectable()
export class VoyageInstructionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
    private readonly registry: FileAccessRegistry,
    private readonly pdf: PdfService,
    private readonly notifications: NotificationsService,
    private readonly voyages: VoyagesService,
  ) {}

  onModuleInit(): void {
    this.registry.register(OWNER_VOYAGE_INSTRUCTION, async (ctx, file) => {
      this.access.assertCan(ctx, 'voyages.view');
      const i = await this.prisma.voyageInstruction.findUnique({
        where: { id: file.ownerId! },
        include: { voyage: { select: { vesselId: true, reference: true } } },
      });
      if (!i) throw Errors.notFound('Fichier');
      this.access.assertVesselAccess(ctx, i.voyage.vesselId);
      if (i.status === 'DRAFT' && !can(ctx, 'instructions.manage')) throw Errors.forbidden('Instruction en brouillon', { permission: 'instructions.manage' });
      return {
        module: 'voyages',
        entityType: 'voyage_instruction',
        entityId: i.id,
        vesselId: i.voyage.vesselId,
        downloadName: `${i.voyage.reference}-VI-v${i.versionNo}.${file.extension}`,
      };
    });
  }

  /** Instruction + scope navire ; un brouillon n'est visible qu'avec instructions.manage. */
  private async getAccessible(ctx: AuthContext, id: string, db: Db = this.prisma) {
    const i = await db.voyageInstruction.findUnique({ where: { id }, include: { voyage: true } });
    if (!i) throw Errors.notFound('Instruction de voyage');
    this.access.assertVesselAccess(ctx, i.voyage.vesselId);
    if (i.status === 'DRAFT' && !can(ctx, 'instructions.manage')) throw Errors.notFound('Instruction de voyage');
    return i;
  }

  async list(ctx: AuthContext, q: ListInstructionsQuery) {
    if (q.vesselId) this.access.assertVesselAccess(ctx, q.vesselId);
    const manage = can(ctx, 'instructions.manage');
    const where: Prisma.VoyageInstructionWhereInput = {
      AND: [
        { voyage: { AND: [vesselWhere(ctx) as Prisma.VoyageWhereInput, q.vesselId ? { vesselId: q.vesselId } : {}] } },
        q.voyageId ? { voyageId: q.voyageId } : {},
        q.status ? { status: q.status } : {},
        manage ? {} : { status: { not: 'DRAFT' } },
      ],
    };
    const [rows, total] = await Promise.all([
      this.prisma.voyageInstruction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          voyage: { select: { id: true, reference: true, status: true, vesselId: true, vessel: { select: { code: true, name: true } } } },
          acks: { select: { userId: true, ackAt: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.voyageInstruction.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    return {
      ...page,
      items: page.items.map(({ acks, ...i }) => ({
        ...i,
        acknowledgements: acks.length,
        acknowledgedByMe: acks.find((a) => a.userId === ctx.userId)?.ackAt ?? null,
      })),
    };
  }

  async get(ctx: AuthContext, id: string) {
    const i = await this.getAccessible(ctx, id);
    const [acks, file] = await Promise.all([
      this.prisma.voyageInstructionAck.findMany({ where: { instructionId: id }, orderBy: { ackAt: 'asc' } }),
      i.fileId ? this.prisma.storedFile.findUnique({ where: { id: i.fileId } }) : Promise.resolve(null),
    ]);
    const labels = await userLabels(this.prisma, [i.createdById, i.issuedById, ...acks.map((a) => a.userId)]);
    const { voyage, ...rest } = i;
    return {
      ...rest,
      voyage: { id: voyage.id, reference: voyage.reference, status: voyage.status, vesselId: voyage.vesselId },
      createdBy: labels.get(i.createdById) ?? null,
      issuedBy: i.issuedById ? labels.get(i.issuedById) ?? null : null,
      file: file ? toFileDto(file) : null,
      acknowledgements: acks.map((a) => ({ userId: a.userId, displayName: labels.get(a.userId) ?? null, ackAt: a.ackAt })),
      acknowledgedByMe: acks.find((a) => a.userId === ctx.userId)?.ackAt ?? null,
    };
  }

  async create(ctx: AuthContext, dto: CreateInstructionDto) {
    const voyage = await this.voyages.getAccessible(ctx, dto.voyageId);
    this.voyages.assertOpen(voyage);
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.voyageInstruction.aggregate({ where: { voyageId: voyage.id }, _max: { versionNo: true } });
      const i = await tx.voyageInstruction.create({
        data: {
          voyageId: voyage.id,
          versionNo: (last._max.versionNo ?? 0) + 1,
          title: dto.title,
          fields: (dto.fields ?? undefined) as Prisma.InputJsonValue | undefined,
          notices: dto.notices ?? null,
          status: 'DRAFT',
          createdById: ctx.userId,
        },
      });
      if (dto.fileId) {
        await this.files.attach(ctx, dto.fileId, { type: OWNER_VOYAGE_INSTRUCTION, id: i.id, contexts: ['VOYAGE'], vesselId: voyage.vesselId }, tx);
        await tx.voyageInstruction.update({ where: { id: i.id }, data: { fileId: dto.fileId } });
      }
      await this.audit.record(
        ctx,
        {
          action: 'voyage.instruction_created',
          module: 'voyages',
          entityType: 'voyage_instruction',
          entityId: i.id,
          vesselId: voyage.vesselId,
          after: { ...i, fileId: dto.fileId ?? null },
          metadata: { voyageId: voyage.id },
        },
        tx,
      );
      return tx.voyageInstruction.findUniqueOrThrow({ where: { id: i.id } });
    });
  }

  /** Modification limitée au brouillon ; une version émise est immuable (nouvelle version sinon). */
  async update(ctx: AuthContext, id: string, dto: UpdateInstructionDto) {
    const before = await this.getAccessible(ctx, id);
    if (before.status !== 'DRAFT') throw Errors.invalidState('Instruction émise : créer une nouvelle version');
    this.voyages.assertOpen(before.voyage);
    if (dto.fileId && before.fileId) throw Errors.conflict('Un document est déjà joint à cette version');
    return this.prisma.$transaction(async (tx) => {
      if (dto.fileId) {
        await this.files.attach(ctx, dto.fileId, { type: OWNER_VOYAGE_INSTRUCTION, id, contexts: ['VOYAGE'], vesselId: before.voyage.vesselId }, tx);
      }
      const data: Prisma.VoyageInstructionUncheckedUpdateManyInput = {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.notices !== undefined ? { notices: dto.notices } : {}),
        ...(dto.fields !== undefined ? { fields: dto.fields === null ? Prisma.DbNull : (dto.fields as Prisma.InputJsonValue) } : {}),
        ...(dto.fileId ? { fileId: dto.fileId } : {}),
      };
      const res = await tx.voyageInstruction.updateMany({ where: { id, status: 'DRAFT' }, data });
      if (res.count === 0) throw Errors.alreadyProcessed('Instruction déjà émise');
      const after = await tx.voyageInstruction.findUniqueOrThrow({ where: { id } });
      const { voyage: _v, ...b } = before;
      await this.audit.record(
        ctx,
        { action: 'voyage.instruction_updated', module: 'voyages', entityType: 'voyage_instruction', entityId: id, vesselId: before.voyage.vesselId, ...diffFields(b as never, after as never) },
        tx,
      );
      return after;
    });
  }

  /**
   * Émission : DRAFT → ISSUED ; l'éventuelle version ISSUED précédente passe SUPERSEDED dans la
   * même transaction (avant l'émission : index partiel « une seule émise »). Options : PDF généré
   * depuis les champs structurés, tâches de checklist Master créées depuis fields.masterChecklist.
   */
  async issue(ctx: AuthContext, id: string, dto: IssueInstructionDto) {
    const instr = await this.getAccessible(ctx, id);
    if (instr.status !== 'DRAFT') throw Errors.alreadyProcessed('Instruction déjà émise');
    this.voyages.assertOpen(instr.voyage);
    const vesselId = instr.voyage.vesselId;

    return this.prisma.serializable(async (tx) => {
      const now = new Date();
      const previous = await tx.voyageInstruction.findMany({ where: { voyageId: instr.voyageId, status: 'ISSUED' }, select: { id: true, versionNo: true } });
      if (previous.length) {
        await tx.voyageInstruction.updateMany({ where: { voyageId: instr.voyageId, status: 'ISSUED' }, data: { status: 'SUPERSEDED' } });
      }
      const res = await tx.voyageInstruction.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'ISSUED', issuedById: ctx.userId, issuedAt: now } });
      if (res.count === 0) throw Errors.alreadyProcessed('Instruction déjà émise');

      let pdfGenerated = false;
      if (dto.generatePdf && !instr.fileId) {
        const buffer = await this.renderPdf(ctx, instr, now, tx);
        const file = await this.files.storeGenerated(
          buffer,
          `${instr.voyage.reference}-VI-v${instr.versionNo}.pdf`,
          'PDF',
          'application/pdf',
          'GENERATED',
          vesselId,
          ctx.userId,
          { type: OWNER_VOYAGE_INSTRUCTION, id },
          tx,
        );
        await tx.voyageInstruction.update({ where: { id }, data: { fileId: file.id } });
        pdfGenerated = true;
      }

      let tasksCreated = 0;
      const checklist = (instr.fields as FieldsJson | null)?.masterChecklist;
      if (dto.createChecklistTasks && Array.isArray(checklist)) {
        const existing = await tx.voyageTask.findMany({ where: { voyageId: instr.voyageId }, select: { title: true, sortOrder: true } });
        const titles = new Set(existing.map((t) => t.title.trim().toLowerCase()));
        let order = existing.reduce((m, t) => Math.max(m, t.sortOrder), -1) + 1;
        const toCreate = checklist.map((t) => String(t).trim()).filter((t) => t && !titles.has(t.toLowerCase()));
        if (toCreate.length) {
          await tx.voyageTask.createMany({
            data: toCreate.map((title) => ({ voyageId: instr.voyageId, title: title.slice(0, 300), category: 'MASTER_CHECKLIST', sortOrder: order++ })),
          });
          tasksCreated = toCreate.length;
        }
      }

      await this.audit.record(
        ctx,
        {
          action: 'voyage.instruction_issued',
          module: 'voyages',
          entityType: 'voyage_instruction',
          entityId: id,
          vesselId,
          before: { status: 'DRAFT' },
          after: { status: 'ISSUED', issuedAt: now },
          metadata: { voyageId: instr.voyageId, versionNo: instr.versionNo, superseded: previous, pdfGenerated, tasksCreated, comment: dto.comment },
        },
        tx,
      );
      const masters = await onboardMasters(this.access, tx, vesselId);
      await this.notifications.notify(
        {
          userIds: masters,
          excludeUserIds: [ctx.userId],
          type: 'voyage.instruction_issued',
          title: `Instructions de voyage ${instr.voyage.reference} v${instr.versionNo} émises — accusé de lecture attendu`,
          body: instr.title,
          module: 'voyages',
          entityType: 'voyage_instruction',
          entityId: id,
          vesselId,
          link: `/voyages/${instr.voyageId}?tab=instructions`,
          priority: 'HIGH',
          dedupeKey: `voyage-instruction:${id}:issued`,
          email: true,
          requiredPermission: 'voyages.view',
        },
        tx,
      );
      const after = await tx.voyageInstruction.findUniqueOrThrow({ where: { id } });
      return { ...after, superseded: previous, pdfGenerated, tasksCreated };
    });
  }

  private async renderPdf(ctx: AuthContext, instr: VoyageInstruction & { voyage: { id: string; reference: string; vesselId: string; charterer: string | null; laycanFrom: Date | null; laycanTo: Date | null } }, issuedAt: Date, db: Db) {
    // Requêtes séquentielles : `db` est le client de la transaction d'émission
    const vessel = await db.vessel.findUniqueOrThrow({ where: { id: instr.voyage.vesselId }, select: { name: true, imoNumber: true } });
    const ports = await db.voyagePort.findMany({ where: { voyageId: instr.voyageId }, orderBy: { sequence: 'asc' }, include: { agent: { select: { name: true } } } });
    const cargos = await db.cargo.findMany({ where: { voyageId: instr.voyageId }, orderBy: { commodity: 'asc' } });
    const fields = (instr.fields as FieldsJson | null) ?? {};
    return this.pdf.render(
      {
        title: 'Voyage Instructions',
        subtitle: `${vessel.name} — ${instr.voyage.reference}`,
        reference: `${instr.voyage.reference}-VI-v${instr.versionNo}`,
        meta: [
          ['Navire', `${vessel.name}${vessel.imoNumber ? ` (IMO ${vessel.imoNumber})` : ''}`],
          ['Voyage', instr.voyage.reference],
          ['Version', `v${instr.versionNo} — émise ${fmtDate(issuedAt)}`],
        ],
        author: ctx.displayName,
      },
      (b) => {
        b.section('Informations générales', 1).fields([
          ['Titre', instr.title],
          ['Affréteur', instr.voyage.charterer],
          ['Laycan', instr.voyage.laycanFrom || instr.voyage.laycanTo ? `${fmtDate(instr.voyage.laycanFrom, false) ?? '?'} → ${fmtDate(instr.voyage.laycanTo, false) ?? '?'}` : null],
          ['Route', ports.length ? ports.map((p) => p.portName).join(' → ') : null],
        ]);
        b.section('Escales', 2);
        if (ports.length) {
          b.table(
            [
              { header: '#', key: 'seq', width: 4 },
              { header: 'Type', key: 'type', width: 12 },
              { header: 'Port', key: 'port', width: 20 },
              { header: 'Agent', key: 'agent', width: 20 },
              { header: 'ETA', key: 'eta', width: 16 },
              { header: 'ETD', key: 'etd', width: 16 },
            ],
            ports.map((p) => ({ seq: p.sequence, type: p.type, port: `${p.portName}${p.country ? ` (${p.country})` : ''}`, agent: p.agent?.name, eta: fmtDate(p.eta), etd: fmtDate(p.etd) })),
          );
        } else b.note('Aucune escale renseignée.');
        b.section('Cargaison', 3);
        if (cargos.length) {
          b.table(
            [
              { header: 'Commodity', key: 'commodity', width: 26 },
              { header: 'Min', key: 'min', width: 10, align: 'right' },
              { header: 'Max', key: 'max', width: 10, align: 'right' },
              { header: 'Option', key: 'option', width: 14 },
              { header: 'Stowage factor', key: 'sf', width: 18 },
            ],
            cargos.map((c) => ({
              commodity: c.commodity,
              min: c.qtyMinMt ? `${c.qtyMinMt.toString()} ${c.unit}` : null,
              max: c.qtyMaxMt ? `${c.qtyMaxMt.toString()} ${c.unit}` : null,
              option: c.quantityOption,
              sf: c.stowageFactor ? `${c.stowageFactor.toString()} ${c.stowageFactorUnit ?? ''}`.trim() : null,
            })),
          );
        } else b.note('Aucune cargaison renseignée.');
        b.section('Champs structurés', 4);
        const entries = Object.entries(fields);
        if (entries.length) {
          b.fields(entries.map(([k, v]) => [k, Array.isArray(v) ? v.join(' ; ') : v === null ? null : String(v)] as [string, string | null]), 1);
        } else b.note('Aucun champ structuré.');
        b.section('Notices', 5).paragraph('Notices', instr.notices);
        b.note('Les clauses NOR / laytime / fret sont contractuelles : reportées telles que saisies, sans interprétation ni calcul automatique.');
        b.signatures([{ label: 'Émis par', name: ctx.displayName, date: fmtDate(issuedAt) }]);
      },
    );
  }

  async acknowledge(ctx: AuthContext, id: string) {
    const i = await this.getAccessible(ctx, id);
    if (i.status !== 'ISSUED') throw Errors.invalidState('Seule la version émise en vigueur peut faire l’objet d’un accusé de lecture');
    const existing = await this.prisma.voyageInstructionAck.findUnique({ where: { instructionId_userId: { instructionId: id, userId: ctx.userId } } });
    if (existing) return { ...existing, alreadyAcknowledged: true };
    return this.prisma.$transaction(async (tx) => {
      const ack = await tx.voyageInstructionAck.create({ data: { instructionId: id, userId: ctx.userId } });
      await this.audit.record(
        ctx,
        {
          action: 'voyage.instruction_acknowledged',
          module: 'voyages',
          entityType: 'voyage_instruction',
          entityId: id,
          vesselId: i.voyage.vesselId,
          metadata: { voyageId: i.voyageId, versionNo: i.versionNo },
        },
        tx,
      );
      return { ...ack, alreadyAcknowledged: false };
    });
  }

  async listAcknowledgements(ctx: AuthContext, id: string) {
    const i = await this.getAccessible(ctx, id);
    const [acks, expected] = await Promise.all([
      this.prisma.voyageInstructionAck.findMany({ where: { instructionId: id }, orderBy: { ackAt: 'asc' } }),
      onboardMasters(this.access, this.prisma, i.voyage.vesselId),
    ]);
    const labels = await userLabels(this.prisma, [...acks.map((a) => a.userId), ...expected]);
    return {
      instruction: { id: i.id, versionNo: i.versionNo, status: i.status },
      acknowledgements: acks.map((a) => ({ userId: a.userId, displayName: labels.get(a.userId) ?? null, ackAt: a.ackAt })),
      pendingMasters: expected.filter((u) => !acks.some((a) => a.userId === u)).map((u) => ({ userId: u, displayName: labels.get(u) ?? null })),
    };
  }

  async fileLink(ctx: AuthContext, id: string, mode: 'preview' | 'download') {
    const i = await this.getAccessible(ctx, id);
    if (!i.fileId) throw Errors.notFound('Document de l’instruction');
    return this.files.issueLink(ctx, i.fileId, mode);
  }
}
