import { Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { CollabProvisionService } from './collab-provision.service';

/**
 * Provisioning des espaces de collaboration au niveau **projet** (onglet
 * Intégrations) — une tuile par fournisseur (Teams / Slack / Google Chat).
 *
 * App-privé (pas `@PublicApi`) : c'est une action humaine en session, comme le
 * bouton Teams historique. Accès projet (anti-IDOR) + `project:update` pour
 * déclencher. **Pas** de `@RequiresFeature` ici : la lecture du statut doit
 * rester possible pour afficher l'état, et chaque service porte déjà son propre
 * gating (toggle org + credentials, licence côté Teams).
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
@Controller('projects/:projectId/collab-provision')
export class CollabProvisionController {
  constructor(private readonly svc: CollabProvisionService) {}

  @Get()
  @RequirePermissions('project:view')
  @ApiOperation({ summary: "État de provisioning des fournisseurs de collaboration" })
  status(@CurrentUser() user: AuthUser, @Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.svc.status(user.orgId, projectId);
  }

  @Post(':provider')
  @RequirePermissions('project:update')
  @SkipAudit()
  @ApiOperation({ summary: "Provisionner maintenant l'espace d'un fournisseur" })
  provision(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('provider') provider: string,
  ) {
    return this.svc.provision(user.orgId, projectId, provider);
  }

  /**
   * Archive l'espace. Destructif côté fournisseur (Slack ne sait pas supprimer
   * un canal : archiver est le seul nettoyage) → confirmation demandée côté UI.
   */
  @Delete(':provider')
  @RequirePermissions('project:update')
  @SkipAudit()
  @ApiOperation({ summary: "Archiver l'espace d'un fournisseur" })
  archive(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('provider') provider: string,
  ) {
    return this.svc.archive(user.orgId, projectId, provider);
  }

  /**
   * Détache le lien LOCAL sans toucher au distant — débloque un projet dont
   * l'espace/équipe a été supprimé côté fournisseur (archive/re-sync en 404).
   * Audité (pas de `@SkipAudit`) : c'est un changement d'état du projet.
   */
  @Post(':provider/detach')
  @RequirePermissions('project:update')
  @ApiOperation({ summary: 'Détacher le lien local (le distant a été supprimé)' })
  detach(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('provider') provider: string,
  ) {
    return this.svc.detach(user.orgId, projectId, provider);
  }

  /**
   * Supprime l'espace distant (Google Chat uniquement — pas d'archivage chez
   * Google). Destructif/définitif → confirmation forte côté UI. Audité.
   */
  @Post(':provider/delete-space')
  @RequirePermissions('project:update')
  @ApiOperation({ summary: "Supprimer l'espace distant (Google Chat — définitif)" })
  deleteSpace(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('provider') provider: string,
  ) {
    return this.svc.deleteSpace(user.orgId, projectId, provider);
  }
}
