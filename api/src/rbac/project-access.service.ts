import { Injectable } from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { RbacService } from './rbac.service';

/**
 * Source unique de vérité de la **visibilité projet** côté membre. Réplique
 * EXACTEMENT la garde de `ProjectsService.findOne` :
 *
 *  - admin global (`isAdmin`)                         → accès
 *  - rôle org avec `project:view_all`                 → accès
 *  - membre direct du projet (`ProjectMember`)        → accès
 *  - membre via une équipe affectée
 *    (`ProjectTeam` ∩ `TeamMember`)                   → accès
 *  - sinon (ou projet inexistant dans l'org)          → refus
 *
 * Utilisée par {@link ProjectAccessGuard} pour fermer l'IDOR sur toutes les
 * sous-ressources d'un projet (tasks, board, gantt, dependencies, reports,
 * comments, attachments, time-entries, labels, skills, allocations) : la
 * `PermissionsGuard` ne vérifie que la permission **org-level**, jamais
 * l'appartenance au projet ciblé.
 */
@Injectable()
export class ProjectAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
  ) {}

  /**
   * Héritage owner→agent. Un agent IA (`kind=AGENT`) n'a pas besoin d'être
   * ajouté membre de chaque projet : il **hérite de l'accès projet de son owner
   * humain**, borné aux projets `agentsEnabled` (les seuls qui acceptent des
   * agents — la case « Agents IA » du projet est donc le point d'opt-in). Le
   * lien est recalculé **à la volée** (pas de `ProjectMember` matérialisé pour
   * l'agent) : si l'owner quitte le projet, l'agent perd l'accès au tick
   * suivant. Renvoie l'`ownerId` si `userId` est un agent avec owner, sinon
   * `null` (les humains ne passent jamais par l'héritage).
   */
  private async agentOwnerId(userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { kind: true, ownerId: true },
    });
    return u?.kind === 'AGENT' ? (u.ownerId ?? null) : null;
  }

  /**
   * `true` si `agentUserId` est un agent dont l'**owner** est membre (direct ou
   * via une équipe affectée) du projet **et** que le projet est `agentsEnabled`.
   * Base commune de l'héritage owner→agent pour les vérifications mono-projet
   * ({@link canAccessProject}, {@link canWriteTasks}).
   */
  private async agentInheritsProject(
    orgId: string,
    agentUserId: string,
    projectId: string,
  ): Promise<boolean> {
    const ownerId = await this.agentOwnerId(agentUserId);
    if (!ownerId) return false;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null, agentsEnabled: true },
      select: { id: true },
    });
    if (!project) return false;
    const [ownerDirect, ownerViaTeam] = await Promise.all([
      this.prisma.projectMember.findFirst({
        where: { projectId, userId: ownerId },
        select: { projectId: true },
      }),
      this.prisma.projectTeam.findFirst({
        where: { projectId, team: { members: { some: { userId: ownerId } } } },
        select: { projectId: true },
      }),
    ]);
    return !!ownerDirect || !!ownerViaTeam;
  }

  async canAccessProject(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    projectId: string,
  ): Promise<boolean> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, kind: true },
    });
    if (!project) return false;
    // Conteneur de tickets externes (kind=EXTERNAL) : pas de notion de
    // membership (invisible dans les menus, personne n'y est membre). Tout
    // utilisateur de l'org peut lire ses tâches et y logger du temps — c'est
    // le seul usage possible, les écritures structurantes (board, allocation,
    // dépendance, création manuelle de tâche) sont bloquées dans les services.
    if (project.kind === 'EXTERNAL') return true;
    if (isAdmin) return true;

    const perms = await this.rbac.getEffectivePermissions(userId, orgId);
    if (perms.has('project:view_all')) return true;

    const [directMember, viaTeam] = await Promise.all([
      this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        select: { projectId: true },
      }),
      this.prisma.projectTeam.findFirst({
        where: { projectId, team: { members: { some: { userId } } } },
        select: { projectId: true },
      }),
    ]);
    if (directMember || viaTeam) return true;
    // Héritage owner→agent : un agent accède au projet si son owner en est
    // membre (projet agentsEnabled uniquement). Recalculé à la volée.
    return this.agentInheritsProject(orgId, userId, projectId);
  }

  /**
   * Policy d'**écriture des tâches** d'un projet (cf. `@TaskWritePolicy`).
   * La permission org-level `task:update`/`task:create` d'un membre ordinaire
   * (ORG_MEMBER) ne suffit pas : elle ne vaut que sur un projet **non
   * billable** dont il fait partie. Les rôles élevés gardent la main partout :
   *
   *  - admin global → autorisé ;
   *  - rôle projet explicite portant `task:update` (PROJECT_MANAGER,
   *    CONTRIBUTOR posé sur CE projet) → autorisé, billable ou non ;
   *  - rôle org « manager » (porte `task:delete` en plus de `task:update` :
   *    ORG_ADMIN, PORTFOLIO_MANAGER, TEAM_MANAGER) → autorisé ;
   *  - sinon (membre ordinaire) → projet non billable ET membre du projet
   *    (direct ou via équipe affectée), sinon refus.
   */
  async canWriteTasks(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    projectId: string,
  ): Promise<boolean> {
    if (isAdmin) return true;
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { billable: true },
    });
    if (!project) return false;

    // Rôle projet explicite (grant délibéré sur CE projet).
    const pm = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      include: { role: true },
    });
    if (pm?.role.permissions.includes('task:update')) return true;

    // Rôle hérité d'une équipe assignée au projet portant `task:update`
    // (ex. l'équipe entière en CONTRIBUTOR) → écriture autorisée, billable ou non.
    const teamWrite = await this.prisma.projectTeam.findFirst({
      where: {
        projectId,
        role: { permissions: { has: 'task:update' } },
        team: { members: { some: { userId } } },
      },
      select: { teamId: true },
    });
    if (teamWrite) return true;

    // Rôle org seul (sans contexte projet — le rôle projet est traité ci-dessus).
    const orgPerms = await this.rbac.getEffectivePermissions(userId, orgId);
    if (!orgPerms.has('task:update')) return false;
    // Manager-level : les rôles org qui portent aussi task:delete.
    if (orgPerms.has('task:delete')) return true;

    // Membre ordinaire : jamais d'édition sur un projet billable.
    if (project.billable) return false;
    if (pm) return true; // membre direct (déjà chargé ci-dessus)
    const viaTeam = await this.prisma.projectTeam.findFirst({
      where: { projectId, team: { members: { some: { userId } } } },
      select: { projectId: true },
    });
    if (viaTeam) return true;
    // Héritage owner→agent : un agent édite les tâches d'un projet non billable
    // agentsEnabled si son owner en est membre — même plancher qu'un membre
    // ordinaire (un projet billable exigerait un rôle projet explicite, que
    // l'héritage n'accorde pas : les agents billables restent à ajouter à la
    // main, comportement volontairement conservateur).
    return this.agentInheritsProject(orgId, userId, projectId);
  }

  /**
   * Périmètre de **lecture transverse** d'un appelant, pour scoper côté serveur
   * les listings org-globaux (`/time-entries`, `/allocations`,
   * `/reports/time-breakdown`) que la {@link ProjectAccessGuard} ne couvre PAS
   * quand ils sont appelés sans `?projectId`/`?taskId` : un simple membre y
   * tient `report:view`/`time:log` sur toute l'org et lirait sinon les données
   * (heures, charges, e-mails) de tous les autres projets.
   *
   *  - `null`  → droit de lecture **élevé** (admin global, `project:view_all`
   *    ou `report:view_all`) : aucune restriction, voit toute l'org.
   *  - `string[]` → liste (possiblement vide) des IDs de projets accessibles
   *    (membre direct OU via une équipe affectée). Le service appelant doit en
   *    plus laisser passer les données **propres** au caller (`userId`).
   *
   * Même logique d'appartenance que {@link canAccessProject} (énumérée ici au
   * lieu d'être testée projet par projet).
   */
  /**
   * Visibilité des **ressources personnelles** d'un autre utilisateur
   * (compétences, work-schedule) : périmètre « annuaire de collaboration »,
   * plus large que la gestion (réservée admin / team lead) mais fermé à
   * l'énumération par un membre sans lien avec la cible.
   *
   *  - self / admin global                                  → accès
   *  - rôle org porteur d'`allocation:manage` ou `member:manage`
   *    (managers qui planifient la capacité)                → accès
   *  - équipe commune avec la cible                         → accès
   *  - projet commun (membre direct ou via équipe affectée) → accès
   *  - sinon                                                → refus
   */
  async canViewUserResource(
    orgId: string,
    caller: { userId: string; isAdmin: boolean },
    targetUserId: string,
  ): Promise<boolean> {
    if (caller.isAdmin || caller.userId === targetUserId) return true;

    const perms = await this.rbac.getEffectivePermissions(caller.userId, orgId);
    if (perms.has('allocation:manage') || perms.has('member:manage')) return true;

    // Équipe commune.
    const sharedTeam = await this.prisma.teamMember.findFirst({
      where: {
        userId: caller.userId,
        team: {
          organizationId: orgId,
          deletedAt: null,
          members: { some: { userId: targetUserId } },
        },
      },
      select: { teamId: true },
    });
    if (sharedTeam) return true;

    // Projet commun : chacun peut y être membre direct ou via une équipe.
    const memberOf = (userId: string): Prisma.ProjectWhereInput => ({
      OR: [
        { members: { some: { userId } } },
        { teams: { some: { team: { members: { some: { userId } } } } } },
      ],
    });
    const sharedProject = await this.prisma.project.findFirst({
      where: {
        organizationId: orgId,
        deletedAt: null,
        AND: [memberOf(caller.userId), memberOf(targetUserId)],
      },
      select: { id: true },
    });
    return !!sharedProject;
  }

  async accessibleProjectScope(
    orgId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<string[] | null> {
    if (isAdmin) return null;
    const perms = await this.rbac.getEffectivePermissions(userId, orgId);
    if (perms.has('project:view_all') || perms.has('report:view_all')) return null;

    const [direct, viaTeam] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: { userId, project: { organizationId: orgId, deletedAt: null } },
        select: { projectId: true },
      }),
      this.prisma.projectTeam.findMany({
        where: {
          project: { organizationId: orgId, deletedAt: null },
          team: { members: { some: { userId } } },
        },
        select: { projectId: true },
      }),
    ]);
    const ids = new Set<string>();
    for (const m of direct) ids.add(m.projectId);
    for (const t of viaTeam) ids.add(t.projectId);

    // Héritage owner→agent : ajoute les projets `agentsEnabled` dont l'owner de
    // l'agent est membre (direct ou via équipe). Borne l'exposition aux seuls
    // projets qui acceptent des agents, jamais tout le portefeuille de l'owner.
    const ownerId = await this.agentOwnerId(userId);
    if (ownerId) {
      const [ownerDirect, ownerViaTeam] = await Promise.all([
        this.prisma.projectMember.findMany({
          where: {
            userId: ownerId,
            project: { organizationId: orgId, deletedAt: null, agentsEnabled: true },
          },
          select: { projectId: true },
        }),
        this.prisma.projectTeam.findMany({
          where: {
            project: { organizationId: orgId, deletedAt: null, agentsEnabled: true },
            team: { members: { some: { userId: ownerId } } },
          },
          select: { projectId: true },
        }),
      ]);
      for (const m of ownerDirect) ids.add(m.projectId);
      for (const t of ownerViaTeam) ids.add(t.projectId);
    }
    return [...ids];
  }

  /**
   * Ensemble des utilisateurs dont le `caller` peut voir les ressources
   * personnelles (planning, congés…). `null` = tous (admin / gestionnaire).
   * Sinon : soi-même + membres d'une équipe commune + membres d'un projet
   * commun. Même règle que {@link canViewUserResource}, mais en liste (pour
   * scoper un listing org-global au lieu de fuiter toute l'org).
   */
  async accessibleUserScope(
    orgId: string,
    userId: string,
    isAdmin: boolean,
  ): Promise<string[] | null> {
    if (isAdmin) return null;
    const perms = await this.rbac.getEffectivePermissions(userId, orgId);
    if (perms.has('allocation:manage') || perms.has('member:manage')) return null;

    const [teamMates, projects] = await Promise.all([
      // Membres de toute équipe dont le caller fait partie.
      this.prisma.teamMember.findMany({
        where: {
          team: {
            organizationId: orgId,
            deletedAt: null,
            members: { some: { userId } },
          },
        },
        select: { userId: true },
      }),
      // Projets accessibles au caller (membre direct ou via équipe).
      this.prisma.project.findMany({
        where: {
          organizationId: orgId,
          deletedAt: null,
          OR: [
            { members: { some: { userId } } },
            { teams: { some: { team: { members: { some: { userId } } } } } },
          ],
        },
        select: {
          members: { select: { userId: true } },
          teams: { select: { team: { select: { members: { select: { userId: true } } } } } },
        },
      }),
    ]);
    const ids = new Set<string>([userId]);
    for (const tm of teamMates) ids.add(tm.userId);
    for (const p of projects) {
      for (const m of p.members) ids.add(m.userId);
      for (const t of p.teams) for (const m of t.team.members) ids.add(m.userId);
    }
    return [...ids];
  }
}
