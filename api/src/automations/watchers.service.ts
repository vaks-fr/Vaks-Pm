import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface WatcherDto {
  id: string;
  userId: string;
  name: string;
  email: string;
}

export interface WatchingEntryDto {
  id: string;
  kind: 'task' | 'project';
  taskId: string | null;
  projectId: string;
  title: string;
  projectName: string;
  createdAt: string;
}

/**
 * Watchers : abonnement passif à une tâche ou un projet. Complète les
 * @mentions (ponctuelles) par un suivi durable — un sponsor suit une tâche
 * clé sans en être assigné.
 *
 * Deux usages : (a) destinataires additionnels des alertes d'automatisation
 * (`AutomationRecipientsService`), (b) notification directe sur changement de
 * statut / nouveau commentaire.
 *
 * `Watcher` porte des références **scalaires** (pas de relation Prisma) — les
 * libellés sont résolus ici, comme pour `SkillRequest`.
 */
@Injectable()
export class WatchersService {
  constructor(private readonly prisma: PrismaService) {}

  /** S'abonner à une tâche. Idempotent (re-cliquer ne duplique pas). */
  async watchTask(orgId: string, userId: string, taskId: string): Promise<{ watching: true }> {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    await this.prisma.watcher.upsert({
      where: { organizationId_userId_taskId: { organizationId: orgId, userId, taskId } },
      create: { organizationId: orgId, userId, taskId },
      update: {},
    });
    return { watching: true };
  }

  async unwatchTask(orgId: string, userId: string, taskId: string): Promise<{ watching: false }> {
    await this.prisma.watcher.deleteMany({ where: { organizationId: orgId, userId, taskId } });
    return { watching: false };
  }

  /** S'abonner à un projet : couvre le projet ET toutes ses tâches. */
  async watchProject(orgId: string, userId: string, projectId: string): Promise<{ watching: true }> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    await this.prisma.watcher.upsert({
      where: { organizationId_userId_projectId: { organizationId: orgId, userId, projectId } },
      create: { organizationId: orgId, userId, projectId },
      update: {},
    });
    return { watching: true };
  }

  async unwatchProject(orgId: string, userId: string, projectId: string): Promise<{ watching: false }> {
    await this.prisma.watcher.deleteMany({ where: { organizationId: orgId, userId, projectId } });
    return { watching: false };
  }

  /** Watchers d'une tâche (abonnés directs uniquement — pas ceux du projet). */
  async listTaskWatchers(orgId: string, taskId: string): Promise<WatcherDto[]> {
    const rows = await this.prisma.watcher.findMany({
      where: { organizationId: orgId, taskId },
      select: { id: true, userId: true },
    });
    return this.resolveNames(orgId, rows);
  }

  async listProjectWatchers(orgId: string, projectId: string): Promise<WatcherDto[]> {
    const rows = await this.prisma.watcher.findMany({
      where: { organizationId: orgId, projectId },
      select: { id: true, userId: true },
    });
    return this.resolveNames(orgId, rows);
  }

  /** L'appelant suit-il cette tâche ? (état du bouton « Suivre »). */
  async isWatchingTask(orgId: string, userId: string, taskId: string): Promise<boolean> {
    const row = await this.prisma.watcher.findFirst({
      where: { organizationId: orgId, userId, taskId },
      select: { id: true },
    });
    return !!row;
  }

  /**
   * **Le cœur** : userIds à notifier pour un événement donné, union des
   * watchers de la tâche et de ceux de son projet. Un abonné projet est
   * intéressé par tout ce qui s'y passe.
   */
  async watchersOf(
    orgId: string,
    ref: { taskId?: string | null; projectId?: string | null },
  ): Promise<string[]> {
    const or: Array<Record<string, string>> = [];
    if (ref.taskId) or.push({ taskId: ref.taskId });
    if (ref.projectId) or.push({ projectId: ref.projectId });
    if (!or.length) return [];
    const rows = await this.prisma.watcher.findMany({
      where: { organizationId: orgId, OR: or },
      select: { userId: true },
    });
    return [...new Set(rows.map((r) => r.userId))];
  }

  /** Ce que l'appelant suit (page « Mes suivis »). */
  async listMine(orgId: string, userId: string): Promise<WatchingEntryDto[]> {
    const rows = await this.prisma.watcher.findMany({
      where: { organizationId: orgId, userId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    if (!rows.length) return [];

    const taskIds = rows.map((r) => r.taskId).filter((v): v is string => !!v);
    const projectIds = rows.map((r) => r.projectId).filter((v): v is string => !!v);
    const [tasks, projects] = await Promise.all([
      taskIds.length
        ? this.prisma.task.findMany({
            where: { id: { in: taskIds }, deletedAt: null },
            select: { id: true, title: true, project: { select: { id: true, name: true } } },
          })
        : Promise.resolve([]),
      projectIds.length
        ? this.prisma.project.findMany({
            where: { id: { in: projectIds }, deletedAt: null },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const taskById = new Map(tasks.map((t) => [t.id, t]));
    const projectById = new Map(projects.map((p) => [p.id, p]));

    const out: WatchingEntryDto[] = [];
    for (const r of rows) {
      if (r.taskId) {
        const t = taskById.get(r.taskId);
        if (!t) continue; // tâche supprimée depuis : on n'expose pas un lien mort
        out.push({
          id: r.id,
          kind: 'task',
          taskId: t.id,
          projectId: t.project.id,
          title: t.title,
          projectName: t.project.name,
          createdAt: r.createdAt.toISOString(),
        });
      } else if (r.projectId) {
        const p = projectById.get(r.projectId);
        if (!p) continue;
        out.push({
          id: r.id,
          kind: 'project',
          taskId: null,
          projectId: p.id,
          title: p.name,
          projectName: p.name,
          createdAt: r.createdAt.toISOString(),
        });
      }
    }
    return out;
  }

  private async resolveNames(
    orgId: string,
    rows: Array<{ id: string; userId: string }>,
  ): Promise<WatcherDto[]> {
    if (!rows.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) }, organizationId: orgId, deletedAt: null },
      select: { id: true, name: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return rows
      .map((r) => {
        const u = byId.get(r.userId);
        return u ? { id: r.id, userId: u.id, name: u.name, email: u.email } : null;
      })
      .filter((v): v is WatcherDto => !!v);
  }
}
