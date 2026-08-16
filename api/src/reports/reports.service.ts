import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, TaskStatus } from '@db';
import { billingUnitForProvider, type AgentBillingUnit } from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { CapacityService } from '../workload/capacity.service';
import { WorkloadService } from '../workload/workload.service';
import { FinanceService } from '../finance/finance.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { CacheService } from '../common/cache.service';
import { S3Service } from '../storage/s3.service';
import { blankStatusCounts } from '../common/task-status.util';
import { BurndownDto, TimeBreakdownDto } from './dto/reports.dto';
import type { StatusDeckModel } from './status-deck';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
    private readonly capacity: CapacityService,
    private readonly workload: WorkloadService,
    private readonly finance: FinanceService,
    private readonly settings: AdminSettingsService,
    private readonly cache: CacheService,
    private readonly s3: S3Service,
  ) {}

  // ============================================================
  // Snapshot d'avancement d'un projet
  // ============================================================
  async projectStats(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);

    const tasks = await this.prisma.task.findMany({
      where: { projectId: project.id, organizationId: orgId, deletedAt: null },
      select: {
        status: true,
        estimateHours: true,
        dueDate: true,
      },
    });

    const counts: Record<TaskStatus, number> = blankStatusCounts();
    let totalEstimateH = 0;
    let doneEstimateH = 0;
    let overdue = 0;
    const now = new Date();
    for (const t of tasks) {
      counts[t.status]++;
      if (t.estimateHours) {
        totalEstimateH += t.estimateHours;
        if (t.status === TaskStatus.DONE) doneEstimateH += t.estimateHours;
      }
      if (
        t.dueDate &&
        t.status !== TaskStatus.DONE &&
        t.dueDate.getTime() < now.getTime()
      ) {
        overdue++;
      }
    }

    const spentAgg = await this.prisma.timeEntry.aggregate({
      where: { organizationId: orgId, task: { projectId: project.id } },
      _sum: { durationMinutes: true },
    });

    const total = tasks.length;
    const completionPct = total === 0 ? 0 : Math.round((counts.DONE / total) * 100);

    return {
      projectId: project.id,
      projectKey: project.key,
      projectName: project.name,
      startDate: project.startDate ? project.startDate.toISOString().slice(0, 10) : null,
      dueDate: project.dueDate ? project.dueDate.toISOString().slice(0, 10) : null,
      totalTasks: total,
      byStatus: counts,
      completionPct,
      overdueTasks: overdue,
      totalEstimateHours: round(totalEstimateH),
      doneEstimateHours: round(doneEstimateH),
      remainingEstimateHours: round(Math.max(0, totalEstimateH - doneEstimateH)),
      totalSpentMinutes: spentAgg._sum.durationMinutes ?? 0,
    };
  }

  // ============================================================
  // Burndown : courbe idéale + courbe réelle (heures restantes)
  // ============================================================
  async burndown(orgId: string, projectId: string, dto: BurndownDto) {
    const project = await this.assertProject(orgId, projectId);
    const start = toDateOnly(dto.from);
    const end = toDateOnly(dto.to);
    if (start.getTime() > end.getTime()) {
      throw new NotFoundException("'from' doit précéder 'to'");
    }

    // ----- Fenêtre de référence (calcul de l'idéal) -----
    // L'idéal se calcule sur la **durée totale du projet** quand on a les dates,
    // pour que zoomer sur 7 / 30j ne soit qu'un zoom sur la même droite idéale.
    // Sinon (projet sans dates), on retombe sur la fenêtre demandée.
    const refStart = project.startDate ? toDateOnly(project.startDate.toISOString()) : start;
    const refEnd = project.dueDate ? toDateOnly(project.dueDate.toISOString()) : end;
    const refDays = Math.max(1, daysBetween(refStart, refEnd));

    // Périmètre du burndown = somme des estimations de toutes les tâches
    // existantes à la fin de la fenêtre demandée (pas la référence).
    const tasks = await this.prisma.task.findMany({
      where: {
        projectId,
        organizationId: orgId,
        deletedAt: null,
        createdAt: { lte: addDays(end, 1) },
      },
      select: { estimateHours: true, status: true, updatedAt: true, createdAt: true },
    });
    const totalScopeH = tasks.reduce((s, t) => s + (t.estimateHours ?? 0), 0);
    const idealStep = totalScopeH / refDays;

    /** Idéal à la date `d` selon la droite référence (clamp 0..totalScopeH). */
    const idealAt = (d: Date): number => {
      const i = daysBetween(refStart, d);
      const v = totalScopeH - idealStep * i;
      return Math.max(0, Math.min(totalScopeH, v));
    };

    const days = daysBetween(start, end);
    const points: Array<{
      date: string;
      idealRemainingHours: number;
      actualRemainingHours: number;
      doneTasks: number;
    }> = [];

    for (let i = 0; i <= days; i++) {
      const d = addDays(start, i);
      const dEnd = addDays(d, 1);
      // Approximation : on considère qu'une tâche est terminée si
      // status=DONE et updatedAt <= dEnd. (Faute d'historique de statut,
      // c'est la meilleure approximation sans audit_log — voir SPEC §5.2.)
      let doneH = 0;
      let doneCount = 0;
      for (const t of tasks) {
        if (t.createdAt.getTime() >= dEnd.getTime()) continue; // pas encore née ce jour-là
        if (t.status === TaskStatus.DONE && t.updatedAt.getTime() < dEnd.getTime()) {
          doneH += t.estimateHours ?? 0;
          doneCount++;
        }
      }
      points.push({
        date: d.toISOString().slice(0, 10),
        idealRemainingHours: round(idealAt(d)),
        actualRemainingHours: round(Math.max(0, totalScopeH - doneH)),
        doneTasks: doneCount,
      });
    }

    return {
      projectId,
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      referenceFrom: refStart.toISOString().slice(0, 10),
      referenceTo: refEnd.toISOString().slice(0, 10),
      totalScopeHours: round(totalScopeH),
      points,
    };
  }

  // ============================================================
  // Respect des échéances : à temps / en retard / sans deadline
  // ============================================================
  async dueAdherence(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    const tasks = await this.prisma.task.findMany({
      where: { projectId, organizationId: orgId, deletedAt: null, status: TaskStatus.DONE },
      select: { id: true, dueDate: true, updatedAt: true },
    });
    // Date de complétion réelle = 1ère transition vers DONE dans l'historique
    // de statut (plus précis que `updatedAt`, qui bouge à chaque édition). On
    // retombe sur `updatedAt` pour les tâches sans historique (legacy).
    const doneAt = await this.firstDoneAt(orgId, projectId, tasks.map((t) => t.id));
    let onTime = 0;
    let late = 0;
    let noDeadline = 0;
    for (const t of tasks) {
      if (!t.dueDate) {
        noDeadline++;
      } else {
        const completed = doneAt.get(t.id) ?? t.updatedAt;
        if (completed.getTime() <= t.dueDate.getTime()) onTime++;
        else late++;
      }
    }
    const withDeadline = onTime + late;
    return {
      projectId,
      totalCompleted: tasks.length,
      onTime,
      late,
      noDeadline,
      onTimePct: tasks.length ? Math.round((onTime / tasks.length) * 100) : 0,
      onTimeCompletionPct: withDeadline ? Math.round((onTime / withDeadline) * 100) : null,
    };
  }

  /** Map taskId → date de 1ère entrée `toStatus=DONE` dans l'historique. */
  private async firstDoneAt(orgId: string, projectId: string, taskIds: string[]): Promise<Map<string, Date>> {
    const out = new Map<string, Date>();
    if (!taskIds.length) return out;
    const hist = await this.prisma.taskStatusHistory.findMany({
      where: { projectId, organizationId: orgId, taskId: { in: taskIds }, toStatus: TaskStatus.DONE },
      orderBy: { changedAt: 'asc' },
      select: { taskId: true, changedAt: true },
    });
    for (const h of hist) if (!out.has(h.taskId)) out.set(h.taskId, h.changedAt);
    return out;
  }

  // ============================================================
  // Reporting non financier agents IA (par projet, fenêtré)
  // ============================================================
  /**
   * KPIs agents d'un projet sur [from, to] (ISO, bornes incluses) :
   * - **throughput** : tâches passées à DONE par un agent (`TaskStatusHistory.
   *   changedById` ∈ agents), dédupliquées par tâche, + série hebdo ;
   * - **first-pass / re-travail** : sur les CHAÎNES de livrables agent
   *   (`supersedesId`/`version`) approuvées dans la fenêtre — % approuvées dès
   *   la v1, rounds moyens (= version finale, 1 = zéro re-travail) ;
   * - **délai de revue** : moyenne soumission → revue (toutes versions revues) ;
   * - **activité** : runs / tokens (`AgentRun`) + rollup par agent.
   * `enabled=false` si `Project.agentsEnabled` est off (agents non approuvés
   * sur ce projet) → l'UI n'affiche aucun bloc agent.
   */
  async agentsReport(orgId: string, projectId: string, q: { from?: string; to?: string }) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, agentsEnabled: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');

    const today = new Date().toISOString().slice(0, 10);
    const toIso = q.to ?? today;
    const fromIso =
      q.from ?? new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
    const fromD = new Date(`${fromIso}T00:00:00.000Z`);
    const toD = new Date(`${toIso}T23:59:59.999Z`);

    const base = {
      projectId,
      enabled: project.agentsEnabled,
      from: fromIso,
      to: toIso,
      tasksCompleted: 0,
      weekly: [] as { weekStart: string; count: number }[],
      approvedDeliverables: 0,
      firstPassApprovalPct: null as number | null,
      avgReviewRounds: null as number | null,
      avgReviewTurnaroundHours: null as number | null,
      activeAgents: 0,
      runs: 0,
      tokensIn: 0,
      tokensOut: 0,
      perAgent: [] as {
        agentId: string;
        name: string;
        billingUnit: AgentBillingUnit;
        tasksCompleted: number;
        deliverables: number;
        approved: number;
        firstPassPct: number | null;
        avgRounds: number | null;
        runs: number;
        tokens: number;
      }[],
    };
    if (!project.agentsEnabled) return base;

    // Agents de l'org (deletedAt inclus : l'historique d'un agent retiré reste
    // attribué). kind est indexé (organizationId, kind).
    const agents = await this.prisma.user.findMany({
      where: { organizationId: orgId, kind: 'AGENT' },
      select: { id: true, name: true, modelProvider: true },
    });
    if (agents.length === 0) return base;
    const agentIds = agents.map((a) => a.id);
    const nameOf = new Map(agents.map((a) => [a.id, a.name]));
    const providerOf = new Map(agents.map((a) => [a.id, a.modelProvider]));

    const [doneEvents, delivs, runAgg] = await Promise.all([
      this.prisma.taskStatusHistory.findMany({
        where: {
          organizationId: orgId,
          projectId,
          toStatus: TaskStatus.DONE,
          changedById: { in: agentIds },
          changedAt: { gte: fromD, lte: toD },
        },
        orderBy: { changedAt: 'asc' },
        select: { taskId: true, changedAt: true, changedById: true },
      }),
      this.prisma.deliverable.findMany({
        where: {
          organizationId: orgId,
          authorId: { in: agentIds },
          deletedAt: null,
          task: { projectId },
        },
        select: {
          id: true,
          authorId: true,
          version: true,
          supersedesId: true,
          reviewStatus: true,
          reviewedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.agentRun.groupBy({
        by: ['agentId'],
        where: {
          organizationId: orgId,
          projectId,
          createdAt: { gte: fromD, lte: toD },
        },
        _sum: { tokensIn: true, tokensOut: true },
        _count: { _all: true },
      }),
    ]);

    // ---- Throughput : 1 tâche = 1 complétion (garde le 1er passage à DONE). ----
    const seenTask = new Set<string>();
    const completions: typeof doneEvents = [];
    for (const e of doneEvents) {
      if (seenTask.has(e.taskId)) continue;
      seenTask.add(e.taskId);
      completions.push(e);
    }
    // Série hebdo : lundi ISO → count, zéros comblés sur toute la fenêtre.
    const mondayOf = (d: Date): string => {
      const shift = (d.getUTCDay() + 6) % 7; // 0 = lundi
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - shift));
      return m.toISOString().slice(0, 10);
    };
    const weekly = new Map<string, number>();
    for (let w = new Date(`${mondayOf(fromD)}T00:00:00.000Z`); w <= toD; w = new Date(w.getTime() + 7 * 86_400_000)) {
      weekly.set(w.toISOString().slice(0, 10), 0);
    }
    for (const c of completions) {
      const k = mondayOf(c.changedAt);
      weekly.set(k, (weekly.get(k) ?? 0) + 1);
    }

    // ---- Chaînes de livrables : final = non remplacé par une version suivante. ----
    const superseded = new Set(delivs.map((d) => d.supersedesId).filter(Boolean) as string[]);
    const finals = delivs.filter((d) => !superseded.has(d.id));
    const inWindow = (d: Date | null) => d != null && d >= fromD && d <= toD;
    const submittedFinals = finals.filter((d) => inWindow(d.createdAt));
    const approvedFinals = finals.filter(
      (d) => d.reviewStatus === 'APPROVED' && inWindow(d.reviewedAt),
    );
    const firstPass = approvedFinals.filter((d) => d.version === 1).length;
    // Délai de revue : toutes les versions revues dans la fenêtre (approve OU
    // changes-requested — c'est la réactivité du reviewer qu'on mesure).
    const reviewed = delivs.filter((d) => inWindow(d.reviewedAt));
    const turnaroundH =
      reviewed.length > 0
        ? reviewed.reduce(
            (s, d) => s + (d.reviewedAt!.getTime() - d.createdAt.getTime()) / 3_600_000,
            0,
          ) / reviewed.length
        : null;

    // ---- Rollup par agent. ----
    const per = new Map<
      string,
      { tasksCompleted: number; deliverables: number; approvedV: number[]; runs: number; tokens: number }
    >();
    const slot = (id: string) => {
      let s = per.get(id);
      if (!s) {
        s = { tasksCompleted: 0, deliverables: 0, approvedV: [], runs: 0, tokens: 0 };
        per.set(id, s);
      }
      return s;
    };
    for (const c of completions) if (c.changedById) slot(c.changedById).tasksCompleted++;
    for (const d of submittedFinals) slot(d.authorId).deliverables++;
    for (const d of approvedFinals) slot(d.authorId).approvedV.push(d.version);
    for (const r of runAgg) {
      const s = slot(r.agentId);
      s.runs = r._count._all;
      s.tokens = (r._sum.tokensIn ?? 0) + (r._sum.tokensOut ?? 0);
    }

    const r1 = (n: number) => Math.round(n * 10) / 10;
    const perAgent = [...per.entries()]
      .map(([agentId, s]) => ({
        agentId,
        name: nameOf.get(agentId) ?? agentId,
        billingUnit: billingUnitForProvider(providerOf.get(agentId)),
        tasksCompleted: s.tasksCompleted,
        deliverables: s.deliverables,
        approved: s.approvedV.length,
        firstPassPct: s.approvedV.length
          ? Math.round((s.approvedV.filter((v) => v === 1).length / s.approvedV.length) * 100)
          : null,
        avgRounds: s.approvedV.length
          ? r1(s.approvedV.reduce((a, b) => a + b, 0) / s.approvedV.length)
          : null,
        runs: s.runs,
        tokens: s.tokens,
      }))
      .sort((a, b) => b.tasksCompleted - a.tasksCompleted || a.name.localeCompare(b.name));

    return {
      ...base,
      tasksCompleted: completions.length,
      weekly: [...weekly.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([weekStart, count]) => ({ weekStart, count })),
      approvedDeliverables: approvedFinals.length,
      firstPassApprovalPct: approvedFinals.length
        ? Math.round((firstPass / approvedFinals.length) * 100)
        : null,
      avgReviewRounds: approvedFinals.length
        ? r1(approvedFinals.reduce((s, d) => s + d.version, 0) / approvedFinals.length)
        : null,
      avgReviewTurnaroundHours: turnaroundH != null ? r1(turnaroundH) : null,
      activeAgents: per.size,
      runs: runAgg.reduce((s, r) => s + r._count._all, 0),
      tokensIn: runAgg.reduce((s, r) => s + (r._sum.tokensIn ?? 0), 0),
      tokensOut: runAgg.reduce((s, r) => s + (r._sum.tokensOut ?? 0), 0),
      perAgent,
    };
  }

  // ============================================================
  // Répartition heures / tâches d'un projet par équipe (assignés → équipe)
  // ============================================================
  async projectByTeam(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    const tasks = await this.prisma.task.findMany({
      where: { projectId, organizationId: orgId, deletedAt: null },
      select: { estimateHours: true, assignees: { select: { userId: true } } },
    });
    const userIds = [...new Set(tasks.flatMap((t) => t.assignees.map((a) => a.userId)))];

    const memberships = userIds.length
      ? await this.prisma.teamMember.findMany({
          where: { userId: { in: userIds }, team: { organizationId: orgId, deletedAt: null } },
          select: { userId: true, teamId: true, team: { select: { name: true, color: true } } },
        })
      : [];
    const userTeams = new Map<string, Array<{ teamId: string; name: string; color: string | null }>>();
    for (const m of memberships) {
      const arr = userTeams.get(m.userId) ?? [];
      arr.push({ teamId: m.teamId, name: m.team.name, color: m.team.color });
      userTeams.set(m.userId, arr);
    }

    const NOTEAM = '__noteam__';
    type Bucket = { teamId: string | null; teamName: string; color: string | null; hours: number; count: number };
    const buckets = new Map<string, Bucket>();
    const ensure = (key: string, name: string, color: string | null): Bucket => {
      let b = buckets.get(key);
      if (!b) { b = { teamId: key === NOTEAM ? null : key, teamName: name, color, hours: 0, count: 0 }; buckets.set(key, b); }
      return b;
    };

    for (const t of tasks) {
      const assignees = t.assignees;
      if (assignees.length === 0) continue; // tâche non assignée → hors répartition
      const estPer = (t.estimateHours ?? 0) / assignees.length;
      const taskPer = 1 / assignees.length;
      for (const a of assignees) {
        const teams = userTeams.get(a.userId) ?? [];
        if (teams.length === 0) {
          const b = ensure(NOTEAM, 'Sans équipe', null);
          b.hours += estPer; b.count += taskPer;
        } else {
          const hShare = estPer / teams.length;
          const cShare = taskPer / teams.length;
          for (const tm of teams) {
            const b = ensure(tm.teamId, tm.name, tm.color);
            b.hours += hShare; b.count += cShare;
          }
        }
      }
    }

    const all = [...buckets.values()];
    return {
      projectId,
      hoursByTeam: all
        .map((b) => ({ teamId: b.teamId, teamName: b.teamName, color: b.color, hours: round(b.hours) }))
        .filter((b) => b.hours > 0)
        .sort((a, b) => b.hours - a.hours),
      tasksByTeam: all
        .map((b) => ({ teamId: b.teamId, teamName: b.teamName, color: b.color, count: round(b.count) }))
        .filter((b) => b.count > 0)
        .sort((a, b) => b.count - a.count),
    };
  }

  // ============================================================
  // Time breakdown transverse : totaux par projet × user × label
  // ============================================================
  async timeBreakdown(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: TimeBreakdownDto,
  ) {
    // Le temps loggé sur les tickets externes (projets `kind=EXTERNAL`) est
    // exclu de TOUS les reports : il ne vit que dans la timesheet personnelle.
    const where: Prisma.TimeEntryWhereInput = {
      organizationId: orgId,
      task: { project: { kind: 'STANDARD' } },
    };
    if (q.projectId) where.task = { projectId: q.projectId, project: { kind: 'STANDARD' } };
    if (q.userId) where.userId = q.userId === 'me' ? requester.userId : q.userId;
    if (q.from || q.to) {
      where.date = {};
      if (q.from) (where.date as Prisma.DateTimeFilter).gte = toDateOnly(q.from);
      if (q.to) (where.date as Prisma.DateTimeFilter).lte = toDateOnly(q.to);
    }

    // Scoping transverse : sans droit de lecture élevé, l'appelant ne voit que
    // ses propres heures + celles des projets accessibles (sinon fuite du
    // breakdown cross-user/cross-projet de toute l'org à un simple membre).
    const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);
    if (scope !== null) {
      (where.AND ??= [] as Prisma.TimeEntryWhereInput[]);
      (where.AND as Prisma.TimeEntryWhereInput[]).push({
        OR: [{ userId: requester.userId }, { task: { projectId: { in: scope } } }],
      });
    }

    const entries = await this.prisma.timeEntry.findMany({
      where,
      select: {
        durationMinutes: true,
        userId: true,
        user: { select: { name: true, email: true } },
        task: {
          select: {
            projectId: true,
            project: { select: { key: true, name: true, billable: true } },
            labels: { select: { label: { select: { id: true, name: true } } } },
          },
        },
      },
    });

    let total = 0;
    let billable = 0;
    const byProject = new Map<string, { projectId: string; key: string; name: string; minutes: number; billable: number }>();
    const byUser = new Map<string, { userId: string; name: string; email: string; minutes: number; billable: number }>();
    const byLabel = new Map<string, { labelId: string; name: string; minutes: number }>();

    for (const e of entries) {
      // Facturabilité dérivée du projet : une heure compte comme facturable
      // ssi son projet est `billable` (plus de flag par-heure).
      const isBillable = e.task.project.billable;
      total += e.durationMinutes;
      if (isBillable) billable += e.durationMinutes;

      const projId = e.task.projectId;
      const p = byProject.get(projId) ?? {
        projectId: projId,
        key: e.task.project.key,
        name: e.task.project.name,
        minutes: 0,
        billable: 0,
      };
      p.minutes += e.durationMinutes;
      if (isBillable) p.billable += e.durationMinutes;
      byProject.set(projId, p);

      const u = byUser.get(e.userId) ?? {
        userId: e.userId,
        name: e.user.name,
        email: e.user.email,
        minutes: 0,
        billable: 0,
      };
      u.minutes += e.durationMinutes;
      if (isBillable) u.billable += e.durationMinutes;
      byUser.set(e.userId, u);

      for (const tl of e.task.labels) {
        const l = byLabel.get(tl.label.id) ?? {
          labelId: tl.label.id,
          name: tl.label.name,
          minutes: 0,
        };
        l.minutes += e.durationMinutes;
        byLabel.set(tl.label.id, l);
      }
    }

    const sortByMin = <T extends { minutes: number }>(arr: T[]) =>
      arr.sort((a, b) => b.minutes - a.minutes);

    return {
      totalMinutes: total,
      billableMinutes: billable,
      nonBillableMinutes: total - billable,
      byProject: sortByMin([...byProject.values()]),
      byUser: sortByMin([...byUser.values()]),
      byLabel: sortByMin([...byLabel.values()]),
    };
  }

  // ============================================================
  // Tâches dont la fenêtre [startDate, dueDate] intersecte [from, to]
  // ============================================================
  async tasksInWindow(orgId: string, projectId: string, dto: BurndownDto) {
    await this.assertProject(orgId, projectId);
    const wFrom = toDateOnly(dto.from);
    const wTo = toDateOnly(dto.to);
    // Une tâche est "dans la fenêtre" si son intervalle [start, due] (en
    // tolérant les nulls) chevauche [from, to]. Si seule l'une des bornes
    // existe, on prend cette borne comme point unique.
    const tasks = await this.prisma.task.findMany({
      where: {
        projectId,
        organizationId: orgId,
        deletedAt: null,
        OR: [
          // bornes complètes : intersection d'intervalles
          { AND: [{ startDate: { lte: wTo } }, { dueDate: { gte: wFrom } }] },
          // que startDate
          { AND: [{ dueDate: null }, { startDate: { gte: wFrom, lte: wTo } }] },
          // que dueDate
          { AND: [{ startDate: null }, { dueDate: { gte: wFrom, lte: wTo } }] },
        ],
      },
      select: {
        id: true,
        title: true,
        status: true,
        startDate: true,
        dueDate: true,
        estimateHours: true,
        progressPct: true,
        assignees: {
          select: {
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
      orderBy: [{ dueDate: 'asc' }, { startDate: 'asc' }],
    });

    const now = new Date();
    return {
      projectId,
      from: wFrom.toISOString().slice(0, 10),
      to: wTo.toISOString().slice(0, 10),
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        startDate: t.startDate ? t.startDate.toISOString().slice(0, 10) : null,
        dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
        estimateHours: t.estimateHours,
        progressPct: t.progressPct,
        overdue:
          !!t.dueDate &&
          t.status !== TaskStatus.DONE &&
          t.dueDate.getTime() < now.getTime(),
        assignees: t.assignees.map((a) => ({
          id: a.user.id,
          name: a.user.name,
          email: a.user.email,
        })),
      })),
    };
  }

  // ============================================================
  // Statut projet composite — agrège en UN aller-retour ce que 4 endpoints
  // séparés (stats + due-adherence + tasks-in-window + workload) rendraient
  // en 4. Pensé pour un tool MCP unique (`vaks_project_status`) : côté
  // Copilot Studio, la facturation est au TOOL appelé, pas à l'appel API
  // interne — un composite coûte 1 action au lieu de 4-5.
  // ============================================================
  async projectStatus(
    orgId: string,
    projectId: string,
    requester: { userId: string; isAdmin: boolean },
    opts: { from?: string; to?: string } = {},
  ) {
    // Défaut serveur : une semaine de recul + un mois à venir, pour ne pas
    // exiger de dates côté appelant (agent ou humain via Copilot).
    const today = startOfToday();
    const from = opts.from ?? addDays(today, -7).toISOString().slice(0, 10);
    const to = opts.to ?? addDays(today, 30).toISOString().slice(0, 10);
    if (toDateOnly(to).getTime() < toDateOnly(from).getTime()) {
      throw new BadRequestException("'from' doit précéder 'to'");
    }
    const window = { from, to } as BurndownDto;

    const [stats, dueAdherence, tasksInWindow, workload] = await Promise.all([
      this.projectStats(orgId, projectId),
      this.dueAdherence(orgId, projectId),
      this.tasksInWindow(orgId, projectId, window),
      // Requester {userId, isAdmin} propagé : un non-admin ne doit voir que
      // le workload de ses propres équipes (self-scope, cf. workloadGrid).
      this.workload.workloadGrid(orgId, requester, { from, to, projectId }),
    ]);

    return { projectId, from, to, stats, dueAdherence, tasksInWindow, workload };
  }

  // ============================================================
  // Point de statut client (deck PPTX) — modèle de contenu
  // ============================================================
  /**
   * Agrège le contenu du POINT DE STATUT destiné au client. Volontairement
   * dépouillé : statut éditorial, avancement, jalons, prochaines étapes, risques.
   * **Exclut** temps passé, agents IA, skill gap, coûts internes — c'est un
   * livrable client, pas un rapport d'ops (≠ `report.pdf`).
   */
  async statusDeckModel(
    orgId: string,
    projectId: string,
    opts: { preparedById: string; preparedByFallback: string; lang: string },
  ): Promise<StatusDeckModel> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null, kind: 'STANDARD' },
      select: {
        key: true,
        name: true,
        startDate: true,
        dueDate: true,
        statusHealth: true,
        statusSummary: true,
        client: { select: { name: true, company: true } },
      },
    });
    if (!project) throw new NotFoundException('Projet introuvable');

    const tasks = await this.prisma.task.findMany({
      where: { projectId, organizationId: orgId, deletedAt: null },
      select: {
        title: true,
        status: true,
        dueDate: true,
        isMilestone: true,
        assignees: { select: { user: { select: { name: true } } } },
      },
      orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }],
    });

    const now = new Date();
    const isDone = (s: TaskStatus) => s === TaskStatus.DONE;
    const isOverdue = (t: { dueDate: Date | null; status: TaskStatus }) =>
      !!t.dueDate && !isDone(t.status) && t.dueDate.getTime() < now.getTime();
    const fmt = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '');

    const total = tasks.length;
    const done = tasks.filter((t) => isDone(t.status)).length;
    const overdueTasks = tasks.filter((t) => !t.isMilestone && isOverdue(t));

    const milestones = tasks.filter((t) => t.isMilestone);
    const milestonesDone = milestones
      .filter((t) => isDone(t.status))
      .map((t) => ({ name: t.title, date: fmt(t.dueDate) }));
    const milestonesAtRisk = milestones
      .filter((t) => isOverdue(t))
      .map((t) => ({ name: t.title, date: fmt(t.dueDate) }));
    const milestonesUpcoming = milestones
      .filter((t) => !isDone(t.status) && !isOverdue(t))
      .map((t) => ({ name: t.title, date: fmt(t.dueDate) }));

    // Prochaines étapes : tâches non terminées, avec échéance, les plus proches.
    const nextSteps = tasks
      .filter((t) => !t.isMilestone && !isDone(t.status) && !!t.dueDate)
      .slice(0, 8)
      .map((t) => ({
        name: t.title,
        due: fmt(t.dueDate),
        assignees: t.assignees.map((a) => a.user.name).join(', '),
      }));

    const clientName = project.client
      ? `${project.client.name}${project.client.company ? ` (${project.client.company})` : ''}`
      : '';

    // Données de graphiques (best-effort — un deck sort même si l'un échoue).
    const bFrom = project.startDate
      ? project.startDate.toISOString().slice(0, 10)
      : new Date(now.getTime() - 30 * 86400000).toISOString().slice(0, 10);
    const bEndDate = project.dueDate && project.dueDate.getTime() > now.getTime() ? project.dueDate : now;
    const bTo = bEndDate.toISOString().slice(0, 10);
    // `preparer`, `due` et `burn` sont mutuellement indépendants → une seule
    // vague parallèle au lieu de 3 await séquentiels.
    const [preparer, due, burn] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: opts.preparedById, organizationId: orgId },
        select: { name: true },
      }),
      this.dueAdherence(orgId, projectId).catch(() => null),
      bFrom <= bTo
        ? this.burndown(orgId, projectId, { from: bFrom, to: bTo } as BurndownDto).catch(() => null)
        : Promise.resolve(null),
    ]);
    // Sous-échantillonne le burndown à ~24 points max (lisibilité du chart).
    const burndown =
      burn && burn.totalScopeHours > 0
        ? {
            totalScope: burn.totalScopeHours,
            points: sampleEvenly(burn.points, 24).map((p) => ({
              date: p.date,
              ideal: p.idealRemainingHours,
              actual: p.actualRemainingHours,
            })),
          }
        : null;

    return {
      projectKey: project.key,
      projectName: project.name,
      client: clientName,
      startDate: fmt(project.startDate),
      dueDate: fmt(project.dueDate),
      reportDate: now.toISOString().slice(0, 10),
      preparedBy: preparer?.name || opts.preparedByFallback,
      lang: opts.lang,
      health: project.statusHealth ?? null,
      statusSummary: project.statusSummary ?? '',
      progressPct: total === 0 ? 0 : Math.round((done / total) * 100),
      totalTasks: total,
      doneTasks: done,
      overdueTasks: overdueTasks.length,
      milestonesDone,
      milestonesUpcoming,
      milestonesAtRisk,
      nextSteps,
      dueAdherence: due
        ? { onTime: due.onTime, late: due.late, noDeadline: due.noDeadline, onTimePct: due.onTimePct, totalCompleted: due.totalCompleted }
        : { onTime: 0, late: 0, noDeadline: 0, onTimePct: 0, totalCompleted: 0 },
      burndown,
    };
  }

  /**
   * Charge le template PPTX de statut client uploadé par l'org (kind
   * `CLIENT_STATUS_PPTX`), ou `null` si aucun → le builder retombe sur le deck
   * par défaut brandé Vaks.
   */
  async loadClientStatusTemplate(orgId: string): Promise<Buffer | null> {
    const row = await this.prisma.organizationDocumentTemplate.findUnique({
      where: { organizationId_kind: { organizationId: orgId, kind: 'CLIENT_STATUS_PPTX' } },
      select: { storageKey: true },
    });
    if (!row) return null;
    try {
      return await this.s3.getObjectBuffer(this.s3.buckets.templates, row.storageKey);
    } catch {
      // Blob manquant (template supprimé côté S3 sans la ligne) → deck par défaut.
      return null;
    }
  }

  // ============================================================
  // Helpers
  // ============================================================
  // ============================================================
  // Cumulative Flow Diagram (depuis l'historique de statut)
  // ============================================================
  async cfd(
    orgId: string,
    projectId: string,
    opts: { from?: string; to?: string; granularity?: 'day' | 'week' } = {},
  ) {
    const project = await this.assertProject(orgId, projectId);
    const today = new Date();
    const to = opts.to ? toDateOnly(opts.to) : today;
    const from = opts.from
      ? toDateOnly(opts.from)
      : project.startDate
        ? toDateOnly(project.startDate.toISOString())
        : addDays(to, -30);
    // Granularité : jour si la fenêtre est courte, sinon semaine (cap ~120 pts).
    const span = Math.max(1, daysBetween(from, to));
    const granularity = opts.granularity ?? (span > 120 ? 'week' : 'day');
    const step = granularity === 'week' ? 7 : 1;

    const history = await this.prisma.taskStatusHistory.findMany({
      where: { projectId: project.id, organizationId: orgId },
      orderBy: { changedAt: 'asc' },
      select: { taskId: true, toStatus: true, changedAt: true },
    });
    const byTask = new Map<string, Array<{ at: number; status: TaskStatus }>>();
    for (const h of history) {
      const arr = byTask.get(h.taskId) ?? [];
      arr.push({ at: h.changedAt.getTime(), status: h.toStatus });
      byTask.set(h.taskId, arr);
    }

    const points: Array<{ date: string } & Record<TaskStatus, number>> = [];
    for (let d = new Date(from); d.getTime() <= to.getTime(); d = addDays(d, step)) {
      const cutoff = addDays(d, 1).getTime(); // fin de journée
      const counts: Record<TaskStatus, number> = blankStatusCounts();
      for (const entries of byTask.values()) {
        let status: TaskStatus | null = null;
        for (const e of entries) {
          if (e.at < cutoff) status = e.status;
          else break;
        }
        if (status) counts[status]++;
      }
      points.push({ date: d.toISOString().slice(0, 10), ...counts });
    }
    return { projectId: project.id, from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10), granularity, points };
  }

  // ============================================================
  // KPIs qualité / périmètre
  // ============================================================
  async quality(orgId: string, projectId: string) {
    const project = await this.assertProject(orgId, projectId);
    const [tasks, history] = await Promise.all([
      this.prisma.task.findMany({
        where: { projectId: project.id, organizationId: orgId, deletedAt: null },
        select: { id: true, isBug: true, createdAt: true, estimateHours: true, status: true },
      }),
      this.prisma.taskStatusHistory.findMany({
        where: { projectId: project.id, organizationId: orgId, fromStatus: { not: null } },
        select: { taskId: true, fromStatus: true, toStatus: true },
      }),
    ]);
    const total = tasks.length;

    // Re-travail : tâche ayant régressé depuis IN_REVIEW/DONE vers un statut amont.
    const rank: Record<TaskStatus, number> = { TODO: 0, ON_HOLD: 1, CLAIMED: 1, IN_PROGRESS: 2, CHANGES_REQUESTED: 2, IN_REVIEW: 3, APPROVED: 4, DONE: 5 };
    const reworked = new Set<string>();
    for (const h of history) {
      if (!h.fromStatus) continue;
      if (rank[h.fromStatus] >= rank.IN_REVIEW && rank[h.toStatus] < rank[h.fromStatus]) {
        reworked.add(h.taskId);
      }
    }

    const bugCount = tasks.filter((t) => t.isBug).length;
    const baseline = project.startDate ? project.startDate.getTime() : null;
    let scopeAddedTasks = 0;
    let scopeAddedEstimateHours = 0;
    if (baseline != null) {
      for (const t of tasks) {
        if (t.createdAt.getTime() > baseline) {
          scopeAddedTasks++;
          scopeAddedEstimateHours += t.estimateHours ?? 0;
        }
      }
    }

    return {
      projectId: project.id,
      totalTasks: total,
      reworkedTasks: reworked.size,
      reworkRatePct: total ? Math.round((reworked.size / total) * 1000) / 10 : 0,
      bugCount,
      bugRatePct: total ? Math.round((bugCount / total) * 1000) / 10 : 0,
      scopeAddedTasks,
      scopeAddedEstimateHours: round(scopeAddedEstimateHours),
      hasBaselineDate: baseline != null,
    };
  }

  // ============================================================
  // KPI projet portefeuille (transverse, filtrable par équipe)
  // ============================================================
  /**
   * KPI portefeuille. Agrégation lourde (conflits capacité + EVM par projet) →
   * cache Redis 30 s. Clé scopée par **userId** de l'appelant : le périmètre est
   * filtré RBAC (`accessibleProjectScope`), deux appelants voient des projets
   * différents — jamais partager la clé entre users. Fenêtre/équipe dans la clé.
   */
  async portfolioKpi(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: { from?: string; to?: string; teamId?: string },
  ) {
    return this.cache.wrap(
      ['portfolioKpi', orgId, requester.userId, requester.isAdmin, JSON.stringify(q)],
      30,
      () => this.computePortfolioKpi(orgId, requester, q),
    );
  }

  private async computePortfolioKpi(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    q: { from?: string; to?: string; teamId?: string },
  ) {
    const to = q.to ? toDateOnly(q.to) : startOfToday();
    const from = q.from ? toDateOnly(q.from) : addDays(to, -90);
    const teamId = q.teamId && q.teamId.length ? q.teamId : null;
    const currency = await this.settings.getCurrency(orgId);

    // Périmètre projet : self-scope (fuite cross-projet) + filtre équipe.
    const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);
    const where: Prisma.ProjectWhereInput = { organizationId: orgId, deletedAt: null, kind: 'STANDARD' };
    if (scope !== null) where.id = { in: scope };
    if (teamId) where.teams = { some: { teamId } };
    // Period-scoped: only projects open or closed during [from, to]. A project
    // must have started before the window ends; the end bound only excludes
    // already-CLOSED (COMPLETED/ARCHIVED) projects that finished before the
    // window — a still-open project (incl. overdue ACTIVE) counts as open
    // through the window regardless of its planned due date. Null dates stay in.
    where.AND = [
      { OR: [{ startDate: null }, { startDate: { lte: to } }] },
      {
        OR: [
          { status: { notIn: ['COMPLETED', 'ARCHIVED'] } },
          { dueDate: null },
          { dueDate: { gte: from } },
        ],
      },
    ];
    const projects = await this.prisma.project.findMany({
      where,
      select: {
        id: true, key: true, name: true, status: true, billable: true,
        startDate: true, dueDate: true, offerDecidedAt: true, createdAt: true, updatedAt: true,
        budgetAmount: true,
      },
    });
    const projectIds = projects.map((p) => p.id);

    // Population utilisateurs pour conflits/utilisation.
    let memberIds: string[];
    if (teamId) {
      memberIds = (await this.prisma.teamMember.findMany({ where: { teamId }, select: { userId: true } })).map((m) => m.userId);
    } else {
      memberIds = (await this.prisma.allocation.findMany({
        where: { organizationId: orgId, endDate: { gte: from }, startDate: { lte: to } },
        select: { userId: true },
        distinct: ['userId'],
      })).map((a) => a.userId);
    }

    // ----- Conflits de ressources (sur-allocation multi-projets) -----
    const cap = memberIds.length
      ? await this.capacity.analyzeUsersCapacity(orgId, memberIds, from, to)
      : { conflictDays: 0, peopleAffected: 0 };

    // ----- Schedule Variance (EV − PV) agrégé : projets datés + budgétés -----
    const evmProjects = projects.filter((p) => p.budgetAmount != null && p.startDate && p.dueDate);
    let ev = 0;
    let pv = 0;
    if (evmProjects.length) {
      // Batché : ~6 requêtes pour tous les projets (au lieu de ~6×N).
      const evmMap = await this.finance
        .getProjectEvmBatch(orgId, evmProjects.map((p) => p.id))
        .catch(() => null);
      if (evmMap) {
        for (const p of evmProjects) {
          const e = evmMap.get(p.id);
          if (!e) continue;
          ev += e.ev;
          if (e.pv != null) pv += e.pv;
        }
      }
    }
    const sv = round(ev - pv);

    // ----- Milestone Hit Rate : jalons à échéance dans la fenêtre -----
    let msTotal = 0;
    let msOnTime = 0;
    if (projectIds.length) {
      const milestones = await this.prisma.task.findMany({
        where: { organizationId: orgId, projectId: { in: projectIds }, deletedAt: null, isMilestone: true, dueDate: { gte: from, lte: to } },
        select: { id: true, dueDate: true },
      });
      msTotal = milestones.length;
      if (msTotal) {
        const hist = await this.prisma.taskStatusHistory.findMany({
          where: { organizationId: orgId, taskId: { in: milestones.map((m) => m.id) }, toStatus: TaskStatus.DONE },
          orderBy: { changedAt: 'asc' },
          select: { taskId: true, changedAt: true },
        });
        const doneAt = new Map<string, Date>();
        for (const h of hist) if (!doneAt.has(h.taskId)) doneAt.set(h.taskId, h.changedAt);
        for (const m of milestones) {
          const d = doneAt.get(m.id);
          if (d && m.dueDate && d.getTime() <= m.dueDate.getTime()) msOnTime++;
        }
      }
    }

    // ----- Project Cycle Time : approbation → clôture (projets terminés) -----
    const cycleSamples: Array<{ projectId: string; key: string; name: string; days: number }> = [];
    for (const p of projects) {
      if (p.status !== 'COMPLETED') continue;
      if (p.updatedAt.getTime() < from.getTime() || p.updatedAt.getTime() > addDays(to, 1).getTime()) continue;
      const approved = p.offerDecidedAt ?? p.startDate ?? p.createdAt;
      const days = Math.round((p.updatedAt.getTime() - approved.getTime()) / 86_400_000);
      if (days >= 0) cycleSamples.push({ projectId: p.id, key: p.key, name: p.name, days });
    }
    const avgCycle = cycleSamples.length
      ? Math.round((cycleSamples.reduce((s, c) => s + c.days, 0) / cycleSamples.length) * 10) / 10
      : null;

    // ----- Utilisation : heures facturables vs opérationnelles -----
    let billableMin = 0;
    let totalMin = 0;
    if (projectIds.length) {
      const entryWhere: Prisma.TimeEntryWhereInput = {
        organizationId: orgId,
        date: { gte: from, lte: addDays(to, 1) },
        task: { projectId: { in: projectIds } },
      };
      if (teamId) entryWhere.userId = { in: memberIds };
      const entries = await this.prisma.timeEntry.findMany({
        where: entryWhere,
        select: { durationMinutes: true, task: { select: { project: { select: { billable: true } } } } },
      });
      for (const e of entries) {
        totalMin += e.durationMinutes;
        if (e.task.project.billable) billableMin += e.durationMinutes;
      }
    }
    const billableH = round(billableMin / 60);
    const operationalH = round((totalMin - billableMin) / 60);

    return {
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      teamId,
      projectCount: projects.length,
      currency,
      conflict: { conflictDays: cap.conflictDays, peopleAffected: cap.peopleAffected },
      schedule: { ev: round(ev), pv: round(pv), sv, svPct: pv > 0 ? Math.round((sv / pv) * 1000) / 10 : null },
      milestones: { total: msTotal, onTime: msOnTime, hitRatePct: msTotal ? Math.round((msOnTime / msTotal) * 1000) / 10 : null },
      cycleTime: { completedCount: cycleSamples.length, avgDays: avgCycle, samples: cycleSamples.sort((a, b) => b.days - a.days).slice(0, 12) },
      utilization: {
        billablePct: totalMin ? Math.round((billableMin / totalMin) * 1000) / 10 : null,
        billableHours: billableH,
        operationalHours: operationalH,
      },
    };
  }

  private async assertProject(orgId: string, projectId: string) {
    // `kind: STANDARD` : pas de stats/burndown/adhérence sur un conteneur de
    // tickets externes, même par appel API direct (introuvable = il n'existe
    // pas pour le reporting).
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null, kind: 'STANDARD' },
      select: { id: true, key: true, name: true, startDate: true, dueDate: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
    return p;
  }
}

// ---- helpers locaux (purs) ----
function toDateOnly(iso: string): Date {
  const s = iso.length === 10 ? `${iso}T00:00:00.000Z` : iso;
  const d = new Date(s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function startOfToday(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Sous-échantillonne un tableau à au plus `max` éléments, bornes incluses,
 *  répartis uniformément (pour garder un chart lisible). */
function sampleEvenly<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const out: T[] = [];
  const step = (arr.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) out.push(arr[Math.round(i * step)]);
  return out;
}
