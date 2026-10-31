import { Injectable } from '@nestjs/common';
import { Prisma, VoyagePort } from '@prisma/client';
import { Errors } from '../../common/errors';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthContext } from '../access/auth-context';
import { AuditService, diffFields } from '../audit/audit.service';
import {
  CreateAgentDto,
  CreateCargoDto,
  CreatePortDto,
  ReorderPortsDto,
  UpdateAgentDto,
  UpdateCargoDto,
  UpdatePortDto,
} from './voyages.dto';
import { cargoQuantityWarnings, validateActualTimesNotFuture, validateCargoQuantities, validatePortOrder, validatePortTimes } from './voyages.logic';
import { VoyagesService } from './voyages.service';

const PORT_TIME_FIELDS = ['eta', 'ata', 'etd', 'atd'] as const;

/**
 * Escales (liste ordonnée), agents et cargaisons d'un voyage (CDC §7.1, V1 §10.1).
 * Toute mise à jour ETA/ATA/ETD/ATD est auditée champ par champ.
 */
@Injectable()
export class VoyageItineraryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly voyages: VoyagesService,
  ) {}

  private async openVoyage(ctx: AuthContext, voyageId: string) {
    const v = await this.voyages.getAccessible(ctx, voyageId);
    this.voyages.assertOpen(v);
    return v;
  }

  private async assertAgentOfVoyage(voyageId: string, agentId: string | null | undefined) {
    if (!agentId) return;
    const ok = await this.prisma.voyageAgent.count({ where: { id: agentId, voyageId } });
    if (!ok) throw Errors.validation('Agent inconnu pour ce voyage');
  }

  // ---------------------------------------------------------------------------
  // Escales
  // ---------------------------------------------------------------------------

  async listPorts(ctx: AuthContext, voyageId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    return this.prisma.voyagePort.findMany({
      where: { voyageId },
      orderBy: { sequence: 'asc' },
      include: { agent: { select: { id: true, name: true, role: true, city: true } }, _count: { select: { tasks: true, notices: true, nors: true } } },
    });
  }

  private async getPort(voyageId: string, portId: string): Promise<VoyagePort> {
    const p = await this.prisma.voyagePort.findFirst({ where: { id: portId, voyageId } });
    if (!p) throw Errors.notFound('Escale');
    return p;
  }

  async addPort(ctx: AuthContext, voyageId: string, dto: CreatePortDto) {
    const v = await this.openVoyage(ctx, voyageId);
    await this.assertAgentOfVoyage(voyageId, dto.agentId);
    const err = validatePortTimes(dto) ?? validateActualTimesNotFuture(dto);
    if (err) throw Errors.validation(err);
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.voyagePort.aggregate({ where: { voyageId }, _max: { sequence: true } });
      const port = await tx.voyagePort.create({
        data: { ...dto, voyageId, sequence: (last._max.sequence ?? 0) + 1 } as Prisma.VoyagePortUncheckedCreateInput,
      });
      await this.audit.record(
        ctx,
        { action: 'voyage.port_added', module: 'voyages', entityType: 'voyage_port', entityId: port.id, vesselId: v.vesselId, after: port, metadata: { voyageId } },
        tx,
      );
      return port;
    });
  }

  async updatePort(ctx: AuthContext, voyageId: string, portId: string, dto: UpdatePortDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.getPort(voyageId, portId);
    if (dto.agentId !== undefined) await this.assertAgentOfVoyage(voyageId, dto.agentId);
    const merged = {
      eta: dto.eta !== undefined ? dto.eta : before.eta,
      etd: dto.etd !== undefined ? dto.etd : before.etd,
      ata: dto.ata !== undefined ? dto.ata : before.ata,
      atd: dto.atd !== undefined ? dto.atd : before.atd,
    };
    // Dates réelles futures contrôlées sur les seules valeurs envoyées (audit FLT-06)
    const err = validatePortTimes(merged) ?? validateActualTimesNotFuture({ ata: dto.ata, atd: dto.atd });
    if (err) throw Errors.validation(err);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.voyagePort.update({ where: { id: portId }, data: dto as Prisma.VoyagePortUncheckedUpdateInput });
      const diff = diffFields(before as never, after as never);
      const timesChanged = PORT_TIME_FIELDS.filter((f) => diff.after && f in (diff.after as object));
      await this.audit.record(
        ctx,
        {
          action: timesChanged.length ? 'voyage.port_times_updated' : 'voyage.port_updated',
          module: 'voyages',
          entityType: 'voyage_port',
          entityId: portId,
          vesselId: v.vesselId,
          ...diff,
          metadata: { voyageId, portName: after.portName, ...(timesChanged.length ? { timesChanged } : {}) },
        },
        tx,
      );
      return after;
    });
  }

  /** Suppression d'une escale sans historique (ni NOR, ni tâches/notices, ni date réelle). */
  async removePort(ctx: AuthContext, voyageId: string, portId: string) {
    const v = await this.openVoyage(ctx, voyageId);
    const port = await this.getPort(voyageId, portId);
    if (port.ata || port.atd) throw Errors.business('Escale avec dates réelles (ATA/ATD) : suppression impossible');
    const [nors, tasks, notices] = await Promise.all([
      this.prisma.norRecord.count({ where: { portId } }),
      this.prisma.voyageTask.count({ where: { portId } }),
      this.prisma.voyageNotice.count({ where: { portId } }),
    ]);
    if (nors || tasks || notices) {
      throw Errors.conflict('Escale référencée (NOR, tâches ou notices) : réaffecter ou annuler ces éléments avant suppression', { nors, tasks, notices });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.voyagePort.delete({ where: { id: portId } });
      await this.audit.record(
        ctx,
        { action: 'voyage.port_removed', module: 'voyages', entityType: 'voyage_port', entityId: portId, vesselId: v.vesselId, before: port, metadata: { voyageId } },
        tx,
      );
    });
    return { removed: true };
  }

  /** Réordonnancement atomique (séquences temporaires négatives : unicité (voyage, séquence)). */
  async reorderPorts(ctx: AuthContext, voyageId: string, dto: ReorderPortsDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const ports = await this.prisma.voyagePort.findMany({ where: { voyageId }, orderBy: { sequence: 'asc' }, select: { id: true, portName: true } });
    const err = validatePortOrder(ports.map((p) => p.id), dto.portIds);
    if (err) throw Errors.validation(err);
    return this.prisma.$transaction(async (tx) => {
      for (const [i, id] of dto.portIds.entries()) await tx.voyagePort.update({ where: { id }, data: { sequence: -(i + 1) } });
      for (const [i, id] of dto.portIds.entries()) await tx.voyagePort.update({ where: { id }, data: { sequence: i + 1 } });
      const name = (id: string) => ports.find((p) => p.id === id)?.portName;
      await this.audit.record(
        ctx,
        {
          action: 'voyage.ports_reordered',
          module: 'voyages',
          entityType: 'voyage',
          entityId: voyageId,
          vesselId: v.vesselId,
          before: { order: ports.map((p) => p.portName) },
          after: { order: dto.portIds.map(name) },
        },
        tx,
      );
      return tx.voyagePort.findMany({ where: { voyageId }, orderBy: { sequence: 'asc' } });
    });
  }

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  async listAgents(ctx: AuthContext, voyageId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    return this.prisma.voyageAgent.findMany({
      where: { voyageId },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      include: { ports: { select: { id: true, portName: true, sequence: true } } },
    });
  }

  async addAgent(ctx: AuthContext, voyageId: string, dto: CreateAgentDto) {
    const v = await this.openVoyage(ctx, voyageId);
    return this.prisma.$transaction(async (tx) => {
      const agent = await tx.voyageAgent.create({ data: { ...dto, voyageId } as Prisma.VoyageAgentUncheckedCreateInput });
      await this.audit.record(
        ctx,
        { action: 'voyage.agent_added', module: 'voyages', entityType: 'voyage_agent', entityId: agent.id, vesselId: v.vesselId, after: agent, metadata: { voyageId } },
        tx,
      );
      return agent;
    });
  }

  async updateAgent(ctx: AuthContext, voyageId: string, agentId: string, dto: UpdateAgentDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.prisma.voyageAgent.findFirst({ where: { id: agentId, voyageId } });
    if (!before) throw Errors.notFound('Agent');
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.voyageAgent.update({ where: { id: agentId }, data: dto as Prisma.VoyageAgentUncheckedUpdateInput });
      await this.audit.record(
        ctx,
        { action: 'voyage.agent_updated', module: 'voyages', entityType: 'voyage_agent', entityId: agentId, vesselId: v.vesselId, ...diffFields(before as never, after as never), metadata: { voyageId } },
        tx,
      );
      return after;
    });
  }

  async removeAgent(ctx: AuthContext, voyageId: string, agentId: string) {
    const v = await this.openVoyage(ctx, voyageId);
    const agent = await this.prisma.voyageAgent.findFirst({ where: { id: agentId, voyageId }, include: { _count: { select: { ports: true } } } });
    if (!agent) throw Errors.notFound('Agent');
    if (agent._count.ports) throw Errors.conflict('Agent affecté à une escale : le retirer de l’escale avant suppression');
    const { _count, ...before } = agent;
    await this.prisma.$transaction(async (tx) => {
      await tx.voyageAgent.delete({ where: { id: agentId } });
      await this.audit.record(
        ctx,
        { action: 'voyage.agent_removed', module: 'voyages', entityType: 'voyage_agent', entityId: agentId, vesselId: v.vesselId, before, metadata: { voyageId } },
        tx,
      );
    });
    return { removed: true };
  }

  // ---------------------------------------------------------------------------
  // Cargaisons
  // ---------------------------------------------------------------------------

  async listCargo(ctx: AuthContext, voyageId: string) {
    await this.voyages.getAccessible(ctx, voyageId);
    const rows = await this.prisma.cargo.findMany({ where: { voyageId }, orderBy: { commodity: 'asc' } });
    return rows.map((c) => ({ ...c, warnings: cargoQuantityWarnings(c) }));
  }

  async addCargo(ctx: AuthContext, voyageId: string, dto: CreateCargoDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const err = validateCargoQuantities(dto);
    if (err) throw Errors.validation(err);
    return this.prisma.$transaction(async (tx) => {
      const cargo = await tx.cargo.create({ data: { ...dto, voyageId } as Prisma.CargoUncheckedCreateInput });
      await this.audit.record(
        ctx,
        { action: 'voyage.cargo_added', module: 'voyages', entityType: 'cargo', entityId: cargo.id, vesselId: v.vesselId, after: cargo, metadata: { voyageId } },
        tx,
      );
      return { ...cargo, warnings: cargoQuantityWarnings(cargo) };
    });
  }

  async updateCargo(ctx: AuthContext, voyageId: string, cargoId: string, dto: UpdateCargoDto) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.prisma.cargo.findFirst({ where: { id: cargoId, voyageId } });
    if (!before) throw Errors.notFound('Cargaison');
    const err = validateCargoQuantities({
      qtyMinMt: dto.qtyMinMt !== undefined ? dto.qtyMinMt : before.qtyMinMt,
      qtyMaxMt: dto.qtyMaxMt !== undefined ? dto.qtyMaxMt : before.qtyMaxMt,
      qtyActualMt: dto.qtyActualMt !== undefined ? dto.qtyActualMt : before.qtyActualMt,
    });
    if (err) throw Errors.validation(err);
    return this.prisma.$transaction(async (tx) => {
      const after = await tx.cargo.update({ where: { id: cargoId }, data: dto as Prisma.CargoUncheckedUpdateInput });
      await this.audit.record(
        ctx,
        { action: 'voyage.cargo_updated', module: 'voyages', entityType: 'cargo', entityId: cargoId, vesselId: v.vesselId, ...diffFields(before as never, after as never), metadata: { voyageId } },
        tx,
      );
      return { ...after, warnings: cargoQuantityWarnings(after) };
    });
  }

  async removeCargo(ctx: AuthContext, voyageId: string, cargoId: string) {
    const v = await this.openVoyage(ctx, voyageId);
    const before = await this.prisma.cargo.findFirst({ where: { id: cargoId, voyageId } });
    if (!before) throw Errors.notFound('Cargaison');
    await this.prisma.$transaction(async (tx) => {
      await tx.cargo.delete({ where: { id: cargoId } });
      await this.audit.record(
        ctx,
        { action: 'voyage.cargo_removed', module: 'voyages', entityType: 'cargo', entityId: cargoId, vesselId: v.vesselId, before, metadata: { voyageId } },
        tx,
      );
    });
    return { removed: true };
  }
}
