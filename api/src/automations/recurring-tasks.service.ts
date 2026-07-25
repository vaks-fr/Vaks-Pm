import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { TasksService } from '../tasks/tasks.service';
import { Frequency, nextOccurrence } from './automation-rules';
import { AutomationActionsService } from './automation-actions.service';
import { AutomationRecipientsService } from './automation-recipients.service';

const FREQUENCIES: Frequency[] = ['daily', 'weekly', 'monthly'];

export interface UpsertRecurrenceDto {
  frequency: Frequency;
  weekday?: number | null;
  monthDay?: number | null;
  active?: boolean;
}

/**
 * Tâches récurrentes : re-crée une copie d'une tâche **modèle** à un rythme
 * donné. Le modèle reste une vraie tâche du projet (on ne duplique pas sa
 * définition) — l'éditer change les occurrences futures.
 *
 * Matérialisation dans le tick horaire du moteur. La discipline d'idempotence
 * est décrite sur `materialize` : elle est le cœur de ce service.
 */
@Injectable()
export class RecurringTasksService {
  private readonly log = new Logger(RecurringTasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly actions: AutomationActionsService,
    private readonly recipients: AutomationRecipientsService,
    private readonly moduleRef: ModuleRef,
  ) {}

  private tasksService(): TasksService | null {
    try {
      return this.moduleRef.get(TasksService, { strict: false });
    } catch {
      return null;
    }
  }

  private validate(dto: UpsertRecurrenceDto): void {
    if (!FREQUENCIES.includes(dto.frequency)) {
      throw new BadRequestException(`frequency invalide : ${dto.frequency} (daily|weekly|monthly)`);
    }
    if (dto.frequency === 'weekly') {
      const d = dto.weekday ?? 1;
      if (!Number.isInteger(d) || d < 1 || d > 7) {
        throw new BadRequestException('weekday doit être un entier 1-7 (1 = lundi)');
      }
    }
    if (dto.frequency === 'monthly') {
      const d = dto.monthDay ?? 1;
      // Borné à 28 : au-delà, l'occurrence sauterait certains mois (février).
      if (!Number.isInteger(d) || d < 1 || d > 28) {
        throw new BadRequestException('monthDay doit être un entier 1-28');
      }
    }
  }

  /** Crée ou met à jour la récurrence d'une tâche (une par tâche modèle). */
  async upsert(orgId: string, taskId: string, userId: string, dto: UpsertRecurrenceDto) {
    this.validate(dto);
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, projectId: true, project: { select: { kind: true } } },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    if (task.project.kind !== 'STANDARD') {
      throw new BadRequestException(
        'Récurrence indisponible sur un conteneur de tickets externes.',
      );
    }

    const next = nextOccurrence(dto.frequency, new Date(), {
      weekday: dto.weekday,
      monthDay: dto.monthDay,
    });
    const existing = await this.prisma.recurringTask.findFirst({
      where: { organizationId: orgId, templateTaskId: taskId },
      select: { id: true },
    });
    if (existing) {
      return this.prisma.recurringTask.update({
        where: { id: existing.id },
        data: {
          frequency: dto.frequency,
          weekday: dto.weekday ?? null,
          monthDay: dto.monthDay ?? null,
          active: dto.active ?? true,
          nextRunAt: next,
        },
      });
    }
    return this.prisma.recurringTask.create({
      data: {
        organizationId: orgId,
        projectId: task.projectId,
        templateTaskId: taskId,
        frequency: dto.frequency,
        weekday: dto.weekday ?? null,
        monthDay: dto.monthDay ?? null,
        active: dto.active ?? true,
        nextRunAt: next,
        createdById: userId,
      },
    });
  }

  async getForTask(orgId: string, taskId: string) {
    return this.prisma.recurringTask.findFirst({
      where: { organizationId: orgId, templateTaskId: taskId },
    });
  }

  async listForProject(orgId: string, projectId: string) {
    return this.prisma.recurringTask.findMany({
      where: { organizationId: orgId, projectId },
      orderBy: { nextRunAt: 'asc' },
    });
  }

  async remove(orgId: string, taskId: string): Promise<{ removed: boolean }> {
    const r = await this.prisma.recurringTask.deleteMany({
      where: { organizationId: orgId, templateTaskId: taskId },
    });
    return { removed: r.count > 0 };
  }

  /**
   * Matérialise les occurrences dues (appelé au tick horaire).
   *
   * **Ordre non négociable** : on avance `nextRunAt` par un `updateMany`
   * conditionné sur sa valeur lue, PUIS on crée la tâche.
   *  - Deux réplicas en concurrence : un seul voit `count === 1`, l'autre
   *    s'arrête → jamais de doublon.
   *  - Crash entre les deux : l'occurrence est perdue (loggée), jamais
   *    dupliquée. On préfère une occurrence manquante à une tâche fantôme
   *    créée deux fois.
   */
  async materialize(orgId: string, now: Date): Promise<number> {
    const due = await this.prisma.recurringTask.findMany({
      where: { organizationId: orgId, active: true, nextRunAt: { lte: now } },
      take: 50,
    });
    let created = 0;

    for (const r of due) {
      try {
        const next = nextOccurrence(r.frequency as Frequency, now, {
          weekday: r.weekday,
          monthDay: r.monthDay,
        });
        // Verrou optimiste : la clause `nextRunAt` est la valeur qu'on vient de
        // lire — si un autre réplica est passé avant, count = 0.
        const claim = await this.prisma.recurringTask.updateMany({
          where: { id: r.id, nextRunAt: r.nextRunAt },
          data: { nextRunAt: next, lastRunAt: now },
        });
        if (claim.count === 0) continue;

        const template = await this.prisma.task.findFirst({
          where: { id: r.templateTaskId, organizationId: orgId, deletedAt: null },
          select: {
            title: true,
            description: true,
            priority: true,
            estimateHours: true,
            requiredSkillId: true,
            requiredSkillLevel: true,
            projectId: true,
          },
        });
        if (!template) {
          // Modèle supprimé : on désactive plutôt que de re-tenter chaque heure.
          await this.prisma.recurringTask.update({
            where: { id: r.id },
            data: { active: false },
          });
          await this.notifyOrphaned(orgId, r.projectId, r.id);
          continue;
        }

        const tasks = this.tasksService();
        if (!tasks) continue;
        // Via TasksService : numérotation, board, webhook `task.created` et
        // hooks (dont le skill gap) hérités sans les ré-implémenter.
        // `system: true` → les hooks d'automatisation s'abstiennent (anti-boucle).
        await tasks.create(orgId, template.projectId, r.createdById, {
          title: template.title,
          description: template.description ?? undefined,
          priority: template.priority,
          estimateHours: template.estimateHours ?? undefined,
          requiredSkillId: template.requiredSkillId ?? undefined,
          requiredSkillLevel: template.requiredSkillLevel ?? undefined,
        } as Parameters<TasksService['create']>[3], { isAdmin: true, system: true });
        created += 1;

        this.actions.logMutation(orgId, {
          kind: 'recurrence',
          resourceType: 'task',
          resourceId: r.templateTaskId,
          resourceLabel: template.title,
          field: 'occurrence',
          before: r.nextRunAt.toISOString(),
          after: next.toISOString(),
        });
      } catch (err) {
        this.log.warn(`materialize recurrence=${r.id} failed: ${(err as Error).message}`);
      }
    }
    return created;
  }

  /** Prévient les PM qu'une récurrence a été désactivée faute de modèle. */
  private async notifyOrphaned(orgId: string, projectId: string, recurrenceId: string): Promise<void> {
    try {
      const [project, pms] = await Promise.all([
        this.prisma.project.findFirst({ where: { id: projectId }, select: { name: true } }),
        this.recipients.projectPMs(projectId),
      ]);
      if (!pms.length) return;
      await this.actions.emit(orgId, {
        kind: 'recurrence_orphaned',
        entityId: recurrenceId,
        recipients: pms,
        params: { projectName: project?.name ?? '' },
        projectId,
      });
    } catch {
      /* best-effort */
    }
  }
}
