import { Global, Module } from '@nestjs/common';
import { TenancyService } from './tenancy.service';
import { TenantConnectionService } from './tenant-connection.service';
import { TenantContext } from './tenant-context.service';
import { TenantMiddleware } from './tenant.middleware';
import { TenantUrlService } from './tenant-url.service';

/** Résolution du tenant + contexte + connexion DB par tenant (multi-tenant).
 *  Global : `PrismaService` injecte `TenantContext`, le middleware est appliqué
 *  depuis AppModule, et tout le monde peut résoudre le tenant. */
@Global()
@Module({
  providers: [TenancyService, TenantConnectionService, TenantContext, TenantMiddleware, TenantUrlService],
  exports: [TenancyService, TenantConnectionService, TenantContext, TenantMiddleware, TenantUrlService],
})
export class TenancyModule {}
