import { Global, Module } from '@nestjs/common';
import { GoogleDriveProvisioningService } from './google-drive-provisioning.service';
import { GoogleDriveProvisioningAdminController } from './google-drive-provisioning-admin.controller';

/**
 * Provisioning d'un Drive partagé Google par projet (4ᵉ fournisseur collab).
 * Global pour que `ProjectsService` (activation de projet), `CollabProvisionService`
 * et le provider de lecture `filesources` puissent l'injecter — comme Teams,
 * Slack et Google Chat.
 */
@Global()
@Module({
  controllers: [GoogleDriveProvisioningAdminController],
  providers: [GoogleDriveProvisioningService],
  exports: [GoogleDriveProvisioningService],
})
export class GoogleDriveProvisioningModule {}
