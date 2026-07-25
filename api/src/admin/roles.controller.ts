import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RolesService } from './roles.service';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/roles')
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** Liste tous les rôles disponibles dans l'organisation. */
  @Get()
  @RequirePermissions('member:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.roles.list(user.orgId);
  }
}
