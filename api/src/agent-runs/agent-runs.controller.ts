import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { Audited } from '../audit-logs/audited.decorator';
import { AgentRunsService } from './agent-runs.service';
import { CreateAgentRunDto } from './dto/create-agent-run.dto';

@ApiTags('agent-runs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller()
export class AgentRunsController {
  constructor(private readonly runs: AgentRunsService) {}

  /**
   * Déclaration par l'agent de SON run (coût réel : tokens + €). Surface
   * publique (PAT agent) ; un agent ne déclare que le sien (agentId = acteur).
   */
  @Post('agent-runs')
  @PublicApi()
  @RequirePermissions('task:view')
  @Audited('agent.run.reported', { resource: 'agent_run' })
  report(@CurrentUser() user: AuthUser, @Body() dto: CreateAgentRunDto) {
    return this.runs.report(
      user.orgId,
      { userId: user.userId, actorKind: user.actorKind ?? 'HUMAN' },
      dto,
    );
  }

  /** Synthèse d'usage d'un agent (app-privé, admin `agent:manage`). */
  @Get('admin/agents/:agentId/runs')
  @RequirePermissions('agent:manage')
  summary(@CurrentUser() user: AuthUser, @Param('agentId', ParseUUIDPipe) agentId: string) {
    return this.runs.summaryForAgent(user.orgId, agentId);
  }
}
