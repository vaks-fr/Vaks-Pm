import { Module } from '@nestjs/common';
import { AutomationsModule } from '../automations/automations.module';
import { AnnouncementsService } from './announcements.service';
import { AnnouncementsController } from './announcements.controller';

/**
 * Annonces projet (canal « prévenir les parties prenantes », notamment via
 * l'assistant IA). Notifications/Webhooks/Admin/AuditLogs sont @Global ;
 * AutomationsModule est importé pour `WatchersService` (audience `watchers`).
 */
@Module({
  imports: [AutomationsModule],
  providers: [AnnouncementsService],
  controllers: [AnnouncementsController],
  exports: [AnnouncementsService],
})
export class AnnouncementsModule {}
