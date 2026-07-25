import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { AgentSelfAuthService } from './agent-self-auth.service';
import { AgentTokenController } from './agent-token.controller';
import { AgentCredentialsController } from './agent-credentials.controller';

/**
 * Auto-authentification des agents headless (refresh rotatif → jeton court).
 *
 * Surface strictement séparée de la façade OAuth/MCP (`OAuthModule`) : ici, que
 * des jetons d'agent, jamais de navigateur, jamais d'`OAuthConnection`. Prisma /
 * ApiTokens / AuditLogs / License sont `@Global` → seul AuthModule est importé
 * (guards du controller d'émission).
 */
@Module({
  imports: [AuthModule],
  providers: [AgentSelfAuthService],
  controllers: [AgentTokenController, AgentCredentialsController],
  exports: [AgentSelfAuthService],
})
export class AgentSelfAuthModule {}
