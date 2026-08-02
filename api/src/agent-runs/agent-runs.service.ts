import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { AgentBudgetService } from '../agents/agent-budget.service';
import { PolicyEngineService } from '../agents/policy-engine.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { CreateAgentRunDto } from './dto/create-agent-run.dto';

const toNum = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

/** En dessous de ce ratio (coût déclaré / coût de référence dérivé), on
 *  considère le coût déclaré comme implausiblement bas → alerte owner. */
const ANOMALY_UNDERREPORT_RATIO = 0.5;

/**
 * Runs d'agent — **coût réel déclaratif** (chantier finance agents). L'agent
 * déclare sa propre consommation (tokens + €).
 *
 * **Dérivation-référence** (2026-07-26) : on recalcule TOUJOURS un coût de
 * référence côté serveur depuis les tokens × les taux du profil agent (taux
 * DISTINCTS entrée/sortie — l'output coûte 3–5× l'input) :
 * `tokensIn/1000 × costRateIn + tokensOut/1000 × costRateOut`. Ce `derivedCost`
 * est stocké à côté du `cost` déclaré, qui reste **prioritaire pour la
 * facturation/les budgets** (il capture le cache/tiers qu'un taux fixe ignore).
 * Si l'agent ne déclare rien, `cost = derivedCost`. La comparaison des deux sert
 * l'**anti-triche** : un `cost` déclaré implausiblement bas déclenche une alerte
 * à l'owner (automation `agent_run_anomaly`), sans jamais fausser la facturation.
 *
 * **Idempotence** : si l'agent fournit un `runKey`, un retour du même appel met
 * à jour le run au lieu d'en créer un doublon (double comptage du coût évité).
 */
@Injectable()
export class AgentRunsService {
  private readonly log = new Logger(AgentRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: AgentBudgetService,
    private readonly policies: PolicyEngineService,
    private readonly audit: AuditLogService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** L'acteur courant (un agent) déclare un de SES runs. */
  async report(
    orgId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
    dto: CreateAgentRunDto,
  ) {
    if (actor.actorKind !== 'AGENT') {
      throw new ForbiddenException('Seul un agent peut déclarer un run.');
    }
    // Dénormalise le projet depuis la tâche (agrégation + budgets par projet).
    let projectId: string | null = null;
    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, organizationId: orgId },
        select: { projectId: true },
      });
      projectId = task?.projectId ?? null;
      // Anti-injection de coût cross-projet (audit sécu 2026-08-01) : un agent ne
      // peut imputer un run qu'à une tâche d'un projet dont il est membre.
      // `dto.taskId` n'étant scopé qu'à l'org, sans ce contrôle un agent pouvait
      // attribuer sa dépense — et donc épuiser le budget par projet (DoS au claim)
      // ou fausser le P&L/la facturation — d'un projet concurrent auquel il n'a
      // aucun lien.
      if (projectId && !(await this.isProjectMember(orgId, actor.userId, projectId))) {
        throw new ForbiddenException(
          "Cet agent n'est pas membre du projet de cette tâche — run refusé.",
        );
      }
    }
    // Coût de RÉFÉRENCE : toujours dérivé du profil agent (taux distincts
    // entrée/sortie). Sert de garde-fou anti-triche même quand l'agent déclare
    // son propre coût. Null si aucun taux configuré ou zéro token.
    const tokensIn = dto.tokensIn ?? 0;
    const tokensOut = dto.tokensOut ?? 0;
    let derivedCost: Prisma.Decimal | null = null;
    // Modèle : déclaré par l'agent s'il le précise, sinon celui de son profil.
    // Un run sans modèle n'est pas exploitable (on ne sait plus ce qui a produit
    // la dépense) — et l'information est déjà connue de la plateforme, autant la
    // renseigner que d'afficher un vide dans le journal d'usage.
    let model = dto.model?.trim() || null;
    if (tokensIn + tokensOut > 0 || !model) {
      const profile = await this.prisma.user.findFirst({
        where: { id: actor.userId, organizationId: orgId },
        select: { costRateInPerKTokens: true, costRateOutPerKTokens: true, model: true },
      });
      if (!model) model = profile?.model ?? null;
      // Le coût de référence n'a de sens qu'avec des tokens : sans eux on
      // laisse `null` (et non 0, qui se lirait « gratuit » au lieu de « inconnu »).
      if (tokensIn + tokensOut > 0) {
        const rateIn = profile?.costRateInPerKTokens != null ? Number(profile.costRateInPerKTokens) : null;
        const rateOut = profile?.costRateOutPerKTokens != null ? Number(profile.costRateOutPerKTokens) : null;
        if (rateIn != null || rateOut != null) {
          const derived = (tokensIn / 1000) * (rateIn ?? 0) + (tokensOut / 1000) * (rateOut ?? 0);
          derivedCost = new Prisma.Decimal(Math.round(derived * 10000) / 10000);
        }
      }
    }
    // Coût facturé/budgété : déclaré s'il existe (cache/tiers), sinon la
    // référence dérivée.
    const declaredCost = dto.cost != null ? new Prisma.Decimal(dto.cost) : null;
    const cost = declaredCost ?? derivedCost;

    const data = {
      organizationId: orgId,
      agentId: actor.userId,
      taskId: dto.taskId ?? null,
      projectId,
      deliverableId: dto.deliverableId ?? null,
      model,
      tokensIn: dto.tokensIn ?? null,
      tokensOut: dto.tokensOut ?? null,
      cost,
      derivedCost,
      note: dto.note?.trim() || null,
    };

    // Idempotence : un `runKey` fourni → upsert (retry sans double comptage).
    const runKey = dto.runKey?.trim() || null;
    const run = runKey
      ? await this.prisma.agentRun.upsert({
          where: {
            organizationId_agentId_runKey: { organizationId: orgId, agentId: actor.userId, runKey },
          },
          create: { ...data, runKey },
          update: data,
        })
      : await this.prisma.agentRun.create({ data });

    // Anti-triche (fire-and-forget, fail-open) : coût déclaré implausiblement
    // bas vs la référence, ou livrable produit « gratuitement ». Alerte l'owner.
    const anomaly = this.detectAnomaly({
      hasDeliverable: !!dto.deliverableId,
      tokensTotal: tokensIn + tokensOut,
      declaredCost: declaredCost != null ? Number(declaredCost) : null,
      derivedCost: derivedCost != null ? Number(derivedCost) : null,
    });
    if (anomaly) {
      void this.hooks()?.onAgentRunReported(orgId, {
        runId: run.id,
        agentId: actor.userId,
        taskId: dto.taskId ?? null,
        projectId,
        reason: anomaly,
        declaredCost: declaredCost != null ? Number(declaredCost) : null,
        derivedCost: derivedCost != null ? Number(derivedCost) : null,
      });
    }

    // Coupe-circuit budgétaire (lot A §2). Les enveloppes n'étaient vérifiées
    // qu'au CLAIM : un agent parti en boucle brûlait tout son budget sur une
    // seule tâche sans que rien ne l'arrête. La déclaration de run est le seul
    // moment où le serveur voit la dépense arriver — c'est donc ici qu'on coupe.
    const budget = await this.budgets
      .snapshot(orgId, actor.userId, { taskId: dto.taskId ?? null, projectId })
      .catch(() => null);
    let taskReleased = false;
    if (budget?.stop) {
      taskReleased = await this.tripBudgetBreaker(orgId, actor.userId, dto.taskId ?? null, projectId, budget);
    }

    return {
      ...this.toDto(run),
      ...(budget ? { budget } : {}),
      ...(taskReleased ? { taskReleased: true } : {}),
    };
  }

  /**
   * Enveloppe consommée en cours de tâche : on alerte TOUJOURS (audit + owner de
   * l'agent), et on retire la tâche à l'agent SI l'org a armé le coupe-circuit
   * (`agents.budgetBreaker`).
   *
   * Pourquoi ne pas lever une exception : le run doit rester enregistré (l'argent
   * a été dépensé, on ne l'efface pas d'un 402), et un agent qui vient de payer
   * son travail doit pouvoir le soumettre plutôt que le jeter. L'arrêt passe donc
   * par la réponse (`budget.stop`), pas par une erreur — et le prochain claim est
   * de toute façon refusé par les garde-fous existants.
   *
   * Le retrait reprend la mécanique « poison task » : claim + assignation
   * retirés, la tâche sort du circuit agent et attend une reprise humaine (le
   * travail déjà produit reste attaché à la tâche).
   */
  private async tripBudgetBreaker(
    orgId: string,
    agentId: string,
    taskId: string | null,
    projectId: string | null,
    budget: { exceeded: string[]; envelopes: { scope: string; budget: number; spent: number }[] },
  ): Promise<boolean> {
    const breaker = await this.policies.getBudgetBreaker(orgId).catch(() => false);
    const canRelease = breaker && !!taskId;
    let released = false;
    if (canRelease && taskId) {
      try {
        released = await this.prisma.$transaction(async (tx) => {
          // Conditionné au claimant : on ne retire jamais la tâche de quelqu'un
          // d'autre (un agent peut déclarer un run sur une tâche qu'il ne tient
          // plus — bail expiré, takeover).
          const res = await tx.task.updateMany({
            where: {
              id: taskId,
              organizationId: orgId,
              claimedById: agentId,
              status: { in: [TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS] },
              deletedAt: null,
            },
            data: { claimedById: null, leaseExpiresAt: null },
          });
          if (res.count === 0) return false;
          await tx.taskAssignee
            .deleteMany({ where: { taskId, userId: agentId } })
            .catch(() => undefined);
          return true;
        });
      } catch (err) {
        this.log.warn(`budget breaker on task=${taskId} failed: ${(err as Error).message}`);
      }
    }

    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_BUDGET_EXCEEDED,
      // Retirer une tâche à un agent en plein travail est irréversible pour lui.
      severity: released ? 'CRITICAL' : 'WARNING',
      actorType: 'AGENT',
      actorId: agentId,
      resourceType: taskId ? 'task' : 'agent',
      resourceId: taskId ?? agentId,
      detail: {
        projectId,
        exceeded: budget.exceeded,
        envelopes: budget.envelopes,
        breakerEnabled: breaker,
        taskReleased: released,
      },
    });

    // Alerte l'owner humain via le canal automations existant (kind
    // `agent_budget`, déjà traduit ×4 + carte Teams). Qualifier distinct de
    // celui du cron horaire : c'est un événement, pas un seuil périodique.
    void this.hooks()?.onAgentBudgetExceeded(orgId, {
      agentId,
      taskId,
      projectId,
      exceeded: budget.exceeded,
      envelopes: budget.envelopes,
      taskReleased: released,
    });
    return released;
  }

  /**
   * Décide si un run déclaré est suspect. Trois signaux binaires (v1) :
   *  - `no_tokens`       : un livrable a été produit mais 0 token déclaré ;
   *  - `zero_cost`       : coût déclaré à 0 alors qu'un coût de référence > 0 existe ;
   *  - `below_reference` : coût déclaré < 50 % du coût de référence dérivé.
   */
  private detectAnomaly(x: {
    hasDeliverable: boolean;
    tokensTotal: number;
    declaredCost: number | null;
    derivedCost: number | null;
  }): 'no_tokens' | 'zero_cost' | 'below_reference' | null {
    if (x.hasDeliverable && x.tokensTotal === 0) return 'no_tokens';
    if (x.declaredCost === 0 && (x.derivedCost ?? 0) > 0) return 'zero_cost';
    if (
      x.declaredCost != null &&
      x.declaredCost > 0 &&
      x.derivedCost != null &&
      x.derivedCost > 0 &&
      x.declaredCost < x.derivedCost * ANOMALY_UNDERREPORT_RATIO
    ) {
      return 'below_reference';
    }
    return null;
  }

  /**
   * Un agent n'impute un run qu'à un projet dont il est **membre** (direct ou via
   * une équipe affectée) — garde-fou anti-injection de coût cross-projet (audit
   * sécu 2026-08-01). Même définition d'appartenance que `DeliverablesService`.
   */
  private async isProjectMember(orgId: string, userId: string, projectId: string): Promise<boolean> {
    const [direct, viaTeam] = await Promise.all([
      this.prisma.projectMember.count({
        where: { userId, projectId, project: { organizationId: orgId, deletedAt: null } },
      }),
      this.prisma.projectTeam.count({
        where: {
          projectId,
          project: { organizationId: orgId, deletedAt: null },
          team: { members: { some: { userId } } },
        },
      }),
    ]);
    return direct > 0 || viaTeam > 0;
  }

  /** Hooks automations en lazy (évite un cycle de modules ; fail-open). */
  private hooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Journal de TOUS les runs d'agent de l'organisation — le pendant du journal
   * d'audit, côté consommation IA.
   *
   * La synthèse par agent existait déjà, mais il n'y avait aucune vue
   * transverse : impossible de répondre à « qu'est-ce que l'IA a coûté ce
   * mois-ci, sur quels projets, et est-ce que quelque chose cloche ». Filtres
   * cumulatifs (agent, projet, période, anomalies), pagination par offset —
   * l'ordre est stable (`createdAt desc, id desc`) et les volumes se comptent en
   * milliers, pas en millions comme l'audit : un curseur keyset serait du zèle.
   *
   * `anomaliesOnly` rejoue le même détecteur qu'à l'écriture plutôt que de
   * stocker un drapeau : la règle peut évoluer sans migration, et l'historique
   * est relu avec la règle courante.
   */
  async list(
    orgId: string,
    q: {
      agentId?: string;
      projectId?: string;
      from?: string;
      to?: string;
      anomaliesOnly?: boolean;
      page?: number;
      pageSize?: number;
    },
  ) {
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(q.pageSize) || 50)));
    const where: Prisma.AgentRunWhereInput = { organizationId: orgId };
    if (q.agentId) where.agentId = q.agentId;
    if (q.projectId) where.projectId = q.projectId;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        // `to` est une DATE côté UI : on inclut la journée entière.
        ...(q.to ? { lt: new Date(new Date(q.to).getTime() + 86_400_000) } : {}),
      };
    }

    // L'anomalie n'est pas une colonne stockée : elle se recalcule à la lecture
    // (cf. commentaire de classe). Une passe scalaire SANS pagination sur le
    // périmètre filtré donne (a) le set d'ids anomalie pour scoper `anomaliesOnly`
    // correctement — auparavant filtré APRÈS la pagination, ce qui faussait le
    // total et la page affichée — et (b) le compteur KPI org-wide, indépendant du
    // toggle. Les volumes de runs restent en milliers (cf. commentaire de
    // méthode), donc ce passage scalaire reste bon marché.
    const scalarRows = await this.prisma.agentRun.findMany({
      where,
      select: { id: true, cost: true, derivedCost: true, tokensIn: true, tokensOut: true, deliverableId: true },
    });
    const anomalousIds = scalarRows
      .filter((r) =>
        this.detectAnomaly({
          hasDeliverable: !!r.deliverableId,
          tokensTotal: (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
          declaredCost: r.cost != null ? Number(r.cost) : null,
          derivedCost: r.derivedCost != null ? Number(r.derivedCost) : null,
        }),
      )
      .map((r) => r.id);
    const scopedWhere: Prisma.AgentRunWhereInput = q.anomaliesOnly
      ? { ...where, id: { in: anomalousIds } }
      : where;

    const [rows, total, agg] = await Promise.all([
      this.prisma.agentRun.findMany({
        where: scopedWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.agentRun.count({ where: scopedWhere }),
      this.prisma.agentRun.aggregate({
        where: scopedWhere,
        _sum: { cost: true, tokensIn: true, tokensOut: true, derivedCost: true },
      }),
    ]);

    // Libellés résolus en une passe (agents + projets + tâches de la page).
    const [agents, projects, tasks] = await Promise.all([
      this.labelUsers(orgId, rows.map((r) => r.agentId)),
      this.labelProjects(orgId, rows.map((r) => r.projectId)),
      this.labelTasks(orgId, rows.map((r) => r.taskId)),
    ]);

    const items = rows.map((r) => {
      const anomaly = this.detectAnomaly({
        hasDeliverable: !!r.deliverableId,
        tokensTotal: (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
        declaredCost: r.cost != null ? Number(r.cost) : null,
        derivedCost: r.derivedCost != null ? Number(r.derivedCost) : null,
      });
      const task = r.taskId ? tasks.get(r.taskId) : null;
      return {
        ...this.toDto(r),
        agentName: agents.get(r.agentId) ?? null,
        projectName: r.projectId ? (projects.get(r.projectId) ?? null) : null,
        taskTitle: task?.title ?? null,
        taskNumber: task?.number ?? null,
        anomaly,
      };
    });

    return {
      items,
      page,
      pageSize,
      total,
      /** Totaux sur le PÉRIMÈTRE FILTRÉ (et sur `anomaliesOnly` si actif), pas sur la page affichée. */
      totals: {
        cost: Math.round(Number(agg._sum.cost ?? 0) * 10000) / 10000,
        tokensIn: agg._sum.tokensIn ?? 0,
        tokensOut: agg._sum.tokensOut ?? 0,
        derivedCost: Math.round(Number(agg._sum.derivedCost ?? 0) * 10000) / 10000,
      },
      /** Toujours sur agent/projet/période — indépendant du toggle `anomaliesOnly`. */
      anomalyCount: anomalousIds.length,
    };
  }

  private async labelUsers(orgId: string, ids: (string | null)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((v): v is string => !!v))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async labelProjects(orgId: string, ids: (string | null)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((v): v is string => !!v))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.project.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async labelTasks(
    orgId: string,
    ids: (string | null)[],
  ): Promise<Map<string, { title: string; number: number }>> {
    const uniq = [...new Set(ids.filter((v): v is string => !!v))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.task.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, title: true, number: true },
    });
    return new Map(rows.map((r) => [r.id, { title: r.title, number: r.number }]));
  }

  /** Synthèse d'usage d'un agent (lecture admin `agent:manage`). */
  async summaryForAgent(orgId: string, agentId: string) {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId, kind: 'AGENT' },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agent introuvable');

    const runs = await this.prisma.agentRun.findMany({
      where: { organizationId: orgId, agentId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const costByTask = new Map<string, number>();
    for (const r of runs) {
      const c = toNum(r.cost) ?? 0;
      totalCost += c;
      totalTokensIn += r.tokensIn ?? 0;
      totalTokensOut += r.tokensOut ?? 0;
      if (r.taskId) costByTask.set(r.taskId, (costByTask.get(r.taskId) ?? 0) + c);
    }
    const taskCosts = [...costByTask.values()].filter((v) => v > 0);
    return {
      agentId,
      runCount: runs.length,
      totalTokensIn,
      totalTokensOut,
      totalCost: Math.round(totalCost * 10000) / 10000,
      avgCostPerRun: runs.length ? Math.round((totalCost / runs.length) * 10000) / 10000 : null,
      avgCostPerTask: taskCosts.length
        ? Math.round((taskCosts.reduce((a, b) => a + b, 0) / taskCosts.length) * 10000) / 10000
        : null,
      runs: runs.slice(0, 50).map((r) => this.toDto(r)),
    };
  }

  private toDto(r: {
    id: string;
    agentId: string;
    taskId: string | null;
    projectId: string | null;
    deliverableId: string | null;
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    cost: Prisma.Decimal | null;
    derivedCost?: Prisma.Decimal | null;
    runKey?: string | null;
    note: string | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      agentId: r.agentId,
      taskId: r.taskId,
      projectId: r.projectId,
      deliverableId: r.deliverableId,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cost: toNum(r.cost),
      derivedCost: r.derivedCost != null ? toNum(r.derivedCost) : null,
      runKey: r.runKey ?? null,
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
