import { Global, Module } from '@nestjs/common';
import { GoogleChatProvisioningService } from './google-chat-provisioning.service';
import { GoogleChatProvisioningAdminController } from './google-chat-provisioning-admin.controller';

/**
 * Provisioning Google Chat. Global pour que `ProjectsService` injecte le
 * service et déclenche le provisioning à l'activation d'un projet (comme
 * Teams et Slack).
 */
@Global()
@Module({
  controllers: [GoogleChatProvisioningAdminController],
  providers: [GoogleChatProvisioningService],
  exports: [GoogleChatProvisioningService],
})
export class GoogleChatProvisioningModule {}
