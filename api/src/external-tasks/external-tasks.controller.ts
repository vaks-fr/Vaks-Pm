import { Body, Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { ExternalTasksService } from './external-tasks.service';
import { SearchExternalTasksDto, UpsertExternalTaskDto } from './dto/external-task.dto';

/**
 * Tickets d'outils de ticketing externes (timesheet only).
 *
 * Pas de `ProjectAccessGuard` : aucune route n'est paramétrée par projet, et
 * les conteneurs `kind=EXTERNAL` sont de toute façon en accès org-wide
 * (by-pass membership dans `ProjectAccessService`). Le scope `time:log`
 * (MEMBER-level) suffit : créer/chercher un ticket n'expose que des
 * références d'outil, pas de donnée projet.
 */
@ApiTags('external-tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller('external-tasks')
export class ExternalTasksController {
  constructor(private readonly svc: ExternalTasksService) {}

  /** Upsert idempotent d'un ticket (UI « logger sur un ticket » ou push
   *  Jira/ServiceNow via clé org + `assigneeEmail`). */
  @Post()
  @RequirePermissions('time:log')
  upsert(@CurrentUser() user: AuthUser, @Body() dto: UpsertExternalTaskDto) {
    return this.svc.upsert(user.orgId, { userId: user.userId }, dto);
  }

  /** Recherche de tickets existants (picker timesheet). */
  @Get()
  @RequirePermissions('time:log')
  search(@CurrentUser() user: AuthUser, @Query() query: SearchExternalTasksDto) {
    return this.svc.search(user.orgId, query);
  }
}
