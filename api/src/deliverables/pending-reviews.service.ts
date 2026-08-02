import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../rbac/project-access.service';

/** Plafond dur du listing — une file de revue n'a pas vocation à tout déverser. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/**
 * File des livrables **en attente de revue**, agrégée au niveau org.
 *
 * Comble un trou : `GET tasks/:taskId/deliverables` est par tâche (il faut déjà
 * connaître la tâche) et l'agrégat `me/dashboard` est app-privé — un client IA
 * n'avait donc aucun moyen de répondre à « qu'est-ce qui m'attend en revue ? »
 * autrement qu'en bouclant projet par projet.
 *
 * Deux invariants de sécurité :
 *
 *  - **Self-scoping obligatoire** via `accessibleProjectScope` : un listing
 *    org-global qui ne se scope pas fuite du cross-user (règle maison). `null`
 *    = périmètre élevé (admin / `project:view_all`), sinon liste d'ids.
 *  - **L'auteur n'est jamais son propre reviewer** : on exclut les livrables
 *    produits par l'appelant, comme le fait le gate de revue lui-même. La file
 *    ne montre donc que ce qu'il pourrait réellement traiter.
 *
 * Les projets `EXTERNAL` (conteneurs de tickets, timesheet only) sont exclus
 * comme partout ailleurs.
 */
@Injectable()
export class PendingReviewsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async list(
    orgId: string,
    requester: { userId: string; isAdmin: boolean },
    opts: { limit?: number } = {},
  ) {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const scope = await this.access.accessibleProjectScope(orgId, requester.userId, requester.isAdmin);

    const where = {
      organizationId: orgId,
      reviewStatus: 'PENDING' as const,
      deletedAt: null,
      // Reviewer ≠ auteur : inutile de lister ce qu'il ne peut pas approuver.
      authorId: { not: requester.userId },
      task: {
        deletedAt: null,
        project: { kind: 'STANDARD' as const, deletedAt: null },
        ...(scope ? { projectId: { in: scope } } : {}),
      },
    };

    const [total, rows] = await Promise.all([
      this.prisma.deliverable.count({ where }),
      this.prisma.deliverable.findMany({
        where,
        // Les plus anciens d'abord : c'est une file d'attente, pas un flux.
        orderBy: { createdAt: 'asc' },
        take: limit,
        select: {
          id: true,
          title: true,
          version: true,
          authorId: true,
          createdAt: true,
          taskId: true,
          task: {
            select: {
              title: true,
              projectId: true,
              project: { select: { key: true, name: true } },
            },
          },
        },
      }),
    ]);

    // `authorId` est un scalaire (pas de relation Prisma) → résolution des
    // libellés en un seul aller-retour plutôt qu'un N+1.
    const authorIds = [...new Set(rows.map((r) => r.authorId))];
    const authors = authorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: authorIds } },
          select: { id: true, name: true, kind: true },
        })
      : [];
    const byId = new Map(authors.map((a) => [a.id, a]));

    const now = Date.now();
    return {
      total,
      returned: rows.length,
      truncated: total > rows.length,
      items: rows.map((r) => ({
        deliverableId: r.id,
        title: r.title,
        version: r.version,
        taskId: r.taskId,
        taskTitle: r.task?.title ?? null,
        projectId: r.task?.projectId ?? null,
        projectKey: r.task?.project?.key ?? null,
        projectName: r.task?.project?.name ?? null,
        authorId: r.authorId,
        authorName: byId.get(r.authorId)?.name ?? null,
        /** Distingue une revue de production humaine d'une sortie d'agent. */
        authorKind: byId.get(r.authorId)?.kind ?? null,
        submittedAt: r.createdAt,
        waitingDays: Math.floor((now - r.createdAt.getTime()) / 86_400_000),
      })),
    };
  }
}
