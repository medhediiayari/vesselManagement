import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import { queryBool } from '../../common/pagination';
import type { AuthContext } from '../access/auth-context';
import type { FileAccessLink } from '../files/files.service';
import { CertificateFilesService } from './certificate-files.service';
import { CertificateRemindersService } from './certificate-reminders.service';
import { CertificateWorkflowService } from './certificate-workflow.service';
import {
  AddAttachmentDto,
  AddCommentDto,
  ArchiveCertificateDto,
  CancelRequestDto,
  ComplianceQuery,
  CorrectionDto,
  CreateCertificateDto,
  DecisionDto,
  DuplicateRequestDto,
  ListCertificatesQuery,
  ListRequestsQuery,
  RenewCertificateDto,
  SetRenewalDto,
  SubmitRequestDto,
  UpdateRequestDto,
} from './certificates.dto';
import { CertificatesService } from './certificates.service';

const LinkQuerySchema = z.object({ redirect: queryBool });

/** Lien éphémère (JSON) ou redirection 302 si ?redirect=true — jamais mis en cache. */
function respondLink(link: FileAccessLink, q: unknown, res: Response) {
  const { redirect } = LinkQuerySchema.parse(q ?? {});
  res.setHeader('Cache-Control', 'no-store');
  if (redirect) {
    res.redirect(302, link.url);
    return;
  }
  return link;
}

const DECISION_PERMISSIONS = ['certificates.approve', 'certificates.attachments.approve'] as const;

/**
 * Certificats navires et Members (CDC §4, §11). Contrôleur mince : permission de route ici,
 * scope navire / ADM-070, état de workflow et version vérifiés dans les services.
 */
@ApiTags('Certificates')
@Controller('certificates')
export class CertificatesController {
  constructor(
    private readonly certificates: CertificatesService,
    private readonly workflow: CertificateWorkflowService,
    private readonly documents: CertificateFilesService,
    private readonly reminders: CertificateRemindersService,
  ) {}

  /** Explorateur paginé (filtres validité, échéance, renouvellement, pièces manquantes, approbations…). */
  @Get()
  @RequirePermissions('certificates.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListCertificatesQuery) {
    return this.certificates.list(ctx, q);
  }

  /** Tableau de conformité transversal (option vesselId : navire + équipage affecté). */
  @Get('compliance')
  @RequirePermissions('certificates.view')
  compliance(@Auth() ctx: AuthContext, @Query() q: ComplianceQuery) {
    return this.certificates.compliance(ctx, q);
  }

  /** Déclenchement manuel du job de rappels (recette / UAT). */
  @Post('reminders/run')
  @RequirePermissions('certificates.types.manage')
  runReminders(@Auth() ctx: AuthContext) {
    return this.reminders.runManually(ctx);
  }

  /** Nouveau certificat + demande CREATE (brouillon ou soumise). */
  @Post()
  @RequirePermissions('certificates.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateCertificateDto) {
    return this.workflow.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('certificates.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.certificates.get(ctx, id);
  }

  /** Demande de renouvellement : l'ancien certificat reste courant jusqu'à approbation (ADM-049/050). */
  @Post(':id/renew')
  @RequirePermissions('certificates.create')
  renew(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RenewCertificateDto) {
    return this.workflow.renew(ctx, id, dto);
  }

  @Post(':id/corrections')
  @RequireAnyPermission('certificates.create', 'certificates.edit')
  correct(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CorrectionDto) {
    return this.workflow.correct(ctx, id, dto);
  }

  /** Pièce ajoutée / remplacée après validation : demande autonome (ADM-066/067, CERT-05). */
  @Post(':id/attachments')
  @RequireAnyPermission('certificates.create', 'certificates.edit')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddAttachmentDto) {
    return this.workflow.addAttachment(ctx, id, dto);
  }

  /** Aperçu inline du document officiel courant (View — CERT-06). */
  @Get(':id/preview')
  @RequirePermissions('certificates.view')
  async preview(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return respondLink(await this.documents.currentLink(ctx, id, 'preview'), q, res);
  }

  /** Téléchargement du document officiel courant (Download Certificate — ADM-068). */
  @Get(':id/download')
  @RequirePermissions('certificates.view', 'certificates.download_current')
  async download(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: unknown, @Res({ passthrough: true }) res: Response) {
    return respondLink(await this.documents.currentLink(ctx, id, 'download'), q, res);
  }

  @Get(':id/attachments/:attachmentId/preview')
  @RequirePermissions('certificates.view')
  async attachmentPreview(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query() q: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respondLink(await this.documents.attachmentLink(ctx, id, attachmentId, 'preview'), q, res);
  }

  /** Courant : download_current ; archivé : download_archived (jamais impliqué — CERT-07). */
  @Get(':id/attachments/:attachmentId/download')
  @RequirePermissions('certificates.view')
  async attachmentDownload(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Query() q: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    return respondLink(await this.documents.attachmentLink(ctx, id, attachmentId, 'download'), q, res);
  }

  /** Responsables de renouvellement éligibles (droit réel de lecture du certificat). */
  @Get(':id/renewal-owners')
  @RequirePermissions('certificates.renewal.manage')
  renewalOwners(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.workflow.renewalOwnerCandidates(ctx, id);
  }

  /** Suivi opérationnel du renouvellement (ADM-048) — sans effet sur validité ni alertes. */
  @Put(':id/renewal')
  @RequirePermissions('certificates.renewal.manage')
  setRenewal(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SetRenewalDto) {
    return this.workflow.setRenewal(ctx, id, dto);
  }

  @Post(':id/comments')
  @RequirePermissions('certificates.renewal.manage')
  addComment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddCommentDto) {
    return this.workflow.addComment(ctx, id, dto);
  }

  @Post(':id/archive')
  @RequirePermissions('certificates.archive')
  archive(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ArchiveCertificateDto) {
    return this.workflow.archive(ctx, id, dto);
  }
}

/** Vie des demandes d'approbation (création, renouvellement, correction, pièce jointe). */
@ApiTags('Certificates')
@Controller('certificate-requests')
export class CertificateRequestsController {
  constructor(
    private readonly certificates: CertificatesService,
    private readonly workflow: CertificateWorkflowService,
  ) {}

  /** Boîte des demandes : ?mine=true (mes demandes), ?toApprove=true (à valider par moi). */
  @Get()
  @RequirePermissions('certificates.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListRequestsQuery) {
    return this.certificates.listRequests(ctx, q);
  }

  /** Modification par le demandeur : nouvelle version immuable (ADM-057/058). */
  @Patch(':requestId')
  @RequirePermissions('certificates.edit')
  update(@Auth() ctx: AuthContext, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: UpdateRequestDto) {
    return this.workflow.updateRequest(ctx, requestId, dto);
  }

  @Post(':requestId/submit')
  @RequirePermissions('certificates.submit')
  submit(@Auth() ctx: AuthContext, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: SubmitRequestDto) {
    return this.workflow.submit(ctx, requestId, dto);
  }

  /**
   * Annulation motivée : par le demandeur (ADM-059) ou, en supervision, par un validateur désigné
   * / un administrateur des types (demande bloquante d'autrui) — contrôlé dans le service.
   */
  @Post(':requestId/cancel')
  @RequireAnyPermission(
    'certificates.create',
    'certificates.edit',
    'certificates.submit',
    'certificates.approve',
    'certificates.attachments.approve',
    'certificates.types.manage',
  )
  cancel(@Auth() ctx: AuthContext, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: CancelRequestDto) {
    return this.workflow.cancel(ctx, requestId, dto);
  }

  @Post(':requestId/duplicate')
  @RequirePermissions('certificates.create')
  duplicate(@Auth() ctx: AuthContext, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DuplicateRequestDto) {
    return this.workflow.duplicate(ctx, requestId, dto);
  }

  /** Alias de POST /approvals/:requestId/decision. */
  @Post(':requestId/decision')
  @RequireAnyPermission(...DECISION_PERMISSIONS)
  decide(@Auth() ctx: AuthContext, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DecisionDto) {
    return this.workflow.decide(ctx, requestId, dto);
  }
}

/** POST /approvals/{id}/decision (CDC §11) — Approve / Reject / Return avec expectedVersion. */
@ApiTags('Certificates')
@Controller('approvals')
export class CertificateApprovalsController {
  constructor(private readonly workflow: CertificateWorkflowService) {}

  @Post(':requestId/decision')
  @RequireAnyPermission(...DECISION_PERMISSIONS)
  decide(@Auth() ctx: AuthContext, @Param('requestId', ParseUUIDPipe) requestId: string, @Body() dto: DecisionDto) {
    return this.workflow.decide(ctx, requestId, dto);
  }
}
