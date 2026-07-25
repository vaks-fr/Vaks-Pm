import { Controller, Param, ParseUUIDPipe, Post, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SharePointProvider } from './providers/sharepoint.provider';
import { FileSourceExceptionFilter } from './file-source-exception.filter';

/**
 * Actions SharePoint au niveau **projet** (app-privé, pas `@PublicApi`). Le bouton
 * « Vérifier l'accès » de l'UI projet tape ici. Gated licence + accès projet +
 * `project:update` (PM/lead/admin).
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard, LicenseFeatureGuard)
@UseFilters(FileSourceExceptionFilter)
@ProjectAccess(fromProjectParam('projectId'))
@RequiresFeature('teams-provisioning')
@Controller('projects/:projectId/ms-team/sharepoint')
export class SharePointController {
  constructor(private readonly sharepoint: SharePointProvider) {}

  /** (Re)résout le site et pose le grant si nécessaire. Renvoie l'état obtenu. */
  @Post('verify')
  @RequirePermissions('project:update')
  verify(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.sharepoint.verify(user.orgId, projectId);
  }
}
