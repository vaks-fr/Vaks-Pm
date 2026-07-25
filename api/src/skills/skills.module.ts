import { Module } from '@nestjs/common';
import { SkillsService } from './skills.service';
import { SkillsController } from './skills.controller';
import { SkillsCronService } from './skills-cron.service';
import { SkillRequestsModule } from '../skill-requests/skill-requests.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { WorkloadModule } from '../workload/workload.module';

@Module({
  imports: [SkillRequestsModule, NotificationsModule, WorkloadModule],
  providers: [SkillsService, SkillsCronService],
  controllers: [SkillsController],
  exports: [SkillsService],
})
export class SkillsModule {}
