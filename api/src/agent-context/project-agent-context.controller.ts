import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { AgentContextPreviewDto } from '@vaks-pm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../rbac/permissions.guard';
import { ProjectAccessGuard } from '../rbac/project-access.guard';
import { ProjectAccess, fromProjectParam } from '../rbac/project-access.decorator';
import { RequirePermissions } from '../rbac/require-permissions.decorator';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { AgentContextService } from './agent-context.service';

/**
 * « Ce que voient les agents » — prévisualisation HUMAINE du pack de contexte.
 *
 * ⚠️ Volontairement dans un controller (et un module) DÉDIÉ, et surtout PAS sur
 * `ProjectsController` : celui-ci porte `@PublicApi()` au niveau CLASSE, ce qui
 * ouvrirait automatiquement cette route aux jetons d'API — et il n'existe aucun
 * décorateur pour repasser une route en app-privé sous une classe publique.
 * Même motif que `filesources/project-filesources.controller.ts`.
 *
 * L'écran sert à ce que l'humain vérifie ce que l'agent reçoit ; il n'a aucune
 * raison d'être consommé par un agent (qui obtient déjà le pack via son
 * work-context, composé par le MÊME service).
 */
@ApiTags('projects')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionsGuard, ProjectAccessGuard)
@ProjectAccess(fromProjectParam('projectId'))
@Controller('projects/:projectId')
export class ProjectAgentContextController {
  constructor(private readonly agentContext: AgentContextService) {}

  @Get('agent-context-preview')
  @RequirePermissions('project:view')
  async preview(
    @CurrentUser() user: AuthUser,
    @Param('projectId', ParseUUIDPipe) projectId: string,
  ): Promise<AgentContextPreviewDto> {
    const pack = await this.agentContext.buildPack(user.orgId, projectId);
    if (!pack) throw new NotFoundException('Projet introuvable');

    return {
      agentsEnabled: pack.agentsEnabled,
      brief: {
        composed: pack.project.brief,
        structured: pack.project.briefStructured,
        orgDefaultApplied: pack.project.orgDefaultApplied,
        freeNotes: pack.project.freeNotes,
      },
      facts: {
        reviewers: pack.facts.reviewerList,
        verificationMode: pack.facts.verificationMode ?? 'report_only',
        verificationModeSource: pack.facts.verificationModeSource,
        stakes: pack.facts.stakes ?? 'low',
        verificationCapabilities: pack.facts.verificationCapabilities ?? [],
        locale: pack.facts.locale ?? null,
        costBudget: {
          set: !!pack.facts.hasCostBudget,
          spentPct:
            pack.facts.costBudgetSpentPct != null
              ? Math.round(pack.facts.costBudgetSpentPct)
              : null,
        },
      },
      guardrails: { project: pack.project.guardrails },
      charter: pack.charter,
      documents: {
        items: pack.documents.items.map((d) => ({
          id: d.id,
          filename: d.filename,
          mimeType: d.mimeType,
          sizeBytes: d.sizeBytes,
          freshAt: d.freshAt.toISOString(),
          source: d.source,
        })),
        total: pack.documents.total,
        returned: pack.documents.returned,
        truncated: pack.documents.truncated,
      },
      contextSources: pack.contextSources,
      journalPreview: pack.journal.map((j) => ({
        title: j.title,
        summary: j.summary,
        at: j.at.toISOString(),
      })),
    };
  }
}
