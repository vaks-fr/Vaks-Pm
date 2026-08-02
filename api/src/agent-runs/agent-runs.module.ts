import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunsController } from './agent-runs.controller';

/**
 * Runs d'agent — coût déclaratif (chantier finance agents). Prisma est global.
 * `AgentsModule` fournit les enveloppes de budget + le moteur de policies
 * (coupe-circuit lot A) ; pas de cycle : AgentsModule n'importe pas celui-ci.
 */
@Module({
  imports: [AgentsModule],
  providers: [AgentRunsService],
  controllers: [AgentRunsController],
  exports: [AgentRunsService],
})
export class AgentRunsModule {}
