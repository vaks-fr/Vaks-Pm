import { Module } from '@nestjs/common';
import { AgentFederationModule } from '../agents/federation/agent-federation.module';
import { OAuthController } from './oauth.controller';
import { OAuthService } from './oauth.service';
import { OAuthStoreService } from './oauth-store.service';
import { McpContextController } from './mcp-context.controller';
import { OAuthAdminController, OAuthAdminConnectionsController } from './oauth-admin.controller';
import { MeAiConnectionsController } from './me-ai-connections.controller';

/**
 * Façade Authorization Server OAuth 2.1 pour MCP (phase 11). Réutilise
 * `ApiTokensService` (module Global, phase 9) pour émettre les access tokens
 * `vaks_pat_` courts, et le `TenantContext` pour cloisonner par tenant.
 */
@Module({
  imports: [AgentFederationModule],
  controllers: [
    OAuthController,
    McpContextController,
    OAuthAdminController,
    OAuthAdminConnectionsController,
    MeAiConnectionsController,
  ],
  providers: [OAuthService, OAuthStoreService],
  exports: [OAuthService],
})
export class OAuthModule {}
