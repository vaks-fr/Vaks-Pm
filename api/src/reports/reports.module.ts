import { Module } from '@nestjs/common';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { PortfolioKpiController } from './portfolio-kpi.controller';
import { ReportWidgetsService } from './report-widgets.service';
import { ReportWidgetsController } from './report-widgets.controller';
import { FinanceApiGateGuard } from '../finance/finance-api-gate.guard';
import { SkillsModule } from '../skills/skills.module';
import { WorkloadModule } from '../workload/workload.module';
import { FinanceModule } from '../finance/finance.module';

@Module({
  // WorkloadModule → CapacityService (conflits/headroom) ; FinanceModule →
  // FinanceService (EVM agrégé pour le Schedule Variance portefeuille).
  imports: [SkillsModule, WorkloadModule, FinanceModule],
  providers: [ReportsService, FinanceApiGateGuard, ReportWidgetsService],
  controllers: [ReportsController, PortfolioKpiController, ReportWidgetsController],
})
export class ReportsModule {}
