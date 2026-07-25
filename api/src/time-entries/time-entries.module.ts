import { Module } from '@nestjs/common';
import { TimeEntriesService } from './time-entries.service';
import { TimeEntriesController } from './time-entries.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  imports: [NotificationsModule, FinanceModule],
  providers: [TimeEntriesService],
  controllers: [TimeEntriesController],
  exports: [TimeEntriesService],
})
export class TimeEntriesModule {}
