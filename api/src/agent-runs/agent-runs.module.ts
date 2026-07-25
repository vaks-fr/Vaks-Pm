import { Module } from '@nestjs/common';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunsController } from './agent-runs.controller';

/** Runs d'agent — coût déclaratif (chantier finance agents). Prisma est global. */
@Module({
  providers: [AgentRunsService],
  controllers: [AgentRunsController],
  exports: [AgentRunsService],
})
export class AgentRunsModule {}
