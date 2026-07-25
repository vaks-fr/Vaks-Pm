import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { ConnectorsFileSourceAdminService, UpsertFileSourceDto } from './filesources-admin.service';
import { SharePointProvider } from './providers/sharepoint.provider';

/**
 * CRUD des connecteurs de sources de fichiers (google-drive, s3, webdav…) +
 * test SharePoint. App-privé (`org:manage`), sous `/admin/` → exclu de la doc
 * OpenAPI publique. Aucun secret n'est jamais renvoyé (chiffré at-rest).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/filesource-connectors')
export class FileSourcesAdminController {
  constructor(
    private readonly admin: ConnectorsFileSourceAdminService,
    private readonly sharepoint: SharePointProvider,
  ) {}

  /** Catalogue des types de sources disponibles (descripteurs de champs). */
  @Get('providers')
  @RequirePermissions('org:manage')
  providers() {
    return this.admin.listProviders();
  }

  @Get()
  @RequirePermissions('org:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.admin.list(user.orgId);
  }

  @Post()
  @RequirePermissions('org:manage')
  create(@CurrentUser() user: AuthUser, @Body() dto: UpsertFileSourceDto) {
    return this.admin.create(user.orgId, dto, { id: user.userId, email: user.email });
  }

  @Patch(':id')
  @RequirePermissions('org:manage')
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpsertFileSourceDto) {
    return this.admin.update(user.orgId, id, dto, { id: user.userId, email: user.email });
  }

  @Delete(':id')
  @RequirePermissions('org:manage')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.admin.remove(user.orgId, id, { id: user.userId, email: user.email });
  }

  /** Test d'un connecteur autonome (Google Drive, …) — org-level. */
  @Post(':id/test')
  @RequirePermissions('org:manage')
  @HttpCode(200)
  testConnector(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.testConnector(user.orgId, id);
  }

  /**
   * Génère la paire de clés RS256 du mode WIF d'un connecteur (Google Drive).
   * Renvoie le JWKS public + issuer à coller dans la config du pool WIF côté Google.
   */
  @Post(':id/wif-key')
  @RequirePermissions('org:manage')
  @HttpCode(200)
  generateWifKey(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.admin.generateWifKey(user.orgId, id, { id: user.userId, email: user.email });
  }

  /** Test bout-en-bout SharePoint pour un projet (résolution + grant + listing). */
  @Post('test-sharepoint')
  @RequirePermissions('org:manage')
  @HttpCode(200)
  testSharePoint(@CurrentUser() user: AuthUser, @Body() body: { projectId?: string }) {
    return this.sharepoint.testSharePoint(user.orgId, String(body?.projectId ?? ''));
  }
}
