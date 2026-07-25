import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, TaskWritePolicy, fromProjectParam, fromTaskParam } from '../rbac/project-access.decorator';
import { RequirePermissions, PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { SkillsService } from './skills.service';
import { sendCsv, toCsv } from '../common/csv.util';
import { CurrentLang, reportT, type ReportLang } from '../common/i18n/report-i18n';
import { buildXlsx, sendXlsx } from '../common/xlsx.util';
import {
  CreateSkillDto,
  CreateSkillPackDto,
  SetPackTeamScopeDto,
  SetProjectSkillsDto,
  SetTeamSkillsDto,
  UpdateSkillDto,
  UpsertUserSkillDto,
} from './dto/skill.dto';

@ApiTags('skills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
// Seules les routes portant `:projectId` ou `:taskId` sont scopées projet ;
// le catalogue org-global, les UserSkill (`:userId`), les TeamSkill (`:teamId`)
// et les packs n'ont aucune de ces sources → non contrôlés par ce guard.
@ProjectAccess(fromProjectParam('projectId'), fromTaskParam('taskId'))
@PublicApi()
@Controller()
export class SkillsController {
  constructor(private readonly svc: SkillsService) {}

  // -------- Catalogue org-global --------
  @Get('skills')
  @RequirePermissions('project:view')
  list(@CurrentUser() user: AuthUser) {
    return this.svc.list(user.orgId);
  }

  @Get('skills/capabilities')
  @RequirePermissions('project:view')
  async capabilities(@CurrentUser() user: AuthUser) {
    const canWriteCatalog = await this.svc.canWriteCatalog(user.orgId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
    return { canWriteCatalog };
  }

  // -------- Skill gap dashboard, scopé projet (Phase F) --------
  /**
   * Réservé : admin / Portfolio Manager / Project Manager du projet /
   * lead d'une équipe affectée au projet. Le gating fin est dans le service
   * via `assertCanViewProjectGap` (la permission `report:view` est large,
   * on resserre ici pour que les autres rôles ne voient pas la matrice
   * compétences ↔ couverture du projet).
   */
  @Get('projects/:projectId/skills/gap')
  @RequirePermissions('project:view')
  async projectGap(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    await this.svc.assertCanViewProjectGap(user.orgId, projectId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
    return this.svc.computeSkillGapForProject(user.orgId, projectId);
  }

  /** Export CSV du gap : une ligne par (compétence × tâche). Même gating. */
  @Get('projects/:projectId/skills/gap.csv')
  @RequirePermissions('project:view')
  async projectGapCsv(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    await this.svc.assertCanViewProjectGap(user.orgId, projectId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
    const rows = await this.svc.computeSkillGapForProject(user.orgId, projectId);
    const { detailHeaders, detailRows } = gapToRows(rows, lang);
    sendCsv(
      res,
      `skill-gap-${projectId.slice(0, 8)}.csv`,
      toCsv(detailHeaders, detailRows),
    );
  }

  /** Export XLSX du gap : feuille synthèse par compétence + feuille détail. */
  @Get('projects/:projectId/skills/gap.xlsx')
  @RequirePermissions('project:view')
  async projectGapXlsx(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @CurrentLang() lang: ReportLang,
    @Res() res: Response,
  ) {
    const t = reportT(lang);
    await this.svc.assertCanViewProjectGap(user.orgId, projectId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
    const rows = await this.svc.computeSkillGapForProject(user.orgId, projectId);
    const { detailHeaders, detailRows } = gapToRows(rows, lang);
    const buf = await buildXlsx(
      [
        {
          name: t('sheet.summary'),
          headers: [
            t('col.skill'), t('sg.category'), t('sg.tasks'), t('kpi.covered'), t('kpi.splittable'),
            t('kpi.partial'), t('kpi.uncovered'),
          ],
          rows: rows.map((r) => [
            r.name, r.category ?? '', r.totalTasks, r.fully, r.splittable,
            r.partial, r.uncovered,
          ]),
        },
        { name: t('sheet.gapDetail'), headers: detailHeaders, rows: detailRows },
      ],
      { title: t('title.skillGap') },
    );
    sendXlsx(res, `skill-gap-${projectId.slice(0, 8)}.xlsx`, buf);
  }

  // -------- Export UserSkill CSV --------
  @Get('admin/users/skills/export')
  @RequirePermissions('member:manage')
  async exportCsv(@CurrentUser() user: AuthUser, @Res() res: Response) {
    const csv = await this.svc.exportUserSkillsCsv(user.orgId);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="user-skills-${user.orgId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    // BOM pour Excel
    res.send('﻿' + csv);
  }

  // -------- Bulk import UserSkill (Phase G) --------
  @Post('admin/users/skills/import')
  @RequirePermissions('member:manage')
  bulkImport(
    @CurrentUser() user: AuthUser,
    @Body() body: { csv: string; createMissing?: boolean },
  ) {
    return this.svc.bulkImportUserSkills(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      body.csv,
      { createMissing: !!body.createMissing },
    );
  }

  // -------- Multi-skill par tâche (Phase E) --------
  @Get('tasks/:taskId/required-skills')
  @RequirePermissions('task:view')
  listTaskSkills(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
  ) {
    return this.svc.listTaskRequiredSkills(user.orgId, taskId);
  }

  @Put('tasks/:taskId/required-skills')
  @RequirePermissions('task:update')
  @TaskWritePolicy()
  setTaskSkills(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Body() body: { items: Array<{ skillId: string; level?: number }> },
  ) {
    return this.svc.setTaskRequiredSkills(
      user.orgId,
      taskId,
      body.items ?? [],
      { isAdmin: user.isAdmin },
    );
  }

  // -------- Packs de compétences prêts à l'emploi --------
  @Get('skills/packs')
  @RequirePermissions('project:view')
  listPacks(@CurrentUser() user: AuthUser) {
    return this.svc.listPacks(user.orgId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  @Get('skills/packs/:packId/teams')
  @RequirePermissions('project:view')
  getPackScope(
    @CurrentUser() user: AuthUser,
    @Param('packId') packId: string,
  ) {
    return this.svc.getPackScope(user.orgId, packId);
  }

  // NB : toutes les mutations catalogue/packs ci-dessous portent un plancher
  // `project:view` (présence dans l'org) — le VRAI gating est en service :
  // `assertCanWriteCatalog` (policy org admin/team_lead/everyone) et, pour les
  // packs scopés, `assertCanWritePack` (admin ou lead d'une équipe du scope).

  /** Admin uniquement : restreint la visibilité d'un pack à certaines équipes. */
  @Put('skills/packs/:packId/teams')
  @RequirePermissions('project:view')
  setPackScope(
    @CurrentUser() user: AuthUser,
    @Param('packId') packId: string,
    @Body() dto: SetPackTeamScopeDto,
  ) {
    return this.svc.setPackScope(user.orgId, packId, dto.teamIds, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  /**
   * Enregistre/met à jour la définition d'un pack custom pour l'org.
   * N'installe pas les compétences au catalogue : appeler ensuite
   * `POST /skills/packs/:id/apply` (ou cliquer "Installer" dans l'UI).
   *
   * Point d'extension API publique : aujourd'hui gating = même que
   * /skills (`canWriteCatalog`, défaut `team_lead`). En phase 9, un PAT
   * scopé `skills:write` pourra utiliser ce même endpoint sans changement.
   */
  @Post('skills/packs')
  @RequirePermissions('project:view')
  upsertCustomPack(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSkillPackDto,
  ) {
    return this.svc.upsertCustomPack(
      user.orgId,
      { userId: user.userId, isAdmin: user.isAdmin },
      dto,
    );
  }

  /** Supprime uniquement la *définition* d'un pack custom (catalogue intact). */
  @Delete('skills/packs/:packId/definition')
  @RequirePermissions('project:view')
  deleteCustomPackDefinition(
    @CurrentUser() user: AuthUser,
    @Param('packId') packId: string,
  ) {
    return this.svc.deleteCustomPackDefinition(user.orgId, packId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  @Post('skills/packs/:packId/apply')
  @RequirePermissions('project:view')
  applyPack(
    @CurrentUser() user: AuthUser,
    @Param('packId') packId: string,
    @Query('force') force?: string,
  ) {
    const restoreDeleted = force === '1' || force === 'true';
    return this.svc.applyPack(
      user.orgId,
      packId,
      { userId: user.userId, isAdmin: user.isAdmin },
      { restoreDeleted },
    );
  }

  @Delete('skills/packs/:packId')
  @RequirePermissions('project:view')
  removePack(
    @CurrentUser() user: AuthUser,
    @Param('packId') packId: string,
  ) {
    return this.svc.removePack(user.orgId, packId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  @Post('skills')
  @RequirePermissions('project:view')
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateSkillDto) {
    return this.svc.create(user.orgId, dto, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  @Patch('skills/:skillId')
  @RequirePermissions('project:view')
  update(
    @CurrentUser() user: AuthUser,
    @Param('skillId', ParseUUIDPipe) skillId: string,
    @Body() dto: UpdateSkillDto,
  ) {
    return this.svc.update(user.orgId, skillId, dto, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  @Delete('skills/:skillId')
  @RequirePermissions('project:view')
  remove(
    @CurrentUser() user: AuthUser,
    @Param('skillId', ParseUUIDPipe) skillId: string,
  ) {
    return this.svc.remove(user.orgId, skillId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // -------- UserSkill --------
  // Lecture : self / admin / manager / équipe ou projet commun avec la cible
  // (cf. ProjectAccessService.canViewUserResource) — pas d'énumération libre
  // des profils de toute l'org par un simple membre.
  @Get('users/:userId/skills')
  @RequirePermissions('project:view')
  listUserSkills(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.listUserSkills(user.orgId, userId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // Écriture : gating en service (assertCanManageUserSkills — admin, lead
  // d'une équipe de la cible, ou self-edit si la policy org l'autorise).
  @Put('users/:userId/skills/:skillId')
  @RequirePermissions('project:view')
  upsertUserSkill(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('skillId', ParseUUIDPipe) skillId: string,
    @Body() dto: UpsertUserSkillDto,
  ) {
    return this.svc.upsertUserSkill(
      user.orgId,
      userId,
      skillId,
      { userId: user.userId, isAdmin: user.isAdmin },
      dto,
    );
  }

  @Delete('users/:userId/skills/:skillId')
  @RequirePermissions('project:view')
  removeUserSkill(
    @CurrentUser() user: AuthUser,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Param('skillId', ParseUUIDPipe) skillId: string,
  ) {
    return this.svc.removeUserSkill(user.orgId, userId, skillId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // -------- ProjectSkill --------
  @Get('projects/:projectId/skills')
  @RequirePermissions('project:view')
  listProjectSkills(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.listProjectSkills(user.orgId, projectId);
  }

  @Get('projects/:projectId/skills/available')
  @RequirePermissions('project:view')
  availableProjectSkills(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ) {
    return this.svc.availableSkillsForProject(user.orgId, projectId, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  @Put('projects/:projectId/skills')
  @RequirePermissions('project:update')
  setProjectSkills(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: SetProjectSkillsDto,
  ) {
    return this.svc.setProjectSkills(user.orgId, projectId, dto, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // -------- TeamSkill (compétences couvertes par une équipe) --------
  @Get('teams/:teamId/skills')
  @RequirePermissions('project:view')
  listTeamSkills(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
  ) {
    return this.svc.listTeamSkills(user.orgId, teamId);
  }

  // Admin OU lead de l'équipe (vérif fine dans le service). On laisse
  // `project:view` au décorateur pour ne pas bloquer un lead non-admin.
  @Put('teams/:teamId/skills')
  @RequirePermissions('project:view')
  setTeamSkills(
    @CurrentUser() user: AuthUser,
    @Param('teamId', ParseUUIDPipe) teamId: string,
    @Body() dto: SetTeamSkillsDto,
  ) {
    return this.svc.setTeamSkills(user.orgId, teamId, dto.skillIds, {
      userId: user.userId,
      isAdmin: user.isAdmin,
    });
  }

  // -------- Suggestions d'assignees --------
  @Get('tasks/:taskId/assignee-suggestions')
  @RequirePermissions('task:view')
  suggest(
    @CurrentUser() user: AuthUser,
    @Param('taskId', ParseUUIDPipe) taskId: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.svc.suggestAssignees(user.orgId, taskId, from, to);
  }
}

// ---------------------------------------------------------------------------
// Mise à plat du gap pour les exports : une ligne par (compétence × tâche).
// ---------------------------------------------------------------------------
const GAP_COVER_KEY: Record<string, string> = {
  fully: 'cover.fully',
  splittable: 'cover.splittable',
  partial: 'cover.partial',
  uncovered: 'cover.uncovered',
};

type GapRows = Awaited<ReturnType<SkillsService['computeSkillGapForProject']>>;

function gapToRows(rows: GapRows, lang: ReportLang): {
  detailHeaders: string[];
  detailRows: unknown[][];
} {
  const t = reportT(lang);
  const lvl = t('lvlAbbr');
  const detailHeaders = [
    t('col.skill'), t('sg.category'), t('task'), t('status'), t('sg.level'),
    t('estimateH'), t('sg.loggedH'), t('sg.remainingH'), t('sg.freeH'),
    t('start'), t('end'), t('sg.qualified'), t('sg.nearQualified'), t('sg.proposedSplit'),
  ];
  const detailRows: unknown[][] = [];
  for (const r of rows) {
    for (const task of r.tasks) {
      detailRows.push([
        r.name,
        r.category ?? '',
        task.title,
        t(GAP_COVER_KEY[task.status] ?? task.status),
        task.requiredLevel,
        task.estimateHours ?? '',
        task.loggedHours,
        task.remainingHours ?? '',
        task.totalFreeHours,
        task.startDate ?? '',
        task.endDate ?? '',
        task.qualifiedUsers
          .map((u) => `${u.name} (${lvl} ${u.level}, ${u.freeHours}h)`)
          .join('; '),
        task.nearQualified
          .map((u) => `${u.name} (${lvl} ${u.level})`)
          .join('; '),
        (task.split ?? []).map((s) => `${s.name}: ${s.hours}h`).join('; '),
      ]);
    }
  }
  return { detailHeaders, detailRows };
}
