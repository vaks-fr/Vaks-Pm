import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../rbac/permissions.guard';
import { RequirePermissions } from '../../rbac/require-permissions.decorator';
import { SkipAudit } from '../../audit-logs/audited.decorator';
import { AuthUser, CurrentUser } from '../../auth/current-user.decorator';
import { AgentTrustIssuersService, type TrustIssuerInput } from './agent-trust-issuers.service';

/**
 * Émetteurs de confiance pour la fédération d'identité des agents.
 *
 * **App-privé, jamais `@PublicApi`** : déclarer qui peut attester d'un agent
 * revient à définir une racine de confiance. Un jeton d'API ne doit pas pouvoir
 * s'en approcher — sinon une clé compromise fabriquerait un émetteur, puis des
 * credentials, c'est-à-dire la chaîne d'escalade complète que `POST /agents`
 * interdit déjà. `@SkipAudit` partout : le service journalise lui-même en
 * CRITICAL avec le détail utile.
 */
@ApiTags('admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('admin/agent-trust-issuers')
export class AgentTrustIssuersController {
  constructor(private readonly issuers: AgentTrustIssuersService) {}

  @Get()
  @RequirePermissions('agent:manage')
  list(@CurrentUser() user: AuthUser) {
    return this.issuers.list(user.orgId);
  }

  /** Pré-remplissage depuis un connecteur d'annuaire (snapshot, pas héritage). */
  @Get('derive/:connectorId')
  @RequirePermissions('agent:manage')
  derive(@CurrentUser() user: AuthUser, @Param('connectorId') connectorId: string) {
    return this.issuers.deriveFromConnector(user.orgId, connectorId);
  }

  @Post()
  @RequirePermissions('agent:manage')
  @SkipAudit()
  create(@CurrentUser() user: AuthUser, @Body() dto: TrustIssuerInput) {
    return this.issuers.create(user.orgId, dto ?? {}, user.userId);
  }

  @Patch(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: TrustIssuerInput) {
    return this.issuers.update(user.orgId, id, dto ?? {}, user.userId);
  }

  @Post(':id/test')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  test(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.issuers.probe(user.orgId, id);
  }

  @Delete(':id')
  @RequirePermissions('agent:manage')
  @SkipAudit()
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.issuers.remove(user.orgId, id, user.userId);
  }
}
