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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { TeamsService } from './teams.service';
import {
  AddTeamMemberDto,
  CreateTeamDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/team.dto';

/**
 * Gating équipes :
 *  - Lecture (GET) : tout user avec `project:view` (filtré côté service par
 *    l'appartenance — seul un admin voit toutes les équipes).
 *  - Création / suppression / rename : ORG_ADMIN uniquement (assertion
 *    explicite dans le contrôleur — `member:manage` n'est accordé qu'à
 *    ORG_ADMIN, mais on double-check pour être robuste).
 *  - Gestion des membres : `member:manage` (ORG_ADMIN) OU lead de l'équipe
 *    (vérifié dans TeamsService.assertCanManageMembers).
 */
@ApiTags('teams')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard)
@Controller('teams')
export class TeamsController {
  constructor(private readonly teams: TeamsService) {}

  @Get()
  @PublicApi()
  @RequirePermissions('project:view')
  list(@CurrentUser() user: AuthUser) {
    return this.teams.list(user.orgId, { userId: user.userId, isAdmin: user.isAdmin });
  }

  // Équipes archivées (soft-deleted) — admin/`team:delete`. Déclaré AVANT
  // `:teamId` pour ne pas être capté par la route paramétrée.
  @Get('archived')
  @RequirePermissions('team:delete')
  listArchived(@CurrentUser() user: AuthUser) {
    return this.teams.listArchived(user.orgId);
  }

  @Get(':teamId')
  @PublicApi()
  @RequirePermissions('project:view')
  get(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.teams.get(user.orgId, teamId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // Rapport d'équipe (lead-only — vérifié dans le service). Fenêtre [from, to].
  @Get(':teamId/report')
  @RequirePermissions('project:view')
  report(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.teams.getTeamReport(
      user.orgId,
      teamId,
      { userId: user.userId, isAdmin: user.isAdmin },
      from,
      to,
    );
  }

  // KPI d'équipe (lead-only — vérifié dans le service) : utilisation, conflits
  // de ressources, marge de capacité. Fenêtre [from, to].
  @Get(':teamId/kpi')
  @RequirePermissions('project:view')
  kpi(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Query('from') from: string,
    @Query('to') to: string,
  ) {
    return this.teams.getTeamKpi(
      user.orgId,
      teamId,
      { userId: user.userId, isAdmin: user.isAdmin },
      from,
      to,
    );
  }

  // Création réservée à `team:create` (ORG_ADMIN par défaut ; délégable à un
  // rôle non-admin en lui accordant cette permission). Plus de hard-check
  // isAdmin pour permettre cette délégation.
  @Post()
  @PublicApi('team:create')
  @RequirePermissions('team:create')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTeamDto) {
    return this.teams.create(user.orgId, dto);
  }

  // Édition : admin (bypass), porteur de `team:manage_members`, ou lead de
  // l'équipe ciblée (grant team-scopé posé par le guard). Le service applique
  // les règles fines (source SCIM, flag non-billable réservé à l'admin).
  @Patch(':teamId')
  @PublicApi('team:manage_members')
  @RequirePermissions('team:manage_members')
  update(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: UpdateTeamDto,
  ) {
    return this.teams.update(user.orgId, teamId, dto, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // Soft-delete (archive, réversible) — réservé à `team:delete`. Étape 1.
  @Delete(':teamId')
  @RequirePermissions('team:delete')
  remove(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.teams.remove(user.orgId, teamId);
  }

  // Restaure une équipe archivée. `team:delete`.
  @Post(':teamId/restore')
  @RequirePermissions('team:delete')
  restore(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.teams.restore(user.orgId, teamId);
  }

  // Suppression DÉFINITIVE (hard-delete) — n'opère que sur une équipe déjà
  // archivée. Étape 2. `team:delete`.
  @Delete(':teamId/purge')
  @RequirePermissions('team:delete')
  purge(@CurrentUser() user: AuthUser, @Param('teamId', ParseUUIDPipe) teamId: string) {
    return this.teams.purge(user.orgId, teamId);
  }

  // ----- Membres : `team:manage_members` (admin, ou lead de l'équipe via le
  // grant team-scopé du guard). Le service revérifie (assertCanManageMembers). -----

  @Post(':teamId/members')
  @PublicApi('team:manage_members')
  @RequirePermissions('team:manage_members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: AddTeamMemberDto,
  ) {
    return this.teams.addMember(
      user.orgId,
      teamId,
      { userId: user.userId, isAdmin: user.isAdmin },
      dto,
    );
  }

  @Patch(':teamId/members/:userId')
  @PublicApi('team:manage_members')
  @RequirePermissions('team:manage_members')
  updateMember(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateTeamMemberDto,
  ) {
    return this.teams.updateMember(
      user.orgId,
      teamId,
      userId,
      { userId: user.userId, isAdmin: user.isAdmin },
      dto,
    );
  }

  @Delete(':teamId/members/:userId')
  @PublicApi('team:manage_members')
  @RequirePermissions('team:manage_members')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.teams.removeMember(user.orgId, teamId, userId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }
}
