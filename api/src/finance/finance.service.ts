import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { WorkloadService } from '../workload/workload.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { BillingExportDto } from './dto/billing-export.dto';
import { SetProjectRateDto } from './dto/set-rate.dto';
import { UpdateBudgetDto } from './dto/update-budget.dto';
import { RestampRatesDto } from './dto/restamp-rates.dto';
import { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';

/** Convertit une date ISO YYYY-MM-DD en Date (minuit UTC). */
function toDateOnly(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Convertit un Prisma.Decimal (ou null) en number JS arrondi 2 décimales. */
function dec(v: Prisma.Decimal | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  return Math.round(Number(v) * 100) / 100;
}

/** Arrondi monétaire 2 décimales. */
const r2 = (n: number) => Math.round(n * 100) / 100;
/** Pourcentage borné, null si pas de base. */
const pct = (part: number, whole: number | null): number | null =>
  whole && whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

type RateSource = 'explicit' | 'user_default' | 'default' | 'missing';

/** Bornes de l'expansion d'un coût récurrent (en mois). */
const MAX_RECURRENCE_MONTHS = 60;
/** Fenêtre par défaut quand un coût récurrent n'a ni endDate ni dueDate projet. */
const DEFAULT_RECURRENCE_MONTHS = 12;

/** Nombre de mois entre deux dates (les deux mois extrêmes comptés), ≥ 1. */
function monthsBetween(start: Date, end: Date): number {
  const diff =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  return Math.max(1, diff + 1);
}

/**
 * Montants effectifs d'un coût hors main-d'œuvre, récurrence dépliée :
 *  - ONE_OFF        → amount × quantity (1 période) ;
 *  - MONTHLY/ANNUAL → × nombre de périodes sur [startDate, endDate ?? dueDate].
 * `cost` = coût interne total, `bill` = pass-through client total.
 */
function computeExpenseAmounts(
  exp: {
    amount: Prisma.Decimal;
    billAmount: Prisma.Decimal | null;
    quantity: Prisma.Decimal;
    recurrence: string;
    startDate: Date | null;
    endDate: Date | null;
  },
  project: { dueDate: Date | null },
): { cost: number; bill: number; periods: number } {
  const qty = dec(exp.quantity) ?? 1;
  const unitCost = (dec(exp.amount) ?? 0) * qty;
  const unitBill = (dec(exp.billAmount) ?? 0) * qty;
  if (exp.recurrence === 'ONE_OFF') {
    return { cost: r2(unitCost), bill: r2(unitBill), periods: 1 };
  }
  const start = exp.startDate;
  const end = exp.endDate ?? project.dueDate ?? null;
  let months: number;
  if (!start) months = 1;
  else if (!end) months = DEFAULT_RECURRENCE_MONTHS;
  else months = monthsBetween(start, end);
  months = Math.min(months, MAX_RECURRENCE_MONTHS);
  const periods = exp.recurrence === 'ANNUAL' ? Math.max(1, Math.ceil(months / 12)) : months;
  return { cost: r2(unitCost * periods), bill: r2(unitBill * periods), periods };
}

export type FiscalGranularity = 'quarter' | 'semester' | 'year';

/** Clé mois `YYYY-MM` (UTC) d'une date. */
function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * Résout la fenêtre [from, to) d'une période fiscale. `fyStart` = mois de début
 * d'exercice (1-12). `offset` décale par blocs (0 = courant, −1 = précédent).
 * `from` inclus, `to` exclus (premiers jours de mois UTC). Label humain fourni.
 */
function resolveFiscalPeriod(
  fyStart: number,
  granularity: FiscalGranularity,
  offset: number,
  now: Date,
): { from: string; to: string; label: string } {
  const fyStart0 = fyStart - 1; // 0-11
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let monthsSince = m - fyStart0;
  let fyYear = y;
  if (monthsSince < 0) { monthsSince += 12; fyYear = y - 1; }
  const blockSize = granularity === 'year' ? 12 : granularity === 'semester' ? 6 : 3;
  const blockIndex = Math.floor(monthsSince / blockSize);
  const absIndex = blockIndex + offset;
  const from = new Date(Date.UTC(fyYear, fyStart0, 1));
  from.setUTCMonth(from.getUTCMonth() + absIndex * blockSize);
  const to = new Date(from);
  to.setUTCMonth(to.getUTCMonth() + blockSize);
  // FY de la date `from`
  const fm = from.getUTCMonth();
  let monthsIn = fm - fyStart0;
  let fyOf = from.getUTCFullYear();
  if (monthsIn < 0) { monthsIn += 12; fyOf = fyOf - 1; }
  const fyLabel = fyStart === 1 ? `${fyOf}` : `${fyOf}/${String((fyOf + 1) % 100).padStart(2, '0')}`;
  let label: string;
  if (granularity === 'year') label = `FY ${fyLabel}`;
  else if (granularity === 'semester') label = `S${Math.floor(monthsIn / 6) + 1} · FY ${fyLabel}`;
  else label = `T${Math.floor(monthsIn / 3) + 1} · FY ${fyLabel}`;
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), label };
}

/** Liste des clés mois `YYYY-MM` couvrant [from, to). */
function monthsInWindow(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cur < to) {
    out.push(monthKey(cur));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

/**
 * Contribution mensuelle d'une dépense (engagée) à la fenêtre [from, to).
 * ONE_OFF → tout sur le mois de sa date ; MONTHLY → unité par mois actif ;
 * ANNUAL → annuel / 12 par mois actif. Renvoie une map moisclé → {cost, bill}
 * restreinte aux mois de la fenêtre.
 */
function expenseMonthly(
  exp: {
    amount: Prisma.Decimal;
    billAmount: Prisma.Decimal | null;
    quantity: Prisma.Decimal;
    recurrence: string;
    startDate: Date | null;
    endDate: Date | null;
    createdAt: Date;
  },
  project: { dueDate: Date | null },
  from: Date,
  to: Date,
): Map<string, { cost: number; bill: number }> {
  const out = new Map<string, { cost: number; bill: number }>();
  const qty = dec(exp.quantity) ?? 1;
  const add = (key: string, cost: number, bill: number) => {
    const c = out.get(key) ?? { cost: 0, bill: 0 };
    c.cost += cost; c.bill += bill;
    out.set(key, c);
  };
  const inWindow = (d: Date) => d >= from && d < to;
  if (exp.recurrence === 'ONE_OFF') {
    const date = exp.startDate ?? exp.createdAt;
    if (inWindow(date)) add(monthKey(date), (dec(exp.amount) ?? 0) * qty, (dec(exp.billAmount) ?? 0) * qty);
    return out;
  }
  // récurrent : fenêtre active [start, end ?? dueDate ?? start+DEFAULT]
  const start = exp.startDate;
  if (!start) return out;
  let end = exp.endDate ?? project.dueDate ?? null;
  if (!end) {
    end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + DEFAULT_RECURRENCE_MONTHS);
  }
  const perMonthDiv = exp.recurrence === 'ANNUAL' ? 12 : 1;
  const unitCost = ((dec(exp.amount) ?? 0) * qty) / perMonthDiv;
  const unitBill = ((dec(exp.billAmount) ?? 0) * qty) / perMonthDiv;
  // itère les mois de la fenêtre intersectés avec [start, end]
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const startM = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const endM = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  while (cur < to) {
    if (cur >= startM && cur <= endM) add(monthKey(cur), unitCost, unitBill);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

interface BudgetBucket { key: string; label: string; count: number; budget: number; }
/** Tranches de budget projet (devise org) : <100K / 100–200K / >200K / sans budget. */
function bucketScaffold(): BudgetBucket[] {
  return [
    { key: 'lt100', label: '< 100K', count: 0, budget: 0 },
    { key: 'b100_200', label: '100K – 200K', count: 0, budget: 0 },
    { key: 'gt200', label: '> 200K', count: 0, budget: 0 },
    { key: 'none', label: 'Sans budget', count: 0, budget: 0 },
  ];
}
function bucketFor(buckets: BudgetBucket[], budget: number | null): BudgetBucket {
  if (budget == null || budget <= 0) return buckets[3];
  if (budget < 100_000) return buckets[0];
  if (budget < 200_000) return buckets[1];
  return buckets[2];
}
function serializeBucket(b: BudgetBucket) {
  return { key: b.key, label: b.label, count: b.count, budget: r2(b.budget) };
}

/**
 * Module finance — taux horaires par projet × personne + enveloppe budgétaire.
 * TOUTES les lectures de montants passent par ce service, gardé en amont par
 * `finance:view` (lecture) / `finance:manage` (écriture) dans le contrôleur.
 * Les champs budget du projet sont volontairement `omit` des lectures projet
 * ordinaires (cf. PROJECT_FINANCE_OMIT dans ProjectsService) : ce service est
 * le SEUL point d'exposition des montants.
 */
@Injectable()
export class FinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly workload: WorkloadService,
    private readonly access: ProjectAccessService,
  ) {}

  private async assertProject(orgId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: {
        id: true,
        billable: true,
        budgetAmount: true,
        defaultCostRate: true,
        defaultBillRate: true,
        startDate: true,
        dueDate: true,
      },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
    return p;
  }

  /**
   * Personnes susceptibles de porter un taux sur le projet : membres directs
   * (ProjectMember) ∪ membres des équipes affectées (ProjectTeam → TeamMember)
   * ∪ toute personne ayant déjà un ProjectRate (rétro-compat si retirée d'une
   * équipe). Déduplique par userId.
   */
  private async projectPeople(orgId: string, projectId: string) {
    const PERSON_SELECT = {
      id: true,
      name: true,
      email: true,
      status: true,
      defaultCostRate: true,
      defaultBillRate: true,
    } as const;
    const [direct, teamLinks, existingRates] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { projectId },
        select: { user: { select: PERSON_SELECT } },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId },
        select: { teamId: true },
      }),
      this.prisma.projectRate.findMany({
        where: { projectId },
        select: { user: { select: PERSON_SELECT } },
      }),
    ]);

    type Person = {
      id: string;
      name: string;
      email: string;
      status: string;
      defaultCostRate: Prisma.Decimal | null;
      defaultBillRate: Prisma.Decimal | null;
    };
    const byId = new Map<string, Person>();
    for (const m of direct) byId.set(m.user.id, m.user);
    for (const r of existingRates) byId.set(r.user.id, r.user);

    const teamIds = teamLinks.map((t) => t.teamId);
    if (teamIds.length > 0) {
      const members = await this.prisma.teamMember.findMany({
        where: { teamId: { in: teamIds } },
        select: { user: { select: PERSON_SELECT } },
      });
      for (const m of members) byId.set(m.user.id, m.user);
    }

    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Vue complète taux + budget d'un projet (gardée `finance:view`).
   * Pour chaque personne : taux explicite, sinon défaut projet, sinon manquant.
   */
  async getRates(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);
    const [currency, people, rates] = await Promise.all([
      this.settings.getCurrency(orgId),
      this.projectPeople(orgId, projectId),
      this.prisma.projectRate.findMany({ where: { projectId } }),
    ]);

    const rateByUser = new Map(rates.map((r) => [r.userId, r]));
    const defaultCost = dec(project.defaultCostRate);
    const defaultBill = dec(project.defaultBillRate);

    const members = people.map((u) => {
      const r = rateByUser.get(u.id);
      const explicitCost = r ? dec(r.costRate) : null;
      const explicitBill = r ? dec(r.billRate) : null;
      const userCost = dec(u.defaultCostRate);
      const userBill = dec(u.defaultBillRate);
      const costRate = explicitCost ?? userCost ?? defaultCost;
      const billRate = explicitBill ?? userBill ?? defaultBill;
      const source: RateSource = r
        ? 'explicit'
        : userCost !== null
          ? 'user_default'
          : costRate !== null
            ? 'default'
            : 'missing';
      return {
        userId: u.id,
        name: u.name,
        email: u.email,
        status: u.status,
        costRate,
        billRate,
        hasExplicitRate: !!r,
        source,
      };
    });

    return {
      projectId: project.id,
      currency,
      billable: project.billable,
      budgetAmount: dec(project.budgetAmount),
      defaultCostRate: defaultCost,
      defaultBillRate: defaultBill,
      members,
    };
  }

  /**
   * Résout les taux (coût + facturation) d'une personne sur un projet :
   * `ProjectRate` explicite sinon défauts projet, sinon null. Réutilisé par
   * TimeEntriesService pour **figer** (snapshot) le taux à la création d'une
   * saisie, et par le re-stamp. Léger (2 requêtes ciblées).
   */
  async resolveRate(
    orgId: string,
    projectId: string,
    userId: string,
  ): Promise<{ costRate: number | null; billRate: number | null }> {
    const [rate, project, user] = await Promise.all([
      this.prisma.projectRate.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { costRate: true, billRate: true },
      }),
      this.prisma.project.findFirst({
        where: { id: projectId, organizationId: orgId },
        select: { defaultCostRate: true, defaultBillRate: true },
      }),
      this.prisma.user.findFirst({
        where: { id: userId, organizationId: orgId },
        select: { defaultCostRate: true, defaultBillRate: true },
      }),
    ]);
    const costRate =
      (rate ? dec(rate.costRate) : null) ??
      dec(user?.defaultCostRate) ??
      dec(project?.defaultCostRate);
    const billRate =
      (rate ? dec(rate.billRate) : null) ??
      dec(user?.defaultBillRate) ??
      dec(project?.defaultBillRate);
    return { costRate, billRate };
  }

  /** Upsert du taux explicite d'une personne (gardé `finance:manage`). */
  async setRate(orgId: string, projectId: string, userId: string, dto: SetProjectRateDto) {
    await this.assertProject(orgId, projectId);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable');
    if (dto.billRate != null && dto.billRate < 0)
      throw new BadRequestException('billRate négatif');

    await this.prisma.projectRate.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { costRate: dto.costRate, billRate: dto.billRate ?? null },
      create: {
        organizationId: orgId,
        projectId,
        userId,
        costRate: dto.costRate,
        billRate: dto.billRate ?? null,
      },
    });
    return this.getRates(orgId, projectId);
  }

  /** Supprime le taux explicite (retour au défaut projet). `finance:manage`. */
  async deleteRate(orgId: string, projectId: string, userId: string) {
    await this.assertProject(orgId, projectId);
    await this.prisma.projectRate.deleteMany({ where: { projectId, userId } });
    return this.getRates(orgId, projectId);
  }

  // ============================================================
  // Taux de facturation agents IA (€ / 1K tokens)
  // ============================================================

  /** Arrondi taux kToken (4 décimales — un taux token est petit). */
  private static rate4(v: Prisma.Decimal | null | undefined): number | null {
    if (v === null || v === undefined) return null;
    return Math.round(Number(v) * 10000) / 10000;
  }

  /**
   * Liste des agents IA d'un projet avec taux résolu (€/kToken), consommation
   * réelle (`AgentRun` : runs / tokens / coût) et CA facturé = kTokens × taux.
   * Résolution 3 niveaux (miroir humain) : `AgentProjectRate` explicite >
   * `User.defaultBillRatePerKTokens` > non facturable.
   * `enabled=false` si `Project.agentsEnabled` est off → l'UI n'affiche rien
   * (les agents ne sont pas « approuvés » sur ce projet).
   * Population = agents avec runs ∪ overrides existants ∪ membres agents.
   */
  async getAgentRates(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, agentsEnabled: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    const currency = await this.settings.getCurrency(orgId);
    const empty = {
      projectId,
      enabled: false,
      currency,
      agents: [] as never[],
      totalKTokens: 0,
      totalCost: 0,
      totalBilled: 0,
    };
    if (!project.agentsEnabled) return empty;

    const [runAgg, rateRows, memberAgents] = await Promise.all([
      this.prisma.agentRun.groupBy({
        by: ['agentId'],
        where: { organizationId: orgId, projectId },
        _sum: { cost: true, tokensIn: true, tokensOut: true },
        _count: { _all: true },
      }),
      this.prisma.agentProjectRate.findMany({ where: { projectId } }),
      this.prisma.projectMember.findMany({
        where: { projectId, user: { kind: 'AGENT', deletedAt: null } },
        select: { userId: true },
      }),
    ]);
    const ids = new Set<string>([
      ...runAgg.map((r) => r.agentId),
      ...rateRows.map((r) => r.agentId),
      ...memberAgents.map((m) => m.userId),
    ]);
    if (ids.size === 0) return { ...empty, enabled: true };

    const agents = await this.prisma.user.findMany({
      where: { id: { in: [...ids] }, organizationId: orgId, kind: 'AGENT' },
      select: { id: true, name: true, model: true, defaultBillRatePerKTokens: true },
    });
    const runBy = new Map(runAgg.map((r) => [r.agentId, r]));
    const rateBy = new Map(rateRows.map((r) => [r.agentId, r]));
    const rows = agents
      .map((a) => {
        const run = runBy.get(a.id);
        const explicit = FinanceService.rate4(rateBy.get(a.id)?.billRatePerKTokens ?? null);
        const fallback = FinanceService.rate4(a.defaultBillRatePerKTokens);
        const rate = explicit ?? fallback;
        const tokensIn = run?._sum.tokensIn ?? 0;
        const tokensOut = run?._sum.tokensOut ?? 0;
        const kTokens = r2((tokensIn + tokensOut) / 1000);
        const cost = r2(Number(run?._sum.cost ?? 0));
        return {
          agentId: a.id,
          name: a.name,
          model: a.model,
          billRatePerKTokens: rate,
          source: (explicit != null ? 'project' : fallback != null ? 'agent_default' : null) as
            | 'project'
            | 'agent_default'
            | null,
          hasProjectRate: rateBy.has(a.id),
          runs: run?._count._all ?? 0,
          tokensIn,
          tokensOut,
          kTokens,
          cost,
          billed: rate != null ? r2(kTokens * rate) : null,
        };
      })
      .sort((x, y) => y.kTokens - x.kTokens || x.name.localeCompare(y.name));
    return {
      projectId,
      enabled: true,
      currency,
      agents: rows,
      totalKTokens: r2(rows.reduce((s, r) => s + r.kTokens, 0)),
      totalCost: r2(rows.reduce((s, r) => s + r.cost, 0)),
      totalBilled: r2(rows.reduce((s, r) => s + (r.billed ?? 0), 0)),
    };
  }

  /** Upsert du taux €/kToken d'un agent sur un projet (`finance:manage`). */
  async setAgentRate(
    orgId: string,
    projectId: string,
    agentId: string,
    dto: { billRatePerKTokens: number },
  ) {
    await this.assertProject(orgId, projectId);
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId, kind: 'AGENT', deletedAt: null },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agent introuvable');
    await this.prisma.agentProjectRate.upsert({
      where: { projectId_agentId: { projectId, agentId } },
      update: { billRatePerKTokens: dto.billRatePerKTokens },
      create: {
        organizationId: orgId,
        projectId,
        agentId,
        billRatePerKTokens: dto.billRatePerKTokens,
      },
    });
    return this.getAgentRates(orgId, projectId);
  }

  /** Supprime l'override projet (retour au défaut agent). `finance:manage`. */
  async deleteAgentRate(orgId: string, projectId: string, agentId: string) {
    await this.assertProject(orgId, projectId);
    await this.prisma.agentProjectRate.deleteMany({ where: { projectId, agentId } });
    return this.getAgentRates(orgId, projectId);
  }

  /** MAJ budget + taux par défaut du projet (gardé `finance:manage`). */
  async updateBudget(orgId: string, projectId: string, dto: UpdateBudgetDto) {
    await this.assertProject(orgId, projectId);
    const data: Prisma.ProjectUpdateInput = {};
    if (dto.budgetAmount !== undefined) data.budgetAmount = dto.budgetAmount;
    if (dto.defaultCostRate !== undefined) data.defaultCostRate = dto.defaultCostRate;
    if (dto.defaultBillRate !== undefined) data.defaultBillRate = dto.defaultBillRate;
    if (Object.keys(data).length > 0) {
      await this.prisma.project.update({ where: { id: projectId }, data });
    }
    return this.getRates(orgId, projectId);
  }

  /**
   * Synthèse budgétaire d'un projet (Phase B) — gardée `finance:view`.
   * - **Coût réel** : time entries × costRate résolu (on paie les heures
   *   loggées, facturables ou non).
   * - **Coût prévisionnel** : heures d'allocation *effectives* (schedule +
   *   time-off + fériés, via WorkloadService) × costRate. = coût total planifié.
   * - **CA facturable** : heures *billable* loggées × billRate.
   * - **Marge** = CA facturable − coût réel.
   * Les taux manquants comptent 0 et sont signalés par `membersMissingRate`.
   */
  async getBudgetSummary(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);
    const [currency, rates] = await Promise.all([
      this.settings.getCurrency(orgId),
      this.prisma.projectRate.findMany({ where: { projectId } }),
    ]);
    const rateByUser = new Map(rates.map((r) => [r.userId, r]));
    const defCost = dec(project.defaultCostRate);
    const defBill = dec(project.defaultBillRate);

    const [entries, allocs] = await Promise.all([
      this.prisma.timeEntry.findMany({
        where: { organizationId: orgId, task: { projectId } },
        select: {
          userId: true,
          durationMinutes: true,
          costRateSnapshot: true,
          billRateSnapshot: true,
          user: { select: { name: true } },
        },
      }),
      this.prisma.allocation.findMany({
        where: { organizationId: orgId, projectId },
        select: {
          id: true,
          userId: true,
          startDate: true,
          endDate: true,
          hoursPerDay: true,
          user: { select: { name: true, countryCode: true } },
        },
      }),
    ]);

    // Défauts par user (niveau intermédiaire de résolution : explicite
    // projet > défaut user > défaut projet) — un seul fetch groupé.
    const userIds = [...new Set([...entries.map((e) => e.userId), ...allocs.map((a) => a.userId)])];
    const userDefaults = new Map(
      (
        await this.prisma.user.findMany({
          where: { id: { in: userIds }, organizationId: orgId },
          select: { id: true, defaultCostRate: true, defaultBillRate: true },
        })
      ).map((u) => [u.id, u]),
    );
    const resolveCost = (uid: string): number | null => {
      const r = rateByUser.get(uid);
      return (r ? dec(r.costRate) : null) ?? dec(userDefaults.get(uid)?.defaultCostRate) ?? defCost;
    };
    const resolveBill = (uid: string): number | null => {
      const r = rateByUser.get(uid);
      return (r ? dec(r.billRate) : null) ?? dec(userDefaults.get(uid)?.defaultBillRate) ?? defBill;
    };

    const effMap = await this.workload.computeEffectiveHoursBatch(
      orgId,
      allocs.map((a) => ({
        id: a.id,
        userId: a.userId,
        startDate: a.startDate,
        endDate: a.endDate,
        hoursPerDay: a.hoursPerDay,
        user: { countryCode: a.user.countryCode },
      })),
    );

    interface Row {
      userId: string;
      name: string;
      costRate: number | null;
      billRate: number | null;
      actualHours: number;
      actualCost: number;
      plannedHours: number;
      plannedCost: number;
      billableRevenue: number;
      plannedRevenue: number;
    }
    const byUser = new Map<string, Row>();
    const ensure = (userId: string, name: string): Row => {
      let row = byUser.get(userId);
      if (!row) {
        row = {
          userId,
          name,
          costRate: resolveCost(userId),
          billRate: resolveBill(userId),
          actualHours: 0,
          actualCost: 0,
          plannedHours: 0,
          plannedCost: 0,
          billableRevenue: 0,
          plannedRevenue: 0,
        };
        byUser.set(userId, row);
      }
      return row;
    };

    for (const e of entries) {
      const row = ensure(e.userId, e.user.name);
      const h = e.durationMinutes / 60;
      row.actualHours += h;
      // Hybride : on valorise CHAQUE heure au taux FIGÉ à sa saisie
      // (snapshot) ; à défaut (saisies antérieures au snapshotting) on retombe
      // sur le taux courant résolu. Le passé reste ainsi immuable.
      const cost = dec(e.costRateSnapshot) ?? row.costRate;
      const bill = dec(e.billRateSnapshot) ?? row.billRate;
      if (cost != null) row.actualCost += h * cost;
      // Facturabilité dérivée du projet : toute heure d'un projet `billable`
      // génère du CA (au taux de vente figé sinon courant). Plus de flag par-heure.
      if (project.billable && bill != null) row.billableRevenue += h * bill;
    }
    for (const a of allocs) {
      const eff = effMap.get(a.id)?.effectiveHours ?? 0;
      const row = ensure(a.userId, a.user.name);
      row.plannedHours += eff;
      if (row.costRate != null) row.plannedCost += eff * row.costRate;
      // CA prévisionnel = heures effectives planifiées × taux de vente (live).
      if (project.billable && row.billRate != null) row.plannedRevenue += eff * row.billRate;
    }

    let actualCost = 0;
    let plannedCost = 0;
    let billableRevenue = 0;
    let plannedRevenue = 0;
    let actualHours = 0;
    let plannedHours = 0;
    let membersMissingRate = 0;
    const members = [...byUser.values()].map((row) => {
      actualCost += row.actualCost;
      plannedCost += row.plannedCost;
      billableRevenue += row.billableRevenue;
      plannedRevenue += row.plannedRevenue;
      actualHours += row.actualHours;
      plannedHours += row.plannedHours;
      if (row.costRate == null) membersMissingRate++;
      return {
        userId: row.userId,
        name: row.name,
        costRate: row.costRate,
        billRate: row.billRate,
        actualHours: r2(row.actualHours),
        actualCost: r2(row.actualCost),
        plannedHours: r2(row.plannedHours),
        plannedCost: r2(row.plannedCost),
        billableRevenue: r2(row.billableRevenue),
        plannedRevenue: r2(row.plannedRevenue),
        hasRate: row.costRate != null,
      };
    });
    members.sort((a, b) => b.actualCost - a.actualCost || b.plannedCost - a.plannedCost);

    // ---- Reste à faire (main-d'œuvre) : coût pour terminer le travail restant ----
    // Par tâche non terminée : heures restantes = estimate × (1 − avancement%),
    // valorisées au taux moyen des assignés (sinon taux mélangé / défaut projet).
    const blendedCost = (() => {
      const r = members.map((m) => m.costRate).filter((c): c is number => c != null);
      return r.length ? r.reduce((a, b) => a + b, 0) / r.length : (defCost ?? 0);
    })();
    const openTasks = await this.prisma.task.findMany({
      where: {
        projectId,
        organizationId: orgId,
        deletedAt: null,
        status: { not: TaskStatus.DONE },
      },
      select: {
        estimateHours: true,
        progressPct: true,
        status: true,
        assignees: { select: { userId: true } },
      },
    });
    let remainingLaborCost = 0;
    for (const t of openTasks) {
      if (!t.estimateHours) continue;
      const eff = t.status === TaskStatus.DONE ? 100 : (t.progressPct ?? 0);
      const remH = t.estimateHours * (1 - Math.min(100, Math.max(0, eff)) / 100);
      if (remH <= 0) continue;
      const aRates = t.assignees
        .map((a) => resolveCost(a.userId))
        .filter((c): c is number => c != null);
      const rate = aRates.length ? aRates.reduce((a, b) => a + b, 0) / aRates.length : blendedCost;
      remainingLaborCost += remH * rate;
    }
    remainingLaborCost = r2(remainingLaborCost);

    // ---- Coûts hors main-d'œuvre (licences, matériel, cloud, sous-traitance) ----
    const expenseRows = await this.prisma.projectExpense.findMany({
      where: { projectId, organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    let nonLaborActualCost = 0;
    let nonLaborForecastCost = 0;
    let nonLaborRevenue = 0;
    let nonLaborPlannedRevenue = 0;
    const catMap = new Map<
      string,
      { category: string; actualCost: number; plannedCost: number; billAmount: number }
    >();
    const expenses = expenseRows.map((e) => {
      const dto = this.serializeExpense(e, project);
      const cost = dto.effectiveCost;
      const bill = dto.effectiveBill;
      const incurred = e.status === 'INCURRED';
      if (incurred) {
        nonLaborActualCost += cost;
        if (project.billable) nonLaborRevenue += bill;
      } else {
        nonLaborForecastCost += cost;
        if (project.billable) nonLaborPlannedRevenue += bill;
      }
      const c =
        catMap.get(e.category) ??
        { category: e.category, actualCost: 0, plannedCost: 0, billAmount: 0 };
      if (incurred) {
        c.actualCost += cost;
        if (project.billable) c.billAmount += bill;
      } else {
        c.plannedCost += cost;
      }
      catMap.set(e.category, c);
      return dto;
    });
    const expensesByCategory = [...catMap.values()].map((c) => ({
      category: c.category,
      actualCost: r2(c.actualCost),
      plannedCost: r2(c.plannedCost),
      billAmount: r2(c.billAmount),
    }));

    // Coûts main-d'œuvre seuls (avant intégration des coûts hors M.O.).
    const laborActualCost = r2(actualCost);
    const laborForecastCost = r2(plannedCost);

    // Totaux projet = main-d'œuvre + hors main-d'œuvre.
    actualCost = r2(actualCost + nonLaborActualCost);
    plannedCost = r2(plannedCost + nonLaborForecastCost);
    billableRevenue = r2(billableRevenue + nonLaborRevenue);
    // CA prévisionnel (allocations + dépenses planifiées facturables) et marge
    // prévisionnelle à terminaison = CA prév. − coût prév. (forecastCost).
    plannedRevenue = r2(plannedRevenue + nonLaborPlannedRevenue);
    const budgetAmount = dec(project.budgetAmount);

    // ---- Coût agents (finance agents) : réel (runs déclarés) + prévisionnel
    // (tâches éligibles non terminées × coût moyen/tâche observé) + budget projet. ----
    const [agentSpendAgg, projAgentRow, nonDoneTasks, avgAgentTask] = await Promise.all([
      this.prisma.agentRun.aggregate({
        _sum: { cost: true },
        where: { organizationId: orgId, projectId },
      }),
      this.prisma.project.findUnique({
        where: { id: projectId },
        select: { agentCostBudget: true },
      }),
      this.prisma.task.count({
        where: { organizationId: orgId, projectId, deletedAt: null, status: { not: TaskStatus.DONE } },
      }),
      this.avgAgentCostPerTask(orgId),
    ]);
    const agentCostReal = r2(Number(agentSpendAgg._sum.cost ?? 0));
    const agentCostBudget = dec(projAgentRow?.agentCostBudget ?? null);
    const agentCostForecast = avgAgentTask != null ? r2(nonDoneTasks * avgAgentTask) : null;

    // ---- Intégration P&L des agents (validé 2026-07-07) : le coût agents réel
    // entre dans `actualCost`, son EAC (jamais < réel) dans `forecastCost`, et
    // le CA agents facturé (kTokens × taux résolu) dans `billableRevenue` ET
    // `forecastRevenue` (le réalisé sert de plancher — pas de projection du CA
    // agents futur, pas de base fiable). Les champs `agent*` restent exposés
    // séparément pour la carte dédiée. ----
    const agentBilledReal = await this.agentBilledForProject(orgId, projectId);
    const agentCostEac = Math.max(agentCostReal, agentCostForecast ?? 0);
    actualCost = r2(actualCost + agentCostReal);
    plannedCost = r2(plannedCost + agentCostEac);
    if (project.billable) {
      billableRevenue = r2(billableRevenue + agentBilledReal);
      plannedRevenue = r2(plannedRevenue + agentBilledReal);
    }

    return {
      projectId: project.id,
      currency,
      billable: project.billable,
      budgetAmount,
      actualCost,
      forecastCost: plannedCost,
      billableRevenue: project.billable ? billableRevenue : null,
      margin: project.billable ? r2(billableRevenue - actualCost) : null,
      forecastRevenue: project.billable ? plannedRevenue : null,
      forecastMargin: project.billable ? r2(plannedRevenue - plannedCost) : null,
      actualHours: r2(actualHours),
      plannedHours: r2(plannedHours),
      spentPct: pct(actualCost, budgetAmount),
      forecastPct: pct(plannedCost, budgetAmount),
      remaining: budgetAmount != null ? r2(budgetAmount - actualCost) : null,
      membersMissingRate,
      members,
      // Décomposition main-d'œuvre vs hors main-d'œuvre.
      laborActualCost,
      laborForecastCost,
      nonLaborActualCost: r2(nonLaborActualCost),
      nonLaborForecastCost: r2(nonLaborForecastCost),
      // Reste à faire main-d'œuvre (cost-to-complete sur estimés des tâches).
      remainingLaborCost,
      expensesByCategory,
      expenses,
      // Coût agents IA (finance agents) : réel / prévisionnel / budget projet.
      agentCostReal,
      agentCostForecast,
      agentCostBudget,
      // CA agents facturé (kTokens × taux résolu) — déjà sommé dans
      // billableRevenue/forecastRevenue ci-dessus (projet facturable).
      agentBilledReal,
    };
  }

  /**
   * CA agents facturé d'un projet = Σ par agent (kTokens des runs × taux
   * résolu : `AgentProjectRate` explicite > `User.defaultBillRatePerKTokens`).
   * 0 si aucun run ou aucun taux. Volontairement NON gaté par `agentsEnabled` :
   * des runs historiques restent du CA réel même si les agents ont été coupés
   * depuis. Fenêtrable pour le portefeuille (période fiscale).
   */
  private async agentBilledForProject(
    orgId: string,
    projectId: string,
    window?: { from?: Date; to?: Date },
  ): Promise<number> {
    const createdAt =
      window?.from || window?.to
        ? {
            ...(window.from ? { gte: window.from } : {}),
            ...(window.to ? { lte: window.to } : {}),
          }
        : undefined;
    const runAgg = await this.prisma.agentRun.groupBy({
      by: ['agentId'],
      where: { organizationId: orgId, projectId, ...(createdAt ? { createdAt } : {}) },
      _sum: { tokensIn: true, tokensOut: true },
    });
    if (runAgg.length === 0) return 0;
    const ids = runAgg.map((r) => r.agentId);
    const [rateRows, agents] = await Promise.all([
      this.prisma.agentProjectRate.findMany({
        where: { projectId, agentId: { in: ids } },
        select: { agentId: true, billRatePerKTokens: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: ids }, organizationId: orgId },
        select: { id: true, defaultBillRatePerKTokens: true },
      }),
    ]);
    const explicitBy = new Map(rateRows.map((r) => [r.agentId, Number(r.billRatePerKTokens)]));
    const defaultBy = new Map(
      agents.map((a) => [
        a.id,
        a.defaultBillRatePerKTokens != null ? Number(a.defaultBillRatePerKTokens) : null,
      ]),
    );
    let billed = 0;
    for (const r of runAgg) {
      const rate = explicitBy.get(r.agentId) ?? defaultBy.get(r.agentId) ?? null;
      if (rate == null) continue;
      billed += (((r._sum.tokensIn ?? 0) + (r._sum.tokensOut ?? 0)) / 1000) * rate;
    }
    return r2(billed);
  }

  /**
   * Coût moyen observé par tâche pour les agents (fenêtre glissante 30 j, org-wide) :
   * somme `AgentRun.cost` par tâche distincte, moyennée. `null` si pas de données.
   * Sert le prévisionnel de coût agent d'un projet.
   */
  private async avgAgentCostPerTask(orgId: string): Promise<number | null> {
    const since = new Date();
    since.setDate(since.getDate() - 30);
    const grouped = await this.prisma.agentRun.groupBy({
      by: ['taskId'],
      where: { organizationId: orgId, createdAt: { gte: since }, taskId: { not: null } },
      _sum: { cost: true },
    });
    const perTask = grouped
      .map((g) => Number(g._sum.cost ?? 0))
      .filter((c) => c > 0);
    if (perTask.length === 0) return null;
    return perTask.reduce((a, b) => a + b, 0) / perTask.length;
  }

  /**
   * Synthèse financière **portefeuille** v2 : scopée à une **période fiscale**
   * (trimestre / semestre / exercice) et optionnellement à **un client**.
   * Renvoie le rollup par client + données de graphiques (par équipe, tranches
   * de budget, revenu/projets par client, série mensuelle). Batché. Gardé
   * `finance:view` (rôles org-wide) → pas de filtre d'appartenance.
   *
   * Scoping : coût/CA *datés* (time entries + dépenses engagées) restreints à la
   * fenêtre ; le **budget** est l'enveloppe projet complète (non pro-ratisée).
   * Répartition par équipe = part des **heures loggées** par équipe sur chaque
   * projet (équipes du logger, split égal ; « Sans équipe » sinon).
   */
  async getPortfolioFinance(
    orgId: string,
    opts: { granularity?: FiscalGranularity; offset?: number; clientId?: string } = {},
  ) {
    const granularity: FiscalGranularity =
      opts.granularity === 'semester' || opts.granularity === 'year' ? opts.granularity : 'quarter';
    const offset = Number.isFinite(opts.offset) ? Math.trunc(opts.offset as number) : 0;
    const clientFilter = opts.clientId && opts.clientId.length ? opts.clientId : null;

    const [currency, fyStart] = await Promise.all([
      this.settings.getCurrency(orgId),
      this.settings.getFiscalYearStartMonth(orgId),
    ]);
    const period = resolveFiscalPeriod(fyStart, granularity, offset, new Date());
    const fromDate = new Date(period.from + 'T00:00:00.000Z');
    const toDate = new Date(period.to + 'T00:00:00.000Z');
    const months = monthsInWindow(fromDate, toDate);
    const periodOut = { granularity, offset, from: period.from, to: period.to, label: period.label };

    const projects = await this.prisma.project.findMany({
      where: {
        organizationId: orgId, deletedAt: null, kind: 'STANDARD',
        ...(clientFilter ? { clientId: clientFilter } : {}),
        // Period-scoped: keep only projects that were open or closed during the
        // selected fiscal window [fromDate, toDate). A project must have started
        // before the window ends; and its end bound only excludes projects that
        // are already CLOSED (COMPLETED/ARCHIVED) and finished before the window
        // starts — a still-open project (incl. overdue ACTIVE) is open through
        // the window regardless of its planned due date. Null dates stay in scope.
        AND: [
          { OR: [{ startDate: null }, { startDate: { lt: toDate } }] },
          {
            OR: [
              { status: { notIn: ['COMPLETED', 'ARCHIVED'] } },
              { dueDate: null },
              { dueDate: { gte: fromDate } },
            ],
          },
        ],
      },
      select: {
        id: true, key: true, name: true, billable: true, budgetAmount: true,
        defaultCostRate: true, defaultBillRate: true, dueDate: true,
        status: true, offerRefusalCount: true, offerSentAt: true,
        clientId: true, client: { select: { id: true, name: true, company: true } },
        teams: { select: { teamId: true } },
      },
    });
    const emptyMonthly = months.map((m) => ({ month: m, cost: 0, revenue: 0 }));
    if (projects.length === 0) {
      return {
        currency, fiscalYearStartMonth: fyStart, period: periodOut, clientId: clientFilter,
        clients: [], totals: { projectCount: 0, clientCount: 0, budget: 0, spent: 0, revenue: 0, margin: 0 },
        byTeam: [], budgetBuckets: bucketScaffold().map(serializeBucket),
        revenueByClient: [], projectsByClient: [], revenueByProject: [], monthly: emptyMonthly,
        offerIterations: { avgIterations: null, projects: [] },
        pvVsCost: { total: { pv: 0, cost: 0 }, byTeam: [] },
      };
    }
    const projectIds = projects.map((p) => p.id);
    const projById = new Map(projects.map((p) => [p.id, p]));

    const [projRates, entries, expenseRows, teams, teamMembers] = await Promise.all([
      this.prisma.projectRate.findMany({
        where: { projectId: { in: projectIds } },
        select: { projectId: true, userId: true, costRate: true, billRate: true },
      }),
      this.prisma.timeEntry.findMany({
        where: { organizationId: orgId, task: { projectId: { in: projectIds } }, date: { gte: fromDate, lt: toDate } },
        select: {
          userId: true, durationMinutes: true,
          costRateSnapshot: true, billRateSnapshot: true, date: true,
          task: { select: { projectId: true } },
        },
      }),
      this.prisma.projectExpense.findMany({
        where: { projectId: { in: projectIds }, organizationId: orgId, deletedAt: null, status: 'INCURRED' },
      }),
      this.prisma.team.findMany({ where: { organizationId: orgId }, select: { id: true, name: true } }),
      this.prisma.teamMember.findMany({ where: { team: { organizationId: orgId } }, select: { teamId: true, userId: true } }),
    ]);

    const teamName = new Map(teams.map((t) => [t.id, t.name]));
    const userTeams = new Map<string, string[]>();
    for (const tm of teamMembers) {
      const arr = userTeams.get(tm.userId) ?? [];
      arr.push(tm.teamId);
      userTeams.set(tm.userId, arr);
    }

    const userIds = [...new Set(entries.map((e) => e.userId))];
    const userDefaults = new Map(
      (await this.prisma.user.findMany({
        where: { id: { in: userIds }, organizationId: orgId },
        select: { id: true, defaultCostRate: true, defaultBillRate: true },
      })).map((u) => [u.id, u]),
    );
    const rateKey = (pid: string, uid: string) => pid + '|' + uid;
    const rateByProjUser = new Map(projRates.map((r) => [rateKey(r.projectId, r.userId), r]));

    const NOTEAM = '__noteam__';
    type Acc = { laborCost: number; billable: number; expCost: number; expBill: number; agentCost: number; agentBill: number; teamHours: Map<string, number> };
    const byProject = new Map<string, Acc>();
    const ensure = (pid: string): Acc => {
      let a = byProject.get(pid);
      if (!a) { a = { laborCost: 0, billable: 0, expCost: 0, expBill: 0, agentCost: 0, agentBill: 0, teamHours: new Map() }; byProject.set(pid, a); }
      return a;
    };
    const monthly = new Map(months.map((m) => [m, { cost: 0, revenue: 0 }]));
    const addMonthly = (key: string, cost: number, rev: number) => {
      const c = monthly.get(key);
      if (c) { c.cost += cost; c.revenue += rev; }
    };

    for (const e of entries) {
      const pid = e.task.projectId;
      const proj = projById.get(pid);
      if (!proj) continue;
      const r = rateByProjUser.get(rateKey(pid, e.userId));
      const cost = dec(e.costRateSnapshot) ?? (r ? dec(r.costRate) : null) ?? dec(userDefaults.get(e.userId)?.defaultCostRate) ?? dec(proj.defaultCostRate);
      const bill = dec(e.billRateSnapshot) ?? (r ? dec(r.billRate) : null) ?? dec(userDefaults.get(e.userId)?.defaultBillRate) ?? dec(proj.defaultBillRate);
      const h = e.durationMinutes / 60;
      const cCost = cost != null ? h * cost : 0;
      const cBill = bill != null && proj.billable ? h * bill : 0;
      const acc = ensure(pid);
      acc.laborCost += cCost;
      acc.billable += cBill;
      const tids = userTeams.get(e.userId) ?? [];
      if (tids.length === 0) acc.teamHours.set(NOTEAM, (acc.teamHours.get(NOTEAM) ?? 0) + h);
      else { const share = h / tids.length; for (const tid of tids) acc.teamHours.set(tid, (acc.teamHours.get(tid) ?? 0) + share); }
      addMonthly(monthKey(e.date), cCost, cBill);
    }
    for (const ex of expenseRows) {
      const proj = projById.get(ex.projectId);
      if (!proj) continue;
      const mm = expenseMonthly(ex, proj, fromDate, toDate);
      let totCost = 0, totBill = 0;
      for (const [mk, v] of mm) {
        const billPart = proj.billable ? v.bill : 0;
        totCost += v.cost; totBill += billPart;
        addMonthly(mk, v.cost, billPart);
      }
      if (totCost || totBill) { const acc = ensure(ex.projectId); acc.expCost += totCost; acc.expBill += totBill; }
    }

    // ---- Agents IA : coût déclaré + CA facturé (kTokens × taux résolu :
    // override projet > défaut agent), fenêtrés comme les time entries.
    // Intégrés au spent/revenue de chaque projet — cohérent avec le P&L
    // projet (getBudgetSummary) — et à la série mensuelle. ----
    const agentRuns = await this.prisma.agentRun.findMany({
      where: {
        organizationId: orgId,
        projectId: { in: projectIds },
        createdAt: { gte: fromDate, lt: toDate },
      },
      select: { projectId: true, agentId: true, cost: true, tokensIn: true, tokensOut: true, createdAt: true },
    });
    if (agentRuns.length > 0) {
      const agentIds = [...new Set(agentRuns.map((r) => r.agentId))];
      const runPids = [...new Set(agentRuns.map((r) => r.projectId).filter(Boolean))] as string[];
      const [agentRates, agentDefaults] = await Promise.all([
        this.prisma.agentProjectRate.findMany({
          where: { projectId: { in: runPids }, agentId: { in: agentIds } },
          select: { projectId: true, agentId: true, billRatePerKTokens: true },
        }),
        this.prisma.user.findMany({
          where: { id: { in: agentIds }, organizationId: orgId },
          select: { id: true, defaultBillRatePerKTokens: true },
        }),
      ]);
      const explicitBy = new Map(agentRates.map((r) => [rateKey(r.projectId, r.agentId), Number(r.billRatePerKTokens)]));
      const defaultBy = new Map(
        agentDefaults.map((a) => [a.id, a.defaultBillRatePerKTokens != null ? Number(a.defaultBillRatePerKTokens) : null]),
      );
      for (const r of agentRuns) {
        if (!r.projectId) continue;
        const proj = projById.get(r.projectId);
        if (!proj) continue;
        const cost = Number(r.cost ?? 0);
        const rate = explicitBy.get(rateKey(r.projectId, r.agentId)) ?? defaultBy.get(r.agentId) ?? null;
        const bill =
          proj.billable && rate != null
            ? (((r.tokensIn ?? 0) + (r.tokensOut ?? 0)) / 1000) * rate
            : 0;
        if (!cost && !bill) continue;
        const acc = ensure(r.projectId);
        acc.agentCost += cost;
        acc.agentBill += bill;
        addMonthly(monthKey(r.createdAt), cost, bill);
      }
    }

    // Rollups par client + par équipe.
    type ProjRow = { id: string; key: string; name: string; budget: number | null; spent: number; revenue: number; margin: number };
    type ClientGroup = { clientId: string | null; clientName: string; company: string | null; budget: number; spent: number; revenue: number; margin: number; agentCost: number; agentBilled: number; projects: ProjRow[] };
    const groups = new Map<string, ClientGroup>();
    const NO_CLIENT = '__none__';
    const teamAgg = new Map<string, { teamId: string | null; teamName: string; projectCount: number; spent: number; revenue: number; margin: number }>();
    const ensureTeam = (tid: string) => {
      let t = teamAgg.get(tid);
      if (!t) { t = { teamId: tid === NOTEAM ? null : tid, teamName: tid === NOTEAM ? 'Sans équipe' : (teamName.get(tid) ?? 'Équipe ?'), projectCount: 0, spent: 0, revenue: 0, margin: 0 }; teamAgg.set(tid, t); }
      return t;
    };
    const projRevRows: Array<{ id: string; key: string; name: string; revenue: number }> = [];
    const buckets = bucketScaffold();

    for (const p of projects) {
      const acc = byProject.get(p.id);
      const spent = r2((acc?.laborCost ?? 0) + (acc?.expCost ?? 0) + (acc?.agentCost ?? 0));
      const revenue = r2((acc?.billable ?? 0) + (acc?.expBill ?? 0) + (acc?.agentBill ?? 0));
      const margin = r2(revenue - spent);
      const budget = dec(p.budgetAmount);
      // client rollup
      const gid = p.clientId ?? NO_CLIENT;
      let g = groups.get(gid);
      if (!g) {
        g = { clientId: p.clientId ?? null, clientName: p.client?.name ?? 'Internes / sans client', company: p.client?.company ?? null, budget: 0, spent: 0, revenue: 0, margin: 0, agentCost: 0, agentBilled: 0, projects: [] };
        groups.set(gid, g);
      }
      g.budget += budget ?? 0; g.spent += spent; g.revenue += revenue; g.margin += margin;
      g.agentCost += acc?.agentCost ?? 0; g.agentBilled += acc?.agentBill ?? 0;
      g.projects.push({ id: p.id, key: p.key, name: p.name, budget, spent, revenue, margin });
      projRevRows.push({ id: p.id, key: p.key, name: p.name, revenue });
      // budget bucket (par enveloppe complète)
      bucketFor(buckets, budget).count += 1;
      bucketFor(buckets, budget).budget += budget ?? 0;
      // Team split: by share of hours logged in the window when there are any.
      // When a project has NO logged hours this period (e.g. an open project
      // idle this quarter), fall back to its ASSIGNED teams (split equally)
      // rather than dumping it into "no team". Only a project with no team at
      // all lands in NOTEAM.
      const th = acc?.teamHours ?? new Map<string, number>();
      let totalH = 0; for (const v of th.values()) totalH += v;
      if (totalH <= 0) {
        const assigned = p.teams.map((t) => t.teamId);
        if (assigned.length === 0) {
          const t = ensureTeam(NOTEAM);
          t.spent += spent; t.revenue += revenue; t.margin += margin;
          if (spent || revenue || (budget ?? 0)) t.projectCount += 1;
        } else {
          const share = 1 / assigned.length;
          for (const tid of assigned) {
            const t = ensureTeam(tid);
            t.spent += spent * share; t.revenue += revenue * share; t.margin += margin * share;
            t.projectCount += 1;
          }
        }
      } else {
        for (const [tid, hrs] of th) {
          const share = hrs / totalH;
          const t = ensureTeam(tid);
          t.spent += spent * share; t.revenue += revenue * share; t.margin += margin * share;
          t.projectCount += 1;
        }
      }
    }

    const clients = [...groups.values()]
      .map((g) => ({
        clientId: g.clientId, clientName: g.clientName, company: g.company,
        projectCount: g.projects.length,
        budget: r2(g.budget), spent: r2(g.spent), revenue: r2(g.revenue), margin: r2(g.margin),
        marginPct: g.revenue > 0 ? Math.round((g.margin / g.revenue) * 1000) / 10 : null,
        // Part agents IA du client (déjà incluse dans spent/revenue).
        agentCost: r2(g.agentCost), agentBilled: r2(g.agentBilled),
        projects: g.projects.sort((a, b) => b.spent - a.spent),
      }))
      .sort((a, b) => b.spent - a.spent);

    const totals = {
      projectCount: projects.length,
      clientCount: clients.filter((c) => c.clientId != null).length,
      budget: r2(clients.reduce((s, c) => s + c.budget, 0)),
      spent: r2(clients.reduce((s, c) => s + c.spent, 0)),
      revenue: r2(clients.reduce((s, c) => s + c.revenue, 0)),
      margin: r2(clients.reduce((s, c) => s + c.margin, 0)),
      // Part agents IA (déjà incluse dans spent/revenue).
      agentCost: r2(clients.reduce((s, c) => s + c.agentCost, 0)),
      agentBilled: r2(clients.reduce((s, c) => s + c.agentBilled, 0)),
    };
    const byTeam = [...teamAgg.values()]
      .map((t) => ({ teamId: t.teamId, teamName: t.teamName, projectCount: t.projectCount, spent: r2(t.spent), revenue: r2(t.revenue), margin: r2(t.margin) }))
      .sort((a, b) => b.spent - a.spent);

    // ===== Itérations d'offre/budget (offerRefusalCount + 1) =====
    // Projets facturables ayant (eu) une offre : status ≠ DRAFT ou déjà envoyée.
    const offerRows = projects
      .filter((p) => p.billable && (p.offerSentAt != null || p.status !== 'DRAFT'))
      .map((p) => ({
        id: p.id, key: p.key, name: p.name,
        iterations: (p.offerRefusalCount ?? 0) + 1,
        refusals: p.offerRefusalCount ?? 0,
        status: p.status as string,
      }))
      .sort((a, b) => b.iterations - a.iterations);
    const avgIterations = offerRows.length
      ? Math.round((offerRows.reduce((s, r) => s + r.iterations, 0) / offerRows.length) * 10) / 10
      : null;

    // ===== Valeur planifiée (estimés × taux) vs coût réel, global + par équipe =====
    const taskRows = await this.prisma.task.findMany({
      where: { organizationId: orgId, projectId: { in: projectIds }, deletedAt: null, estimateHours: { not: null } },
      select: { projectId: true, estimateHours: true, assignees: { select: { userId: true } } },
    });
    // Défauts coût pour les assignés pas déjà chargés (loggers ≠ assignés).
    const newAssignees = [...new Set(taskRows.flatMap((t) => t.assignees.map((a) => a.userId)))].filter((id) => !userDefaults.has(id));
    if (newAssignees.length) {
      for (const u of await this.prisma.user.findMany({
        where: { id: { in: newAssignees }, organizationId: orgId },
        select: { id: true, defaultCostRate: true, defaultBillRate: true },
      })) userDefaults.set(u.id, u);
    }
    const costRateFor = (pid: string, uid: string): number => {
      const r = rateByProjUser.get(rateKey(pid, uid));
      return (r ? dec(r.costRate) : null) ?? dec(userDefaults.get(uid)?.defaultCostRate) ?? dec(projById.get(pid)?.defaultCostRate) ?? 0;
    };
    const pvByTeam = new Map<string, number>();
    let pvTotal = 0;
    for (const t of taskRows) {
      const est = t.estimateHours ?? 0;
      if (est <= 0 || t.assignees.length === 0) continue;
      const perH = est / t.assignees.length;
      for (const a of t.assignees) {
        const val = perH * costRateFor(t.projectId, a.userId);
        if (val <= 0) continue;
        pvTotal += val;
        // Attribute to the assignee's teams; if they have none, fall back to
        // the project's assigned teams (rather than "no team").
        const tids = userTeams.get(a.userId) ?? [];
        const teamsForVal = tids.length ? tids : (projById.get(t.projectId)?.teams.map((x) => x.teamId) ?? []);
        if (teamsForVal.length === 0) pvByTeam.set(NOTEAM, (pvByTeam.get(NOTEAM) ?? 0) + val);
        else { const share = val / teamsForVal.length; for (const tid of teamsForVal) pvByTeam.set(tid, (pvByTeam.get(tid) ?? 0) + share); }
      }
    }
    // Coût réel par équipe = laborCost projet réparti par part d'heures loggées ;
    // fallback sur les équipes assignées au projet si aucune heure dans la fenêtre.
    const costByTeam = new Map<string, number>();
    let costTotal = 0;
    for (const [pid, acc] of byProject) {
      costTotal += acc.laborCost;
      let totalH = 0; for (const v of acc.teamHours.values()) totalH += v;
      if (totalH <= 0) {
        const assigned = projById.get(pid)?.teams.map((x) => x.teamId) ?? [];
        if (assigned.length === 0) costByTeam.set(NOTEAM, (costByTeam.get(NOTEAM) ?? 0) + acc.laborCost);
        else { const share = acc.laborCost / assigned.length; for (const tid of assigned) costByTeam.set(tid, (costByTeam.get(tid) ?? 0) + share); }
      } else for (const [tid, hrs] of acc.teamHours) costByTeam.set(tid, (costByTeam.get(tid) ?? 0) + acc.laborCost * (hrs / totalH));
    }
    const pvCostTeamKeys = new Set([...pvByTeam.keys(), ...costByTeam.keys()]);
    const pvVsCostByTeam = [...pvCostTeamKeys]
      .map((tid) => ({
        teamId: tid === NOTEAM ? null : tid,
        teamName: tid === NOTEAM ? 'Sans équipe' : (teamName.get(tid) ?? 'Équipe ?'),
        pv: r2(pvByTeam.get(tid) ?? 0),
        cost: r2(costByTeam.get(tid) ?? 0),
      }))
      .sort((a, b) => (b.pv + b.cost) - (a.pv + a.cost));

    return {
      currency, fiscalYearStartMonth: fyStart, period: periodOut, clientId: clientFilter,
      clients, totals, byTeam,
      budgetBuckets: buckets.map(serializeBucket),
      revenueByClient: clients.map((c) => ({ clientId: c.clientId, clientName: c.clientName, revenue: c.revenue })),
      projectsByClient: clients.map((c) => ({ clientId: c.clientId, clientName: c.clientName, count: c.projectCount })),
      revenueByProject: projRevRows.sort((a, b) => b.revenue - a.revenue),
      monthly: months.map((m) => { const v = monthly.get(m)!; return { month: m, cost: r2(v.cost), revenue: r2(v.revenue) }; }),
      offerIterations: { avgIterations, projects: offerRows },
      pvVsCost: { total: { pv: r2(pvTotal), cost: r2(costTotal) }, byTeam: pvVsCostByTeam },
    };
  }

  /**
   * Earned Value Management (EVM) d'un projet. Gardé `finance:view`.
   * - **AC** (Actual Cost) : coût réel cumulé (M.O. loggée × taux figé +
   *   dépenses engagées), par mois.
   * - **PV** (Planned Value) : courbe linéaire `budget × avancement temporel`
   *   sur [startDate, dueDate].
   * - **EV** (Earned Value) : `budget × % d'avancement` (pondéré par estimés).
   * - **CPI** = EV/AC, **SPI** = EV/PV, **écart budgétaire** = PV(now) − AC.
   */
  async getProjectEvm(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);
    const [currency, rates, tasks, entries, expenseRows] = await Promise.all([
      this.settings.getCurrency(orgId),
      this.prisma.projectRate.findMany({ where: { projectId }, select: { userId: true, costRate: true } }),
      this.prisma.task.findMany({
        where: { projectId, organizationId: orgId, deletedAt: null },
        select: { status: true, estimateHours: true, progressPct: true },
      }),
      this.prisma.timeEntry.findMany({
        where: { organizationId: orgId, task: { projectId } },
        select: { userId: true, durationMinutes: true, costRateSnapshot: true, date: true },
      }),
      this.prisma.projectExpense.findMany({
        where: { projectId, organizationId: orgId, deletedAt: null, status: 'INCURRED' },
      }),
    ]);
    const userDefaults = await this.loadUserDefaults(orgId, entries);
    return this.buildEvmResult(project, { rates, tasks, entries, expenseRows }, userDefaults, currency);
  }

  /**
   * EVM de plusieurs projets en **~6 requêtes batchées** (au lieu de ~6×N).
   * Même moteur de calcul que `getProjectEvm` (helper pur `buildEvmResult`) →
   * aucun risque de divergence single/batch. Utilisé par le KPI portefeuille.
   */
  async getProjectEvmBatch(orgId: string, projectIds: string[]) {
    const out = new Map<string, ReturnType<typeof this.buildEvmResult>>();
    if (!projectIds.length) return out;
    const ids = { in: projectIds };
    const [currency, projects, rates, tasks, entries, expenseRows] = await Promise.all([
      this.settings.getCurrency(orgId),
      this.prisma.project.findMany({
        where: { id: ids, organizationId: orgId, deletedAt: null },
        select: { id: true, budgetAmount: true, defaultCostRate: true, startDate: true, dueDate: true },
      }),
      this.prisma.projectRate.findMany({
        where: { projectId: ids },
        select: { projectId: true, userId: true, costRate: true },
      }),
      this.prisma.task.findMany({
        where: { projectId: ids, organizationId: orgId, deletedAt: null },
        select: { projectId: true, status: true, estimateHours: true, progressPct: true },
      }),
      this.prisma.timeEntry.findMany({
        where: { organizationId: orgId, task: { projectId: ids } },
        select: {
          userId: true, durationMinutes: true, costRateSnapshot: true, date: true,
          task: { select: { projectId: true } },
        },
      }),
      this.prisma.projectExpense.findMany({
        where: { projectId: ids, organizationId: orgId, deletedAt: null, status: 'INCURRED' },
      }),
    ]);
    const userDefaults = await this.loadUserDefaults(orgId, entries);
    const by = <T>(rows: T[], key: (r: T) => string) => {
      const m = new Map<string, T[]>();
      for (const r of rows) {
        const k = key(r);
        const bucket = m.get(k);
        if (bucket) bucket.push(r);
        else m.set(k, [r]);
      }
      return m;
    };
    const ratesBy = by(rates, (r) => r.projectId);
    const tasksBy = by(tasks, (t) => t.projectId);
    const entriesBy = by(entries, (e) => e.task.projectId);
    const expBy = by(expenseRows, (x) => x.projectId);
    for (const p of projects) {
      out.set(
        p.id,
        this.buildEvmResult(
          p,
          {
            rates: ratesBy.get(p.id) ?? [],
            tasks: tasksBy.get(p.id) ?? [],
            entries: entriesBy.get(p.id) ?? [],
            expenseRows: expBy.get(p.id) ?? [],
          },
          userDefaults,
          currency,
        ),
      );
    }
    return out;
  }

  /** Charge les `defaultCostRate` des users apparaissant dans `entries` (1 requête). */
  private async loadUserDefaults(
    orgId: string,
    entries: Array<{ userId: string }>,
  ): Promise<Map<string, { defaultCostRate: Prisma.Decimal | null }>> {
    const userIds = [...new Set(entries.map((e) => e.userId))];
    if (!userIds.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: userIds }, organizationId: orgId },
      select: { id: true, defaultCostRate: true },
    });
    return new Map(rows.map((u) => [u.id, u]));
  }

  /**
   * Calcul EVM **pur** (aucune requête) — cœur partagé single/batch. Reçoit les
   * données déjà chargées et renvoie exactement le même objet qu'auparavant.
   */
  private buildEvmResult(
    project: {
      id: string;
      budgetAmount: Prisma.Decimal | null;
      defaultCostRate: Prisma.Decimal | null;
      startDate: Date | null;
      dueDate: Date | null;
    },
    data: {
      rates: Array<{ userId: string; costRate: Prisma.Decimal | null }>;
      tasks: Array<{ status: TaskStatus; estimateHours: number | null; progressPct: number | null }>;
      entries: Array<{ userId: string; durationMinutes: number; costRateSnapshot: Prisma.Decimal | null; date: Date }>;
      expenseRows: Array<{
        amount: Prisma.Decimal; billAmount: Prisma.Decimal | null; quantity: Prisma.Decimal;
        recurrence: string; startDate: Date | null; endDate: Date | null; createdAt: Date;
      }>;
    },
    userDefaults: Map<string, { defaultCostRate: Prisma.Decimal | null }>,
    currency: string,
  ) {
    const { rates, tasks, entries, expenseRows } = data;
    const budget = dec(project.budgetAmount) ?? 0;

    // % d'avancement (pondéré estimés, fallback done/total).
    let estSum = 0, estProg = 0, total = 0, done = 0;
    for (const t of tasks) {
      total++;
      if (t.status === TaskStatus.DONE) done++;
      if (t.estimateHours) {
        estSum += t.estimateHours;
        const p = t.status === TaskStatus.DONE ? 100 : Math.min(100, Math.max(0, t.progressPct ?? 0));
        estProg += t.estimateHours * (p / 100);
      }
    }
    const percentComplete = estSum > 0 ? estProg / estSum : total > 0 ? done / total : 0;
    const ev = r2(budget * percentComplete);

    // Résolution coût par user (snapshot > ProjectRate > défaut user > défaut projet).
    const rateByUser = new Map(rates.map((r) => [r.userId, r]));
    const defCost = dec(project.defaultCostRate);
    const resolveCost = (uid: string): number | null =>
      (rateByUser.get(uid) ? dec(rateByUser.get(uid)!.costRate) : null) ??
      dec(userDefaults.get(uid)?.defaultCostRate) ?? defCost;

    // Fenêtre mensuelle : [min(start, 1re saisie) … max(today, due)].
    const now = new Date();
    const entryDates = entries.map((e) => e.date.getTime());
    const earliest = project.startDate ?? (entryDates.length ? new Date(Math.min(...entryDates)) : now);
    const latest = project.dueDate && project.dueDate.getTime() > now.getTime() ? project.dueDate : now;
    const fromDate = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
    const toDate = new Date(Date.UTC(latest.getUTCFullYear(), latest.getUTCMonth() + 1, 1));
    const months = monthsInWindow(fromDate, toDate);

    // AC mensuel (M.O. + dépenses engagées).
    const acByMonth = new Map(months.map((m) => [m, 0]));
    for (const e of entries) {
      const cost = dec(e.costRateSnapshot) ?? resolveCost(e.userId);
      if (cost == null) continue;
      const k = monthKey(e.date);
      if (acByMonth.has(k)) acByMonth.set(k, acByMonth.get(k)! + (e.durationMinutes / 60) * cost);
    }
    for (const ex of expenseRows) {
      const mm = expenseMonthly(ex, project, fromDate, toDate);
      for (const [k, v] of mm) if (acByMonth.has(k)) acByMonth.set(k, acByMonth.get(k)! + v.cost);
    }

    // PV (courbe linéaire) + cumuls.
    const hasDates = !!(project.startDate && project.dueDate && project.dueDate > project.startDate);
    const startMs = project.startDate?.getTime() ?? 0;
    const dueMs = project.dueDate?.getTime() ?? 0;
    const pvFrac = (atMs: number) => (hasDates ? Math.min(1, Math.max(0, (atMs - startMs) / (dueMs - startMs))) : null);
    let acCum = 0;
    const monthly = months.map((m) => {
      acCum += acByMonth.get(m)!;
      const [yy, mm] = m.split('-').map(Number);
      const monthEnd = new Date(Date.UTC(yy, mm, 0)).getTime(); // dernier jour du mois
      const frac = pvFrac(monthEnd);
      return { month: m, ac: r2(acCum), pv: frac == null ? null : r2(budget * frac) };
    });

    const ac = r2(acCum);
    const pvNowFrac = pvFrac(now.getTime());
    const pvNow = pvNowFrac == null ? null : r2(budget * pvNowFrac);
    const cpi = ac > 0 ? Math.round((ev / ac) * 1000) / 1000 : null;
    const spi = pvNow && pvNow > 0 ? Math.round((ev / pvNow) * 1000) / 1000 : null;

    return {
      projectId: project.id, currency, budget, hasDates,
      percentComplete: Math.round(percentComplete * 1000) / 10, // %
      pv: pvNow, ev, ac,
      cpi, spi,
      budgetVariance: pvNow == null ? null : r2(pvNow - ac),
      costVariance: r2(ev - ac),
      monthly,
    };
  }

  // ============================================================
  // Coûts hors main-d'œuvre (licences, matériel, cloud, sous-traitance)
  // ============================================================

  /** Sérialise une ligne de coût + ses montants effectifs (récurrence dépliée). */
  private serializeExpense(
    e: {
      id: string;
      category: string;
      label: string;
      description: string | null;
      amount: Prisma.Decimal;
      billAmount: Prisma.Decimal | null;
      quantity: Prisma.Decimal;
      status: string;
      recurrence: string;
      startDate: Date | null;
      endDate: Date | null;
    },
    project: { dueDate: Date | null },
  ) {
    const { cost, bill, periods } = computeExpenseAmounts(e, project);
    return {
      id: e.id,
      category: e.category,
      label: e.label,
      description: e.description,
      amount: dec(e.amount),
      billAmount: dec(e.billAmount),
      quantity: dec(e.quantity) ?? 1,
      status: e.status,
      recurrence: e.recurrence,
      startDate: e.startDate ? e.startDate.toISOString() : null,
      endDate: e.endDate ? e.endDate.toISOString() : null,
      effectiveCost: cost,
      effectiveBill: bill,
      periods,
    };
  }

  /** Valide la cohérence récurrence ↔ dates (un coût récurrent exige startDate). */
  private assertRecurrence(
    recurrence: string | undefined,
    startDate: string | null | undefined,
  ) {
    if (recurrence && recurrence !== 'ONE_OFF' && !startDate) {
      throw new BadRequestException(
        'Un coût récurrent (mensuel / annuel) exige une date de début (startDate).',
      );
    }
  }

  async listExpenses(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);
    const rows = await this.prisma.projectExpense.findMany({
      where: { projectId, organizationId: orgId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.serializeExpense(r, project));
  }

  async createExpense(
    orgId: string,
    projectId: string,
    userId: string,
    dto: CreateExpenseDto,
  ) {
    const project = await this.assertProject(orgId, projectId);
    this.assertRecurrence(dto.recurrence, dto.startDate);
    const row = await this.prisma.projectExpense.create({
      data: {
        organizationId: orgId,
        projectId,
        category: dto.category,
        label: dto.label,
        description: dto.description ?? null,
        amount: dto.amount,
        billAmount: dto.billAmount ?? null,
        quantity: dto.quantity ?? 1,
        status: dto.status ?? 'INCURRED',
        recurrence: dto.recurrence ?? 'ONE_OFF',
        startDate: dto.startDate ? toDateOnly(dto.startDate) : null,
        endDate: dto.endDate ? toDateOnly(dto.endDate) : null,
        createdById: userId,
      },
    });
    return this.serializeExpense(row, project);
  }

  async updateExpense(
    orgId: string,
    projectId: string,
    expenseId: string,
    dto: UpdateExpenseDto,
  ) {
    const project = await this.assertProject(orgId, projectId);
    const existing = await this.prisma.projectExpense.findFirst({
      where: { id: expenseId, projectId, organizationId: orgId, deletedAt: null },
    });
    if (!existing) throw new NotFoundException('Coût introuvable');
    // Récurrence effective après patch (pour la validation croisée des dates).
    const effRecurrence = dto.recurrence ?? existing.recurrence;
    const effStart =
      dto.startDate !== undefined
        ? dto.startDate
        : existing.startDate
          ? existing.startDate.toISOString().slice(0, 10)
          : undefined;
    this.assertRecurrence(effRecurrence, effStart);

    const data: Prisma.ProjectExpenseUpdateInput = {};
    if (dto.category !== undefined) data.category = dto.category;
    if (dto.label !== undefined) data.label = dto.label;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.amount !== undefined) data.amount = dto.amount;
    if (dto.billAmount !== undefined) data.billAmount = dto.billAmount;
    if (dto.quantity !== undefined) data.quantity = dto.quantity;
    if (dto.status !== undefined) data.status = dto.status;
    if (dto.recurrence !== undefined) data.recurrence = dto.recurrence;
    if (dto.startDate !== undefined)
      data.startDate = dto.startDate ? toDateOnly(dto.startDate) : null;
    if (dto.endDate !== undefined)
      data.endDate = dto.endDate ? toDateOnly(dto.endDate) : null;

    const row = await this.prisma.projectExpense.update({
      where: { id: expenseId },
      data,
    });
    return this.serializeExpense(row, project);
  }

  async deleteExpense(orgId: string, projectId: string, expenseId: string) {
    await this.assertProject(orgId, projectId);
    const existing = await this.prisma.projectExpense.findFirst({
      where: { id: expenseId, projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Coût introuvable');
    await this.prisma.projectExpense.update({
      where: { id: expenseId },
      data: { deletedAt: new Date() },
    });
    return { id: expenseId, deleted: true };
  }

  /**
   * Re-fige les snapshots de taux des time entries d'un projet aux **taux
   * courants** (correction d'erreur de taux, ou back-fill des saisies sans
   * snapshot avec `onlyMissing`). Gardé `finance:manage`.
   * Efficace : un `updateMany` par personne (taux résolu une fois chacun).
   */
  async restampRates(orgId: string, projectId: string, dto: RestampRatesDto) {
    await this.assertProject(orgId, projectId);
    // TimeEntry n'a pas de projectId scalaire → on passe par les tâches.
    const tasks = await this.prisma.task.findMany({
      where: { projectId, organizationId: orgId },
      select: { id: true },
    });
    const taskIds = tasks.map((t) => t.id);
    if (taskIds.length === 0) return { updated: 0 };

    const where: Prisma.TimeEntryWhereInput = {
      organizationId: orgId,
      taskId: { in: taskIds },
    };
    if (dto.from || dto.to) {
      where.date = {};
      if (dto.from) (where.date as Prisma.DateTimeFilter).gte = toDateOnly(dto.from);
      if (dto.to) (where.date as Prisma.DateTimeFilter).lte = toDateOnly(dto.to);
    }
    if (dto.onlyMissing) where.costRateSnapshot = null;

    const grouped = await this.prisma.timeEntry.groupBy({
      by: ['userId'],
      where,
    });

    let updated = 0;
    for (const g of grouped) {
      const r = await this.resolveRate(orgId, projectId, g.userId);
      const res = await this.prisma.timeEntry.updateMany({
        where: { ...where, userId: g.userId },
        data: { costRateSnapshot: r.costRate, billRateSnapshot: r.billRate },
      });
      updated += res.count;
    }
    return { updated };
  }

  // ============================================================
  // Export facturation — timesheet ligne à ligne (portfolio manager)
  // ============================================================
  /**
   * Export **ligne à ligne** des saisies de temps pour la facturation : une
   * ligne par `TimeEntry`, avec projet, **ticket externe** (Jira/ServiceNow) et
   * valorisation (taux figé sinon résolu live × heures facturables). Distinct
   * des reports : c'est le **seul** export qui n'exclut PAS les projets
   * `kind=EXTERNAL` (le temps sur ticket est facturable).
   *
   * Franchit volontairement l'invariant « timesheet strictement personnelle » →
   * réservé aux rôles org-wide (`finance:view`). Fail-safe : self-scoping par
   * `accessibleProjectScope` (un appelant sans lecture élevée ne verrait que ses
   * heures + projets accessibles). Fenêtre plafonnée à 366 j. Tracé en audit
   * par le contrôleur (`billing.exported`).
   */
  async billingExport(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    dto: BillingExportDto,
  ) {
    const from = toDateOnly(dto.from);
    const to = toDateOnly(dto.to);
    if (to < from) throw new BadRequestException('to < from');
    const spanDays = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (spanDays > 366) throw new BadRequestException('Fenêtre > 366 jours');
    const billableOnly = dto.billableOnly === 'true' || dto.billableOnly === '1';
    const MAX_ROWS = 200_000;

    const where: Prisma.TimeEntryWhereInput = {
      organizationId: orgId,
      date: { gte: from, lte: to },
    };
    // Filtres projet/client/facturable — PAS de filtre `kind` (externe inclus).
    const projectWhere: Prisma.ProjectWhereInput = { deletedAt: null };
    if (dto.clientId) projectWhere.clientId = dto.clientId;
    if (billableOnly) projectWhere.billable = true;
    const taskWhere: Prisma.TaskWhereInput = { project: projectWhere };
    if (dto.projectId) taskWhere.projectId = dto.projectId;
    where.task = taskWhere;

    // Self-scoping fail-safe (PM org-wide ⇒ scope null ⇒ aucune restriction).
    const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);
    if (scope !== null) {
      where.AND = [{ OR: [{ userId: requester.userId }, { task: { projectId: { in: scope } } }] }];
    }

    const [currency, entries] = await Promise.all([
      this.settings.getCurrency(orgId),
      this.prisma.timeEntry.findMany({
        where,
        orderBy: [{ date: 'asc' }],
        take: MAX_ROWS + 1,
        select: {
          date: true,
          durationMinutes: true,
          overtimeMinutes: true,
          description: true,
          billRateSnapshot: true,
          userId: true,
          user: { select: { name: true, email: true } },
          task: {
            select: {
              title: true,
              externalSource: true,
              externalKey: true,
              externalUrl: true,
              projectId: true,
              project: {
                select: {
                  key: true, name: true, billable: true, kind: true,
                  defaultBillRate: true,
                  client: { select: { name: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const truncated = entries.length > MAX_ROWS;
    const rows = truncated ? entries.slice(0, MAX_ROWS) : entries;

    // Résolution du taux de vente pour les saisies SANS snapshot (rares) :
    // ProjectRate explicite > défaut user > défaut projet. Maps groupées.
    const projectIds = [...new Set(rows.map((e) => e.task.projectId))];
    const userIds = [...new Set(rows.map((e) => e.userId))];
    const [projectRates, userDefaults] = await Promise.all([
      this.prisma.projectRate.findMany({
        where: { projectId: { in: projectIds }, userId: { in: userIds } },
        select: { projectId: true, userId: true, billRate: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: userIds }, organizationId: orgId },
        select: { id: true, defaultBillRate: true },
      }),
    ]);
    const rateByPair = new Map(projectRates.map((r) => [`${r.projectId}:${r.userId}`, dec(r.billRate)]));
    const userDefBill = new Map(userDefaults.map((u) => [u.id, dec(u.defaultBillRate)]));
    const resolveBill = (projectId: string, userId: string, projectDefault: number | null): number | null =>
      rateByPair.get(`${projectId}:${userId}`) ?? userDefBill.get(userId) ?? projectDefault;

    const iso = (d: Date) => d.toISOString().slice(0, 10);
    let totalAmount = 0;
    let linesMissingRate = 0;
    type SumRow = { clientName: string; projectKey: string; projectName: string; userName: string; billableHours: number; amount: number };
    const summary = new Map<string, SumRow>();

    const detail = rows.map((e) => {
      const p = e.task.project;
      const hours = Math.round((e.durationMinutes / 60) * 100) / 100;
      const overtimeHours = Math.round((e.overtimeMinutes / 60) * 100) / 100;
      const rate = dec(e.billRateSnapshot) ?? resolveBill(e.task.projectId, e.userId, dec(p.defaultBillRate));
      const billable = p.billable;
      const amount = billable && rate != null ? r2((e.durationMinutes / 60) * rate) : 0;
      if (billable && rate == null) linesMissingRate++;
      totalAmount += amount;

      const clientName = p.client?.name ?? '';
      if (billable) {
        const k = `${p.key}|${e.userId}`;
        const s = summary.get(k) ?? { clientName, projectKey: p.key, projectName: p.name, userName: e.user.name, billableHours: 0, amount: 0 };
        s.billableHours = Math.round((s.billableHours + e.durationMinutes / 60) * 100) / 100;
        s.amount = r2(s.amount + amount);
        summary.set(k, s);
      }

      return {
        date: iso(e.date),
        userName: e.user.name,
        userEmail: e.user.email,
        projectKey: p.key,
        projectName: p.name,
        clientName,
        kind: p.kind as 'STANDARD' | 'EXTERNAL',
        taskTitle: e.task.title,
        externalSource: e.task.externalSource ?? '',
        externalKey: e.task.externalKey ?? '',
        externalUrl: e.task.externalUrl ?? '',
        hours,
        overtimeHours,
        billable,
        billRate: rate,
        amount,
        note: e.description ?? '',
      };
    });

    return {
      currency,
      rows: detail,
      summary: [...summary.values()].sort((a, b) => b.amount - a.amount),
      meta: {
        from: dto.from,
        to: dto.to,
        totalRows: detail.length,
        truncated,
        linesMissingRate,
        totalAmount: r2(totalAmount),
      },
    };
  }
}

export type BillingExportResult = Awaited<ReturnType<FinanceService['billingExport']>>;
