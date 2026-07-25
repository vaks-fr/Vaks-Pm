import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from '../rbac/project-access.service';
import { AuthUser, requesterOf } from '../auth/current-user.decorator';

export interface SearchResults {
  projects: { id: string; key: string; name: string }[];
  tasks: {
    id: string;
    title: string;
    projectId: string;
    projectKey: string;
    projectName: string;
    status: string;
  }[];
}

/**
 * Recherche globale (command palette ⌘K) : projets + tâches, **bornée au
 * périmètre accessible** de l'appelant (`accessibleProjectScope`) — un membre
 * ne voit que ses projets. Conteneurs `kind=EXTERNAL` exclus (invisibles).
 */
@Injectable()
export class SearchService {
  /** Au-delà de cette taille de résultat par catégorie, on tronque. */
  private static readonly LIMIT = 8;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async global(user: AuthUser, rawQuery: string): Promise<SearchResults> {
    const q = (rawQuery ?? '').trim();
    if (q.length < 2) return { projects: [], tasks: [] };

    const { userId, isAdmin } = requesterOf(user);
    const scope = await this.access.accessibleProjectScope(user.orgId, userId, isAdmin);
    // scope === null  → accès org-wide (admin / view_all) ; [] → aucun projet.
    if (scope && scope.length === 0) return { projects: [], tasks: [] };
    const inScope = scope ? { in: scope } : undefined;

    const [projects, tasks] = await Promise.all([
      this.prisma.project.findMany({
        where: {
          organizationId: user.orgId,
          deletedAt: null,
          kind: 'STANDARD',
          ...(inScope ? { id: inScope } : {}),
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { key: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: { id: true, key: true, name: true },
        orderBy: { name: 'asc' },
        take: 6,
      }),
      this.prisma.task.findMany({
        where: {
          organizationId: user.orgId,
          deletedAt: null,
          project: { deletedAt: null, kind: 'STANDARD' },
          ...(inScope ? { projectId: inScope } : {}),
          title: { contains: q, mode: 'insensitive' },
        },
        select: {
          id: true,
          title: true,
          projectId: true,
          status: true,
          project: { select: { key: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
        take: SearchService.LIMIT,
      }),
    ]);

    return {
      projects,
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId,
        projectKey: t.project.key,
        projectName: t.project.name,
        status: t.status,
      })),
    };
  }
}
