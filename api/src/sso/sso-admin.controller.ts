import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SsoAdminService, UpsertIdpDto } from './sso-admin.service';

/**
 * CRUD des fournisseurs d'identité (SSO). App-privé (pas `@PublicApi`),
 * `org:manage` requis. Sous `/admin/` → exclu de la doc OpenAPI publique.
 * Aucun secret n'est jamais accepté/renvoyé ici (le secret client vit en
 * Swarm secret, cf. SSO.md §5).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/identity-providers')
export class SsoAdminController {
  constructor(private readonly admin: SsoAdminService) {}

  @Get()
  @RequirePermissions('org:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.admin.list(user.orgId);
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: UpsertIdpDto) {
    return this.admin.create(user.orgId, dto, { id: user.userId, email: user.email });
  }

  @Patch(':id')
  @RequirePermissions('org:manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpsertIdpDto) {
    return this.admin.update(user.orgId, id, dto, { id: user.userId, email: user.email });
  }

  @Delete(':id')
  @RequirePermissions('org:manage')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.remove(user.orgId, id, { id: user.userId, email: user.email });
  }

  @Post(':id/test')
  @RequirePermissions('org:manage')
  @HttpCode(200)
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.testConnection(user.orgId, id);
  }
}
