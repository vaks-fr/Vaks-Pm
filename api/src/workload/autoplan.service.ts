import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { HolidaysService } from '../holidays/holidays.service';
import {
  Allocation,
  Prisma,
  ProjectStatus,
  Task,
  TaskPriority,
  TaskStatus,
  TimeOff,
  WorkSchedule,
} from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { CapacityService, UserCapacityCtx } from './capacity.service';
import { AutoplanRequestDto } from './dto/autoplan.dto';
import {
  addDays,
  AssigneeCandidate,
  computeSchedule,
  computeTopoOrder,
  computeTransitiveDependents,
  dateIso,
  selectAssignees,
  startOfUtcDay,
  weekdayMonFirst,
} from './scheduling';

const MS_PER_DAY = 86_400_000;
/** Horizon de planification par défaut quand l'appelant ne borne pas `to` :
 *  on planifie TOUT le scope (projet/global), pas la fenêtre d'affichage.
 *  2 ans couvre la quasi-totalité des projets ; le rare débordement reste un
 *  warning `user_saturated`. La fenêtre semaine/mois de la vue ne sert plus
 *  qu'à l'affichage de la grille. */
const PLAN_HORIZON_DAYS = 730;
/** Tolérance pour comparer des heures/jour (split flottant éventuel). */
const HOURS_EPS = 0.01;

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  URGENT: 4,
  HIGH: 2,
  NORMAL: 1,
  LOW: 0.5,
};

/**
 * Poids du score d'ordonnancement (départage les tâches comparables ; l'ordre
 * topologique reste la contrainte dure au-dessus). Chaque composante est
 * normalisée à ~[0,1] avant pondération → l'ordre des poids reflète vraiment
 * la hiérarchie voulue : priorité métier > chemin critique > prérequis
 * (dépendants) > urgence (échéance) > compétence.
 */
const SCORE_WEIGHTS = {
  priority: 5,
  critical: 4,
  dependents: 3,
  due: 2,
  skill: 1,
};

export interface ProposedAllocation {
  userId: string;
  taskId: string;
  projectId: string;
  startDate: string; // ISO date
  endDate: string;
  hoursPerDay: number;
  // Champs enrichis pour l'UI (ajoutés en post-traitement).
  userName?: string;
  taskTitle?: string;
  projectKey?: string;
}

export interface EnrichedAllocation {
  id: string;
  userId: string;
  taskId: string;
  projectId: string;
  startDate: string;
  endDate: string;
  hoursPerDay: number;
  isManual: boolean;
  isAutoPlan: boolean;
  userName?: string;
  taskTitle?: string;
  projectKey?: string;
}

export interface AutoplanWarning {
  taskId: string;
  taskTitle?: string;
  type:
    | 'missing_estimate'
    | 'deadline_overflow'
    | 'user_saturated'
    | 'unassigned'
    | 'outside_window';
  message: string;
  missingHours?: number;
}

/** Proposition d'affectation pour une tâche sans assigné (feature autoAssign). */
export interface ProposedAssignment {
  taskId: string;
  taskTitle?: string;
  projectId: string;
  projectKey?: string;
  /** Assignee(s) retenu(s) (auto ou override PM). */
  chosen: AssigneeCandidate[];
  /** Autres candidats qualifiés & disponibles (pool de swap côté UI). */
  alternatives: AssigneeCandidate[];
  source: 'auto' | 'override';
  warning?: 'no_candidates' | 'no_qualified' | 'capacity_short';
  /** Vrai si la tâche était déjà assignée (proposition de réassignation). */
  wasAssigned?: boolean;
}

export interface AutoplanResult {
  proposed: ProposedAllocation[];
  current: EnrichedAllocation[];
  diff: {
    added: ProposedAllocation[];
    removed: EnrichedAllocation[];
    modified: { before: EnrichedAllocation; after: ProposedAllocation }[];
  };
  warnings: AutoplanWarning[];
  /** Affectations proposées pour les tâches sans assigné (vide si autoAssign
   *  désactivé). En preview = suggestion ; persistées (TaskAssignee) si
   *  `persist` + `autoAssign`. */
  assignments: ProposedAssignment[];
}

interface TaskNode {
  task: Task;
  remainingHours: number;
  earliestStartOffset: number; // jours depuis epoch (du fait des deps)
  scoreCache?: number;
  scheduledEnd?: Date; // remplie après placement
}

@Injectable()
export class AutoplanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly holidays: HolidaysService,
    private readonly capacity: CapacityService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Hooks d'automatisation résolus en **lazy** : `AutomationsModule` importe
   * `WorkloadModule`, un import direct dans l'autre sens créerait un cycle.
   * Best-effort — muet si le module n'est pas monté.
   */
  private automationHooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Calcule un plan complet pour le scope demandé, optionnellement persiste.
   * Mode preview (persist=false) par défaut.
   */
  async run(orgId: string, dto: AutoplanRequestDto): Promise<AutoplanResult> {
    const now = startOfUtcDay(new Date());
    // Gel du passé : l'auto-plan ne crée/remplace qu'à partir de DEMAIN. Toute
    // allocation commençant aujourd'hui ou avant est intouchable (déjà en
    // cours / faite). Le cutoff est aussi le plancher de planification.
    const cutoff = addDays(now, 1);
    const from = dto.from ? startOfUtcDay(new Date(dto.from)) : cutoff;
    const to = dto.to
      ? startOfUtcDay(new Date(dto.to))
      : addDays(from, PLAN_HORIZON_DAYS);
    if (to.getTime() < from.getTime()) {
      throw new BadRequestException('to must be on or after from');
    }
    const preserve = dto.preserve ?? 'manual_autosplit';
    // Réassignation (mode suggestion) : on propose AUSSI les tâches déjà
    // assignées (par défaut sur leur assigné actuel) pour permettre au PM d'en
    // swapper l'assigné. Indépendant du mode de préservation — le swap ne touche
    // que la tâche concernée (retrait de l'ancien assigné + ses allocations
    // futures, ajout du nouveau). Hors scope=user.
    const reassign = dto.reassignAssigned === true && dto.scope !== 'user';

    // -------- 1. Charger le scope --------
    // Important : on NE filtre PLUS les users via `projectMembers` parce
    // qu'on veut planifier pour TOUS les assignees des tâches en scope,
    // même s'ils n'ont pas été (encore) ajoutés en tant que membres du
    // projet. Sinon, assigner quelqu'un de nouveau à une tâche puis
    // lancer un auto-plan le ferait skipper silencieusement.
    // On ne planifie que les projets LANCÉS (ACTIVE) et les tâches À FAIRE ou
    // EN COURS (TODO / IN_PROGRESS) : pas les projets DRAFT/CHARTER_REVIEW/
    // COMPLETED/ARCHIVED (leurs tâches ne sont pas accessibles, ex. archivé
    // masqué du sélecteur), ni les tâches IN_REVIEW/DONE.
    const taskWhere: Prisma.TaskWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      status: { in: [TaskStatus.TODO, TaskStatus.IN_PROGRESS] },
      // `kind: STANDARD` : les tickets d'outils externes (projets EXTERNAL,
      // timesheet only) ne sont jamais auto-planifiés.
      project: { status: ProjectStatus.ACTIVE, kind: 'STANDARD' },
    };
    if (dto.scope === 'project') {
      if (!dto.projectId) throw new BadRequestException('projectId requis pour scope=project');
      taskWhere.projectId = dto.projectId;
    } else if (dto.scope === 'user') {
      if (!dto.userId) throw new BadRequestException('userId requis pour scope=user');
      taskWhere.assignees = { some: { userId: dto.userId } };
    }

    const tasks = await this.prisma.task.findMany({
      where: taskWhere,
      include: { assignees: { select: { userId: true } } },
    });

    // -------- Skill match (bonus de score d'ordonnancement) --------
    // On précharge le niveau de chaque assignee sur le skill requis de sa
    // tâche, pour donner un bonus de priorité aux tâches dont les assignees
    // sont effectivement compétents — sans exclure les autres (per choix
    // produit : "skill = score pondéré uniquement").
    const skillMaxLevel = await this.settings.getSkillsMaxLevel(orgId);
    const skillReqByTask = new Map<string, { skillId: string; level: number | null }>();
    for (const t of tasks) {
      if (t.requiredSkillId) {
        skillReqByTask.set(t.id, {
          skillId: t.requiredSkillId,
          level: t.requiredSkillLevel ?? null,
        });
      }
    }
    const skillIdsInScope = Array.from(
      new Set(Array.from(skillReqByTask.values()).map((s) => s.skillId)),
    );
    const skillRows = skillIdsInScope.length
      ? await this.prisma.userSkill.findMany({
          where: { skillId: { in: skillIdsInScope } },
          select: { userId: true, skillId: true, level: true },
        })
      : [];
    const userLevelOnSkill = new Map<string, number>(); // key = userId|skillId
    for (const r of skillRows) {
      userLevelOnSkill.set(`${r.userId}|${r.skillId}`, r.level);
    }
    /** Bonus 0..5 : couverture moyenne du skill requis par les assignees. */
    const skillBonus = (taskId: string, assigneeIds: string[]): number => {
      const req = skillReqByTask.get(taskId);
      if (!req || assigneeIds.length === 0) return 0;
      const target = req.level && req.level > 0 ? req.level : skillMaxLevel;
      let sum = 0;
      for (const uid of assigneeIds) {
        const lvl = userLevelOnSkill.get(`${uid}|${req.skillId}`) ?? 0;
        sum += Math.min(1, lvl / target);
      }
      return (sum / assigneeIds.length) * 5; // pondération 0..5
    };

    // -------- Temps déjà loggé (remonté : l'auto-affectation en a besoin) -----
    // (6) Soustraire le temps déjà loggé : une tâche estimée 40h dont 30h sont
    // déjà loguées ne doit être replanifiée que pour 10h restants.
    const timeAgg = tasks.length
      ? await this.prisma.timeEntry.groupBy({
          by: ['taskId'],
          where: { organizationId: orgId, taskId: { in: tasks.map((t) => t.id) } },
          _sum: { durationMinutes: true },
        })
      : [];
    const loggedHoursByTask = new Map<string, number>();
    for (const row of timeAgg) {
      loggedHoursByTask.set(row.taskId, (row._sum.durationMinutes ?? 0) / 60);
    }

    // h/jour de l'org (réutilisé plus bas pour le schedule par défaut).
    const hoursPerDay = await this.settings.getHoursPerDay(orgId);

    // -------- Affectation assistée (feature autoAssign) --------
    // Pour les tâches SANS assigné (et, si `reassign`, aussi celles déjà
    // assignées), on choisit le(s) candidat(s) (skill requis + capacité réelle)
    // parmi les membres du projet / des équipes affectées, puis on les injecte
    // dans `task.assignees` en mémoire pour qu'ils suivent tout le pipeline
    // normal (split pondéré, placement). Ignoré pour scope=user.
    // `assignmentChanges` (delta add/remove par tâche) sert ensuite à
    // réconcilier les TaskAssignee à la persistance.
    let assignments: ProposedAssignment[] = [];
    // Changements d'affectation à persister : par tâche, les users à ajouter et
    // à retirer (vide tant que rien ne change — défaut « garder l'assigné »).
    let assignmentChanges = new Map<string, { add: string[]; remove: string[] }>();
    if (dto.autoAssign && dto.scope !== 'user') {
      const res = await this.autoAssignTasks(orgId, {
        tasks,
        cutoff,
        to,
        hoursPerDay,
        loggedHoursByTask,
        skillMaxLevel,
        userLevelOnSkill,
        overrides: dto.assignmentOverrides,
        reassign,
      });
      assignments = res.assignments;
      assignmentChanges = res.assignmentChanges;
    }

    // Union des userIds qui apparaissent comme assignees sur les tâches du
    // scope (inclut désormais les assignees auto-choisis ci-dessus). Pour
    // scope=user, on borne en plus à `dto.userId` (sinon on ramènerait les
    // co-assignees alors qu'on veut planifier juste un user).
    const assigneeIdSet = new Set<string>();
    for (const t of tasks) for (const a of t.assignees) assigneeIdSet.add(a.userId);
    if (dto.scope === 'user' && dto.userId) {
      for (const id of Array.from(assigneeIdSet)) {
        if (id !== dto.userId) assigneeIdSet.delete(id);
      }
    }

    const users = assigneeIdSet.size
      ? await this.prisma.user.findMany({
          where: {
            id: { in: Array.from(assigneeIdSet) },
            organizationId: orgId,
            deletedAt: null,
            status: 'ACTIVE',
            // Agents IA hors auto-plan : leur capacité n'est pas des heures.
            kind: 'HUMAN',
          },
          select: { id: true, countryCode: true },
        })
      : [];

    const inScopeUserIds = new Set(users.map((u) => u.id));
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const inScopeTaskIds = new Set(tasks.map((t) => t.id));

    // Prédicat central : une allocation est REMPLAÇABLE (l'auto-plan peut la
    // supprimer/recréer) ssi elle est dans le futur (>= cutoff = demain), sur
    // une tâche du scope, ET son origine est visée par le mode de préservation.
    // Tout le reste est CONSERVÉ : passé/aujourd'hui gelé, manuel préservé,
    // auto-split préservé selon le mode, allocations d'autres projets.
    const matchesPreserve = (a: { isManual: boolean; isAutoPlan: boolean }): boolean => {
      if (preserve === 'none') return true; // remplace tout (futur in-scope)
      if (preserve === 'manual') return !a.isManual; // remplace auto-plan + auto-split
      return a.isAutoPlan; // 'manual_autosplit' : ne remplace que l'auto-plan
    };
    const replaceable = (a: {
      startDate: Date;
      taskId: string;
      isManual: boolean;
      isAutoPlan: boolean;
    }): boolean =>
      +a.startDate >= +cutoff &&
      inScopeTaskIds.has(a.taskId) &&
      matchesPreserve(a);

    // (loggedHoursByTask est désormais calculé plus haut, avant l'auto-affectation.)

    // Dépendances : on prend toutes celles du périmètre projet(s) concerné(s)
    // pour pouvoir suivre les chaînes. Si scope=user, on charge celles dont
    // les tâches sont impliquées.
    const projectIds = Array.from(new Set(tasks.map((t) => t.projectId)));
    const dependencies = projectIds.length
      ? await this.prisma.taskDependency.findMany({
          where: { projectId: { in: projectIds } },
        })
      : [];

    // Tâches assignées à au moins un user dans le scope, avec estimate > 0.
    // (Une tâche peut avoir plusieurs assignees ; on planifie pour chacun.)
    const warnings: AutoplanWarning[] = [];
    const planNodes: { node: TaskNode; userId: string }[] = [];
    // Les planNodes (répartition des heures restantes d'une tâche entre ses
    // assignees) sont construits plus bas, APRÈS le calcul de la capacité par
    // user, pour que le split soit proportionnel à la disponibilité réelle de
    // chacun (cf. « Construire les planNodes »). On ne peut pas le faire ici :
    // la capacité n'est pas encore connue.

    // -------- 2. Charger schedules / time-offs / allocations existantes --------
    // Tous les assignees in-scope (les planNodes ne sont pas encore construits).
    const userIds = Array.from(inScopeUserIds);
    const [schedules, timeOffs, existingAllocs, defaultCountry] =
      await Promise.all([
        this.prisma.workSchedule.findMany({
          where: { userId: { in: userIds }, organizationId: orgId, effectiveFrom: { lte: to } },
          orderBy: { effectiveFrom: 'desc' },
        }),
        this.prisma.timeOff.findMany({
          where: {
            userId: { in: userIds },
            organizationId: orgId,
            startDate: { lte: to },
            endDate: { gte: from },
          },
        }),
        // Important : cross-projets (pas de filtre projectId).
        this.prisma.allocation.findMany({
          where: {
            userId: { in: userIds },
            organizationId: orgId,
            startDate: { lte: to },
            endDate: { gte: from },
          },
        }),
        this.holidays.getDefaultCountry(orgId),
      ]);

    // (3) Fériés par user : on dérive son countryCode (fallback org default),
    // puis on précalcule les ISO des fériés sur la fenêtre. Réutilisé dans
    // le calcul de capacité.
    const countryByUser = new Map<string, string>();
    for (const u of users) {
      countryByUser.set(
        u.id,
        ((u.countryCode ?? null) || defaultCountry).toUpperCase(),
      );
    }
    const fromIso = dateIso(from);
    const toIso = dateIso(to);
    const holidaysByCountry = new Map<string, Set<string>>();
    const uniqueCountries = new Set(countryByUser.values());
    for (const cc of uniqueCountries) {
      holidaysByCountry.set(
        cc,
        new Set(this.holidays.forCountryRange(cc, fromIso, toIso).map((h) => h.date)),
      );
    }

    const scheduleByUser = new Map<string, WorkSchedule>();
    for (const s of schedules) if (!scheduleByUser.has(s.userId)) scheduleByUser.set(s.userId, s);
    // Schedule virtuel pour les users sans WorkSchedule custom (réutilise
    // `hoursPerDay` déjà chargé plus haut).
    const defHours = hoursPerDay;
    const defDays = await this.settings.getDefaultWorkDays(orgId);
    const defaultSchedule = {
      hoursMon: defDays[0] ? defHours : 0,
      hoursTue: defDays[1] ? defHours : 0,
      hoursWed: defDays[2] ? defHours : 0,
      hoursThu: defDays[3] ? defHours : 0,
      hoursFri: defDays[4] ? defHours : 0,
      hoursSat: defDays[5] ? defHours : 0,
      hoursSun: defDays[6] ? defHours : 0,
      occupancyPct: 100,
    } as Pick<WorkSchedule, 'hoursMon'|'hoursTue'|'hoursWed'|'hoursThu'|'hoursFri'|'hoursSat'|'hoursSun'|'occupancyPct'>;
    const timeOffsByUser = groupBy(timeOffs, (t) => t.userId);
    // Capacité : on ne soustrait QUE les allocations conservées (= non
    // remplaçables). Sinon l'auto-plan planifie « autour » de ses propres
    // allocations qu'il va pourtant supprimer → plan non idempotent (dérive à
    // chaque application). Les gelées futures (passé débordant) restent bien
    // soustraites ; celles du passé strict sont hors fenêtre [from,to].
    const keptAllocs = existingAllocs.filter((a) => !replaceable(a));
    const allocsByUser = groupBy(keptAllocs, (a) => a.userId);

    // Heures effectives d'une allocation pour son user (jours ouvrés réels ×
    // h/j), pour ne pas re-planifier ce que les allocations CONSERVÉES
    // couvrent déjà (sinon double-planification : 40h manuelles préservées +
    // 40h replanifiées = 80h sur la tâche).
    const effectiveHoursOf = (a: Allocation): number => {
      const sched = scheduleByUser.get(a.userId) ?? defaultSchedule;
      const occ = (sched?.occupancyPct ?? 100) / 100;
      const offs = timeOffsByUser.get(a.userId) ?? [];
      const cc = countryByUser.get(a.userId) ?? defaultCountry.toUpperCase();
      const holidaySet = holidaysByCountry.get(cc) ?? new Set<string>();
      let sum = 0;
      for (let cur = +a.startDate; cur <= +a.endDate; cur += MS_PER_DAY) {
        const d = new Date(cur);
        if (scheduleHoursFor(sched, d) * occ <= 0) continue;
        if (offs.some((o) => +o.startDate <= cur && +o.endDate >= cur)) continue;
        if (holidaySet.has(dateIso(d))) continue;
        sum += a.hoursPerDay;
      }
      return sum;
    };
    // keptHours[userId|taskId] = heures déjà couvertes par les allocations
    // conservées sur les tâches du scope.
    const keptHoursByUserTask = new Map<string, number>();
    for (const a of keptAllocs) {
      if (!inScopeTaskIds.has(a.taskId)) continue;
      const k = `${a.userId}|${a.taskId}`;
      keptHoursByUserTask.set(k, (keptHoursByUserTask.get(k) ?? 0) + effectiveHoursOf(a));
    }
    // (La soustraction des heures déjà couvertes par les allocations
    // conservées est appliquée plus bas, après la construction des planNodes.)

    // Warning proactif `outside_window` : la fenêtre [startDate, dueDate] propre
    // à la tâche est mathématiquement trop courte pour son effort, même à
    // pleine capacité de tous ses assignees en parallèle (indépendant de la
    // contention avec les autres tâches — ça, c'est `deadline_overflow`).
    const dailyDefHours = (d: Date) =>
      scheduleHoursFor(defaultSchedule, d) * ((defaultSchedule.occupancyPct ?? 100) / 100);
    for (const t of tasks) {
      if (!t.startDate || !t.dueDate || t.estimateHours == null || t.estimateHours <= 0) continue;
      const nAssignees = t.assignees.filter((a) => inScopeUserIds.has(a.userId)).length;
      if (nAssignees === 0) continue;
      const wStart = startOfUtcDay(t.startDate);
      const wEnd = startOfUtcDay(t.dueDate);
      if (+wEnd < +wStart) continue;
      let windowHours = 0;
      for (let cur = +wStart; cur <= +wEnd; cur += MS_PER_DAY) {
        windowHours += dailyDefHours(new Date(cur));
      }
      windowHours *= nAssignees;
      const logged = loggedHoursByTask.get(t.id) ?? 0;
      const needed = Math.max(0, t.estimateHours - logged);
      if (needed > windowHours + HOURS_EPS) {
        warnings.push({
          taskId: t.id,
          type: 'outside_window',
          message: `Tâche "${t.title}" : sa fenêtre de dates (${dateIso(wStart)} → ${dateIso(wEnd)}) est trop courte — ${round(needed)}h à placer pour ~${round(windowHours)}h de capacité disponible sur la fenêtre (${nAssignees} assigné${nAssignees > 1 ? 's' : ''}).`,
          missingHours: round(needed - windowHours),
        });
      }
    }

    // -------- 3. CPM complet (forward + backward + slack) sur le graphe --------
    // `computeSchedule` fait un vrai backward-pass : on récupère, par tâche, sa
    // date au plus tôt (plancher de placement) ET son mou total (`totalSlack`)
    // qui pilote la priorité (point 4 : leveling — les tâches à fort mou cèdent
    // la capacité précoce aux tâches critiques).
    const schedule = computeSchedule(tasks, dependencies, from, defHours);
    const earliestStartByTask = new Map(
      Array.from(schedule, ([id, s]) => [id, s.earlyStart] as const),
    );

    // -------- 4. Ordre de traitement : topo des deps × score décroissant --------
    // Compter les dépendants transitifs par tâche.
    const dependentsCount = computeTransitiveDependents(tasks, dependencies);

    // Calcul du score : départage les tâches COMPARABLES (l'ordre topo reste
    // la contrainte dure au-dessus → un prérequis passe toujours avant son
    // successeur). Chaque composante est normalisée à ~[0,1] puis pondérée par
    // SCORE_WEIGHTS, pour une hiérarchie lisible et réglable :
    //   priorité métier > chemin critique > prérequis (dépendants) > urgence
    //   (échéance) > compétence.
    const maxDependents = Math.max(1, ...Array.from(dependentsCount.values()));
    const scoreFor = (n: TaskNode): number => {
      if (n.scoreCache != null) return n.scoreCache;
      const t = n.task;
      // Priorité métier 0..1 (URGENT=4 → 1, LOW=0.5 → 0.125).
      const prio = (PRIORITY_WEIGHT[t.priority] ?? 1) / 4;
      // Urgence 0..1 : 1 si due aujourd'hui, → 0 si lointaine ; 0 sans échéance.
      const daysToDue = t.dueDate
        ? Math.max(1, Math.ceil((+startOfUtcDay(t.dueDate) - +now) / MS_PER_DAY))
        : Number.POSITIVE_INFINITY;
      const urgency = t.dueDate ? 1 / daysToDue : 0;
      // « Prérequis-ité » 0..1 : combien de tâches cette tâche bloque.
      const deps = (dependentsCount.get(t.id) ?? 0) / maxDependents;
      // Criticité 0..1 dérivée du **mou réel** (backward-pass) : 1 si mou nul
      // (chemin critique), décroît continûment avec le slack. Remplace l'ancien
      // booléen heuristique → encode le leveling (une tâche à fort mou pèse
      // moins, cède la capacité précoce aux tâches tendues).
      const slack = schedule.get(t.id)?.totalSlack ?? Number.POSITIVE_INFINITY;
      const crit = 1 / (1 + slack);
      const assigneeIds = (t as Task & { assignees?: { userId: string }[] }).assignees?.map(
        (a) => a.userId,
      ) ?? [];
      const skill = skillBonus(t.id, assigneeIds) / 5; // skillBonus ∈ [0,5]
      const s =
        SCORE_WEIGHTS.priority * prio +
        SCORE_WEIGHTS.critical * crit +
        SCORE_WEIGHTS.dependents * deps +
        SCORE_WEIGHTS.due * urgency +
        SCORE_WEIGHTS.skill * skill;
      n.scoreCache = s;
      return s;
    };

    // (8) Préparer un ordre topologique global des tâches pour que les
    // dépendances inter-users soient respectées : on doit placer la tâche
    // prédécesseur AVANT son successor, peu importe qui en sont les
    // assignees. À score égal, on prend l'ordre topo.
    const taskTopoOrder = computeTopoOrder(tasks, dependencies);
    const taskTopoRank = new Map(taskTopoOrder.map((id, i) => [id, i]));

    // Pré-indexe les prédécesseurs par tâche pour la propagation des
    // scheduledEnd réels (cross-user).
    const predsByTask = new Map<string, { predId: string; type: string; lagDays: number }[]>();
    for (const t of tasks) predsByTask.set(t.id, []);
    for (const d of dependencies) {
      if (!predsByTask.has(d.successorId)) continue;
      predsByTask.get(d.successorId)!.push({
        predId: d.predecessorId,
        type: d.type,
        lagDays: d.lagDays,
      });
    }

    // -------- 4. Construire la capacité par user (constant pour la passe) --------
    const dayCount = Math.max(1, Math.round((+to - +from) / MS_PER_DAY) + 1);
    const capacityByUser = new Map<string, Float64Array>();
    for (const userId of inScopeUserIds) {
      const sched = scheduleByUser.get(userId) ?? defaultSchedule;
      const offs = timeOffsByUser.get(userId) ?? [];
      const existing = allocsByUser.get(userId) ?? [];
      const cc = countryByUser.get(userId) ?? defaultCountry.toUpperCase();
      const holidaySet = holidaysByCountry.get(cc) ?? new Set<string>();

      const capacity = new Float64Array(dayCount);
      for (let i = 0; i < dayCount; i++) {
        const d = addDays(from, i);
        let cap = scheduleHoursFor(sched, d) * ((sched?.occupancyPct ?? 100) / 100);
        if (offs.some((o) => +o.startDate <= +d && +o.endDate >= +d)) cap = 0;
        // (3) Férié pour ce user → capacité 0.
        if (holidaySet.has(dateIso(d))) cap = 0;
        capacity[i] = cap;
      }
      // Soustraire allocations existantes (manuelles + autres auto-plans).
      for (const a of existing) {
        const startIdx = Math.max(0, Math.round((+a.startDate - +from) / MS_PER_DAY));
        const endIdx = Math.min(dayCount - 1, Math.round((+a.endDate - +from) / MS_PER_DAY));
        for (let i = startIdx; i <= endIdx; i++) capacity[i] = Math.max(0, capacity[i] - a.hoursPerDay);
      }
      capacityByUser.set(userId, capacity);
    }

    // -------- Construire les planNodes (split pondéré par la capacité) --------
    // Disponibilité totale de chaque user sur l'horizon = somme de sa capacité
    // nette (schedule × occupancy − fériés/time-offs − allocations CONSERVÉES).
    // Sert de poids pour répartir les heures restantes d'une tâche entre ses
    // assignees : un assignee déjà chargé (peu de capacité libre) reçoit une
    // part plus faible, au lieu d'un partage égal aveugle qui le sur-saturait.
    // Stable entre deux runs (les allocs auto-plan sont remplaçables, donc
    // exclues de la capacité) → split idempotent.
    const freeCapTotalByUser = new Map<string, number>();
    for (const [uid, cap] of capacityByUser) {
      let sum = 0;
      for (let i = 0; i < cap.length; i++) sum += cap[i];
      freeCapTotalByUser.set(uid, sum);
    }

    for (const t of tasks) {
      const assigneeIds = t.assignees
        .map((a) => a.userId)
        .filter((uid) => inScopeUserIds.has(uid));
      if (assigneeIds.length === 0) continue; // unassigned → skip silencieux (spec)
      if (t.estimateHours == null || t.estimateHours <= 0) {
        warnings.push({
          taskId: t.id,
          type: 'missing_estimate',
          message: `Tâche "${t.title}" — estimate manquant, non planifiable.`,
        });
        continue;
      }
      // Heures restantes = estimate − temps déjà loggé. Si la tâche est déjà
      // au-delà de son estimate, on la skippe silencieusement (rien à
      // replanifier).
      const logged = loggedHoursByTask.get(t.id) ?? 0;
      const remainingTaskHours = Math.max(0, t.estimateHours - logged);
      if (remainingTaskHours < HOURS_EPS) continue;
      // Split pondéré par la capacité libre de chaque assignee. Si tous sont
      // saturés (Σ poids ≈ 0), on retombe sur un partage égal — le placement
      // émettra alors un `user_saturated`.
      const weights = assigneeIds.map((uid) =>
        Math.max(0, freeCapTotalByUser.get(uid) ?? 0),
      );
      const wSum = weights.reduce((a, b) => a + b, 0);
      assigneeIds.forEach((uid, k) => {
        const share =
          wSum > HOURS_EPS
            ? remainingTaskHours * (weights[k] / wSum)
            : remainingTaskHours / assigneeIds.length;
        planNodes.push({
          userId: uid,
          node: { task: t, remainingHours: share, earliestStartOffset: 0 },
        });
      });
    }
    // Retranche aux nodes ce qui est déjà couvert par les allocations
    // conservées (gel du passé + préservées) sur la même paire user×tâche.
    for (const p of planNodes) {
      const kept = keptHoursByUserTask.get(`${p.userId}|${p.node.task.id}`) ?? 0;
      if (kept > 0) p.node.remainingHours = Math.max(0, p.node.remainingHours - kept);
    }

    // -------- 5. Placement ASAP en ordre topologique global --------
    //
    // (8) Pour chaque tâche en ordre topo, on calcule son earliestStartOffset
    // *dynamique* à partir des `placedEndByTask` réels de ses prédécesseurs
    // (et non plus uniquement de `earliestStartByTask` statique). Cela fait
    // que si la tâche A (user 1) glisse à cause d'une saturation, sa
    // successor B (user 2) glisse aussi.
    const proposed: ProposedAllocation[] = [];
    const placedEndByTask = new Map<string, Date>();

    // Regroupe les planNodes par taskId pour itérer dans l'ordre topo.
    const nodesByTask = new Map<string, { userId: string; node: TaskNode }[]>();
    for (const p of planNodes) {
      const arr = nodesByTask.get(p.node.task.id) ?? [];
      arr.push(p);
      nodesByTask.set(p.node.task.id, arr);
    }

    // Ordre des tâches : topo en clé primaire, score décroissant en
    // tie-break (deux tâches sans dépendance entre elles → la plus
    // prioritaire d'abord).
    const orderedTaskIds = Array.from(nodesByTask.keys()).sort((a, b) => {
      const ra = taskTopoRank.get(a) ?? 0;
      const rb = taskTopoRank.get(b) ?? 0;
      if (ra !== rb) return ra - rb;
      const sa = scoreFor(nodesByTask.get(a)![0].node);
      const sb = scoreFor(nodesByTask.get(b)![0].node);
      return sb - sa;
    });

    for (const taskId of orderedTaskIds) {
      // Earliest start dynamique pour cette tâche : max sur ses
      // prédécesseurs de leur fin réelle (+ lag), borné par
      // earliestStartByTask (statique CPM, ne baisse pas le plancher).
      let dynStart = earliestStartByTask.get(taskId) ?? from;
      for (const p of predsByTask.get(taskId) ?? []) {
        const predEnd = placedEndByTask.get(p.predId);
        if (!predEnd) continue;
        // FS = successor start après predecessor end. Les autres (SS/FF/SF)
        // sont approximés au start du pred dans computeEarliestStart ; on
        // reste cohérent ici et n'utilise placedEnd que pour FS.
        if (p.type === 'FS') {
          const start = addDays(predEnd, 1 + p.lagDays);
          if (+start > +dynStart) dynStart = start;
        }
      }
      const dynStartOffset = Math.max(
        0,
        Math.round((+dynStart - +from) / MS_PER_DAY),
      );

      // Trie les assignees de cette tâche par score (même tâche → même
      // score, donc ordre stable). Place pour chacun.
      let taskMaxEndDate: Date | null = null;
      for (const { userId, node: n } of nodesByTask.get(taskId)!) {
        n.earliestStartOffset = dynStartOffset;
        const capacity = capacityByUser.get(userId)!;

        let remaining = n.remainingHours;
        let lastEndIdx = -1;
        let segStart = -1;
        let segHours = 0;
        const flush = () => {
          if (segStart < 0) return;
          proposed.push({
            userId,
            taskId: n.task.id,
            projectId: n.task.projectId,
            startDate: dateIso(addDays(from, segStart)),
            endDate: dateIso(addDays(from, lastEndIdx)),
            hoursPerDay: round(segHours),
          });
          segStart = -1;
          segHours = 0;
        };

        for (let i = dynStartOffset; i < dayCount && remaining > HOURS_EPS; i++) {
          const free = capacity[i];
          if (free <= HOURS_EPS) {
            if (segStart >= 0) flush();
            continue;
          }
          const put = Math.min(free, remaining);
          if (segStart >= 0 && Math.abs(put - segHours) > HOURS_EPS) {
            flush();
          }
          if (segStart < 0) {
            segStart = i;
            segHours = put;
          }
          lastEndIdx = i;
          capacity[i] -= put;
          remaining -= put;
        }
        if (segStart >= 0) flush();

        if (remaining > HOURS_EPS) {
          warnings.push({
            taskId: n.task.id,
            type: 'user_saturated',
            message: `Capacité insuffisante pour la tâche "${n.task.title}" : ${round(remaining)}h non planifiées sur la fenêtre.`,
            missingHours: round(remaining),
          });
        } else if (n.task.dueDate && lastEndIdx >= 0) {
          const lastDate = addDays(from, lastEndIdx);
          const due = startOfUtcDay(n.task.dueDate);
          if (+lastDate > +due) {
            warnings.push({
              taskId: n.task.id,
              type: 'deadline_overflow',
              message: `Tâche "${n.task.title}" déborde sa deadline (${dateIso(due)}) — fin planifiée ${dateIso(lastDate)}.`,
            });
          }
        }
        if (lastEndIdx >= 0) {
          const endDate = addDays(from, lastEndIdx);
          if (!taskMaxEndDate || +endDate > +taskMaxEndDate) taskMaxEndDate = endDate;
        }
      }
      // Enregistre la fin "réelle" de la tâche pour propager aux successors.
      if (taskMaxEndDate) placedEndByTask.set(taskId, taskMaxEndDate);
    }

    // -------- 6. Diff vs allocations REMPLAÇABLES --------
    // La base de comparaison = exactement les allocations que persist() va
    // supprimer/recréer (futur in-scope visé par le mode). Les conservées
    // (gelées, manuelles, auto-split préservées, autres projets) n'apparaissent
    // pas dans le diff : elles ne changent pas.
    const currentReplaceable = existingAllocs.filter((a) => replaceable(a));
    const diff = this.computeDiff(currentReplaceable, proposed);

    // -------- 7. Persist optionnel --------
    if (dto.persist) {
      await this.persist(
        orgId,
        currentReplaceable,
        proposed,
        existingAllocs,
        dto.autoAssign ? assignmentChanges : undefined,
        cutoff,
      );
      // Automatisation « plan qui déborde » : uniquement sur une APPLICATION
      // réelle. `run()` produit les mêmes warnings en preview — alerter là
      // enverrait un mail à chaque scénario exploré par le PM.
      void this.automationHooks()?.onAutoplanApplied(orgId, dto.projectId ?? null, warnings);
    }

    // -------- 8. Enrichissement (noms users, titres tâches, clés projets) --------
    // Charger les libellés des entités référencées pour rendre la réponse lisible côté UI.
    const refUserIds = new Set<string>();
    const refTaskIds = new Set<string>();
    const refProjectIds = new Set<string>();
    for (const p of proposed) {
      refUserIds.add(p.userId);
      refTaskIds.add(p.taskId);
      refProjectIds.add(p.projectId);
    }
    for (const a of existingAllocs) {
      refUserIds.add(a.userId);
      refTaskIds.add(a.taskId);
      refProjectIds.add(a.projectId);
    }
    for (const w of warnings) refTaskIds.add(w.taskId);
    for (const a of assignments) {
      refTaskIds.add(a.taskId);
      refProjectIds.add(a.projectId);
    }

    const [refUsers, refTasks, refProjects] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: Array.from(refUserIds) } },
        select: { id: true, name: true },
      }),
      this.prisma.task.findMany({
        where: { id: { in: Array.from(refTaskIds) } },
        select: { id: true, title: true },
      }),
      this.prisma.project.findMany({
        where: { id: { in: Array.from(refProjectIds) } },
        select: { id: true, key: true },
      }),
    ]);
    const userName = new Map(refUsers.map((u) => [u.id, u.name]));
    const taskTitle = new Map(refTasks.map((t) => [t.id, t.title]));
    const projectKey = new Map(refProjects.map((p) => [p.id, p.key]));

    const enrichProposed = (p: ProposedAllocation): ProposedAllocation => ({
      ...p,
      userName: userName.get(p.userId),
      taskTitle: taskTitle.get(p.taskId),
      projectKey: projectKey.get(p.projectId),
    });
    const enrichAllocation = (a: Allocation): EnrichedAllocation => ({
      id: a.id,
      userId: a.userId,
      taskId: a.taskId,
      projectId: a.projectId,
      startDate: dateIso(a.startDate),
      endDate: dateIso(a.endDate),
      hoursPerDay: a.hoursPerDay,
      isManual: a.isManual,
      isAutoPlan: a.isAutoPlan,
      userName: userName.get(a.userId),
      taskTitle: taskTitle.get(a.taskId),
      projectKey: projectKey.get(a.projectId),
    });

    void taskById;
    return {
      proposed: proposed.map(enrichProposed),
      current: existingAllocs.map(enrichAllocation),
      diff: {
        added: diff.added.map(enrichProposed),
        removed: diff.removed.map(enrichAllocation),
        modified: diff.modified.map((m) => ({
          before: enrichAllocation(m.before),
          after: enrichProposed(m.after),
        })),
      },
      warnings: warnings.map((w) => ({ ...w, taskTitle: taskTitle.get(w.taskId) })),
      assignments: assignments.map((a) => ({
        ...a,
        taskTitle: taskTitle.get(a.taskId),
        projectKey: projectKey.get(a.projectId),
      })),
    };
  }

  // ------------------------------------------------------------
  // Affectation assistée (autoAssign)
  // ------------------------------------------------------------

  /**
   * Choisit / propose le(s) assignee(s) d'une tâche selon le skill requis ET la
   * capacité réellement libre sur la fenêtre de la tâche, parmi le pool du
   * projet (membres directs + membres des équipes affectées).
   *
   * Deux familles de tâches traitées :
   *  - **tâches SANS assigné** (toujours) : sélection *greedy* du meilleur pool ;
   *  - **tâches DÉJÀ assignées** (uniquement si `reassign`) : par défaut on
   *    GARDE l'assigné actuel (aucun changement) ; le PM peut swapper via un
   *    override → on retient alors exactement ces users.
   *
   * Mute `task.assignees` en mémoire (les choisis suivent ensuite le pipeline
   * normal de planification) et renvoie les propositions (chosen + alternatives)
   * ainsi que `assignmentChanges` (delta add/remove par tâche, pour persister
   * les TaskAssignee). Une tâche sans changement n'apparaît PAS dans le delta.
   */
  private async autoAssignTasks(
    orgId: string,
    p: {
      tasks: (Task & { assignees: { userId: string }[] })[];
      cutoff: Date;
      to: Date;
      hoursPerDay: number;
      loggedHoursByTask: Map<string, number>;
      skillMaxLevel: number;
      userLevelOnSkill: Map<string, number>;
      overrides?: { taskId: string; userIds: string[] }[];
      reassign: boolean;
    },
  ): Promise<{
    assignments: ProposedAssignment[];
    assignmentChanges: Map<string, { add: string[]; remove: string[] }>;
  }> {
    const {
      tasks,
      cutoff,
      to,
      hoursPerDay,
      loggedHoursByTask,
      skillMaxLevel,
      userLevelOnSkill,
      overrides,
      reassign,
    } = p;
    const overrideByTask = new Map<string, string[]>();
    for (const o of overrides ?? []) overrideByTask.set(o.taskId, o.userIds);

    const remainingOf = (t: Task) =>
      Math.max(0, (t.estimateHours ?? 0) - (loggedHoursByTask.get(t.id) ?? 0));
    // Tâches éligibles : reliquat d'effort > 0 et SOIT sans assigné (toujours),
    // SOIT déjà assignée quand `reassign` est actif.
    const targets = tasks.filter(
      (t) =>
        t.estimateHours != null &&
        t.estimateHours > 0 &&
        remainingOf(t) > HOURS_EPS &&
        (t.assignees.length === 0 || (reassign && t.assignees.length > 0)),
    );
    if (targets.length === 0)
      return { assignments: [], assignmentChanges: new Map() };

    // Assignés ACTUELS par tâche, capturés AVANT toute mutation in-memory.
    const currentByTask = new Map<string, string[]>();
    for (const t of targets) currentByTask.set(t.id, t.assignees.map((a) => a.userId));

    // -------- Pool de candidats par projet (membres directs + équipes) --------
    const projectIds = Array.from(new Set(targets.map((t) => t.projectId)));
    const [members, projectTeams] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: {
          projectId: { in: projectIds },
          // kind HUMAN : l'affectation assistée ne propose jamais un agent IA.
          user: { deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
        },
        select: { projectId: true, userId: true, user: { select: { name: true } } },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId: { in: projectIds } },
        select: {
          projectId: true,
          team: {
            select: {
              members: {
                where: { user: { deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' } },
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
        },
      }),
    ]);
    const poolByProject = new Map<string, Map<string, string>>(); // projectId → userId → name
    const addToPool = (pid: string, uid: string, name: string) => {
      let m = poolByProject.get(pid);
      if (!m) {
        m = new Map();
        poolByProject.set(pid, m);
      }
      if (!m.has(uid)) m.set(uid, name);
    };
    for (const m of members) addToPool(m.projectId, m.userId, m.user?.name ?? '—');
    for (const pt of projectTeams)
      for (const mm of pt.team.members) addToPool(pt.projectId, mm.userId, mm.user?.name ?? '—');

    // Les assignés actuels d'une tâche réassignable peuvent NE PAS être membres
    // du projet / d'une équipe (assignation directe). On les ajoute au pool de
    // leur projet pour qu'ils restent candidats (défaut « garder ») et swappables.
    const currentIds = Array.from(
      new Set(Array.from(currentByTask.values()).flat()),
    );
    if (currentIds.length) {
      const names = await this.prisma.user.findMany({
        where: { id: { in: currentIds } },
        select: { id: true, name: true },
      });
      const nameById = new Map(names.map((u) => [u.id, u.name]));
      for (const t of targets) {
        for (const uid of currentByTask.get(t.id) ?? []) {
          addToPool(t.projectId, uid, nameById.get(uid) ?? '—');
        }
      }
    }

    // -------- Contexte de capacité par candidat (mis en cache) --------
    const ctxCache = new Map<string, UserCapacityCtx>();
    const ctxFor = async (uid: string): Promise<UserCapacityCtx> => {
      let c = ctxCache.get(uid);
      if (!c) {
        c = await this.capacity.loadUserCapacityCtx(orgId, uid, cutoff, to);
        ctxCache.set(uid, c);
      }
      return c;
    };

    const assignments: ProposedAssignment[] = [];
    const assignmentChanges = new Map<string, { add: string[]; remove: string[] }>();

    for (const t of targets) {
      const remaining = remainingOf(t);
      const pool = poolByProject.get(t.projectId);
      const reqSkillId = t.requiredSkillId ?? null;
      const reqLevel = t.requiredSkillLevel ?? 0;
      const target = reqLevel > 0 ? reqLevel : skillMaxLevel;
      const current = currentByTask.get(t.id) ?? [];
      const wasAssigned = current.length > 0;

      // Fenêtre d'évaluation de la dispo : [max(cutoff, startDate), dueDate] ou,
      // à défaut de deadline, un horizon proportionnel à l'effort (borné 7–60 j),
      // jamais au-delà de l'horizon de planification `to`.
      const wStart =
        t.startDate && +startOfUtcDay(t.startDate) > +cutoff
          ? startOfUtcDay(t.startDate)
          : cutoff;
      let wEnd = t.dueDate
        ? startOfUtcDay(t.dueDate)
        : addDays(
            wStart,
            Math.min(60, Math.max(7, Math.ceil((remaining / Math.max(1, hoursPerDay)) * 1.5))),
          );
      if (+wEnd > +to) wEnd = to;
      if (+wEnd < +wStart) wEnd = wStart;

      const candidates: AssigneeCandidate[] = [];
      for (const [uid, name] of pool ?? []) {
        const level = reqSkillId ? userLevelOnSkill.get(`${uid}|${reqSkillId}`) ?? 0 : null;
        const meetsRequired = !reqSkillId || (level ?? 0) >= reqLevel;
        const ctx = await ctxFor(uid);
        const freeHours = this.capacity.freeHoursInWindow(ctx, wStart, wEnd, t.id);
        // Score : le skill domine (0..100), la dispo départage (0..10).
        const skillScore = reqSkillId ? Math.min(1, (level ?? 0) / Math.max(1, target)) : 1;
        const availScore = Math.min(1, freeHours / Math.max(1, remaining));
        candidates.push({
          userId: uid,
          name,
          level,
          meetsRequired,
          freeHours: round(freeHours),
          score: round(skillScore * 100 + availScore * 10),
        });
      }

      const override = overrideByTask.get(t.id);
      let sel: ReturnType<typeof selectAssignees>;
      if (override && override.length) {
        // Le PM a swappé : on retient exactement les users demandés.
        sel = selectAssignees(candidates, remaining, override);
      } else if (wasAssigned) {
        // Défaut sur une tâche déjà assignée : on GARDE l'assigné actuel (pas de
        // sélection greedy qui le remplacerait). Les autres candidats qualifiés
        // forment le pool de swap.
        const byId = new Map(candidates.map((c) => [c.userId, c]));
        const chosen = current
          .map((uid) => byId.get(uid))
          .filter((c): c is AssigneeCandidate => !!c);
        const chosenIds = new Set(chosen.map((c) => c.userId));
        const coverage = chosen.reduce((s, c) => s + c.freeHours, 0);
        sel = {
          chosen,
          // Pool de swap = TOUT le pool sauf l'assigné gardé, qualifiés en tête
          // puis non qualifiés (⚠) — pour pouvoir toujours réassigner, même sans
          // autre candidat qualifié.
          alternatives: candidates
            .filter((c) => !chosenIds.has(c.userId))
            .sort(
              (a, b) =>
                Number(b.meetsRequired) - Number(a.meetsRequired) ||
                b.score - a.score ||
                b.freeHours - a.freeHours ||
                a.name.localeCompare(b.name),
            ),
          source: 'auto',
          warning: coverage + 1e-6 < remaining ? 'capacity_short' : undefined,
        };
      } else {
        // Tâche sans assigné : couverture greedy classique.
        sel = selectAssignees(candidates, remaining, undefined);
      }

      const finalIds = sel.chosen.map((c) => c.userId);
      // Delta vs l'état actuel (vide tant que rien ne change).
      const currentSet = new Set(current);
      const finalSet = new Set(finalIds);
      const add = finalIds.filter((id) => !currentSet.has(id));
      const remove = current.filter((id) => !finalSet.has(id));
      if (add.length || remove.length) {
        assignmentChanges.set(t.id, { add, remove });
        // Reflète le set final sur la tâche en mémoire → pipeline de placement.
        t.assignees.length = 0;
        for (const uid of finalIds) t.assignees.push({ userId: uid });
      }

      assignments.push({
        taskId: t.id,
        projectId: t.projectId,
        chosen: sel.chosen,
        alternatives: sel.alternatives,
        source: sel.source,
        warning: sel.warning,
        wasAssigned,
      });
    }
    return { assignments, assignmentChanges };
  }

  // CPM helpers (computeSchedule = forward+backward+slack /
  // computeTransitiveDependents / computeTopoOrder) sont exportés depuis
  // ./scheduling (purs, sans Prisma — testables en isolation).

  // ------------------------------------------------------------
  // Diff & persistence
  // ------------------------------------------------------------

  private computeDiff(current: Allocation[], proposed: ProposedAllocation[]) {
    // (13) Clé d'appariement enrichie avec endDate pour gérer les multiples
    // segments par (user, task) que l'algo peut générer quand la capacité
    // est fragmentée. Sans endDate, deux allocs sur la même paire qui ne
    // diffèrent que par leur fin matchaient à tort et l'une était marquée
    // "modified" alors qu'elles couvraient des plages distinctes.
    const iso = (s: string | Date) => (typeof s === 'string' ? s : dateIso(s));
    const key = (a: { userId: string; taskId: string; startDate: string | Date; endDate: string | Date }) =>
      `${a.userId}|${a.taskId}|${iso(a.startDate)}|${iso(a.endDate)}`;
    // Première passe : matching exact (user, task, start, end). C'est le
    // cas "aucun changement" ou "même range, hoursPerDay différent".
    const currentByKey = new Map<string, Allocation>();
    for (const a of current) currentByKey.set(key(a), a);
    const proposedByKey = new Map<string, ProposedAllocation>();
    for (const p of proposed) proposedByKey.set(key(p), p);

    const added: ProposedAllocation[] = [];
    const modified: { before: Allocation; after: ProposedAllocation }[] = [];
    const removed: Allocation[] = [];
    const matchedProposedKeys = new Set<string>();
    const matchedCurrentKeys = new Set<string>();

    for (const [k, p] of proposedByKey) {
      const c = currentByKey.get(k);
      if (!c) continue;
      matchedProposedKeys.add(k);
      matchedCurrentKeys.add(k);
      if (Math.abs(c.hoursPerDay - p.hoursPerDay) > HOURS_EPS) {
        modified.push({ before: c, after: p });
      }
      // Sinon : identique, rien à dire.
    }

    // Seconde passe : matching plus lâche par (user, task) pour repérer
    // les "modified" qui ont changé de range. On apparie 1-pour-1 dans
    // l'ordre d'apparition.
    const pendingByPair = new Map<string, { c: Allocation[]; p: ProposedAllocation[] }>();
    const pairKey = (a: { userId: string; taskId: string }) => `${a.userId}|${a.taskId}`;
    for (const [k, c] of currentByKey) {
      if (matchedCurrentKeys.has(k)) continue;
      const pk = pairKey(c);
      const bucket = pendingByPair.get(pk) ?? { c: [], p: [] };
      bucket.c.push(c);
      pendingByPair.set(pk, bucket);
    }
    for (const [k, p] of proposedByKey) {
      if (matchedProposedKeys.has(k)) continue;
      const pk = pairKey(p);
      const bucket = pendingByPair.get(pk) ?? { c: [], p: [] };
      bucket.p.push(p);
      pendingByPair.set(pk, bucket);
    }
    for (const { c: cs, p: ps } of pendingByPair.values()) {
      const min = Math.min(cs.length, ps.length);
      for (let i = 0; i < min; i++) modified.push({ before: cs[i], after: ps[i] });
      for (let i = min; i < cs.length; i++) removed.push(cs[i]);
      for (let i = min; i < ps.length; i++) added.push(ps[i]);
    }
    return { added, removed, modified };
  }

  private async persist(
    orgId: string,
    replaceableAllocs: Allocation[],
    proposed: ProposedAllocation[],
    allExistingAllocs: Allocation[],
    assignmentChanges?: Map<string, { add: string[]; remove: string[] }>,
    cutoff?: Date,
  ): Promise<void> {
    // Stratégie atomique : on supprime EXACTEMENT les allocations remplaçables
    // (calculées par le prédicat `replaceable` : futur in-scope visé par le
    // mode de préservation) et on recrée `proposed`. Tout le reste (gelé
    // passé/aujourd'hui, manuel/auto-split préservés, autres projets) est
    // intact — jamais touché.
    // Si l'auto-affectation a touché des assignees (tâches sans assigné OU
    // réassignées par le PM), on réconcilie aussi les TaskAssignee dans la même
    // transaction : ajout des nouveaux, retrait des remplacés. Pour un retrait,
    // on supprime EN PLUS les allocations futures (≥ cutoff) de l'ancien assigné
    // sur cette tâche, qui n'auraient pas été couvertes par `replaceableAllocs`
    // s'il a quitté le scope (plus aucune tâche planifiée → non chargé).
    const addRows: { taskId: string; userId: string }[] = [];
    const removeByTask = new Map<string, string[]>();
    for (const [taskId, ch] of assignmentChanges ?? []) {
      for (const userId of ch.add) addRows.push({ taskId, userId });
      if (ch.remove.length) removeByTask.set(taskId, ch.remove);
    }
    if (
      proposed.length === 0 &&
      replaceableAllocs.length === 0 &&
      addRows.length === 0 &&
      removeByTask.size === 0
    ) {
      return;
    }
    const deleteIds = replaceableAllocs.map((a) => a.id);

    // (2) Validation cap 24h cumulatif AVANT le createMany, parce que
    // createMany court-circuite assertNoDailyOverbook. On simule l'état
    // final : (existing − supprimées) + proposed. Si un jour dépasse 24h pour
    // un user, on refuse et l'UI doit ajuster.
    const MAX = 24;
    const proposedDeleteIds = new Set(deleteIds);
    const surviving = allExistingAllocs.filter((a) => !proposedDeleteIds.has(a.id));
    type DayKey = string; // `${userId}|YYYY-MM-DD`
    const daily = new Map<DayKey, number>();
    const bump = (userId: string, d: Date, h: number) => {
      const k = `${userId}|${dateIso(d)}`;
      daily.set(k, (daily.get(k) ?? 0) + h);
    };
    for (const a of surviving) {
      for (let cur = +a.startDate; cur <= +a.endDate; cur += MS_PER_DAY) {
        bump(a.userId, new Date(cur), a.hoursPerDay);
      }
    }
    for (const p of proposed) {
      const s = +new Date(p.startDate + 'T00:00:00.000Z');
      const e = +new Date(p.endDate + 'T00:00:00.000Z');
      for (let cur = s; cur <= e; cur += MS_PER_DAY) {
        bump(p.userId, new Date(cur), p.hoursPerDay);
      }
    }
    for (const [k, total] of daily) {
      if (total > MAX) {
        const [userId, day] = k.split('|');
        throw new BadRequestException(
          `Auto-plan refusé : ${round(total)}h cumulées pour le user ${userId} le ${day} (max ${MAX}h/jour). Réduisez la charge manuelle ou revoyez les estimations des tâches.`,
        );
      }
    }

    const nextVersion =
      Math.max(0, ...replaceableAllocs.map((a) => a.planVersion ?? 0)) + 1;

    const freezeFrom = cutoff ?? startOfUtcDay(new Date());

    await this.prisma.$transaction(async (tx) => {
      if (deleteIds.length > 0) {
        await tx.allocation.deleteMany({
          where: { organizationId: orgId, id: { in: deleteIds } },
        });
      }
      // Réassignation : retirer les anciens assignees + leurs allocations
      // futures sur la tâche (le passé/aujourd'hui reste gelé).
      for (const [taskId, uids] of removeByTask) {
        await tx.taskAssignee.deleteMany({
          where: { taskId, userId: { in: uids } },
        });
        await tx.allocation.deleteMany({
          where: {
            organizationId: orgId,
            taskId,
            userId: { in: uids },
            startDate: { gte: freezeFrom },
          },
        });
      }
      if (proposed.length > 0) {
        await tx.allocation.createMany({
          data: proposed.map((p) => ({
            organizationId: orgId,
            userId: p.userId,
            taskId: p.taskId,
            projectId: p.projectId,
            startDate: new Date(p.startDate + 'T00:00:00.000Z'),
            endDate: new Date(p.endDate + 'T00:00:00.000Z'),
            hoursPerDay: p.hoursPerDay,
            isManual: false,
            isAutoPlan: true,
            planVersion: nextVersion,
          })),
        });
      }
      if (addRows.length > 0) {
        await tx.taskAssignee.createMany({
          data: addRows,
          skipDuplicates: true,
        });
      }
    });
  }
}

// ============================================================
// Pure helpers locaux (date helpers communs déplacés dans ./scheduling)
// ============================================================

function scheduleHoursFor(
  s: Pick<WorkSchedule, 'hoursMon'|'hoursTue'|'hoursWed'|'hoursThu'|'hoursFri'|'hoursSat'|'hoursSun'> | undefined,
  d: Date,
): number {
  if (!s) return 0;
  switch (weekdayMonFirst(d)) {
    case 0:
      return s.hoursMon;
    case 1:
      return s.hoursTue;
    case 2:
      return s.hoursWed;
    case 3:
      return s.hoursThu;
    case 4:
      return s.hoursFri;
    case 5:
      return s.hoursSat;
    case 6:
      return s.hoursSun;
  }
  return 0;
}
function round(n: number): number {
  return Math.round(n * 100) / 100;
}
function groupBy<T, K>(items: T[], by: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = by(it);
    const arr = m.get(k) ?? [];
    arr.push(it);
    m.set(k, arr);
  }
  return m;
}

// Inutile mais évite la complainte "TimeOff non utilisé" en cas d'import.
export type _TimeOff = TimeOff;
