import { Global, Module } from '@nestjs/common';
import { LicenseService } from './license.service';
import { SeatService } from './seat.service';
import { LicenseAdminService } from './license-admin.service';
import { LicenseRemoteService } from './license-remote.service';
import { LicenseFeatureGuard } from './license-feature.guard';
import { LicenseController } from './license.controller';
import { AdminLicenseController } from './admin-license.controller';

/**
 * Module de licence (open-core, SPEC §16). **Global** : `LicenseService` et
 * `LicenseFeatureGuard` sont injectés par les modules qui gatent une feature
 * premium (SSO, SCIM, audit/SIEM) sans réimport. PrismaService et TenantContext
 * proviennent de modules globaux.
 */
@Global()
@Module({
  controllers: [LicenseController, AdminLicenseController],
  providers: [LicenseService, SeatService, LicenseAdminService, LicenseRemoteService, LicenseFeatureGuard],
  exports: [LicenseService, SeatService, LicenseFeatureGuard],
})
export class LicensingModule {}
