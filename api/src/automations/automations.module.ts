import { Module } from '@nestjs/common';
import { WorkloadModule } from '../workload/workload.module';
import { FinanceModule } from '../finance/finance.module';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationRecipientsService } from './automation-recipients.service';
import { AutomationsEvaluatorService } from './automations-evaluator.service';
import { AutomationsHooksService } from './automations-hooks.service';
import { AutomationsCronService } from './automations-cron.service';
import { AutomationsAdminController } from './automations-admin.controller';
import { WatchersService } from './watchers.service';
import { WatchersController, MeWatchingController } from './watchers.controller';
import { RecurringTasksService } from './recurring-tasks.service';
import { RecurringTasksController } from './recurring-tasks.controller';

/**
 * Automatisations built-in (BUILTIN_AUTOMATIONS.md) : règles livrées de base,
 * activables/paramétrables dans l'admin (`OrgSetting` clés `automations.*`),
 * jamais composées par l'utilisateur final.
 *
 * Dépendances (Notifications/Webhooks/Admin/AuditLogs/Tenancy) : tous
 * @Global — aucun import de module métier ici. Les mutations d'état des lots
 * suivants résoudront TasksService & co en lazy via ModuleRef pour éviter
 * les cycles.
 */
@Module({
  // WorkloadModule exporte CapacityService (règles de charge), FinanceModule
  // exporte FinanceService (règles de budget). Notifications/Webhooks/Admin/
  // AuditLogs/Tenancy sont @Global — rien à importer pour eux.
  imports: [WorkloadModule, FinanceModule],
  providers: [
    AutomationActionsService,
    AutomationRecipientsService,
    AutomationsEvaluatorService,
    AutomationsHooksService,
    AutomationsCronService,
    WatchersService,
    RecurringTasksService,
  ],
  controllers: [
    AutomationsAdminController,
    WatchersController,
    MeWatchingController,
    RecurringTasksController,
  ],
  exports: [AutomationActionsService, AutomationsHooksService, WatchersService],
})
export class AutomationsModule {}
