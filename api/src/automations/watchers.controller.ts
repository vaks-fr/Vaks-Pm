import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromTaskParam, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { WatchersService } from './watchers.service';

/**
 * Abonnement passif (watchers) à une tâche ou un projet.
 *
 * `@ProjectAccess` est **obligatoire** sur ces routes project-scoped : sans lui
 * le guard est fail-open et n'importe quel membre de l'org pourrait suivre
 * (et donc lire les libellés) une tâche d'un projet auquel il n'a pas accès.
 *
 * On suit ce qu'on a le droit de voir (`task:view` / `project:view`) — aucun
 * droit d'écriture n'est requis : c'est un abonnement personnel.
 *
 * App-privé (pas de `@PublicApi`) : ce n'est pas une surface d'intégration.
 */
@ApiTags('watchers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromTaskParam('taskId'), fromProjectParam('projectId'))
@Controller()
export class WatchersController {
  constructor(private readonly svc: WatchersService) {}

  @Post('tasks/:taskId/watch')
  @RequirePermissions('task:view')
  watchTask(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.watchTask(user.orgId, user.userId, taskId);
  }

  @Delete('tasks/:taskId/watch')
  @RequirePermissions('task:view')
  unwatchTask(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.unwatchTask(user.orgId, user.userId, taskId);
  }

  @Get('tasks/:taskId/watchers')
  @RequirePermissions('task:view')
  listTaskWatchers(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.listTaskWatchers(user.orgId, taskId);
  }

  @Post('projects/:projectId/watch')
  @RequirePermissions('project:view')
  watchProject(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.watchProject(user.orgId, user.userId, projectId);
  }

  @Delete('projects/:projectId/watch')
  @RequirePermissions('project:view')
  unwatchProject(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.unwatchProject(user.orgId, user.userId, projectId);
  }

  @Get('projects/:projectId/watchers')
  @RequirePermissions('project:view')
  listProjectWatchers(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.listProjectWatchers(user.orgId, projectId);
  }
}

/**
 * Self-service : ce que l'appelant suit. Contrôleur séparé — pas de
 * `@ProjectAccess` ici (la route n'est pas project-scoped, elle est
 * self-scopée par `user.userId`).
 */
@ApiTags('watchers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('me')
export class MeWatchingController {
  constructor(private readonly svc: WatchersService) {}

  @Get('watching')
  listMine(@CurrentUser() user: AuthUser) {
    return this.svc.listMine(user.orgId, user.userId);
  }
}
