import { Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { MetricsController } from './metrics.controller';

/**
 * Export de métriques Prometheus org-scopé (scope `monitoring:read`). Pas de
 * `@Global()` ni d'`exports` : `PrismaService`/`LicenseService` sont déjà
 * globaux (PrismaModule, LicensingModule), rien d'autre ne consomme
 * `MetricsService`.
 */
@Module({
  providers: [MetricsService],
  controllers: [MetricsController],
})
export class MetricsModule {}
