import { Body, Controller, Get, Param, Patch, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { AgentNudgeService } from './agent-nudge.service';

/**
 * Visibilité admin des souscriptions de nudge agent + journal de livraisons.
 * App-privé (pas `@PublicApi`), gaté `agent:manage` (comme la gestion des
 * agents). Lecture + toggle actif/inactif d'une souscription.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/agent-webhook-subscriptions')
export class AgentNudgeAdminController {
  constructor(
    private readonly nudge: AgentNudgeService,
    private readonly apiTokens: ApiTokensService,
  ) {}

  @Get()
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.nudge.listSubscriptionsForAdmin(user.orgId);
  }

  /**
   * Génère une **clé org dédiée** à coller dans le provider (Copilot/n8n) pour
   * abonner un nudge org-level. Scope minimal `nudge:manage` (ne peut RIEN lire),
   * expiration ~2 ans. Le secret n'est renvoyé qu'ici (montré une seule fois).
   */
  @Post('connector-key')
  @RequirePermissions('agent:manage')
  connectorKey(@CurrentUser() user: AuthUser) {
    const expiresAt = new Date(Date.now() + 725 * 24 * 60 * 60 * 1000).toISOString();
    return this.apiTokens.create(user.orgId, 'ORG', {
      createdById: user.userId,
      dto: { name: 'Agent nudges — connecteur', scopes: ['nudge:manage'], expiresAt },
    });
  }

  @Get('deliveries')
  @RequirePermissions('agent:manage')
  deliveries(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    return this.nudge.listDeliveriesForAdmin(user.orgId, limit ? Number(limit) : 100);
  }

  /** Statut du mode on-prem (gate) + CIDR internes approuvés. */
  @Get('internal-cidrs')
  @RequirePermissions('agent:manage')
  internalCidrs(@CurrentUser() user: AuthUser) {
    return this.nudge.internalCidrsStatus(user.orgId);
  }

  /** Édite les CIDR internes approuvés (audit explicite → `@SkipAudit`). */
  @Put('internal-cidrs')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  setInternalCidrs(@CurrentUser() user: AuthUser, @Body() body: { cidrs: string[] }) {
    return this.nudge.setInternalCidrs(user.orgId, body?.cidrs ?? [], user.userId);
  }

  @Patch(':id')
  @RequirePermissions('agent:manage')
  setActive(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() body: { active: boolean },
  ) {
    return this.nudge.setActiveForAdmin(user.orgId, id, !!body?.active);
  }
}
