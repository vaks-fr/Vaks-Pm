import { Body, Controller, Delete, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import type { LicenseHistoryRowDto, LicenseStatusDto, UploadLicenseDto } from '@vaks-pm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { LicenseAdminService } from './license-admin.service';
import { LicenseService } from './license.service';

class UploadLicenseBody implements UploadLicenseDto {
  @IsString()
  token!: string;
}

/**
 * Administration de la licence du tenant (`org:manage`). App-privé, sous
 * `/admin/` → hors doc OpenAPI publique et inaccessible aux jetons d'API.
 * L'upload vérifie la signature avant de remplacer la licence active.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/license')
export class AdminLicenseController {
  constructor(
    private readonly admin: LicenseAdminService,
    private readonly licenses: LicenseService,
  ) {}

  /** État courant (mêmes données que `GET /license`, côté admin). */
  @Get()
  @RequirePermissions('org:manage')
  status(): Promise<LicenseStatusDto> {
    return this.licenses.status();
  }

  @Get('history')
  @RequirePermissions('org:manage')
  history(): Promise<LicenseHistoryRowDto[]> {
    return this.admin.history();
  }

  @Post()
  @RequirePermissions('org:manage')
  upload(
    @CurrentUser() user: AuthUser,
    @Body() body: UploadLicenseBody,
  ): Promise<LicenseStatusDto> {
    return this.admin.upload(user.orgId, body.token, { id: user.userId, email: user.email });
  }

  /** Retire la licence active → retour au core gratuit. */
  @Delete()
  @RequirePermissions('org:manage')
  @HttpCode(200)
  clear(): Promise<LicenseStatusDto> {
    return this.admin.clearActive();
  }
}
