import { Controller, Get, Param, ParseUUIDPipe, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromTaskParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { Audited } from '../audit-logs/audited.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { FileSourcesService } from './filesources.service';
import { FileSourceExceptionFilter } from './file-source-exception.filter';

/**
 * Lecture, par les agents IA, des documents d'une source externe (SharePoint…)
 * rattachée au projet d'une tâche. Même périmètre d'accès que le work-context :
 * `@PublicApi('task:view')` pour être atteignable par un PAT agent (MCP), ET
 * appartenance au projet de la tâche exigée (`ProjectAccessGuard`) — sans quoi
 * tout membre de l'org / tout PAT `task:view` lisait les documents de contexte
 * de n'importe quel projet. Les gates (licence, toggles, grant) sont évaluées
 * côté service. Proxy live — aucune copie.
 */
@ApiTags('tasks')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromTaskParam('taskId'))
@UseFilters(FileSourceExceptionFilter)
@Controller()
export class FileSourcesController {
  constructor(private readonly svc: FileSourcesService) {}

  /** Liste un dossier de la source (racine si `folderId` absent), paginé. */
  @Get('tasks/:taskId/context-files')
  @RequirePermissions('task:view')
  @PublicApi('task:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query('source') source = 'sharepoint',
    @Query('folderId') folderId?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.svc.listForTask(user.orgId, taskId, source, folderId, cursor);
  }

  /** Texte extrait d'un fichier de la source (binaire → 415, gros → 413). */
  @Get('tasks/:taskId/context-files/:source/:itemId')
  @RequirePermissions('task:view')
  @PublicApi('task:view')
  @Audited('filesource.document.read', { resource: 'task', idParam: 'taskId' })
  getFile(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Param('source') source: string,
    @Param('itemId') itemId: string,
  ) {
    return this.svc.getFileForTask(user.orgId, taskId, source, itemId);
  }
}
