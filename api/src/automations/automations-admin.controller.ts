import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AutomationsCronService } from './automations-cron.service';

/**
 * Endpoints admin du moteur d'automatisations. Les settings `automations.*`
 * passent par le contrôleur générique `/admin/settings` (sections
 * déclaratives) — ici il n'y a que l'exécution forcée pour tester une config
 * sans attendre le `dailyHour`. App-privé (pas de @PublicApi).
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/automations')
export class AutomationsAdminController {
  constructor(private readonly cron: AutomationsCronService) {}

  /**
   * Exécute immédiatement les règles pour l'org de l'appelant (ignore les gates
   * de cadence ; kill switch et cooldowns restent respectés). Retourne les
   * compteurs — un 2ᵉ appel immédiat doit rendre sent=0 (cooldown).
   *
   * `?scope=daily` (défaut) | `hourly` | `weekly` (semaine ISO échue) | `all`.
   */
  @Post('tick')
  @RequirePermissions('org:manage')
  tick(@CurrentUser() user: AuthUser, @Query('scope') scope?: string) {
    const s =
      scope === 'weekly' || scope === 'hourly' || scope === 'all' ? scope : 'daily';
    return this.cron.runNowForOrg(user.orgId, s);
  }
}
