import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RisksService } from './risks.service';
import { CreateRiskDto, UpdateRiskDto } from './dto/risk.dto';

/**
 * Registre de risques projet. App-privé (pas de `@PublicApi`) : feature d'UI,
 * pas une surface d'intégration en v1. Lecture = `project:view` (même
 * périmètre que le reste du projet) ; écriture = `risk:manage` (scope dédié,
 * cf. packages/shared — accordé aux rôles managers, jamais aux agents).
 */
@ApiTags('risks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
@Controller('projects/:projectId/risks')
export class RisksController {
  constructor(private readonly svc: RisksService) {}

  @Get()
  @RequirePermissions('project:view')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.list(user.orgId, projectId);
  }

  @Post()
  @RequirePermissions('risk:manage')
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateRiskDto,
  ) {
    return this.svc.create(user.orgId, projectId, dto);
  }

  @Patch(':riskId')
  @RequirePermissions('risk:manage')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
    @Body() dto: UpdateRiskDto,
  ) {
    return this.svc.update(user.orgId, projectId, riskId, dto);
  }

  @Post(':riskId/resolve')
  @RequirePermissions('risk:manage')
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
  ) {
    return this.svc.resolve(user.orgId, projectId, riskId);
  }

  @Delete(':riskId')
  @RequirePermissions('risk:manage')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('riskId', ParseUUIDPipe) riskId: string,
  ) {
    await this.svc.remove(user.orgId, projectId, riskId);
    return { removed: true };
  }
}
