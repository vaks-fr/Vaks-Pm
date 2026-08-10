import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { MeTasksController } from './me-tasks.controller';
import { SkillsModule } from '../skills/skills.module';
import { TaskTransitionService } from './task-transition.service';
import { AgentsModule } from '../agents/agents.module';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentDispatchController } from '../agents/agent-dispatch.controller';
import { AgentExecutionLeaseCronService } from './agent-execution-lease-cron.service';
import { SubtreeVerificationService } from '../deliverables/subtree-verification.service';
import { LAZY_AGENT_DISPATCH } from '../agents/agent-nudge.service';

/**
 * Le dispatch « pull » des agents (chantier 4, `AgentDispatch*`) vit ici plutôt
 * que dans AgentsModule : il consomme `TasksService.claim` (même module) ET
 * `PolicyEngineService` (via AgentsModule déjà importé) — l'héberger dans
 * AgentsModule créerait un cycle AgentsModule↔TasksModule.
 */
@Module({
  imports: [SkillsModule, AgentsModule],
  providers: [
    TasksService,
    TaskTransitionService,
    AgentDispatchService,
    AgentExecutionLeaseCronService,
    // Fourni ICI et pas dans DeliverablesModule : celui-ci importe déjà
    // TasksModule, l'inverse ferait un cycle. Le service est autonome (Prisma +
    // settings + logique pure de vérification).
    SubtreeVerificationService,
    // Alias par token string consommé par `AgentNudgeService` (reprise des
    // agents). Il ne peut PAS importer `AgentDispatchService` en valeur : le
    // cycle agent-dispatch → tasks → agent-nudge ferait capturer `undefined`
    // pour `TasksService` dans les métadonnées d'injection du dispatch.
    { provide: LAZY_AGENT_DISPATCH, useExisting: AgentDispatchService },
  ],
  controllers: [TasksController, MeTasksController, AgentDispatchController],
  exports: [TasksService, SubtreeVerificationService],
})
export class TasksModule {}
