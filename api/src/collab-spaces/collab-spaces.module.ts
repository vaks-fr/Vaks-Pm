import { Module } from '@nestjs/common';
import { CollabSpacesController } from './collab-spaces.controller';
import { CollabSpacesService } from './collab-spaces.service';
import { CollabProvisionController } from './collab-provision.controller';
import { CollabProvisionService } from './collab-provision.service';

/**
 * Espaces de collaboration par projet : déclaration entrante + lecture
 * (`CollabSpaces*`) et provisioning sortant multi-fournisseurs au niveau projet
 * (`CollabProvision*`). Les services de provisioning (Teams/Slack/Google Chat)
 * vivent dans des modules `@Global`, donc injectables sans import ici.
 */
@Module({
  controllers: [CollabSpacesController, CollabProvisionController],
  providers: [CollabSpacesService, CollabProvisionService],
  exports: [CollabSpacesService],
})
export class CollabSpacesModule {}
