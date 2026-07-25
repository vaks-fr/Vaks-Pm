import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { TeamsProvisioningService } from './teams-provisioning.service';

/**
 * Provisioning Microsoft Teams au niveau **projet** (app-privé, pas `@PublicApi`).
 * Le bouton « Provisionner maintenant » de l'UI tape ici. Gated licence
 * (`teams-provisioning`) + accès projet (IDOR) + `project:update` (PM/lead/admin).
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard, LicenseFeatureGuard)
@ProjectAccess(fromProjectParam('projectId'))
@RequiresFeature('teams-provisioning')
@Controller('projects/:projectId/ms-team')
export class TeamsProvisioningController {
  constructor(private readonly svc: TeamsProvisioningService) {}

  /** Statut de l'équipe Teams + 10 derniers logs de provisioning. */
  @Get()
  @RequirePermissions('project:view')
  status(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.status(user.orgId, projectId);
  }

  /** Provisionne (ou re-synchronise avec `?force=1`) l'équipe maintenant. */
  @Post('provision')
  @RequirePermissions('project:update')
  provision(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('force') force?: string,
  ) {
    return this.svc.enqueue(user.orgId, projectId, 'provision', { force: force === '1' || force === 'true' });
  }

  /** Archive l'équipe (manuel). */
  @Post('archive')
  @RequirePermissions('project:update')
  archive(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.enqueue(user.orgId, projectId, 'archive');
  }
}
