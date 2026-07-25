import { Module } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { CustomFieldsController } from './custom-fields.controller';

/**
 * Champs personnalisés (custom fields). AdminSettingsService (write-policy) et
 * PrismaService sont @Global — rien à importer.
 */
@Module({
  providers: [CustomFieldsService],
  controllers: [CustomFieldsController],
  exports: [CustomFieldsService],
})
export class CustomFieldsModule {}
