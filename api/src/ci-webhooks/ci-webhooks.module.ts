import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CiConnectorsService } from './ci-connectors.service';
import { CiWebhooksService } from './ci-webhooks.service';
import { CiWebhooksCronService } from './ci-webhooks-cron.service';
import { CiWebhooksController } from './ci-webhooks.controller';
import { CiConnectorsAdminController } from './ci-connectors-admin.controller';

/**
 * Vérification des livrables agents — phase C (`ci_signed`). Webhook CI ENTRANT
 * signé HMAC + connecteurs signataires (secret chiffré at-rest) + buffer
 * `CiResultPending` (corroboration au gate) + purge TTL. Prisma / AuditLogs /
 * TenantCrypto / Tenancy sont `@Global` → seul AuthModule est importé (guards
 * de l'admin CRUD). `CiWebhooksService` est exporté pour `DeliverablesModule`
 * (corroboration de la preuve au gate de revue).
 */
@Module({
  imports: [AuthModule],
  providers: [CiConnectorsService, CiWebhooksService, CiWebhooksCronService],
  controllers: [CiWebhooksController, CiConnectorsAdminController],
  exports: [CiWebhooksService],
})
export class CiWebhooksModule {}
