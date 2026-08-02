import { BadRequestException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { HolidaysService } from '../holidays/holidays.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { AgentBudgetService } from '../agents/agent-budget.service';
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
import { CapacityService, scheduleHoursFor, UserCapacityCtx } from './capacity.service';
import { AutoplanRequestDto } from './dto/autoplan.dto';
import {
  addDays,
  AgentTaskStakes,
  AgentTrust,
  agentTrustAllowsStakes,
  AssigneeCandidate,
  cloneCapacityMap,
  computeSchedule,
  computeTransitiveDependents,
  dateIso,
  deadlineAwarePass,
  durationDays,
  filterByApplyOnly,
  isAgentEligible,
  isUnfrozenAllocation,
  latenessObjective,
  overflowsOf,
  PlacedSegment,
  placeTasks,
  PlacementWarning,
  SchedulingDepType,
  selectAssignees,
  startOfUtcDay,
  UnfreezeUserDay,
  WorkCalendar,
} from './scheduling';
import {
  buildAtomicClusters,
  clusterEffort,
  clusterWindow,
  ClusterInputTask,
  continuityScore,
  distributeClusterTasks,
  filterAbsentCandidates,
  meetsAllRequired,
  mergeClustersBySetCover,
  WindowedCluster,
} from './clustering';

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
    | 'outside_window'
    | 'dependency_cycle'
    | 'agent_assigned'
    | 'all_candidates_unavailable';
  message: string;
  missingHours?: number;
}

/** Vue élargie d'une tâche du scope autoplan : assignees + skills multiples
 *  (`TaskRequiredSkill`, Lot 1b préalable multi-skill) + board (fallback
 *  conteneur du clustering 1b.1). */
type ScopedTask = Task & {
  assignees: { userId: string }[];
  requiredSkills: { skillId: string; level: number }[];
  boardColumn: { boardId: string } | null;
};

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
  /** `agent_suggested` (Lot 5, §5.2) : un agent IA éligible a été proposé —
   *  suggestion uniquement, jamais persistée sans acceptation PM explicite
   *  (override → `source` devient `override`). */
  source: 'auto' | 'override' | 'agent_suggested';
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

@Injectable()
export class AutoplanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly holidays: HolidaysService,
    private readonly capacity: CapacityService,
    private readonly moduleRef: ModuleRef,
    private readonly audit: AuditLogService,
    private readonly agentBudget: AgentBudgetService,
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
  async run(
    orgId: string,
    dto: AutoplanRequestDto,
    actor?: { id: string; email: string },
  ): Promise<AutoplanResult> {
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

    // -------- Lot 4.2 (porte 2) — levée CIBLÉE du gel du passé --------
    // Validation forte AVANT tout le reste : n'a de sens qu'avec scope='user',
    // le MÊME userId que le scope, et EXACTEMENT aujourd'hui (le passé strict
    // reste intouchable — seul « aujourd'hui » peut être rouvert par un geste
    // explicite). Toute autre combinaison est un 400, jamais une ignoration
    // silencieuse : un appelant qui croit avoir libéré un jour doit savoir
    // immédiatement que ce n'est pas le cas.
    let unfreeze: UnfreezeUserDay | null = null;
    if (dto.unfreezeUserDay) {
      if (dto.scope !== 'user' || dto.userId !== dto.unfreezeUserDay.userId) {
        throw new BadRequestException(
          'unfreezeUserDay requiert scope=user avec le même userId.',
        );
      }
      const day = startOfUtcDay(new Date(dto.unfreezeUserDay.date));
      if (+day !== +now) {
        throw new BadRequestException(
          "unfreezeUserDay ne peut lever le gel que sur AUJOURD'HUI — le passé strict reste intouchable.",
        );
      }
      unfreeze = { userId: dto.unfreezeUserDay.userId, dayMs: +day };
    }
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

    const tasks: ScopedTask[] = await this.prisma.task.findMany({
      where: taskWhere,
      include: {
        assignees: { select: { userId: true } },
        // Multi-skill (Lot 1b préalable) : au-delà du skill principal
        // rétrocompat (`requiredSkillId`), une tâche peut porter plusieurs
        // `TaskRequiredSkill` ("Terraform + Azure + Python").
        requiredSkills: { select: { skillId: true, level: true } },
        // Fallback conteneur du clustering (1b.1, dernier niveau de cascade).
        boardColumn: { select: { boardId: true } },
      },
    });

    // -------- Skill match (bonus de score + éligibilité multi-skill) --------
    // On précharge le niveau de chaque assignee sur CHAQUE skill requis de sa
    // tâche (union skill principal ∪ TaskRequiredSkill, dédupliquée par
    // skillId en gardant le niveau MAX demandé), pour (a) donner un bonus de
    // priorité aux tâches dont les assignees sont effectivement compétents,
    // et (b) permettre à l'affectation assistée d'exiger une CONJONCTION sur
    // tous les skills (plus de faux qualifié "Terraform+Azure" jugé sur
    // Terraform seul).
    const skillMaxLevel = await this.settings.getSkillsMaxLevel(orgId);
    const skillReqByTask = new Map<string, { skillId: string; level: number | null }[]>();
    for (const t of tasks) {
      const byId = new Map<string, number | null>();
      if (t.requiredSkillId) byId.set(t.requiredSkillId, t.requiredSkillLevel ?? null);
      for (const rs of t.requiredSkills) {
        const cur = byId.get(rs.skillId);
        if (cur === undefined || (rs.level ?? 0) > (cur ?? 0)) byId.set(rs.skillId, rs.level ?? null);
      }
      if (byId.size) {
        skillReqByTask.set(
          t.id,
          Array.from(byId, ([skillId, level]) => ({ skillId, level })),
        );
      }
    }
    const skillIdsInScope = Array.from(
      new Set(Array.from(skillReqByTask.values()).flatMap((reqs) => reqs.map((r) => r.skillId))),
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
    /** Cible numérique d'un skill requis : le niveau demandé, sinon le max du catalogue. */
    const skillTarget = (level: number | null): number => (level && level > 0 ? level : skillMaxLevel);
    /** Bonus 0..5 : moyenne (sur les skills requis PUIS sur les assignees) de
     *  la couverture de chaque skill — un assignee qui ignore un des skills
     *  requis plafonne sa propre couverture, pas seulement le score global. */
    const skillBonus = (taskId: string, assigneeIds: string[]): number => {
      const reqs = skillReqByTask.get(taskId);
      if (!reqs || reqs.length === 0 || assigneeIds.length === 0) return 0;
      let sum = 0;
      for (const uid of assigneeIds) {
        let coverage = 0;
        for (const r of reqs) {
          const lvl = userLevelOnSkill.get(`${uid}|${r.skillId}`) ?? 0;
          coverage += Math.min(1, lvl / skillTarget(r.level));
        }
        sum += coverage / reqs.length;
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
    // Curseur de concentration (Lot 2.2) : surcharge par run > défaut org.
    // Sans effet si autoAssign est désactivé ou scope=user (l'affectation
    // assistée est de toute façon ignorée dans ce cas, cf. plus bas).
    const concentration: 'focus' | 'balanced' | 'spread' =
      dto.concentration ?? (await this.settings.getAutoplanConcentration(orgId));

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
    // Warnings émis par l'affectation assistée (ex. `all_candidates_unavailable`
    // — fallback 1b.1) : capturés ici, poussés dans `warnings` une fois ce
    // tableau déclaré plus bas.
    let autoAssignWarnings: AutoplanWarning[] = [];
    if (dto.autoAssign && dto.scope !== 'user') {
      // -------- Lot 5.2 — passe agent SÉPARÉE, TOUJOURS AVANT le pool humain
      // (AUTOPLAN_IMPROVEMENTS.md §5.2) : jamais dans le même greedy — la
      // concurrence d'un agent et les heures libres d'un humain ne se
      // comparent pas. Une tâche « gérée » (suggérée OU acceptée par override
      // PM) sort ENTIÈREMENT du pool humain ci-dessous.
      const agentPass = await this.proposeAgentAssignments(orgId, {
        tasks,
        loggedHoursByTask,
        skillReqByTask,
        userLevelOnSkill,
        skillMaxLevel,
        overrides: dto.assignmentOverrides,
      });
      const humanTasks = agentPass.handledTaskIds.size
        ? tasks.filter((t) => !agentPass.handledTaskIds.has(t.id))
        : tasks;
      const res = await this.autoAssignTasks(orgId, {
        tasks: humanTasks,
        cutoff,
        to,
        hoursPerDay,
        loggedHoursByTask,
        skillMaxLevel,
        userLevelOnSkill,
        skillReqByTask,
        overrides: dto.assignmentOverrides,
        reassign,
        concentration,
      });
      assignments = [...agentPass.assignments, ...res.assignments];
      assignmentChanges = new Map([...agentPass.assignmentChanges, ...res.assignmentChanges]);
      autoAssignWarnings = res.warnings;
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

    // -------- Classification agent vs humain hors-scope --------
    // Un assignee présent dans `assigneeIdSet` mais absent de `inScopeUserIds`
    // est soit un agent IA (exclu du chargement ci-dessus par `kind: 'HUMAN'`),
    // soit un humain inactif/supprimé. On ne distingue que les agents (le
    // reste retombe correctement sur `unassigned`, cf. plus bas).
    const nonHumanAssigneeIds = Array.from(assigneeIdSet).filter(
      (id) => !inScopeUserIds.has(id),
    );
    const nonHumanUsers = nonHumanAssigneeIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: nonHumanAssigneeIds }, organizationId: orgId },
          select: { id: true, name: true, kind: true },
        })
      : [];
    const agentIds = new Set(
      nonHumanUsers.filter((u) => u.kind === 'AGENT').map((u) => u.id),
    );
    const agentNameById = new Map(
      nonHumanUsers.filter((u) => u.kind === 'AGENT').map((u) => [u.id, u.name]),
    );

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
    // Lot 4.2 (porte 2) — `unfreeze` élargit CE prédicat pour les allocations
    // du user visé qui COMMENCENT exactement le jour levé (aujourd'hui) : le
    // plancher de placement, lui, ne bouge pas (`from` reste `cutoff` par
    // défaut) — les heures libérées se replacent à partir de DEMAIN, jamais
    // aujourd'hui. `isUnfrozenAllocation` est bornée par construction à UN
    // user × UN jour (cf. scheduling.ts).
    const replaceable = (a: {
      userId: string;
      startDate: Date;
      taskId: string;
      isManual: boolean;
      isAutoPlan: boolean;
    }): boolean =>
      (+a.startDate >= +cutoff || isUnfrozenAllocation(a, unfreeze, +cutoff)) &&
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
    const warnings: AutoplanWarning[] = [...autoAssignWarnings];
    // Les nodes par tâche (répartition des heures restantes entre assignees)
    // sont construits plus bas, APRÈS le calcul de la capacité par user, pour
    // que le split soit proportionnel à la disponibilité réelle de chacun
    // (cf. « Construire les nodes par tâche »). On ne peut pas le faire ici :
    // la capacité n'est pas encore connue.

    // -------- 2. Charger schedules / time-offs / allocations existantes --------
    // Tous les assignees in-scope (les nodes par tâche ne sont pas encore construits).
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
    // Lot 1b.4 — ne compter QUE les jours ≥ cutoff : le passé est déjà
    // exactement couvert par `logged` (TimeEntry). Sur une allocation à
    // cheval sur aujourd'hui (gelée car startDate < cutoff, chargée car
    // endDate >= from), compter aussi les jours passés double-déduisait le
    // travail déjà loggé (ou, à l'inverse, déduisait à tort du temps non
    // effectué un jour d'incident) — cf. AUTOPLAN_IMPROVEMENTS.md §1b.4.
    const effectiveHoursOf = (a: Allocation): number => {
      const sched = scheduleByUser.get(a.userId) ?? defaultSchedule;
      const occ = (sched?.occupancyPct ?? 100) / 100;
      const offs = timeOffsByUser.get(a.userId) ?? [];
      const cc = countryByUser.get(a.userId) ?? defaultCountry.toUpperCase();
      const holidaySet = holidaysByCountry.get(cc) ?? new Set<string>();
      let sum = 0;
      for (let cur = +a.startDate; cur <= +a.endDate; cur += MS_PER_DAY) {
        if (cur < +cutoff) continue;
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
    // conservées est appliquée plus bas, à la construction des nodes par tâche.)

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

    // Calendrier de jours ouvrés (Lot 1c.1) : approximation org-level (schedule
    // par défaut × fériés du pays par défaut) branchée dans le CPM/placement —
    // le CPM ne connaît pas encore l'assignee à ce stade, donc ni ses congés ni
    // son occupancy propres, seulement « ce jour est-il un jour ouvré pour
    // l'org ». Un seul appel fériés supplémentaire (defaultSchedule/
    // defaultCountry/fromIso/toIso déjà en scope depuis les étapes 1-2).
    const holidaysDefaultSet = new Set(
      this.holidays.forCountryRange(defaultCountry.toUpperCase(), fromIso, toIso).map((h) => h.date),
    );
    const calendar: WorkCalendar = {
      isWorkday: (d: Date) =>
        scheduleHoursFor(defaultSchedule, d) > 0 && !holidaysDefaultSet.has(dateIso(d)),
    };

    // -------- 3. CPM complet (forward + backward + slack) sur le graphe --------
    // `computeSchedule` fait un vrai backward-pass : on récupère, par tâche, sa
    // date au plus tôt (plancher de placement) ET son mou total (`totalSlack`)
    // qui pilote la priorité (point 4 : leveling — les tâches à fort mou cèdent
    // la capacité précoce aux tâches critiques).
    const schedule = computeSchedule(tasks, dependencies, from, defHours, calendar);
    const earliestStartByTask = new Map(
      Array.from(schedule, ([id, s]) => [id, s.earlyStart] as const),
    );

    // -------- 4. Score d'ordonnancement --------
    // Compter les dépendants transitifs par tâche.
    const dependentsCount = computeTransitiveDependents(tasks, dependencies);

    // Calcul du score : départage les tâches COMPARABLES parmi les tâches
    // PRÊTES (list scheduling, cf. placeTasks) — l'ordre topologique reste la
    // contrainte dure au-dessus (un prérequis passe toujours avant son
    // successeur, la comparaison de score ne s'applique jamais entre deux
    // tâches liées par une dépendance). Chaque composante est normalisée à
    // ~[0,1] puis pondérée par SCORE_WEIGHTS, pour une hiérarchie lisible et
    // réglable : priorité métier > chemin critique > prérequis (dépendants) >
    // urgence (échéance) > compétence. Keyé par taskId (pas par TaskNode) :
    // une tâche sans node (agent, sans assigné, sans estimate) doit rester
    // scorable pour que le list scheduling puisse la traiter et débloquer ses
    // successeurs.
    const maxDependents = Math.max(1, ...Array.from(dependentsCount.values()));
    const scoreCache = new Map<string, number>();
    const scoreForTask = (t: Task & { assignees?: { userId: string }[] }): number => {
      const cached = scoreCache.get(t.id);
      if (cached != null) return cached;
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
      const assigneeIds = t.assignees?.map((a) => a.userId) ?? [];
      const skill = skillBonus(t.id, assigneeIds) / 5; // skillBonus ∈ [0,5]
      const s =
        SCORE_WEIGHTS.priority * prio +
        SCORE_WEIGHTS.critical * crit +
        SCORE_WEIGHTS.dependents * deps +
        SCORE_WEIGHTS.due * urgency +
        SCORE_WEIGHTS.skill * skill;
      scoreCache.set(t.id, s);
      return s;
    };
    const scoreOf = (taskId: string): number => {
      const t = taskById.get(taskId);
      return t ? scoreForTask(t) : 0;
    };

    // Pré-indexe les prédécesseurs ET les successeurs par tâche : sert à la
    // fois à la propagation des scheduledEnd réels (cross-user) et au list
    // scheduling (`pendingPreds`/`ready` dans placeTasks). Couvre TOUTES les
    // tâches du scope, pas seulement celles ayant un node — une tâche sans
    // assigné/estimate doit quand même débloquer ses successeurs.
    const predsByTask = new Map<
      string,
      { predId: string; type: SchedulingDepType; lagDays: number }[]
    >();
    const succsByTask = new Map<string, string[]>();
    for (const t of tasks) {
      predsByTask.set(t.id, []);
      succsByTask.set(t.id, []);
    }
    for (const d of dependencies) {
      if (!predsByTask.has(d.successorId) || !succsByTask.has(d.predecessorId)) continue;
      predsByTask.get(d.successorId)!.push({
        predId: d.predecessorId,
        type: d.type,
        lagDays: d.lagDays,
      });
      succsByTask.get(d.predecessorId)!.push(d.successorId);
    }

    // Échéances par tâche (pour le warning deadline_overflow du placement).
    const dueByTask = new Map<string, Date>();
    for (const t of tasks) if (t.dueDate) dueByTask.set(t.id, startOfUtcDay(t.dueDate));

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

    // -------- Construire les nodes par tâche (split pondéré par la capacité) --------
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

    // nodesByTask alimente directement `placeTasks` (list scheduling, pure) ;
    // projectByTask lui réattache le projectId (placeTasks n'a pas Prisma) ;
    // estimatedEndByTask porte la fin CPM des tâches confiées à un agent IA,
    // pour propager la contrainte FS à un successeur humain SANS jamais leur
    // allouer d'heures (modèle pull strict).
    const nodesByTask = new Map<string, { userId: string; hours: number }[]>();
    const projectByTask = new Map<string, string>();
    const estimatedEndByTask = new Map<string, Date>();

    for (const t of tasks) {
      projectByTask.set(t.id, t.projectId);
      const assigneeIds = t.assignees
        .map((a) => a.userId)
        .filter((uid) => inScopeUserIds.has(uid));
      if (assigneeIds.length === 0) {
        // Aucun assignee HUMAIN in-scope : soit confiée à un agent IA (signal
        // dédié `agent_assigned`, jamais `unassigned` — elle EST assignée),
        // soit réellement sans assigné.
        const agentAssignees = t.assignees.filter((a) => agentIds.has(a.userId));
        if (agentAssignees.length > 0) {
          const names = agentAssignees
            .map((a) => agentNameById.get(a.userId) ?? '—')
            .join(', ');
          warnings.push({
            taskId: t.id,
            type: 'agent_assigned',
            message: `Tâche "${t.title}" confiée à l'agent ${names} — hors capacité humaine.`,
          });
          // Propagation agent→humain : fin CPM posée pour que la contrainte
          // FS décale quand même un successeur humain.
          const sc = schedule.get(t.id);
          if (sc) estimatedEndByTask.set(t.id, sc.earlyFinish);
        } else if (!dto.autoAssign && t.estimateHours != null && t.estimateHours > 0) {
          warnings.push({
            taskId: t.id,
            type: 'unassigned',
            message: `Tâche "${t.title}" sans assigné — non planifiée.`,
          });
        }
        continue;
      }
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
      const nodes: { userId: string; hours: number }[] = [];
      assigneeIds.forEach((uid, k) => {
        const share =
          wSum > HOURS_EPS
            ? remainingTaskHours * (weights[k] / wSum)
            : remainingTaskHours / assigneeIds.length;
        // Retranche ce qui est déjà couvert par les allocations conservées
        // (gel du passé + préservées) sur la même paire user×tâche.
        const kept = keptHoursByUserTask.get(`${uid}|${t.id}`) ?? 0;
        nodes.push({ userId: uid, hours: Math.max(0, share - kept) });
      });
      nodesByTask.set(t.id, nodes);
    }

    // durationDaysByTask alimente le raffinement dynamique FF/SF de
    // `placeTasks` (Lot 1c.2) — même formule que le CPM (`durationDays`,
    // ./scheduling), keyée par tâche pour que `place()` puisse convertir une
    // contrainte de FIN en plancher de START pour n'importe quel successeur.
    const durationDaysByTask = new Map<string, number>();
    for (const t of tasks) durationDaysByTask.set(t.id, durationDays(t.estimateHours, defHours));

    // -------- 5. Placement (list scheduling) --------
    // `placeTasks` (pure, ./scheduling) implémente le serial schedule
    // generation scheme : à chaque itération, la tâche PRÊTE (tous
    // prédécesseurs in-scope traités) de meilleur score est placée — l'ordre
    // topologique reste la contrainte dure, le score ne départage que les
    // tâches effectivement comparables. Itère sur TOUTES les tâches du scope
    // (pas seulement celles ayant un node) pour que les tâches sans
    // assigné/estimate/agent débloquent quand même leurs successeurs.
    const placementStrategy: 'asap' | 'deadline_aware' =
      dto.placementStrategy === 'deadline_aware' ? 'deadline_aware' : 'asap';
    // Clone PRISTINE de la capacité, pris AVANT le run `asap` (qui mute
    // `capacityByUser` en place) — nécessaire uniquement pour rejouer la
    // passe deadline-aware (Lot 2.1) depuis un état vierge à chaque essai.
    // `capacityByUser` n'est plus lu après le placement : le laisser mutable
    // pour le run `asap` par défaut ne régresse rien (comportement du lot 1a
    // inchangé, zéro clone si `placementStrategy` reste `asap`).
    const pristineCapacityByUser =
      placementStrategy === 'deadline_aware' ? cloneCapacityMap(capacityByUser) : null;
    const placeTasksInput = {
      graph: { preds: predsByTask, succs: succsByTask },
      taskIds: tasks.map((t) => t.id),
      scoreOf,
      nodes: nodesByTask,
      projectByTask,
      capacity: capacityByUser,
      earliestStartByTask,
      dueByTask,
      estimatedEndByTask,
      durationDaysByTask,
      calendar,
      dayCount,
      from,
    };
    let { proposed: placedSegments, warnings: placementWarnings } = placeTasks(placeTasksInput);

    // -------- 5b. Passe corrective deadline-aware (Lot 2.1) --------
    // Ne retient le résultat que s'il améliore STRICTEMENT la fonction
    // objectif Σ(jours de retard × poids de priorité) par rapport au plan
    // `asap` — sinon on conserve le plan `asap` tel quel. `deadlineAwarePass`
    // rejoue `placeTasks` sur des clones frais (jamais `capacityByUser`,
    // déjà consommé par le run ci-dessus) : sûr par construction.
    if (placementStrategy === 'deadline_aware' && pristineCapacityByUser) {
      const baselineOverflows = overflowsOf(placementWarnings);
      if (baselineOverflows.length > 0) {
        const weightByTask = new Map(
          tasks.map((t) => [t.id, PRIORITY_WEIGHT[t.priority] ?? 1] as const),
        );
        const baselineObjective = latenessObjective(baselineOverflows, dueByTask, weightByTask);
        const attempt = deadlineAwarePass(
          { ...placeTasksInput, capacity: pristineCapacityByUser },
          weightByTask,
        );
        if (attempt && attempt.objective < baselineObjective - 1e-9) {
          placedSegments = attempt.proposed;
          placementWarnings = attempt.warnings;
        }
      }
    }

    const proposed: ProposedAllocation[] = placedSegments.map(
      (s: PlacedSegment): ProposedAllocation => ({
        userId: s.userId,
        taskId: s.taskId,
        projectId: s.projectId,
        startDate: s.startDate,
        endDate: s.endDate,
        hoursPerDay: s.hoursPerDay,
      }),
    );

    // Reconstruit les messages FR (identiques à l'historique) à partir des
    // warnings STRUCTURELS renvoyés par le placement — celui-ci reste pur,
    // aucune string métier n'y vit (prépare l'i18n du Lot 3.1).
    for (const w of placementWarnings as PlacementWarning[]) {
      const t = taskById.get(w.taskId);
      const title = t?.title ?? w.taskId;
      if (w.type === 'user_saturated') {
        warnings.push({
          taskId: w.taskId,
          type: 'user_saturated',
          message: `Capacité insuffisante pour la tâche "${title}" : ${round(w.missingHours ?? 0)}h non planifiées sur la fenêtre.`,
          missingHours: round(w.missingHours ?? 0),
        });
      } else if (w.type === 'deadline_overflow') {
        const due = t?.dueDate ? dateIso(startOfUtcDay(t.dueDate)) : '?';
        warnings.push({
          taskId: w.taskId,
          type: 'deadline_overflow',
          message: `Tâche "${title}" déborde sa deadline (${due}) — fin planifiée ${w.plannedEnd}.`,
        });
      } else {
        warnings.push({
          taskId: w.taskId,
          type: 'dependency_cycle',
          message: `Cycle de dépendances détecté sur la tâche "${title}" — placée hors contrainte d'ordre.`,
        });
      }
    }

    // Déduplique par (taskId, type) — garde la première occurrence.
    const seenWarningKeys = new Set<string>();
    const dedupedWarnings: AutoplanWarning[] = [];
    for (const w of warnings) {
      const k = `${w.taskId}|${w.type}`;
      if (seenWarningKeys.has(k)) continue;
      seenWarningKeys.add(k);
      dedupedWarnings.push(w);
    }
    warnings.length = 0;
    warnings.push(...dedupedWarnings);

    // -------- 6. Diff vs allocations REMPLAÇABLES --------
    // La base de comparaison = exactement les allocations que persist() va
    // supprimer/recréer (futur in-scope visé par le mode). Les conservées
    // (gelées, manuelles, auto-split préservées, autres projets) n'apparaissent
    // pas dans le diff : elles ne changent pas.
    const currentReplaceable = existingAllocs.filter((a) => replaceable(a));
    const diff = this.computeDiff(currentReplaceable, proposed);

    // -------- 7. Persist optionnel --------
    if (dto.persist) {
      // Lot 2.5 — application partielle : restreint À LA FOIS `replaceable`
      // et `proposed` au filtre `applyOnly` (userIds/taskIds), pour que le
      // modèle delete+recreate reste cohérent (on ne supprime que ce qu'on va
      // recréer). Le DIFF renvoyé plus haut (`diff`) reste TOUJOURS complet —
      // seule la persistance est filtrée. `assignmentChanges` (TaskAssignee)
      // n'est volontairement PAS filtré par `applyOnly` : une affectation
      // décidée par le run doit rester cohérente pour la tâche entière, pas
      // partiellement appliquée user par user (hors périmètre du Lot 2.5,
      // cf. AUTOPLAN_IMPROVEMENTS.md §2.5).
      const replaceableForPersist = filterByApplyOnly(currentReplaceable, dto.applyOnly);
      const proposedForPersist = filterByApplyOnly(proposed, dto.applyOnly);
      await this.persist(
        orgId,
        replaceableForPersist,
        proposedForPersist,
        existingAllocs,
        dto.autoAssign ? assignmentChanges : undefined,
        cutoff,
      );
      // Automatisation « plan qui déborde » : uniquement sur une APPLICATION
      // réelle. `run()` produit les mêmes warnings en preview — alerter là
      // enverrait un mail à chaque scénario exploré par le PM.
      void this.automationHooks()?.onAutoplanApplied(orgId, dto.projectId ?? null, warnings);

      // Lot 4.2 (porte 2) — trace explicite du contournement du gel du passé,
      // SUR UNE APPLICATION RÉELLE seulement (jamais en preview). Distinct de
      // la capture générique de la route : celle-ci nomme précisément le
      // périmètre (user × jour) et le nombre d'allocations effectivement
      // libérées, pour rester repérable dans le journal sans dépouiller le
      // `detail` JSON générique de l'interceptor.
      if (unfreeze) {
        const allocationsFreed = replaceableForPersist.filter((a) =>
          isUnfrozenAllocation(a, unfreeze, +cutoff),
        ).length;
        this.audit.log({
          organizationId: orgId,
          action: AUDIT_ACTIONS.WORKLOAD_UNFREEZE_DAY,
          actorId: actor?.id ?? null,
          actorLabel: actor?.email ?? null,
          resourceType: 'user',
          resourceId: unfreeze.userId,
          detail: { date: dateIso(new Date(unfreeze.dayMs)), allocationsFreed },
        });
      }
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
  // Lot 5.2 — agents IA dans l'affectation assistée (§5,
  // AUTOPLAN_IMPROVEMENTS.md) — SUGGESTION uniquement, JAMAIS d'Allocation.
  // ------------------------------------------------------------

  /**
   * Passe agent SÉPARÉE, TOUJOURS AVANT le pool humain (§5.2) : pour chaque
   * tâche SANS assigné d'un projet `agentsEnabled`, propose le meilleur agent
   * ÉLIGIBLE (capabilities, skill multi requis, budget restant aux 4
   * périmètres, concurrence libre, trust ≥ enjeu du projet). Jamais mélangée
   * au greedy humain — la concurrence d'un agent (tâches simultanées) et les
   * heures libres d'un humain ne se comparent pas.
   *
   * GARDE-FOUS structurels (non négociables, AGENTS_ARCHITECTURE.md) :
   *  - **mode SUGGESTION uniquement** : une tâche suggérée reste SANS
   *    assignee (`task.assignees` non touché, `assignmentChanges` non écrit)
   *    tant que le PM ne l'a pas explicitement acceptée via un
   *    `assignmentOverrides` nommant CET agent → alors seulement `source`
   *    devient `'override'` et `task.assignees` est mutée ;
   *  - **aucune Allocation possible** : une tâche « gérée » ici (suggérée OU
   *    acceptée) est retirée du `humanTasks` passé à `autoAssignTasks` par
   *    l'appelant (`run()`), donc n'entre JAMAIS dans `nodesByTask`/
   *    `placeTasks` — zéro heure calculée, zéro allocation possible ;
   *  - un override PM nommant exclusivement des HUMAINS pour une tâche route
   *    cette tâche vers le pool humain normal, même si un agent était
   *    éligible (jamais imposé malgré un choix humain explicite).
   */
  private async proposeAgentAssignments(
    orgId: string,
    p: {
      tasks: ScopedTask[];
      loggedHoursByTask: Map<string, number>;
      skillReqByTask: Map<string, { skillId: string; level: number | null }[]>;
      userLevelOnSkill: Map<string, number>;
      skillMaxLevel: number;
      overrides?: { taskId: string; userIds: string[] }[];
    },
  ): Promise<{
    assignments: ProposedAssignment[];
    assignmentChanges: Map<string, { add: string[]; remove: string[] }>;
    handledTaskIds: Set<string>;
  }> {
    const empty = {
      assignments: [] as ProposedAssignment[],
      assignmentChanges: new Map<string, { add: string[]; remove: string[] }>(),
      handledTaskIds: new Set<string>(),
    };
    const { tasks, loggedHoursByTask, skillReqByTask, userLevelOnSkill, skillMaxLevel, overrides } = p;

    const remainingOf = (t: ScopedTask) =>
      Math.max(0, (t.estimateHours ?? 0) - (loggedHoursByTask.get(t.id) ?? 0));
    // Candidates : SANS assigné (jamais la réassignation — réservée au pool
    // humain, cf. AUTOPLAN_IMPROVEMENTS.md §5.2 « hors périmètre »), reliquat > 0.
    const targets = tasks.filter(
      (t) => t.assignees.length === 0 && t.estimateHours != null && t.estimateHours > 0 && remainingOf(t) > HOURS_EPS,
    );
    if (targets.length === 0) return empty;

    // -------- Projets `agentsEnabled` du scope (gating dur — pattern déjà --
    // -------- appliqué partout : pas de toggle ⇒ la fonctionnalité N'EXISTE --
    // -------- PAS pour ce projet). -------------------------------------------
    const projectIds = Array.from(new Set(targets.map((t) => t.projectId)));
    const projects = await this.prisma.project.findMany({
      where: { id: { in: projectIds }, organizationId: orgId, agentsEnabled: true },
      select: { id: true, stakes: true },
    });
    if (projects.length === 0) return empty;
    const stakesByProject = new Map<string, AgentTaskStakes | null>(
      projects.map((pr) => [pr.id, (pr.stakes ?? null) as AgentTaskStakes | null]),
    );
    const agentTargets = targets.filter((t) => stakesByProject.has(t.projectId));
    if (agentTargets.length === 0) return empty;

    // -------- Pool d'agents par projet : membres directs + membres des --------
    // -------- équipes affectées (même construction que le pool humain). --------
    const agentProjectIds = Array.from(stakesByProject.keys());
    const [members, projectTeams] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: {
          projectId: { in: agentProjectIds },
          user: { kind: 'AGENT', deletedAt: null, status: 'ACTIVE' },
        },
        select: { projectId: true, userId: true, user: { select: { name: true } } },
      }),
      this.prisma.projectTeam.findMany({
        where: { projectId: { in: agentProjectIds } },
        select: {
          projectId: true,
          team: {
            select: {
              members: {
                where: { user: { kind: 'AGENT', deletedAt: null, status: 'ACTIVE' } },
                select: { userId: true, user: { select: { name: true } } },
              },
            },
          },
        },
      }),
    ]);
    const poolByProject = new Map<string, Map<string, string>>();
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

    const allAgentIds = new Set<string>();
    for (const m of poolByProject.values()) for (const uid of m.keys()) allAgentIds.add(uid);
    if (allAgentIds.size === 0) return empty;

    const agentIdsArr = Array.from(allAgentIds);
    const [profiles, activeRows] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: agentIdsArr }, organizationId: orgId, kind: 'AGENT' },
        select: { id: true, capabilities: true, trustLevel: true, maxConcurrentTasks: true },
      }),
      // Concurrence : même ensemble de statuts que le refus 409
      // BUDGET_CONCURRENCY au claim (tasks.service.ts).
      this.prisma.taskAssignee.findMany({
        where: {
          userId: { in: agentIdsArr },
          task: {
            organizationId: orgId,
            deletedAt: null,
            status: { in: [TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS, TaskStatus.CHANGES_REQUESTED] },
          },
        },
        select: { userId: true },
      }),
    ]);
    const profileById = new Map(profiles.map((a) => [a.id, a]));
    const activeCountByAgent = new Map<string, number>();
    for (const r of activeRows) activeCountByAgent.set(r.userId, (activeCountByAgent.get(r.userId) ?? 0) + 1);

    const skillTarget = (level: number | null): number => (level && level > 0 ? level : skillMaxLevel);
    const meetsAllRequiredFor = (uid: string, taskId: string): boolean => {
      const reqs = skillReqByTask.get(taskId);
      if (!reqs || reqs.length === 0) return true;
      return reqs.every((r) => (userLevelOnSkill.get(`${uid}|${r.skillId}`) ?? 0) >= skillTarget(r.level));
    };
    const skillScoreFor = (uid: string, taskId: string): number => {
      const reqs = skillReqByTask.get(taskId);
      if (!reqs || reqs.length === 0) return 1;
      let sum = 0;
      for (const r of reqs) {
        sum += Math.min(1, (userLevelOnSkill.get(`${uid}|${r.skillId}`) ?? 0) / skillTarget(r.level));
      }
      return sum / reqs.length;
    };

    // Snapshot budget par (agentId, tâche) — borné : cette passe n'opère QUE
    // sur des tâches sans assigné de projets `agentsEnabled` (rare/opt-in),
    // jamais sur toute la grille de charge.
    const budgetCache = new Map<string, { stop: boolean; remaining: number }>();
    const budgetFor = async (agentId: string, t: ScopedTask) => {
      const key = `${agentId}|${t.id}`;
      let v = budgetCache.get(key);
      if (!v) {
        const snap = await this.agentBudget.snapshot(orgId, agentId, {
          projectId: t.projectId,
          taskId: t.id,
        });
        const remaining = snap.envelopes.length
          ? Math.min(...snap.envelopes.map((e) => e.remaining))
          : Number.POSITIVE_INFINITY;
        v = { stop: snap.stop, remaining };
        budgetCache.set(key, v);
      }
      return v;
    };

    type Evaluated = {
      userId: string;
      name: string;
      eligible: boolean;
      skillScore: number;
      remaining: number;
      free: number;
    };
    const candidateDto = (e: Evaluated): AssigneeCandidate => ({
      userId: e.userId,
      name: e.name,
      level: null,
      meetsRequired: e.eligible,
      // Sans objet pour un agent (la capacité n'est jamais des heures) —
      // l'UI n'affiche pas ce champ pour `isAgent`, cf. WorkloadView.
      freeHours: 0,
      score: round(e.skillScore * 100),
      isAgent: true,
      trustLevel: (profileById.get(e.userId)?.trustLevel ?? null) as AgentTrust | null,
    });

    const overrideByTask = new Map<string, string[]>();
    for (const o of overrides ?? []) overrideByTask.set(o.taskId, o.userIds);

    const assignments: ProposedAssignment[] = [];
    const assignmentChanges = new Map<string, { add: string[]; remove: string[] }>();
    const handledTaskIds = new Set<string>();

    for (const t of agentTargets) {
      const pool = poolByProject.get(t.projectId);
      if (!pool || pool.size === 0) continue; // pas de candidat agent → pool humain normal
      const stakes = stakesByProject.get(t.projectId) ?? null;

      const overrideIds = overrideByTask.get(t.id) ?? [];
      const overrideAgentIds = overrideIds.filter((id) => pool.has(id));
      // Le PM a explicitement demandé un HUMAIN pour cette tâche → jamais
      // imposer l'agent, même s'il était éligible. Le pool humain traite
      // l'override normalement (cf. autoAssignTasks).
      if (overrideIds.length > 0 && overrideAgentIds.length === 0) continue;

      const evaluated: Evaluated[] = [];
      for (const [uid, name] of pool) {
        const profile = profileById.get(uid);
        const capabilitiesCoverAction = !!profile?.capabilities?.includes('tasks:execute');
        const meetsRequiredSkills = meetsAllRequiredFor(uid, t.id);
        const { stop: budgetStop, remaining } = await budgetFor(uid, t);
        const max = profile?.maxConcurrentTasks ?? null;
        const active = activeCountByAgent.get(uid) ?? 0;
        const concurrencyFull = max != null && active >= max;
        const trustAllowsStakes = agentTrustAllowsStakes(
          stakes,
          (profile?.trustLevel ?? null) as AgentTrust | null,
        );
        const { eligible } = isAgentEligible({
          capabilitiesCoverAction,
          meetsRequiredSkills,
          budgetStop,
          concurrencyFull,
          trustAllowsStakes,
        });
        evaluated.push({
          userId: uid,
          name,
          eligible,
          skillScore: skillScoreFor(uid, t.id),
          remaining,
          free: max != null ? Math.max(0, max - active) : Number.POSITIVE_INFINITY,
        });
      }

      // -------- Override PM nommant un agent : ACCEPTATION explicite --------
      if (overrideAgentIds.length > 0) {
        const chosenId = overrideAgentIds[0];
        const chosenEval = evaluated.find((e) => e.userId === chosenId)!;
        assignmentChanges.set(t.id, { add: [chosenId], remove: [] });
        // Mute EN MÉMOIRE (même pattern que l'affectation humaine) : le reste
        // du pipeline (`nodesByTask`) filtre les agents des inScopeUserIds
        // humains → zéro node → zéro heure → warning `agent_assigned`, jamais
        // d'allocation. `handledTaskIds` retire de toute façon la tâche du
        // pool humain plus haut dans `run()`.
        t.assignees.length = 0;
        t.assignees.push({ userId: chosenId });
        handledTaskIds.add(t.id);
        assignments.push({
          taskId: t.id,
          projectId: t.projectId,
          chosen: [candidateDto(chosenEval)],
          alternatives: evaluated.filter((e) => e.userId !== chosenId && e.eligible).map(candidateDto),
          source: 'override',
          wasAssigned: false,
        });
        continue;
      }

      // -------- Suggestion algorithmique : SANS override, tâche INTOUCHÉE ---
      const eligibleSorted = evaluated
        .filter((e) => e.eligible)
        .sort(
          (a, b) =>
            b.skillScore - a.skillScore ||
            b.remaining - a.remaining ||
            b.free - a.free ||
            a.name.localeCompare(b.name),
        );
      if (eligibleSorted.length === 0) continue; // aucun agent éligible → pool humain normal

      handledTaskIds.add(t.id);
      assignments.push({
        taskId: t.id,
        projectId: t.projectId,
        chosen: [candidateDto(eligibleSorted[0])],
        alternatives: eligibleSorted.slice(1).map(candidateDto),
        source: 'agent_suggested',
        wasAssigned: false,
      });
    }

    return { assignments, assignmentChanges, handledTaskIds };
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
      tasks: ScopedTask[];
      cutoff: Date;
      to: Date;
      hoursPerDay: number;
      loggedHoursByTask: Map<string, number>;
      skillMaxLevel: number;
      userLevelOnSkill: Map<string, number>;
      skillReqByTask: Map<string, { skillId: string; level: number | null }[]>;
      overrides?: { taskId: string; userIds: string[] }[];
      reassign: boolean;
      /** Curseur de concentration (Lot 2.2) : `focus` (continuité 50, noyau
       *  élargi seulement si l'échéance est manquée — cf. note ci-dessous),
       *  `balanced` (continuité 30, comportement historique du lot 1b),
       *  `spread` (continuité 0, AUCUNE fusion de grappe — chaque tâche
       *  évaluée seule, la soupape de secours du lot 1b.1). */
      concentration: 'focus' | 'balanced' | 'spread';
    },
  ): Promise<{
    assignments: ProposedAssignment[];
    assignmentChanges: Map<string, { add: string[]; remove: string[] }>;
    warnings: AutoplanWarning[];
  }> {
    const {
      tasks,
      cutoff,
      to,
      hoursPerDay,
      loggedHoursByTask,
      skillMaxLevel,
      userLevelOnSkill,
      skillReqByTask,
      overrides,
      reassign,
      concentration,
    } = p;
    // Lot 2.2 : poids de continuité — dans la fourchette [continuity=0..1],
    // pondère de combien la continuité (déjà sur ce skill/projet) prime sur
    // la disponibilité (poids fixe 10) sans jamais dépasser le skill (100).
    const continuityWeight = concentration === 'focus' ? 50 : concentration === 'spread' ? 0 : 30;
    const overrideByTask = new Map<string, string[]>();
    for (const o of overrides ?? []) overrideByTask.set(o.taskId, o.userIds);
    const extraWarnings: AutoplanWarning[] = [];

    const skillTarget = (level: number | null): number =>
      level && level > 0 ? level : skillMaxLevel;
    /** Conjonction multi-skill (Lot 1b préalable) : le candidat doit atteindre
     *  la cible sur CHAQUE skill requis de la tâche. */
    const meetsAllRequiredFor = (uid: string, taskId: string): boolean => {
      const reqs = skillReqByTask.get(taskId);
      if (!reqs || reqs.length === 0) return true;
      return reqs.every(
        (r) => (userLevelOnSkill.get(`${uid}|${r.skillId}`) ?? 0) >= skillTarget(r.level),
      );
    };
    const skillScoreFor = (uid: string, taskId: string): number => {
      const reqs = skillReqByTask.get(taskId);
      if (!reqs || reqs.length === 0) return 1;
      let sum = 0;
      for (const r of reqs) {
        sum += Math.min(1, (userLevelOnSkill.get(`${uid}|${r.skillId}`) ?? 0) / skillTarget(r.level));
      }
      return sum / reqs.length;
    };
    // `level` d'affichage (badge UI) : reste scalaire (skill PRINCIPAL) pour ne
    // pas changer la forme du DTO — ne sert JAMAIS à l'éligibilité (multi-skill).
    const displayLevelFor = (uid: string, t: ScopedTask): number | null =>
      t.requiredSkillId ? userLevelOnSkill.get(`${uid}|${t.requiredSkillId}`) ?? 0 : null;

    const remainingOf = (t: ScopedTask) =>
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
      return { assignments: [], assignmentChanges: new Map(), warnings: [] };

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
    // Lot 1b.2 : précharge en PARALLÈLE la capacité de TOUT le pool concerné —
    // ensuite la concentration par grappe appelle `freeHoursInWindow` en
    // SYNCHRONE (ctx déjà en cache), ce qui réduit mécaniquement les
    // allers-retours vs l'ancien appel par (tâche × candidat).
    const allPoolIds = new Set<string>();
    for (const m of poolByProject.values()) for (const uid of m.keys()) allPoolIds.add(uid);
    await Promise.all(Array.from(allPoolIds, (uid) => ctxFor(uid)));
    const timeOffsByUser = new Map<string, { startDate: Date; endDate: Date }[]>();
    for (const uid of allPoolIds) {
      const ctx = ctxCache.get(uid);
      if (ctx) timeOffsByUser.set(uid, ctx.timeOffs);
    }

    // -------- Continuité (base + décidé plus tôt dans ce run) --------
    // key = `${userId}|${projectId}`. Alimenté par les assignations EXISTANTES
    // de TOUTES les tâches du scope (pas seulement `targets`), puis mis à jour
    // au fil des décisions de ce run (fresh clusters ET réassignations).
    const priorSkillsByUser = new Map<string, Set<string>>();
    const activeProjectMembers = new Map<string, Set<string>>();
    const markContinuity = (projectId: string, userId: string, skillIds: string[]): void => {
      let mem = activeProjectMembers.get(projectId);
      if (!mem) {
        mem = new Set();
        activeProjectMembers.set(projectId, mem);
      }
      mem.add(userId);
      if (!skillIds.length) return;
      const key = `${userId}|${projectId}`;
      let set = priorSkillsByUser.get(key);
      if (!set) {
        set = new Set();
        priorSkillsByUser.set(key, set);
      }
      for (const sid of skillIds) set.add(sid);
    };
    for (const t of tasks) {
      const skillIds = (skillReqByTask.get(t.id) ?? []).map((r) => r.skillId);
      for (const a of t.assignees) markContinuity(t.projectId, a.userId, skillIds);
    }

    const assignments: ProposedAssignment[] = [];
    const assignmentChanges = new Map<string, { add: string[]; remove: string[] }>();

    // ==============================================================
    // Tâches DÉJÀ assignées (reassign) : logique PAR TÂCHE, inchangée —
    // hors périmètre de la concentration (AUTOPLAN_IMPROVEMENTS.md §1b.1,
    // « Hors périmètre ») : on ne ré-attribue jamais d'office une tâche déjà
    // assignée à la main, seul le PM la propose au swap.
    // ==============================================================
    const reassignTargets = targets.filter((t) => (currentByTask.get(t.id) ?? []).length > 0);
    for (const t of reassignTargets) {
      const remaining = remainingOf(t);
      const pool = poolByProject.get(t.projectId);
      const current = currentByTask.get(t.id) ?? [];

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
        const ctx = await ctxFor(uid);
        const freeHours = this.capacity.freeHoursInWindow(ctx, wStart, wEnd, t.id);
        candidates.push({
          userId: uid,
          name,
          level: displayLevelFor(uid, t),
          meetsRequired: meetsAllRequiredFor(uid, t.id),
          freeHours: round(freeHours),
          score: round(skillScoreFor(uid, t.id) * 100 + Math.min(1, freeHours / Math.max(1, remaining)) * 10),
        });
      }

      const override = overrideByTask.get(t.id);
      let sel: ReturnType<typeof selectAssignees>;
      if (override && override.length) {
        // Le PM a swappé : on retient exactement les users demandés.
        sel = selectAssignees(candidates, remaining, override);
      } else {
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
      }

      const finalIds = sel.chosen.map((c) => c.userId);
      const currentSet = new Set(current);
      const finalSet = new Set(finalIds);
      const add = finalIds.filter((id) => !currentSet.has(id));
      const remove = current.filter((id) => !finalSet.has(id));
      if (add.length || remove.length) {
        assignmentChanges.set(t.id, { add, remove });
        t.assignees.length = 0;
        for (const uid of finalIds) t.assignees.push({ userId: uid });
        const skillIds = (skillReqByTask.get(t.id) ?? []).map((r) => r.skillId);
        for (const uid of finalIds) markContinuity(t.projectId, uid, skillIds);
      }

      assignments.push({
        taskId: t.id,
        projectId: t.projectId,
        chosen: sel.chosen,
        alternatives: sel.alternatives,
        source: sel.source,
        warning: sel.warning,
        wasAssigned: true,
      });
    }

    // ==============================================================
    // Tâches SANS assigné : concentration par grappe (Lot 1b.1/1b.2).
    // ==============================================================
    const freshTargets = targets.filter((t) => (currentByTask.get(t.id) ?? []).length === 0);
    if (freshTargets.length) {
      const reservedByUser = new Map<string, number>(); // Lot 1b.2
      const tasksById = new Map(freshTargets.map((t) => [t.id, t]));
      const effortByTask = new Map(freshTargets.map((t) => [t.id, remainingOf(t)]));

      // Groupage + fenêtre/effort + fusion set-cover, PAR PROJET (le pool de
      // candidats diffère par projet).
      const freshByProject = groupBy(freshTargets, (t) => t.projectId);
      let allClusters: WindowedCluster[] = [];
      for (const [projectId, projTasks] of freshByProject) {
        // Lot 2.2 — `spread` : soupape de secours, comportement historique
        // (chaque tâche évaluée SEULE). On construit directement des grappes
        // singleton, en sautant à la fois le groupage par skill/parent/board
        // (`buildAtomicClusters`) et la fusion set-cover — sinon on recrée
        // exactement l'émiettement que la concentration existe pour éviter.
        let windowed: WindowedCluster[];
        if (concentration === 'spread') {
          windowed = projTasks.map((t): WindowedCluster => {
            const skillReqs = (skillReqByTask.get(t.id) ?? []).map((r) => ({
              skillId: r.skillId,
              target: skillTarget(r.level),
            }));
            const effort = clusterEffort([t.id], effortByTask);
            const { start, end } = clusterWindow([t.id], tasksById, effort, cutoff, hoursPerDay, to);
            return {
              key: `${projectId}|task|${t.id}`,
              projectId,
              skillReqs,
              taskIds: [t.id],
              effort,
              windowStart: start,
              windowEnd: end,
            };
          });
          allClusters.push(...windowed);
          continue;
        }
        const inputs: ClusterInputTask[] = projTasks.map((t) => ({
          id: t.id,
          projectId,
          parentTaskId: t.parentTaskId ?? null,
          boardKey: t.boardColumn?.boardId ?? null,
          skillReqs: (skillReqByTask.get(t.id) ?? []).map((r) => ({
            skillId: r.skillId,
            target: skillTarget(r.level),
          })),
          startDate: t.startDate ?? null,
          dueDate: t.dueDate ?? null,
        }));
        const atomic = buildAtomicClusters(inputs);
        windowed = atomic.map((c) => {
          const effort = clusterEffort(c.taskIds, effortByTask);
          const { start, end } = clusterWindow(c.taskIds, tasksById, effort, cutoff, hoursPerDay, to);
          return { ...c, effort, windowStart: start, windowEnd: end };
        });
        const pool = poolByProject.get(projectId);
        const candidateIds = pool ? Array.from(pool.keys()) : [];
        const levelFor = (uid: string, sid: string) => userLevelOnSkill.get(`${uid}|${sid}`) ?? 0;
        const freeHoursFor = (uid: string, ws: Date, we: Date) => {
          const ctx = ctxCache.get(uid);
          if (!ctx) return 0;
          return Math.max(0, this.capacity.freeHoursInWindow(ctx, ws, we));
        };
        const merged = candidateIds.length
          ? mergeClustersBySetCover(windowed, candidateIds, levelFor, freeHoursFor)
          : windowed;
        allClusters.push(...merged);
      }
      // Traiter les grappes (tous projets confondus) par effort décroissant :
      // les plus contraignantes réservent la capacité en premier.
      allClusters = allClusters.sort(
        (a, b) => b.effort - a.effort || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );

      for (const cluster of allClusters) {
        const pool = poolByProject.get(cluster.projectId);
        if (!pool || pool.size === 0) {
          for (const taskId of cluster.taskIds) {
            assignments.push({
              taskId,
              projectId: cluster.projectId,
              chosen: [],
              alternatives: [],
              source: 'auto',
              warning: 'no_candidates',
              wasAssigned: false,
            });
          }
          continue;
        }

        const candidates: AssigneeCandidate[] = [];
        for (const [uid, name] of pool) {
          const ctx = ctxCache.get(uid);
          const freeHoursRaw = ctx ? this.capacity.freeHoursInWindow(ctx, cluster.windowStart, cluster.windowEnd) : 0;
          const freeHours = Math.max(0, freeHoursRaw - (reservedByUser.get(uid) ?? 0));
          const skillScore = cluster.skillReqs.length
            ? cluster.skillReqs.reduce(
                (s, r) => s + Math.min(1, (userLevelOnSkill.get(`${uid}|${r.skillId}`) ?? 0) / r.target),
                0,
              ) / cluster.skillReqs.length
            : 1;
          const continuity = continuityScore(
            cluster.skillReqs.map((r) => r.skillId),
            priorSkillsByUser.get(`${uid}|${cluster.projectId}`),
            activeProjectMembers.get(cluster.projectId)?.has(uid) ?? false,
          );
          const availScore = Math.min(1, freeHours / Math.max(1, cluster.effort));
          candidates.push({
            userId: uid,
            name,
            level:
              cluster.skillReqs.length === 1
                ? userLevelOnSkill.get(`${uid}|${cluster.skillReqs[0].skillId}`) ?? 0
                : null,
            meetsRequired: meetsAllRequired(cluster.skillReqs, (sid) => userLevelOnSkill.get(`${uid}|${sid}`) ?? 0),
            freeHours: round(freeHours),
            score: round(skillScore * 100 + continuity * continuityWeight + availScore * 10),
          });
        }

        // Écarter les absents (filtre dur) + fallback si le filtre vide le
        // pool alors que des candidats QUALIFIÉS existaient.
        const { core: filteredCore } = filterAbsentCandidates(
          candidates,
          timeOffsByUser,
          cluster.windowStart,
          cluster.windowEnd,
        );
        let core = filteredCore;
        let fellBack = false;
        if (core.length === 0 && candidates.some((c) => c.meetsRequired)) {
          core = candidates; // réintègre tout le monde (excluded === candidates ici)
          fellBack = true;
        }
        if (fellBack) {
          for (const taskId of cluster.taskIds) {
            const tt = tasksById.get(taskId)!;
            extraWarnings.push({
              taskId,
              type: 'all_candidates_unavailable',
              message: `Aucun candidat disponible pour la tâche "${tt.title}" (tous en congé ou sans capacité) — affectation forcée malgré l'indisponibilité, à vérifier.`,
            });
          }
        }
        const coreIds = new Set(core.map((c) => c.userId));
        const markedCandidates = candidates.map((c) =>
          coreIds.has(c.userId) ? c : { ...c, unavailable: true },
        );
        const swapPool = [...markedCandidates].sort(
          (a, b) =>
            Number(b.meetsRequired) - Number(a.meetsRequired) ||
            b.score - a.score ||
            b.freeHours - a.freeHours ||
            a.name.localeCompare(b.name),
        );

        // Noyau de la grappe (couverture greedy, pur — même moteur que le mode
        // par tâche historique) puis répartition sur ce noyau (Lot 1b.1).
        const sel = selectAssignees(core, cluster.effort);
        const overrideTaskIds = new Set(
          cluster.taskIds.filter((id) => (overrideByTask.get(id)?.length ?? 0) > 0),
        );
        const distTasks = cluster.taskIds
          .filter((id) => !overrideTaskIds.has(id))
          .map((id) => ({ id, effort: effortByTask.get(id) ?? 0 }));
        const coreMembers = sel.chosen.map((c) => ({ userId: c.userId, residualHours: c.freeHours }));
        const { distributions, residualByUser } = distributeClusterTasks(distTasks, coreMembers);
        const distByTask = new Map(distributions.map((d) => [d.taskId, d.assigneeIds]));

        for (const taskId of cluster.taskIds) {
          const t = tasksById.get(taskId)!;
          const override = overrideByTask.get(taskId);
          let finalIds: string[];
          let source: 'auto' | 'override';
          let warning: 'no_candidates' | 'no_qualified' | 'capacity_short' | undefined;

          if (override && override.length) {
            const selT = selectAssignees(candidates, effortByTask.get(taskId) ?? 0, override);
            finalIds = selT.chosen.map((c) => c.userId);
            source = 'override';
            warning = selT.warning;
            const per = finalIds.length ? (effortByTask.get(taskId) ?? 0) / finalIds.length : 0;
            for (const uid of finalIds) reservedByUser.set(uid, (reservedByUser.get(uid) ?? 0) + per);
          } else {
            finalIds = distByTask.get(taskId) ?? [];
            source = 'auto';
            warning = sel.warning; // hérité du sizing du noyau (no_candidates/no_qualified/capacity_short)
          }

          const chosenIdsSet = new Set(finalIds);
          const chosenForTask = finalIds
            .map((uid) => markedCandidates.find((c) => c.userId === uid))
            .filter((c): c is AssigneeCandidate => !!c);

          if (finalIds.length) {
            assignmentChanges.set(taskId, { add: finalIds, remove: [] });
            t.assignees.length = 0;
            for (const uid of finalIds) t.assignees.push({ userId: uid });
            const skillIds = cluster.skillReqs.map((r) => r.skillId);
            for (const uid of finalIds) markContinuity(cluster.projectId, uid, skillIds);
          }

          assignments.push({
            taskId,
            projectId: cluster.projectId,
            chosen: chosenForTask,
            alternatives: swapPool.filter((c) => !chosenIdsSet.has(c.userId)),
            source,
            warning,
            wasAssigned: false,
          });
        }

        // Lot 1b.2 : crédite la réservation globale de chaque membre du noyau
        // à hauteur de ce que la grappe a réellement consommé (freeHours
        // initiale − résiduel final) — les grappes SUIVANTES (même d'un autre
        // projet, une personne pouvant apparaître dans plusieurs pools) verront
        // sa capacité réduite d'autant.
        for (const c of sel.chosen) {
          const finalResidual = residualByUser.get(c.userId) ?? c.freeHours;
          const consumed = Math.max(0, c.freeHours - finalResidual);
          if (consumed > HOURS_EPS) {
            reservedByUser.set(c.userId, (reservedByUser.get(c.userId) ?? 0) + consumed);
          }
        }
      }
    }

    return { assignments, assignmentChanges, warnings: extraWarnings };
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
// Pure helpers locaux (date helpers communs déplacés dans ./scheduling ;
// `scheduleHoursFor` réutilisé depuis ./capacity.service — Lot 1c.1, ne plus
// dupliquer)
// ============================================================

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
