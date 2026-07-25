import { Body, Controller, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { ReportWidgetsService } from './report-widgets.service';
import { UpdateReportWidgetsDto } from './dto/report-widgets.dto';

/**
 * Préférence d'affichage des widgets du rapport projet, **par utilisateur**
 * (self-service, pas de `@PublicApi` — préférence UI pure, pas un besoin
 * d'automation). `userId` vient toujours de `CurrentUser()`, jamais du
 * chemin/body : aucun moyen de lire/écrire la config d'un autre utilisateur,
 * donc `report:view` + accès projet suffisent (même raisonnement que
 * `GET /timesheet` qui ignore tout `userId` passé en query).
 */
@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
@Controller('projects/:projectId/report-widgets')
export class ReportWidgetsController {
  constructor(private readonly svc: ReportWidgetsService) {}

  @Get()
  @RequirePermissions('report:view')
  get(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.getEffective(user.orgId, user.userId, projectId);
  }

  @Put()
  @RequirePermissions('report:view')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpdateReportWidgetsDto,
  ) {
    return this.svc.update(user.orgId, user.userId, projectId, dto);
  }
}
