import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { RequiresFeature } from '../licensing/requires-feature.decorator';
import { LicenseFeatureGuard } from '../licensing/license-feature.guard';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { CiConnectorsService } from './ci-connectors.service';
import { UpsertCiConnectorDto } from './dto/upsert-ci-connector.dto';

/**
 * Administration des connecteurs CI signataires (phase C). **App-privé**, scope
 * `agent:manage` (aligné sur les connecteurs d'annuaire d'agents — la
 * vérification des livrables est une préoccupation de gouvernance agents, donc
 * accessible aussi à l'« AI administrator »). Mutations auditées par hooks
 * `logCritical` → `@SkipAudit`.
 *
 * **Feature de licence `ci-verification`** (brique entreprise, comme SSO/SCIM/SIEM) :
 * `@RequiresFeature` au niveau classe → les 5 routes renvoient `403
 * LICENSE_FEATURE_DISABLED` sans licence. Sans connecteur configuré, le webhook
 * entrant `/webhooks/ci/*` n'a rien à corroborer → le gating de la CRUD suffit.
 */
@ApiTags('admin')
@ApiBearerAuth()
@RequiresFeature('ci-verification')
@UseGuards(JwtAuthGuard, PermissionsGuard, LicenseFeatureGuard)
@Controller('admin/ci-connectors')
export class CiConnectorsAdminController {
  constructor(private readonly connectors: CiConnectorsService) {}

  @Get('providers')
  @RequirePermissions('agent:manage')
  providers() {
    return this.connectors.listProviders();
  }

  @Get()
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.connectors.list(user.orgId);
  }

  @Post()
  @RequirePermissions('agent:manage')
  @SkipAudit()
  create(@CurrentUser() user: AuthUser, @Body() dto: UpsertCiConnectorDto) {
    return this.connectors.create(user.orgId, dto, { id: user.userId, email: user.email });
  }

  @Patch(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: UpsertCiConnectorDto) {
    return this.connectors.update(user.orgId, id, dto, { id: user.userId, email: user.email });
  }

  @Delete(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.connectors.remove(user.orgId, id, { id: user.userId, email: user.email });
  }
}
