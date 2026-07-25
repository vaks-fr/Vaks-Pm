import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AgentFederationVerifier } from './agent-federation.verifier';
import { AgentFederationService } from './agent-federation.service';
import { AgentTrustIssuersService } from './agent-trust-issuers.service';
import { AgentTrustIssuersController } from './agent-trust-issuers.controller';
import { FederatedTokenPurgeCronService } from './federated-token-purge-cron.service';

/**
 * Fédération d'identité des agents (RFC 8693 token exchange).
 *
 * Volontairement séparé d'`AgentsModule` : `OAuthModule` n'a besoin que du
 * service d'échange, et l'importer ne doit pas tirer tout le domaine agents
 * (connecteurs, policies, dispatch) dans la façade OAuth. Prisma / ApiTokens /
 * AuditLogs / TenantContext sont `@Global` → seul AuthModule est importé, pour
 * les guards du controller d'administration.
 */
@Module({
  imports: [AuthModule],
  providers: [
    AgentFederationVerifier,
    AgentFederationService,
    AgentTrustIssuersService,
    FederatedTokenPurgeCronService,
  ],
  controllers: [AgentTrustIssuersController],
  exports: [AgentFederationService],
})
export class AgentFederationModule {}
