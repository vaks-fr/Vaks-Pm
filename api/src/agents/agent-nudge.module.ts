import { Global, Module } from '@nestjs/common';
import { AgentsModule } from './agents.module';
import { AgentNudgeService } from './agent-nudge.service';
import { AgentWebhookSubscriptionsController } from './agent-webhook-subscriptions.controller';
import { AgentNudgeInternalController } from './agent-nudge-internal.controller';
import { AgentNudgeAdminController } from './agent-nudge-admin.controller';

/**
 * Nudge sortant vers les agents IA. `@Global` pour que TasksService /
 * CommentsService puissent injecter `AgentNudgeService` sans cycle d'import
 * (même motif que `WebhooksModule`). `WebhooksService`, `TenantUrlService`,
 * `TenantContext` et `PrismaService` sont fournis par des modules globaux.
 */
@Global()
@Module({
  // `AgentsModule` (n'importe que AuthModule → aucun cycle) exporte
  // `PolicyEngineService` et `AgentBudgetService`, dont le gate de capacité a
  // besoin. On l'IMPORTE plutôt que de redéclarer ces providers : sinon le
  // nudge aurait sa propre instance de `PolicyEngineService`, avec un cache
  // 30 s distinct que le `invalidate()` de l'admin ne purgerait pas — un
  // changement de `backpressure.maxPendingReviews` mettrait jusqu'à 30 s à
  // être vu ici alors qu'il serait déjà actif au submit.
  imports: [AgentsModule],
  providers: [AgentNudgeService],
  controllers: [
    AgentWebhookSubscriptionsController,
    AgentNudgeInternalController,
    AgentNudgeAdminController,
  ],
  exports: [AgentNudgeService],
})
export class AgentNudgeModule {}
