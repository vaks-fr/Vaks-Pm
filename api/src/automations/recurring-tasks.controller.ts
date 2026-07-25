import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromTaskParam, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { RecurringTasksService, UpsertRecurrenceDto } from './recurring-tasks.service';

/**
 * Récurrence d'une tâche. `@ProjectAccess` obligatoire (route project-scoped).
 * Écriture réservée à `task:update` : poser une récurrence revient à créer des
 * tâches, ce n'est pas une préférence personnelle comme le suivi.
 *
 * App-privé (pas de `@PublicApi`).
 */
@ApiTags('automations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromTaskParam('taskId'), fromProjectParam('projectId'))
@Controller()
export class RecurringTasksController {
  constructor(private readonly svc: RecurringTasksService) {}

  @Get('tasks/:taskId/recurrence')
  @RequirePermissions('task:view')
  get(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.getForTask(user.orgId, taskId);
  }

  @Put('tasks/:taskId/recurrence')
  @RequirePermissions('task:update')
  upsert(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: UpsertRecurrenceDto,
  ) {
    return this.svc.upsert(user.orgId, taskId, user.userId, dto);
  }

  @Delete('tasks/:taskId/recurrence')
  @RequirePermissions('task:update')
  remove(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.remove(user.orgId, taskId);
  }

  @Get('projects/:projectId/recurring-tasks')
  @RequirePermissions('task:view')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.listForProject(user.orgId, projectId);
  }
}
