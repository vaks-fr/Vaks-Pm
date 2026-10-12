import { Module } from '@nestjs/common';
import { RisksService } from './risks.service';
import { RisksController } from './risks.controller';
import { RiskAutoService } from './risk-auto.service';
import { LAZY_RISK_AUTO } from './risk-auto.tokens';

/**
 * Registre de risques (RAID, MVP=RISK). PrismaService est `@Global` — rien à
 * importer. `RiskAutoService` est résolu en LAZY (ModuleRef, `strict:false`,
 * token `LAZY_RISK_AUTO`) par `AutomationActionsService` — volontairement
 * AUCUN import de `AutomationsModule` ici : ce module ne dépend jamais des
 * automatisations, seul le sens inverse existe (cf. `automation-actions.service.ts`).
 */
@Module({
  providers: [
    RisksService,
    RiskAutoService,
    { provide: LAZY_RISK_AUTO, useExisting: RiskAutoService },
  ],
  controllers: [RisksController],
  exports: [RisksService, RiskAutoService],
})
export class RisksModule {}
