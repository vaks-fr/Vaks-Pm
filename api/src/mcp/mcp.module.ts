import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AdminModule } from '../admin/admin.module';
import { CommonModule } from '../common/common.module';
import { AuditLogsModule } from '../audit-logs/audit-logs.module';
import { McpToolUsageService } from './mcp-tool-usage.service';
import { McpToolQuotaInterceptor } from './mcp-tool-quota.interceptor';
import { McpConfirmStore } from './mcp-confirm.store';
import { McpConfirmInterceptor } from './mcp-confirm.interceptor';
import { McpAdminController } from './mcp-admin.controller';

/**
 * Gouvernance du connecteur MCP côté API : comptage et quotas par tool.
 *
 * L'intercepteur est enregistré en `APP_INTERCEPTOR` (donc global) et non en
 * `APP_GUARD` : un guard global tourne AVANT les guards de contrôleur, or
 * `JwtAuthGuard` est posé par contrôleur — `req.user` n'existerait pas encore.
 * Voir le docstring de `McpToolQuotaInterceptor`.
 */
@Module({
  imports: [AdminModule, CommonModule, AuditLogsModule],
  controllers: [McpAdminController],
  providers: [
    McpToolUsageService,
    McpConfirmStore,
    { provide: APP_INTERCEPTOR, useClass: McpToolQuotaInterceptor },
    { provide: APP_INTERCEPTOR, useClass: McpConfirmInterceptor },
  ],
  exports: [McpToolUsageService],
})
export class McpModule {}
