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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { toCsv, sendCsv } from '../common/csv.util';
import { CurrentLang, reportT, statusLabel, type ReportLang } from '../common/i18n/report-i18n';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, TaskWritePolicy, fromProjectParam, fromTaskParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { Audited } from '../audit-logs/audited.decorator';
import { TasksService } from './tasks.service';
import { CreateTaskDto } from './dto/create-task.dto';
import { UpdateTaskDto } from './dto/update-task.dto';
import { MoveTaskDto } from './dto/move-task.dto';
import { ListTasksDto } from './dto/list-tasks.dto';

@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'), fromTaskParam('taskId'))
@PublicApi()
@Controller()
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  // Liste/création scoped au projet
  @Get('projects/:projectId/tasks')
  @RequirePermissions('task:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListTasksDto,
  ) {
    return this.tasks.list(user.orgId, projectId, query);
  }

  /** Export CSV des tâches du projet (téléchargeable + via API). */
  @Get('projects/:projectId/tasks.csv')
  @RequirePermissions('task:view')
  async listCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Query() query: ListTasksDto,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const tr = reportT(lang);
    const r = (await this.tasks.list(user.orgId, projectId, query)) as unknown;
    const arr = (Array.isArray(r) ? r : (r as { tasks?: unknown[] }).tasks ?? []) as Array<Record<string, any>>;
    const rows = arr.map((t) => [
      t.number,
      t.title,
      statusLabel(lang, t.status),
      t.priority,
      t.estimateHours,
      t.startDate ? String(t.startDate).slice(0, 10) : '',
      t.dueDate ? String(t.dueDate).slice(0, 10) : '',
      t.progressPct,
      (t.assignees ?? []).map((a: any) => a?.user?.name ?? a?.name ?? a?.userId).filter(Boolean).join(' / '),
    ]);
    sendCsv(
      res,
      `tasks-${projectId.slice(0, 8)}.csv`,
      toCsv([tr('number'), tr('title'), tr('status'), tr('priority'), tr('estimateH'), tr('start'), tr('dueDate'), tr('progressPct'), tr('assignees')], rows),
    );
  }

  @Post('projects/:projectId/tasks')
  @RequirePermissions('task:create')
  @TaskWritePolicy()
  @Audited('task.created', { resource: 'task' })
  create(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateTaskDto,
  ) {
    return this.tasks.create(user.orgId, projectId, user.userId, dto, {
      isAdmin: user.isAdmin,
    });
  }

  // Opérations sur une tâche par son ID (toutes confinées à l'org via service)
  @Get('tasks/:taskId')
  @RequirePermissions('task:view')
  findOne(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string) {
    return this.tasks.findOne(user.orgId, id);
  }

  /**
   * Contexte de travail agrégé d'une tâche (chantier 2c.2) : brief projet +
   * garde-fous + critères d'acceptation + journal vivant + commentaires récents.
   * Une seule lecture pour qu'un agent démarre avec tout.
   */
  @Get('tasks/:taskId/work-context')
  @RequirePermissions('task:view')
  workContext(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string) {
    return this.tasks.getWorkContext(user.orgId, id);
  }

  /**
   * Contenu texte d'un document « Contexte IA » du projet de la tâche. Lu PAR la
   * tâche (même périmètre d'accès que le work-context) → `@PublicApi('task:view')`
   * pour être atteignable par un PAT agent via `vaks_read` (MCP). Binaire → 415.
   */
  @Get('tasks/:taskId/context-documents/:docId')
  @RequirePermissions('task:view')
  @PublicApi('task:view')
  contextDocument(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('docId', ParseUUIDPipe) docId: string,
  ) {
    return this.tasks.getContextDocument(user.orgId, taskId, docId);
  }

  @Patch('tasks/:taskId')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  @Audited('task.updated', { resource: 'task', idParam: 'taskId' })
  update(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.tasks.update(user.orgId, id, dto, user.userId, {
      isAdmin: user.isAdmin,
      actorKind: user.actorKind ?? 'HUMAN',
    });
  }

  @Post('tasks/:taskId/move')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  @Audited('task.moved', { resource: 'task', idParam: 'taskId' })
  move(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) id: string,
    @Body() dto: MoveTaskDto,
  ) {
    return this.tasks.move(user.orgId, id, dto, {
      userId: user.userId,
      actorKind: user.actorKind ?? 'HUMAN',
    });
  }

  /** Revendication atomique d'une tâche (TODO→CLAIMED). Cycle de vie agents. */
  @Post('tasks/:taskId/claim')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  @Audited('task.claimed', { resource: 'task', idParam: 'taskId' })
  claim(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string) {
    return this.tasks.claim(user.orgId, id, {
      userId: user.userId,
      actorKind: user.actorKind ?? 'HUMAN',
    });
  }

  /** Soumission en revue (IN_PROGRESS→IN_REVIEW). Agent : ≥1 livrable PENDING requis. */
  @Post('tasks/:taskId/submit-review')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  @Audited('task.review_requested', { resource: 'task', idParam: 'taskId' })
  submitForReview(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string) {
    return this.tasks.submitForReview(user.orgId, id, {
      userId: user.userId,
      actorKind: user.actorKind ?? 'HUMAN',
    });
  }

  /** Libération d'une tâche revendiquée (CLAIMED→TODO) — release ou takeover. */
  @Post('tasks/:taskId/release')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  @Audited('task.released', { resource: 'task', idParam: 'taskId' })
  release(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string) {
    return this.tasks.release(user.orgId, id, {
      userId: user.userId,
      actorKind: user.actorKind ?? 'HUMAN',
    });
  }

  @Delete('tasks/:taskId')
  @RequirePermissions('task:delete')
  @TaskWritePolicy()
  @Audited('task.deleted', { resource: 'task', idParam: 'taskId' })
  remove(@CurrentUser() user: AuthUser, @Param('taskId', ParseUUIDPipe) id: string) {
    return this.tasks.remove(user.orgId, id);
  }
}
