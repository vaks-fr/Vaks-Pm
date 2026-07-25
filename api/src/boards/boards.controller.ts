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
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { BoardsService } from './boards.service';
import { CreateColumnDto } from './dto/create-column.dto';
import { UpdateColumnDto } from './dto/update-column.dto';
import { ReorderColumnsDto } from './dto/reorder-columns.dto';

@ApiTags('boards')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
// App-privé : le board = les colonnes Kanban = les statuts de tâche (fixes).
// Pas une surface d'intégration → réservé à l'UI (hors API publique / PAT).
@Controller()
export class BoardsController {
  constructor(private readonly boards: BoardsService) {}

  @Get('projects/:projectId/board')
  @RequirePermissions('project:view')
  getBoard(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.boards.getProjectBoard(user.orgId, projectId);
  }

  @Post('projects/:projectId/board/columns')
  @RequirePermissions('project:update')
  createColumn(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateColumnDto,
  ) {
    return this.boards.createColumn(user.orgId, projectId, dto);
  }

  @Patch('projects/:projectId/board/columns/:columnId')
  @RequirePermissions('project:update')
  updateColumn(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('columnId', ParseUUIDPipe) columnId: string,
    @Body() dto: UpdateColumnDto,
  ) {
    return this.boards.updateColumn(user.orgId, projectId, columnId, dto);
  }

  @Delete('projects/:projectId/board/columns/:columnId')
  @RequirePermissions('project:update')
  deleteColumn(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('columnId', ParseUUIDPipe) columnId: string,
  ) {
    return this.boards.deleteColumn(user.orgId, projectId, columnId);
  }

  @Post('projects/:projectId/board/columns/reorder')
  @RequirePermissions('project:update')
  reorder(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: ReorderColumnsDto,
  ) {
    return this.boards.reorderColumns(user.orgId, projectId, dto);
  }
}
