import { Body, Controller, Get, Headers, Param, ParseUUIDPipe, Post, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { toCsv, sendCsv } from '../common/csv.util';
import { ListAgentRunsDto } from './dto/list-agent-runs.dto';
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
  report(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAgentRunDto,
    // La passerelle LLM (ou une passerelle externe / le collecteur de logs) porte
    // ce header ; l'API l'honore pour marquer une source MESURÉE (jamais via le
    // body). Absent pour un report direct (`self`).
    @Headers('x-vaks-gateway-secret') gatewaySecret?: string,
    // Raffine la source mesurée : `gateway` (défaut) vs `runtime_log` (collecteur).
    @Headers('x-vaks-run-source') runSource?: string,
  ) {
    return this.runs.report(
      user.orgId,
      { userId: user.userId, actorKind: user.actorKind ?? 'HUMAN' },
      dto,
      gatewaySecret,
      runSource,
    );
  }

  /** Synthèse d'usage d'un agent (app-privé, admin `agent:manage`). */
  @Get('admin/agents/:agentId/runs')
  @RequirePermissions('agent:manage')
  summary(@CurrentUser() user: AuthUser, @Param('agentId', ParseUUIDPipe) agentId: string) {
    return this.runs.summaryForAgent(user.orgId, agentId);
  }

  /**
   * Journal transverse des runs d'agent (app-privé, `agent:manage` → accessible
   * à l'« AI administrator » sans être admin global). Filtres cumulatifs +
   * totaux sur le périmètre filtré. Pendant du journal d'audit, côté coût IA.
   */
  @Get('admin/agent-runs')
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser, @Query() q: ListAgentRunsDto) {
    return this.runs.list(user.orgId, {
      ...q,
      anomaliesOnly: String(q.anomaliesOnly) === 'true',
    });
  }

  /** Même périmètre, en CSV (analyse hors ligne / refacturation). */
  @Get('admin/agent-runs.csv')
  @RequirePermissions('agent:manage')
  async listCsv(
    @CurrentUser() user: AuthUser,
    @Query() q: ListAgentRunsDto,
    @Res() res: Response,
  ) {
    // Export borné comme la vue : on ne streame pas des millions de lignes pour
    // un journal qui se compte en milliers.
    const r = await this.runs.list(user.orgId, {
      ...q,
      anomaliesOnly: String(q.anomaliesOnly) === 'true',
      page: 1,
      pageSize: 5000,
    });
    const rows = r.items.map((i) => [
      i.createdAt,
      i.agentName ?? i.agentId,
      i.model ?? '',
      i.projectName ?? '',
      i.taskNumber != null ? `#${i.taskNumber} ${i.taskTitle ?? ''}` : '',
      i.tokensIn ?? '',
      i.tokensOut ?? '',
      i.cost ?? '',
      i.derivedCost ?? '',
      i.source ?? 'self',
      i.anomaly ?? '',
      i.note ?? '',
    ]);
    sendCsv(
      res,
      'agent-runs.csv',
      toCsv(
        ['date', 'agent', 'model', 'project', 'task', 'tokensIn', 'tokensOut', 'cost', 'derivedCost', 'source', 'anomaly', 'note'],
        rows,
      ),
    );
  }
}
