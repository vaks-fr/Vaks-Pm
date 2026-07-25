import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AgentsService } from './agents.service';
import { AgentConnectorsService } from './agent-connectors.service';
import { AgentProviderRegistry } from './agent-provider.registry';
import { EntraAgentProvider } from './providers/entra-agent.provider';
import { AgentsAdminController, AgentConnectorsAdminController } from './agents-admin.controller';
import { AgentsPublicController, AgentsMeController } from './agents-public.controller';
import { PolicyEngineService } from './policy-engine.service';

/**
 * Agents IA — chantiers 1 & 3 (AGENTS_ARCHITECTURE.md) : identités
 * (User.kind=AGENT), jetons, provisioning (connecteurs plateforme +
 * enregistrement entrant), et **moteur de policies** (chantier 3 —
 * `PolicyEngineService`, exporté et consommé par `TasksService`).
 * Prisma / ApiTokens / AuditLogs / TenantCrypto / Admin (RolesService) sont
 * `@Global` → seul AuthModule est importé (guards).
 */
@Module({
  imports: [AuthModule],
  providers: [
    AgentsService,
    AgentConnectorsService,
    AgentProviderRegistry,
    EntraAgentProvider,
    PolicyEngineService,
  ],
  controllers: [AgentsAdminController, AgentConnectorsAdminController, AgentsPublicController, AgentsMeController],
  exports: [AgentsService, PolicyEngineService],
})
export class AgentsModule {}
