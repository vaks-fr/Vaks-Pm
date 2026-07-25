import { Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { BillingExportSchedulerService } from './billing-export-scheduler.service';
import { AuditLogService } from '../audit-logs/audit-log.service';

@Controller('admin/billing-export')
@UseGuards(JwtAuthGuard, PermissionsGuard)
@RequirePermissions('org:manage')
export class BillingExportAdminController {
  constructor(
    private readonly scheduler: BillingExportSchedulerService,
    private readonly audit: AuditLogService,
  ) {}

  /** Déclenche immédiatement l'export facturation planifié (même logique que le cron). */
  @Post('send-now')
  async sendNow(@CurrentUser() user: AuthUser): Promise<{ sent: number; skipped: boolean }> {
    const result = await this.scheduler.sendNow(user.orgId);
    this.audit.log({
      action: 'billing_export.sent_now',
      actorId: user.userId,
      organizationId: user.orgId,
      severity: 'INFO',
      outcome: 'SUCCESS',
      detail: result,
    });
    return result;
  }
}
