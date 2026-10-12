import { Controller, Get, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { PublicApi, RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { MetricsService } from './metrics.service';

/**
 * Export de métriques applicatives via l'**API publique** — scope
 * `monitoring:read`. Même patron que `audit:read` (`audit-logs-public.controller.ts`) :
 * pull org-scopé destiné à une **clé org** (`vaks_org_…`) collée dans un
 * scrape Prometheus. Un PAT utilisateur ne fonctionne que si le user
 * sous-jacent porte la permission (en pratique, les Org Admins).
 *
 * **Aucune métrique d'infra** (hostname, IP, nœud Swarm, état des services) —
 * uniquement des compteurs métier de l'organisation appelante, cf.
 * `MetricsService`. C'est la raison même du retrait du panneau Monitoring de
 * l'admin (mémoire `project_monitoring_admin_removed`) : ne pas régresser.
 *
 * Lecture SEULE, servie depuis un cache mémoire par-org (TTL ~20s) pour
 * absorber la cadence de scrape (15-30s typique) sans recompter à chaque appel.
 */
@ApiTags('monitoring')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi('monitoring:read')
@RequirePermissions('monitoring:read')
@SkipAudit()
@Controller('monitoring')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  @ApiOperation({
    summary: "Métriques applicatives de l'organisation (format Prometheus text exposition)",
    description:
      "Compteurs métier uniquement (sièges, projets, tâches par statut, livrables par statut " +
      'de revue, échecs de connexion récents, dernière sync SCIM) — jamais de topologie ' +
      "d'infrastructure. Cache mémoire ~20s par organisation.",
  })
  async metricsText(@CurrentUser() user: AuthUser, @Res() res: Response): Promise<void> {
    const body = await this.metrics.render(user.orgId);
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(body);
  }
}
