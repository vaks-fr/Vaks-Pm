import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { TenantContext } from '../tenancy/tenant-context.service';
import { Audited } from '../audit-logs/audited.decorator';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { DiagnosticsService } from './diagnostics.service';

/**
 * Bundle de diagnostic in-app (Admin > Sécurité & Conformité > Support).
 * Réservé à l'admin org (`org:manage`), JWT uniquement — délibérément **hors**
 * `@PublicApi` (un jeton ne doit pas l'atteindre). Renvoie un snapshot JSON
 * redacté que le client peut télécharger et nous envoyer en cas d'incident.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/diagnostics')
export class DiagnosticsController {
  constructor(
    private readonly diagnostics: DiagnosticsService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Affichage in-app (chargé à l'ouverture de la page + bouton Refresh).
   * **Non audité** : une simple consultation ne doit pas générer une entrée
   * d'audit à chaque ouverture. L'export explicite l'est (route `/export`).
   */
  @Get()
  @RequirePermissions('org:manage')
  async view(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.build(user, req);
  }

  /**
   * Téléchargement explicite du bundle (bouton « Download »). **Audité**
   * (`admin.diagnostics.exported`) — c'est l'action qui sort les données de l'app.
   */
  @Get('export')
  @RequirePermissions('org:manage')
  @Audited(AUDIT_ACTIONS.ADMIN_DIAGNOSTICS_EXPORTED, {
    resource: 'organization',
    severity: 'WARNING',
  })
  async export(@CurrentUser() user: AuthUser, @Req() req: Request) {
    return this.build(user, req);
  }

  private build(user: AuthUser, req: Request) {
    return this.diagnostics.buildBundle({
      orgId: user.orgId,
      slug: this.tenant.currentSlug() ?? undefined,
      host: req.headers.host,
      requestedBy: { id: user.userId, email: user.email },
    });
  }
}
