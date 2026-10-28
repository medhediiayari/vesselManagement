import { Injectable } from '@nestjs/common';
import { Prisma, PrRevisionLine, PrStatus } from '@prisma/client';
import { Errors } from '../../common/errors';
import { Db, PrismaService, Tx } from '../../prisma/prisma.service';
import { AccessService } from '../access/access.service';
import type { AuthContext } from '../access/auth-context';
import { NotificationsService } from '../notifications/notifications.service';
import { ApplyCounterDto, ProposeRevisionDto, RevisionDecisionDto, WithdrawRevisionDto } from './purchase-requests.dto';
import { PurchasingCore } from './purchasing-core.service';
import { LINKS } from './purchasing.constants';
import {
  PR_PROGRESS_STATUSES,
  PR_REVISABLE_STATUSES,
  RevisionCurrentLine,
  applyRevisionLine,
  diffRevision,
  fmtQty,
  planRevision,
} from './purchasing.logic';

type HeaderField = 'neededBy' | 'priority' | 'subject' | 'category';
type HeaderChanges = Partial<Record<HeaderField, { before: string | null; after: string | null }>>;

const HEADER_LABELS: Record<HeaderField, string> = { neededBy: 'Date de besoin', priority: 'Priorité', subject: 'Objet', category: 'Catégorie' };

function dayIso(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Counter-PR / Revised PR (CDC §6.4, PUR-02) : révision versionnée qui n'écrase jamais la PR d'origine.
 * Depuis la refonte du 22/10/2026, l'acheteur l'APPLIQUE DIRECTEMENT (applyCounter : motif facultatif, demandeur
 * notifié, avant / après conservé) ; l'ancien parcours « proposition puis décision » reste lisible et utilisable.
 * Seules les quantités de travail évoluent (quantity_approved / quantity_cancelled / nouvelles lignes) ; l'en-tête
 * (date de besoin, priorité, objet, catégorie) peut aussi être ajusté, le « avant » étant tracé dans header_changes.
 */
@Injectable()
export class PrRevisionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly core: PurchasingCore,
    private readonly access: AccessService,
    private readonly notifications: NotificationsService,
  ) {}

  private async currentLines(prId: string, db: Db = this.prisma): Promise<RevisionCurrentLine[]> {
    const lines = await db.prLine.findMany({ where: { prId }, orderBy: { lineNo: 'asc' } });
    const allocated = await this.core.allocatedByPrLine(lines.map((l) => l.id), db);
    return lines.map((l) => ({ ...l, allocated: allocated.get(l.id) ?? 0 }));
  }

  async list(ctx: AuthContext, prId: string) {
    await this.core.findPr(ctx, prId);
    const revs = await this.prisma.prRevision.findMany({ where: { prId }, orderBy: { revisionNo: 'desc' }, include: { lines: true } });
    const names = await this.core.userNames(revs.flatMap((r) => [r.proposedById, r.decidedById]));
    return revs.map((r) => ({ ...r, proposedByName: names.get(r.proposedById) ?? null, decidedByName: r.decidedById ? names.get(r.decidedById) ?? null : null }));
  }

  async get(ctx: AuthContext, prId: string, revisionId: string) {
    await this.core.findPr(ctx, prId);
    const rev = await this.prisma.prRevision.findFirst({ where: { id: revisionId, prId }, include: { lines: true } });
    if (!rev) throw Errors.notFound('Révision');
    const comments = await this.prisma.prComment.findMany({ where: { prId, revisionId }, orderBy: { createdAt: 'asc' } });
    const names = await this.core.userNames([rev.proposedById, rev.decidedById, ...comments.map((c) => c.authorId)]);
    return {
      ...rev,
      proposedByName: names.get(rev.proposedById) ?? null,
      decidedByName: rev.decidedById ? names.get(rev.decidedById) ?? null : null,
      comments: comments.map((c) => ({ ...c, authorName: names.get(c.authorId) ?? null })),
      diff: await this.diffLines(prId, rev.lines),
    };
  }

  /** Différence ligne à ligne : PR d'origine (immuable) vs proposition révisée (PUR-02). */
  async diff(ctx: AuthContext, prId: string, revisionId: string) {
    const pr = await this.core.findPr(ctx, prId);
    const rev = await this.prisma.prRevision.findFirst({ where: { id: revisionId, prId }, include: { lines: true } });
    if (!rev) throw Errors.notFound('Révision');
    return {
      prId,
      prNumber: pr.number,
      revisionId: rev.id,
      revisionNo: rev.revisionNo,
      status: rev.status,
      justification: rev.justification,
      lines: await this.diffLines(prId, rev.lines),
    };
  }

  private async diffLines(prId: string, revLines: { prLineId: string | null; action: 'KEEP' | 'CHANGE' | 'ADD' | 'REMOVE'; designation: string; reference: string | null; quantity: unknown; unit: string; remarks: string | null }[]) {
    const original = await this.prisma.prLine.findMany({ where: { prId }, orderBy: { lineNo: 'asc' } });
    const order = new Map(original.map((l) => [l.id, l.lineNo]));
    const sorted = [...revLines].sort((a, b) => (order.get(a.prLineId ?? '') ?? 1e9) - (order.get(b.prLineId ?? '') ?? 1e9));
    const diff = diffRevision(
      original,
      sorted.map((l) => ({ ...l, quantity: String(l.quantity) })),
    );
    // Valeurs de travail courantes (après éventuelles révisions acceptées)
    return diff.map((d) => {
      const cur = d.prLineId ? original.find((o) => o.id === d.prLineId) : null;
      return {
        ...d,
        current: cur
          ? { quantityApproved: cur.quantityApproved === null ? null : fmtQty(cur.quantityApproved), quantityCancelled: fmtQty(cur.quantityCancelled), status: cur.status }
          : null,
      };
    });
  }

  async propose(ctx: AuthContext, prId: string, dto: ProposeRevisionDto) {
    return this.core.serializable(async (tx) => {
      await this.core.findPr(ctx, prId, tx);
      await this.core.lockPrLines(tx, prId);
      const pr = await this.core.findPr(ctx, prId, tx);
      if (!PR_REVISABLE_STATUSES.includes(pr.status)) throw Errors.invalidState(`Counter-PR impossible au statut ${pr.status}`);
      const open = await tx.prRevision.count({ where: { prId, status: 'PROPOSED' } });
      if (open) throw Errors.conflict('Une proposition révisée est déjà en attente de décision');
      const current = await this.currentLines(prId, tx);
      const plan = planRevision(
        current,
        dto.lines.map((l) => ({ ...l, quantity: l.quantity })),
      );
      const last = await tx.prRevision.aggregate({ where: { prId }, _max: { revisionNo: true } });
      const revisionNo = (last._max.revisionNo ?? 0) + 1;
      const rev = await tx.prRevision.create({
        data: {
          prId,
          revisionNo,
          kind: dto.kind,
          status: 'PROPOSED',
          justification: dto.justification ?? null,
          proposedById: ctx.userId,
          lines: { create: plan.lines.map((l) => ({ ...l })) },
        },
        include: { lines: true },
      });
      await this.core.bumpPr(tx, pr, dto.expectedVersion, { status: 'REVISED' });
      await this.core.audit(
        ctx,
        {
          action: 'pr.revision_proposed',
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          before: { status: pr.status },
          after: { status: 'REVISED', revisionNo },
          metadata: { revisionId: rev.id, kind: dto.kind, justification: dto.justification, changes: plan.changes, previousStatus: pr.status },
        },
        tx,
      );
      const deciders = await this.access.usersWithPermission('pr.approve', pr.vesselId, tx);
      await this.notifications.notify(
        {
          userIds: [...deciders, pr.requesterId],
          excludeUserIds: [ctx.userId],
          type: 'purchasing.pr_revision_proposed',
          title: `Counter-PR n°${revisionNo} proposée sur ${pr.number}`,
          body: dto.justification ?? undefined,
          module: 'purchasing',
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          link: LINKS.pr(prId),
          dedupeKey: `pr:${prId}:revision:${revisionNo}`,
          email: true,
          requiredPermission: 'pr.view',
        },
        tx,
      );
      return rev;
    });
  }

  /** Statut de la PR à la sortie de REVISED : revue si non approuvée, sinon avancement recalculé. */
  private async restoredStatus(prId: string, approvedAt: Date | null, tx: Db): Promise<PrStatus> {
    if (!approvedAt) return 'UNDER_REVIEW';
    return (await this.core.derivePrStatus(prId, tx)) ?? 'APPROVED';
  }

  async decide(ctx: AuthContext, prId: string, revisionId: string, dto: RevisionDecisionDto) {
    return this.core.serializable(async (tx) => {
      await this.core.findPr(ctx, prId, tx);
      await this.core.lockPrLines(tx, prId);
      const pr = await this.core.findPr(ctx, prId, tx);
      const rev = await tx.prRevision.findFirst({ where: { id: revisionId, prId }, include: { lines: true } });
      if (!rev) throw Errors.notFound('Révision');
      if (rev.status !== 'PROPOSED') throw Errors.alreadyProcessed(`Révision déjà traitée (${rev.status})`);
      // Anti-contournement : la décision est prise par une autre personne que le proposant (acteur tracé)
      if (rev.proposedById === ctx.userId) throw Errors.selfApproval();
      if (pr.status !== 'REVISED') throw Errors.invalidState(`PR au statut ${pr.status} : décision impossible`);
      const now = new Date();

      const addedLines = dto.decision === 'ACCEPT' ? await this.applyLines(tx, prId, rev.id, rev.lines) : 0;

      const status = dto.decision === 'ACCEPT' ? 'ACCEPTED' : dto.decision === 'REJECT' ? 'REJECTED' : 'CORRECTION_REQUESTED';
      const upd = await tx.prRevision.updateMany({
        where: { id: rev.id, status: 'PROPOSED' },
        data: { status, decidedById: ctx.userId, decidedAt: now, decisionComment: dto.comment ?? null },
      });
      if (!upd.count) throw Errors.alreadyProcessed('Révision déjà traitée');
      if (dto.comment) await tx.prComment.create({ data: { prId, revisionId: rev.id, authorId: ctx.userId, body: dto.comment } });
      const target = await this.restoredStatus(prId, pr.approvedAt, tx);
      await this.core.bumpPr(tx, pr, dto.expectedVersion, {
        status: target,
        ...(dto.decision === 'ACCEPT' ? { currentRevisionNo: rev.revisionNo } : {}),
      });
      await this.core.audit(
        ctx,
        {
          action: `pr.revision_${status.toLowerCase()}`,
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          before: { status: pr.status, revisionStatus: 'PROPOSED' },
          after: { status: target, revisionStatus: status },
          metadata: { revisionId: rev.id, revisionNo: rev.revisionNo, decidedBy: ctx.userId, comment: dto.comment, addedLines, masterReapprovalRequired: false },
        },
        tx,
      );
      await this.notifications.notify(
        {
          userIds: [rev.proposedById, pr.requesterId],
          excludeUserIds: [ctx.userId],
          type: 'purchasing.pr_revision_decided',
          title: `Counter-PR n°${rev.revisionNo} sur ${pr.number} : ${status === 'ACCEPTED' ? 'acceptée' : status === 'REJECTED' ? 'refusée' : 'correction demandée'}`,
          body: dto.comment ?? undefined,
          module: 'purchasing',
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          link: LINKS.pr(prId),
          email: true,
          requiredPermission: 'pr.view',
        },
        tx,
      );
      return { ...(await tx.prRevision.findUniqueOrThrow({ where: { id: rev.id }, include: { lines: true } })), prStatus: target };
    });
  }

  /** Applique les lignes d'une révision acceptée (quantités de travail, annulations, ajouts). Retourne le nombre d'ajouts. */
  private async applyLines(tx: Tx, prId: string, revisionId: string, revLines: PrRevisionLine[]): Promise<number> {
    const current = await this.currentLines(prId, tx);
    const byId = new Map(current.map((l) => [l.id, l]));
    let nextNo = Math.max(0, ...current.map((l) => l.lineNo)) + 1;
    let added = 0;
    for (const rl of revLines) {
      if (rl.action === 'ADD') {
        await tx.prLine.create({
          data: {
            prId,
            lineNo: nextNo++,
            designation: rl.designation,
            reference: rl.reference,
            quantityRequested: rl.quantity,
            unit: rl.unit,
            remarks: rl.remarks,
            addedByRevisionId: revisionId,
            quantityApproved: rl.quantity,
          },
        });
        added++;
        continue;
      }
      const line = rl.prLineId ? byId.get(rl.prLineId) : undefined;
      if (!line) continue;
      const op = applyRevisionLine(line, rl.action, rl.quantity);
      if (op) {
        await tx.prLine.update({
          where: { id: op.prLineId },
          data: { quantityApproved: op.quantityApproved, quantityCancelled: op.quantityCancelled, status: op.status },
        });
      }
    }
    return added;
  }

  /**
   * POST /purchase-requests/:id/counter — Counter-PR appliquée immédiatement par l'acheteur (décision « Counter-PR »
   * en discussion, valant validation des autres lignes) : révision ACCEPTED tracée, demandeur notifié avec le détail.
   * Une PR soumise passe « en discussion » ; une PR déjà validée garde son statut d'avancement (recalculé).
   */
  async applyCounter(ctx: AuthContext, prId: string, dto: ApplyCounterDto) {
    return this.core.serializable(async (tx) => {
      await this.core.findPr(ctx, prId, tx);
      await this.core.lockPrLines(tx, prId);
      const pr = await this.core.findPr(ctx, prId, tx);
      if (!PR_REVISABLE_STATUSES.includes(pr.status)) throw Errors.invalidState(`Counter-PR impossible au statut ${pr.status}`, { status: pr.status });
      // Appliquée sans second regard : jamais par le demandeur lui-même (séparation des rôles)
      if (pr.requesterId === ctx.userId) throw Errors.selfApproval();
      if (await tx.prRevision.count({ where: { prId, status: 'PROPOSED' } })) throw Errors.conflict('Une Counter-PR proposée attend déjà une décision');

      // En-tête : seuls les champs réellement modifiés sont tracés
      const headerChanges: HeaderChanges = {};
      const headerData: Prisma.PurchaseRequestUncheckedUpdateManyInput = {};
      const h = dto.header ?? {};
      if (h.neededBy !== undefined && dayIso(h.neededBy) !== dayIso(pr.neededBy)) {
        headerChanges.neededBy = { before: dayIso(pr.neededBy), after: dayIso(h.neededBy) };
        headerData.neededBy = h.neededBy;
      }
      for (const f of ['priority', 'subject', 'category'] as const) {
        const v = h[f];
        if (v !== undefined && v !== pr[f]) {
          headerChanges[f] = { before: pr[f], after: v };
          headerData[f] = v;
        }
      }
      if (h.neededBy && h.neededBy.getTime() < pr.requestDate.getTime()) {
        throw Errors.validation('La date de besoin ne peut pas précéder la date de la demande', { field: 'neededBy' });
      }
      const hasHeader = Object.keys(headerChanges).length > 0;

      const current = await this.currentLines(prId, tx);
      const plan = planRevision(current, dto.lines, { allowNoLineChange: hasHeader });
      const last = await tx.prRevision.aggregate({ where: { prId }, _max: { revisionNo: true } });
      const revisionNo = (last._max.revisionNo ?? 0) + 1;
      const now = new Date();
      const rev = await tx.prRevision.create({
        data: {
          prId,
          revisionNo,
          kind: 'COUNTER_PR',
          status: 'ACCEPTED',
          justification: dto.justification ?? null,
          proposedById: ctx.userId,
          decidedById: ctx.userId,
          decidedAt: now,
          decisionComment: 'Appliquée directement par les Achats',
          headerChanges: hasHeader ? (headerChanges as Prisma.InputJsonValue) : undefined,
          lines: { create: plan.lines.map((l) => ({ ...l })) },
        },
        include: { lines: true },
      });
      const addedLines = plan.changes ? await this.applyLines(tx, prId, rev.id, rev.lines) : 0;
      const status: PrStatus = pr.status === 'SUBMITTED' ? 'UNDER_REVIEW' : pr.status;
      await this.core.bumpPr(tx, pr, dto.expectedVersion, { ...headerData, status, currentRevisionNo: revisionNo });
      if (PR_PROGRESS_STATUSES.includes(status)) await this.core.recomputePrStatuses(ctx, [prId], tx, 'pr.counter_applied');
      if (dto.justification) await tx.prComment.create({ data: { prId, revisionId: rev.id, authorId: ctx.userId, body: `Counter-PR n°${revisionNo} : ${dto.justification}` } });

      const byId = new Map(current.map((l) => [l.id, l]));
      const summary = [
        ...rev.lines
          .filter((l) => l.action !== 'KEEP')
          .map((l) => {
            const o = l.prLineId ? byId.get(l.prLineId) : undefined;
            if (l.action === 'ADD') return `+ ${l.designation} : ${fmtQty(l.quantity)} ${l.unit}`;
            if (l.action === 'REMOVE') return `Ligne ${o?.lineNo ?? '?'} retirée : ${l.designation}`;
            return `Ligne ${o?.lineNo ?? '?'} ${l.designation} : ${o ? fmtQty(o.quantityApproved ?? o.quantityRequested) : '?'} → ${fmtQty(l.quantity)} ${l.unit}`;
          }),
        ...(Object.entries(headerChanges) as [HeaderField, { before: string | null; after: string | null }][]).map(
          ([f, c]) => `${HEADER_LABELS[f]} : ${c.before ?? '—'} → ${c.after ?? '—'}`,
        ),
      ];
      await this.core.audit(
        ctx,
        {
          action: 'pr.counter_applied',
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          before: { status: pr.status, ...Object.fromEntries(Object.entries(headerChanges).map(([k, v]) => [k, v!.before])) },
          after: { status, revisionNo, ...Object.fromEntries(Object.entries(headerChanges).map(([k, v]) => [k, v!.after])) },
          metadata: { revisionId: rev.id, justification: dto.justification, changes: plan.changes, addedLines, headerChanges, summary },
        },
        tx,
      );
      await this.notifications.notify(
        {
          userIds: [pr.requesterId],
          excludeUserIds: [ctx.userId],
          type: 'purchasing.pr_counter_applied',
          title: `Counter-PR appliquée sur votre PR ${pr.number}`,
          body: [dto.justification, summary.join('\n')].filter(Boolean).join('\n\n'),
          module: 'purchasing',
          entityType: 'purchase_request',
          entityId: prId,
          vesselId: pr.vesselId,
          link: LINKS.pr(prId),
          dedupeKey: `pr:${prId}:counter:${revisionNo}`,
          email: true,
          requiredPermission: 'pr.view',
        },
        tx,
      );
      return { ...rev, prStatus: status, summary };
    });
  }

  async withdraw(ctx: AuthContext, prId: string, revisionId: string, dto: WithdrawRevisionDto) {
    return this.prisma.$transaction(async (tx) => {
      const pr = await this.core.findPr(ctx, prId, tx);
      const rev = await tx.prRevision.findFirst({ where: { id: revisionId, prId } });
      if (!rev) throw Errors.notFound('Révision');
      if (rev.status !== 'PROPOSED') throw Errors.alreadyProcessed(`Révision déjà traitée (${rev.status})`);
      if (rev.proposedById !== ctx.userId) throw Errors.forbidden('Seul le proposant peut retirer sa proposition');
      await tx.prRevision.update({ where: { id: rev.id }, data: { status: 'WITHDRAWN', decidedAt: new Date(), decisionComment: dto.comment ?? null } });
      const target = await this.restoredStatus(prId, pr.approvedAt, tx);
      await this.core.bumpPr(tx, pr, dto.expectedVersion, { status: target });
      await this.core.audit(
        ctx,
        { action: 'pr.revision_withdrawn', entityType: 'purchase_request', entityId: prId, vesselId: pr.vesselId, before: { status: pr.status }, after: { status: target }, metadata: { revisionId: rev.id, comment: dto.comment } },
        tx,
      );
      return { id: rev.id, status: 'WITHDRAWN', prStatus: target };
    });
  }
}
