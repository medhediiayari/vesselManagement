import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CertificateTypesService } from './certificate-types.service';
import {
  CreateCertificateTypeDto,
  CreateReminderPolicyDto,
  ListCertificateTypesQuery,
  SetPrincipalsDto,
  UpdateCertificateTypeDto,
  UpdateReminderPolicyDto,
} from './certificates.dto';

/** Types de certificats et validateurs éligibles (ADM-051) — lecture : certificates.view. */
@ApiTags('Certificates — Configuration')
@Controller('certificate-types')
export class CertificateTypesController {
  constructor(private readonly types: CertificateTypesService) {}

  @Get()
  @RequirePermissions('certificates.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListCertificateTypesQuery) {
    return this.types.listTypes(ctx, q);
  }

  @Get(':id')
  @RequirePermissions('certificates.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.types.getType(ctx, id);
  }

  @Post()
  @RequirePermissions('certificates.types.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateCertificateTypeDto) {
    return this.types.createType(ctx, dto);
  }

  /** Validateurs proposés : personnes désignées ayant réellement le droit d'approuver (sélecteur). */
  @Post('validators/check')
  @RequirePermissions('certificates.types.manage')
  checkValidators(@Body() dto: SetPrincipalsDto) {
    return this.types.checkValidators(dto.principals);
  }

  @Patch(':id')
  @RequirePermissions('certificates.types.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCertificateTypeDto) {
    return this.types.updateType(ctx, id, dto);
  }

  /** Remplace la liste des validateurs (USER / ROLE / DEPARTMENT). */
  @Put(':id/validators')
  @RequirePermissions('certificates.types.manage')
  setValidators(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPrincipalsDto) {
    return this.types.setValidators(ctx, id, dto.principals);
  }
}

/** Politiques de rappel par type (ADM-044..047, 056, 063, 065). */
@ApiTags('Certificates — Configuration')
@Controller('certificate-reminder-policies')
export class CertificateReminderPoliciesController {
  constructor(private readonly types: CertificateTypesService) {}

  @Get()
  @RequirePermissions('certificates.view')
  list(@Auth() ctx: AuthContext) {
    return this.types.listPolicies(ctx);
  }

  @Get(':id')
  @RequirePermissions('certificates.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.types.getPolicy(ctx, id);
  }

  @Post()
  @RequirePermissions('certificates.types.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateReminderPolicyDto) {
    return this.types.createPolicy(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('certificates.types.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateReminderPolicyDto) {
    return this.types.updatePolicy(ctx, id, dto);
  }

  /** Destinataires users / rôles / départements — filtrés sur droits réels à l'envoi (ADM-045). */
  @Put(':id/recipients')
  @RequirePermissions('certificates.types.manage')
  setRecipients(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetPrincipalsDto) {
    return this.types.setRecipients(ctx, id, dto.principals);
  }
}
