import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { SkipAudit } from '../../audit-logs/audited.decorator';
import { AuthUser, CurrentUser } from '../../auth/current-user.decorator';
import { AgentSelfAuthService } from './agent-self-auth.service';

/**
 * Émission des credentials machine d'un agent (refresh durable rotatif).
 *
 * **App-privé, `agent:manage`** : donner à un agent le moyen de s'authentifier
 * tout seul est un acte humain. Le secret `vaks_agr_…` n'est renvoyé qu'une fois,
 * à la création. `@SkipAudit` : le service journalise lui-même en CRITICAL.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/agents')
export class AgentCredentialsController {
  constructor(private readonly selfAuth: AgentSelfAuthService) {}

  @Get(':id/credentials')
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.selfAuth.listCredentials(user.orgId, id);
  }

  @Post(':id/credentials')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  issue(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { label?: string },
  ) {
    return this.selfAuth.issueCredential(user.orgId, id, user.userId, body?.label);
  }

  @Delete(':id/credentials/:credentialId')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  revoke(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('credentialId') credentialId: string,
  ) {
    return this.selfAuth.revokeCredential(user.orgId, id, credentialId, user.userId);
  }
}
