import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AuthGuard } from './common/guards/auth.guard';
import { RequestIdMiddleware } from './common/request-id.middleware';
import { HealthController } from './health.controller';
import { AccessModule } from './modules/access/access.module';
import { AdminModule } from './modules/admin/admin.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { CertificatesModule } from './modules/certificates/certificates.module';
import { CsoModule } from './modules/cso/cso.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { DocumentsModule } from './modules/documents/documents.module';
import { ExportsModule } from './modules/exports/exports.module';
import { FilesModule } from './modules/files/files.module';
import { JobsModule } from './modules/jobs/jobs.module';
import { MembersModule } from './modules/members/members.module';
import { NoonModule } from './modules/noon/noon.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { PurchasingModule } from './modules/purchasing/purchasing.module';
import { SettingsModule } from './modules/settings/settings.module';
import { VesselsModule } from './modules/vessels/vessels.module';
import { VoyagesModule } from './modules/voyages/voyages.module';
import { PrismaModule } from './prisma/prisma.module';

/**
 * Monolithe modulaire (CDC §1.1) : Identity/Access, Fleet, Members, Certificates, CSO,
 * Procurement, Voyages, Noon, Notifications, Files, Audit, Reporting.
 */
@Module({
  imports: [
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    // Plateforme (globaux)
    PrismaModule,
    SettingsModule,
    AccessModule,
    AuditModule,
    JobsModule,
    NotificationsModule,
    FilesModule,
    DocumentsModule,
    // Identité & administration
    AuthModule,
    AdminModule,
    // Domaines métier
    VesselsModule,
    MembersModule,
    CertificatesModule,
    CsoModule,
    PurchasingModule,
    VoyagesModule,
    NoonModule,
    DashboardModule,
    ExportsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
