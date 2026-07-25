import { Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { SlackProvisioningService } from './slack-provisioning.service';

/**
 * Endpoint admin du provisioning Slack (bouton « Tester » de la carte).
 * App-privé, `org:manage`, gated sur la même licence que « Collaboration
 * spaces » (`teams-provisioning` — un flag ombrelle pour toute la section,
 * pas un flag par fournisseur). Ne renvoie jamais le bot token.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, LicenseFeatureGuard)
@RequiresFeature('teams-provisioning')
@Controller('admin/slack-provisioning')
export class SlackProvisioningAdminController {
  constructor(private readonly svc: SlackProvisioningService) {}

  @Post('test')
  @RequirePermissions('org:manage')
  @SkipAudit()
  test(@CurrentUser() user: AuthUser) {
    return this.svc.testConnection(user.orgId);
  }

  /**
   * Provisionne le canal Slack d'un projet **maintenant**, sans passer par une
   * transition de statut. Indispensable pour un projet DÉJÀ actif : le hook
   * automatique ne se déclenche qu'à l'entrée en ACTIVE, et refaire un
   * aller-retour de statut aurait des effets de bord (provisioning Teams,
   * notifications sponsors, webhooks). Idempotent côté service.
   */
  @Post('provision/:projectId')
  @RequirePermissions('org:manage')
  @SkipAudit()
  provision(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.provisionForProject(user.orgId, projectId);
  }
}
