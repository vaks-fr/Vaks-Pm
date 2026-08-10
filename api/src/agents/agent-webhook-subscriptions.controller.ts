import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import { AgentNudgeService, ORG_NUDGE_SUBJECT } from './agent-nudge.service';

/**
 * Souscription **self-provisionnée** d'un agent IA à ses nudges sortants
 * (chantier « réveil sur assignation »). Contrat subscribe/unsubscribe du
 * trigger « HTTP Webhook » de Logic Apps (Copilot Studio / Power Automate),
 * mais provider-agnostique (n8n, runner custom…).
 *
 * Self-only, comme `me/next-task` : le sujet est TOUJOURS dérivé du porteur du
 * jeton (jamais d'id de body/param). Deux modes :
 *  - **PAT d'agent** → souscription ciblée sur CET agent (`agentUserId=userId`).
 *  - **clé org** (`vaks_org_…`) → souscription **org-level** (`ORG_NUDGE_SUBJECT`) :
 *    un seul callback reçoit les nudges de TOUS les agents de l'org, chacun
 *    identifié dans le payload/headers du nudge → un seul flow provider qui
 *    branche sur `agentEmail`. C'est la voie « un flow pour tous les agents ».
 *
 * `@PublicApi('nudge:manage')` : appelable par un PAT agent (self) ou une clé org
 * scopée `nudge:manage` (scope dédié minimal). L'autorisation exacte est dans
 * `subjectFor` — un JWT humain de session est refusé (403).
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi('nudge:manage')
@Controller('me/webhook-subscriptions')
export class AgentWebhookSubscriptionsController {
  constructor(
    private readonly nudge: AgentNudgeService,
    private readonly tenantUrl: TenantUrlService,
  ) {}

  /**
   * Résout le **sujet** de la souscription depuis le porteur du jeton et applique
   * l'autorisation (pas de `@RequirePermissions` : agents et clé org n'ont pas de
   * permission commune). Agent PAT → self (son userId, souscription ciblée, sans
   * exposition). Clé org → sentinelle org, mais elle DOIT être scopée
   * `nudge:manage` (scope dédié minimal) — `task:view` toléré pour rétro-compat.
   * JWT humain de session → refusé (pas d'identité de service).
   */
  private subjectFor(user: AuthUser): string {
    if (user.actorKind === 'AGENT') return user.userId;
    if (user.viaApiToken && user.isOrgToken) {
      const scopes = user.tokenScopes ?? [];
      if (!scopes.includes('nudge:manage') && !scopes.includes('task:view')) {
        throw new ForbiddenException(
          'La clé organisation doit être scopée « nudge:manage » (ou « task:view »).',
        );
      }
      return ORG_NUDGE_SUBJECT;
    }
    throw new ForbiddenException(
      'Réservé aux jetons : PAT d’agent (souscription ciblée) ou clé organisation scopée « nudge:manage » (souscription org-level).',
    );
  }

  /** Souscription courante de l'agent (sans secret), ou null. */
  @Get()
  get(@CurrentUser() user: AuthUser) {
    return this.nudge.mySubscription(user.orgId, this.subjectFor(user));
  }

  /**
   * S'abonne (upsert). Body `{ callbackUrl, events? }`. Pose l'en-tête
   * `Location` = URL absolue de désinscription (le trigger Logic Apps la stocke
   * depuis la réponse). Le `secret` HMAC est renvoyé **une seule fois**.
   */
  @Post()
  @HttpCode(201)
  @ApiOperation({
    summary: 'S’abonner aux nudges (agent)',
    description:
      'Enregistre l’URL de callback du provider (`@{listCallbackUrl()}`). Upsert : ' +
      'une souscription active par agent. Renvoie le secret HMAC une seule fois et ' +
      'un en-tête `Location` pour la désinscription.',
  })
  async subscribe(
    @CurrentUser() user: AuthUser,
    @Body() body: { callbackUrl: string; events?: string[] },
    @Res({ passthrough: true }) res: Response,
  ) {
    const sub = await this.nudge.subscribe(user.orgId, this.subjectFor(user), body);
    const location = `${this.tenantUrl.publicBaseUrl()}/api/v1/me/webhook-subscriptions/${sub.id}`;
    res.setHeader('Location', location);
    return { ...sub, unsubscribeUrl: location };
  }

  /**
   * Se désabonne **sans id** (désactive la souscription courante du porteur) —
   * URI d'unsubscribe STATIQUE pour le trigger HttpWebhook (Copilot exige une
   * URI d'unsubscribe fixe au design, l'id n'étant connu qu'après subscribe).
   * Idempotent.
   */
  @Delete()
  @HttpCode(200)
  unsubscribeCurrent(@CurrentUser() user: AuthUser) {
    return this.nudge.unsubscribeCurrent(user.orgId, this.subjectFor(user));
  }

  /** Se désabonne par id (désactive). Idempotent : 200 même si absent/déjà inactif. */
  @Delete(':id')
  @HttpCode(200)
  unsubscribe(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.nudge.unsubscribe(user.orgId, this.subjectFor(user), id);
  }

  /**
   * Alias de désinscription en POST — certains flux Logic Apps émettent un POST
   * (et non DELETE) sur l'URL d'unsubscribe. Même effet, idempotent.
   */
  @Post(':id/unsubscribe')
  @HttpCode(200)
  unsubscribePost(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.nudge.unsubscribe(user.orgId, this.subjectFor(user), id);
  }
}
