import { Module } from '@nestjs/common';
import { CustomStatusesService } from './custom-statuses.service';
import { CustomStatusesController } from './custom-statuses.controller';

/**
 * Sous-statuts configurables (Custom Status). AdminSettingsService
 * (write-policy) et PrismaService sont @Global — rien à importer.
 * La sync statut ↔ sous-statut des tâches vit dans TasksService (chokepoint),
 * qui requête Prisma directement — pas de dépendance de module.
 */
@Module({
  providers: [CustomStatusesService],
  controllers: [CustomStatusesController],
  exports: [CustomStatusesService],
})
export class CustomStatusesModule {}
