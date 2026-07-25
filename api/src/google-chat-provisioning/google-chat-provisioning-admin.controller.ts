import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { GoogleChatProvisioningService } from './google-chat-provisioning.service';

/**
 * Endpoint admin du provisioning Google Chat (bouton « Tester » de la carte).
 * App-privé, `org:manage`, gated sur la même licence que « Collaboration
 * spaces » (`teams-provisioning` — flag ombrelle de section). Ne renvoie
 * jamais la clé privée du compte de service.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, LicenseFeatureGuard)
@RequiresFeature('teams-provisioning')
@Controller('admin/google-chat-provisioning')
export class GoogleChatProvisioningAdminController {
  constructor(private readonly svc: GoogleChatProvisioningService) {}

  @Post('test')
  @RequirePermissions('org:manage')
  @SkipAudit()
  test(@CurrentUser() user: AuthUser) {
    return this.svc.testConnection(user.orgId);
  }

  /**
   * Génère (ou régénère) la paire de clés du mode Workload Identity Federation.
   * Renvoie le JWKS public + issuer à coller dans la config du provider WIF côté
   * Google. La clé privée reste chiffrée en base, jamais renvoyée. Audité via
   * `settings.updated` (upsertMany), donc pas de `@SkipAudit` ici.
   */
  @Post('wif-key')
  @RequirePermissions('org:manage')
  @SkipAudit()
  generateWifKey(@CurrentUser() user: AuthUser) {
    return this.svc.generateWifKey(user.orgId, { id: user.userId, email: user.email });
  }
}
