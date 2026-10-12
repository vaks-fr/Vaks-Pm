import { Module } from '@nestjs/common';
import { TasksModule } from '../tasks/tasks.module';
import { WorkloadModule } from '../workload/workload.module';
import { CalendarService } from './calendar.service';
import { CalendarFeedController } from './calendar-feed.controller';
import { CalendarSubscriptionController } from './calendar-subscription.controller';

/**
 * Slice C du calendrier (flux ICS personnel). Importe `TasksModule` /
 * `WorkloadModule` pour leurs services déjà exportés — aucune logique
 * dupliquée, `CalendarService` ne fait qu'assembler leurs helpers de lecture
 * self-only en VCALENDAR.
 */
@Module({
  imports: [TasksModule, WorkloadModule],
  providers: [CalendarService],
  controllers: [CalendarFeedController, CalendarSubscriptionController],
})
export class CalendarModule {}
