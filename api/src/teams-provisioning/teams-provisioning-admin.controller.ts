import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { TeamsProvisioningService } from './teams-provisioning.service';

/**
 * Endpoint admin du provisioning Teams (bouton « Tester la connexion Graph »).
 * App-privé, `org:manage`, gated licence. Ne renvoie jamais le client secret.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, LicenseFeatureGuard)
@RequiresFeature('teams-provisioning')
@Controller('admin/teams-provisioning')
export class TeamsProvisioningAdminController {
  constructor(private readonly svc: TeamsProvisioningService) {}

  @Post('test')
  @RequirePermissions('org:manage')
  @SkipAudit()
  test(@CurrentUser() user: AuthUser) {
    return this.svc.testConnection(user.orgId);
  }
}
