import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { CapacityService } from '../workload/capacity.service';
import { FinanceService } from '../finance/finance.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import {
  AutomationKind,
  daysLate,
  daysUntil,
  highestTierCrossed,
  isDueWithin,
  isoWeekKey,
  isoWeekRange,
  MAX_ALERTS_PER_RULE_PER_TICK,
  olderThanDays,
  pct,
} from './automation-rules';
import { AutomationsSettings } from './automations-settings';
import { readSponsorNotify } from './sponsor-notify';
import { AutomationActionsService, AutomationRecipient, EmitOutcome } from './automation-actions.service';
import { AutomationRecipientsService } from './automation-recipients.service';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RunCounters {
  sent: number;
  cooldown: number;
  deferred: number;
  capped: number;
}

/** Tâche candidate chargée par les requêtes des règles hygiène. */
interface CandidateTask {
  id: string;
  title: string;
  dueDate: Date | null;
  updatedAt: Date;
  createdAt: Date;
  externalBlockedAt: Date | null;
  project: { id: string; name: string };
}

const TASK_SELECT = {
  id: true,
  title: true,
  dueDate: true,
  updatedAt: true,
  createdAt: true,
  externalBlockedAt: true,
  project: { select: { id: true, name: true } },
} as const;

/**
 * Requêtes et déclenchement des règles évaluées par le cron. Les décisions
 * pures (fenêtres de jours, retards) vivent dans `automation-rules.ts` ; les
 * toggles/seuils dans `automations-settings.ts` ; l'émission (cooldown,
 * email, webhook, audit) dans `AutomationActionsService`.
 *
 * Périmètre commun : tâches non supprimées de projets ACTIVE, kind STANDARD
 * (jamais les buckets de tickets externes, jamais les drafts/archivés).
 */
@Injectable()
export class AutomationsEvaluatorService {
  private readonly log = new Logger(AutomationsEvaluatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: AutomationActionsService,
    private readonly recipients: AutomationRecipientsService,
    private readonly settings: AdminSettingsService,
    private readonly capacity: CapacityService,
    private readonly finance: FinanceService,
    private readonly tenantUrl: TenantUrlService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Exécute les règles quotidiennes pour une org (contexte tenant déjà posé).
   * L'appelant (cron / route admin) a déjà vérifié `settings.enabled` et le
   * gate `dailyHour`.
   */
  async runDailyRules(orgId: string, s: AutomationsSettings): Promise<RunCounters> {
    const counters: RunCounters = { sent: 0, cooldown: 0, deferred: 0, capped: 0 };
    const now = new Date();

    if (s.onHoldDormant.enabled) {
      await this.runOnHoldDormant(orgId, s, now, counters);
    }
    if (s.overdue.enabled) {
      await this.runOverdue(orgId, s, now, counters);
    }
    if (s.inProgressInactive.enabled) {
      await this.runInProgressInactive(orgId, s, now, counters);
    }
    if (s.unassignedStale.enabled) {
      await this.runUnassignedStale(orgId, s, now, counters);
    }
    if (s.externalBlockedStale.enabled) {
      await this.runExternalBlockedStale(orgId, s, now, counters);
    }
    if (s.milestoneAtRisk.enabled) {
      await this.runMilestoneAtRisk(orgId, s, now, counters);
    }
    if (s.projectInactive.enabled) {
      await this.runProjectInactive(orgId, s, now, counters);
    }
    if (s.projectEndSoon.enabled) {
      await this.runProjectEndSoon(orgId, s, now, counters);
    }
    if (s.overload.enabled || s.underload.enabled) {
      await this.runCapacityRules(orgId, s, now, counters);
    }
    if (s.budgetThreshold.enabled || s.forecastOverrun.enabled) {
      await this.runFinanceRules(orgId, s, counters);
    }

    return counters;
  }

  /**
   * Règles horaires — celles dont la latence compte : un budget agent qui se
   * remplit ou une revue qui traîne se signalent dans l'heure, pas le lendemain.
   */
  async runHourlyRules(orgId: string, s: AutomationsSettings): Promise<RunCounters> {
    const counters: RunCounters = { sent: 0, cooldown: 0, deferred: 0, capped: 0 };
    const now = new Date();
    if (s.agentBudget.enabled) {
      await this.runAgentBudget(orgId, s, now, counters);
    }
    if (s.deliverableStale.enabled) {
      await this.runDeliverableStale(orgId, s, now, counters);
    }
    return counters;
  }

  /**
   * Règles hebdomadaires — évaluées sur la semaine ISO **échue** (on ne
   * reproche pas une timesheet incomplète en cours de semaine). L'appelant a
   * déjà vérifié le gate jour+heure.
   */
  async runWeeklyRules(orgId: string, s: AutomationsSettings): Promise<RunCounters> {
    const counters: RunCounters = { sent: 0, cooldown: 0, deferred: 0, capped: 0 };
    const lastWeek = new Date(Date.now() - 7 * DAY_MS);
    const { start, end } = isoWeekRange(lastWeek);
    const weekKey = isoWeekKey(lastWeek);

    if (s.timesheetReminder.enabled) {
      await this.runTimesheetReminder(orgId, s, start, end, weekKey, counters);
    }
    if (s.overtime.enabled) {
      await this.runOvertime(orgId, s, start, end, weekKey, counters);
    }
    if (s.utilization.enabled) {
      await this.runUtilization(orgId, s, start, end, weekKey, counters);
    }
    return counters;
  }

  /** Périmètre projet commun à toutes les règles tâche. */
  private taskScope(orgId: string) {
    return {
      organizationId: orgId,
      deletedAt: null,
      project: { deletedAt: null, status: 'ACTIVE' as const, kind: 'STANDARD' as const },
    };
  }

  /** Charge les candidats d'une règle avec cap anti-tempête (loggé, jamais silencieux). */
  private async loadCandidates(
    kind: AutomationKind,
    orgId: string,
    where: Record<string, unknown>,
    counters: RunCounters,
  ): Promise<CandidateTask[]> {
    const rows = await this.prisma.task.findMany({
      where: { ...this.taskScope(orgId), ...where },
      select: TASK_SELECT,
      orderBy: { updatedAt: 'asc' },
      take: MAX_ALERTS_PER_RULE_PER_TICK + 1,
    });
    if (rows.length > MAX_ALERTS_PER_RULE_PER_TICK) {
      counters.capped += 1;
      this.log.warn(
        `rule=${kind} org=${orgId}: more than ${MAX_ALERTS_PER_RULE_PER_TICK} candidates — capped this tick, remainder picked up on later ticks`,
      );
      return rows.slice(0, MAX_ALERTS_PER_RULE_PER_TICK);
    }
    return rows;
  }

  // Liens sortants : origine résolue PAR TENANT (le cron pose le contexte via
  // `tenantCtx.run`), jamais l'`APP_URL` global. Cf. TenantUrlService.
  private taskUrl(taskId: string): string {
    return this.tenantUrl.taskUrl(taskId);
  }

  private projectUrl(projectId: string): string {
    return this.tenantUrl.projectUrl(projectId);
  }

  private viewUrl(view: string): string {
    return this.tenantUrl.viewUrl(view);
  }

  /** Users humains actifs de l'org (maille des règles par personne). */
  private async activeHumans(orgId: string) {
    return this.prisma.user.findMany({
      where: { organizationId: orgId, kind: 'HUMAN', status: 'ACTIVE', deletedAt: null },
      select: { id: true, name: true, email: true, preferredLanguage: true },
    });
  }

  private bump(counters: RunCounters, outcome: 'sent' | 'cooldown' | 'deferred' | 'error'): void {
    if (outcome === 'sent') counters.sent += 1;
    else if (outcome === 'cooldown') counters.cooldown += 1;
    else if (outcome === 'deferred') counters.deferred += 1;
  }

  /**
   * `TasksService` résolu en **lazy** : `AutomationsModule` importe
   * `WorkloadModule`/`FinanceModule`, et `TasksModule` importe indirectement
   * de quoi boucler — un import direct créerait un cycle. Best-effort.
   */
  private tasksService(): TasksService | null {
    try {
      return this.moduleRef.get(TasksService, { strict: false });
    } catch {
      return null;
    }
  }

  private async emitTaskAlert(
    orgId: string,
    kind: AutomationKind,
    task: CandidateTask,
    recipients: AutomationRecipient[],
    params: { days: number; dueDate?: string },
    counters: RunCounters,
  ): Promise<void> {
    await this.emitTaskAlertOut(orgId, kind, task, recipients, params, counters);
  }

  /** Variante de `emitTaskAlert` qui rend l'issue — utile quand une mutation
   *  doit être adossée à l'envoi réel de l'alerte (cf. bump de priorité). */
  private async emitTaskAlertOut(
    orgId: string,
    kind: AutomationKind,
    task: CandidateTask,
    recipients: AutomationRecipient[],
    params: { days: number; dueDate?: string },
    counters: RunCounters,
  ): Promise<EmitOutcome | null> {
    if (!recipients.length) return null;
    const outcome = await this.actions.emit(orgId, {
      kind,
      entityId: task.id,
      recipients,
      params: {
        taskTitle: task.title,
        projectName: task.project.name,
        days: params.days,
        dueDate: params.dueDate,
      },
      taskId: task.id,
      projectId: task.project.id,
      url: this.taskUrl(task.id),
    });
    this.bump(counters, outcome);
    return outcome;
  }

  // Règle 1 — ON_HOLD sans mouvement depuis N jours → PM projet.
  private async runOnHoldDormant(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.onHoldDormant.days * DAY_MS);
    const tasks = await this.loadCandidates('on_hold_dormant', orgId, {
      status: 'ON_HOLD',
      updatedAt: { lte: threshold },
    }, counters);
    for (const task of tasks) {
      if (!olderThanDays(task.updatedAt, now, s.onHoldDormant.days)) continue;
      const pms = await this.recipients.projectPMs(task.project.id);
      const stalledDays = Math.floor((now.getTime() - task.updatedAt.getTime()) / DAY_MS);
      await this.emitTaskAlert(orgId, 'on_hold_dormant', task, pms, { days: stalledDays }, counters);
    }
  }

  // Règle 2 — due date (+ grâce) dépassée, non terminée → assignés + PM,
  // + bump optionnel de la priorité (mutation, opt-in).
  private async runOverdue(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.overdue.graceDays * DAY_MS);
    const tasks = await this.loadCandidates('overdue', orgId, {
      status: { notIn: ['DONE'] },
      dueDate: { lt: threshold },
    }, counters);
    for (const task of tasks) {
      if (!task.dueDate) continue;
      const [assignees, pms] = await Promise.all([
        this.recipients.assigneesOf(task.id),
        this.recipients.projectPMs(task.project.id),
      ]);
      const outcome = await this.emitTaskAlertOut(
        orgId,
        'overdue',
        task,
        this.recipients.merge(assignees, pms),
        { days: daysLate(task.dueDate, now), dueDate: task.dueDate.toISOString().slice(0, 10) },
        counters,
      );
      // Bump de priorité adossé à l'alerte : on ne mute QUE lorsque l'alerte
      // part réellement (`sent`). Le cooldown de la règle gate ainsi les deux —
      // une tâche en retard depuis un mois n'est pas re-bumpée chaque jour.
      if (s.overdue.bumpPriority && outcome === 'sent') {
        await this.bumpPriority(orgId, task);
      }
    }
  }

  /**
   * Passe une tâche en priorité HIGH. Ne dégrade jamais : une tâche déjà HIGH
   * ou URGENT est laissée telle quelle (sinon on écraserait le jugement d'un
   * humain qui l'a montée à URGENT).
   *
   * Écrit via `TasksService.update` — jamais Prisma direct : on hérite ainsi de
   * l'historique de statut, des webhooks et du diff d'audit, sans les
   * ré-implémenter ni risquer de diverger.
   */
  private async bumpPriority(orgId: string, task: CandidateTask): Promise<void> {
    try {
      const current = await this.prisma.task.findUnique({
        where: { id: task.id },
        select: { priority: true },
      });
      if (!current || current.priority === 'HIGH' || current.priority === 'URGENT') return;
      const tasks = this.tasksService();
      if (!tasks) return;
      await tasks.update(orgId, task.id, { priority: 'HIGH' }, null, {
        isAdmin: true,
        system: true,
      });
      this.actions.logMutation(orgId, {
        kind: 'overdue',
        resourceType: 'task',
        resourceId: task.id,
        resourceLabel: task.title,
        field: 'priority',
        before: current.priority,
        after: 'HIGH',
      });
    } catch (err) {
      // Fail-open : l'alerte est déjà partie, une mutation ratée ne doit pas
      // interrompre le traitement des tâches suivantes.
      this.log.warn(`bumpPriority task=${task.id} failed: ${(err as Error).message}`);
    }
  }

  // Règle 3 — IN_PROGRESS sans activité depuis N jours → assignés (fallback PM).
  private async runInProgressInactive(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.inProgressInactive.days * DAY_MS);
    const tasks = await this.loadCandidates('in_progress_inactive', orgId, {
      status: 'IN_PROGRESS',
      updatedAt: { lte: threshold },
    }, counters);
    for (const task of tasks) {
      const assignees = await this.recipients.assigneesOf(task.id);
      const to = assignees.length ? assignees : await this.recipients.projectPMs(task.project.id);
      const stalledDays = Math.floor((now.getTime() - task.updatedAt.getTime()) / DAY_MS);
      await this.emitTaskAlert(orgId, 'in_progress_inactive', task, to, { days: stalledDays }, counters);
    }
  }

  // Règle 5 — TODO sans assigné depuis N jours (depuis la création) → PM projet.
  private async runUnassignedStale(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.unassignedStale.days * DAY_MS);
    const tasks = await this.loadCandidates('unassigned_stale', orgId, {
      status: 'TODO',
      createdAt: { lte: threshold },
      assignees: { none: {} },
    }, counters);
    for (const task of tasks) {
      const pms = await this.recipients.projectPMs(task.project.id);
      const waitingDays = Math.floor((now.getTime() - task.createdAt.getTime()) / DAY_MS);
      await this.emitTaskAlert(orgId, 'unassigned_stale', task, pms, { days: waitingDays }, counters);
    }
  }

  // Règle — tâche bloquée par un prestataire externe depuis > N jours → PM
  // projet + assignés. `externalBlockedAt` est posé au passage false→true de
  // `externalBlocked` (cf. TasksService), effacé au déblocage.
  private async runExternalBlockedStale(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.externalBlockedStale.days * DAY_MS);
    const tasks = await this.loadCandidates('external_blocked_stale', orgId, {
      status: { notIn: ['DONE'] },
      externalBlocked: true,
      externalBlockedAt: { lte: threshold },
    }, counters);
    for (const task of tasks) {
      if (!task.externalBlockedAt) continue;
      const [assignees, pms] = await Promise.all([
        this.recipients.assigneesOf(task.id),
        this.recipients.projectPMs(task.project.id),
      ]);
      const blockedDays = Math.floor((now.getTime() - task.externalBlockedAt.getTime()) / DAY_MS);
      await this.emitTaskAlert(
        orgId,
        'external_blocked_stale',
        task,
        this.recipients.merge(assignees, pms),
        { days: blockedDays },
        counters,
      );
    }
  }

  // Règle 7 — jalon à échéance proche avec des prérequis non terminés → PM.
  private async runMilestoneAtRisk(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const horizon = new Date(now.getTime() + s.milestoneAtRisk.days * DAY_MS);
    const milestones = await this.prisma.task.findMany({
      where: {
        ...this.taskScope(orgId),
        isMilestone: true,
        status: { notIn: ['DONE'] },
        dueDate: { gte: now, lte: horizon },
      },
      select: {
        ...TASK_SELECT,
        // sponsorNotify : opt-in projet « jalon à risque → sponsors aussi ».
        project: { select: { id: true, name: true, sponsorNotify: true } },
        // `predecessorLinks` = liens où CETTE tâche est le successeur (relation
        // "DependencySuccessor") → `predecessor` est la tâche amont.
        predecessorLinks: {
          select: { predecessor: { select: { id: true, status: true, deletedAt: true } } },
        },
      },
      orderBy: { dueDate: 'asc' },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    for (const m of milestones) {
      if (!m.dueDate || !isDueWithin(m.dueDate, now, s.milestoneAtRisk.days)) continue;
      const blocking = m.predecessorLinks.filter(
        (l) => l.predecessor && !l.predecessor.deletedAt && l.predecessor.status !== 'DONE',
      ).length;
      if (blocking === 0) continue; // jalon tenu : rien à signaler
      const pms = await this.recipients.projectPMs(m.project.id);
      if (!pms.length) continue;
      // Opt-in projet (feed sponsor) : les sponsors s'ajoutent aux PM sur la
      // même alerte (aucune donnée financière ici) — dédup au chokepoint.
      const sponsors = readSponsorNotify(m.project.sponsorNotify).milestoneAtRisk
        ? await this.recipients.projectSponsors(m.project.id)
        : [];
      const outcome = await this.actions.emit(orgId, {
        kind: 'milestone_at_risk',
        entityId: m.id,
        recipients: this.recipients.merge(pms, sponsors),
        params: {
          taskTitle: m.title,
          projectName: m.project.name,
          days: daysUntil(m.dueDate, now),
          dueDate: m.dueDate.toISOString().slice(0, 10),
          count: blocking,
        },
        taskId: m.id,
        projectId: m.project.id,
        url: this.taskUrl(m.id),
      });
      this.bump(counters, outcome);
    }
  }

  // Règle 21 — projet ACTIVE sans aucune activité depuis N jours → PM.
  // « Activité » = tâche modifiée OU temps loggé OU commentaire. Pré-filtre sur
  // les tâches (indexé, une requête), puis confirmation temps/commentaires
  // seulement sur les candidats — sinon un projet où l'on ne fait que logger du
  // temps serait faussement déclaré inactif.
  private async runProjectInactive(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.projectInactive.days * DAY_MS);
    const projects = await this.prisma.project.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: 'ACTIVE',
        kind: 'STANDARD',
        updatedAt: { lte: threshold },
        tasks: { none: { updatedAt: { gt: threshold }, deletedAt: null } },
      },
      select: { id: true, name: true },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    for (const p of projects) {
      const [entry, comment] = await Promise.all([
        this.prisma.timeEntry.findFirst({
          where: { organizationId: orgId, task: { projectId: p.id }, createdAt: { gt: threshold } },
          select: { id: true },
        }),
        this.prisma.comment.findFirst({
          where: {
            organizationId: orgId,
            deletedAt: null,
            task: { projectId: p.id },
            createdAt: { gt: threshold },
          },
          select: { id: true },
        }),
      ]);
      if (entry || comment) continue; // activité réelle, pas d'alerte
      const pms = await this.recipients.projectPMs(p.id);
      if (!pms.length) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'project_inactive',
        entityId: p.id,
        recipients: pms,
        params: { projectName: p.name, days: s.projectInactive.days },
        projectId: p.id,
        url: this.projectUrl(p.id),
      });
      this.bump(counters, outcome);
    }
  }

  // ============================================================
  // Workload — règles 9 (surcharge) & 10 (sous-charge)
  // ============================================================

  /**
   * `CapacityService.analyzeUsersCapacity` est batch et sans RBAC — préféré à
   * `workloadGrid`, dont le scoping dépend d'un requester appelant.
   * Fenêtres distinctes : la surcharge regarde la semaine à venir (actionnable
   * tout de suite), la sous-charge un horizon plus long (staffing).
   */
  private async runCapacityRules(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const users = await this.activeHumans(orgId);
    if (!users.length) return;
    const byId = new Map(users.map((u) => [u.id, u]));
    const ids = users.map((u) => u.id);

    if (s.overload.enabled) {
      const { perUser } = await this.capacity.analyzeUsersCapacity(
        orgId,
        ids,
        now,
        new Date(now.getTime() + 7 * DAY_MS),
      );
      for (const row of perUser) {
        // Capacité nulle = semaine entièrement en congé/fériés : pas une surcharge.
        if (row.availableHours <= 0) continue;
        const load = pct(row.allocatedHours, row.availableHours);
        if (load < s.overload.thresholdPct) continue;
        const user = byId.get(row.userId);
        if (!user) continue;
        const leads = await this.recipients.teamLeadsOf(orgId, row.userId);
        if (!leads.length) continue;
        const outcome = await this.actions.emit(orgId, {
          kind: 'overload',
          entityId: row.userId,
          recipients: leads,
          params: { userName: user.name, pct: load, hours: Math.round(row.allocatedHours) },
          url: this.viewUrl('workload'),
        });
        this.bump(counters, outcome);
      }
    }

    if (s.underload.enabled) {
      const days = s.underload.weeks * 7;
      const { perUser } = await this.capacity.analyzeUsersCapacity(
        orgId,
        ids,
        now,
        new Date(now.getTime() + days * DAY_MS),
      );
      for (const row of perUser) {
        if (row.availableHours <= 0) continue;
        const load = pct(row.allocatedHours, row.availableHours);
        if (load >= s.underload.thresholdPct) continue;
        const user = byId.get(row.userId);
        if (!user) continue;
        const leads = await this.recipients.teamLeadsOf(orgId, row.userId);
        if (!leads.length) continue;
        const outcome = await this.actions.emit(orgId, {
          kind: 'underload',
          entityId: row.userId,
          recipients: leads,
          params: {
            userName: user.name,
            pct: load,
            days,
            hours: Math.round(Math.max(0, row.headroomHours)),
          },
          url: this.viewUrl('workload'),
        });
        this.bump(counters, outcome);
      }
    }
  }

  // ============================================================
  // Finance — règles 14 (paliers budget) & 15 (dérive du prévisionnel)
  // ============================================================

  /**
   * Seuls les projets ACTIVE avec un `budgetAmount` défini sont concernés (sans
   * budget, aucun palier n'a de sens). `getBudgetSummary` est coûteux (plusieurs
   * requêtes + capacité + agents) → boucle séquentielle, jamais de `Promise.all`
   * massif, et cap au passage.
   */
  private async runFinanceRules(
    orgId: string,
    s: AutomationsSettings,
    counters: RunCounters,
  ): Promise<void> {
    const projects = await this.prisma.project.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: 'ACTIVE',
        kind: 'STANDARD',
        budgetAmount: { not: null },
      },
      select: { id: true, name: true, sponsorNotify: true },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    if (!projects.length) return;
    const currency = await this.settings.getCurrency(orgId).catch(() => 'EUR');
    const money = (n: number) => `${Math.round(n).toLocaleString('en-US')} ${currency}`;

    for (const p of projects) {
      let sum: Awaited<ReturnType<FinanceService['getBudgetSummary']>>;
      try {
        sum = await this.finance.getBudgetSummary(orgId, p.id);
      } catch (err) {
        this.log.warn(`budget summary project=${p.id} failed: ${(err as Error).message}`);
        continue;
      }
      if (sum.budgetAmount == null || sum.budgetAmount <= 0) continue;

      // Règle 14 — palier de coût RÉEL franchi. Cooldown qualifié par palier :
      // un budget qui oscille autour de 80 % n'alerte qu'une fois par mois.
      if (s.budgetThreshold.enabled && sum.spentPct != null) {
        const tier = highestTierCrossed(sum.spentPct, s.budgetThreshold.tiers);
        if (tier != null) {
          const to = await this.recipients.financeRecipients(orgId, p.id);
          if (to.length) {
            const outcome = await this.actions.emit(orgId, {
              kind: 'budget_threshold',
              entityId: p.id,
              qualifier: String(tier),
              recipients: to,
              params: {
                projectName: p.name,
                pct: Math.round(sum.spentPct),
                tier,
                amount: money(sum.actualCost),
                budget: money(sum.budgetAmount),
              },
              projectId: p.id,
              url: this.projectUrl(p.id),
            });
            this.bump(counters, outcome);
          }

          // Miroir sponsor opt-in (feed sponsor) : alerte SÉPARÉE et
          // QUALITATIVE — palier franchi, jamais de montants (le budget
          // chiffré reste derrière finance:view). Kind distinct → cooldown
          // propre (le cooldown PM déjà consommé ne la bloque pas).
          if (readSponsorNotify(p.sponsorNotify).budgetThresholds) {
            const sponsors = await this.recipients.projectSponsors(p.id);
            if (sponsors.length) {
              const outcome = await this.actions.emit(orgId, {
                kind: 'sponsor_budget',
                entityId: p.id,
                qualifier: String(tier),
                recipients: sponsors,
                params: { projectName: p.name, tier },
                projectId: p.id,
                url: this.projectUrl(p.id),
              });
              this.bump(counters, outcome);
            }
          }
        }
      }

      // Règle 15 — le prévisionnel à terminaison dépasse le budget alors que le
      // réel tient encore. Au-delà de 100 % de réel, la règle 14 l'a déjà dit →
      // on ne double pas l'alerte.
      if (
        s.forecastOverrun.enabled &&
        sum.forecastCost > sum.budgetAmount &&
        (sum.spentPct == null || sum.spentPct < 100)
      ) {
        const to = await this.recipients.financeRecipients(orgId, p.id);
        if (to.length) {
          const outcome = await this.actions.emit(orgId, {
            kind: 'forecast_overrun',
            entityId: p.id,
            recipients: to,
            params: {
              projectName: p.name,
              pct: pct(sum.forecastCost, sum.budgetAmount),
              amount: money(sum.forecastCost),
              budget: money(sum.budgetAmount),
            },
            projectId: p.id,
            url: this.projectUrl(p.id),
          });
          this.bump(counters, outcome);
        }
      }
    }
  }

  // ============================================================
  // Agents IA — règles horaires 19 (budget) & 20 (livrable en attente)
  // ============================================================

  /** Somme des coûts de runs agent sur un périmètre (Decimal → number). */
  private async agentRunCost(where: Record<string, unknown>): Promise<number> {
    const agg = await this.prisma.agentRun.aggregate({ _sum: { cost: true }, where });
    return Number(agg._sum.cost ?? 0);
  }

  /**
   * Règle 19 — prévenir AVANT le mur. Les quatre budgets agent sont enforce au
   * claim (`BUDGET_COST_DAILY|MONTHLY|PROJECT|TASK` dans `TasksService.claim`,
   * refus si `dépensé >= budget`) ; cette règle alerte au seuil (défaut 80 %)
   * pour qu'on puisse relever l'enveloppe avant que les agents se bloquent.
   *
   * Les 4 périmètres sont traités, chacun avec sa clé de cooldown propre :
   * agent×jour, agent×mois, projet (enveloppe totale), tâche (enveloppe totale).
   */
  private async runAgentBudget(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const currency = await this.settings.getCurrency(orgId).catch(() => 'EUR');
    const money = (n: number) => `${Math.round(n * 100) / 100} ${currency}`;
    const threshold = s.agentBudget.thresholdPct;
    const dayKey = now.toISOString().slice(0, 10);
    const monthKey = now.toISOString().slice(0, 7);
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

    // --- Budgets par agent (jour / mois). L'agent est un User kind=AGENT.
    const agents = await this.prisma.user.findMany({
      where: {
        organizationId: orgId,
        kind: 'AGENT',
        status: 'ACTIVE',
        deletedAt: null,
        OR: [{ dailyCostBudget: { not: null } }, { monthlyCostBudget: { not: null } }],
      },
      select: { id: true, name: true, ownerId: true, dailyCostBudget: true, monthlyCostBudget: true },
    });
    for (const agent of agents) {
      const windows: Array<{ scope: 'daily' | 'monthly'; budget: number; since: Date; qual: string }> = [];
      if (agent.dailyCostBudget != null) {
        windows.push({ scope: 'daily', budget: Number(agent.dailyCostBudget), since: dayStart, qual: dayKey });
      }
      if (agent.monthlyCostBudget != null) {
        windows.push({ scope: 'monthly', budget: Number(agent.monthlyCostBudget), since: monthStart, qual: monthKey });
      }
      for (const w of windows) {
        if (w.budget <= 0) continue;
        const spent = await this.agentRunCost({
          organizationId: orgId,
          agentId: agent.id,
          createdAt: { gte: w.since },
        });
        const ratio = pct(spent, w.budget);
        if (ratio < threshold) continue;
        const to = await this.recipients.agentSupervisors(orgId, agent.ownerId);
        if (!to.length) continue;
        const outcome = await this.actions.emit(orgId, {
          kind: 'agent_budget',
          entityId: agent.id,
          qualifier: `${w.scope}:${w.qual}`,
          recipients: to,
          params: {
            scope: `${agent.name} (${w.scope === 'daily' ? 'day' : 'month'})`,
            pct: ratio,
            amount: money(spent),
            budget: money(w.budget),
          },
          url: this.viewUrl('admin'),
        });
        this.bump(counters, outcome);
      }
    }

    // --- Enveloppe totale par projet (tous agents confondus, sans fenêtre).
    const projects = await this.prisma.project.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: 'ACTIVE',
        agentCostBudget: { not: null },
      },
      select: { id: true, name: true, agentCostBudget: true },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    for (const p of projects) {
      const budget = Number(p.agentCostBudget);
      if (budget <= 0) continue;
      const spent = await this.agentRunCost({ organizationId: orgId, projectId: p.id });
      const ratio = pct(spent, budget);
      if (ratio < threshold) continue;
      const to = await this.recipients.financeRecipients(orgId, p.id);
      if (!to.length) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'agent_budget',
        entityId: p.id,
        qualifier: 'project',
        recipients: to,
        params: {
          scope: 'project',
          projectName: p.name,
          pct: ratio,
          amount: money(spent),
          budget: money(budget),
        },
        projectId: p.id,
        url: this.projectUrl(p.id),
      });
      this.bump(counters, outcome);
    }

    // --- Enveloppe totale par tâche (attrape surtout le re-travail).
    const tasks = await this.prisma.task.findMany({
      where: {
        ...this.taskScope(orgId),
        status: { notIn: ['DONE'] },
        agentCostBudget: { not: null },
      },
      select: { id: true, title: true, agentCostBudget: true, project: { select: { id: true, name: true } } },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    for (const t of tasks) {
      const budget = Number(t.agentCostBudget);
      if (budget <= 0) continue;
      const spent = await this.agentRunCost({ organizationId: orgId, taskId: t.id });
      const ratio = pct(spent, budget);
      if (ratio < threshold) continue;
      const to = await this.recipients.financeRecipients(orgId, t.project.id);
      if (!to.length) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'agent_budget',
        entityId: t.id,
        qualifier: 'task',
        recipients: to,
        params: {
          scope: 'task',
          taskTitle: t.title,
          projectName: t.project.name,
          pct: ratio,
          amount: money(spent),
          budget: money(budget),
        },
        taskId: t.id,
        projectId: t.project.id,
        url: this.taskUrl(t.id),
      });
      this.bump(counters, outcome);
    }
  }

  /**
   * Règle 20 — livrable en attente de revue depuis trop longtemps. Backpressure :
   * tant que personne ne relit, la tâche est bloquée.
   *
   * `Deliverable` n'a pas de `submittedAt` → `createdAt` fait foi. On ne retient
   * que le **maillon final** d'une chaîne de versions : `supersedesId` pointe
   * vers le prédécesseur, donc un livrable remplacé est celui que quelqu'un
   * supersede. La relation inverse n'étant pas déclarée côté Prisma, on résout
   * en deux passes.
   */
  private async runDeliverableStale(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const threshold = new Date(now.getTime() - s.deliverableStale.hours * 3600_000);
    const pending = await this.prisma.deliverable.findMany({
      where: {
        organizationId: orgId,
        reviewStatus: 'PENDING',
        deletedAt: null,
        createdAt: { lt: threshold },
      },
      select: {
        id: true,
        createdAt: true,
        task: { select: { id: true, title: true, project: { select: { id: true, name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    if (!pending.length) return;

    const superseded = new Set(
      (
        await this.prisma.deliverable.findMany({
          where: { organizationId: orgId, supersedesId: { in: pending.map((d) => d.id) } },
          select: { supersedesId: true },
        })
      )
        .map((d) => d.supersedesId)
        .filter((v): v is string => !!v),
    );

    for (const d of pending) {
      if (superseded.has(d.id)) continue; // remplacé par une v+1 : plus à relire
      if (!d.task) continue;
      // Aucun reviewer n'est désigné à l'avance sur le livrable → les PM du
      // projet sont les relecteurs attendus (même résolution que submitForReview).
      const to = await this.recipients.projectPMs(d.task.project.id);
      if (!to.length) continue;
      const hours = Math.floor((now.getTime() - d.createdAt.getTime()) / 3600_000);
      const outcome = await this.actions.emit(orgId, {
        kind: 'deliverable_stale',
        entityId: d.id,
        recipients: to,
        params: { taskTitle: d.task.title, projectName: d.task.project.name, hours },
        taskId: d.task.id,
        projectId: d.task.project.id,
        url: this.taskUrl(d.task.id),
      });
      this.bump(counters, outcome);
    }
  }

  // ============================================================
  // Timesheet & occupation — règles hebdo 12, 13, 16
  // ============================================================

  /** Minutes loggées par user sur une fenêtre (une requête pour toute l'org). */
  private async loggedMinutesByUser(
    orgId: string,
    start: Date,
    end: Date,
    billableOnly = false,
  ): Promise<Map<string, number>> {
    const rows = await this.prisma.timeEntry.groupBy({
      by: ['userId'],
      where: {
        organizationId: orgId,
        date: { gte: start, lte: end },
        ...(billableOnly ? { task: { project: { billable: true, deletedAt: null } } } : {}),
      },
      _sum: { durationMinutes: true },
    });
    return new Map(rows.map((r) => [r.userId, r._sum.durationMinutes ?? 0]));
  }

  // Règle 12 — timesheet de la semaine échue sous X % de la capacité → le user.
  private async runTimesheetReminder(
    orgId: string,
    s: AutomationsSettings,
    start: Date,
    end: Date,
    weekKey: string,
    counters: RunCounters,
  ): Promise<void> {
    const users = await this.activeHumans(orgId);
    if (!users.length) return;
    // `TimesheetService.getTimesheet` est strictement personnelle (elle ignore
    // tout userId en query) → on recalcule capacité + réel, ce qui tient en 2
    // requêtes pour toute l'org au lieu de 6+ par personne.
    const { perUser } = await this.capacity.analyzeUsersCapacity(
      orgId,
      users.map((u) => u.id),
      start,
      end,
    );
    const logged = await this.loggedMinutesByUser(orgId, start, end);
    const byId = new Map(users.map((u) => [u.id, u]));

    for (const row of perUser) {
      if (row.availableHours <= 0) continue; // semaine entièrement en congé : rien à remplir
      const hours = (logged.get(row.userId) ?? 0) / 60;
      const fill = pct(hours, row.availableHours);
      if (fill >= s.timesheetReminder.thresholdPct) continue;
      const user = byId.get(row.userId);
      if (!user) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'timesheet_incomplete',
        entityId: row.userId,
        qualifier: weekKey,
        recipients: [user],
        params: { pct: fill, hours: Math.round(hours * 10) / 10 },
        url: this.viewUrl('timesheet'),
      });
      this.bump(counters, outcome);
    }
  }

  // Règle 13 — heures sup déclarées au-delà du seuil sur la semaine → lead.
  private async runOvertime(
    orgId: string,
    s: AutomationsSettings,
    start: Date,
    end: Date,
    weekKey: string,
    counters: RunCounters,
  ): Promise<void> {
    const rows = await this.prisma.timeEntry.groupBy({
      by: ['userId'],
      where: { organizationId: orgId, date: { gte: start, lte: end }, overtimeMinutes: { gt: 0 } },
      _sum: { overtimeMinutes: true },
    });
    const thresholdMinutes = s.overtime.hoursPerWeek * 60;
    for (const r of rows) {
      const minutes = r._sum.overtimeMinutes ?? 0;
      if (minutes <= thresholdMinutes) continue;
      const user = await this.prisma.user.findFirst({
        where: { id: r.userId, organizationId: orgId, kind: 'HUMAN', deletedAt: null },
        select: { id: true, name: true, email: true, preferredLanguage: true },
      });
      if (!user) continue;
      const leads = await this.recipients.teamLeadsOf(orgId, user.id);
      if (!leads.length) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'overtime_high',
        entityId: user.id,
        qualifier: weekKey,
        recipients: leads,
        params: {
          userName: user.name,
          hours: Math.round((minutes / 60) * 10) / 10,
          count: s.overtime.hoursPerWeek,
        },
        url: this.viewUrl('reports'),
      });
      this.bump(counters, outcome);
    }
  }

  // Règle 16 — taux d'occupation facturable par PERSONNE sous la cible → lead.
  // La facturabilité est un booléen de PROJET : un « ratio billable » par projet
  // vaudrait toujours 100 % ou 0 % — seule la maille user porte du sens.
  private async runUtilization(
    orgId: string,
    s: AutomationsSettings,
    start: Date,
    end: Date,
    weekKey: string,
    counters: RunCounters,
  ): Promise<void> {
    const [total, billable] = await Promise.all([
      this.loggedMinutesByUser(orgId, start, end),
      this.loggedMinutesByUser(orgId, start, end, true),
    ]);
    for (const [userId, totalMinutes] of total) {
      // Personne qui n'a rien logué : c'est le sujet de la règle 12, pas ici —
      // sinon un absent non déclaré remonterait comme « 0 % facturable ».
      if (totalMinutes <= 0) continue;
      const ratio = pct(billable.get(userId) ?? 0, totalMinutes);
      if (ratio >= s.utilization.thresholdPct) continue;
      const user = await this.prisma.user.findFirst({
        where: { id: userId, organizationId: orgId, kind: 'HUMAN', deletedAt: null },
        select: { id: true, name: true, email: true, preferredLanguage: true },
      });
      if (!user) continue;
      const leads = await this.recipients.teamLeadsOf(orgId, user.id);
      if (!leads.length) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'low_utilization',
        entityId: user.id,
        qualifier: weekKey,
        recipients: leads,
        params: {
          userName: user.name,
          pct: ratio,
          hours: Math.round((totalMinutes / 60) * 10) / 10,
          count: s.utilization.thresholdPct,
        },
        url: this.viewUrl('reports'),
      });
      this.bump(counters, outcome);
    }
  }

  // Règle 22 — fin de projet dans moins de N jours avec des tâches ouvertes → PM.
  private async runProjectEndSoon(
    orgId: string,
    s: AutomationsSettings,
    now: Date,
    counters: RunCounters,
  ): Promise<void> {
    const horizon = new Date(now.getTime() + s.projectEndSoon.days * DAY_MS);
    const projects = await this.prisma.project.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        status: 'ACTIVE',
        kind: 'STANDARD',
        dueDate: { gte: now, lte: horizon },
      },
      select: {
        id: true,
        name: true,
        dueDate: true,
        _count: { select: { tasks: { where: { status: { notIn: ['DONE'] }, deletedAt: null } } } },
      },
      orderBy: { dueDate: 'asc' },
      take: MAX_ALERTS_PER_RULE_PER_TICK,
    });
    for (const p of projects) {
      if (!p.dueDate || !isDueWithin(p.dueDate, now, s.projectEndSoon.days)) continue;
      const open = p._count.tasks;
      if (open === 0) continue; // projet qui atterrit proprement
      const pms = await this.recipients.projectPMs(p.id);
      if (!pms.length) continue;
      const outcome = await this.actions.emit(orgId, {
        kind: 'project_end_soon',
        entityId: p.id,
        recipients: pms,
        params: {
          projectName: p.name,
          days: daysUntil(p.dueDate, now),
          dueDate: p.dueDate.toISOString().slice(0, 10),
          count: open,
        },
        projectId: p.id,
        url: this.projectUrl(p.id),
      });
      this.bump(counters, outcome);
    }
  }
}
