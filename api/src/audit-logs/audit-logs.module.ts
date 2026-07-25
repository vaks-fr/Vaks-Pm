import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditLogService } from './audit-log.service';
import { AuditLogInterceptor } from './audit-log.interceptor';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsPublicController } from './audit-logs-public.controller';
import { AuditInternalController } from './audit-internal.controller';
import { AuditRetentionCronService } from './audit-retention-cron.service';
import { AuditAlertsService } from './audit-alerts.service';

/**
 * Journal d'audit (Phase 8). Global pour que les hooks de sécurité (auth,
 * api-tokens, users, admin…) injectent `AuditLogService` sans cycle d'import.
 * L'interceptor global assure la couverture générique des mutations HTTP.
 */
@Global()
@Module({
  providers: [
    AuditLogService,
    AuditRetentionCronService,
    AuditAlertsService,
    { provide: APP_INTERCEPTOR, useClass: AuditLogInterceptor },
  ],
  controllers: [AuditLogsController, AuditLogsPublicController, AuditInternalController],
  exports: [AuditLogService, AuditAlertsService],
})
export class AuditLogsModule {}
