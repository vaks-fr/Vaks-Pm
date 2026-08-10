import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AgentRunsService } from './agent-runs.service';
import { AgentRunsController } from './agent-runs.controller';
import { LAZY_AGENT_RUNS } from './agent-runs.tokens';

/**
 * Runs d'agent — coût déclaratif (chantier finance agents). Prisma est global.
 * `AgentsModule` fournit les enveloppes de budget + le moteur de policies
 * (coupe-circuit lot A) ; pas de cycle : AgentsModule n'importe pas celui-ci.
 */
@Module({
  imports: [AgentsModule],
  providers: [
    AgentRunsService,
    // Alias par token string consommé lazy par `McpToolQuotaInterceptor`.
    { provide: LAZY_AGENT_RUNS, useExisting: AgentRunsService },
  ],
  controllers: [AgentRunsController],
  exports: [AgentRunsService, LAZY_AGENT_RUNS],
})
export class AgentRunsModule {}
