import { Global, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentContextService } from './agent-context.service';
import { ProjectAgentContextController } from './project-agent-context.controller';

/**
 * Composition du contexte agent d'un projet (refonte du contexte IA).
 *
 * `@Global` pour que `TasksService` puisse injecter `AgentContextService` sans
 * créer de dépendance de module : le work-context de la tâche et l'écran de
 * prévisualisation doivent passer par le MÊME code de composition, faute de quoi
 * l'écran mentirait dès la première divergence.
 *
 * Module feuille : Prisma, AdminSettings et FileSources sont fournis ailleurs
 * (tous `@Global`), donc aucun cycle possible avec ProjectsModule ou TasksModule.
 */
@Global()
@Module({
  imports: [AuthModule],
  providers: [AgentContextService],
  controllers: [ProjectAgentContextController],
  exports: [AgentContextService],
})
export class AgentContextModule {}
