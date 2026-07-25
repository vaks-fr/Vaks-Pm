import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { GoogleDriveProvisioningService } from './google-drive-provisioning.service';

/**
 * Endpoints admin du provisioning Google Drive (boutons « Tester » et
 * « Générer la clé WIF » de la carte). App-privé, `org:manage`, gated sur la
 * même licence que « Collaboration spaces ». Ne renvoie jamais la clé privée.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, LicenseFeatureGuard)
@RequiresFeature('teams-provisioning')
@Controller('admin/google-drive-provisioning')
export class GoogleDriveProvisioningAdminController {
  constructor(private readonly svc: GoogleDriveProvisioningService) {}

  @Post('test')
  @RequirePermissions('org:manage')
  @SkipAudit()
  test(@CurrentUser() user: AuthUser) {
    return this.svc.testConnection(user.orgId);
  }

  /**
   * Génère (ou régénère) la paire de clés du mode Workload Identity Federation.
   * Renvoie le JWKS public + issuer à coller côté Google ; la clé privée reste
   * chiffrée en base. Audité via `settings.updated` (upsertMany).
   */
  @Post('wif-key')
  @RequirePermissions('org:manage')
  @SkipAudit()
  generateWifKey(@CurrentUser() user: AuthUser) {
    return this.svc.generateWifKey(user.orgId, { id: user.userId, email: user.email });
  }
}
