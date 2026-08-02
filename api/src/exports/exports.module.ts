import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { ExportJobStore } from './export-job.store';
import { ExportsService } from './exports.service';
import { ExportsController } from './exports.controller';
import { ExportsInternalController } from './exports-internal.controller';

/**
 * Exports asynchrones. Additif : les routes synchrones existantes ne bougent
 * pas, l'UI web continue de les utiliser.
 */
@Module({
  imports: [StorageModule, UsersModule],
  providers: [ExportJobStore, ExportsService],
  controllers: [ExportsController, ExportsInternalController],
  exports: [ExportsService],
})
export class ExportsModule {}
