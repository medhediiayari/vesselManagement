import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { CreateInvoiceDto, InvoiceStatusDto, ListInvoicesQuery } from './invoices.dto';
import { InvoicesService } from './invoices.service';
import { AttachmentDto } from './purchase-requests.dto';
import { PurchasingCore } from './purchasing-core.service';

/** Factures fournisseurs (CDC §6.7 ; §11 « POST /invoices ») — jamais d'effet sur le statut du BC (PUR-07). */
@ApiTags('Purchasing — Invoices')
@Controller('invoices')
export class InvoicesController {
  constructor(
    private readonly invoices: InvoicesService,
    private readonly core: PurchasingCore,
  ) {}

  @Get()
  @RequirePermissions('invoice.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListInvoicesQuery) {
    return this.invoices.list(ctx, q);
  }

  @Post()
  @RequirePermissions('invoice.manage')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateInvoiceDto) {
    return this.invoices.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('invoice.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.invoices.get(ctx, id);
  }

  /** Rapprochement commandé / reçu / facturé par devise + suggestion MATCHED / DISPUTED. */
  @Get(':id/matching')
  @RequirePermissions('invoice.view')
  async matching(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.invoices.get(ctx, id);
    return this.invoices.matching(id);
  }

  @Post(':id/status')
  @RequirePermissions('invoice.manage')
  setStatus(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: InvoiceStatusDto) {
    return this.invoices.setStatus(ctx, id, dto);
  }

  @Get(':id/attachments')
  @RequirePermissions('invoice.view')
  attachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'INVOICE', id);
  }

  @Post(':id/attachments')
  @RequirePermissions('invoice.manage')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'INVOICE', id, dto.fileId, dto.title);
  }
}
