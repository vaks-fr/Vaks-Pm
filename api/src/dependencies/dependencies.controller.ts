import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import {
  ProjectAccess,
  TaskWritePolicy,
  fromProjectParam,
  fromDependencyParam,
  fromTaskBody,
} from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { DependenciesService } from './dependencies.service';
import { CreateDependencyDto } from './dto/create-dependency.dto';
import { UpdateDependencyDto } from './dto/update-dependency.dto';

@ApiTags('dependencies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(
  fromProjectParam('projectId'),
  fromDependencyParam('id'),
  fromTaskBody('predecessorId'),
  fromTaskBody('successorId'),
)
@PublicApi()
@Controller()
export class DependenciesController {
  constructor(private readonly svc: DependenciesService) {}

  @Get('projects/:projectId/dependencies')
  @RequirePermissions('task:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.listForProject(user.orgId, projectId);
  }

  @Get('projects/:projectId/gantt')
  @RequirePermissions('task:view')
  gantt(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.gantt(user.orgId, projectId);
  }

  @Post('dependencies')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDependencyDto) {
    return this.svc.create(user.orgId, dto);
  }

  @Patch('dependencies/:id')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDependencyDto,
  ) {
    return this.svc.update(user.orgId, id, dto);
  }

  @Delete('dependencies/:id')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.remove(user.orgId, id);
  }
}
