import { Global, Module } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { NotificationsCronService } from './notifications-cron.service';
import { BillingExportSchedulerService } from './billing-export-scheduler.service';
import { BillingExportAdminController } from './billing-export-admin.controller';
import { NotificationsController } from './notifications.controller';
import { NotificationsInternalController } from './notifications-internal.controller';
import { MeNotificationPrefsController } from './me-notification-prefs.controller';
import { MeNotificationsController } from './me-notifications.controller';
import { FinanceModule } from '../finance/finance.module';

@Global()
@Module({
  imports: [FinanceModule],
  providers: [NotificationsService, NotificationsCronService, BillingExportSchedulerService],
  controllers: [
    NotificationsController,
    NotificationsInternalController,
    MeNotificationPrefsController,
    MeNotificationsController,
    BillingExportAdminController,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
