import { Global, Module } from '@nestjs/common';
import { env } from '../../config/env';
import { EmailProcessor } from './email.processor';
import { EmailService } from './email.service';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  controllers: [NotificationsController],
  providers: [EmailService, NotificationsService, ...(env().WORKERS_ENABLED ? [EmailProcessor] : [])],
  exports: [EmailService, NotificationsService],
})
export class NotificationsModule {}
