import { Module } from '@nestjs/common';
import { TasksService } from './tasks.service';
import { TasksController } from './tasks.controller';
import { MeTasksController } from './me-tasks.controller';
import { SkillsModule } from '../skills/skills.module';
import { TaskTransitionService } from './task-transition.service';
import { AgentsModule } from '../agents/agents.module';
import { AgentDispatchService } from '../agents/agent-dispatch.service';
import { AgentDispatchController } from '../agents/agent-dispatch.controller';

/**
 * Le dispatch « pull » des agents (chantier 4, `AgentDispatch*`) vit ici plutôt
 * que dans AgentsModule : il consomme `TasksService.claim` (même module) ET
 * `PolicyEngineService` (via AgentsModule déjà importé) — l'héberger dans
 * AgentsModule créerait un cycle AgentsModule↔TasksModule.
 */
@Module({
  imports: [SkillsModule, AgentsModule],
  providers: [TasksService, TaskTransitionService, AgentDispatchService],
  controllers: [TasksController, MeTasksController, AgentDispatchController],
  exports: [TasksService],
})
export class TasksModule {}
