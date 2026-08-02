import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AgentBudgetEnvelope,
  buildEnvelope,
  evaluateBudgetStop,
} from './agent-budget';

/**
 * Photographie des enveloppes de coût agent (lot A §2 — plafonds *a priori*).
 *
 * Le claim vérifiait déjà les 4 enveloppes (agent/jour, agent/mois, projet,
 * tâche) — mais **seulement au claim** : un agent parti en boucle brûlait tout
 * son budget avant qu'on ne s'en aperçoive, et il ne connaissait de toute façon
 * jamais son plafond. Ce service rend la même donnée disponible EN COURS de
 * tâche, à trois endroits :
 *   - `vaks_get_work_context` : l'agent démarre en sachant ce dont il dispose ;
 *   - `vaks_execution_heartbeat` : il le réapprend à chaque battement ;
 *   - `vaks_report_run` : le coupe-circuit, au moment où le coût est déclaré.
 *
 * Lecture pure (aucun effet de bord) ; la décision est la fonction pure
 * `evaluateBudgetStop`. Les sommes portent sur `AgentRun.cost` (coût facturé =
 * déclaré, sinon dérivé) — même base que les refus au claim, pour qu'un agent
 * ne voie jamais deux vérités différentes.
 */
@Injectable()
export class AgentBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Enveloppes applicables à un agent, éventuellement sur une tâche/un projet.
   * Ne renvoie que les enveloppes RÉELLEMENT définies (pas de plafond = pas de
   * ligne : un agent ne doit pas croire qu'il est borné quand il ne l'est pas).
   */
  async snapshot(
    orgId: string,
    agentId: string,
    opts: { taskId?: string | null; projectId?: string | null } = {},
  ): Promise<{
    envelopes: AgentBudgetEnvelope[];
    stop: boolean;
    exceeded: AgentBudgetEnvelope['scope'][];
  }> {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId },
      select: { dailyCostBudget: true, monthlyCostBudget: true, kind: true },
    });
    // Un humain n'a pas d'enveloppe agent — on ne fabrique pas de contrainte.
    if (!agent || agent.kind !== 'AGENT') return { envelopes: [], stop: false, exceeded: [] };

    // Résolution du projet depuis la tâche quand il n'est pas fourni (le budget
    // projet doit s'appliquer même si l'appelant ne connaît que la tâche).
    let projectId = opts.projectId ?? null;
    let taskBudget: number | null = null;
    let taskScope: string[] = [];
    if (opts.taskId) {
      const env = await this.resolveTaskEnvelope(orgId, opts.taskId);
      projectId = projectId ?? env.projectId;
      taskBudget = env.budget;
      taskScope = env.taskIds;
    }
    let projectBudget: number | null = null;
    if (projectId) {
      const project = await this.prisma.project.findFirst({
        where: { id: projectId, organizationId: orgId },
        select: { agentCostBudget: true },
      });
      projectBudget = project?.agentCostBudget != null ? Number(project.agentCostBudget) : null;
    }

    // Mêmes fenêtres que le claim : minuit UTC / 1er du mois UTC (cohérence app
    // documentée — un run à 23 h UTC compte pour la journée UTC courante).
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const dailyBudget = agent.dailyCostBudget != null ? Number(agent.dailyCostBudget) : null;
    const monthlyBudget = agent.monthlyCostBudget != null ? Number(agent.monthlyCostBudget) : null;

    // Une agrégation par enveloppe DÉFINIE seulement : pas de plafond, pas de
    // requête (le cas nominal d'une org sans budget agent ne coûte rien).
    const [daySpent, monthSpent, projectSpent, taskSpent] = await Promise.all([
      dailyBudget != null ? this.sum({ organizationId: orgId, agentId, createdAt: { gte: dayStart } }) : null,
      monthlyBudget != null ? this.sum({ organizationId: orgId, agentId, createdAt: { gte: monthStart } }) : null,
      projectBudget != null && projectId ? this.sum({ organizationId: orgId, projectId }) : null,
      taskBudget != null && taskScope.length
        ? this.sum({ organizationId: orgId, taskId: { in: taskScope } })
        : null,
    ]);

    const envelopes = [
      buildEnvelope('agent_daily', dailyBudget, daySpent ?? 0),
      buildEnvelope('agent_monthly', monthlyBudget, monthSpent ?? 0),
      buildEnvelope('project', projectBudget, projectSpent ?? 0),
      buildEnvelope('task', taskBudget, taskSpent ?? 0),
    ].filter((e): e is AgentBudgetEnvelope => e !== null);

    return { envelopes, ...evaluateBudgetStop(envelopes) };
  }

  /**
   * Enveloppe de coût applicable à une tâche, **héritage compris** (lot B).
   *
   * Une sous-tâche créée par un agent n'a pas de plafond propre : si elle
   * n'héritait pas de celui de son parent, la décomposition deviendrait une
   * porte de sortie budgétaire — plafonné sur X, l'agent découpe X et continue
   * à dépenser sur X.1. L'enveloppe du parent couvre donc **le parent et toutes
   * ses sous-tâches**, et c'est cette somme qu'on compare au plafond.
   *
   * Un plafond posé explicitement sur la sous-tâche (par un humain) l'emporte :
   * c'est une décision de gouvernance plus fine, pas un contournement.
   * Profondeur bornée à un niveau (cf. `assertAgentDecomposition`) → une seule
   * remontée suffit.
   */
  async resolveTaskEnvelope(
    orgId: string,
    taskId: string,
  ): Promise<{ projectId: string | null; budget: number | null; taskIds: string[] }> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId },
      select: { id: true, projectId: true, agentCostBudget: true, parentTaskId: true },
    });
    if (!task) return { projectId: null, budget: null, taskIds: [taskId] };

    if (task.agentCostBudget != null) {
      return { projectId: task.projectId, budget: Number(task.agentCostBudget), taskIds: [task.id] };
    }
    if (!task.parentTaskId) {
      return { projectId: task.projectId, budget: null, taskIds: [task.id] };
    }
    const parent = await this.prisma.task.findFirst({
      where: { id: task.parentTaskId, organizationId: orgId },
      select: { id: true, agentCostBudget: true },
    });
    if (parent?.agentCostBudget == null) {
      return { projectId: task.projectId, budget: null, taskIds: [task.id] };
    }
    const siblings = await this.prisma.task.findMany({
      where: { parentTaskId: parent.id, organizationId: orgId },
      select: { id: true },
    });
    return {
      projectId: task.projectId,
      budget: Number(parent.agentCostBudget),
      // Le parent ET sa fratrie : l'enveloppe est celle de l'arbre, pas d'une branche.
      taskIds: [parent.id, ...siblings.map((s) => s.id)],
    };
  }

  private async sum(where: Record<string, unknown>): Promise<number> {
    const agg = await this.prisma.agentRun.aggregate({
      _sum: { cost: true },
      where: where as never,
    });
    return Number(agg._sum.cost ?? 0);
  }
}
