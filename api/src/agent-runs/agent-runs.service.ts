import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
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
    }
    // Coût de RÉFÉRENCE : toujours dérivé du profil agent (taux distincts
    // entrée/sortie). Sert de garde-fou anti-triche même quand l'agent déclare
    // son propre coût. Null si aucun taux configuré ou zéro token.
    const tokensIn = dto.tokensIn ?? 0;
    const tokensOut = dto.tokensOut ?? 0;
    let derivedCost: Prisma.Decimal | null = null;
    if (tokensIn + tokensOut > 0) {
      const profile = await this.prisma.user.findFirst({
        where: { id: actor.userId, organizationId: orgId },
        select: { costRateInPerKTokens: true, costRateOutPerKTokens: true },
      });
      const rateIn = profile?.costRateInPerKTokens != null ? Number(profile.costRateInPerKTokens) : null;
      const rateOut = profile?.costRateOutPerKTokens != null ? Number(profile.costRateOutPerKTokens) : null;
      if (rateIn != null || rateOut != null) {
        const derived = (tokensIn / 1000) * (rateIn ?? 0) + (tokensOut / 1000) * (rateOut ?? 0);
        derivedCost = new Prisma.Decimal(Math.round(derived * 10000) / 10000);
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
      model: dto.model ?? null,
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

    return this.toDto(run);
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

  /** Hooks automations en lazy (évite un cycle de modules ; fail-open). */
  private hooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
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
