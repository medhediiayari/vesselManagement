import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import {
  CreateOrderDto,
  ListOrdersQuery,
  MarkOrderSentDto,
  OrderCloseDto,
  OrderReasonDto,
  OrderRejectDto,
  OrderVersionDto,
  ReplaceOrderDto,
  ReviseOrderDto,
} from './orders.dto';
import { OrdersService } from './orders.service';
import { AttachmentDto, PdfQuery } from './purchase-requests.dto';
import { PurchasingCore } from './purchasing-core.service';

/** Bons de commande BC = OC = PO (CDC §6.6 ; §11 « POST /orders »). */
@ApiTags('Purchasing — Orders (BC/PO)')
@Controller('orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly core: PurchasingCore,
  ) {}

  @Get()
  @RequirePermissions('bc.view')
  list(@Auth() ctx: AuthContext, @Query() q: ListOrdersQuery) {
    return this.orders.list(ctx, q);
  }

  /** Création depuis lignes de devis sélectionnées ou manuellement depuis lignes PR (allocations explicites). */
  @Post()
  @RequirePermissions('bc.create')
  create(@Auth() ctx: AuthContext, @Body() dto: CreateOrderDto) {
    return this.orders.create(ctx, dto);
  }

  @Get(':id')
  @RequirePermissions('bc.view')
  get(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.get(ctx, id);
  }

  @Get(':id/history')
  @RequirePermissions('bc.view')
  history(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.history(ctx, id);
  }

  @Put(':id')
  @RequirePermissions('bc.create')
  replace(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReplaceOrderDto) {
    return this.orders.replace(ctx, id, dto);
  }

  @Post(':id/submit')
  @RequirePermissions('bc.create')
  submit(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderVersionDto) {
    return this.orders.submit(ctx, id, dto);
  }

  /** « Émettre le BC » : contrôle + validation + émission en un clic ; transmis au créateur de la PR (PDF). */
  @Post(':id/issue')
  @RequirePermissions('bc.create')
  issue(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderVersionDto) {
    return this.orders.issue(ctx, id, dto);
  }

  /**
   * Écart de réception — « Correction fournisseur » par révision du BC (quantités ajustées, reliquat annulé…) :
   * ouverte à l'acheteur qui traite les écarts ; la comparaison BC ↔ BL est refaite automatiquement.
   */
  @Post(':id/correction')
  @RequirePermissions('variances.manage', 'bc.create')
  correction(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviseOrderDto) {
    return this.orders.revise(ctx, id, { ...dto, reason: dto.reason.startsWith('Correction fournisseur') ? dto.reason : `Correction fournisseur : ${dto.reason}` });
  }

  /** Second regard (seuil configurable) : approbateur ≠ créateur / émetteur. */
  @Post(':id/approve')
  @RequirePermissions('bc.approve')
  approve(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderVersionDto) {
    return this.orders.approve(ctx, id, dto);
  }

  @Post(':id/reject')
  @RequirePermissions('bc.approve')
  reject(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderRejectDto) {
    return this.orders.reject(ctx, id, dto);
  }

  @Post(':id/mark-sent')
  @RequirePermissions('bc.send')
  markSent(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MarkOrderSentDto) {
    return this.orders.markSent(ctx, id, dto);
  }

  @Get(':id/revisions')
  @RequirePermissions('bc.view')
  revisions(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.revisions(ctx, id);
  }

  /** Avenant : snapshot des quantités contractuelles précédentes + nouveau PDF (jamais de modification silencieuse). */
  @Post(':id/revisions')
  @RequirePermissions('bc.cancel')
  revise(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: ReviseOrderDto) {
    return this.orders.revise(ctx, id, dto);
  }

  /** Annulation motivée (bc.cancel) ; le créateur peut abandonner son propre brouillon avec bc.create. */
  @Post(':id/cancel')
  @RequireAnyPermission('bc.cancel', 'bc.create')
  cancel(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderReasonDto) {
    return this.orders.cancel(ctx, id, dto);
  }

  /** Clôture ; avec reliquat : bc.cancel + motif (révision annulant le reliquat). */
  @Post(':id/close')
  @RequireAnyPermission('bc.create', 'bc.cancel')
  close(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: OrderCloseDto) {
    return this.orders.close(ctx, id, dto);
  }

  /** Rapprochement BC | BL | reçu physique | accepté | rejeté | reliquat (PUR-04). */
  @Get(':id/reconciliation')
  @RequireAnyPermission('bc.view', 'receiving.view')
  reconciliation(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.orders.reconciliation(ctx, id);
  }

  @Get(':id/pdf')
  @RequirePermissions('bc.view')
  pdf(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query() q: PdfQuery) {
    return this.orders.pdf(ctx, id, !!q.download);
  }

  @Get(':id/attachments')
  @RequirePermissions('bc.view')
  attachments(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.core.listAttachments(ctx, 'PURCHASE_ORDER', id);
  }

  @Post(':id/attachments')
  @RequireAnyPermission('bc.create', 'bc.send')
  addAttachment(@Auth() ctx: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachmentDto) {
    return this.core.addAttachment(ctx, 'PURCHASE_ORDER', id, dto.fileId, dto.title);
  }
}
