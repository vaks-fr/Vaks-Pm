import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { HolidaysService } from '../holidays/holidays.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TimesheetQueryDto } from './dto/timesheet.dto';

const MS_PER_DAY = 86_400_000;

type DaySchedule = {
  hoursMon: number;
  hoursTue: number;
  hoursWed: number;
  hoursThu: number;
  hoursFri: number;
  hoursSat: number;
  hoursSun: number;
  occupancyPct: number;
};

@Injectable()
export class TimesheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly holidays: HolidaysService,
    private readonly settings: AdminSettingsService,
  ) {}

  /**
   * Renvoie une « timesheet » complète pour [from, to] sur un user :
   *  - les jours de la fenêtre avec capacité, jours fériés et time-offs
   *  - les tâches sur lesquelles l'user a une allocation OU une time entry
   *    qui chevauche la fenêtre
   *  - les cellules (taskId × date) avec heures planifiées et heures réelles
   *  - les totaux quotidiens (planifié, réel, capacité, heures supp)
   */
  async getTimesheet(orgId: string, currentUserId: string, q: TimesheetQueryDto) {
    // Restriction : la timesheet est strictement personnelle. On ignore tout
    // userId passé en query — chaque utilisateur ne voit que la sienne.
    void q.userId;
    const userId = currentUserId;
    const from = toDateOnly(q.from);
    const to = toDateOnly(q.to);
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException("'from' doit précéder 'to'");
    }
    // Garde-fou : on plafonne à 92 jours (~3 mois) pour éviter une requête
    // monstre depuis une UI mal calibrée.
    if ((to.getTime() - from.getTime()) / MS_PER_DAY > 92) {
      throw new BadRequestException('Fenêtre limitée à 92 jours');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: { id: true, name: true, email: true, countryCode: true },
    });
    if (!user) throw new NotFoundException('Utilisateur introuvable');

    // ---------- Schedule, time-offs, holidays ----------
    const [scheduleRow, timeOffs, defaultCountry, defaultHpd, defaultDays] = await Promise.all([
      this.prisma.workSchedule.findFirst({
        where: {
          userId,
          organizationId: orgId,
          effectiveFrom: { lte: to },
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.prisma.timeOff.findMany({
        where: {
          userId,
          organizationId: orgId,
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: { startDate: true, endDate: true, type: true, notes: true },
      }),
      this.holidays.getDefaultCountry(orgId),
      this.settings.getHoursPerDay(orgId),
      this.settings.getDefaultWorkDays(orgId),
    ]);

    const sched: DaySchedule = scheduleRow ?? {
      hoursMon: defaultDays[0] ? defaultHpd : 0,
      hoursTue: defaultDays[1] ? defaultHpd : 0,
      hoursWed: defaultDays[2] ? defaultHpd : 0,
      hoursThu: defaultDays[3] ? defaultHpd : 0,
      hoursFri: defaultDays[4] ? defaultHpd : 0,
      hoursSat: defaultDays[5] ? defaultHpd : 0,
      hoursSun: defaultDays[6] ? defaultHpd : 0,
      occupancyPct: 100,
    };
    const occ = (sched.occupancyPct ?? 100) / 100;

    const cc = (user.countryCode ?? defaultCountry).toUpperCase();
    const fromIso = dateIso(from);
    const toIso = dateIso(to);
    const holidayMap = new Map<string, string>();
    for (const h of this.holidays.forCountryRange(cc, fromIso, toIso)) {
      holidayMap.set(h.date, h.name);
    }

    // ---------- Tâches concernées : allocations OR time-entries sur la fenêtre ----------
    const [allocs, entries] = await Promise.all([
      this.prisma.allocation.findMany({
        where: {
          userId,
          organizationId: orgId,
          startDate: { lte: to },
          endDate: { gte: from },
        },
        select: {
          id: true,
          taskId: true,
          startDate: true,
          endDate: true,
          hoursPerDay: true,
        },
      }),
      this.prisma.timeEntry.findMany({
        where: {
          userId,
          organizationId: orgId,
          date: { gte: from, lte: to },
        },
        select: {
          id: true,
          taskId: true,
          date: true,
          durationMinutes: true,
          overtimeMinutes: true,
          description: true,
        },
      }),
    ]);

    const taskIds = new Set<string>();
    for (const a of allocs) taskIds.add(a.taskId);
    for (const e of entries) taskIds.add(e.taskId);

    // ⚠️ deletedAt: null — sinon les tâches soft-deletées sur lesquelles
    // l'user a logué du temps continuent d'apparaître dans la grille
    // (leurs TimeEntry survivent au soft-delete).
    const tasks = taskIds.size
      ? await this.prisma.task.findMany({
          where: {
            id: { in: [...taskIds] },
            organizationId: orgId,
            deletedAt: null,
          },
          select: {
            id: true,
            title: true,
            status: true,
            number: true,
            estimateHours: true,
            externalSource: true,
            externalKey: true,
            externalUrl: true,
            project: { select: { id: true, key: true, name: true, status: true, deletedAt: true } },
          },
        })
      : [];
    // On exclut aussi les tâches dont le projet est archivé/supprimé — leurs
    // entries restent dans la DB pour l'historique, mais la grille de timesheet
    // n'a aucune raison de les proposer à l'édition courante.
    const visibleTasks = tasks.filter(
      (t) => t.project.deletedAt == null && t.project.status !== 'ARCHIVED',
    );

    // Tâches "ajoutables" pour le menu « Add a task to your week » :
    // strictement les tâches assignées à l'user, sur un projet non
    // complété / non archivé / non supprimé. Indépendant de la semaine
    // affichée (l'user peut ajouter une tâche dont la planif n'est pas
    // cette semaine — c'est précisément le cas d'usage). On garde
    // `status != DONE` pour ne pas proposer du logging sur du terminé.
    const addableRaw = await this.prisma.task.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: { not: TaskStatus.DONE },
        id: { notIn: [...taskIds] },
        assignees: { some: { userId } },
        project: {
          deletedAt: null,
          status: { notIn: ['ARCHIVED', 'COMPLETED'] },
        },
      },
      select: {
        id: true,
        title: true,
        number: true,
        estimateHours: true,
        externalSource: true,
        externalKey: true,
        externalUrl: true,
        project: { select: { id: true, key: true, name: true } },
      },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200,
    });

    // ---------- Jours ----------
    type DayInfo = {
      date: string;
      dayOfWeek: number; // 0=Mon ... 6=Sun
      capacityHours: number;
      isWeekend: boolean;
      isHoliday: boolean;
      holidayName: string | null;
      isTimeOff: boolean;
      timeOffType: string | null;
      timeOffNotes: string | null;
      allocatedHours: number;
      actualMinutes: number;
      overtimeMinutes: number; // max(0, actual - capacity)
    };
    const days: DayInfo[] = [];

    // Pré-index entries & allocs par date pour le calcul par jour.
    const entriesByDate = new Map<string, number>();
    const overtimeByDate = new Map<string, number>();
    for (const e of entries) {
      const k = dateIso(e.date);
      entriesByDate.set(k, (entriesByDate.get(k) ?? 0) + e.durationMinutes);
      overtimeByDate.set(k, (overtimeByDate.get(k) ?? 0) + (e.overtimeMinutes ?? 0));
    }

    for (let t = from.getTime(); t <= to.getTime(); t += MS_PER_DAY) {
      const d = new Date(t);
      const iso = dateIso(d);
      const dow = weekdayMonFirst(d);
      const isWeekend = dow >= 5;
      const isHoliday = holidayMap.has(iso);
      const off = timeOffs.find(
        (o) => o.startDate.getTime() <= t && o.endDate.getTime() >= t,
      );
      const baseCap = scheduleHoursFor(sched, d) * occ;
      const cap = isHoliday || off ? 0 : baseCap;
      // Heures planifiées (allocations) ce jour.
      let allocH = 0;
      for (const a of allocs) {
        if (a.startDate.getTime() <= t && a.endDate.getTime() >= t) {
          allocH += a.hoursPerDay;
        }
      }
      const actualMin = entriesByDate.get(iso) ?? 0;
      // Overtime = somme déclarée par les entries (champs `overtimeMinutes`)
      // — c'est l'utilisateur qui décide explicitement combien d'heures sup
      // il déclare et sur quelle tâche, plus une dérivation arithmétique.
      const overtimeMin = overtimeByDate.get(iso) ?? 0;

      days.push({
        date: iso,
        dayOfWeek: dow,
        capacityHours: round1(cap),
        isWeekend,
        isHoliday,
        holidayName: isHoliday ? holidayMap.get(iso) ?? null : null,
        isTimeOff: !!off,
        timeOffType: off ? off.type : null,
        timeOffNotes: off ? off.notes : null,
        allocatedHours: round1(allocH),
        actualMinutes: actualMin,
        overtimeMinutes: overtimeMin,
      });
    }

    // ---------- Cellules par (taskId × date) ----------
    type CellKey = string; // `${taskId}|${dateIso}`
    const cellMap = new Map<
      CellKey,
      {
        taskId: string;
        date: string;
        allocatedHours: number;
        actualMinutes: number;
        overtimeMinutes: number;
        entryIds: string[];
      }
    >();
    const cellKey = (taskId: string, dateStr: string) => `${taskId}|${dateStr}`;

    for (const a of allocs) {
      for (let t = +a.startDate; t <= +a.endDate; t += MS_PER_DAY) {
        if (t < +from || t > +to) continue;
        const iso = dateIso(new Date(t));
        const k = cellKey(a.taskId, iso);
        const cur = cellMap.get(k) ?? {
          taskId: a.taskId,
          date: iso,
          allocatedHours: 0,
          actualMinutes: 0,
          overtimeMinutes: 0,
          entryIds: [],
        };
        cur.allocatedHours += a.hoursPerDay;
        cellMap.set(k, cur);
      }
    }
    for (const e of entries) {
      const iso = dateIso(e.date);
      const k = cellKey(e.taskId, iso);
      const cur = cellMap.get(k) ?? {
        taskId: e.taskId,
        date: iso,
        allocatedHours: 0,
        actualMinutes: 0,
        overtimeMinutes: 0,
        entryIds: [],
      };
      cur.actualMinutes += e.durationMinutes;
      cur.overtimeMinutes += e.overtimeMinutes ?? 0;
      cur.entryIds.push(e.id);
      cellMap.set(k, cur);
    }

    const cells = [...cellMap.values()].map((c) => ({
      ...c,
      allocatedHours: round1(c.allocatedHours),
    }));

    return {
      userId,
      from: dateIso(from),
      to: dateIso(to),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        countryCode: user.countryCode,
      },
      schedule: {
        hoursMon: sched.hoursMon,
        hoursTue: sched.hoursTue,
        hoursWed: sched.hoursWed,
        hoursThu: sched.hoursThu,
        hoursFri: sched.hoursFri,
        hoursSat: sched.hoursSat,
        hoursSun: sched.hoursSun,
        occupancyPct: sched.occupancyPct ?? 100,
        isDefault: !scheduleRow,
      },
      days,
      tasks: visibleTasks
        .map((t) => ({
          id: t.id,
          title: t.title,
          status: t.status as TaskStatus,
          number: t.number ?? 0,
          estimateHours: t.estimateHours,
          projectId: t.project.id,
          projectKey: t.project.key,
          projectName: t.project.name,
          externalSource: t.externalSource,
          externalKey: t.externalKey,
          externalUrl: t.externalUrl,
        }))
        .sort((a, b) => {
          if (a.projectKey !== b.projectKey) return a.projectKey < b.projectKey ? -1 : 1;
          return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
        }),
      cells: cells.filter((c) => visibleTasks.some((t) => t.id === c.taskId)),
      timeOffRows: buildTimeOffRows(timeOffs, sched, occ, holidayMap, from, to),
      addableTasks: addableRaw.map((t) => ({
        id: t.id,
        title: t.title,
        number: t.number ?? 0,
        estimateHours: t.estimateHours,
        projectId: t.project.id,
        projectKey: t.project.key,
        projectName: t.project.name,
        externalSource: t.externalSource,
        externalKey: t.externalKey,
        externalUrl: t.externalUrl,
      })),
    };
  }
}

// ---- helpers locaux ----
function toDateOnly(iso: string): Date {
  const s = iso.length === 10 ? `${iso}T00:00:00.000Z` : iso;
  const d = new Date(s);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function dateIso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function weekdayMonFirst(d: Date): number {
  return (d.getUTCDay() + 6) % 7;
}
function scheduleHoursFor(s: DaySchedule, d: Date): number {
  switch (weekdayMonFirst(d)) {
    case 0: return s.hoursMon;
    case 1: return s.hoursTue;
    case 2: return s.hoursWed;
    case 3: return s.hoursThu;
    case 4: return s.hoursFri;
    case 5: return s.hoursSat;
    case 6: return s.hoursSun;
  }
  return 0;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

const TIMEOFF_LABELS: Record<string, string> = {
  VACATION: 'Vacation',
  SICK: 'Sick leave',
  PARENTAL: 'Parental leave',
  PERSONAL: 'Personal time off',
  HOLIDAY: 'Holiday',
  OTHER: 'Time off',
};

/** Pour chaque TimeOff qui intersecte [from,to], on génère 1 ligne par type
 *  avec, pour chaque jour ouvré non-férié, les heures de capacité de base
 *  (schedule × occupancy). On ignore les jours où l'utilisateur n'aurait pas
 *  travaillé de toute façon (weekend hors planning, férié). */
function buildTimeOffRows(
  timeOffs: { startDate: Date; endDate: Date; type: string; notes: string | null }[],
  sched: DaySchedule,
  occ: number,
  holidayMap: Map<string, string>,
  from: Date,
  to: Date,
): Array<{ id: string; type: string; label: string; hoursByDate: Record<string, number> }> {
  if (timeOffs.length === 0) return [];
  const byType = new Map<string, Record<string, number>>();
  for (const off of timeOffs) {
    const start = off.startDate.getTime() < from.getTime() ? from : off.startDate;
    const end = off.endDate.getTime() > to.getTime() ? to : off.endDate;
    for (let t = +start; t <= +end; t += MS_PER_DAY) {
      const d = new Date(t);
      const iso = dateIso(d);
      if (holidayMap.has(iso)) continue; // férié : déjà 0 cap, pas d'absence à logger
      const baseCap = scheduleHoursFor(sched, d) * occ;
      if (baseCap <= 0) continue; // weekend ou jour non-travaillé : on n'affiche rien
      const key = off.type || 'OTHER';
      const m = byType.get(key) ?? {};
      m[iso] = (m[iso] ?? 0) + baseCap;
      byType.set(key, m);
    }
  }
  return [...byType.entries()].map(([type, hoursByDate]) => ({
    id: `timeoff:${type}`,
    type,
    label: TIMEOFF_LABELS[type] ?? type,
    hoursByDate,
  }));
}
