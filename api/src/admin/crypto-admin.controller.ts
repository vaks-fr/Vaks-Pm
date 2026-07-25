import { Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { CryptoAdminService } from './crypto-admin.service';

/**
 * Rotation des clés de chiffrement (DORA). App-privé uniquement (pas @PublicApi).
 * Gardé par `crypto:manage` ; hooks d'audit explicites dans le service.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/crypto')
export class CryptoAdminController {
  constructor(private readonly svc: CryptoAdminService) {}

  /** État des clés : KEK active + distribution des DEK (lecture). */
  @Get('status')
  @RequirePermissions('crypto:manage')
  status(@CurrentUser() user: AuthUser) {
    return this.svc.status(user.orgId);
  }

  /** Rotation KEK : re-wrappe les DEK sous la KEK active (données intactes). */
  @Post('rewrap-keks')
  @HttpCode(200)
  @RequirePermissions('crypto:manage')
  @SkipAudit() // hook explicite CRYPTO_KEK_ROTATED dans le service
  rewrapKeks(@CurrentUser() user: AuthUser) {
    return this.svc.rewrapKeks(user.orgId, { id: user.userId, email: user.email });
  }

  /** Rotation DEK : nouvelle DEK + re-chiffrement des secrets (compromission). */
  @Post('rotate-dek')
  @HttpCode(200)
  @RequirePermissions('crypto:manage')
  @SkipAudit() // hook explicite CRYPTO_DEK_ROTATED dans le service
  rotateDek(@CurrentUser() user: AuthUser) {
    return this.svc.rotateDek(user.orgId, { id: user.userId, email: user.email });
  }
}
