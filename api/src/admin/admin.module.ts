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
import { AgentsModule } from '../agents/agents.module';

@Global()
@Module({
  // AgentsModule : uniquement pour injecter PolicyEngineService dans
  // AdminSettingsController (invalidation du cache policies sur le chemin
  // d'écriture générique `/admin/settings`, cf. audit sécu 2026-08-01 finding
  // #7 résiduel). Pas de cycle : AgentsModule n'importe jamais AdminModule
  // (@Global() rend déjà AdminSettingsService injectable là-bas sans import).
  imports: [forwardRef(() => AuthModule), AgentsModule],
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
