import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DependencyType, Prisma, TaskStatus } from '@db';
import { EVENTS } from '@vaks-pm/shared';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { HolidaysService } from '../holidays/holidays.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { CreateDependencyDto } from './dto/create-dependency.dto';
import { UpdateDependencyDto } from './dto/update-dependency.dto';
import {
  AssigneeAvailability,
  TaskCalendar,
  addCalendarDays,
  calendarDaysBetween,
  isoDay,
  startOfUtcDay,
} from './work-calendar';

/**
 * Durée par défaut (en jours) d'une tâche sans dates ni estimation :
 * la planification a besoin d'un minimum pour positionner les barres.
 */
const DEFAULT_TASK_DAYS = 1;

interface ScheduleNode {
  id: string;
  /** Durée en jours OUVRÉS sur le calendrier propre à la tâche. */
  durationDays: number;
  isMilestone: boolean;
  fixedStart: Date | null;
  fixedEnd: Date | null;
  cal: TaskCalendar;
  /** Toutes les dates ci-dessous sont des Date UTC à 00:00. */
  earlyStart: Date;
  earlyFinish: Date;
  lateStart: Date;
  lateFinish: Date;
}

interface EdgeOut {
  to: string;
  type: DependencyType;
  lagDays: number;
}

@Injectable()
export class DependenciesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly adminSettings: AdminSettingsService,
    private readonly holidays: HolidaysService,
  ) {}

  // ------------------------------------------------------------
  // CRUD dépendances
  // ------------------------------------------------------------

  async listForProject(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    const deps = await this.prisma.taskDependency.findMany({
      where: { projectId },
      orderBy: { createdAt: 'asc' },
    });
    return deps.map(this.toDto);
  }

  async create(orgId: string, dto: CreateDependencyDto) {
    if (dto.predecessorId === dto.successorId) {
      throw new BadRequestException(
        'Une tâche ne peut pas dépendre d\'elle-même',
      );
    }
    const [pred, succ] = await Promise.all([
      this.prisma.task.findFirst({
        where: { id: dto.predecessorId, organizationId: orgId, deletedAt: null },
        select: { id: true, projectId: true, isGroup: true, parentTaskId: true },
      }),
      this.prisma.task.findFirst({
        where: { id: dto.successorId, organizationId: orgId, deletedAt: null },
        select: { id: true, projectId: true, isGroup: true, parentTaskId: true },
      }),
    ]);
    if (!pred || !succ) throw new NotFoundException('Tâche introuvable');
    // Pas de dépendances sur les tickets externes (projet EXTERNAL) : ils ne
    // participent ni au Gantt ni à la planification.
    const proj = await this.prisma.project.findUnique({
      where: { id: pred.projectId },
      select: { kind: true },
    });
    if (proj?.kind === 'EXTERNAL') {
      throw new BadRequestException(
        'Impossible de créer une dépendance sur un ticket externe.',
      );
    }
    if (pred.projectId !== succ.projectId) {
      throw new BadRequestException(
        'Les deux tâches doivent appartenir au même projet',
      );
    }
    // Règle : pour qu'un groupe puisse démarrer, son prédécesseur doit être
    // soit un autre groupe, soit une tâche autonome (parentTaskId null) et
    // non-groupe. On évite ainsi de coupler un groupe à une sous-tâche
    // d'un autre groupe.
    if (succ.isGroup) {
      const okStandaloneTask = !pred.isGroup && pred.parentTaskId === null;
      const okGroup = pred.isGroup;
      if (!okStandaloneTask && !okGroup) {
        throw new BadRequestException(
          "A group's predecessor must be another group or a standalone task (not a member of a group).",
        );
      }
    }

    const type = dto.type ?? DependencyType.FS;
    const lagDays = dto.lagDays ?? 0;

    // Détection de cycle : on simule l'ajout et on cherche un chemin
    // pred -> ... -> succ existant ; si oui, la nouvelle arête succ->pred
    // boucle. Plus précisément on vérifie qu'aucun chemin successor -> ... -> predecessor n'existe.
    const wouldCycle = await this.pathExists(succ.id, pred.id, pred.projectId);
    if (wouldCycle) {
      throw new ConflictException('Création refusée : créerait un cycle');
    }

    try {
      const dep = await this.prisma.taskDependency.create({
        data: {
          organizationId: orgId,
          projectId: pred.projectId,
          predecessorId: pred.id,
          successorId: succ.id,
          type,
          lagDays,
        },
      });
      const out = this.toDto(dep);
      this.events.emitToProject(pred.projectId, EVENTS.DEPENDENCY_CREATED, out);
      return out;
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('Dépendance déjà existante');
      }
      throw e;
    }
  }

  async update(orgId: string, id: string, dto: UpdateDependencyDto) {
    const existing = await this.prisma.taskDependency.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Dépendance introuvable');
    const dep = await this.prisma.taskDependency.update({
      where: { id },
      data: {
        type: dto.type ?? undefined,
        lagDays: dto.lagDays ?? undefined,
      },
    });
    return this.toDto(dep);
  }

  async remove(orgId: string, id: string) {
    const existing = await this.prisma.taskDependency.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!existing) throw new NotFoundException('Dépendance introuvable');
    await this.prisma.taskDependency.delete({ where: { id } });
    this.events.emitToProject(existing.projectId, EVENTS.DEPENDENCY_DELETED, {
      id,
    });
    return { id, deleted: true };
  }

  // ------------------------------------------------------------
  // Vue Gantt : tâches + dépendances + chemin critique
  // ------------------------------------------------------------

  async gantt(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);

    const [tasks, deps, allocations] = await Promise.all([
      this.prisma.task.findMany({
        where: { projectId, organizationId: orgId, deletedAt: null },
        include: {
          assignees: {
            include: { user: { select: { id: true, name: true, email: true, countryCode: true } } },
          },
          labels: { include: { label: true } },
        },
      }),
      this.prisma.taskDependency.findMany({ where: { projectId } }),
      // Phase 5+ : les allocations explicitement posées sur une tâche (split
      // genre "2h/j sur 10 jours") doivent dicter la durée affichée sur le
      // Gantt — sinon une tâche estimée à 20h s'écraserait à 3 jours alors
      // que le user l'a étalée sur 2 semaines.
      this.prisma.allocation.findMany({
        where: { task: { projectId, organizationId: orgId, deletedAt: null } },
        select: { taskId: true, startDate: true, endDate: true },
      }),
    ]);

    // Agrège par tâche : on prend l'enveloppe [min(start), max(end)] de toutes
    // les allocations. C'est l'intervalle pendant lequel quelqu'un est censé
    // travailler dessus, même si c'est en parallèle d'autres tâches.
    const allocSpanByTask = new Map<string, { start: Date; end: Date }>();
    for (const a of allocations) {
      const cur = allocSpanByTask.get(a.taskId);
      if (!cur) {
        allocSpanByTask.set(a.taskId, { start: a.startDate, end: a.endDate });
      } else {
        if (+a.startDate < +cur.start) cur.start = a.startDate;
        if (+a.endDate > +cur.end) cur.end = a.endDate;
      }
    }

    if (tasks.length === 0) {
      const today = new Date();
      const todayIso = today.toISOString().slice(0, 10);
      return {
        projectId,
        projectStart: todayIso,
        projectEnd: todayIso,
        tasks: [],
        dependencies: [],
        criticalPathDays: 0,
      };
    }

    // ---- Construction des calendriers (par tâche, basés sur les assignés) ----
    const orgDefaultMask = await this.adminSettings.getDefaultWorkDays(orgId);
    const orgDefaultCountry = await this.holidays.getDefaultCountry(orgId);

    const assigneeUserIds = Array.from(
      new Set(tasks.flatMap((t) => t.assignees.map((a) => a.user.id))),
    );

    // Date range qu'on couvre pour fériés / time-offs : on prend large autour
    // des dates du projet pour ne rien manquer.
    let minDate = +new Date();
    let maxDate = +new Date();
    for (const t of tasks) {
      for (const d of [t.startDate, t.endDate, t.dueDate]) {
        if (!d) continue;
        if (+d < minDate) minDate = +d;
        if (+d > maxDate) maxDate = +d;
      }
    }
    for (const span of allocSpanByTask.values()) {
      if (+span.start < minDate) minDate = +span.start;
      if (+span.end > maxDate) maxDate = +span.end;
    }
    // Marge : on étend de 365 jours en avant et 60 jours en arrière pour couvrir
    // le décalage CPM éventuel et les fériés à venir.
    const calRangeFrom = addCalendarDays(startOfUtcDay(new Date(minDate)), -60);
    const calRangeTo = addCalendarDays(startOfUtcDay(new Date(maxDate)), 365);
    const rangeFromIso = isoDay(calRangeFrom);
    const rangeToIso = isoDay(calRangeTo);

    // Schedules + time-offs des assignés.
    const [schedules, timeOffs, userCountries] = await Promise.all([
      assigneeUserIds.length
        ? this.prisma.workSchedule.findMany({
            where: { userId: { in: assigneeUserIds }, organizationId: orgId },
            orderBy: { effectiveFrom: 'desc' },
          })
        : Promise.resolve([] as Awaited<ReturnType<typeof this.prisma.workSchedule.findMany>>),
      assigneeUserIds.length
        ? this.prisma.timeOff.findMany({
            where: {
              userId: { in: assigneeUserIds },
              organizationId: orgId,
              endDate: { gte: calRangeFrom },
              startDate: { lte: calRangeTo },
            },
          })
        : Promise.resolve([] as Awaited<ReturnType<typeof this.prisma.timeOff.findMany>>),
      assigneeUserIds.length
        ? this.holidays.resolveUserCountries(orgId, assigneeUserIds)
        : Promise.resolve(new Map<string, string>()),
    ]);

    // Pour chaque user, on prend le schedule le plus récent (orderBy desc).
    const scheduleByUser = new Map<string, (typeof schedules)[number]>();
    for (const s of schedules) {
      if (!scheduleByUser.has(s.userId)) scheduleByUser.set(s.userId, s);
    }

    const timeOffsByUser = new Map<string, { start: Date; end: Date }[]>();
    for (const o of timeOffs) {
      const arr = timeOffsByUser.get(o.userId) ?? [];
      arr.push({ start: startOfUtcDay(o.startDate), end: startOfUtcDay(o.endDate) });
      timeOffsByUser.set(o.userId, arr);
    }

    // Fériés par pays (ISO set) — mis en cache local pour éviter de redemander
    // au service à chaque user.
    const holidaysByCountry = new Map<string, Set<string>>();
    const getHolidays = (country: string): Set<string> => {
      const key = country.toUpperCase();
      const cached = holidaysByCountry.get(key);
      if (cached) return cached;
      const list = this.holidays.forCountryRange(key, rangeFromIso, rangeToIso);
      const s = new Set(list.map((h) => h.date));
      holidaysByCountry.set(key, s);
      return s;
    };

    const orgDefaultHolidays = getHolidays(orgDefaultCountry);

    const availabilityByUser = new Map<string, AssigneeAvailability>();
    for (const uid of assigneeUserIds) {
      const sched = scheduleByUser.get(uid);
      const mask = sched
        ? [
            sched.hoursMon > 0,
            sched.hoursTue > 0,
            sched.hoursWed > 0,
            sched.hoursThu > 0,
            sched.hoursFri > 0,
            sched.hoursSat > 0,
            sched.hoursSun > 0,
          ]
        : [...orgDefaultMask];
      const country = (userCountries.get(uid) ?? orgDefaultCountry).toUpperCase();
      availabilityByUser.set(uid, {
        workMask: mask,
        timeOffs: timeOffsByUser.get(uid) ?? [],
        holidays: getHolidays(country),
      });
    }

    const calendarFor = (t: (typeof tasks)[number]): TaskCalendar => {
      const av = t.assignees
        .map((a) => availabilityByUser.get(a.user.id))
        .filter((x): x is AssigneeAvailability => !!x);
      return new TaskCalendar(av, orgDefaultMask, orgDefaultHolidays);
    };

    // ---- Choix du "jour 0" du projet ----
    let epoch = +new Date();
    for (const t of tasks) {
      for (const d of [t.startDate, t.endDate, t.dueDate]) {
        if (d && d.getTime() < epoch) epoch = d.getTime();
      }
    }
    for (const span of allocSpanByTask.values()) {
      if (+span.start < epoch) epoch = +span.start;
    }
    const epochDate = startOfUtcDay(new Date(epoch));

    // ---- Construction des nœuds ----
    const nodes = new Map<string, ScheduleNode>();
    for (const t of tasks) {
      const cal = calendarFor(t);
      const span = allocSpanByTask.get(t.id) ?? null;
      const duration = computeDuration(t, span, cal);
      const allocStart = span ? startOfUtcDay(span.start) : null;
      const allocEnd = span ? startOfUtcDay(span.end) : null;
      const fixedStart = t.startDate
        ? startOfUtcDay(t.startDate)
        : allocStart;
      const fixedEnd = t.endDate
        ? startOfUtcDay(t.endDate)
        : t.dueDate
          ? startOfUtcDay(t.dueDate)
          : allocEnd;
      nodes.set(t.id, {
        id: t.id,
        durationDays: duration,
        isMilestone: t.isMilestone,
        fixedStart,
        fixedEnd,
        cal,
        earlyStart: epochDate,
        earlyFinish: epochDate,
        lateStart: epochDate,
        lateFinish: epochDate,
      });
    }

    // Adjacence : pred -> [{ to: succ, ... }] et inEdges pour le forward pass.
    const outEdges = new Map<string, EdgeOut[]>();
    const inEdges = new Map<string, { from: string; type: DependencyType; lagDays: number }[]>();
    const inDegree = new Map<string, number>();
    for (const id of nodes.keys()) {
      outEdges.set(id, []);
      inEdges.set(id, []);
      inDegree.set(id, 0);
    }
    for (const d of deps) {
      if (!nodes.has(d.predecessorId) || !nodes.has(d.successorId)) continue;
      outEdges.get(d.predecessorId)!.push({
        to: d.successorId,
        type: d.type,
        lagDays: d.lagDays,
      });
      inEdges.get(d.successorId)!.push({
        from: d.predecessorId,
        type: d.type,
        lagDays: d.lagDays,
      });
      inDegree.set(d.successorId, (inDegree.get(d.successorId) ?? 0) + 1);
    }

    // Tri topologique (Kahn). Si cycle (ne devrait pas arriver — empêché à la création),
    // on planifie quand même de manière dégradée en ignorant les arêtes restantes.
    const order: string[] = [];
    const queue: string[] = [];
    for (const [id, deg] of inDegree) if (deg === 0) queue.push(id);
    while (queue.length) {
      const id = queue.shift()!;
      order.push(id);
      for (const e of outEdges.get(id) ?? []) {
        const d = (inDegree.get(e.to) ?? 0) - 1;
        inDegree.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    // Compléter si cycle (mis aux mêmes positions par défaut).
    for (const id of nodes.keys()) {
      if (!order.includes(id)) order.push(id);
    }

    // ---- Forward pass — earlyStart/earlyFinish (en Date, jours ouvrés) ----
    for (const id of order) {
      const n = nodes.get(id)!;
      let esCandidate = epochDate;
      if (n.fixedStart && +n.fixedStart > +esCandidate) esCandidate = n.fixedStart;
      for (const e of inEdges.get(id) ?? []) {
        const p = nodes.get(e.from)!;
        const cand = constrainedEarlyStart(p, n, e.type, e.lagDays);
        if (+cand > +esCandidate) esCandidate = cand;
      }
      // Aligne sur le 1er jour ouvré du calendrier propre à la tâche.
      n.earlyStart = n.cal.nextWorkingDay(esCandidate);
      n.earlyFinish = n.isMilestone
        ? n.earlyStart
        : n.cal.addWorkDays(n.earlyStart, n.durationDays);
      if (n.fixedEnd && +n.fixedEnd > +n.earlyFinish) {
        n.earlyFinish = n.fixedEnd;
      }
    }

    // Fin projet = max(earlyFinish).
    let projectFinish = epochDate;
    for (const n of nodes.values()) {
      if (+n.earlyFinish > +projectFinish) projectFinish = n.earlyFinish;
    }

    // ---- Backward pass — lateFinish/lateStart ----
    for (let i = order.length - 1; i >= 0; i--) {
      const n = nodes.get(order[i])!;
      const outs = outEdges.get(n.id) ?? [];
      let lf: Date;
      if (outs.length === 0) {
        lf = projectFinish;
      } else {
        let candidate: Date | null = null;
        for (const e of outs) {
          const s = nodes.get(e.to)!;
          const c = constrainedLateFinish(n, s, e.type, e.lagDays);
          if (candidate === null || +c < +candidate) candidate = c;
        }
        lf = candidate ?? projectFinish;
      }
      n.lateFinish = lf;
      n.lateStart = n.isMilestone ? lf : n.cal.subWorkDays(lf, n.durationDays);
    }

    // Index local pour calculer la couleur effective : couleur propre du
    // groupe, sinon celle du plus proche ancêtre groupe coloré.
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const effectiveColor = (start: (typeof tasks)[number]): string | null => {
      let cur: (typeof tasks)[number] | undefined = start;
      const seen = new Set<string>();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        if (cur.color) return cur.color;
        if (!cur.parentTaskId) return null;
        cur = taskById.get(cur.parentTaskId);
      }
      return null;
    };

    // Construction du DTO de sortie. earlyFinish étant "lendemain du dernier
    // jour ouvré" (avec saut de week-end), on rembobine pour que la barre
    // Gantt se termine au jour calendaire suivant le dernier jour travaillé
    // (et ne s'étire pas visuellement sur le week-end suivant).
    const ganttTasks = tasks.map((t) => {
      const n = nodes.get(t.id)!;
      const totalSlack = Math.max(0, calendarDaysBetween(n.earlyStart, n.lateStart));
      const visualEnd = n.isMilestone ? n.earlyStart : n.cal.trimTrailingNonWorking(n.earlyFinish);
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        isMilestone: t.isMilestone,
        isGroup: t.isGroup,
        color: effectiveColor(t),
        parentTaskId: t.parentTaskId,
        progressPct: t.progressPct,
        scheduledStart: isoDay(n.earlyStart),
        scheduledEnd: isoDay(visualEnd),
        totalSlack,
        critical: +n.lateStart <= +n.earlyStart,
        assignees: t.assignees.map((a) => ({
          userId: a.user.id,
          name: a.user.name,
          email: a.user.email,
          countryCode: a.user.countryCode ?? null,
        })),
        labels: t.labels.map((l) => ({
          id: l.label.id,
          name: l.label.name,
          color: l.label.color,
        })),
      };
    });

    // Idem pour projectEnd : max des fins visuelles (sans week-end de queue).
    let projectVisualEnd = epochDate;
    for (const t of tasks) {
      const n = nodes.get(t.id)!;
      const ve = n.isMilestone ? n.earlyStart : n.cal.trimTrailingNonWorking(n.earlyFinish);
      if (+ve > +projectVisualEnd) projectVisualEnd = ve;
    }

    return {
      projectId,
      projectStart: isoDay(epochDate),
      projectEnd: isoDay(projectVisualEnd),
      tasks: ganttTasks,
      dependencies: deps.map(this.toDto),
      criticalPathDays: calendarDaysBetween(epochDate, projectVisualEnd),
    };
  }

  // ------------------------------------------------------------
  // Helpers internes
  // ------------------------------------------------------------

  private async assertProject(orgId: string, projectId: string) {
    // `kind: STANDARD` : pas de Gantt ni de listing de dépendances sur un
    // conteneur de tickets externes — il n'existe pas pour la planification.
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null, kind: 'STANDARD' },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
  }

  /**
   * Existe-t-il un chemin de `from` à `to` via les dépendances déjà en base ?
   * Sert à empêcher les cycles à la création.
   */
  private async pathExists(
    from: string,
    to: string,
    projectId: string,
  ): Promise<boolean> {
    const deps = await this.prisma.taskDependency.findMany({
      where: { projectId },
      select: { predecessorId: true, successorId: true },
    });
    const adj = new Map<string, string[]>();
    for (const d of deps) {
      const arr = adj.get(d.predecessorId) ?? [];
      arr.push(d.successorId);
      adj.set(d.predecessorId, arr);
    }
    const stack = [from];
    const seen = new Set<string>();
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === to) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const n of adj.get(cur) ?? []) stack.push(n);
    }
    return false;
  }

  private toDto(d: {
    id: string;
    projectId: string;
    predecessorId: string;
    successorId: string;
    type: DependencyType;
    lagDays: number;
    createdAt: Date;
  }) {
    return {
      id: d.id,
      projectId: d.projectId,
      predecessorId: d.predecessorId,
      successorId: d.successorId,
      type: d.type,
      lagDays: d.lagDays,
      createdAt: d.createdAt.toISOString(),
    };
  }
}

// ============================================================
// Helpers purs
// ============================================================

/**
 * Durée d'une tâche EN JOURS OUVRÉS sur le calendrier propre à la tâche.
 * Cohérent avec la sémantique "Je peux faire avancer la tâche pendant N
 * jours où mes assignés sont disponibles".
 */
function computeDuration(
  t: {
    startDate: Date | null;
    endDate: Date | null;
    dueDate: Date | null;
    estimateHours: number | null;
    isMilestone: boolean;
  },
  allocSpan: { start: Date; end: Date } | null = null,
  cal?: TaskCalendar,
): number {
  if (t.isMilestone) return 0;
  // 1) Dates explicites sur la tâche : source de vérité absolue. On compte
  //    les jours ouvrés inclusifs entre startDate et (endDate ?? dueDate).
  if (t.startDate && (t.endDate ?? t.dueDate) && cal) {
    const end = t.endDate ?? t.dueDate!;
    const days = cal.workDaysBetween(
      startOfUtcDay(t.startDate),
      addCalendarDays(startOfUtcDay(end), 1),
    );
    return Math.max(DEFAULT_TASK_DAYS, days);
  }
  // 2) Allocations explicites : enveloppe en jours ouvrés.
  if (allocSpan && cal) {
    const days = cal.workDaysBetween(
      startOfUtcDay(allocSpan.start),
      addCalendarDays(startOfUtcDay(allocSpan.end), 1),
    );
    return Math.max(DEFAULT_TASK_DAYS, days);
  }
  // 3) Fallback estimation (1j ouvré = 8h capacité par défaut).
  if (t.estimateHours && t.estimateHours > 0) {
    return Math.max(DEFAULT_TASK_DAYS, Math.ceil(t.estimateHours / 8));
  }
  return DEFAULT_TASK_DAYS;
}

/**
 * Borne inférieure de earlyStart du successeur à partir du prédécesseur
 * et du type de dépendance. Le lag est compté en jours ouvrés sur le
 * calendrier du successeur (convention MS Project).
 */
function constrainedEarlyStart(
  pred: ScheduleNode,
  succ: ScheduleNode,
  type: DependencyType,
  lag: number,
): Date {
  const succCal = succ.cal;
  switch (type) {
    case DependencyType.FS:
      // succ.es >= pred.ef + lag
      return succCal.addWorkDays(pred.earlyFinish, lag);
    case DependencyType.SS:
      // succ.es >= pred.es + lag
      return succCal.addWorkDays(pred.earlyStart, lag);
    case DependencyType.FF: {
      // succ.ef >= pred.ef + lag → succ.es = succ.ef - duration
      const ef = succCal.addWorkDays(pred.earlyFinish, lag);
      return succCal.subWorkDays(ef, succ.durationDays);
    }
    case DependencyType.SF: {
      // succ.ef >= pred.es + lag
      const ef = succCal.addWorkDays(pred.earlyStart, lag);
      return succCal.subWorkDays(ef, succ.durationDays);
    }
  }
}

/**
 * Borne supérieure de lateFinish du prédécesseur à partir du successeur
 * et du type de dépendance. Lag compté en jours ouvrés sur le calendrier
 * du successeur.
 */
function constrainedLateFinish(
  pred: ScheduleNode,
  succ: ScheduleNode,
  type: DependencyType,
  lag: number,
): Date {
  const succCal = succ.cal;
  const predCal = pred.cal;
  switch (type) {
    case DependencyType.FS:
      // pred.lf <= succ.ls - lag
      return succCal.subWorkDays(succ.lateStart, lag);
    case DependencyType.SS: {
      // pred.ls <= succ.ls - lag → pred.lf = pred.ls + duration
      const ls = succCal.subWorkDays(succ.lateStart, lag);
      return predCal.addWorkDays(ls, pred.durationDays);
    }
    case DependencyType.FF:
      // pred.lf <= succ.lf - lag
      return succCal.subWorkDays(succ.lateFinish, lag);
    case DependencyType.SF: {
      // pred.ls <= succ.lf - lag
      const ls = succCal.subWorkDays(succ.lateFinish, lag);
      return predCal.addWorkDays(ls, pred.durationDays);
    }
  }
}
