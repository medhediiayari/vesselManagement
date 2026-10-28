import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { PrRevisionsService } from './pr-revisions.service';
import {
  ApplyCounterDto,
  AttachmentDto,
  CloseDto,
  CommentDto,
  CreatePrDto,
  ListPrQuery,
  PdfQuery,
  PrFormDefaultsQuery,
  ProposeRevisionDto,
  ReasonDto,
  RejectDto,
  ReplacePrLinesDto,
  RevisionDecisionDto,
  SplitPrDto,
  UpdatePrDto,
  VersionDto,
  WithdrawRevisionDto,
} from './purchase-requests.dto';
import { PurchaseRequestsService } from './purchase-requests.service';
import { PurchasingCore } from './purchasing-core.service';

/**
 * Purchase Requests (CDC §6.4, §11 « GET/POST /purchase-requests ; POST /purchase-requests/{id}/revisions »).
 * Toutes les lectures sont filtrées par le scope navire (PUR-06).
 */
@ApiTags('Purchasing — Purchase Requests')
@Controller('purchase-requests')
export class PurchaseRequestsController {
  constructor(
    private readonly prs: PurchaseRequestsService,
    private readonly revisions: PrRevisionsService,
    private readonly core: PurchasingCore,
  ) {}

  @Get()
  @RequirePermissions('pr.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListPrQuery) {
    return this.prs.list(ctx, q);
  }

  @Post()
  @RequirePermissions('pr.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreatePrDto) {
    return this.prs.create(ctx, dto);
  }

  /** Valeurs proposées au formulaire : référence du formulaire PR et prochaine escale du navire (déclaré avant :id). */
  @Get('form-defaults')
  @RequireAnyPermission('pr.create', 'pr.edit')
  formDefaults(@Auth() ctx: AuthContext, @Query() q: PrFormDefaultsQuery) {
    return this.prs.formDefaults(ctx, q);
  }

  @Get(':id')
  @RequirePermissions('pr.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.prs.get(ctx, id);
  }

  @Get(':id/history')
  @RequirePermissions('pr.view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.prs.history(ctx, id);
  }

  /** En-tête modifiable uniquement en DRAFT (verrou optimiste expectedVersion). */
  @Patch(':id')
  @RequirePermissions('pr.edit')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePrDto) {
    return this.prs.update(ctx, id, dto);
  }

  /** Saisie tableur des lignes (remplacement complet) — DRAFT uniquement. */
  @Put(':id/lines')
  @RequirePermissions('pr.edit')
  replaceLines(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplacePrLinesDto) {
    return this.prs.replaceLines(ctx, id, dto);
  }

  @Get(':id/attachments')
  @RequirePermissions('pr.view')
  attachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'PR', id);
  }

  @Post(':id/attachments')
  @RequireAnyPermission('pr.create', 'pr.edit', 'pr.revise', 'pr.approve')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.prs.addAttachment(ctx, id, dto);
  }

  // ------------------------------------------------------------------ commandes de workflow

  @Post(':id/submit')
  @RequirePermissions('pr.submit')
  submit(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.prs.submit(ctx, id, dto);
  }

  @Post(':id/start-review')
  @RequireAnyPermission('pr.approve', 'pr.revise')
  startReview(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.prs.startReview(ctx, id, dto);
  }

  /** Visa d'une étape intermédiaire si le circuit configuré en comporte (aucune par défaut — PUR-01). */
  @Post(':id/endorse')
  @RequireAnyPermission('pr.approve', 'pr.submit')
  endorse(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.prs.endorse(ctx, id, dto);
  }

  @Post(':id/approve')
  @RequirePermissions('pr.approve')
  approve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.prs.approve(ctx, id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('pr.approve')
  reject(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RejectDto) {
    return this.prs.reject(ctx, id, dto);
  }

  @Post(':id/hold')
  @RequirePermissions('pr.approve')
  hold(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.prs.hold(ctx, id, dto);
  }

  @Post(':id/resume')
  @RequirePermissions('pr.approve')
  resume(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VersionDto) {
    return this.prs.resume(ctx, id, dto);
  }

  /** Annulation motivée (pr.cancel) ; le demandeur peut abandonner son propre brouillon avec pr.edit. */
  @Post(':id/cancel')
  @RequireAnyPermission('pr.cancel', 'pr.edit')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReasonDto) {
    return this.prs.cancel(ctx, id, dto);
  }

  @Post(':id/close')
  @RequirePermissions('pr.approve')
  close(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CloseDto) {
    return this.prs.close(ctx, id, dto);
  }

  // ------------------------------------------------------------------ discussion

  @Get(':id/comments')
  @RequirePermissions('pr.view')
  comments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.prs.comments(ctx, id);
  }

  @Post(':id/comments')
  @RequireAnyPermission('pr.create', 'pr.edit', 'pr.submit', 'pr.revise', 'pr.approve')
  addComment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CommentDto) {
    return this.prs.addComment(ctx, id, dto);
  }

  // ------------------------------------------------------------------ Counter-PR (PUR-02)

  @Get(':id/revisions')
  @RequirePermissions('pr.view')
  listRevisions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.revisions.list(ctx, id);
  }

  @Post(':id/revisions')
  @RequirePermissions('pr.revise')
  propose(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ProposeRevisionDto) {
    return this.revisions.propose(ctx, id, dto);
  }

  @Get(':id/revisions/:revisionId')
  @RequirePermissions('pr.view')
  getRevision(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('revisionId', ParseUUIDPipe) revisionId: string) {
    return this.revisions.get(ctx, id, revisionId);
  }

  /** Différence ligne à ligne PR d'origine vs proposition révisée. */
  @Get(':id/revisions/:revisionId/diff')
  @RequirePermissions('pr.view')
  diff(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('revisionId', ParseUUIDPipe) revisionId: string) {
    return this.revisions.diff(ctx, id, revisionId);
  }

  @Post(':id/revisions/:revisionId/decision')
  @RequirePermissions('pr.approve')
  decide(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: RevisionDecisionDto,
  ) {
    return this.revisions.decide(ctx, id, revisionId, dto);
  }

  /** Counter-PR appliquée directement (motif facultatif, demandeur notifié) — décision « Counter-PR » en discussion. */
  @Post(':id/counter')
  @RequirePermissions('pr.revise')
  applyCounter(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ApplyCounterDto) {
    return this.revisions.applyCounter(ctx, id, dto);
  }

  /** Décision « Diviser » : lignes entières réparties en sous-PR validées (une par fournisseur visé). */
  @Post(':id/split')
  @RequirePermissions('pr.approve')
  split(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: SplitPrDto) {
    return this.prs.split(ctx, id, dto);
  }

  @Post(':id/revisions/:revisionId/withdraw')
  @RequirePermissions('pr.revise')
  withdraw(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @Body() dto: WithdrawRevisionDto,
  ) {
    return this.revisions.withdraw(ctx, id, revisionId, dto);
  }

  // ------------------------------------------------------------------ PDF

  /** PDF PR généré à la demande, stocké, retourné en lien signé 60 s (?download=true => pièce jointe). */
  @Get(':id/pdf')
  @RequirePermissions('pr.view')
  pdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: PdfQuery) {
    return this.prs.pdf(ctx, id, !!q.download);
  }
}
