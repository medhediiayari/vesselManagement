import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { VoyageItineraryService } from './voyage-itinerary.service';
import {
  CancelVoyageDto,
  CreateAgentDto,
  CreateCargoDto,
  CreatePortDto,
  CreateVoyageDto,
  ListVoyagesQuery,
  PlanVoyageDto,
  ReorderPortsDto,
  UpdateAgentDto,
  UpdateCargoDto,
  UpdatePortDto,
  UpdateVoyageDto,
  VoyageCommandDto,
} from './voyages.dto';
import { VoyagesService } from './voyages.service';

/**
 * Voyages (CDC §7.1, §11 « GET/POST /voyages ; POST /voyages/{id}/ports ») :
 * workspace, commandes d'état, escales, agents, cargaisons, timeline, contrôle certificats.
 */
@ApiTags('Voyages')
@Controller('voyages')
export class VoyagesController {
  constructor(
    private readonly voyages: VoyagesService,
    private readonly itinerary: VoyageItineraryService,
  ) {}

  @Get()
  @RequirePermissions('voyages.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListVoyagesQuery) {
    return this.voyages.list(ctx, q);
  }

  @Post()
  @RequirePermissions('voyages.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateVoyageDto) {
    return this.voyages.create(ctx, dto);
  }

  /** Workspace : overview, escales & agents, cargo, notices & NOR, CP*, instructions, noon*, fichiers, tâches, timeline. */
  @Get(':id')
  @RequirePermissions('voyages.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.voyages.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('voyages.edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateVoyageDto) {
    return this.voyages.update(ctx, id, dto);
  }

  // ----- Commandes d'état (DRAFT → PLANNED → ACTIVE → COMPLETED ; DRAFT/PLANNED → CANCELLED)

  @Post(':id/plan')
  @RequirePermissions('voyages.activate')
  plan(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: PlanVoyageDto) {
    return this.voyages.command(ctx, id, 'plan', dto);
  }

  @Post(':id/activate')
  @RequirePermissions('voyages.activate')
  activate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoyageCommandDto) {
    return this.voyages.command(ctx, id, 'activate', dto);
  }

  @Post(':id/complete')
  @RequirePermissions('voyages.close')
  complete(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VoyageCommandDto) {
    return this.voyages.command(ctx, id, 'complete', dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('voyages.close')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelVoyageDto) {
    return this.voyages.command(ctx, id, 'cancel', dto);
  }

  @Get(':id/timeline')
  @RequirePermissions('voyages.view')
  timeline(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.voyages.timeline(ctx, id);
  }

  /** Contrôle INFORMATIF des certificats navire expirant avant la fin du voyage (CDC §7.4). */
  @Get(':id/certificate-check')
  @RequirePermissions('voyages.view')
  certificateCheck(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.voyages.certificateCheck(ctx, id);
  }

  // ----- Escales

  @Get(':id/ports')
  @RequirePermissions('voyages.view')
  ports(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.itinerary.listPorts(ctx, id);
  }

  @Post(':id/ports')
  @RequirePermissions('voyages.edit')
  addPort(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreatePortDto) {
    return this.itinerary.addPort(ctx, id, dto);
  }

  /** Réordonnancement : liste complète des escales dans le nouvel ordre. */
  @Put(':id/ports/order')
  @RequirePermissions('voyages.edit')
  reorderPorts(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReorderPortsDto) {
    return this.itinerary.reorderPorts(ctx, id, dto);
  }

  @Patch(':id/ports/:portId')
  @RequirePermissions('voyages.edit')
  updatePort(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('portId', ParseUUIDPipe) portId: string,
    @Body() dto: UpdatePortDto,
  ) {
    return this.itinerary.updatePort(ctx, id, portId, dto);
  }

  @Delete(':id/ports/:portId')
  @RequirePermissions('voyages.edit')
  removePort(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('portId', ParseUUIDPipe) portId: string) {
    return this.itinerary.removePort(ctx, id, portId);
  }

  // ----- Agents

  @Get(':id/agents')
  @RequirePermissions('voyages.view')
  agents(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.itinerary.listAgents(ctx, id);
  }

  @Post(':id/agents')
  @RequirePermissions('voyages.edit')
  addAgent(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateAgentDto) {
    return this.itinerary.addAgent(ctx, id, dto);
  }

  @Patch(':id/agents/:agentId')
  @RequirePermissions('voyages.edit')
  updateAgent(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('agentId', ParseUUIDPipe) agentId: string,
    @Body() dto: UpdateAgentDto,
  ) {
    return this.itinerary.updateAgent(ctx, id, agentId, dto);
  }

  @Delete(':id/agents/:agentId')
  @RequirePermissions('voyages.edit')
  removeAgent(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('agentId', ParseUUIDPipe) agentId: string) {
    return this.itinerary.removeAgent(ctx, id, agentId);
  }

  // ----- Cargaisons

  @Get(':id/cargo')
  @RequirePermissions('voyages.view')
  cargo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.itinerary.listCargo(ctx, id);
  }

  @Post(':id/cargo')
  @RequirePermissions('voyages.edit')
  addCargo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateCargoDto) {
    return this.itinerary.addCargo(ctx, id, dto);
  }

  @Patch(':id/cargo/:cargoId')
  @RequirePermissions('voyages.edit')
  updateCargo(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cargoId', ParseUUIDPipe) cargoId: string,
    @Body() dto: UpdateCargoDto,
  ) {
    return this.itinerary.updateCargo(ctx, id, cargoId, dto);
  }

  @Delete(':id/cargo/:cargoId')
  @RequirePermissions('voyages.edit')
  removeCargo(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('cargoId', ParseUUIDPipe) cargoId: string) {
    return this.itinerary.removeCargo(ctx, id, cargoId);
  }
}
