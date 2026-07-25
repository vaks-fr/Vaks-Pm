import { Module } from '@nestjs/common';
import { FinanceService } from './finance.service';
import { FinanceController } from './finance.controller';
import { PortfolioFinanceController } from './portfolio-finance.controller';
import { FinanceApiGateGuard } from './finance-api-gate.guard';
import { WorkloadModule } from '../workload/workload.module';

/**
 * Module finance : taux horaires projet × personne, budget (Phase A) et
 * synthèse budgétaire réel/prévisionnel (Phase B). AdminSettingsService
 * (devise) et PrismaService sont fournis par des modules @Global ;
 * WorkloadService (heures d'allocation effectives) vient de WorkloadModule.
 */
@Module({
  imports: [WorkloadModule],
  providers: [FinanceService, FinanceApiGateGuard],
  controllers: [FinanceController, PortfolioFinanceController],
  exports: [FinanceService],
})
export class FinanceModule {}
