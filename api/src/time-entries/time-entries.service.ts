import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { FinanceService } from '../finance/finance.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import {
  CreateTimeEntryDto,
  ListTimeEntriesDto,
  TimesheetQueryDto,
  UpdateTimeEntryDto,
} from './dto/time-entry.dto';

const INCLUDE = {
  task: {
    select: {
      id: true,
      title: true,
      projectId: true,
      project: { select: { billable: true } },
    },
  },
  user: { select: { id: true, name: true, email: true } },
} satisfies Prisma.TimeEntryInclude;

type Entry = Prisma.TimeEntryGetPayload<{ include: typeof INCLUDE }>;

@Injectable()
export class TimeEntriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
    private readonly finance: FinanceService,
    private readonly access: ProjectAccessService,
  ) {}

  /**
   * Calcule la somme des heures loggées sur une tâche (toutes entries).
   * Sert à détecter le franchissement de l'estimate pour la notification
   * "over_estimate" aux PROJECT_MANAGER.
   */
  private async loggedHoursForTask(taskId: string): Promise<number> {
    const agg = await this.prisma.timeEntry.aggregate({
      where: { taskId },
      _sum: { durationMinutes: true },
    });
    return (agg._sum.durationMinutes ?? 0) / 60;
  }

  /**
   * Si l'estimate vient d'être franchie (loggedBefore ≤ estimate < loggedAfter),
   * déclenche la notification. Aucune action si la tâche n'a pas d'estimate
   * ou si on est déjà au-dessus depuis avant. Best-effort, n'échoue jamais.
   */
  private async maybeNotifyOverEstimate(
    orgId: string,
    actorUserId: string,
    taskId: string,
    loggedBefore: number,
    loggedAfter: number,
  ): Promise<void> {
    if (loggedAfter <= loggedBefore) return;
    const t = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { estimateHours: true },
    });
    if (!t || t.estimateHours == null || t.estimateHours <= 0) return;
    // Franchissement strict : "avant" était ≤ estimate, "après" est > estimate.
    if (loggedBefore > t.estimateHours) return;
    if (loggedAfter <= t.estimateHours) return;
    void this.notifications
      .notifyOverEstimate(orgId, actorUserId, taskId, loggedAfter)
      .catch(() => { /* déjà loggé */ });
  }

  // ---- Création ----
  async create(orgId: string, userId: string, dto: CreateTimeEntryDto) {
    const task = await this.assertTask(orgId, dto.taskId);
    const loggedBefore = await this.loggedHoursForTask(dto.taskId);
    const ot = Math.min(dto.overtimeMinutes ?? 0, dto.durationMinutes);
    // Snapshot des taux : on fige le taux résolu (coût + facturation) au moment
    // où l'heure est loggée → coût historique immuable même si le taux change
    // plus tard. Best-effort : si la résolution échoue, on laisse null (le
    // reporting retombera sur le taux live pour cette ligne).
    const snap = await this.finance
      .resolveRate(orgId, task.projectId, userId)
      .catch(() => ({ costRate: null, billRate: null }));
    const entry = await this.prisma.timeEntry.create({
      data: {
        organizationId: orgId,
        taskId: dto.taskId,
        userId,
        date: this.toDateOnly(dto.date),
        durationMinutes: dto.durationMinutes,
        overtimeMinutes: Math.max(0, ot),
        description: dto.description ?? null,
        costRateSnapshot: snap.costRate,
        billRateSnapshot: snap.billRate,
      },
      include: INCLUDE,
    });
    this.events.emitToProject(task.projectId, 'time_entry.created', this.toDto(entry));
    const loggedAfter = loggedBefore + dto.durationMinutes / 60;
    void this.maybeNotifyOverEstimate(orgId, userId, dto.taskId, loggedBefore, loggedAfter);
    return this.toDto(entry);
  }

  // ---- Mise à jour (auteur seulement, sauf admin) ----
  async update(orgId: string, userId: string, isAdmin: boolean, entryId: string, dto: UpdateTimeEntryDto) {
    const existing = await this.assertOwned(orgId, userId, isAdmin, entryId);
    const data: Prisma.TimeEntryUpdateInput = {};
    if (dto.date !== undefined) data.date = this.toDateOnly(dto.date);
    if (dto.durationMinutes !== undefined) data.durationMinutes = dto.durationMinutes;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.overtimeMinutes !== undefined) {
      // Borne par la nouvelle durée si fournie, sinon par l'existante.
      const maxDur = dto.durationMinutes ?? existing.durationMinutes;
      data.overtimeMinutes = Math.max(0, Math.min(dto.overtimeMinutes, maxDur));
    } else if (dto.durationMinutes !== undefined) {
      // Si la durée diminue sous l'overtime existant, on tronque l'overtime.
      if (existing.overtimeMinutes > dto.durationMinutes) {
        data.overtimeMinutes = dto.durationMinutes;
      }
    }
    const loggedBefore = await this.loggedHoursForTask(existing.taskId);
    const entry = await this.prisma.timeEntry.update({
      where: { id: entryId },
      data,
      include: INCLUDE,
    });
    this.events.emitToProject(existing.task.projectId, 'time_entry.updated', this.toDto(entry));
    if (dto.durationMinutes !== undefined && dto.durationMinutes !== existing.durationMinutes) {
      const delta = (dto.durationMinutes - existing.durationMinutes) / 60;
      const loggedAfter = loggedBefore + delta;
      void this.maybeNotifyOverEstimate(orgId, userId, existing.taskId, loggedBefore, loggedAfter);
    }
    return this.toDto(entry);
  }

  // ---- Suppression ----
  async remove(orgId: string, userId: string, isAdmin: boolean, entryId: string) {
    const existing = await this.assertOwned(orgId, userId, isAdmin, entryId);
    await this.prisma.timeEntry.delete({ where: { id: entryId } });
    this.events.emitToProject(existing.task.projectId, 'time_entry.deleted', { id: entryId });
    return { id: entryId, deleted: true };
  }

  // ---- Listing ----
  async list(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    query: ListTimeEntriesDto,
  ) {
    const where: Prisma.TimeEntryWhereInput = { organizationId: orgId };
    if (query.taskId) where.taskId = query.taskId;
    if (query.projectId) where.task = { projectId: query.projectId };
    if (query.userId) {
      where.userId = query.userId === 'me' ? requester.userId : query.userId;
    }
    if (query.from || query.to) {
      where.date = {};
      if (query.from) (where.date as Prisma.DateTimeFilter).gte = this.toDateOnly(query.from);
      if (query.to) (where.date as Prisma.DateTimeFilter).lte = this.toDateOnly(query.to);
    }

    // Scoping transverse : sans droit de lecture élevé, l'appelant ne voit que
    // ses propres entrées + celles des projets auxquels il a accès. Ferme la
    // fuite org-globale du listing non filtré (la ProjectAccessGuard ne couvre
    // que le cas ?projectId/?taskId=foreign).
    const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);
    if (scope !== null) {
      (where.AND ??= [] as Prisma.TimeEntryWhereInput[]);
      (where.AND as Prisma.TimeEntryWhereInput[]).push({
        OR: [{ userId: requester.userId }, { task: { projectId: { in: scope } } }],
      });
    }

    const entries = await this.prisma.timeEntry.findMany({
      where,
      include: INCLUDE,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: query.limit ?? 200,
    });
    return entries.map((e) => this.toDto(e));
  }

  // ---- Timesheet hebdo (par utilisateur, jour × tâche) ----
  async timesheet(orgId: string, currentUserId: string, q: TimesheetQueryDto) {
    const userId = !q.userId || q.userId === 'me' ? currentUserId : q.userId;
    const start = this.toDateOnly(q.weekStart);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 6);

    const entries = await this.prisma.timeEntry.findMany({
      where: { organizationId: orgId, userId, date: { gte: start, lte: end } },
      include: INCLUDE,
      orderBy: [{ date: 'asc' }],
    });

    // Regroupement task × date → totalMinutes
    const byTask = new Map<
      string,
      { task: Entry['task']; days: Record<string, number>; total: number }
    >();
    let weekTotal = 0;
    for (const e of entries) {
      const dayKey = e.date.toISOString().slice(0, 10);
      const slot =
        byTask.get(e.taskId) ?? { task: e.task, days: {}, total: 0 };
      slot.days[dayKey] = (slot.days[dayKey] ?? 0) + e.durationMinutes;
      slot.total += e.durationMinutes;
      weekTotal += e.durationMinutes;
      byTask.set(e.taskId, slot);
    }

    // Totaux par jour pour la rangée d'en-tête
    const dailyTotals: Record<string, number> = {};
    for (let i = 0; i < 7; i++) {
      const d = new Date(start);
      d.setUTCDate(d.getUTCDate() + i);
      dailyTotals[d.toISOString().slice(0, 10)] = 0;
    }
    for (const slot of byTask.values()) {
      for (const [k, v] of Object.entries(slot.days)) {
        dailyTotals[k] = (dailyTotals[k] ?? 0) + v;
      }
    }

    return {
      userId,
      weekStart: start.toISOString().slice(0, 10),
      weekEnd: end.toISOString().slice(0, 10),
      totalMinutes: weekTotal,
      dailyTotals,
      rows: [...byTask.values()].map((s) => ({
        taskId: s.task.id,
        taskTitle: s.task.title,
        projectId: s.task.projectId,
        days: s.days,
        totalMinutes: s.total,
      })),
    };
  }

  // ---- Estimé vs réel par tâche ----
  async taskSummary(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, title: true, estimateHours: true, projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    const agg = await this.prisma.timeEntry.aggregate({
      where: { taskId },
      _sum: { durationMinutes: true },
    });
    const spentMinutes = agg._sum.durationMinutes ?? 0;
    const estimatedMinutes = task.estimateHours !== null ? Math.round(task.estimateHours * 60) : null;
    return {
      taskId: task.id,
      title: task.title,
      projectId: task.projectId,
      estimatedMinutes,
      spentMinutes,
      remainingMinutes:
        estimatedMinutes !== null ? Math.max(0, estimatedMinutes - spentMinutes) : null,
      overrunMinutes:
        estimatedMinutes !== null && spentMinutes > estimatedMinutes
          ? spentMinutes - estimatedMinutes
          : 0,
    };
  }

  // ---- Helpers ----

  private async assertTask(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!task) throw new BadRequestException('Tâche inconnue');
    return task;
  }

  private async assertOwned(orgId: string, userId: string, isAdmin: boolean, id: string) {
    const e = await this.prisma.timeEntry.findFirst({
      where: { id, organizationId: orgId },
      include: { task: { select: { projectId: true } } },
    });
    if (!e) throw new NotFoundException('Entrée introuvable');
    if (!isAdmin && e.userId !== userId) {
      throw new ForbiddenException("Tu ne peux modifier que tes propres entrées");
    }
    return e;
  }

  /** YYYY-MM-DD ou ISO → Date UTC à 00:00 (champ DATE en Postgres). */
  private toDateOnly(iso: string): Date {
    const s = iso.length === 10 ? `${iso}T00:00:00.000Z` : iso;
    const d = new Date(s);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }

  private toDto(e: Entry) {
    return {
      id: e.id,
      taskId: e.taskId,
      task: {
        id: e.task.id,
        title: e.task.title,
        projectId: e.task.projectId,
        projectBillable: e.task.project.billable,
      },
      userId: e.userId,
      user: { id: e.user.id, name: e.user.name, email: e.user.email },
      date: e.date.toISOString().slice(0, 10),
      durationMinutes: e.durationMinutes,
      overtimeMinutes: e.overtimeMinutes,
      description: e.description,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    };
  }
}
