import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { NotificationsService } from './notifications.service';
import { EmailTemplateKey } from './email-templates';

const VALID_TEMPLATES: EmailTemplateKey[] = ['assignment', 'mention', 'due', 'status', 'digest', 'skill_request', 'test'];

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/notifications')
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  /** Snapshot des settings (notifications + SMTP) pour l'UI admin. */
  @Get()
  @RequirePermissions('org:manage')
  get(@CurrentUser() user: AuthUser) {
    return this.svc.getOrgSettings(user.orgId);
  }

  /** Test SMTP : envoie un mail au destinataire fourni avec le template `test`. */
  @Post('test')
  @RequirePermissions('org:manage')
  test(
    @CurrentUser() user: AuthUser,
    @Body() body: { to?: string },
  ) {
    const to = (body?.to ?? user.email).trim();
    return this.svc.sendTest(user.orgId, to, user.email);
  }

  /** Rendu HTML d'un template avec le branding org (pour le bouton "Preview"). */
  @Get('preview/:template')
  @RequirePermissions('org:manage')
  preview(
    @CurrentUser() user: AuthUser,
    @Param('template') template: string,
    @Query('lang') lang?: string,
  ) {
    const key: EmailTemplateKey = VALID_TEMPLATES.includes(template as EmailTemplateKey)
      ? (template as EmailTemplateKey)
      : 'test';
    return this.svc.preview(user.orgId, key, lang);
  }

  /**
   * Journal des envois (debug) — fenêtre glissante de 30 jours, pagination
   * keyset : repasser `nextCursor` tel quel pour la page suivante (null = fin).
   */
  @Get('deliveries')
  @RequirePermissions('org:manage')
  list(
    @CurrentUser() user: AuthUser,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    const n = pageSize ? parseInt(pageSize, 10) : NaN;
    return this.svc.listDeliveries(user.orgId, {
      status,
      cursor,
      pageSize: Number.isFinite(n) ? n : undefined,
    });
  }
}
