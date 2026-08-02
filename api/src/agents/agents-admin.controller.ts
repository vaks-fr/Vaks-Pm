import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CreateAgentDto, UpdateAgentDto, UpsertAgentConnectorDto } from '@vaks-pm/shared';
import { resolveLeaseMinutes } from './agent-budget';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { AgentsService } from './agents.service';
import { PolicyEngineService } from './policy-engine.service';
import { AgentConnectorsService } from './agent-connectors.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { normalizeAgentBrief } from './context/agent-brief';
import { pickExcLang, translateExc } from '../common/i18n/exception-i18n';

/**
 * Les résultats de test/sync d'un connecteur portent leur message dans le CORPS
 * de la réponse (`error`/`detail`), pas dans une exception — le filtre i18n
 * global ne les voit donc jamais. On les traduit ici, au seul endroit qui
 * connaît encore l'Accept-Language de la requête.
 */
function localizeResult<T extends { error?: string; detail?: string }>(req: Request, r: T): T {
  const lang = pickExcLang(req.headers['accept-language'] as string | undefined);
  return {
    ...r,
    ...(r.error ? { error: translateExc(r.error, lang) } : {}),
    ...(r.detail ? { detail: translateExc(r.detail, lang) } : {}),
  };
}

/** Convention de nommage des clés d'enregistrement d'agents (carte inbound). */
const AGENT_REG_KEY_PREFIX = 'inbound:agent-registration:';
/** Scopes FIXES d'une clé d'enregistrement d'agents (imposés côté serveur). */
const AGENT_REG_KEY_SCOPES = ['agent:manage'];

/** Clés OrgSetting pilotables via `/admin/agents/policies` (scope `agent:manage`).
 *  Whitelist stricte : un AI-admin ne doit écrire QUE la gouvernance agents,
 *  jamais les autres settings org (réservés à `org:manage`). */
const AGENT_POLICY_KEYS = [
  'agents.policies',
  'agents.backpressure.maxPendingReviews',
  'agents.requireRunDeclaration',
  'agents.preauthorizeBudget',
  // Lot A : bail d'exécution (min, 0 = off) + coupe-circuit budgétaire.
  'agents.executionLeaseMinutes',
  'agents.budgetBreaker',
  // Brief agent par défaut de l'org, hérité CHAMP PAR CHAMP par les projets :
  // les conventions maison (langue, format des livrables) se règlent une fois
  // ici au lieu d'être retapées dans chaque projet.
  'agents.briefDefault',
] as const;

function pickAgentPolicies(all: Record<string, unknown>) {
  return {
    'agents.policies': Array.isArray(all['agents.policies']) ? all['agents.policies'] : [],
    'agents.backpressure.maxPendingReviews':
      all['agents.backpressure.maxPendingReviews'] ?? 5,
    'agents.requireRunDeclaration': all['agents.requireRunDeclaration'] === true,
    'agents.preauthorizeBudget': all['agents.preauthorizeBudget'] === true,
    // Clé absente = filet armé au défaut serveur (30 min), PAS 0 : l'UI relit
    // ce bloc puis le réécrit tel quel au save — un 0 par omission désarmerait
    // silencieusement le bail à la première sauvegarde.
    'agents.executionLeaseMinutes': resolveLeaseMinutes(all['agents.executionLeaseMinutes']),
    'agents.budgetBreaker': all['agents.budgetBreaker'] === true,
    'agents.briefDefault': normalizeAgentBrief(all['agents.briefDefault']),
  };
}

/**
 * Administration des agents IA (chantier 1). **App-privé** (pas `@PublicApi`) :
 * la gestion des identités agents — et surtout le mint de leurs jetons — reste
 * une action humaine en session. Scope `agent:manage` (ORG_ADMIN).
 * Mutations auditées par hooks explicites `logCritical` → `@SkipAudit`.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/agents')
export class AgentsAdminController {
  constructor(
    private readonly agents: AgentsService,
    private readonly settings: AdminSettingsService,
    private readonly tokens: ApiTokensService,
    private readonly policies: PolicyEngineService,
  ) {}

  @Get()
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.agents.list(user.orgId);
  }

  // ---------- Clés d'enregistrement d'agents (carte inbound) ----------
  // Déclarées AVANT les routes `:id` pour éviter que `registration-keys` soit
  // capté comme un id d'agent. Scopes hardcodés `['agent:manage']` : pas
  // d'escalade (on accorde exactement ce que le caller détient déjà), et les
  // agents enregistrés via `POST /agents` arrivent DRAFT_ONLY sans jeton.

  @Get('registration-keys')
  @RequirePermissions('agent:manage')
  listRegistrationKeys(@CurrentUser() user: AuthUser) {
    return this.tokens.listOrgKeysByPurpose(user.orgId, AGENT_REG_KEY_PREFIX, AGENT_REG_KEY_SCOPES);
  }

  @Post('registration-keys')
  @RequirePermissions('agent:manage')
  @SkipAudit() // ApiTokensService.create émet API_TOKEN_CREATED (CRITICAL).
  createRegistrationKey(
    @CurrentUser() user: AuthUser,
    @Body() body: { expiresAt?: string | null; label?: string },
  ) {
    const label = (body?.label ?? '').trim();
    return this.tokens.create(user.orgId, 'ORG', {
      createdById: user.userId,
      dto: {
        name: `${AGENT_REG_KEY_PREFIX}${label || new Date(body?.expiresAt ?? Date.now()).toISOString().slice(0, 10)}`,
        scopes: AGENT_REG_KEY_SCOPES,
        expiresAt: body?.expiresAt,
      },
    });
  }

  @Delete('registration-keys/:id')
  @RequirePermissions('agent:manage')
  @SkipAudit() // revoke émet API_TOKEN_REVOKED (CRITICAL).
  @HttpCode(204)
  async revokeRegistrationKey(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.tokens.revokeScoped(user.orgId, id, AGENT_REG_KEY_PREFIX, user.userId);
  }

  /**
   * Policies de gouvernance agents (chantier 3) — lecture/écriture dédiée gatée
   * `agent:manage`, pour que l'« AI administrator » puisse les gérer SANS
   * `org:manage`. Miroir borné du générique `/admin/settings` : seules les 2
   * clés `agents.*` sont lisibles/écrivables ici (cf. AGENT_POLICY_KEYS).
   */
  @Get('policies')
  @RequirePermissions('agent:manage')
  async getPolicies(@CurrentUser() user: AuthUser) {
    return pickAgentPolicies(await this.settings.getAll(user.orgId));
  }

  @Put('policies')
  @RequirePermissions('agent:manage')
  @SkipAudit() // upsertMany émet déjà `settings.updated` (CRITICAL).
  async putPolicies(
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    const values: Record<string, unknown> = {};
    for (const k of AGENT_POLICY_KEYS) {
      if (body && k in body) values[k] = body[k];
    }
    await this.settings.upsertMany(user.orgId, values, {
      id: user.userId,
      email: user.email,
    });
    // Purge immédiate du cache 30 s (finding #7, audit sécu 2026-08-01) : sans
    // ça, un claim/auto-close survenant juste après ce PUT continuait de lire
    // les ANCIENNES policies jusqu'à expiration naturelle du TTL.
    this.policies.invalidate(user.orgId);
    return pickAgentPolicies(await this.settings.getAll(user.orgId));
  }

  /** Catalogue des capabilities assignables (l'UI affiche les permissions mappées). */
  @Get('capabilities')
  @RequirePermissions('agent:manage')
  capabilities() {
    return this.agents.listCapabilities();
  }

  @Post()
  @RequirePermissions('agent:manage')
  @SkipAudit()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateAgentDto) {
    return this.agents.create(user.orgId, dto, { id: user.userId, email: user.email });
  }

  @Patch(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpdateAgentDto) {
    return this.agents.update(user.orgId, id, dto, { id: user.userId, email: user.email });
  }

  @Delete(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.agents.remove(user.orgId, id, { id: user.userId, email: user.email });
  }

  /** Mint un PAT pour l'agent — secret montré UNE seule fois. TTL défaut 90 j. */
  @Post(':id/tokens')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  mintToken(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: { name?: string; expiresAt?: string | null; scopes?: string[] },
  ) {
    return this.agents.mintToken(user.orgId, id, dto ?? {}, { id: user.userId, email: user.email });
  }

  @Delete(':id/tokens/:tokenId')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @HttpCode(204)
  async revokeToken(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('tokenId') tokenId: string,
  ) {
    await this.agents.revokeToken(user.orgId, id, tokenId, { id: user.userId, email: user.email });
  }
}

/**
 * Connecteurs d'annuaire d'agents (Entra Agent ID, …). App-privé,
 * `agent:manage`. Chemin distinct de `/admin/agents` pour éviter toute
 * collision de routes avec `/admin/agents/:id`.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/agent-connectors')
export class AgentConnectorsAdminController {
  constructor(private readonly connectors: AgentConnectorsService) {}

  @Get('providers')
  @RequirePermissions('agent:manage')
  providers() {
    return this.connectors.listProviders();
  }

  @Get()
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.connectors.list(user.orgId);
  }

  @Post()
  @RequirePermissions('agent:manage')
  @SkipAudit()
  create(@CurrentUser() user: AuthUser, @Body() dto: UpsertAgentConnectorDto) {
    return this.connectors.create(user.orgId, dto, { id: user.userId, email: user.email });
  }

  @Patch(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpsertAgentConnectorDto) {
    return this.connectors.update(user.orgId, id, dto, { id: user.userId, email: user.email });
  }

  @Delete(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.connectors.remove(user.orgId, id, { id: user.userId, email: user.email });
  }

  @Post(':id/test')
  @RequirePermissions('agent:manage')
  @HttpCode(200)
  async test(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return localizeResult(req, await this.connectors.testConnection(user.orgId, id));
  }

  /** Sync manuelle « Sync now » — upsert des agents de la plateforme. */
  @Post(':id/sync')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @HttpCode(200)
  async sync(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request) {
    return localizeResult(req, await this.connectors.sync(user.orgId, id, { id: user.userId, email: user.email }));
  }
}
