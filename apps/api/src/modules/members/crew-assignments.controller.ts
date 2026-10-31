import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  CancelAssignmentDto,
  CertificateCheckQuery,
  JoinAssignmentDto,
  ListAssignmentsQuery,
  PlanAssignmentDto,
  PlanVesselAssignmentDto,
  RosterQuery,
  SignOffAssignmentDto,
  UpdateAssignmentDto,
} from './crew-assignments.dto';
import { CrewAssignmentsService } from './crew-assignments.service';

/** Affectations d'équipage (CDC V1 §5.2) : transitions par commandes, scope navire vérifié sur chaque affectation. */
@ApiTags('Fleet — Crew assignments')
@Controller('crew-assignments')
export class CrewAssignmentsController {
  constructor(private readonly crew: CrewAssignmentsService) {}

  @Get()
  @RequireAnyPermission('members.view', 'vessel_crew.assign')
  list(@Auth() ctx: AuthContext, @Query() q: ListAssignmentsQuery) {
    return this.crew.list(ctx, q);
  }

  /** Planification (PLANNED). */
  @Post()
  @RequirePermissions('vessel_crew.assign')
  plan(@Auth() ctx: AuthContext, @Body() dto: PlanAssignmentDto) {
    return this.crew.plan(ctx, dto);
  }

  /**
   * Prévisualisation, avant confirmation, des certificats du marin expirés ou expirant avant la fin
   * de la période d'embarquement (non bloquant). Déclarée avant `:id`.
   */
  @Get('certificate-check')
  @RequirePermissions('vessel_crew.assign')
  certificateCheck(@Auth() ctx: AuthContext, @Query() q: CertificateCheckQuery) {
    return this.crew.certificateCheck(ctx, q);
  }

  @Get(':id')
  @RequireAnyPermission('members.view', 'vessel_crew.assign')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.crew.get(ctx, id);
  }

  @Patch(':id')
  @RequirePermissions('vessel_crew.assign')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateAssignmentDto) {
    return this.crew.update(ctx, id, dto);
  }

  /** Embarquement confirmé (ONBOARD, actualJoinDate) — 409 si déjà embarqué ailleurs. */
  @Post(':id/join')
  @RequirePermissions('vessel_crew.assign')
  join(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: JoinAssignmentDto) {
    return this.crew.join(ctx, id, dto);
  }

  /** Débarquement (COMPLETED, actualSignOffDate). */
  @Post(':id/sign-off')
  @RequirePermissions('vessel_crew.assign')
  signOff(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SignOffAssignmentDto) {
    return this.crew.signOff(ctx, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('vessel_crew.assign')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelAssignmentDto) {
    return this.crew.cancel(ctx, id, dto.reason);
  }
}

/** Crew roster par navire (et par date) — onglet « Crew » du Vessel Workspace. */
@ApiTags('Fleet — Crew assignments')
@Controller('vessels/:vesselId/crew')
export class VesselCrewController {
  constructor(private readonly crew: CrewAssignmentsService) {}

  /** ?date=AAAA-MM-JJ : personnes à bord ce jour-là (équipage historique ou futur planifié). */
  @Get()
  @RequireAnyPermission('members.view', 'vessel_crew.assign')
  roster(@Auth() ctx: AuthContext, @Param('vesselId', ParseUUIDPipe) vesselId: string, @Query() q: RosterQuery) {
    return this.crew.roster(ctx, vesselId, q.date);
  }

  @Post()
  @RequirePermissions('vessel_crew.assign')
  plan(@Auth() ctx: AuthContext, @Param('vesselId', ParseUUIDPipe) vesselId: string, @Body() dto: PlanVesselAssignmentDto) {
    return this.crew.plan(ctx, { ...dto, vesselId });
  }
}
