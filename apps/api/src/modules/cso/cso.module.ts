import { Module } from '@nestjs/common';
import { env } from '../../config/env';
import { CsoAccessService } from './cso-access.service';
import { CsoCategoriesController, CsoFieldsController } from './cso-categories.controller';
import { CsoCategoriesService } from './cso-categories.service';
import { CsoDocumentsController, CsoMiscController, CsoVersionsController } from './cso-documents.controller';
import { CsoDocumentsService } from './cso-documents.service';
import { CsoFieldsService } from './cso-fields.service';
import { CsoFoldersController, CsoLibrariesController } from './cso-folders.controller';
import { CsoFoldersService } from './cso-folders.service';
import { CsoImportService } from './cso-import.service';
import { CsoRemindersService } from './cso-reminders.service';
import { CsoSearchService } from './cso-search.service';
import { CsoSharesController } from './cso-shares.controller';
import { CsoSharesService } from './cso-shares.service';
import { CsoImportController, CsoZipController } from './cso-transfer.controller';
import { CsoWorkflowService } from './cso-workflow.service';
import { CsoZipProcessor } from './cso-zip.processor';
import { CsoZipService } from './cso-zip.service';

/**
 * CSO — Company Security Officer : DMS de sûreté (CDC §5, décisions CSO-001..034).
 * Moteur d'accès : permission module ∧ scope navire ∧ ACL héritée (DENY prioritaire) ∧ workflow.
 * Le worker ZIP (file « exports », job « cso-zip ») n'est enregistré que si WORKERS_ENABLED.
 */
@Module({
  controllers: [
    CsoLibrariesController,
    CsoFoldersController,
    CsoDocumentsController,
    CsoVersionsController,
    CsoMiscController,
    CsoCategoriesController,
    CsoFieldsController,
    CsoZipController,
    CsoImportController,
    CsoSharesController,
  ],
  providers: [
    CsoAccessService,
    CsoFieldsService,
    CsoWorkflowService,
    CsoFoldersService,
    CsoDocumentsService,
    CsoCategoriesService,
    CsoSearchService,
    CsoZipService,
    CsoImportService,
    CsoRemindersService,
    CsoSharesService,
    ...(env().WORKERS_ENABLED ? [CsoZipProcessor] : []),
  ],
  exports: [CsoAccessService],
})
export class CsoModule {}
