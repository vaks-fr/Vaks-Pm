import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { PendingReviewsService } from './pending-reviews.service';

/**
 * File des livrables en attente de revue, **au niveau org**.
 *
 * Controller séparé de `DeliverablesController` à dessein : ce dernier porte un
 * `@ProjectAccess(fromTaskParam('taskId'))` au niveau classe, qui n'a pas de
 * sens ici (route non project-scopée). Le scoping RBAC est fait *dans* le
 * service via `accessibleProjectScope` — jamais de listing org-global nu.
 */
@ApiTags('deliverables')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi('task:view')
@Controller('me/pending-reviews')
export class PendingReviewsController {
  constructor(private readonly pending: PendingReviewsService) {}

  @Get()
  @RequirePermissions('task:view')
  list(@CurrentUser() user: AuthUser, @Query('limit') limit?: string) {
    const parsed = Number.parseInt(limit ?? '', 10);
    return this.pending.list(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      { limit: Number.isFinite(parsed) ? parsed : undefined },
    );
  }
}
