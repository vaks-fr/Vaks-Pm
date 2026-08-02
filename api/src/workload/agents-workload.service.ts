import { Injectable, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '@db';
import type { AgentWorkloadDto, AgentWorkloadItemDto } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { AgentBudgetService } from '../agents/agent-budget.service';
import { stripAgentFinanceFields } from './scheduling';

/** Même ensemble que le 409 `BUDGET_CONCURRENCY` au claim (tasks.service.ts). */
const ACTIVE_STATUSES: TaskStatus[] = [
  TaskStatus.CLAIMED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.CHANGES_REQUESTED,
];

/**
 * Vue agrégée des agents IA dans le workload (Lot 5, AUTOPLAN_IMPROVEMENTS.md
 * §5.1) — VISIBILITÉ, pas allocation. La capacité d'un agent n'est jamais des
 * heures (AGENTS_ARCHITECTURE.md) : on expose (a) sa concurrence — tâches
 * CLAIMED/IN_PROGRESS/CHANGES_REQUESTED vs `maxConcurrentTasks` — (b) son
 * budget consommé/restant aux 4 périmètres existants, et (c) sa file de
 * revue — livrables `PENDING` qu'il a produits (le vrai goulot).
 *
 * ⚠️ Garde-fou dur : les montants € sont OMIS (jamais un placeholder, jamais
 * un 403) pour qui n'a pas `finance:view` — décidé par l'APPELANT
 * (contrôleur), cette classe se contente d'honorer `canViewFinance` via
 * `stripAgentFinanceFields` (pur, scheduling.ts).
 *
 * Gating : `Project.agentsEnabled=false` ⇒ la vue N'EXISTE PAS
 * (`enabled:false`), même pattern que `ReportsService.agentsReport`.
 * Self-scoping obligatoire (org-wide) via `accessibleProjectScope` — même
 * règle que `PendingReviewsService`.
 */
@Injectable()
export class AgentsWorkloadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly budgets: AgentBudgetService,
  ) {}

  async agentsView(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: { from?: string; to?: string; projectId?: string },
    canViewFinance: boolean,
  ): Promise<AgentWorkloadDto> {
    const today = new Date().toISOString().slice(0, 10);
    const toIso = q.to ?? today;
    const fromIso = q.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const empty: AgentWorkloadDto = {
      enabled: false,
      from: fromIso,
      to: toIso,
      canViewFinance,
      agents: [],
    };

    // -------- Résolution du scope projet(s) --------
    let projectIds: string[];
    let singleProjectId: string | null = null;
    if (q.projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: q.projectId, organizationId: orgId, deletedAt: null, kind: 'STANDARD' },
        select: { id: true, agentsEnabled: true },
      });
      if (!project) throw new NotFoundException('Projet introuvable');
      if (!project.agentsEnabled) return empty;
      projectIds = [project.id];
      singleProjectId = project.id;
    } else {
      // Org-wide : self-scoping obligatoire (jamais fuiter le cross-projet),
      // borné en plus aux projets `agentsEnabled`.
      const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);
      const projects = await this.prisma.project.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          kind: 'STANDARD',
          agentsEnabled: true,
          ...(scope ? { id: { in: scope } } : {}),
        },
        select: { id: true },
      });
      projectIds = projects.map((p) => p.id);
      if (projectIds.length === 0) return empty;
    }

    // -------- Pool d'agents du scope : membres directs + membres des --------
    // -------- équipes affectées + assignés directs d'une tâche du scope. ----
    const [members, projectTeams, taskAgentRows] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId: { in: projectIds }, user: { kind: 'AGENT', deletedAt: null } },
        select: { userId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          team: {
            select: {
              members: {
                where: { user: { kind: 'AGENT', deletedAt: null } },
                select: { userId: true },
              },
            },
          },
        },
      }),
      this.prisma.taskAssignee.findMany({
        where: {
          task: { organizationId: orgId, deletedAt: null, projectId: { in: projectIds } },
          user: { kind: 'AGENT', deletedAt: null },
        },
        select: { userId: true },
      }),
    ]);
    const agentIdSet = new Set<string>();
    for (const m of members) agentIdSet.add(m.userId);
    for (const pt of projectTeams) for (const mm of pt.team.members) agentIdSet.add(mm.userId);
    for (const r of taskAgentRows) agentIdSet.add(r.userId);

    if (agentIdSet.size === 0) return { ...empty, enabled: true };

    const agentIds = Array.from(agentIdSet);
    const agents = await this.prisma.user.findMany({
      where: { id: { in: agentIds }, organizationId: orgId, kind: 'AGENT' },
      select: { id: true, name: true, trustLevel: true, maxConcurrentTasks: true },
    });

    // -------- Concurrence : tâches actives assignées, par agent (même --------
    // -------- ensemble de statuts que le 409 BUDGET_CONCURRENCY au claim). ---
    const activeRows = await this.prisma.taskAssignee.findMany({
      where: {
        userId: { in: agentIds },
        task: { organizationId: orgId, deletedAt: null, status: { in: ACTIVE_STATUSES } },
      },
      select: { userId: true },
    });
    const activeByAgent = new Map<string, number>();
    for (const r of activeRows) activeByAgent.set(r.userId, (activeByAgent.get(r.userId) ?? 0) + 1);

    // -------- File de revue : livrables PENDING produits par cet agent --------
    // -------- (dans le scope projet), le vrai goulot d'un agent. -------------
    const pendingRows = await this.prisma.deliverable.groupBy({
      by: ['authorId'],
      where: {
        organizationId: orgId,
        authorId: { in: agentIds },
        reviewStatus: 'PENDING',
        deletedAt: null,
        task: { deletedAt: null, projectId: { in: projectIds } },
      },
      _count: { _all: true },
    });
    const pendingByAgent = new Map<string, number>();
    for (const r of pendingRows) pendingByAgent.set(r.authorId, r._count._all);

    // -------- Budget — seulement si l'appelant a le droit de le voir --------
    // (évite N requêtes finance inutiles pour un PM sans finance:view, et
    // c'est de toute façon strippé plus bas si jamais collecté par erreur).
    const budgetByAgent = new Map<string, AgentWorkloadItemDto['budget']>();
    if (canViewFinance) {
      await Promise.all(
        agentIds.map(async (agentId) => {
          const snap = await this.budgets.snapshot(orgId, agentId, {
            projectId: singleProjectId ?? undefined,
          });
          budgetByAgent.set(agentId, snap);
        }),
      );
    }

    const items: AgentWorkloadItemDto[] = agents
      .map((a) => ({
        agentId: a.id,
        name: a.name,
        trustLevel: (a.trustLevel ?? null) as AgentWorkloadItemDto['trustLevel'],
        activeTasks: activeByAgent.get(a.id) ?? 0,
        maxConcurrentTasks: a.maxConcurrentTasks ?? null,
        reviewQueuePending: pendingByAgent.get(a.id) ?? 0,
        budget: budgetByAgent.get(a.id),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return {
      enabled: true,
      from: fromIso,
      to: toIso,
      canViewFinance,
      // Garde-fou dur (§5.1) : dégradation propre, jamais un placeholder.
      agents: stripAgentFinanceFields(items, canViewFinance),
    };
  }
}
