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
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { LabelsService } from './labels.service';
import { CreateLabelDto, UpdateLabelDto } from './dto/label.dto';

@ApiTags('labels')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
@PublicApi()
@Controller('projects/:projectId/labels')
export class LabelsController {
  constructor(private readonly labels: LabelsService) {}

  @Get()
  @RequirePermissions('project:view')
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.labels.list(user.orgId, projectId);
  }

  @Post()
  @RequirePermissions('project:update')
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateLabelDto,
  ) {
    return this.labels.create(user.orgId, projectId, dto);
  }

  @Patch(':labelId')
  @RequirePermissions('project:update')
  update(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
    @Body() dto: UpdateLabelDto,
  ) {
    return this.labels.update(user.orgId, projectId, labelId, dto);
  }

  @Delete(':labelId')
  @RequirePermissions('project:update')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('labelId', ParseUUIDPipe) labelId: string,
  ) {
    return this.labels.remove(user.orgId, projectId, labelId);
  }
}
