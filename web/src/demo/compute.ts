/* ============================================================
   Vaks — Démo statique : endpoints CALCULÉS dérivés du store vivant.
   ----------------------------------------------------------------
   Logique simplifiée (pas bit-exacte serveur) mais RÉACTIVE aux mutations :
   passer une tâche à DONE bouge le dashboard, logger du temps bouge la
   timesheet. Suffisant pour une vitrine.
   ============================================================ */
import {
  TaskStatus,
  type DashboardDto,
  type TimesheetDto,
  type TimesheetDayDto,
  type TimesheetTaskDto,
  type TimesheetCellDto,
  type TaskDto,
} from '@vaks-pm/shared';
import { getState, currentUser } from './store';

const MS_DAY = 86_400_000;

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function isSameWeekAsNow(iso: string): boolean {
  const now = new Date();
  const dow = (now.getDay() + 6) % 7;
  const mon = new Date(now.getTime() - dow * MS_DAY);
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon.getTime() + 7 * MS_DAY);
  const t = new Date(iso).getTime();
  return t >= mon.getTime() && t < sun.getTime();
}

/** `GET /me/dashboard` → DashboardDto (tâches de l'utilisateur courant). */
export function computeDashboard(): DashboardDto {
  const s = getState();
  const me = currentUser();
  const projById = new Map(s.projects.map((p) => [p.id, p]));
  const mine = s.tasks.filter((t) => t.assignees.some((a) => a.userId === me.id));

  const dashTasks = mine.map((t) => {
    const p = projById.get(t.projectId);
    return {
      id: t.id,
      key: `${p?.key ?? '?'}-${t.number}`,
      title: t.title,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate,
      projectId: t.projectId,
      projectName: p?.name ?? '',
      projectKey: p?.key ?? '',
      assigneeIds: t.assignees.map((a) => a.userId),
    };
  });

  const statusCounts: Record<string, number> = {};
  for (const t of mine) statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;

  const todayYmd = ymd(new Date());
  const overdueTeam = s.tasks.filter(
    (t) => t.status !== TaskStatus.DONE && t.dueDate != null && t.dueDate < todayYmd,
  ).length;

  // Prochain jalon (toutes tâches) : milestone non-DONE, échéance future la plus proche.
  const milestones = s.tasks
    .filter((t) => t.isMilestone && t.status !== TaskStatus.DONE && t.dueDate != null)
    .sort((a, b) => (a.dueDate! < b.dueDate! ? -1 : 1));
  const nm = milestones[0];
  const nextMilestone = nm
    ? {
        taskId: nm.id,
        key: `${projById.get(nm.projectId)?.key ?? '?'}-${nm.number}`,
        title: nm.title,
        dueDate: nm.dueDate!,
        projectName: projById.get(nm.projectId)?.name ?? '',
      }
    : null;

  // Activité récente synthétique (à partir des tâches en cours / commentaires).
  const activity = mine.slice(0, 6).map((t, i) => ({
    id: `act_${i}`,
    kind: (t.status === TaskStatus.DONE ? 'move' : i % 2 === 0 ? 'comment' : 'created') as
      | 'move'
      | 'comment'
      | 'created',
    at: t.updatedAt,
    actor: { id: me.id, name: me.name },
    taskId: t.id,
    taskKey: `${projById.get(t.projectId)?.key ?? '?'}-${t.number}`,
    taskTitle: t.title,
    toStatus: t.status === TaskStatus.DONE ? t.status : null,
  }));

  return {
    tasks: dashTasks,
    statusCounts,
    inProgress: mine.filter((t) => t.status === TaskStatus.IN_PROGRESS).length,
    completedThisWeek: mine.filter((t) => t.status === TaskStatus.DONE && isSameWeekAsNow(t.updatedAt)).length,
    overdueTeam,
    nextMilestone,
    activity,
  };
}

/** Liste les dates yyyy-mm-dd de [from, to] inclus. */
function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(from + 'T00:00:00Z').getTime();
  const end = new Date(to + 'T00:00:00Z').getTime();
  for (let t = start; t <= end; t += MS_DAY) out.push(ymd(new Date(t)));
  return out;
}

/** `GET /timesheet?from&to` → TimesheetDto (timesheet personnelle). */
export function computeTimesheet(from: string, to: string): TimesheetDto {
  const s = getState();
  const me = currentUser();
  const projById = new Map(s.projects.map((p) => [p.id, p]));
  const taskById = new Map(s.tasks.map((t) => [t.id, t]));

  const dates = dateRange(from, to);
  const myEntries = s.timeEntries.filter((e) => e.userId === me.id && dates.includes(e.date));
  const myAllocs = s.allocations.filter(
    (a) => a.userId === me.id && a.startDate <= to && a.endDate >= from,
  );

  const days: TimesheetDayDto[] = dates.map((date) => {
    const dow = (new Date(date + 'T00:00:00Z').getUTCDay() + 6) % 7;
    const isWeekend = dow >= 5;
    const actualMinutes = myEntries.filter((e) => e.date === date).reduce((n, e) => n + e.durationMinutes, 0);
    const allocatedHours = myAllocs
      .filter((a) => a.startDate <= date && a.endDate >= date)
      .reduce((n, a) => n + a.hoursPerDay, 0);
    const capacityHours = isWeekend ? 0 : 8;
    return {
      date,
      dayOfWeek: dow,
      capacityHours,
      isWeekend,
      isHoliday: false,
      holidayName: null,
      isTimeOff: false,
      timeOffType: null,
      timeOffNotes: null,
      allocatedHours,
      actualMinutes,
      overtimeMinutes: Math.max(0, actualMinutes - capacityHours * 60),
    };
  });

  // Tâches présentes dans la grille = celles avec entries OU allocations dans la fenêtre.
  const taskIds = new Set<string>([...myEntries.map((e) => e.taskId), ...myAllocs.map((a) => a.taskId)]);
  const mkTaskRow = (t: TaskDto): TimesheetTaskDto => {
    const p = projById.get(t.projectId);
    return {
      id: t.id, title: t.title, status: t.status, number: t.number,
      estimateHours: t.estimateHours, projectId: t.projectId,
      projectKey: p?.key ?? '', projectName: p?.name ?? '',
    };
  };
  const tasks = [...taskIds].map((id) => taskById.get(id)).filter((t): t is TaskDto => !!t).map(mkTaskRow);

  const cells: TimesheetCellDto[] = [];
  for (const id of taskIds) {
    for (const date of dates) {
      const es = myEntries.filter((e) => e.taskId === id && e.date === date);
      const alloc = myAllocs
        .filter((a) => a.taskId === id && a.startDate <= date && a.endDate >= date)
        .reduce((n, a) => n + a.hoursPerDay, 0);
      const actualMinutes = es.reduce((n, e) => n + e.durationMinutes, 0);
      if (es.length === 0 && alloc === 0) continue;
      cells.push({
        taskId: id, date, allocatedHours: alloc, actualMinutes,
        overtimeMinutes: es.reduce((n, e) => n + e.overtimeMinutes, 0),
        entryIds: es.map((e) => e.id),
      });
    }
  }

  // Tâches « ajoutables » = mes autres tâches assignées non déjà dans la grille.
  const addableTasks = s.tasks
    .filter((t) => t.assignees.some((a) => a.userId === me.id) && !taskIds.has(t.id) && t.status !== TaskStatus.DONE)
    .slice(0, 12)
    .map((t) => {
      const p = projById.get(t.projectId);
      return {
        id: t.id, title: t.title, number: t.number, estimateHours: t.estimateHours,
        projectId: t.projectId, projectKey: p?.key ?? '', projectName: p?.name ?? '',
      };
    });

  return {
    userId: me.id,
    from,
    to,
    user: { id: me.id, name: me.name, email: me.email, countryCode: me.countryCode ?? null },
    schedule: {
      hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, hoursSat: 0, hoursSun: 0,
      occupancyPct: 100, isDefault: true,
    },
    days,
    tasks,
    cells,
    addableTasks,
    timeOffRows: [],
  };
}
