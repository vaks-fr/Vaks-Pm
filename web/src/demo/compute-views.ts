/* ============================================================
   Vaks — Démo statique : endpoints calculés des vues « lourdes »
   (workload, gantt/PERT, reports, finance, KPIs).
   ----------------------------------------------------------------
   Logique SIMPLIFIÉE mais cohérente et réactive au store. Objectif :
   qu'AUCUNE vue ne soit vide/cassée. Toutes les formes DTO respectent le
   contrat exact des vues (tableaux jamais `undefined`, compteurs complets).
   ============================================================ */
import {
  TaskStatus,
  type WorkloadGridDto,
  type GanttDto,
  type ProjectStatsDto,
  type BurndownReportDto,
  type DueAdherenceDto,
  type TimeBreakdownDto,
  type TasksInWindowReportDto,
  type ProjectBudgetSummaryDto,
  type ProjectEvmDto,
  type ProjectAgentRatesDto,
  type ReportWidgetPreferenceDto,
  type TeamReportDto,
  type TeamKpiDto,
  type PortfolioKpiDto,
  type PortfolioFinanceDto,
  type TaskDto,
} from '@vaks-pm/shared';
import { getState } from './store';
import { DEMO_TEAM_MEMBERS } from './seed';

const MS_DAY = 86_400_000;
const HPD = 8; // heures par jour ouvré

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function parse(dateYmd: string): Date {
  return new Date(dateYmd + 'T00:00:00Z');
}
function weekdayOf(dateYmd: string): number {
  return (parse(dateYmd).getUTCDay() + 6) % 7; // 0 = lundi
}
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const end = parse(to).getTime();
  for (let t = parse(from).getTime(); t <= end; t += MS_DAY) out.push(ymd(new Date(t)));
  return out;
}
function addDays(dateYmd: string, n: number): string {
  return ymd(new Date(parse(dateYmd).getTime() + n * MS_DAY));
}
function businessDays(from: string, to: string): number {
  return dateRange(from, to).filter((d) => weekdayOf(d) < 5).length;
}
function todayYmd(): string {
  return ymd(new Date());
}

/** Taux internes/facturés synthétiques (déterministes par user). */
function ratesFor(userId: string): { cost: number; bill: number } {
  const n = getState().users.findIndex((u) => u.id === userId);
  const cost = 55 + ((n < 0 ? 0 : n) % 6) * 8; // 55..95 €/h
  return { cost, bill: Math.round(cost * 1.7) };
}

/* ============================================================
   Workload
   ============================================================ */
export function computeWorkload(from: string, to: string, teamId?: string): WorkloadGridDto {
  const s = getState();
  const dates = dateRange(from, to);
  const days = dates.map((date) => ({ date, weekday: weekdayOf(date) }));
  const memberIds = teamId ? DEMO_TEAM_MEMBERS[teamId] ?? [] : s.users.map((u) => u.id);
  const users = s.users.filter((u) => memberIds.includes(u.id));
  const projByTask = new Map(s.tasks.map((t) => [t.id, t.projectId]));
  const projById = new Map(s.projects.map((p) => [p.id, p]));

  const rows = users.map((u) => {
    const uAllocs = s.allocations.filter((a) => a.userId === u.id);
    const cells = dates.map((date) => {
      const weekday = weekdayOf(date);
      const dayAllocs = uAllocs.filter((a) => a.startDate <= date && a.endDate >= date);
      const allocations = dayAllocs.map((a) => {
        const pid = projByTask.get(a.taskId) ?? a.projectId;
        const p = projById.get(pid);
        return {
          allocationId: a.id,
          taskId: a.taskId,
          taskTitle: a.taskTitle ?? s.tasks.find((t) => t.id === a.taskId)?.title ?? '',
          projectKey: p?.key ?? '',
          projectName: p?.name ?? '',
          color: null as string | null,
          hours: a.hoursPerDay,
        };
      });
      return {
        date,
        weekday,
        capacityHours: weekday < 5 ? HPD : 0,
        allocatedHours: allocations.reduce((n, a) => n + a.hours, 0),
        timeOffType: null,
        isHoliday: false,
        holidayName: null,
        allocations,
      };
    });
    return { userId: u.id, name: u.name, email: u.email, cells };
  });

  return { from, to, days, rows };
}

/* ============================================================
   Gantt / PERT — CPM (forward/backward pass, chemin critique)
   ============================================================ */
export function computeGantt(projectId: string): GanttDto {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const deps = s.dependencies.filter((d) => d.projectId === projectId);
  const ids = tasks.map((t) => t.id);
  const idSet = new Set(ids);
  const durOf = new Map(tasks.map((t) => [t.id, Math.max(1, Math.ceil((t.estimateHours ?? HPD) / HPD))]));

  // Graphe FS (on approxime SS/FF/SF sur le start pour rester simple).
  const preds = new Map<string, Array<{ id: string; lag: number }>>();
  const succs = new Map<string, Array<{ id: string; lag: number }>>();
  for (const id of ids) { preds.set(id, []); succs.set(id, []); }
  for (const d of deps) {
    if (!idSet.has(d.predecessorId) || !idSet.has(d.successorId)) continue;
    preds.get(d.successorId)!.push({ id: d.predecessorId, lag: d.lagDays ?? 0 });
    succs.get(d.predecessorId)!.push({ id: d.successorId, lag: d.lagDays ?? 0 });
  }

  // Ordre topologique (Kahn). Les nœuds restants (cycle) sont ajoutés en fin.
  const indeg = new Map(ids.map((id) => [id, preds.get(id)!.length]));
  const queue = ids.filter((id) => indeg.get(id) === 0);
  const topo: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    topo.push(id);
    for (const sc of succs.get(id)!) {
      indeg.set(sc.id, (indeg.get(sc.id) ?? 1) - 1);
      if (indeg.get(sc.id) === 0) queue.push(sc.id);
    }
  }
  for (const id of ids) if (!topo.includes(id)) topo.push(id);

  // Forward pass : ES/EF (en jours depuis le début du projet).
  const ES = new Map<string, number>();
  const EF = new Map<string, number>();
  for (const id of topo) {
    const es = Math.max(0, ...preds.get(id)!.map((pr) => (EF.get(pr.id) ?? 0) + pr.lag));
    ES.set(id, es);
    EF.set(id, es + (durOf.get(id) ?? 1));
  }
  const projDur = Math.max(0, ...ids.map((id) => EF.get(id) ?? 0));

  // Backward pass : LS/LF.
  const LF = new Map<string, number>();
  const LS = new Map<string, number>();
  for (const id of [...topo].reverse()) {
    const sc = succs.get(id)!;
    const lf = sc.length ? Math.min(...sc.map((x) => (LS.get(x.id) ?? projDur) - x.lag)) : projDur;
    LF.set(id, lf);
    LS.set(id, lf - (durOf.get(id) ?? 1));
  }

  // Ancrage : on cale le début du projet pour que les tâches TERMINÉES finissent
  // vers aujourd'hui et que le reste (en cours / à faire) tombe dans le futur —
  // sinon le Gantt « à partir d'aujourd'hui » serait vide (tout dans le passé).
  const doneEFs = tasks.filter((t) => t.status === TaskStatus.DONE).map((t) => EF.get(t.id) ?? 0);
  const maxDoneEF = doneEFs.length ? Math.max(...doneEFs) : Math.round(projDur * 0.25);
  const base = addDays(todayYmd(), -maxDoneEF);
  const scheduled = tasks.map((t) => {
    const es = ES.get(t.id) ?? 0;
    const ef = EF.get(t.id) ?? es + 1;
    const slack = Math.max(0, Math.round((LS.get(t.id) ?? es) - es));
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      isMilestone: t.isMilestone,
      isGroup: t.isGroup,
      color: t.color,
      parentTaskId: t.parentTaskId,
      progressPct: t.progressPct,
      scheduledStart: addDays(base, es),
      scheduledEnd: addDays(base, ef),
      totalSlack: slack,
      critical: slack === 0,
      assignees: t.assignees,
      labels: t.labels,
    };
  });

  return {
    projectId,
    projectStart: base,
    projectEnd: addDays(base, projDur),
    tasks: scheduled,
    dependencies: deps,
    criticalPathDays: projDur,
  };
}

/* ============================================================
   Reports
   ============================================================ */
const REPORT_WIDGET_KEYS = [
  'kpis', 'burndown', 'dueAdherence', 'agentsQuality', 'teamBreakdown',
  'quality', 'agents', 'cfd', 'tasksInWindow', 'breakdownTables', 'skillGap',
] as const;

export function computeReportWidgets(): ReportWidgetPreferenceDto {
  return { widgetOrder: [...REPORT_WIDGET_KEYS] as ReportWidgetPreferenceDto['widgetOrder'], hiddenKeys: [] };
}

export function computeStats(projectId: string): ProjectStatsDto {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const count = (st: TaskStatus) => tasks.filter((t) => t.status === st).length;
  const done = count(TaskStatus.DONE);
  const totalEstimate = tasks.reduce((n, t) => n + (t.estimateHours ?? 0), 0);
  const doneEstimate = tasks.filter((t) => t.status === TaskStatus.DONE).reduce((n, t) => n + (t.estimateHours ?? 0), 0);
  const taskIds = new Set(tasks.map((t) => t.id));
  const spentMinutes = s.timeEntries.filter((e) => taskIds.has(e.taskId)).reduce((n, e) => n + e.durationMinutes, 0);
  const today = todayYmd();
  return {
    projectId,
    projectKey: p?.key ?? '',
    projectName: p?.name ?? '',
    startDate: p?.startDate ?? null,
    dueDate: p?.dueDate ?? null,
    totalTasks: tasks.length,
    // ProjectStatsDto.byStatus ne déclare que 4 clés côté type partagé, mais l'API
    // porte les 8 statuts de l'enum (dont les statuts agents) à l'exécution — on
    // aligne la démo dessus et on referme le littéral par cast pour rester compatible
    // avec le type partagé sans le modifier (hors périmètre de cette slice).
    byStatus: ({
      TODO: count(TaskStatus.TODO),
      CLAIMED: count(TaskStatus.CLAIMED),
      IN_PROGRESS: count(TaskStatus.IN_PROGRESS),
      IN_REVIEW: count(TaskStatus.IN_REVIEW),
      CHANGES_REQUESTED: count(TaskStatus.CHANGES_REQUESTED),
      APPROVED: count(TaskStatus.APPROVED),
      ON_HOLD: count(TaskStatus.ON_HOLD),
      DONE: done,
    }) as ProjectStatsDto['byStatus'],
    completionPct: tasks.length ? Math.round((done / tasks.length) * 100) : 0,
    overdueTasks: tasks.filter((t) => t.status !== TaskStatus.DONE && t.dueDate != null && t.dueDate < today).length,
    totalEstimateHours: totalEstimate,
    doneEstimateHours: doneEstimate,
    remainingEstimateHours: Math.max(0, totalEstimate - doneEstimate),
    totalSpentMinutes: spentMinutes,
  };
}

export function computeBurndown(projectId: string, from: string, to: string): BurndownReportDto {
  const s = getState();
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const scope = tasks.reduce((n, t) => n + (t.estimateHours ?? 0), 0);
  const dates = dateRange(from, to);
  const n = dates.length;
  const points = dates.map((date, i) => {
    const ideal = n > 1 ? scope * (1 - i / (n - 1)) : 0;
    // « fait » à cette date = tâches DONE dont l'échéance (ou maj) ≤ date.
    const doneTasks = tasks.filter(
      (t) => t.status === TaskStatus.DONE && (t.dueDate ?? t.updatedAt).slice(0, 10) <= date,
    );
    const doneHours = doneTasks.reduce((h, t) => h + (t.estimateHours ?? 0), 0);
    return {
      date,
      idealRemainingHours: Math.round(ideal * 10) / 10,
      actualRemainingHours: Math.max(0, Math.round((scope - doneHours) * 10) / 10),
      doneTasks: doneTasks.length,
    };
  });
  return { projectId, from, to, referenceFrom: from, referenceTo: to, totalScopeHours: scope, points };
}

export function computeDueAdherence(projectId: string): DueAdherenceDto {
  const s = getState();
  const done = s.tasks.filter((t) => t.projectId === projectId && t.status === TaskStatus.DONE);
  const withDeadline = done.filter((t) => t.dueDate != null);
  const noDeadline = done.length - withDeadline.length;
  // Sans date de complétion, on considère les échéances tenues.
  const onTime = withDeadline.length;
  const late = 0;
  return {
    projectId,
    totalCompleted: done.length,
    onTime,
    late,
    noDeadline,
    onTimePct: done.length ? Math.round((onTime / done.length) * 100) : 0,
    onTimeCompletionPct: onTime + late > 0 ? Math.round((onTime / (onTime + late)) * 100) : null,
  };
}

export function computeTimeBreakdown(projectId: string, from: string, to: string): TimeBreakdownDto {
  const s = getState();
  const projById = new Map(s.projects.map((p) => [p.id, p]));
  const taskById = new Map(s.tasks.map((t) => [t.id, t]));
  const userById = new Map(s.users.map((u) => [u.id, u]));
  const entries = s.timeEntries.filter((e) => {
    const t = taskById.get(e.taskId);
    if (!t) return false;
    if (projectId && t.projectId !== projectId) return false;
    if (from && e.date < from) return false;
    if (to && e.date > to) return false;
    return true;
  });
  const total = entries.reduce((n, e) => n + e.durationMinutes, 0);
  const group = (keyFn: (e: (typeof entries)[number]) => { key: string; name: string }[]) => {
    const map = new Map<string, { name: string; minutes: number }>();
    for (const e of entries) {
      for (const { key, name } of keyFn(e)) {
        const cur = map.get(key) ?? { name, minutes: 0 };
        cur.minutes += e.durationMinutes;
        map.set(key, cur);
      }
    }
    return [...map.values()].sort((a, b) => b.minutes - a.minutes);
  };
  const byProject = group((e) => {
    const t = taskById.get(e.taskId);
    const p = t ? projById.get(t.projectId) : undefined;
    return p ? [{ key: p.id, name: p.name }] : [];
  });
  const byUser = group((e) => {
    const u = userById.get(e.userId);
    return u ? [{ key: u.id, name: u.name }] : [];
  });
  const byLabel = group((e) => {
    const t = taskById.get(e.taskId);
    return (t?.labels ?? []).map((l) => ({ key: l.id, name: l.name }));
  });
  return {
    totalMinutes: total,
    billableMinutes: total,
    nonBillableMinutes: 0,
    byProject,
    byUser,
    byLabel,
  };
}

export function computeTasksInWindow(projectId: string, from: string, to: string): TasksInWindowReportDto {
  const s = getState();
  const today = todayYmd();
  const inWin = (d: string | null) => d != null && d.slice(0, 10) >= from && d.slice(0, 10) <= to;
  const tasks = s.tasks
    .filter((t) => t.projectId === projectId && (inWin(t.startDate) || inWin(t.dueDate)))
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      startDate: t.startDate,
      dueDate: t.dueDate,
      estimateHours: t.estimateHours,
      progressPct: t.progressPct,
      overdue: t.status !== TaskStatus.DONE && t.dueDate != null && t.dueDate.slice(0, 10) < today,
      assignees: t.assignees.map((a) => ({ id: a.userId, name: a.name, email: a.email })),
    }));
  return { projectId, from, to, tasks };
}

/* ============================================================
   Finance
   ============================================================ */
export function computeBudgetSummary(projectId: string): ProjectBudgetSummaryDto {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  const billable = p?.billable ?? false;
  const tasks = s.tasks.filter((t) => t.projectId === projectId);
  const taskIds = new Set(tasks.map((t) => t.id));
  const memberIds = [...new Set(tasks.flatMap((t) => t.assignees.map((a) => a.userId)))];

  const members = memberIds.map((uid) => {
    const u = s.users.find((x) => x.id === uid);
    const { cost, bill } = ratesFor(uid);
    const actualHours =
      s.timeEntries.filter((e) => e.userId === uid && taskIds.has(e.taskId)).reduce((n, e) => n + e.durationMinutes, 0) / 60;
    const plannedHours = s.allocations
      .filter((a) => a.userId === uid && a.projectId === projectId)
      .reduce((n, a) => n + a.hoursPerDay * businessDays(a.startDate, a.endDate), 0);
    return {
      userId: uid,
      name: u?.name ?? uid,
      costRate: cost,
      billRate: bill,
      actualHours: Math.round(actualHours * 10) / 10,
      actualCost: Math.round(actualHours * cost),
      plannedHours,
      plannedCost: plannedHours * cost,
      billableRevenue: billable ? Math.round(actualHours * bill) : 0,
      plannedRevenue: billable ? plannedHours * bill : 0,
      hasRate: true,
    };
  });

  const actualCost = members.reduce((n, m) => n + m.actualCost, 0);
  const plannedCost = members.reduce((n, m) => n + m.plannedCost, 0);
  const forecastCost = Math.max(actualCost, plannedCost);
  const billableRevenue = billable ? members.reduce((n, m) => n + m.billableRevenue, 0) : null;
  const forecastRevenue = billable ? members.reduce((n, m) => n + Math.max(m.billableRevenue, m.plannedRevenue), 0) : null;
  const budgetAmount = Math.round((plannedCost || 20000) * 1.15);
  const margin = billableRevenue != null ? billableRevenue - actualCost : null;
  const forecastMargin = forecastRevenue != null ? forecastRevenue - forecastCost : null;

  return {
    projectId,
    currency: 'EUR',
    billable,
    budgetAmount,
    actualCost,
    forecastCost,
    billableRevenue,
    margin,
    forecastRevenue,
    forecastMargin,
    actualHours: Math.round(members.reduce((n, m) => n + m.actualHours, 0) * 10) / 10,
    plannedHours: members.reduce((n, m) => n + m.plannedHours, 0),
    spentPct: budgetAmount ? Math.round((actualCost / budgetAmount) * 100) : null,
    forecastPct: budgetAmount ? Math.round((forecastCost / budgetAmount) * 100) : null,
    remaining: budgetAmount ? budgetAmount - actualCost : null,
    membersMissingRate: 0,
    members,
  };
}

export function computeEvm(projectId: string): ProjectEvmDto {
  const s = getState();
  const p = s.projects.find((x) => x.id === projectId);
  const budget = computeBudgetSummary(projectId);
  const stats = computeStats(projectId);
  const hasDates = !!(p?.startDate && p?.dueDate);
  const pct = stats.completionPct;
  const bud = budget.budgetAmount ?? 0;
  const ac = budget.actualCost;
  const ev = Math.round((bud * pct) / 100);
  let pv: number | null = null;
  if (hasDates && p?.startDate && p?.dueDate) {
    const start = parse(p.startDate.slice(0, 10)).getTime();
    const end = parse(p.dueDate.slice(0, 10)).getTime();
    const now = Date.now();
    const frac = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
    pv = Math.round(bud * frac);
  }
  return {
    projectId,
    currency: 'EUR',
    budget: bud,
    hasDates,
    percentComplete: pct,
    pv,
    ev,
    ac,
    cpi: ac > 0 ? Math.round((ev / ac) * 100) / 100 : null,
    spi: pv && pv > 0 ? Math.round((ev / pv) * 100) / 100 : null,
    budgetVariance: pv != null ? bud - pv : null,
    costVariance: ev - ac,
    monthly: [],
  };
}

export function computeAgentRates(projectId: string): ProjectAgentRatesDto {
  return {
    projectId,
    enabled: false,
    currency: 'EUR',
    agents: [],
    totalKTokens: 0,
    totalCost: 0,
    totalBilled: 0,
  };
}

/* ============================================================
   KPI équipe / portefeuille
   ============================================================ */
const ALL_STATUSES: TaskStatus[] = [
  TaskStatus.TODO, TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS, TaskStatus.IN_REVIEW,
  TaskStatus.CHANGES_REQUESTED, TaskStatus.APPROVED, TaskStatus.ON_HOLD, TaskStatus.DONE,
];
function emptyStatusCounts(): Record<TaskStatus, number> {
  const r = {} as Record<TaskStatus, number>;
  for (const st of ALL_STATUSES) r[st] = 0;
  return r;
}

export function computeTeamReport(teamId: string, from: string, to: string): TeamReportDto {
  const s = getState();
  const team = s.teams.find((t) => t.id === teamId);
  const memberIds = DEMO_TEAM_MEMBERS[teamId] ?? [];
  const capDays = businessDays(from, to);
  const projById = new Map(s.projects.map((p) => [p.id, p]));

  const members = memberIds.map((uid) => {
    const u = s.users.find((x) => x.id === uid);
    const capacityHours = capDays * HPD;
    const taskIds = new Set(s.tasks.filter((t) => t.assignees.some((a) => a.userId === uid)).map((t) => t.id));
    const loggedHours =
      s.timeEntries.filter((e) => e.userId === uid && taskIds.has(e.taskId) && e.date >= from && e.date <= to)
        .reduce((n, e) => n + e.durationMinutes, 0) / 60;
    const allocatedHours = s.allocations
      .filter((a) => a.userId === uid && a.startDate <= to && a.endDate >= from)
      .reduce((n, a) => n + a.hoursPerDay * businessDays(a.startDate < from ? from : a.startDate, a.endDate > to ? to : a.endDate), 0);
    const statusCounts = emptyStatusCounts();
    for (const t of s.tasks.filter((x) => x.assignees.some((a) => a.userId === uid))) statusCounts[t.status] += 1;
    const byProjMap = new Map<string, { projectKey: string; projectName: string; hours: number }>();
    for (const e of s.timeEntries.filter((x) => x.userId === uid && taskIds.has(x.taskId))) {
      const t = s.tasks.find((x) => x.id === e.taskId);
      const p = t ? projById.get(t.projectId) : undefined;
      if (!p) continue;
      const cur = byProjMap.get(p.id) ?? { projectKey: p.key, projectName: p.name, hours: 0 };
      cur.hours += e.durationMinutes / 60;
      byProjMap.set(p.id, cur);
    }
    const byProject = [...byProjMap.values()].map((r) => ({
      ...r, hours: Math.round(r.hours * 10) / 10, pct: loggedHours ? Math.round((r.hours / loggedHours) * 100) : null,
    }));
    return {
      userId: uid,
      name: u?.name ?? uid,
      capacityHours,
      loggedHours: Math.round(loggedHours * 10) / 10,
      allocatedHours: Math.round(allocatedHours * 10) / 10,
      utilizationPct: capacityHours ? Math.round((loggedHours / capacityHours) * 100) : null,
      allocationPct: capacityHours ? Math.round((allocatedHours / capacityHours) * 100) : null,
      byProject,
      statusCounts,
    };
  });

  const totalsStatus = emptyStatusCounts();
  for (const m of members) for (const st of ALL_STATUSES) totalsStatus[st] += m.statusCounts[st];
  const capacityHours = members.reduce((n, m) => n + m.capacityHours, 0);
  const loggedHours = Math.round(members.reduce((n, m) => n + m.loggedHours, 0) * 10) / 10;
  const allocatedHours = Math.round(members.reduce((n, m) => n + m.allocatedHours, 0) * 10) / 10;
  const utils = members.map((m) => m.utilizationPct).filter((x): x is number => x != null);

  return {
    teamId,
    teamName: team?.name ?? '',
    from,
    to,
    members,
    totals: {
      memberCount: members.length,
      avgUtilizationPct: utils.length ? Math.round(utils.reduce((n, x) => n + x, 0) / utils.length) : null,
      statusCounts: totalsStatus,
      capacityHours,
      loggedHours,
      allocatedHours,
    },
  };
}

export function computeTeamKpi(teamId: string, from: string, to: string): TeamKpiDto {
  const s = getState();
  const team = s.teams.find((t) => t.id === teamId);
  const memberIds = DEMO_TEAM_MEMBERS[teamId] ?? [];
  const capDays = businessDays(from, to);
  const byUser = memberIds.map((uid) => {
    const u = s.users.find((x) => x.id === uid);
    const taskIds = new Set(s.tasks.filter((t) => t.assignees.some((a) => a.userId === uid)).map((t) => t.id));
    const totalHours =
      s.timeEntries.filter((e) => e.userId === uid && taskIds.has(e.taskId) && e.date >= from && e.date <= to)
        .reduce((n, e) => n + e.durationMinutes, 0) / 60;
    const billableHours = Math.round(totalHours * 0.8 * 10) / 10;
    const operationalHours = Math.round((totalHours - billableHours) * 10) / 10;
    return {
      userId: uid,
      name: u?.name ?? uid,
      billableHours,
      operationalHours,
      totalHours: Math.round(totalHours * 10) / 10,
      billablePct: totalHours ? Math.round((billableHours / totalHours) * 100) : null,
    };
  });
  const availableHours = memberIds.length * capDays * HPD;
  const allocatedHours = s.allocations
    .filter((a) => memberIds.includes(a.userId) && a.startDate <= to && a.endDate >= from)
    .reduce((n, a) => n + a.hoursPerDay * businessDays(a.startDate < from ? from : a.startDate, a.endDate > to ? to : a.endDate), 0);
  const totalBillable = byUser.reduce((n, u) => n + u.billableHours, 0);
  const totalHours = byUser.reduce((n, u) => n + u.totalHours, 0);
  return {
    teamId,
    teamName: team?.name ?? '',
    from,
    to,
    utilization: {
      teamBillablePct: totalHours ? Math.round((totalBillable / totalHours) * 100) : null,
      byUser,
    },
    conflict: { conflictDays: 0, peopleAffected: 0, worst: [] },
    capacity: {
      availableHours,
      allocatedHours: Math.round(allocatedHours),
      headroomHours: Math.round(availableHours - allocatedHours),
      byUser: memberIds.map((uid) => {
        const u = s.users.find((x) => x.id === uid);
        const alloc = s.allocations
          .filter((a) => a.userId === uid && a.startDate <= to && a.endDate >= from)
          .reduce((n, a) => n + a.hoursPerDay * businessDays(a.startDate < from ? from : a.startDate, a.endDate > to ? to : a.endDate), 0);
        const avail = capDays * HPD;
        return { userId: uid, name: u?.name ?? uid, availableHours: avail, allocatedHours: Math.round(alloc), headroomHours: Math.round(avail - alloc) };
      }),
    },
  };
}

export function computePortfolioKpi(from: string, to: string, teamId?: string): PortfolioKpiDto {
  const s = getState();
  const projects = s.projects.filter((p) => p.status === 'ACTIVE');
  const milestones = s.tasks.filter((t) => t.isMilestone);
  const doneMilestones = milestones.filter((t) => t.status === TaskStatus.DONE);
  const budgets = projects.map((p) => computeBudgetSummary(p.id));
  const ev = budgets.reduce((n, b) => n + Math.round(((b.budgetAmount ?? 0) * computeStats(b.projectId).completionPct) / 100), 0);
  const pv = budgets.reduce((n, b) => n + (b.budgetAmount ?? 0), 0) * 0.5;
  return {
    from,
    to,
    teamId: teamId ?? null,
    projectCount: projects.length,
    currency: 'EUR',
    conflict: { conflictDays: 0, peopleAffected: 0 },
    schedule: { ev, pv: Math.round(pv), sv: Math.round(ev - pv), svPct: pv ? Math.round(((ev - pv) / pv) * 100) : null },
    milestones: {
      total: milestones.length,
      onTime: doneMilestones.length,
      hitRatePct: milestones.length ? Math.round((doneMilestones.length / milestones.length) * 100) : null,
    },
    cycleTime: { completedCount: 0, avgDays: null, samples: [] },
    utilization: { billablePct: 72, billableHours: 0, operationalHours: 0 },
  };
}

/* ============================================================
   Portefeuille finance (FinancePanel)
   ============================================================ */
export function computePortfolioFinance(from: string, to: string): PortfolioFinanceDto {
  const s = getState();
  const projects = s.projects.filter((p) => p.status !== 'ARCHIVED');
  const clientById = new Map(s.clients.map((c) => [c.id, c]));

  type ProjFin = { id: string; key: string; name: string; budget: number | null; spent: number; revenue: number; margin: number; clientId: string | null };
  const projFins: ProjFin[] = projects.map((p) => {
    const b = computeBudgetSummary(p.id);
    const revenue = b.billableRevenue ?? 0;
    return {
      id: p.id, key: p.key, name: p.name,
      budget: b.budgetAmount, spent: b.actualCost, revenue, margin: revenue - b.actualCost,
      clientId: p.clientId ?? null,
    };
  });

  const clientMap = new Map<string | null, ProjFin[]>();
  for (const pf of projFins) {
    const arr = clientMap.get(pf.clientId) ?? [];
    arr.push(pf);
    clientMap.set(pf.clientId, arr);
  }
  const clients = [...clientMap.entries()].map(([cid, list]) => {
    const c = cid ? clientById.get(cid) : null;
    const budget = list.reduce((n, x) => n + (x.budget ?? 0), 0);
    const spent = list.reduce((n, x) => n + x.spent, 0);
    const revenue = list.reduce((n, x) => n + x.revenue, 0);
    const margin = revenue - spent;
    return {
      clientId: cid,
      clientName: c?.name ?? 'Internes / sans client',
      company: c?.company ?? null,
      projectCount: list.length,
      budget, spent, revenue, margin,
      marginPct: revenue ? Math.round((margin / revenue) * 100) : null,
      projects: list.map((x) => ({ id: x.id, key: x.key, name: x.name, budget: x.budget, spent: x.spent, revenue: x.revenue, margin: x.margin })),
    };
  });

  const totals = {
    projectCount: projFins.length,
    clientCount: clients.length,
    budget: projFins.reduce((n, x) => n + (x.budget ?? 0), 0),
    spent: projFins.reduce((n, x) => n + x.spent, 0),
    revenue: projFins.reduce((n, x) => n + x.revenue, 0),
    margin: projFins.reduce((n, x) => n + x.margin, 0),
  };

  return {
    currency: 'EUR',
    fiscalYearStartMonth: 1,
    period: { granularity: 'quarter', offset: 0, from, to, label: 'Période courante' },
    clientId: null,
    clients,
    totals,
    byTeam: [],
    budgetBuckets: [],
    revenueByClient: clients.map((c) => ({ clientId: c.clientId, clientName: c.clientName, revenue: c.revenue })),
    projectsByClient: clients.map((c) => ({ clientId: c.clientId, clientName: c.clientName, count: c.projectCount })),
    revenueByProject: projFins.map((p) => ({ id: p.id, key: p.key, name: p.name, revenue: p.revenue })),
    monthly: [],
    offerIterations: { avgIterations: null, projects: [] },
    pvVsCost: { total: { pv: totals.budget, cost: totals.spent }, byTeam: [] },
  };
}
