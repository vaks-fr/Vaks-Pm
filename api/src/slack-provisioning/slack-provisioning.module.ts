import { Global, Module } from '@nestjs/common';
import { SlackProvisioningService } from './slack-provisioning.service';
import { SlackProvisioningAdminController } from './slack-provisioning-admin.controller';

/**
 * Provisioning Slack. Global pour que `ProjectsService` injecte le service et
 * déclenche le provisioning à l'activation d'un projet (comme Teams).
 */
@Global()
@Module({
  controllers: [SlackProvisioningAdminController],
  providers: [SlackProvisioningService],
  exports: [SlackProvisioningService],
})
export class SlackProvisioningModule {}
