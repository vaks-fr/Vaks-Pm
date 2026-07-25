import { Module } from '@nestjs/common';
import { ScimController } from './scim.controller';
import { ScimService } from './scim.service';
import { ScimAuthGuard } from './scim-auth.guard';

/**
 * SCIM 2.0 (phase 10 lot 2). Provisioning/déprovisioning des comptes depuis
 * l'IdP. Toutes les dépendances (Prisma, ApiTokens, Roles, AuditLogs) sont
 * `@Global` → aucun import nécessaire.
 */
@Module({
  controllers: [ScimController],
  providers: [ScimService, ScimAuthGuard],
})
export class ScimModule {}
