import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { ProjectAccessService } from './project-access.service';
import {
  PROJECT_ACCESS_KEY,
  TASK_WRITE_POLICY_KEY,
  ProjectAccessSource,
} from './project-access.decorator';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ferme l'IDOR (broken object-level authorization) sur les sous-ressources
 * projet. La `PermissionsGuard` ne vérifie que la permission **org-level**
 * (`task:view`, `report:view`, …) : un membre ordinaire l'a sur toute l'org et
 * pouvait donc lire/écrire les tâches/board/gantt/commentaires de n'importe
 * quel projet, y compris ceux dont il n'est pas membre.
 *
 * Ce guard lit les {@link ProjectAccessSource} déclarées via `@ProjectAccess`,
 * résout le(s) projet(s) ciblé(s) (directement par `:projectId`, ou via
 * l'entité task/comment/dependency/attachment/allocation/timeEntry pointée par
 * son id), puis exige que l'appelant soit membre/manager de **chaque** projet
 * concerné — ou détienne un droit élevé (`isAdmin`, `project:view_all`). La
 * décision réutilise {@link ProjectAccessService.canAccessProject}, identique
 * à la garde de `ProjectsService.findOne`.
 *
 * Sémantique des erreurs :
 *  - entité (task/comment/…) introuvable dans l'org → 404 (cohérent avec les
 *    « introuvable » des services) ;
 *  - entité visible mais projet non accessible       → 403.
 */
@Injectable()
export class ProjectAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly access: ProjectAccessService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const sources = this.reflector.getAllAndOverride<ProjectAccessSource[]>(
      PROJECT_ACCESS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!sources || sources.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    if (!user) throw new ForbiddenException('Non authentifié');

    // Clé d'organisation (identité service, tous scopes) = accès org complet,
    // au même titre qu'un admin. Un PAT utilisateur reste soumis au contrôle
    // d'appartenance ci-dessous (RBAC du user sous-jacent).
    if (user.viaApiToken && user.isOrgToken) return true;

    const orgId = user.orgId;
    const projectIds = new Set<string>();

    for (const s of sources) {
      const bag =
        s.in === 'body' ? req.body : s.in === 'query' ? req.query : req.params;
      const raw = bag?.[s.key];
      if (raw == null || typeof raw !== 'string' || raw === '') continue;
      if (!UUID_RE.test(raw)) throw new NotFoundException('Ressource introuvable');

      const projectId = await this.resolveProjectId(orgId, s, raw);
      if (!projectId) throw new NotFoundException('Ressource introuvable');
      projectIds.add(projectId);
    }

    // Aucune source résolue : la route n'est pas scopée projet pour cette
    // requête (ex. listing org-global) → rien à contrôler ici.
    if (projectIds.size === 0) return true;

    const taskWrite = this.reflector.getAllAndOverride<boolean>(TASK_WRITE_POLICY_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);

    for (const projectId of projectIds) {
      const ok = await this.access.canAccessProject(
        orgId,
        user.userId,
        !!user.isAdmin,
        projectId,
      );
      if (!ok) throw new ForbiddenException('Accès au projet refusé');

      // Policy d'écriture des tâches (cf. @TaskWritePolicy) : un membre
      // ordinaire ne peut éditer que les tâches d'un projet NON billable dont
      // il fait partie — sur un projet billable il ne fait que logger du temps.
      if (taskWrite) {
        const canWrite = await this.access.canWriteTasks(
          orgId,
          user.userId,
          !!user.isAdmin,
          projectId,
        );
        if (!canWrite) {
          throw new ForbiddenException(
            'Édition des tâches refusée sur ce projet (projet facturable — réservé aux Project Managers / Contributors du projet)',
          );
        }
      }
    }
    return true;
  }

  /** Remonte au `projectId` selon le type de la source. `null` = introuvable. */
  private async resolveProjectId(
    orgId: string,
    s: ProjectAccessSource,
    id: string,
  ): Promise<string | null> {
    switch (s.kind) {
      case 'project':
        return id;
      case 'task': {
        const t = await this.prisma.task.findFirst({
          where: { id, organizationId: orgId, deletedAt: null },
          select: { projectId: true },
        });
        return t?.projectId ?? null;
      }
      case 'comment': {
        const c = await this.prisma.comment.findFirst({
          where: { id, organizationId: orgId, deletedAt: null },
          select: { task: { select: { projectId: true } } },
        });
        return c?.task?.projectId ?? null;
      }
      case 'dependency': {
        const d = await this.prisma.taskDependency.findFirst({
          where: { id, organizationId: orgId },
          select: { projectId: true },
        });
        return d?.projectId ?? null;
      }
      case 'attachment': {
        const a = await this.prisma.attachment.findFirst({
          where: { id, organizationId: orgId, deletedAt: null },
          select: { task: { select: { projectId: true } } },
        });
        return a?.task?.projectId ?? null;
      }
      case 'allocation': {
        const a = await this.prisma.allocation.findFirst({
          where: { id, organizationId: orgId },
          select: { projectId: true },
        });
        return a?.projectId ?? null;
      }
      case 'timeEntry': {
        const e = await this.prisma.timeEntry.findFirst({
          where: { id, organizationId: orgId },
          select: { task: { select: { projectId: true } } },
        });
        return e?.task?.projectId ?? null;
      }
    }
  }
}
