import { Controller, Get, Post, Header, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { DataManagementService } from './data-management.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS, severityForAction } from '../audit-logs/audit-actions';
import { SkipAudit } from '../audit-logs/audited.decorator';

/**
 * **Admin > Data Management.** Purge du soft-delete + export org (portabilité).
 * Réservé `org:manage`, app-privé (jamais `@PublicApi` : opérations destructives
 * / dump complet). Audit CRITICAL sur la purge (irréversible), WARNING sur
 * l'export org.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/data')
export class DataManagementController {
  constructor(
    private readonly svc: DataManagementService,
    private readonly audit: AuditLogService,
  ) {}

  /** Aperçu : combien d'enregistrements soft-deleted seraient purgés « now ». */
  @Get('purge-preview')
  @RequirePermissions('org:manage')
  purgePreview(@CurrentUser() user: AuthUser) {
    return this.svc.purgeStats(user.orgId);
  }

  /** Purge immédiate de TOUT le soft-delete (bouton « Purge now »). */
  @Post('purge')
  @RequirePermissions('org:manage')
  @SkipAudit() // hook explicite `data.purged` ci-dessous (évite le doublon interceptor)
  async purgeNow(@CurrentUser() user: AuthUser) {
    const res = await this.svc.purge(user.orgId);
    void this.audit.logCritical({
      organizationId: user.orgId,
      action: AUDIT_ACTIONS.DATA_PURGED,
      actorId: user.userId,
      actorLabel: user.email,
      resourceType: 'organization',
      resourceId: user.orgId,
      detail: { trigger: 'manual', total: res.total, byType: res.byType },
    });
    return res;
  }

  /** Export machine-lisible de toute l'org (JSON, secrets exclus). */
  @Get('export')
  @RequirePermissions('org:manage')
  @Header('Content-Type', 'application/json; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="org-export.json"')
  async exportOrg(@CurrentUser() user: AuthUser) {
    const data = await this.svc.exportOrg(user.orgId);
    void this.audit.log({
      organizationId: user.orgId,
      action: AUDIT_ACTIONS.ORG_DATA_EXPORTED,
      severity: severityForAction(AUDIT_ACTIONS.ORG_DATA_EXPORTED),
      actorId: user.userId,
      actorLabel: user.email,
      resourceType: 'organization',
      resourceId: user.orgId,
      detail: { counts: data.counts },
    });
    return data;
  }
}
