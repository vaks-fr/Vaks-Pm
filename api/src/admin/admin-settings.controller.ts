import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AdminSettingsService } from './admin-settings.service';
import { SkipAudit } from '../audit-logs/audited.decorator';

@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/settings')
export class AdminSettingsController {
  constructor(private readonly svc: AdminSettingsService) {}

  /**
   * Sous-ensemble *public* des settings org : valeurs nécessaires côté UI
   * à tout utilisateur authentifié (locale, premier jour de la semaine,
   * heures par jour ouvré). Accessible sans permission `org:settings`.
   */
  @Get('public')
  async getPublic(@CurrentUser() user: AuthUser) {
    const [
      locale,
      defaultLanguage,
      enabledLanguages,
      weekStart,
      hoursPerDay,
      skillsMaxLevel,
      skillsSelfEditEnabled,
      skillsLevelScale,
      skillsLevelInputMode,
      fiscalYearStartMonth,
    ] = await Promise.all([
      this.svc.getDefaultLocale(user.orgId),
      this.svc.getDefaultLanguage(user.orgId),
      this.svc.getEnabledLanguages(user.orgId),
      this.svc.getWeekStart(user.orgId),
      this.svc.getHoursPerDay(user.orgId),
      this.svc.getSkillsMaxLevel(user.orgId),
      this.svc.getSkillsSelfEditEnabled(user.orgId),
      this.svc.getSkillsLevelScale(user.orgId),
      this.svc.getSkillsLevelInputMode(user.orgId),
      this.svc.getFiscalYearStartMonth(user.orgId),
    ]);
    return {
      locale,
      defaultLanguage,
      enabledLanguages,
      weekStart,
      hoursPerDay,
      skillsMaxLevel,
      skillsSelfEditEnabled,
      skillsLevelScale,
      skillsLevelInputMode,
      fiscalYearStartMonth,
    };
  }

  /**
   * Lit TOUS les settings de l'org (dont SMTP / notif / gouvernance webhooks).
   * Réservé aux admins (`org:manage`) : les membres utilisent `/public` pour le
   * sous-ensemble UI non sensible.
   */
  @Get()
  @RequirePermissions('org:manage')
  getAll(@CurrentUser() user: AuthUser) {
    // getAllForAdmin masque les secrets chiffrés (`…Enc` → booléen `…Set`).
    return this.svc.getAllForAdmin(user.orgId);
  }

  /** Upsert d'un lot de settings. Le body est un objet plat `{ key: value }`. */
  @Put()
  @RequirePermissions('org:manage')
  @SkipAudit() // hook explicite `settings.updated` (avec diff) dans le service
  putAll(@CurrentUser() user: AuthUser, @Body() body: Record<string, unknown>) {
    return this.svc.upsertMany(user.orgId, body || {}, {
      id: user.userId,
      email: user.email,
    });
  }
}
