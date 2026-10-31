import { Module } from '@nestjs/common';
import { CertificateAccessService } from './certificate-access.service';
import { CertificateFilesService } from './certificate-files.service';
import { CertificateRemindersService } from './certificate-reminders.service';
import { CertificateCategoriesController, CertificateFoldersController } from './certificate-tree.controller';
import { CertificateTreeService } from './certificate-tree.service';
import { CertificateReminderPoliciesController, CertificateTypesController } from './certificate-types.controller';
import { CertificateTypesService } from './certificate-types.service';
import { CertificateWorkflowService } from './certificate-workflow.service';
import { CertificateApprovalsController, CertificateRequestsController, CertificatesController } from './certificates.controller';
import { CertificatesService } from './certificates.service';

/**
 * Moteur Certificats VESSEL / MEMBER (CDC §4 — priorité critique) : configuration, explorateur,
 * conformité, workflow d'approbation, documents (resolver `certificate_attachment`) et rappels
 * (`SCHEDULED_JOBS.CERTIFICATE_REMINDERS`). Les services plateforme (Prisma, accès, audit,
 * fichiers, notifications, jobs, paramètres) sont fournis par des modules globaux.
 */
@Module({
  controllers: [
    CertificateTypesController,
    CertificateReminderPoliciesController,
    CertificateFoldersController,
    CertificateCategoriesController,
    CertificatesController,
    CertificateRequestsController,
    CertificateApprovalsController,
  ],
  providers: [
    CertificateAccessService,
    CertificateTypesService,
    CertificatesService,
    CertificateWorkflowService,
    CertificateFilesService,
    CertificateRemindersService,
    CertificateTreeService,
  ],
  exports: [CertificateAccessService, CertificatesService, CertificateWorkflowService],
})
export class CertificatesModule {}
