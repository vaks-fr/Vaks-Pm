import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, TaskWritePolicy, fromProjectParam, fromTaskParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { CustomFieldsService } from './custom-fields.service';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  UpsertCustomFieldValuesDto,
} from './dto/custom-field.dto';

/**
 * Champs personnalisés. App-privé (pas de `@PublicApi`) : feature d'UI, pas
 * une surface d'intégration en v1.
 *
 * `@ProjectAccess` scope UNIQUEMENT les routes portant `:taskId`/`:projectId`
 * (les valeurs) ; le catalogue org-global (`/custom-fields`) n'a aucune de ces
 * sources → non filtré par le guard (write-gating dans le service).
 */
@ApiTags('custom-fields')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'), fromTaskParam('taskId'))
@Controller()
export class CustomFieldsController {
  constructor(private readonly svc: CustomFieldsService) {}

  // -------- Catalogue org (définitions) --------
  @Get('custom-fields')
  @RequirePermissions('project:view')
  list(@CurrentUser() user: AuthUser, @Query('entityType') entityType?: string) {
    return this.svc.list(user.orgId, entityType);
  }

  @Get('custom-fields/capabilities')
  @RequirePermissions('project:view')
  async capabilities(@CurrentUser() user: AuthUser) {
    const canWrite = await this.svc.canWrite(user.orgId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
    return { canWrite };
  }

  @Post('custom-fields')
  @RequirePermissions('project:view')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomFieldDto) {
    return this.svc.create(user.orgId, dto, { userId: user.userId, isAdmin: user.isAdmin });
  }

  @Patch('custom-fields/:fieldId')
  @RequirePermissions('project:view')
  update(
    @CurrentUser() user: AuthUser,
    @Param('fieldId', ParseUUIDPipe) fieldId: string,
    @Body() dto: UpdateCustomFieldDto,
  ) {
    return this.svc.update(user.orgId, fieldId, dto, { userId: user.userId, isAdmin: user.isAdmin });
  }

  @Delete('custom-fields/:fieldId')
  @RequirePermissions('project:view')
  remove(@CurrentUser() user: AuthUser, @Param('fieldId', ParseUUIDPipe) fieldId: string) {
    return this.svc.remove(user.orgId, fieldId, { userId: user.userId, isAdmin: user.isAdmin });
  }

  // -------- Valeurs par tâche --------
  @Get('tasks/:taskId/custom-fields')
  @RequirePermissions('task:view')
  getTaskValues(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.getTaskValues(user.orgId, taskId);
  }

  @Put('tasks/:taskId/custom-fields')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  setTaskValues(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: UpsertCustomFieldValuesDto,
  ) {
    return this.svc.setTaskValues(user.orgId, taskId, dto);
  }

  // -------- Valeurs par projet --------
  @Get('projects/:projectId/custom-fields')
  @RequirePermissions('project:view')
  getProjectValues(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.getProjectValues(user.orgId, projectId);
  }

  @Put('projects/:projectId/custom-fields')
  @RequirePermissions('project:update')
  setProjectValues(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: UpsertCustomFieldValuesDto,
  ) {
    return this.svc.setProjectValues(user.orgId, projectId, dto);
  }
}
