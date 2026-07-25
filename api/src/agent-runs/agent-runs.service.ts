import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { CreateAgentRunDto } from './dto/create-agent-run.dto';

const toNum = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

/**
 * Runs d'agent — **coût réel déclaratif** (chantier finance agents). L'agent
 * déclare sa propre consommation (tokens + €). Si le coût n'est pas déclaré
 * mais que les tokens le sont, il est DÉRIVÉ du profil de l'agent, avec des
 * taux DISTINCTS entrée/sortie (l'output coûte 3–5× l'input chez les
 * fournisseurs LLM) : tokensIn/1000 × costRateInPerKTokens
 * + tokensOut/1000 × costRateOutPerKTokens (Admin > Agents). Si un seul des
 * deux taux est défini, l'autre compte pour 0. Le coût se configure ainsi une
 * fois par agent, plus par run.
 */
@Injectable()
export class AgentRunsService {
  constructor(private readonly prisma: PrismaService) {}

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
    // Coût : déclaré explicitement, sinon dérivé du profil agent avec des taux
    // distincts entrée/sortie (l'output coûte 3–5× l'input).
    let cost = dto.cost != null ? new Prisma.Decimal(dto.cost) : null;
    const tokensIn = dto.tokensIn ?? 0;
    const tokensOut = dto.tokensOut ?? 0;
    if (cost == null && tokensIn + tokensOut > 0) {
      const profile = await this.prisma.user.findFirst({
        where: { id: actor.userId, organizationId: orgId },
        select: { costRateInPerKTokens: true, costRateOutPerKTokens: true },
      });
      const rateIn = profile?.costRateInPerKTokens != null ? Number(profile.costRateInPerKTokens) : null;
      const rateOut = profile?.costRateOutPerKTokens != null ? Number(profile.costRateOutPerKTokens) : null;
      if (rateIn != null || rateOut != null) {
        const derived = (tokensIn / 1000) * (rateIn ?? 0) + (tokensOut / 1000) * (rateOut ?? 0);
        cost = new Prisma.Decimal(Math.round(derived * 10000) / 10000);
      }
    }
    const run = await this.prisma.agentRun.create({
      data: {
        organizationId: orgId,
        agentId: actor.userId,
        taskId: dto.taskId ?? null,
        projectId,
        deliverableId: dto.deliverableId ?? null,
        model: dto.model ?? null,
        tokensIn: dto.tokensIn ?? null,
        tokensOut: dto.tokensOut ?? null,
        cost,
        note: dto.note?.trim() || null,
      },
    });
    return this.toDto(run);
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
      note: r.note,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
