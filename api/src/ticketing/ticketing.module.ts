import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ConnectorsAdminController } from './connectors-admin.controller';
import { ConnectorsAdminService } from './connectors-admin.service';
import { TicketProviderRegistry } from './ticket-provider.registry';
import { ServiceNowProvider } from './providers/servicenow.provider';
import { TicketingSearchService } from './ticketing-search.service';
import { TicketingSearchController } from './ticketing-search.controller';

/**
 * Module connecteurs externes de ticketing (provider-agnostic).
 * Incrément 1 : admin CRUD + registry + provider ServiceNow.
 * Incrément 2 : recherche live + picker timesheet (GET /ticketing/sources|search).
 *
 * Prisma / Crypto / AuditLogs sont `@Global` → seul AuthModule est importé.
 */
@Module({
  imports: [AuthModule],
  providers: [ConnectorsAdminService, TicketProviderRegistry, ServiceNowProvider, TicketingSearchService],
  controllers: [ConnectorsAdminController, TicketingSearchController],
  exports: [ConnectorsAdminService, TicketProviderRegistry],
})
export class TicketingModule {}
