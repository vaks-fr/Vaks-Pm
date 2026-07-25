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
import { ConnectorsAdminService, UpsertConnectorDto } from './connectors-admin.service';

/**
 * CRUD des connecteurs externes de ticketing (ServiceNow, …). App-privé (pas
 * `@PublicApi`), `org:manage` requis. Sous `/admin/` → exclu de la doc OpenAPI
 * publique. Aucun secret n'est jamais renvoyé (chiffré at-rest).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/ticketing-connectors')
export class ConnectorsAdminController {
  constructor(private readonly admin: ConnectorsAdminService) {}

  /** Catalogue des types de fournisseurs disponibles (descripteurs de champs). */
  @Get('providers')
  @RequirePermissions('org:manage')
  providers() {
    return this.admin.listProviders();
  }

  @Get()
  @RequirePermissions('org:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.admin.list(user.orgId);
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: UpsertConnectorDto) {
    return this.admin.create(user.orgId, dto, { id: user.userId, email: user.email });
  }

  @Patch(':id')
  @RequirePermissions('org:manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpsertConnectorDto) {
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
