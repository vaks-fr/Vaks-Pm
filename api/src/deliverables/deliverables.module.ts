import { Module } from '@nestjs/common';
import { DeliverablesService } from './deliverables.service';
import { DeliverablesController } from './deliverables.controller';
import { AgentValidationController } from './agent-validation.controller';
import { AgentValidationCronService } from './agent-validation-cron.service';
import { PendingReviewsService } from './pending-reviews.service';
import { PendingReviewsController } from './pending-reviews.controller';
import { TasksModule } from '../tasks/tasks.module';
import { CiWebhooksModule } from '../ci-webhooks/ci-webhooks.module';

/**
 * Livrables (chantier 2c). Dépend de `TasksModule` (délègue la transition de
 * statut à `TasksService`) et de `CiWebhooksModule` (corroboration serveur de la
 * preuve `ci_signed` au gate de revue — phase C). Prisma / Webhooks sont fournis
 * globalement.
 */
@Module({
  imports: [TasksModule, CiWebhooksModule],
  providers: [DeliverablesService, AgentValidationCronService, PendingReviewsService],
  controllers: [DeliverablesController, AgentValidationController, PendingReviewsController],
  exports: [DeliverablesService],
})
export class DeliverablesModule {}
