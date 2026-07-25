import { Injectable } from '@nestjs/common';
import { TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../rbac/project-access.service';

/** Nb max de tâches renvoyées dans la liste « Mes tâches ». */
const TASK_LIST_LIMIT = 8;
/** Nb max d'entrées dans le feed d'activité. */
const ACTIVITY_LIMIT = 8;
/** Fenêtre de lookback pour le feed d'activité (jours). */
const ACTIVITY_LOOKBACK_DAYS = 21;

const MS_PER_DAY = 86_400_000;

/**
 * Agrège la vue d'accueil personnelle (`GET /me/dashboard`). Strictement
 * self-only : le sujet est toujours l'utilisateur courant. Le feed d'activité
 * couvre **l'équipe** de l'utilisateur (membres partageant une équipe, lui
 * inclus) et reste borné aux projets qu'il peut voir (anti-fuite cross-projet).
 */
@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async getDashboard(orgId: string, userId: string, isAdmin: boolean) {
    // Bornes temporelles (UTC, cohérent avec le stockage).
    const now = new Date();
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // Lundi de la semaine courante (getUTCDay: 0=dim … 1=lun).
    const dow = todayStart.getUTCDay();
    const daysSinceMonday = (dow + 6) % 7;
    const weekStart = new Date(todayStart.getTime() - daysSinceMonday * MS_PER_DAY);
    const activitySince = new Date(now.getTime() - ACTIVITY_LOOKBACK_DAYS * MS_PER_DAY);

    // Périmètre de projets visibles (null = tous, pour admin / view_all).
    const scope = await this.access.accessibleProjectScope(orgId, userId, isAdmin);
    // Coéquipiers = membres de toute équipe dont je fais partie (moi inclus).
    const teamMemberRows = await this.prisma.teamMember.findMany({
      where: { team: { organizationId: orgId, deletedAt: null, members: { some: { userId } } } },
      select: { userId: true },
    });
    const teammateIds = new Set<string>([userId, ...teamMemberRows.map((m) => m.userId)]);
    const teammateList = [...teammateIds];

    // Filtre projet réutilisable (undefined si aucun scope → tous les projets).
    const projectScopeFilter = scope ? { id: { in: scope } } : undefined;

    const [myTasks, completedThisWeek, overdueTeam, milestone, statusHistory, comments] =
      await Promise.all([
        // Mes tâches actives (hors DONE), projets STANDARD/ACTIVE.
        this.prisma.task.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            status: { not: TaskStatus.DONE },
            assignees: { some: { userId } },
            project: { status: 'ACTIVE', kind: 'STANDARD', deletedAt: null },
          },
          orderBy: [{ priority: 'desc' }, { dueDate: 'asc' }, { position: 'asc' }],
          select: {
            id: true,
            number: true,
            title: true,
            status: true,
            priority: true,
            dueDate: true,
            projectId: true,
            project: { select: { key: true, name: true } },
            assignees: { select: { userId: true } },
          },
        }),
        // Tâches que j'ai fait passer à DONE cette semaine (tâches distinctes).
        this.prisma.taskStatusHistory
          .findMany({
            where: {
              organizationId: orgId,
              changedById: userId,
              toStatus: TaskStatus.DONE,
              changedAt: { gte: weekStart },
            },
            select: { taskId: true },
            distinct: ['taskId'],
          })
          .then((rows) => rows.length),
        // Tâches en retard assignées à un coéquipier (moi inclus), projets visibles.
        this.prisma.task.count({
          where: {
            organizationId: orgId,
            deletedAt: null,
            status: { not: TaskStatus.DONE },
            dueDate: { lt: todayStart },
            assignees: { some: { userId: { in: teammateList } } },
            project: {
              status: 'ACTIVE',
              kind: 'STANDARD',
              deletedAt: null,
              ...(projectScopeFilter ?? {}),
            },
          },
        }),
        // Prochain jalon à venir sur un projet visible.
        this.prisma.task.findFirst({
          where: {
            organizationId: orgId,
            deletedAt: null,
            isMilestone: true,
            status: { not: TaskStatus.DONE },
            dueDate: { gte: todayStart },
            project: {
              status: 'ACTIVE',
              kind: 'STANDARD',
              deletedAt: null,
              ...(projectScopeFilter ?? {}),
            },
          },
          orderBy: { dueDate: 'asc' },
          select: {
            id: true,
            number: true,
            title: true,
            dueDate: true,
            project: { select: { key: true, name: true } },
          },
        }),
        // Activité équipe — changements de statut récents.
        this.prisma.taskStatusHistory.findMany({
          where: {
            organizationId: orgId,
            changedById: { in: teammateList },
            changedAt: { gte: activitySince },
            task: {
              deletedAt: null,
              project: {
                kind: 'STANDARD',
                deletedAt: null,
                ...(projectScopeFilter ?? {}),
              },
            },
          },
          orderBy: { changedAt: 'desc' },
          take: ACTIVITY_LIMIT * 3,
          select: {
            id: true,
            fromStatus: true,
            toStatus: true,
            changedAt: true,
            changedById: true,
            taskId: true,
            task: {
              select: { number: true, title: true, project: { select: { key: true } } },
            },
          },
        }),
        // Activité équipe — commentaires récents.
        this.prisma.comment.findMany({
          where: {
            organizationId: orgId,
            deletedAt: null,
            authorId: { in: teammateList },
            createdAt: { gte: activitySince },
            task: {
              deletedAt: null,
              project: {
                kind: 'STANDARD',
                deletedAt: null,
                ...(projectScopeFilter ?? {}),
              },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: ACTIVITY_LIMIT * 3,
          select: {
            id: true,
            createdAt: true,
            authorId: true,
            taskId: true,
            task: {
              select: { number: true, title: true, project: { select: { key: true } } },
            },
          },
        }),
      ]);

    // Répartition par statut de mes tâches actives.
    const statusCounts: Record<string, number> = {};
    for (const t of myTasks) {
      statusCounts[t.status] = (statusCounts[t.status] ?? 0) + 1;
    }

    // Résolution des noms d'acteurs (une seule requête).
    const actorIds = new Set<string>();
    for (const h of statusHistory) if (h.changedById) actorIds.add(h.changedById);
    for (const c of comments) actorIds.add(c.authorId);
    const actors = actorIds.size
      ? await this.prisma.user.findMany({
          where: { id: { in: [...actorIds] } },
          select: { id: true, name: true },
        })
      : [];
    const actorName = new Map(actors.map((a) => [a.id, a.name]));

    // Fusion du feed (statut + commentaires), tri desc, plafonné.
    const activity = [
      ...statusHistory.map((h) => ({
        id: `move:${h.id}`,
        kind: 'move' as const,
        at: h.changedAt.toISOString(),
        actor: { id: h.changedById ?? '', name: actorName.get(h.changedById ?? '') ?? '—' },
        taskId: h.taskId,
        taskKey: `${h.task.project.key}-${h.task.number}`,
        taskTitle: h.task.title,
        toStatus: h.fromStatus === null ? null : h.toStatus,
      })),
      // fromStatus null = création de la tâche → kind `created`.
      ...statusHistory
        .filter((h) => h.fromStatus === null)
        .map((h) => ({
          id: `created:${h.id}`,
          kind: 'created' as const,
          at: h.changedAt.toISOString(),
          actor: { id: h.changedById ?? '', name: actorName.get(h.changedById ?? '') ?? '—' },
          taskId: h.taskId,
          taskKey: `${h.task.project.key}-${h.task.number}`,
          taskTitle: h.task.title,
          toStatus: null,
        })),
      ...comments.map((c) => ({
        id: `comment:${c.id}`,
        kind: 'comment' as const,
        at: c.createdAt.toISOString(),
        actor: { id: c.authorId, name: actorName.get(c.authorId) ?? '—' },
        taskId: c.taskId,
        taskKey: `${c.task.project.key}-${c.task.number}`,
        taskTitle: c.task.title,
        toStatus: null,
      })),
    ]
      // Une entrée `move` avec fromStatus null a été dupliquée en `created` :
      // on retire alors le doublon `move` (garder seulement `created`).
      .filter((e) => !(e.kind === 'move' && e.toStatus === null))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, ACTIVITY_LIMIT);

    return {
      tasks: myTasks.slice(0, TASK_LIST_LIMIT).map((t) => ({
        id: t.id,
        key: `${t.project.key}-${t.number}`,
        title: t.title,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null,
        projectId: t.projectId,
        projectName: t.project.name,
        projectKey: t.project.key,
        assigneeIds: t.assignees.map((a) => a.userId),
      })),
      statusCounts,
      inProgress: statusCounts[TaskStatus.IN_PROGRESS] ?? 0,
      completedThisWeek,
      overdueTeam,
      nextMilestone: milestone
        ? {
            taskId: milestone.id,
            key: `${milestone.project.key}-${milestone.number}`,
            title: milestone.title,
            dueDate: milestone.dueDate!.toISOString().slice(0, 10),
            projectName: milestone.project.name,
          }
        : null,
      activity,
    };
  }
}
