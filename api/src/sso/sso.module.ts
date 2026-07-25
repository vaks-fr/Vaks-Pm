import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { LoginEnabledGuard } from '../auth/guards/login-enabled.guard';
import { SsoController } from './sso.controller';
import { SsoAdminController } from './sso-admin.controller';
import { SsoService } from './sso.service';
import { SsoAdminService } from './sso-admin.service';
import { OidcClientService } from './oidc-client.service';
import { SamlClientService } from './saml-client.service';
import { SsoStateService } from './sso-state.service';
import { SsoProvisioningService } from './sso-provisioning.service';

/**
 * Module SSO / identité d'entreprise (phase 10). Lot 1 : login OIDC (Entra) +
 * provisioning JIT + account linking + mapping de rôles + admin CRUD.
 *
 * Dépendances globales (Prisma, Rbac, Admin/Roles, AuditLogs, Tenancy) sont
 * `@Global`, donc seul AuthModule (non-global, fournit AuthService) est importé.
 * LoginEnabledGuard est re-fourni localement (il ne dépend que de ConfigService).
 */
@Module({
  imports: [AuthModule],
  providers: [
    SsoService,
    SsoAdminService,
    OidcClientService,
    SamlClientService,
    SsoStateService,
    SsoProvisioningService,
    LoginEnabledGuard,
  ],
  controllers: [SsoController, SsoAdminController],
})
export class SsoModule {}
