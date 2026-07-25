import { Module } from '@nestjs/common';
import { SkillRequestsService } from './skill-requests.service';
import { SkillRequestsController } from './skill-requests.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { WebhooksModule } from '../webhooks/webhooks.module';

@Module({
  imports: [NotificationsModule, WebhooksModule],
  providers: [SkillRequestsService],
  controllers: [SkillRequestsController],
  exports: [SkillRequestsService],
})
export class SkillRequestsModule {}
