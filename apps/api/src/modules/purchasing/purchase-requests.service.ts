import { Injectable } from '@nestjs/common';
import { Prisma, PrStatus } from '@prisma/client';
import { Errors } from '../../common/errors';
import { cursorArgs, toPage } from '../../common/pagination';
import { PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import { AuthContext, can, vesselWhere } from '../access/auth-context';
import { diffFields } from '../audit/audit.service';
import { NumberingService } from '../documents/numbering.service';
import { FilesService } from '../files/files.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AttachmentDto,
  CloseDto,
  CommentDto,
  CreatePrDto,
  ListPrFilters,
  PrFormDefaultsQuery,
  ReasonDto,
  RejectDto,
  ReplacePrLinesDto,
  SplitPrDto,
  UpdatePrDto,
  VersionDto,
} from './purchase-requests.dto';
import { PurchasingConfigService } from './purchasing-config.service';
import { PurchasingCore } from './purchasing-core.service';
import { PurchasingDocuments } from './purchasing-documents.service';
import { LINKS } from './purchasing.constants';
import {
  AppliedReviewCircuit,
  AppliedReviewStep,
  PR_CANCELLABLE_STATUSES,
  PR_CLOSABLE_STATUSES,
  PR_HOLDABLE_STATUSES,
  PR_OPEN_STATUSES,
  PR_SPLITTABLE_STATUSES,
  PR_TRANSITIONS,
  assertTransition,
  fmtQty,
  planSplit,
  prDateIssue,
  resolveReviewCircuit,
} from './purchasing.logic';

type PrLineCreate = Omit<Prisma.PrLineCreateManyInput, 'prId'>;

function todayUtc(): Date {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function circuitSteps(circuit: unknown): AppliedReviewStep[] {
  const steps = (circuit as { steps?: unknown } | null)?.steps;
  return Array.isArray(steps) ? (steps as AppliedReviewStep[]) : [];
}

/**
 * Purchase Requests (CDC §6.4, V1 §8-9, refonte du 22/10/2026) : brouillon éditable façon tableur, soumission,
 * mise « en discussion » (UNDER_REVIEW) puis décision de l'acheteur, qui vaut validation : continuer avec la même
 * PR (APPROVED), la diviser en sous-PR (SPLIT) ou appliquer une Counter-PR (PrRevisionsService.applyCounter).
 * Les lignes ne sont plus jamais modifiées après DRAFT : seules les quantités de travail (approuvée / annulée)
 * évoluent ; une division copie des lignes entières dans des sous-PR validées, la PR mère restant en lecture seule.
 */
@Injectable()
export class PurchaseRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly access: AccessService,
    private readonly numbering: NumberingService,
    private readonly notifications: NotificationsService,
    private readonly config: PurchasingConfigService,
    private readonly docs: PurchasingDocuments,
    private readonly files: FilesService,
  ) {}

  // ---------------------------------------------------------------------------
  // Lecture
  // ---------------------------------------------------------------------------

  /** Filtre serveur (scope navire TOUJOURS appliqué — PUR-06). */
  buildWhere(ctx: AuthContext, q: Partial<ListPrFilters>): Prisma.PurchaseRequestWhereInput {
    const and: Prisma.PurchaseRequestWhereInput[] = [vesselWhere(ctx) as Prisma.PurchaseRequestWhereInput, this.core.prOwnWhere(ctx)];
    if (q.vesselId) and.push({ vesselId: q.vesselId });
    if (q.requesterId) and.push({ requesterId: q.requesterId });
    if (q.mine) and.push({ requesterId: ctx.userId });
    if (q.departmentId) and.push({ departmentId: q.departmentId });
    if (q.category) and.push({ category: { equals: q.category, mode: 'insensitive' } });
    if (q.status?.length) and.push({ status: { in: q.status } });
    if (q.priority?.length) and.push({ priority: { in: q.priority } });
    if (q.overdue) and.push({ neededBy: { lt: todayUtc() }, status: { in: [...PR_OPEN_STATUSES] } });
    if (q.search) {
      and.push({
        OR: [
          { number: { contains: q.search, mode: 'insensitive' } },
          { subject: { contains: q.search, mode: 'insensitive' } },
          { lines: { some: { designation: { contains: q.search, mode: 'insensitive' } } } },
          { lines: { some: { reference: { contains: q.search, mode: 'insensitive' } } } },
        ],
      });
    }
    return { AND: and };
  }

  async list(ctx: AuthContext, q: ListPrFilters) {
    const where = this.buildWhere(ctx, q);
    const [rows, total] = await Promise.all([
      this.prisma.purchaseRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          vessel: { select: { id: true, code: true, name: true } },
          lines: { orderBy: { lineNo: 'asc' } },
          parent: { select: { id: true, number: true } },
          _count: { select: { children: true } },
        },
        ...cursorArgs(q),
      }),
      this.prisma.purchaseRequest.count({ where }),
    ]);
    const page = toPage(rows, q, total);
    const progress = await this.core.prLinesProgress(page.items.flatMap((p) => p.lines));
    const names = await this.core.userNames(page.items.map((p) => p.requesterId));
    const today = todayUtc();
    return {
      ...page,
      items: page.items.map(({ lines, reviewCircuit: _rc, _count, ...pr }) => {
        const badges: Record<string, number> = {};
        const lineViews = lines.map((l) => {
          const p = progress.get(l.id)!;
          badges[p.badge] = (badges[p.badge] ?? 0) + 1;
          return {
            id: l.id,
            lineNo: l.lineNo,
            designation: l.designation,
            unit: l.unit,
            requested: p.requested,
            effective: p.effective,
            ordered: p.ordered,
            accepted: p.accepted,
            badge: p.badge,
          };
        });
        return {
          ...pr,
          requesterName: names.get(pr.requesterId) ?? null,
          overdue: !!pr.neededBy && pr.neededBy < today && PR_OPEN_STATUSES.includes(pr.status),
          lineCount: lines.length,
          childCount: _count.children,
          badges,
          lines: lineViews,
        };
      }),
    };
  }

  async get(ctx: AuthContext, id: string) {
    const pr = await this.core.findPr(ctx, id);
    const full = await this.prisma.purchaseRequest.findUniqueOrThrow({
      where: { id },
      include: {
        vessel: { select: { id: true, code: true, name: true } },
        lines: { orderBy: { lineNo: 'asc' } },
        revisions: { orderBy: { revisionNo: 'desc' }, select: { id: true, revisionNo: true, kind: true, status: true, proposedById: true, proposedAt: true, decidedById: true, decidedAt: true } },
        parent: { select: { id: true, number: true, status: true, subject: true } },
        children: {
          orderBy: { number: 'asc' },
          select: { id: true, number: true, status: true, subject: true, approvedAt: true, _count: { select: { lines: true } } },
        },
      },
    });
    const progress = await this.core.prLinesProgress(full.lines);
    const lineIds = full.lines.map((l) => l.id);
    const department = pr.departmentId ? await this.prisma.department.findUnique({ where: { id: pr.departmentId }, select: { id: true, code: true, name: true } }) : null;
    const names = await this.core.userNames([pr.requesterId, pr.approvedById, ...full.revisions.flatMap((r) => [r.proposedById, r.decidedById])]);

    // Objets liés, chacun soumis à sa permission de consultation (le scope navire est celui de la PR)
    const orderIds = [...new Set([...progress.values()].flatMap((p) => p.orders.map((o) => o.poId)))];
    const links: Record<string, unknown> = {};
    if (can(ctx, 'rfq.view')) {
      links.rfqs = await this.prisma.rfq.findMany({
        where: { lines: { some: { prLineId: { in: lineIds } } } },
        select: { id: true, number: true, title: true, status: true, deadline: true, issuedAt: true },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (can(ctx, 'quotation.view')) {
      links.quotations = await this.prisma.quotation.findMany({
        where: { lines: { some: { rfqLine: { prLineId: { in: lineIds } } } } },
        select: { id: true, rfqId: true, reference: true, currency: true, totalAmount: true, status: true, supplier: { select: { id: true, name: true } } },
      });
    }
    if (can(ctx, 'bc.view')) {
      links.orders = await this.prisma.purchaseOrder.findMany({
        where: { id: { in: orderIds } },
        select: { id: true, number: true, status: true, currency: true, totalAmount: true, expectedDeliveryDate: true, supplier: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      });
    }
    if (can(ctx, 'receiving.view')) {
      links.deliveryNotes = await this.prisma.deliveryNote.findMany({
        where: { poId: { in: orderIds } },
        select: { id: true, number: true, poId: true, deliveryDate: true, status: true },
      });
      links.receipts = await this.prisma.goodsReceipt.findMany({
        where: { poId: { in: orderIds } },
        select: { id: true, number: true, poId: true, receivedAt: true, status: true },
      });
    }
    if (can(ctx, 'invoice.view')) {
      links.invoices = await this.prisma.invoice.findMany({
        where: { orders: { some: { poId: { in: orderIds } } } },
        select: { id: true, number: true, status: true, currency: true, amount: true, supplier: { select: { id: true, name: true } } },
      });
    }

    return {
      ...full,
      department,
      requesterName: names.get(pr.requesterId) ?? null,
      approvedByName: pr.approvedById ? names.get(pr.approvedById) ?? null : null,
      lines: full.lines.map((l) => ({ ...l, progress: progress.get(l.id) })),
      revisions: full.revisions.map((r) => ({ ...r, proposedByName: names.get(r.proposedById) ?? null, decidedByName: r.decidedById ? names.get(r.decidedById) ?? null : null })),
      children: full.children.map(({ _count, ...c }) => ({ ...c, lineCount: _count.lines })),
      attachments: await this.core.attachmentsOf('PR', [id]),
      // Sous-PR : pièces jointes de la PR mère (photos, plaques…) consultables sans les dupliquer
      parentAttachments: full.parentId ? await this.core.attachmentsOf('PR', [full.parentId]) : [],
      links,
    };
  }

  /** Timeline : événements d'audit de la PR (CDC V1 §9.2 « timeline événements »). */
  async history(ctx: AuthContext, id: string) {
    await this.core.findPr(ctx, id);
    return this.prisma.auditEvent.findMany({
      where: { module: 'purchasing', entityType: 'purchase_request', entityId: id },
      orderBy: { occurredAt: 'asc' },
      take: 500,
      select: { id: true, occurredAt: true, actorLabel: true, action: true, before: true, after: true, metadata: true },
    });
  }

  // ---------------------------------------------------------------------------
  // Brouillon
  // ---------------------------------------------------------------------------

  private async assertDepartment(departmentId: string | null | undefined) {
    if (!departmentId) return;
    const d = await this.prisma.department.findUnique({ where: { id: departmentId }, select: { status: true } });
    if (!d || d.status !== 'ACTIVE') throw Errors.validation('Département inconnu ou inactif');
  }

  private lineData(lines: CreatePrDto['lines']): PrLineCreate[] {
    return lines.map((l, i) => ({
      lineNo: i + 1,
      designation: l.designation,
      reference: l.reference ?? null,
      quantityRequested: l.quantityRequested,
      unit: l.unit,
      rob: l.rob ?? null,
      remarks: l.remarks ?? null,
      catalogItemId: l.catalogItemId ?? null,
    }));
  }

  /** Dates d'en-tête : demande non future, besoin ≥ demande (422 sur le champ fautif). */
  private assertPrDates(requestDate: Date, neededBy: Date | null | undefined) {
    const issue = prDateIssue(requestDate, neededBy, todayUtc());
    if (issue) throw Errors.validation(issue.message, { field: issue.field });
  }

  /**
   * GET /purchase-requests/form-defaults — référence du formulaire (paramétrage) et, si un navire est fourni,
   * sa prochaine escale avec ETA (voyage planifié ou actif) pour proposer la date de besoin.
   */
  async formDefaults(ctx: AuthContext, q: PrFormDefaultsQuery) {
    const formRef = await this.config.prFormRef();
    const today = todayUtc().toISOString().slice(0, 10);
    if (!q.vesselId) return { formRef, today, nextPortCall: null };
    this.access.assertVesselAccess(ctx, q.vesselId);
    const port = await this.prisma.voyagePort.findFirst({
      where: { voyage: { vesselId: q.vesselId, status: { in: ['PLANNED', 'ACTIVE'] } }, ata: null, eta: { gte: new Date() } },
      orderBy: { eta: 'asc' },
      select: { portName: true, eta: true, voyage: { select: { reference: true } } },
    });
    return {
      formRef,
      today,
      nextPortCall: port?.eta ? { portName: port.portName, eta: port.eta, voyageReference: port.voyage.reference } : null,
    };
  }

  async create(ctx: AuthContext, dto: CreatePrDto) {
    const vessel = await this.core.vesselForWrite(ctx, dto.vesselId);
    await this.assertDepartment(dto.departmentId);
    const requestDate = dto.requestDate ?? todayUtc();
    this.assertPrDates(requestDate, dto.neededBy);
    return this.prisma.$transaction(async (tx) => {
      const number = await this.numbering.nextFormatted('PR', vessel.code, tx);
      const formRef = await this.config.prFormRef(tx);
      const pr = await tx.purchaseRequest.create({
        data: {
          number,
          vesselId: vessel.id,
          departmentId: dto.departmentId ?? null,
          requesterId: ctx.userId,
          requestDate,
          category: dto.category,
          priority: dto.priority,
          neededBy: dto.neededBy ?? null,
          subject: dto.subject,
          comment: dto.comment ?? null,
          formRef,
          status: 'DRAFT',
          lines: { createMany: { data: this.lineData(dto.lines) } },
        },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
      });
      await this.core.audit(ctx, { action: 'pr.created', entityType: 'purchase_request', entityId: pr.id, vesselId: pr.vesselId, after: pr }, tx);
      return pr;
    });
  }

  /**
   * Seul le demandeur rédige et soumet son brouillon : un acheteur ne peut ni modifier ni soumettre la PR
   * d'un autre (sinon une même personne rédigerait puis approuverait la demande — séparation des rôles).
   */
  private assertDraftEditor(ctx: AuthContext, pr: { status: PrStatus; requesterId: string }) {
    if (pr.status !== 'DRAFT') throw Errors.invalidState('PR soumise : immuable (passer par une Counter-PR / révision)', { status: pr.status });
    if (pr.requesterId !== ctx.userId) throw Errors.forbidden('Seul le demandeur peut modifier ou soumettre sa PR brouillon');
  }

  async update(ctx: AuthContext, id: string, dto: UpdatePrDto) {
    const { expectedVersion, ...data } = dto;
    await this.assertDepartment(data.departmentId);
    return this.prisma.$transaction(async (tx) => {
      const before = await this.core.findPr(ctx, id, tx);
      this.assertDraftEditor(ctx, before);
      this.assertPrDates(data.requestDate ?? before.requestDate, data.neededBy === undefined ? before.neededBy : data.neededBy);
      const after = await this.core.bumpPr(tx, before, expectedVersion, data as Prisma.PurchaseRequestUncheckedUpdateManyInput);
      await this.core.audit(ctx, { action: 'pr.updated', entityType: 'purchase_request', entityId: id, vesselId: after.vesselId, ...diffFields(before as never, after as never) }, tx);
      return after;
    });
  }

  /** PUT /purchase-requests/:id/lines — saisie tableur (remplacement complet) tant que DRAFT. */
  async replaceLines(ctx: AuthContext, id: string, dto: ReplacePrLinesDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      this.assertDraftEditor(ctx, pr);
      const before = await tx.prLine.findMany({ where: { prId: id }, orderBy: { lineNo: 'asc' } });
      await this.core.bumpPr(tx, pr, dto.expectedVersion, {});
      await tx.prLine.deleteMany({ where: { prId: id } });
      if (dto.lines.length) await tx.prLine.createMany({ data: this.lineData(dto.lines).map((l) => ({ ...l, prId: id })) });
      const after = await tx.prLine.findMany({ where: { prId: id }, orderBy: { lineNo: 'asc' } });
      await this.core.audit(
        ctx,
        { action: 'pr.lines_replaced', entityType: 'purchase_request', entityId: id, vesselId: pr.vesselId, before: before, after: after },
        tx,
      );
      return { ...(await tx.purchaseRequest.findUniqueOrThrow({ where: { id } })), lines: after };
    });
  }

  async addAttachment(ctx: AuthContext, id: string, dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'PR', id, dto.fileId, dto.title);
  }

  // ---------------------------------------------------------------------------
  // Soumission et revue (circuit configurable, PUR-01)
  // ---------------------------------------------------------------------------

  async submit(ctx: AuthContext, id: string, dto: VersionDto) {
    const { rules } = await this.config.reviewCircuits();
    const result = await this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      assertTransition(PR_TRANSITIONS, pr.status, 'SUBMITTED', 'Soumission PR');
      this.assertDraftEditor(ctx, pr);
      const lineCount = await tx.prLine.count({ where: { prId: id } });
      if (!lineCount) throw Errors.business('Une PR doit comporter au moins une ligne pour être soumise');
      const requesterRoles = (await tx.userRole.findMany({ where: { userId: pr.requesterId }, select: { role: { select: { key: true } } } })).map((r) => r.role.key);
      const circuit = resolveReviewCircuit(rules, {
        requesterRoles,
        category: pr.category,
        priority: pr.priority,
        departmentId: pr.departmentId,
        vesselId: pr.vesselId,
      });
      const after = await this.core.bumpPr(tx, pr, dto.expectedVersion, {
        status: 'SUBMITTED',
        submittedAt: new Date(),
        reviewCircuit: circuit as unknown as Prisma.InputJsonValue,
      });
      await this.core.audit(
        ctx,
        {
          action: 'pr.submitted',
          entityType: 'purchase_request',
          entityId: id,
          vesselId: pr.vesselId,
          before: { status: pr.status },
          after: { status: after.status },
          metadata: { reviewCircuit: circuit, comment: dto.comment },
        },
        tx,
      );
      if (dto.comment) await tx.prComment.create({ data: { prId: id, authorId: ctx.userId, body: dto.comment } });
      // Destinataires : acteurs de la première étape du circuit (Purchasing par défaut)
      const first = circuit.steps[0];
      const candidates = await this.access.usersWithPermission(first.permission, pr.vesselId, tx);
      await this.notifications.notify(
        {
          userIds: candidates,
          excludeUserIds: [ctx.userId],
          type: 'purchasing.pr_submitted',
          title: `PR ${pr.number} soumise — ${pr.subject}`,
          body: `Circuit appliqué : ${circuit.label}${circuit.captainApprovalRequired ? ' (visa Captain requis)' : ''}.`,
          module: 'purchasing',
          entityType: 'purchase_request',
          entityId: id,
          vesselId: pr.vesselId,
          link: LINKS.pr(id),
          priority: pr.priority === 'URGENT' ? 'HIGH' : 'NORMAL',
          dedupeKey: `pr:${id}:submitted`,
          email: true,
          requiredPermission: 'pr.view',
        },
        tx,
      );
      return after;
    });
    return result;
  }

  async startReview(ctx: AuthContext, id: string, dto: VersionDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      assertTransition(PR_TRANSITIONS, pr.status, 'UNDER_REVIEW', 'Prise en revue');
      if (pr.status !== 'SUBMITTED') throw Errors.invalidState('Seule une PR soumise peut être prise en revue');
      const after = await this.core.bumpPr(tx, pr, dto.expectedVersion, { status: 'UNDER_REVIEW' });
      await this.core.audit(ctx, { action: 'pr.review_started', entityType: 'purchase_request', entityId: id, vesselId: pr.vesselId, before: { status: pr.status }, after: { status: 'UNDER_REVIEW' }, metadata: { comment: dto.comment } }, tx);
      if (dto.comment) await tx.prComment.create({ data: { prId: id, authorId: ctx.userId, body: dto.comment } });
      await this.notifyRequester(
        pr,
        `PR ${pr.number} en discussion avec les Achats`,
        dto.comment ?? 'Les Achats étudient votre demande ; vous pouvez échanger avec eux dans l’onglet Discussion.',
        'purchasing.pr_in_discussion',
        tx,
        ctx.userId,
      );
      return after;
    });
  }

  /** Visa d'une étape intermédiaire du circuit (ex. visa Master si une règle l'exige — jamais par défaut, PUR-01). */
  async endorse(ctx: AuthContext, id: string, dto: VersionDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      if (pr.status !== 'SUBMITTED' && pr.status !== 'UNDER_REVIEW') throw Errors.invalidState(`Visa impossible au statut ${pr.status}`);
      const circuit = pr.reviewCircuit as unknown as AppliedReviewCircuit | null;
      const steps = circuitSteps(circuit);
      const idx = steps.findIndex((s) => s.status === 'PENDING');
      if (idx < 0 || idx === steps.length - 1) throw Errors.business('Aucune étape intermédiaire en attente : utilisez l’approbation Purchasing');
      const step = steps[idx];
      this.assertStepActor(ctx, step, pr.requesterId);
      steps[idx] = { ...step, status: 'DONE', actorId: ctx.userId, actorName: ctx.displayName, at: new Date().toISOString(), comment: dto.comment ?? null };
      const after = await this.core.bumpPr(tx, pr, dto.expectedVersion, { reviewCircuit: { ...circuit!, steps } as unknown as Prisma.InputJsonValue });
      await this.core.audit(ctx, { action: 'pr.step_endorsed', entityType: 'purchase_request', entityId: id, vesselId: pr.vesselId, after: { step: step.key }, metadata: { comment: dto.comment } }, tx);
      return after;
    });
  }

  private assertStepActor(ctx: AuthContext, step: AppliedReviewStep, requesterId: string) {
    if (!can(ctx, step.permission)) throw Errors.forbidden(`Étape « ${step.label} » : permission ${step.permission} requise`);
    if (step.roleKeys?.length && !step.roleKeys.some((r) => ctx.roleKeys.includes(r))) {
      throw Errors.forbidden(`Étape « ${step.label} » réservée aux rôles : ${step.roleKeys.join(', ')}`);
    }
    if (requesterId === ctx.userId) throw Errors.selfApproval();
  }

  async approve(ctx: AuthContext, id: string, dto: VersionDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      if (pr.status !== 'SUBMITTED' && pr.status !== 'UNDER_REVIEW') {
        if (pr.status === 'APPROVED' || pr.approvedAt) throw Errors.alreadyProcessed('PR déjà approuvée');
        throw Errors.invalidState(`Approbation impossible au statut ${pr.status}`);
      }
      // Séparation demandeur / validateur (même pour un Super Admin)
      if (pr.requesterId === ctx.userId) throw Errors.selfApproval();
      const circuit = pr.reviewCircuit as unknown as AppliedReviewCircuit | null;
      const steps = circuitSteps(circuit);
      if (steps.length) {
        const pendingBefore = steps.slice(0, -1).filter((s) => s.status !== 'DONE');
        if (pendingBefore.length) {
          throw Errors.business(`Circuit « ${circuit?.label} » : étape(s) en attente — ${pendingBefore.map((s) => s.label).join(', ')}`);
        }
        const last = steps[steps.length - 1];
        this.assertStepActor(ctx, last, pr.requesterId);
        steps[steps.length - 1] = { ...last, status: 'DONE', actorId: ctx.userId, actorName: ctx.displayName, at: new Date().toISOString(), comment: dto.comment ?? null };
      }
      const now = new Date();
      await this.core.bumpPr(tx, pr, dto.expectedVersion, {
        status: 'APPROVED',
        approvedById: ctx.userId,
        approvedAt: now,
        ...(steps.length ? { reviewCircuit: { ...circuit!, steps } as unknown as Prisma.InputJsonValue } : {}),
      });
      // Quantité approuvée = demandée, sauf lignes déjà révisées par une Counter-PR acceptée
      await tx.$executeRaw`UPDATE pr_lines SET quantity_approved = quantity_requested WHERE pr_id = ${id}::uuid AND quantity_approved IS NULL AND status = 'OPEN'`;
      if (dto.comment) await tx.prComment.create({ data: { prId: id, authorId: ctx.userId, body: dto.comment } });
      await this.core.audit(ctx, { action: 'pr.approved', entityType: 'purchase_request', entityId: id, vesselId: pr.vesselId, before: { status: pr.status }, after: { status: 'APPROVED', approvedAt: now }, metadata: { comment: dto.comment } }, tx);
      // Une RFQ peut déjà être en cours (consultation pendant la revue) => SOURCING
      await this.core.recomputePrStatuses(ctx, [id], tx, 'pr.approved');
      await this.notifyRequester(pr, `PR ${pr.number} validée par les Achats`, dto.comment ?? 'Prochaine étape : consultation éventuelle des fournisseurs puis bon de commande.', 'purchasing.pr_approved', tx);
      return tx.purchaseRequest.findUniqueOrThrow({ where: { id }, include: { lines: { orderBy: { lineNo: 'asc' } } } });
    });
  }

  /**
   * POST /purchase-requests/:id/split — décision « Diviser » (vaut validation) : les lignes entières sont réparties
   * dans des sous-PR validées (<n°>-A, -B…), une par fournisseur visé ; la PR mère passe « Divisée » en lecture
   * seule et se clôture quand toutes ses sous-PR sont terminées. Impossible une fois une RFQ ou un BC engagé.
   */
  async split(ctx: AuthContext, id: string, dto: SplitPrDto) {
    return this.core.serializable(async (tx) => {
      await this.core.findPr(ctx, id, tx);
      await this.core.lockPrLines(tx, id);
      const pr = await this.core.findPr(ctx, id, tx);
      if (pr.parentId) throw Errors.business('Une sous-PR ne se divise pas à nouveau : passez par un BC complémentaire chez un autre fournisseur');
      if (!PR_SPLITTABLE_STATUSES.includes(pr.status)) throw Errors.invalidState(`Division impossible au statut ${pr.status}`, { status: pr.status });
      // La division vaut validation : séparation demandeur / acheteur (même pour un Super Admin)
      if (pr.requesterId === ctx.userId) throw Errors.selfApproval();
      const circuit = pr.reviewCircuit as unknown as AppliedReviewCircuit | null;
      const steps = circuitSteps(circuit);
      const pendingBefore = steps.slice(0, -1).filter((st) => st.status !== 'DONE');
      if (pr.status !== 'APPROVED' && pendingBefore.length) {
        throw Errors.business(`Circuit « ${circuit?.label} » : étape(s) en attente — ${pendingBefore.map((st) => st.label).join(', ')}`);
      }
      if (await tx.prRevision.count({ where: { prId: id, status: 'PROPOSED' } })) throw Errors.conflict('Une Counter-PR proposée attend une décision');
      const lines = await tx.prLine.findMany({ where: { prId: id }, orderBy: { lineNo: 'asc' } });
      const allocated = await tx.poLineAllocation.count({
        where: { prLine: { prId: id }, poLine: { status: { not: 'CANCELLED' }, po: { status: { not: 'CANCELLED' } } } },
      });
      if (allocated) throw Errors.business('PR déjà engagée sur un bon de commande : division impossible');
      const rfqs = await tx.rfqLine.count({ where: { prLineId: { in: lines.map((l) => l.id) }, rfq: { status: { notIn: ['CLOSED', 'CANCELLED'] } } } });
      if (rfqs) throw Errors.business('Consultation (RFQ) en cours sur cette PR : clôturez ou annulez la RFQ avant de diviser');

      const plan = planSplit(lines, dto.groups);
      const now = new Date();
      if (steps.length && pr.status !== 'APPROVED') {
        const last = steps[steps.length - 1];
        steps[steps.length - 1] = { ...last, status: 'DONE', actorId: ctx.userId, actorName: ctx.displayName, at: now.toISOString(), comment: dto.comment ?? 'Division en sous-PR' };
      }
      const appliedCircuit = circuit ? ({ ...circuit, steps } as unknown as Prisma.InputJsonValue) : undefined;
      const children: { id: string; number: string; subject: string; label: string | null; lineCount: number }[] = [];
      for (const g of plan) {
        const child = await tx.purchaseRequest.create({
          data: {
            number: `${pr.number}-${g.suffix}`,
            vesselId: pr.vesselId,
            departmentId: pr.departmentId,
            requesterId: pr.requesterId,
            requestDate: pr.requestDate,
            category: pr.category,
            priority: pr.priority,
            neededBy: pr.neededBy,
            subject: (g.label ? `${pr.subject} — ${g.label}` : pr.subject).slice(0, 300),
            comment: pr.comment,
            formRef: pr.formRef,
            status: 'APPROVED',
            reviewCircuit: appliedCircuit,
            submittedAt: pr.submittedAt,
            approvedById: ctx.userId,
            approvedAt: now,
            parentId: pr.id,
            lines: {
              createMany: {
                data: g.lines.map((l, i) => ({
                  lineNo: i + 1,
                  designation: l.designation,
                  reference: l.reference,
                  quantityRequested: l.quantityRequested,
                  unit: l.unit,
                  rob: l.rob,
                  remarks: l.remarks,
                  catalogItemId: l.catalogItemId,
                  quantityApproved: l.effective,
                  sourceLineId: l.id,
                })),
              },
            },
          },
        });
        children.push({ id: child.id, number: child.number, subject: child.subject, label: g.label, lineCount: g.lines.length });
        await this.core.audit(
          ctx,
          {
            action: 'pr.created_from_split',
            entityType: 'purchase_request',
            entityId: child.id,
            vesselId: pr.vesselId,
            after: { number: child.number, status: 'APPROVED', parentId: pr.id },
            metadata: { parentNumber: pr.number, label: g.label, sourceLines: g.lines.map((l) => ({ lineNo: l.lineNo, quantity: fmtQty(l.effective) })) },
          },
          tx,
        );
      }
      const after = await this.core.bumpPr(tx, pr, dto.expectedVersion, {
        status: 'SPLIT',
        approvedById: ctx.userId,
        approvedAt: now,
        ...(appliedCircuit ? { reviewCircuit: appliedCircuit } : {}),
      });
      if (dto.comment) await tx.prComment.create({ data: { prId: id, authorId: ctx.userId, body: dto.comment } });
      await this.core.audit(
        ctx,
        {
          action: 'pr.split',
          entityType: 'purchase_request',
          entityId: id,
          vesselId: pr.vesselId,
          before: { status: pr.status },
          after: { status: 'SPLIT' },
          metadata: { comment: dto.comment, children: children.map((c) => ({ id: c.id, number: c.number, label: c.label, lineCount: c.lineCount })) },
        },
        tx,
      );
      await this.notifyRequester(
        pr,
        `PR ${pr.number} divisée en ${children.length} sous-PR`,
        children.map((c) => `${c.number}${c.label ? ` (${c.label})` : ''} : ${c.lineCount} ligne(s)`).join('\n') + (dto.comment ? `\n\n${dto.comment}` : ''),
        'purchasing.pr_split',
        tx,
        ctx.userId,
      );
      return { ...after, children };
    });
  }

  async reject(ctx: AuthContext, id: string, dto: RejectDto) {
    return this.simpleTransition(ctx, id, dto.expectedVersion, 'REJECTED', 'pr.rejected', dto.comment, {}, 'Rejet PR');
  }

  async hold(ctx: AuthContext, id: string, dto: ReasonDto) {
    return this.core.serializable(async (tx) => {
      await this.core.findPr(ctx, id, tx);
      await this.core.lockPrLines(tx, id);
      const pr = await this.core.findPr(ctx, id, tx);
      if (!PR_HOLDABLE_STATUSES.includes(pr.status)) throw Errors.invalidState(`Mise en attente impossible au statut ${pr.status}`);
      return this.transitionTx(ctx, tx, pr, dto.expectedVersion, 'ON_HOLD', 'pr.held', dto.reason, {});
    });
  }

  /** Reprise : retour en revue si non approuvée, sinon statut d'avancement recalculé. */
  async resume(ctx: AuthContext, id: string, dto: VersionDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      if (pr.status !== 'ON_HOLD') throw Errors.invalidState('Seule une PR en attente peut être reprise');
      const target: PrStatus = pr.approvedAt ? ((await this.core.derivePrStatus(id, tx)) ?? 'APPROVED') : 'UNDER_REVIEW';
      return this.transitionTx(ctx, tx, pr, dto.expectedVersion, target, 'pr.resumed', dto.comment ?? null, {});
    });
  }

  async cancel(ctx: AuthContext, id: string, dto: ReasonDto) {
    return this.core.serializable(async (tx) => {
      await this.core.findPr(ctx, id, tx);
      // Même verrou que la création de BC : pas d'allocation concurrente pendant l'annulation
      await this.core.lockPrLines(tx, id);
      const pr = await this.core.findPr(ctx, id, tx);
      // Le demandeur peut abandonner son propre brouillon (pr.edit) ; sinon pr.cancel
      if (!(pr.status === 'DRAFT' && pr.requesterId === ctx.userId && can(ctx, 'pr.edit'))) this.access.assertCan(ctx, 'pr.cancel');
      if (!PR_CANCELLABLE_STATUSES.includes(pr.status)) throw Errors.invalidState(`Annulation impossible au statut ${pr.status} (utilisez une révision puis la clôture)`);
      const allocated = await tx.poLineAllocation.count({
        where: { prLine: { prId: id }, poLine: { status: { not: 'CANCELLED' }, po: { status: { not: 'CANCELLED' } } } },
      });
      if (allocated) throw Errors.business('PR liée à des bons de commande actifs : annulez ou révisez les BC d’abord');
      const after = await this.transitionTx(ctx, tx, pr, dto.expectedVersion, 'CANCELLED', 'pr.cancelled', dto.reason, { cancelledAt: new Date(), cancelReason: dto.reason });
      await this.notifyRequester(pr, `PR ${pr.number} annulée`, dto.reason, 'purchasing.pr_cancelled', tx, ctx.userId);
      return after;
    });
  }

  /** Clôture (droits de clôture « À CONFIRMER » : pr.approve) — motif obligatoire si la PR n'est pas entièrement reçue. */
  async close(ctx: AuthContext, id: string, dto: CloseDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      if (!PR_CLOSABLE_STATUSES.includes(pr.status)) throw Errors.invalidState(`Clôture impossible au statut ${pr.status}`);
      if (pr.status !== 'RECEIVED' && !dto.reason) throw Errors.validation('Clôture d’une PR non entièrement reçue : décision documentée (motif) obligatoire');
      return this.transitionTx(ctx, tx, pr, dto.expectedVersion, 'CLOSED', 'pr.closed', dto.reason ?? null, { closedAt: new Date() });
    });
  }

  private async simpleTransition(
    ctx: AuthContext,
    id: string,
    expectedVersion: number,
    to: PrStatus,
    action: string,
    comment: string | null | undefined,
    data: Prisma.PurchaseRequestUncheckedUpdateManyInput,
    label: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, id, tx);
      assertTransition(PR_TRANSITIONS, pr.status, to, label);
      const after = await this.transitionTx(ctx, tx, pr, expectedVersion, to, action, comment ?? null, data);
      if (to === 'REJECTED') await this.notifyRequester(pr, `PR ${pr.number} rejetée`, comment ?? undefined, 'purchasing.pr_rejected', tx);
      return after;
    });
  }

  private async transitionTx(
    ctx: AuthContext,
    tx: Tx,
    pr: { id: string; status: PrStatus; vesselId: string; lockVersion: number },
    expectedVersion: number,
    to: PrStatus,
    action: string,
    comment: string | null,
    data: Prisma.PurchaseRequestUncheckedUpdateManyInput,
  ) {
    assertTransition(PR_TRANSITIONS, pr.status, to, 'PR');
    const after = await this.core.bumpPr(tx, pr, expectedVersion, { ...data, status: to });
    if (comment) await tx.prComment.create({ data: { prId: pr.id, authorId: ctx.userId, body: comment } });
    await this.core.audit(ctx, { action, entityType: 'purchase_request', entityId: pr.id, vesselId: pr.vesselId, before: { status: pr.status }, after: { status: to }, metadata: { comment } }, tx);
    return after;
  }

  private async notifyRequester(
    pr: { id: string; number: string; requesterId: string; vesselId: string },
    title: string,
    body: string | undefined,
    type: string,
    tx: Tx,
    excludeUserId?: string,
  ) {
    await this.notifications.notify(
      {
        userIds: [pr.requesterId],
        excludeUserIds: excludeUserId ? [excludeUserId] : undefined,
        type,
        title,
        body,
        module: 'purchasing',
        entityType: 'purchase_request',
        entityId: pr.id,
        vesselId: pr.vesselId,
        link: LINKS.pr(pr.id),
        email: true,
        requiredPermission: 'pr.view',
      },
      tx,
    );
  }

  // ---------------------------------------------------------------------------
  // Fil de discussion
  // ---------------------------------------------------------------------------

  async comments(ctx: AuthContext, id: string) {
    await this.core.findPr(ctx, id);
    const rows = await this.prisma.prComment.findMany({ where: { prId: id }, orderBy: { createdAt: 'asc' } });
    const names = await this.core.userNames(rows.map((r) => r.authorId));
    return rows.map((r) => ({ ...r, authorName: names.get(r.authorId) ?? null }));
  }

  async addComment(ctx: AuthContext, id: string, dto: CommentDto) {
    const pr = await this.core.findPr(ctx, id);
    if (dto.revisionId) {
      const rev = await this.prisma.prRevision.findFirst({ where: { id: dto.revisionId, prId: id }, select: { id: true } });
      if (!rev) throw Errors.notFound('Révision');
    }
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.prComment.create({ data: { prId: id, revisionId: dto.revisionId ?? null, authorId: ctx.userId, body: dto.body } });
      await this.core.audit(ctx, { action: 'pr.comment_added', entityType: 'purchase_request', entityId: id, vesselId: pr.vesselId, after: { commentId: c.id, revisionId: c.revisionId } }, tx);
      await this.notifyRequester(pr, `Nouveau commentaire sur la PR ${pr.number}`, dto.body.slice(0, 500), 'purchasing.pr_comment', tx, ctx.userId);
      return { ...c, authorName: ctx.displayName };
    });
  }

  // ---------------------------------------------------------------------------
  // PDF à la demande (stocké + lien signé)
  // ---------------------------------------------------------------------------

  async pdf(ctx: AuthContext, id: string, download: boolean) {
    const pr = await this.core.findPr(ctx, id);
    const file = await this.docs.storePr(ctx, id, pr.vesselId);
    await this.core.audit(ctx, { action: 'pr.pdf_generated', entityType: 'purchase_request', entityId: id, vesselId: pr.vesselId, metadata: { fileId: file.id } });
    return { fileId: file.id, ...(await this.files.issueLink(ctx, file, download ? 'download' : 'preview')) };
  }
}
