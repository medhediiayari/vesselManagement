import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { AttachmentDto, PdfQuery } from './purchase-requests.dto';
import { PurchasingCore } from './purchasing-core.service';
import {
  AssignVarianceDto,
  AwaitRemainderDto,
  CancelDeliveryNoteDto,
  ComplementaryForOrderDto,
  ComplementaryOrderDto,
  CreateDeliveryNoteDto,
  CreateReceiptDto,
  ListDeliveryNotesQuery,
  ListReceiptsQuery,
  ListVariancesQuery,
  OnboardDeliveryDto,
  ResolveVarianceDto,
  ValidateReceiptDto,
  VarianceCommentDto,
} from './receiving.dto';
import { ReceivingService } from './receiving.service';
import { VariancesService } from './variances.service';

/** BL, réceptions à bord et écarts (CDC §6.7 ; §11 « POST /receipts »). Filtrage par scope navire (PUR-06). */
@ApiTags('Purchasing — Delivery notes, receipts & variances')
@Controller()
export class ReceivingController {
  constructor(
    private readonly receiving: ReceivingService,
    private readonly variances: VariancesService,
    private readonly core: PurchasingCore,
  ) {}

  // ------------------------------------------------------------------ BL saisi à bord (refonte 22/10/2026)

  /** Réponse du bord à un BC : BL + réception en une étape (saisie par ligne, « tout reçu », articles hors BC, fichiers). */
  @Post('delivery-notes/onboard')
  @RequirePermissions('receiving.record')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'UUID conseillé : un renvoi ne compte jamais deux fois' })
  async recordOnboard(
    @Auth() ctx: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: OnboardDeliveryDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.receiving.recordOnboard(ctx, key, dto);
    // Rejeu (même clé, même contenu, y compris envois simultanés) : résultat d'origine en 200 (ACH-09)
    res.status(result.replay ? 200 : 201);
    return result;
  }

  /** Écart de réception — décision « Attendre le reliquat ». */
  @Post('orders/:id/await-remainder')
  @RequirePermissions('variances.manage')
  awaitRemainder(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AwaitRemainderDto) {
    return this.variances.awaitRemainder(ctx, id, dto);
  }

  /** Écart de réception — « Correction fournisseur » par BC complémentaire (plusieurs lignes, autre fournisseur possible). */
  @Post('orders/:id/complementary')
  @RequirePermissions('variances.manage', 'bc.create')
  complementaryForOrder(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ComplementaryForOrderDto) {
    return this.variances.complementaryForOrder(ctx, id, dto);
  }

  // ------------------------------------------------------------------ BL

  @Get('delivery-notes')
  @RequirePermissions('receiving.view')
  listNotes(@Auth() ctx: AuthContext, @Query() q: ListDeliveryNotesQuery) {
    return this.receiving.listDeliveryNotes(ctx, q);
  }

  @Post('delivery-notes')
  @RequirePermissions('receiving.record')
  createNote(@Auth() ctx: AuthContext, @Body() dto: CreateDeliveryNoteDto) {
    return this.receiving.createDeliveryNote(ctx, dto);
  }

  @Get('delivery-notes/:id')
  @RequirePermissions('receiving.view')
  getNote(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.receiving.getDeliveryNote(ctx, id);
  }

  @Post('delivery-notes/:id/cancel')
  @RequirePermissions('receiving.record')
  cancelNote(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CancelDeliveryNoteDto) {
    return this.receiving.cancelDeliveryNote(ctx, id, dto);
  }

  @Get('delivery-notes/:id/attachments')
  @RequirePermissions('receiving.view')
  noteAttachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'DELIVERY_NOTE', id);
  }

  @Post('delivery-notes/:id/attachments')
  @RequirePermissions('receiving.record')
  addNoteAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'DELIVERY_NOTE', id, dto.fileId, dto.title);
  }

  // ------------------------------------------------------------------ Réceptions

  @Get('receipts')
  @RequirePermissions('receiving.view')
  listReceipts(@Auth() ctx: AuthContext, @Query() q: ListReceiptsQuery) {
    return this.receiving.listReceipts(ctx, q);
  }

  /**
   * POST /receipts — en-tête Idempotency-Key OBLIGATOIRE (8-128 caractères) : un rejeu de la même requête
   * renvoie la réception d'origine (HTTP 200, `replay: true`) sans double comptage (PUR-05).
   */
  @Post('receipts')
  @RequirePermissions('receiving.record')
  @ApiHeader({ name: 'Idempotency-Key', required: true, description: 'Clé unique de la réception (UUID conseillé), 8 à 128 caractères' })
  async createReceipt(
    @Auth() ctx: AuthContext,
    @Headers('idempotency-key') key: string | undefined,
    @Body() dto: CreateReceiptDto,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.receiving.createReceipt(ctx, key, dto);
    res.status(result.replay ? 200 : 201);
    return { ...result.receipt, replay: result.replay };
  }

  @Get('receipts/:id')
  @RequirePermissions('receiving.view')
  getReceipt(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.receiving.getReceipt(ctx, id);
  }

  @Post('receipts/:id/validate')
  @RequirePermissions('receiving.validate')
  validate(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ValidateReceiptDto) {
    return this.receiving.validateReceipt(ctx, id, dto);
  }

  /** Rapport de réception PDF (BC | BL | reçu physique côte à côte), généré à la demande. */
  @Get('receipts/:id/pdf')
  @RequirePermissions('receiving.view')
  receiptPdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: PdfQuery) {
    return this.receiving.receiptPdf(ctx, id, !!q.download);
  }

  @Get('receipts/:id/attachments')
  @RequirePermissions('receiving.view')
  receiptAttachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'GOODS_RECEIPT', id);
  }

  @Post('receipts/:id/attachments')
  @RequireAnyPermission('receiving.record', 'receiving.validate')
  addReceiptAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'GOODS_RECEIPT', id, dto.fileId, dto.title);
  }

  // ------------------------------------------------------------------ Écarts

  @Get('variances')
  @RequireAnyPermission('receiving.view', 'variances.manage')
  listVariances(@Auth() ctx: AuthContext, @Query() q: ListVariancesQuery) {
    return this.variances.list(ctx, q);
  }

  @Get('variances/:id')
  @RequireAnyPermission('receiving.view', 'variances.manage')
  getVariance(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.variances.get(ctx, id);
  }

  @Post('variances/:id/assign')
  @RequirePermissions('variances.manage')
  assign(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignVarianceDto) {
    return this.variances.assign(ctx, id, dto);
  }

  @Post('variances/:id/resolve')
  @RequirePermissions('variances.manage')
  resolve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ResolveVarianceDto) {
    return this.variances.resolve(ctx, id, dto);
  }

  @Post('variances/:id/close')
  @RequirePermissions('variances.manage')
  closeVariance(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VarianceCommentDto) {
    return this.variances.close(ctx, id, dto.comment);
  }

  @Post('variances/:id/reopen')
  @RequirePermissions('variances.manage')
  reopen(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: VarianceCommentDto) {
    return this.variances.reopen(ctx, id, dto.comment);
  }

  /** BC complémentaire pour le reliquat, lié aux lignes PR d'origine (variances.manage + bc.create). */
  @Post('variances/:id/complementary-order')
  @RequirePermissions('variances.manage', 'bc.create')
  complementary(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ComplementaryOrderDto) {
    return this.variances.complementaryOrder(ctx, id, dto);
  }

  @Get('variances/:id/attachments')
  @RequireAnyPermission('receiving.view', 'variances.manage')
  varianceAttachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'VARIANCE', id);
  }

  @Post('variances/:id/attachments')
  @RequireAnyPermission('variances.manage', 'receiving.record')
  addVarianceAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'VARIANCE', id, dto.fileId, dto.title);
  }
}
