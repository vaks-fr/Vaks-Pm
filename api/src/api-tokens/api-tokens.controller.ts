import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { ApiTokensService } from './api-tokens.service';
import { CreateApiTokenDto } from './dto/create-api-token.dto';

/**
 * Jetons API personnels (PAT) de l'utilisateur courant. App-privé : se gère
 * uniquement en **session** (JWT) — un jeton API ne peut pas créer de jetons
 * (pas de `@PublicApi`). Pas de permission requise : chacun gère LES SIENS.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('me/api-tokens')
export class MyApiTokensController {
  constructor(private readonly svc: ApiTokensService) {}

  @Get('scopes')
  scopes() {
    // Un PAT restreint dans la limite des droits du porteur → on propose tout.
    return { scopes: this.svc.listScopeCatalog() };
  }

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.svc.listForUser(user.orgId, user.userId);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiTokenDto) {
    return this.svc.create(user.orgId, 'USER', {
      userId: user.userId,
      createdById: user.userId,
      dto,
    });
  }

  @Delete(':id')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.revoke(user.orgId, id, { type: 'USER', requireUserId: user.userId });
  }
}

/**
 * Clés API au niveau **organisation** (identité service, lecture seule en v1).
 * Réservé aux admins (`org:manage`). App-privé.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/api-tokens')
export class OrgApiTokensController {
  constructor(private readonly svc: ApiTokensService) {}

  @Get('scopes')
  @RequirePermissions('org:manage')
  scopes() {
    return { scopes: this.svc.listOrgScopeCatalog() };
  }

  @Get()
  @RequirePermissions('org:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.svc.listOrg(user.orgId);
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateApiTokenDto) {
    return this.svc.create(user.orgId, 'ORG', { createdById: user.userId, dto });
  }

  @Delete(':id')
  @RequirePermissions('org:manage')
  revoke(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.svc.revoke(user.orgId, id, { type: 'ORG', actorId: user.userId });
  }
}
