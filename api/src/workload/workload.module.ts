import { Module } from '@nestjs/common';
import { WorkloadService } from './workload.service';
import { WorkloadController } from './workload.controller';
import { AutoplanService } from './autoplan.service';
import { CapacityService } from './capacity.service';
import { AgentsWorkloadService } from './agents-workload.service';
import { HolidaysModule } from '../holidays/holidays.module';
import { AgentsModule } from '../agents/agents.module';

// AgentsModule n'importe que AuthModule (guards) → aucun cycle en important
// AgentsModule ici pour AgentBudgetService (Lot 5, §5.1/§5.2 — budget des
// agents dans la vue workload et l'auto-plan).
@Module({
  imports: [HolidaysModule, AgentsModule],
  providers: [WorkloadService, AutoplanService, CapacityService, AgentsWorkloadService],
  controllers: [WorkloadController],
  exports: [WorkloadService, CapacityService],
})
export class WorkloadModule {}
