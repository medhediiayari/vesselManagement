import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { AttachmentDto } from './purchase-requests.dto';
import { PurchasingCore } from './purchasing-core.service';
import { CreateSelectionsDto, RecordQuotationDto, WithdrawQuotationDto, WithdrawSelectionDto } from './quotations.dto';
import { QuotationsService } from './quotations.service';
import { AddRfqSuppliersDto, CreateRfqDto, ListRfqQuery, MarkRfqSentDto, RfqCommentDto, RfqReasonDto, RfqStatsQuery, UpdateRfqDto } from './rfqs.dto';
import { RfqsService } from './rfqs.service';

/** RFQ, devis, comparaison et sélection (CDC §6.5 ; §11 « POST /rfqs ; POST /quotations ; GET /quotation-comparison »). */
@ApiTags('Purchasing — RFQ & quotations')
@Controller()
export class RfqsController {
  constructor(
    private readonly rfqs: RfqsService,
    private readonly quotations: QuotationsService,
    private readonly core: PurchasingCore,
  ) {}

  @Get('rfqs')
  @RequirePermissions('rfq.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListRfqQuery) {
    return this.rfqs.list(ctx, q);
  }

  @Post('rfqs')
  @RequirePermissions('rfq.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateRfqDto) {
    return this.rfqs.create(ctx, dto);
  }

  /** Compteurs par statut, RFQ à relancer et RFQ ayant donné lieu à un BC (déclaré avant rfqs/:id). */
  @Get('rfqs/stats')
  @RequirePermissions('rfq.view')
  stats(@Auth() ctx: AuthContext, @Query() q: RfqStatsQuery) {
    return this.rfqs.stats(ctx, q);
  }

  @Get('rfqs/:id')
  @RequirePermissions('rfq.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.get(ctx, id);
  }

  @Patch('rfqs/:id')
  @RequirePermissions('rfq.manage')
  update(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRfqDto) {
    return this.rfqs.update(ctx, id, dto);
  }

  @Get('rfqs/:id/open-quantities')
  @RequirePermissions('rfq.view')
  openQuantities(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.rfqs.openQuantities(ctx, id);
  }

  @Post('rfqs/:id/suppliers')
  @RequirePermissions('rfq.manage')
  addSuppliers(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AddRfqSuppliersDto) {
    return this.rfqs.addSuppliers(ctx, id, dto);
  }

  @Delete('rfqs/:id/suppliers/:supplierId')
  @RequirePermissions('rfq.manage')
  removeSupplier(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('supplierId', ParseUUIDPipe) supplierId: string) {
    return this.rfqs.removeSupplier(ctx, id, supplierId);
  }

  /** Contact du fournisseur hors plateforme (aucun e-mail envoyé par la plateforme) : déclaré, attribué et audité. */
  @Post('rfqs/:id/suppliers/:supplierId/mark-sent')
  @RequirePermissions('rfq.manage')
  markSent(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body() dto: MarkRfqSentDto,
  ) {
    return this.rfqs.markSent(ctx, id, supplierId, dto);
  }

  @Post('rfqs/:id/suppliers/:supplierId/decline')
  @RequirePermissions('rfq.manage')
  decline(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('supplierId', ParseUUIDPipe) supplierId: string,
    @Body() dto: RfqCommentDto,
  ) {
    return this.rfqs.decline(ctx, id, supplierId, dto.comment);
  }

  @Post('rfqs/:id/close')
  @RequirePermissions('rfq.manage')
  close(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RfqCommentDto) {
    return this.rfqs.close(ctx, id, dto.comment);
  }

  @Post('rfqs/:id/cancel')
  @RequirePermissions('rfq.manage')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RfqReasonDto) {
    return this.rfqs.cancel(ctx, id, dto);
  }

  @Get('rfqs/:id/attachments')
  @RequirePermissions('rfq.view')
  attachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'RFQ', id);
  }

  @Post('rfqs/:id/attachments')
  @RequirePermissions('rfq.manage')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'RFQ', id, dto.fileId, dto.title);
  }

  // ------------------------------------------------------------------ devis

  @Get('rfqs/:id/quotations')
  @RequirePermissions('quotation.view')
  quotationsOf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.listForRfq(ctx, id);
  }

  @Post('rfqs/:id/quotations')
  @RequirePermissions('quotation.record')
  record(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RecordQuotationDto) {
    return this.quotations.record(ctx, id, dto);
  }

  @Get('quotations/:id')
  @RequirePermissions('quotation.view')
  quotation(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.get(ctx, id);
  }

  /** Correction d'un devis = retrait motivé puis saisie d'un nouveau devis (jamais d'écrasement). */
  @Post('quotations/:id/withdraw')
  @RequirePermissions('quotation.record')
  withdrawQuotation(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: WithdrawQuotationDto) {
    return this.quotations.withdraw(ctx, id, dto);
  }

  @Get('quotations/:id/attachments')
  @RequirePermissions('quotation.view')
  quotationAttachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'QUOTATION', id);
  }

  @Post('quotations/:id/attachments')
  @RequirePermissions('quotation.record')
  addQuotationAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'QUOTATION', id, dto.fileId, dto.title);
  }

  // ------------------------------------------------------------------ comparaison & sélection

  /** Comparateur multi-fournisseurs sans conversion de devise. */
  @Get('rfqs/:id/comparison')
  @RequirePermissions('quotation.view')
  comparison(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.comparison(ctx, id);
  }

  @Get('rfqs/:id/selections')
  @RequirePermissions('quotation.view')
  selections(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.quotations.listSelections(ctx, id);
  }

  /** Sélection séparée de la saisie (quotation.evaluate) avec justification obligatoire. */
  @Post('rfqs/:id/selections')
  @RequirePermissions('quotation.evaluate')
  select(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: CreateSelectionsDto) {
    return this.quotations.select(ctx, id, dto);
  }

  @Post('rfqs/:id/selections/:selectionId/withdraw')
  @RequirePermissions('quotation.evaluate')
  withdrawSelection(
    @Auth() ctx: AuthContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('selectionId', ParseUUIDPipe) selectionId: string,
    @Body() dto: WithdrawSelectionDto,
  ) {
    return this.quotations.withdrawSelection(ctx, id, selectionId, dto);
  }
}
