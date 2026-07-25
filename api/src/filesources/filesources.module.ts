import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { FileSourceProviderRegistry } from './file-source-provider.registry';
import { SharePointProvider } from './providers/sharepoint.provider';
import { GoogleDriveProvider } from './providers/google-drive.provider';
import { ConnectorsFileSourceAdminService } from './filesources-admin.service';
import { FileSourcesService } from './filesources.service';
import { FileSourcesController } from './filesources.controller';
import { ProjectFileSourcesController } from './project-filesources.controller';
import { FileSourcesAdminController } from './filesources-admin.controller';
import { SharePointController } from './sharepoint.controller';

/**
 * Seam « sources de fichiers » : lecture par les agents IA de documents stockés
 * hors de vaks-pm (SharePoint de la team provisionnée en v1). Proxy live.
 *
 * `@Global` pour que `TeamsProvisioningService` puisse résoudre `SharePointProvider`
 * en lazy (ModuleRef) et déclencher la résolution de site au provisioning.
 * Prisma / Crypto / AuditLogs / Cache / Licensing / AdminSettings + GraphService
 * (exporté par TeamsProvisioningModule @Global) sont fournis ailleurs.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [
    FileSourceProviderRegistry,
    SharePointProvider,
    GoogleDriveProvider,
    ConnectorsFileSourceAdminService,
    FileSourcesService,
  ],
  controllers: [
    FileSourcesController,
    ProjectFileSourcesController,
    FileSourcesAdminController,
    SharePointController,
  ],
  exports: [SharePointProvider, FileSourcesService],
})
export class FileSourcesModule {}
