import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { OAuthService } from './oauth.service';

/**
 * Gestion des **clients OAuth pré-enregistrés** (phase 11) — pour les
 * intégrations qui ne font pas de DCR et attendent un `client_id` + `client_secret`
 * statiques (typiquement **Microsoft Copilot Studio** / Power Platform).
 *
 * App-privé (PAS `@PublicApi`) : réservé aux admins (`org:manage`), JWT
 * uniquement — un jeton d'API ne peut pas créer d'autres clients. Le secret
 * n'est renvoyé qu'à la création (affiché une seule fois).
 */
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/oauth-clients')
export class OAuthAdminController {
  constructor(private readonly oauth: OAuthService) {}

  @Get()
  @RequirePermissions('org:manage')
  list() {
    return this.oauth.listPreregisteredClients();
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@Body() body: { name?: string; redirect_uris?: string[] }) {
    return this.oauth.createPreregisteredClient(body?.name ?? '', body?.redirect_uris ?? []);
  }

  @Patch(':clientId')
  @RequirePermissions('org:manage')
  update(@Param('clientId') clientId: string, @Body() body: { redirect_uris?: string[] }) {
    return this.oauth.updatePreregisteredClient(clientId, body?.redirect_uris ?? []);
  }

  @Delete(':clientId')
  @RequirePermissions('org:manage')
  revoke(@Param('clientId') clientId: string) {
    return this.oauth.revokePreregisteredClient(clientId);
  }
}

/**
 * Vue **admin org-wide** des connexions IA actives (phase 11) — toutes les
 * connexions des utilisateurs de l'org (qui, quel client, dernière utilisation),
 * avec révocation par l'admin (offboarding, réponse à incident). App-privé,
 * `org:manage`, JWT only.
 */
@ApiExcludeController()
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/ai-connections')
export class OAuthAdminConnectionsController {
  constructor(private readonly oauth: OAuthService) {}

  @Get()
  @RequirePermissions('org:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.oauth.listAllConnections(user.orgId);
  }

  @Delete(':connId')
  @RequirePermissions('org:manage')
  revoke(@CurrentUser() user: AuthUser, @Param('connId') connId: string) {
    return this.oauth.adminRevokeConnection(user.orgId, connId);
  }
}
