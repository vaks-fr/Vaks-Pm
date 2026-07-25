import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { PublicApi, RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { CollabSpacesService } from './collab-spaces.service';
import { UpsertCollabSpaceBody } from './dto/upsert-collab-space.dto';

/**
 * Espaces de collaboration d'un projet (Teams, Slack, Google…).
 *
 * Voie **entrante** : un provisioner externe qui gère lui-même l'espace vient
 * DÉCLARER le lien avec une clé org scopée `collab:link` — scope étroit
 * délibéré : `project:update` laisserait ce jeton éditer tout le projet.
 *
 * ⚠️ **Pas** de `@RequiresFeature('teams-provisioning')` : déclarer un espace
 * Slack créé dehors ne doit pas exiger la licence du provisioning Teams.
 * `ProjectAccessGuard` by-passe les clés org (identité service) ; l'isolation
 * org est re-vérifiée en service (404 sur un projet d'un autre tenant).
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
@PublicApi()
@Controller('projects/:projectId/collab-spaces')
export class CollabSpacesController {
  constructor(private readonly svc: CollabSpacesService) {}

  @Get()
  @PublicApi('project:view')
  @RequirePermissions('project:view')
  @ApiOperation({ summary: "Lister les espaces de collaboration du projet" })
  list(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.list(user.orgId, projectId);
  }

  @Put(':provider')
  @PublicApi('collab:link')
  @RequirePermissions('collab:link')
  @ApiOperation({
    summary: "Déclarer (upsert) un espace de collaboration créé à l'extérieur",
    description:
      "Idempotent sur (projet, provider). Refuse (409) d'écraser un espace provisionné par Vaks.",
  })
  upsert(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('provider') provider: string,
    @Body() dto: UpsertCollabSpaceBody,
  ) {
    return this.svc.upsert(user.orgId, projectId, provider, dto);
  }

  @Delete(':provider')
  @PublicApi('collab:link')
  @RequirePermissions('collab:link')
  @ApiOperation({ summary: "Retirer un espace déclaré (externe uniquement)" })
  remove(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('provider') provider: string,
  ) {
    return this.svc.remove(user.orgId, projectId, provider);
  }
}
