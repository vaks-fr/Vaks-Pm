import { Global, Module, forwardRef } from '@nestjs/common';
import { AdminSettingsService } from './admin-settings.service';
import { AdminSettingsController } from './admin-settings.controller';
import { RolesService } from './roles.service';
import { RolesController } from './roles.controller';
import { DocumentTemplatesController } from './document-templates.controller';
import { AdminSecurityController } from './admin-security.controller';
import { DiagnosticsService } from './diagnostics.service';
import { DiagnosticsController } from './diagnostics.controller';
import { CryptoAdminService } from './crypto-admin.service';
import { CryptoAdminController } from './crypto-admin.controller';
import { DataManagementService } from './data-management.service';
import { DataManagementController } from './data-management.controller';
import { DataPurgeCronService } from './data-purge-cron.service';
import { AuthModule } from '../auth/auth.module';

@Global()
@Module({
  imports: [forwardRef(() => AuthModule)],
  providers: [
    AdminSettingsService,
    RolesService,
    DiagnosticsService,
    CryptoAdminService,
    DataManagementService,
    DataPurgeCronService,
  ],
  controllers: [
    AdminSettingsController,
    RolesController,
    DocumentTemplatesController,
    AdminSecurityController,
    DiagnosticsController,
    CryptoAdminController,
    DataManagementController,
  ],
  exports: [AdminSettingsService, RolesService],
})
export class AdminModule {}
