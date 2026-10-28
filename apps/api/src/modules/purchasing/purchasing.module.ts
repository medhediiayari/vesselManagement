import { Module } from '@nestjs/common';
import { InvoicesController } from './invoices.controller';
import { InvoicesService } from './invoices.service';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';
import { PrRevisionsService } from './pr-revisions.service';
import { PurchaseRequestsController } from './purchase-requests.controller';
import { PurchaseRequestsService } from './purchase-requests.service';
import { PurchasingBoardService } from './purchasing-board.service';
import { PurchasingConfigService } from './purchasing-config.service';
import { PurchasingCore } from './purchasing-core.service';
import { PurchasingDocuments } from './purchasing-documents.service';
import { PurchasingExportsService } from './purchasing-exports.service';
import { PurchasingFollowupService } from './purchasing-followup.service';
import { PurchasingController } from './purchasing.controller';
import { QuotationsService } from './quotations.service';
import { ReceivingController } from './receiving.controller';
import { ReceivingService } from './receiving.service';
import { RfqsController } from './rfqs.controller';
import { RfqsService } from './rfqs.service';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { VariancesService } from './variances.service';

/**
 * Lot 4 — Achats (CDC §6, V1 §8-9) : fournisseurs, PR & Counter-PR, RFQ, devis & comparaison, BC/PO,
 * BL & réceptions, écarts, factures, PDF, exports, relances planifiées.
 * Services transverses (Prisma, Access, Audit, Files, Documents, Notifications, Settings, Jobs) : modules globaux.
 */
@Module({
  controllers: [
    SuppliersController,
    PurchaseRequestsController,
    RfqsController,
    OrdersController,
    ReceivingController,
    InvoicesController,
    PurchasingController,
  ],
  providers: [
    PurchasingCore,
    PurchasingConfigService,
    PurchasingDocuments,
    SuppliersService,
    PurchaseRequestsService,
    PrRevisionsService,
    RfqsService,
    QuotationsService,
    OrdersService,
    ReceivingService,
    VariancesService,
    InvoicesService,
    PurchasingExportsService,
    PurchasingBoardService,
    PurchasingFollowupService,
  ],
  exports: [PurchasingCore, PurchaseRequestsService, OrdersService],
})
export class PurchasingModule {}
