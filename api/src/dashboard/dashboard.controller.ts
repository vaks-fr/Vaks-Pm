import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { DashboardService } from './dashboard.service';

/**
 * Vue d'accueil personnelle (`GET /me/dashboard`). Strictement self-only : le
 * sujet est toujours `user.userId`, jamais un id passé en paramètre (même esprit
 * que `GET /me/tasks` / `GET /timesheet`). App-privé volontairement (pas
 * `@PublicApi`) : c'est un agrégat de confort UI, pas une surface d'intégration.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('me/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get()
  @RequirePermissions('task:view')
  get(@CurrentUser() user: AuthUser) {
    return this.dashboard.getDashboard(user.orgId, user.userId, !!user.isAdmin);
  }
}
