import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RegisterAgentDto, UpdateAgentCostProfileDto } from '@vaks-pm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { PublicApi, RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { AgentsService } from './agents.service';

/**
 * Enregistrement **entrant** d'agents par API (3ᵉ voie de provisioning —
 * plateformes sans connecteur : self-hosted, LangGraph, n8n hors Entra, CI…).
 *
 * `POST /agents` — clé org scopée `agent:manage`, upsert **idempotent** sur
 * `(idpSource='api', externalId)` (pattern `POST /external-tasks`).
 *
 * Garde-fous : l'agent arrive `DRAFT_ONLY`, capabilities lecture seule, **sans
 * PAT**. Le mint du jeton et l'élévation trust/capabilities restent app-privés
 * (humain dans l'UI) — sinon une clé org compromise fabriquerait identité +
 * credential (chaîne d'escalade complète). L'API déclare l'existence ;
 * l'humain active.
 */
@ApiTags('agents')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('agents')
export class AgentsPublicController {
  constructor(private readonly agents: AgentsService) {}

  @Post()
  @PublicApi('agent:manage')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @ApiOperation({
    summary: "Déclarer (upsert) un agent IA",
    description:
      "Upsert idempotent par `externalId`. L'agent créé arrive en trust DRAFT_ONLY, " +
      "capabilities lecture seule et sans jeton : un administrateur l'active et " +
      "lui mint un jeton dans l'UI. `ownerEmail` doit résoudre vers un humain actif.",
  })
  register(@CurrentUser() user: AuthUser, @Body() dto: RegisterAgentDto) {
    return this.agents.registerViaApi(user.orgId, dto, {
      id: user.userId,
      email: user.email ?? 'org-token',
      actorType: user.viaApiToken ? 'API_TOKEN' : 'USER',
    });
  }

  /**
   * Met à jour le **coût interne** (€/1K tokens entrée+sortie) d'un agent
   * désigné par `externalId`. **Coût interne seulement** : le taux facturé
   * client n'est pas modifiable ici (hors DTO). Le reste du profil (owner,
   * trust, capabilities, jeton) reste app-privé — cet endpoint n'expose QUE
   * les deux taux de coût, jamais le PATCH agent complet.
   */
  @Patch('cost-profile')
  @PublicApi('agent:manage')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @ApiOperation({
    summary: "Mettre à jour le coût interne d'un agent",
    description:
      "Fixe `costRateInPerKTokens` et/ou `costRateOutPerKTokens` (€/1K tokens) de " +
      "l'agent identifié par `externalId`. Coût interne uniquement — le taux facturé " +
      "client n'est pas modifiable par cette route. Ambiguïté si le même externalId " +
      "existe sur plusieurs sources → préciser `idpSource`.",
  })
  updateCostProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateAgentCostProfileDto) {
    return this.agents.updateCostProfileByExternalId(user.orgId, dto, {
      id: user.userId,
      email: user.email ?? 'org-token',
      actorType: user.viaApiToken ? 'API_TOKEN' : 'USER',
    });
  }
}

/**
 * Vue **workspace** des agents pour un utilisateur (dashboard, pas l'admin) :
 * ceux dont il est owner + ceux des équipes qu'il mène. Self-only (le sujet est
 * toujours le porteur du jeton). App-privé (JWT navigateur), aucune permission
 * spéciale requise — chacun ne voit que SES agents.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('me/agents')
export class AgentsMeController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  list(
    @CurrentUser() user: AuthUser,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.agents.listForUser(
      user.orgId,
      user.userId,
      page ? Number(page) : 1,
      pageSize ? Number(pageSize) : 10,
    );
  }

  /** Détail d'un agent (profil + compétences + usage + projets). 403 si l'agent
   *  n'est pas lié au caller (owner/lead). */
  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.agents.getDetailForUser(user.orgId, user.userId, id);
  }

  /** Owner/lead : change le modèle de l'agent (provider inchangé, catalogue connu). */
  @Patch(':id')
  updateModel(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { model?: string | null },
  ) {
    return this.agents.updateModelForUser(user.orgId, user.userId, id, body?.model ?? null);
  }

  /** Owner/lead : pose/met à jour une compétence de l'agent. */
  @Put(':id/skills/:skillId')
  setSkill(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('skillId') skillId: string,
    @Body() body: { level?: number },
  ) {
    return this.agents.setSkillForUser(user.orgId, user.userId, id, skillId, body?.level ?? 1);
  }

  /** Owner/lead : retire une compétence de l'agent. */
  @Delete(':id/skills/:skillId')
  removeSkill(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('skillId') skillId: string,
  ) {
    return this.agents.removeSkillForUser(user.orgId, user.userId, id, skillId);
  }
}
