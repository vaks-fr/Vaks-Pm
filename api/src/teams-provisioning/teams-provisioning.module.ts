import { Global, Module } from '@nestjs/common';
import { TeamsProvisioningService } from './teams-provisioning.service';
import { GraphService } from './graph.service';
import { TeamsReconcileCronService } from './teams-reconcile-cron.service';
import { TeamsProvisioningController } from './teams-provisioning.controller';
import { TeamsProvisioningAdminController } from './teams-provisioning-admin.controller';
import { TeamsProvisioningInternalController } from './teams-provisioning-internal.controller';

/**
 * Provisioning Microsoft Teams (Graph) — feature premium `teams-provisioning`.
 * Global pour que `ProjectsService` puisse injecter le service et enqueue le
 * provisioning à l'activation d'un projet (incrément 3).
 */
@Global()
@Module({
  providers: [TeamsProvisioningService, GraphService, TeamsReconcileCronService],
  controllers: [
    TeamsProvisioningController,
    TeamsProvisioningAdminController,
    TeamsProvisioningInternalController,
  ],
  exports: [TeamsProvisioningService, GraphService],
})
export class TeamsProvisioningModule {}
