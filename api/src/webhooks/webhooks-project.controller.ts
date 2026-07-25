import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import {
  CreateWebhookDto,
  KNOWN_EVENTS,
  UpdateWebhookDto,
  WebhookCaller,
  WebhooksService,
} from './webhooks.service';

/**
 * Webhooks en self-service au niveau **projet**. Un PROJECT_MANAGER (ou
 * PORTFOLIO_MANAGER / admin selon la policy org `webhooks.managePolicy`) branche
 * son projet à un canal externe (Teams, Slack…) sans passer par l'Org Admin.
 *
 * Toutes les routes sont scopées au projet : le périmètre des webhooks créés est
 * **forcé** à `PROJECT:<projectId>` côté service, et chaque écriture passe par
 * `assertCanManage`. `project:view` ouvre la porte (membre du projet) ; le
 * service restreint ensuite aux gestionnaires.
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@PublicApi()
@Controller('projects/:projectId/webhooks')
export class WebhooksProjectController {
  constructor(private readonly svc: WebhooksService) {}

  private caller(user: AuthUser): WebhookCaller {
    return { userId: user.userId, isAdmin: user.isAdmin };
  }

  @Get('events')
  @RequirePermissions('project:view')
  events() {
    return { events: KNOWN_EVENTS };
  }

  /** Indique à l'UI si l'utilisateur courant peut gérer les webhooks du projet. */
  @Get('can-manage')
  @RequirePermissions('project:view')
  async canManage(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    const canManage = await this.svc.canManage(user.orgId, this.caller(user), 'PROJECT', projectId);
    return { canManage };
  }

  @Get('deliveries')
  @RequirePermissions('project:view')
  deliveries(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query('limit') limit?: string,
  ) {
    const n = limit ? parseInt(limit, 10) : 100;
    return this.svc.deliveriesForProject(
      user.orgId,
      this.caller(user),
      projectId,
      Number.isFinite(n) ? n : 100,
    );
  }

  @Post('deliveries/:id/retry')
  @RequirePermissions('project:view')
  retry(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id') id: string,
  ) {
    return this.svc.retryForProject(user.orgId, this.caller(user), projectId, id);
  }

  @Get()
  @RequirePermissions('project:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.listForProject(user.orgId, this.caller(user), projectId);
  }

  @Post()
  @RequirePermissions('project:view')
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.svc.createForProject(user.orgId, this.caller(user), projectId, dto);
  }

  @Patch(':id')
  @RequirePermissions('project:view')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.svc.updateForProject(user.orgId, this.caller(user), projectId, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('project:view')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id') id: string,
  ) {
    return this.svc.removeForProject(user.orgId, this.caller(user), projectId, id);
  }

  @Post(':id/test')
  @RequirePermissions('project:view')
  test(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id') id: string,
  ) {
    return this.svc.testForProject(user.orgId, this.caller(user), projectId, id);
  }

  @Post(':id/rotate-secret')
  @RequirePermissions('project:view')
  rotate(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id') id: string,
  ) {
    return this.svc.rotateForProject(user.orgId, this.caller(user), projectId, id);
  }
}
