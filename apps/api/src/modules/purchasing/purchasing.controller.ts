import { Body, Controller, Get, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Auth, RequireAnyPermission, RequirePermissions } from '../../common/decorators';
import type { AuthContext } from '../access/auth-context';
import { PurchasingBoardService } from './purchasing-board.service';
import { PoApprovalModeDto, PrFormRefDto, PurchasingConfigService, ReviewCircuitsDto, UpsertThresholdDto } from './purchasing-config.service';
import { ExportOrdersQuery, ExportPrQuery, PurchasingExportsService } from './purchasing-exports.service';
import { PurchasingFollowupService } from './purchasing-followup.service';
import { ReviewCircuitRule } from './purchasing.logic';

/** Transverse Achats : tableau de bord, paramétrage (circuits, seuils), exports, relances. */
@ApiTags('Purchasing — Board, configuration & exports')
@Controller('purchasing')
export class PurchasingController {
  constructor(
    private readonly board: PurchasingBoardService,
    private readonly config: PurchasingConfigService,
    private readonly exports: PurchasingExportsService,
    private readonly followup: PurchasingFollowupService,
  ) {}

  /** Purchasing board : compteurs par permission et scope navire (V1 §9.2). */
  @Get('board')
  @RequireAnyPermission('pr.view', 'rfq.view', 'quotation.view', 'bc.view', 'receiving.view', 'invoice.view')
  getBoard(@Auth() ctx: AuthContext, @Query() q: Record<string, unknown>) {
    const { vesselId } = z.object({ vesselId: z.string().uuid().optional() }).parse(q ?? {});
    return this.board.board(ctx, vesselId);
  }

  // ------------------------------------------------------------------ paramétrage (hypothèses configurables CDC §17)

  @Get('config')
  @RequireAnyPermission('pr.view', 'bc.view', 'settings.manage')
  getConfig() {
    return this.config.summary();
  }

  /** Circuits de revue PR (règles évaluées dans l'ordre ; dernière étape = pr.approve). */
  @Put('config/review-circuits')
  @RequirePermissions('settings.manage')
  setReviewCircuits(@Auth() ctx: AuthContext, @Body() dto: ReviewCircuitsDto) {
    return this.config.setReviewCircuits(ctx, dto.rules as ReviewCircuitRule[]);
  }

  /** THRESHOLD_ONLY (défaut) : second regard si seuil de la devise atteint ; ALWAYS : tout BC. */
  @Put('config/po-approval-mode')
  @RequirePermissions('settings.manage')
  setPoApprovalMode(@Auth() ctx: AuthContext, @Body() dto: PoApprovalModeDto) {
    return this.config.setPoApprovalMode(ctx, dto.mode);
  }

  /** Référence du modèle de formulaire PR, recopiée automatiquement dans chaque nouvelle PR. */
  @Put('config/pr-form-ref')
  @RequirePermissions('settings.manage')
  setPrFormRef(@Auth() ctx: AuthContext, @Body() dto: PrFormRefDto) {
    return this.config.setPrFormRef(ctx, dto.formRef);
  }

  @Get('approval-thresholds')
  @RequireAnyPermission('bc.view', 'settings.manage')
  thresholds() {
    return this.config.thresholds();
  }

  /** Seuil BC par devise (aucun seuil n'est pré-rempli ; aucune conversion FX). */
  @Put('approval-thresholds')
  @RequirePermissions('settings.manage')
  upsertThreshold(@Auth() ctx: AuthContext, @Body() dto: UpsertThresholdDto) {
    return this.config.upsertThreshold(ctx, dto);
  }

  // ------------------------------------------------------------------ exports (reports.export)

  @Get('exports/purchase-requests.xlsx')
  @RequirePermissions('reports.export', 'pr.view')
  exportPrs(@Auth() ctx: AuthContext, @Query() q: ExportPrQuery) {
    return this.exports.purchaseRequests(ctx, q);
  }

  @Get('exports/orders.xlsx')
  @RequirePermissions('reports.export', 'bc.view')
  exportOrders(@Auth() ctx: AuthContext, @Query() q: ExportOrdersQuery) {
    return this.exports.purchaseOrders(ctx, q);
  }

  // ------------------------------------------------------------------ relances (déclenchement manuel / recette)

  @Post('followup/run')
  @RequirePermissions('settings.manage')
  runFollowup() {
    return this.followup.run();
  }
}
