import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma } from '@db';
import { WatchersService } from '../automations/watchers.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventsGateway } from '../realtime/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { CreateCommentDto, UpdateCommentDto } from './dto/comment.dto';

const INCLUDE = {
  author: { select: { id: true, name: true, email: true } },
} satisfies Prisma.CommentInclude;
type CommentRow = Prisma.CommentGetPayload<{ include: typeof INCLUDE }>;

@Injectable()
export class CommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async list(orgId: string, taskId: string) {
    const task = await this.assertTask(orgId, taskId);
    const rows = await this.prisma.comment.findMany({
      where: { taskId: task.id, deletedAt: null },
      orderBy: { createdAt: 'asc' },
      include: INCLUDE,
    });
    return rows.map((c) => this.toDto(c));
  }

  async create(orgId: string, userId: string, taskId: string, dto: CreateCommentDto) {
    const task = await this.assertTask(orgId, taskId);
    const c = await this.prisma.comment.create({
      data: {
        organizationId: orgId,
        taskId: task.id,
        authorId: userId,
        body: dto.body,
      },
      include: INCLUDE,
    });
    const out = this.toDto(c);
    this.events.emitToProject(task.projectId, 'comment.created', out);
    void this.webhooks.dispatch(orgId, 'comment.created', out, { projectId: task.projectId });
    // Notifs @mentions (fire-and-forget). Format reconnu : `@email@domain.tld`
    // ou `@username` matchant la partie locale d'un email org. On extrait, on
    // résout, on déclenche un mail par user mentionné.
    void this.dispatchMentions(orgId, userId, task.id, dto.body);
    // Watchers : le suivi passif vaut aussi pour les commentaires. Les
    // mentionnés sont exclus (ils viennent d'être notifiés juste au-dessus).
    void this.notifyWatchers(orgId, userId, task.id, task.projectId, dto.body);
    return out;
  }

  /**
   * Prévient les abonnés (tâche ou projet parent) d'un nouveau commentaire, en
   * réutilisant le template `mention` — le contenu est le même (« untel a
   * écrit ceci »), seul le motif d'envoi diffère.
   *
   * Best-effort et non bloquant. Exclut l'auteur et les personnes déjà
   * mentionnées dans le corps, pour ne pas doubler l'envoi.
   */
  private async notifyWatchers(
    orgId: string,
    actorUserId: string,
    taskId: string,
    projectId: string,
    body: string,
  ): Promise<void> {
    try {
      const watchers = this.watchersService();
      if (!watchers) return;
      const ids = await watchers.watchersOf(orgId, { taskId, projectId });
      if (!ids.length) return;
      const mentioned = new Set(await this.resolveMentionedIds(orgId, body));
      for (const uid of ids) {
        if (uid === actorUserId || mentioned.has(uid)) continue;
        void this.notifications.notifyMention(orgId, actorUserId, uid, taskId, body);
      }
    } catch {
      /* fail-open : un souci de suivi ne casse pas la création du commentaire */
    }
  }

  /**
   * Parse les @mentions dans `body` et déclenche une notif par user résolu.
   * Reconnaît `@user.name@example.com` (mention email pleine) ou `@handle`
   * (matché contre la partie locale d'un email user dans la même org).
   */
  private async dispatchMentions(
    orgId: string,
    actorUserId: string,
    taskId: string,
    body: string,
  ): Promise<void> {
    for (const id of await this.resolveMentionedIds(orgId, body)) {
      void this.notifications.notifyMention(orgId, actorUserId, id, taskId, body);
    }
  }

  /** userIds mentionnés dans `body` (partagé avec la notif des watchers). */
  private async resolveMentionedIds(orgId: string, body: string): Promise<string[]> {
    const handles = new Set<string>();
    for (const m of body.matchAll(/@([\w.+-]+(?:@[\w.-]+\.[\w]{2,})?)/g)) {
      handles.add(m[1].toLowerCase());
    }
    if (handles.size === 0) return [];
    const arr = Array.from(handles);
    const users = await this.prisma.user.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        OR: [
          { email: { in: arr, mode: 'insensitive' } },
          // Préfixe local : si l'email est `alex@example.com` et la mention `@alex`.
          ...arr.filter((h) => !h.includes('@')).map((h) => ({
            email: { startsWith: `${h}@`, mode: 'insensitive' as const },
          })),
        ],
      },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  /** Watchers résolus en lazy (cf. TasksService — évite un cycle de modules). */
  private watchersService(): WatchersService | null {
    try {
      return this.moduleRef.get(WatchersService, { strict: false });
    } catch {
      return null;
    }
  }

  async update(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    commentId: string,
    dto: UpdateCommentDto,
  ) {
    const existing = await this.assertOwned(orgId, userId, isAdmin, commentId);
    const c = await this.prisma.comment.update({
      where: { id: commentId },
      data: { body: dto.body },
      include: INCLUDE,
    });
    const out = this.toDto(c);
    this.events.emitToProject(existing.projectId, 'comment.updated', out);
    return out;
  }

  async remove(orgId: string, userId: string, isAdmin: boolean, commentId: string) {
    const existing = await this.assertOwned(orgId, userId, isAdmin, commentId);
    await this.prisma.comment.update({ where: { id: commentId }, data: { deletedAt: new Date() } });
    this.events.emitToProject(existing.projectId, 'comment.deleted', { id: commentId });
    return { id: commentId, deleted: true };
  }

  // ---- Helpers ----

  private async assertTask(orgId: string, taskId: string) {
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId, deletedAt: null },
      select: { id: true, projectId: true },
    });
    if (!task) throw new NotFoundException('Tâche introuvable');
    return task;
  }

  private async assertOwned(orgId: string, userId: string, isAdmin: boolean, id: string) {
    const c = await this.prisma.comment.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      include: { task: { select: { projectId: true } } },
    });
    if (!c) throw new NotFoundException('Commentaire introuvable');
    if (!isAdmin && c.authorId !== userId) {
      throw new ForbiddenException("Tu ne peux modifier que tes propres commentaires");
    }
    return { ...c, projectId: c.task.projectId };
  }

  private toDto(c: CommentRow) {
    return {
      id: c.id,
      taskId: c.taskId,
      author: { id: c.author.id, name: c.author.name, email: c.author.email },
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }
}
