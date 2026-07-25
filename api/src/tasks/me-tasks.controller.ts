import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { TasksService } from './tasks.service';

/**
 * Board inter-projet « Mes tâches » : agrège toutes les tâches assignées à
 * l'utilisateur courant à travers ses projets ACTIVE. Strictement self-only
 * (le sujet est toujours `user.userId`, jamais un id passé en paramètre — même
 * esprit que `GET /timesheet` / `GET /me/export`).
 *
 * `@PublicApi('task:view')` : ouvert aux jetons — un **agent** liste ainsi ses
 * propres tâches (revendiquées/assignées) via `vaks_list_my_tasks`, borné à son
 * périmètre. Reste self-only quel que soit le porteur.
 */
@ApiTags('me')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi('task:view')
@Controller('me/tasks')
export class MeTasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  @RequirePermissions('task:view')
  list(@CurrentUser() user: AuthUser) {
    return this.tasks.myTasks(user.orgId, user.userId);
  }
}
