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
import { ProjectAccess, fromTaskParam, fromCommentParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { CommentsService } from './comments.service';
import { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto';

@ApiTags('comments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromTaskParam('taskId'), fromCommentParam('id'))
@PublicApi()
@Controller()
export class CommentsController {
  constructor(private readonly svc: CommentsService) {}

  @Get('tasks/:taskId/comments')
  @RequirePermissions('task:view')
  list(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) taskId: string) {
    return this.svc.list(user.orgId, taskId);
  }

  @Post('tasks/:taskId/comments')
  @RequirePermissions('comment:create')
  create(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() dto: CreateCommentDto,
  ) {
    return this.svc.create(user.orgId, user.userId, taskId, dto);
  }

  // PATCH/DELETE sous `comment:create` (pas de `comment:update`/`delete` au
  // vocabulaire — en ajouter imposerait une migration des rôles par tenant) :
  // le service garantit l'owner-only via `assertOwned` (auteur ou admin).
  @Patch('comments/:id')
  @RequirePermissions('comment:create')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCommentDto,
  ) {
    return this.svc.update(user.orgId, user.userId, user.isAdmin, id, dto);
  }

  @Delete('comments/:id')
  @RequirePermissions('comment:create')
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.remove(user.orgId, user.userId, user.isAdmin, id);
  }
}
