import { Controller, Get, Param, ParseUUIDPipe, Query, UseFilters, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { Audited } from '../audit-logs/audited.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { FileSourcesService } from './filesources.service';
import { FileSourceExceptionFilter } from './file-source-exception.filter';

/**
 * Navigation HUMAINE des documents d'une source externe (SharePoint de la team
 * provisionnée) rattachée à un projet. **App-privé** (PAS `@PublicApi` — les
 * agents passent par les routes `tasks/:taskId/context-files`). Gated accès
 * projet + `project:view`, puis le service vérifie l'appartenance à la team
 * Microsoft : seul un membre réellement invité voit le drive. Proxy live,
 * lecture seule, aucune copie.
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@UseFilters(FileSourceExceptionFilter)
@ProjectAccess(fromProjectParam('id'))
@Controller('projects/:id/context-files')
export class ProjectFileSourcesController {
  constructor(private readonly svc: FileSourcesService) {}

  /** Sources dispo (gates + appartenance team) — pilote l'affichage de l'onglet. */
  @Get('availability')
  @RequirePermissions('project:view')
  availability(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.availabilityForProject(user.orgId, id, user.userId);
  }

  /** Liste un dossier de la source (racine si `folderId` absent), paginé. */
  @Get()
  @RequirePermissions('project:view')
  list(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('source') source = 'sharepoint',
    @Query('folderId') folderId?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.svc.listForProject(user.orgId, id, user.userId, source, folderId, cursor);
  }

  /** Texte extrait d'un fichier de la source (binaire → 415, gros → 413). */
  @Get(':source/:itemId')
  @RequirePermissions('project:view')
  @Audited('filesource.document.read', { resource: 'project', idParam: 'id' })
  getFile(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('source') source: string,
    @Param('itemId') itemId: string,
  ) {
    return this.svc.getFileForProject(user.orgId, id, user.userId, source, itemId);
  }
}
