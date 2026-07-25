import { Module } from '@nestjs/common';
import { OpsController } from './ops.controller';
import { BackupAlertService } from './backup-alert.service';

/**
 * Module d'exploitation : endpoints `/ops/*` pour les signaux d'infrastructure
 * host-side (échec de sauvegarde). Les services injectés (Prisma, Notifications,
 * Webhooks, AuditLog) proviennent de modules @Global — pas d'import nécessaire.
 */
@Module({
  controllers: [OpsController],
  providers: [BackupAlertService],
})
export class OpsModule {}
