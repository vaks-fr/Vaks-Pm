import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { WorkloadService } from '../workload/workload.service';
import { CapacityService } from '../workload/capacity.service';
import { TeamsProvisioningService } from '../teams-provisioning/teams-provisioning.service';
import { SeatService } from '../licensing/seat.service';
import { blankStatusCounts } from '../common/task-status.util';
import {
  AddTeamMemberDto,
  CreateTeamDto,
  UpdateTeamDto,
  UpdateTeamMemberDto,
} from './dto/team.dto';

/**
 * Contexte appelant pour les méthodes qui scopent la vue / autorisent les
 * mutations. `isAdmin` court-circuite tous les filtres ; sinon on filtre
 * sur les équipes dont l'utilisateur est lead (TEAM_MANAGER), avec un
 * fallback "équipes dont je suis membre" pour les rôles non-admin sans
 * pouvoir de management (visibilité simple).
 */
export interface CallerCtx {
  userId: string;
  isAdmin: boolean;
}

/** Prisma.Decimal (ou null) → number JS arrondi 2 décimales. */
const money = (v: unknown): number | null =>
  v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100;

@Injectable()
export class TeamsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workload: WorkloadService,
    private readonly capacity: CapacityService,
    private readonly teamsProvisioning: TeamsProvisioningService,
    private readonly seats: SeatService,
  ) {}

  /** Si l'équipe est `autoLicense`, réconcilie les sièges (grant/revoke) pour
   *  les users concernés. Best-effort, fire-and-forget. */
  private autoLicense(
    orgId: string,
    teamId: string,
    change: { grant?: string[]; revoke?: string[] },
    caller: CallerCtx,
  ): void {
    void (async () => {
      const team = await this.prisma.team.findUnique({
        where: { id: teamId },
        select: { autoLicense: true },
      });
      if (!team?.autoLicense) return;
      await this.seats.reconcileAutoLicense(orgId, change, {
        actorId: caller.userId,
        via: 'team_auto',
      });
    })().catch(() => { /* best-effort */ });
  }

  /** Best-effort : un changement de composition d'équipe ré-synchronise la
   *  membership Teams des projets provisionnés qui incluent cette équipe. */
  private reconcileTeam(orgId: string, teamId: string) {
    void this.teamsProvisioning
      .enqueueReconcileForTeam(orgId, teamId)
      .catch(() => { /* swallow — best-effort */ });
  }

  /** Garde lead-only (ou admin) partagée par les rapports/KPI d'équipe. */
  private async assertTeamLead(teamId: string, caller: CallerCtx) {
    if (caller.isAdmin) return;
    const lead = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: caller.userId } },
      select: { isLead: true },
    });
    if (!lead?.isLead) {
      throw new ForbiddenException('Réservé au Team Manager de cette équipe (ou à un admin).');
    }
  }

  /**
   * KPI d'équipe (lead-only) : taux d'utilisation (facturable vs opérationnel,
   * par membre), fréquence des conflits de ressources (sur-allocation
   * multi-projets) et marge de capacité (dispo − alloué). Fenêtre `[from, to]`.
   */
  async getTeamKpi(orgId: string, teamId: string, caller: CallerCtx, from: string, to: string) {
    const team = await this.assertTeam(orgId, teamId);
    await this.assertTeamLead(teamId, caller);

    const members = await this.prisma.teamMember.findMany({
      where: { teamId },
      select: { userId: true, user: { select: { name: true } } },
    });
    const memberIds = members.map((m) => m.userId);
    const nameOf = new Map(members.map((m) => [m.userId, m.user.name]));
    const fromD = new Date(from + 'T00:00:00.000Z');
    const toD = new Date(to + 'T00:00:00.000Z');
    const toDEnd = new Date(to + 'T23:59:59.999Z');

    // ----- Utilisation : heures facturables vs opérationnelles par membre -----
    const util = new Map<string, { billable: number; total: number }>();
    if (memberIds.length) {
      const entries = await this.prisma.timeEntry.findMany({
        where: {
          organizationId: orgId,
          userId: { in: memberIds },
          date: { gte: fromD, lte: toDEnd },
          task: { project: { kind: 'STANDARD' } },
        },
        select: { userId: true, durationMinutes: true, task: { select: { project: { select: { billable: true } } } } },
      });
      for (const e of entries) {
        const u = util.get(e.userId) ?? { billable: 0, total: 0 };
        u.total += e.durationMinutes;
        if (e.task.project.billable) u.billable += e.durationMinutes;
        util.set(e.userId, u);
      }
    }
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const byUserUtil = memberIds.map((uid) => {
      const u = util.get(uid) ?? { billable: 0, total: 0 };
      const billableH = r1(u.billable / 60);
      const totalH = r1(u.total / 60);
      return {
        userId: uid,
        name: nameOf.get(uid) ?? '—',
        billableHours: billableH,
        operationalHours: r1((u.total - u.billable) / 60),
        totalHours: totalH,
        billablePct: u.total ? Math.round((u.billable / u.total) * 1000) / 10 : null,
      };
    }).sort((a, b) => b.totalHours - a.totalHours);
    const totBill = [...util.values()].reduce((s, u) => s + u.billable, 0);
    const totAll = [...util.values()].reduce((s, u) => s + u.total, 0);

    // ----- Conflits + marge de capacité -----
    const cap = memberIds.length
      ? await this.capacity.analyzeUsersCapacity(orgId, memberIds, fromD, toD)
      : { conflictDays: 0, peopleAffected: 0, worst: [], availableHours: 0, allocatedHours: 0, headroomHours: 0, perUser: [] };

    return {
      teamId: team.id,
      teamName: team.name,
      from,
      to,
      utilization: {
        teamBillablePct: totAll ? Math.round((totBill / totAll) * 1000) / 10 : null,
        byUser: byUserUtil,
      },
      conflict: {
        conflictDays: cap.conflictDays,
        peopleAffected: cap.peopleAffected,
        worst: cap.worst,
      },
      capacity: {
        availableHours: cap.availableHours,
        allocatedHours: cap.allocatedHours,
        headroomHours: cap.headroomHours,
        byUser: cap.perUser,
      },
    };
  }

  /**
   * Rapport d'équipe (lead-only) : par membre — capacité, heures loggées,
   * taux d'utilisation, allocation par projet, répartition des statuts de
   * tâches. Réutilise `WorkloadService.workloadGrid` (capacité + allocation
   * par projet, déjà scopé équipe). Fenêtre `[from, to]` (semaine ou mois côté UI).
   */
  async getTeamReport(orgId: string, teamId: string, caller: CallerCtx, from: string, to: string) {
    const team = await this.assertTeam(orgId, teamId);
    if (!caller.isAdmin) {
      const lead = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: caller.userId } },
        select: { isLead: true },
      });
      if (!lead?.isLead) {
        throw new ForbiddenException('Réservé au Team Manager de cette équipe (ou à un admin).');
      }
    }

    const grid = await this.workload.workloadGrid(
      orgId,
      { userId: caller.userId, isAdmin: caller.isAdmin },
      { from, to, teamId } as never,
    );
    const userIds = grid.rows.map((r) => r.userId);
    const fromD = new Date(from + 'T00:00:00.000Z');
    const toD = new Date(to + 'T23:59:59.999Z');

    // Heures loggées par user (projets STANDARD), sur la fenêtre.
    const logged = new Map<string, number>();
    if (userIds.length) {
      const entries = await this.prisma.timeEntry.findMany({
        where: {
          organizationId: orgId,
          userId: { in: userIds },
          date: { gte: fromD, lte: toD },
          task: { project: { kind: 'STANDARD' } },
        },
        select: { userId: true, durationMinutes: true },
      });
      for (const e of entries) logged.set(e.userId, (logged.get(e.userId) ?? 0) + e.durationMinutes / 60);
    }

    // Comptes de statut par user (tâches assignées, non supprimées).
    const statusByUser = new Map<string, Record<TaskStatus, number>>();
    if (userIds.length) {
      const assigned = await this.prisma.taskAssignee.findMany({
        where: { userId: { in: userIds }, task: { organizationId: orgId, deletedAt: null } },
        select: { userId: true, task: { select: { status: true } } },
      });
      for (const a of assigned) {
        const s = statusByUser.get(a.userId) ?? blankStatusCounts();
        s[a.task.status]++;
        statusByUser.set(a.userId, s);
      }
    }

    const r2 = (n: number) => Math.round(n * 10) / 10;
    const members = grid.rows.map((row) => {
      let capacity = 0;
      const byProj = new Map<string, { projectKey: string; projectName: string; hours: number }>();
      for (const c of row.cells) {
        capacity += c.capacityHours;
        for (const a of c.allocations) {
          const g = byProj.get(a.projectKey) ?? { projectKey: a.projectKey, projectName: a.projectName, hours: 0 };
          g.hours += a.hours;
          byProj.set(a.projectKey, g);
        }
      }
      const allocated = [...byProj.values()].reduce((s, p) => s + p.hours, 0);
      const loggedH = logged.get(row.userId) ?? 0;
      return {
        userId: row.userId,
        name: row.name,
        capacityHours: r2(capacity),
        loggedHours: r2(loggedH),
        allocatedHours: r2(allocated),
        utilizationPct: capacity > 0 ? Math.round((loggedH / capacity) * 1000) / 10 : null,
        allocationPct: capacity > 0 ? Math.round((allocated / capacity) * 1000) / 10 : null,
        byProject: [...byProj.values()]
          .map((p) => ({ projectKey: p.projectKey, projectName: p.projectName, hours: r2(p.hours), pct: capacity > 0 ? Math.round((p.hours / capacity) * 1000) / 10 : null }))
          .sort((a, b) => b.hours - a.hours),
        statusCounts: statusByUser.get(row.userId) ?? blankStatusCounts(),
      };
    });

    // Agrégats équipe.
    const totalsStatus = blankStatusCounts();
    for (const m of members) (Object.keys(m.statusCounts) as TaskStatus[]).forEach((k) => (totalsStatus[k] += m.statusCounts[k]));
    const utilVals = members.map((m) => m.utilizationPct).filter((v): v is number => v != null);
    const avgUtilization = utilVals.length ? Math.round((utilVals.reduce((s, v) => s + v, 0) / utilVals.length) * 10) / 10 : null;

    return {
      teamId: team.id,
      teamName: team.name,
      from,
      to,
      members,
      totals: {
        memberCount: members.length,
        avgUtilizationPct: avgUtilization,
        statusCounts: totalsStatus,
        capacityHours: r2(members.reduce((s, m) => s + m.capacityHours, 0)),
        loggedHours: r2(members.reduce((s, m) => s + m.loggedHours, 0)),
        allocatedHours: r2(members.reduce((s, m) => s + m.allocatedHours, 0)),
      },
    };
  }

  /**
   * Liste les équipes visibles par l'appelant.
   *  - admin / `member:manage` (handled by guard upstream) → toutes
   *  - sinon → équipes dont l'appelant est membre (lead ou non)
   *
   * On garde la visibilité large pour les ORG_MEMBER (ils ont besoin de
   * voir leurs équipes pour comprendre à quels projets ils ont accès) ;
   * la distinction "manager" se joue sur les permissions de mutation.
   */
  list(orgId: string, caller: CallerCtx) {
    const where: Prisma.TeamWhereInput = {
      organizationId: orgId,
      deletedAt: null,
    };
    if (!caller.isAdmin) {
      where.members = { some: { userId: caller.userId } };
    }
    return this.prisma.team.findMany({
      where,
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
  }

  /** Liste exclusivement les équipes pilotées par l'appelant (TEAM_MANAGER). */
  listLed(orgId: string, userId: string) {
    return this.prisma.team.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        members: { some: { userId, isLead: true } },
      },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
  }

  async get(orgId: string, teamId: string, caller: CallerCtx) {
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: orgId, deletedAt: null },
      include: {
        members: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                status: true,
                canCreateNonBillableProject: true,
                defaultCostRate: true,
                defaultBillRate: true,
              },
            },
          },
          orderBy: [{ isLead: 'desc' }, { createdAt: 'asc' }],
        },
      },
    });
    if (!team) throw new NotFoundException('Équipe introuvable');
    if (!caller.isAdmin && !team.members.some((m) => m.userId === caller.userId)) {
      // On ne révèle pas l'existence d'une équipe à laquelle l'appelant
      // n'appartient pas — 404 plutôt que 403.
      throw new NotFoundException('Équipe introuvable');
    }
    // Les taux par défaut des membres ne sont visibles que par un Team
    // Manager de CETTE équipe (ou un admin) — strip pour les autres.
    const callerIsLead =
      caller.isAdmin ||
      team.members.some((m) => m.userId === caller.userId && m.isLead);
    return {
      ...team,
      members: team.members.map((m) => {
        const { defaultCostRate, defaultBillRate, ...user } = m.user;
        return {
          ...m,
          user: callerIsLead
            ? {
                ...user,
                defaultCostRate: money(defaultCostRate),
                defaultBillRate: money(defaultBillRate),
              }
            : user,
        };
      }),
    };
  }

  async create(orgId: string, dto: CreateTeamDto) {
    try {
      return await this.prisma.team.create({
        data: {
          organizationId: orgId,
          name: dto.name,
          description: dto.description ?? null,
          color: dto.color ?? null,
          source: 'LOCAL',
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Une équipe avec ce nom existe déjà');
      }
      throw e;
    }
  }

  async update(
    orgId: string,
    teamId: string,
    dto: UpdateTeamDto,
    caller?: CallerCtx,
  ) {
    const existing = await this.assertTeam(orgId, teamId);
    // Si appelé depuis le contrôleur (caller fourni), on autorise admin OU
    // lead de l'équipe. Les anciens appelants internes (sans caller) gardent
    // le comportement implicite "admin uniquement" assumé par leur contexte.
    if (caller && !caller.isAdmin) {
      const lead = await this.prisma.teamMember.findUnique({
        where: { teamId_userId: { teamId, userId: caller.userId } },
        select: { isLead: true },
      });
      if (!lead?.isLead) {
        throw new ForbiddenException(
          "Seul un Team Manager de cette équipe (ou un admin) peut la modifier",
        );
      }
      // Un lead ne doit pas pouvoir toggler le flag
      // canCreateNonBillableProject (policy organisationnelle).
      if (dto.canCreateNonBillableProject !== undefined) {
        throw new ForbiddenException(
          "Seul un administrateur global peut modifier ce paramètre",
        );
      }
      // Idem pour l'auto-licence : c'est un enjeu de licence/facturation.
      if (dto.autoLicense !== undefined) {
        throw new ForbiddenException(
          "Seul un administrateur global peut modifier l'auto-licence",
        );
      }
    }
    // Équipes SCIM/OIDC : SEUL le `name` canonique (et la composition) viennent
    // de l'IdP — réécrits à chaque sync, donc non éditables ici. Tout le reste
    // (displayName, couleur, description, flag projet) est LOCAL et n'est jamais
    // touché par la synchro → éditable comme une équipe normale.
    const scimManaged = existing.source !== 'LOCAL';
    if (scimManaged && dto.name !== undefined && dto.name !== existing.name) {
      throw new ForbiddenException(
        `Équipe synchronisée depuis ${existing.source} : le nom est géré par l'IdP — utilisez le « nom d'affichage » à la place.`,
      );
    }
    try {
      const updated = await this.prisma.team.update({
        where: { id: teamId },
        data: {
          ...(dto.displayName !== undefined
            ? { displayName: dto.displayName?.trim() || null }
            : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.description !== undefined ? { description: dto.description } : {}),
          ...(dto.canCreateNonBillableProject !== undefined
            ? { canCreateNonBillableProject: dto.canCreateNonBillableProject }
            : {}),
          ...(dto.autoLicense !== undefined ? { autoLicense: dto.autoLicense } : {}),
          ...(!scimManaged && dto.name !== undefined ? { name: dto.name } : {}),
        },
      });
      // Bascule du flag auto-licence → réconcilier tous les membres : ON =
      // attribuer un siège, OFF = libérer (sauf couverture par une autre équipe).
      if (dto.autoLicense !== undefined && dto.autoLicense !== existing.autoLicense) {
        const members = await this.prisma.teamMember.findMany({
          where: { teamId },
          select: { userId: true },
        });
        const ids = members.map((m) => m.userId);
        if (ids.length) {
          const actor: CallerCtx = caller ?? { userId: '', isAdmin: true };
          void this.seats.reconcileAutoLicense(
            orgId,
            dto.autoLicense ? { grant: ids } : { revoke: ids },
            { actorId: actor.userId || null, via: 'team_auto' },
          );
        }
      }
      return updated;
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Une équipe avec ce nom existe déjà');
      }
      throw e;
    }
  }

  /**
   * Soft-delete (archive) — réversible. Étape 1 du cycle de suppression :
   * l'équipe est masquée partout mais reste restaurable (et, pour une équipe
   * SCIM/OIDC, ressuscitable par l'IdP à la prochaine synchro via l'externalId).
   * On autorise désormais les équipes synchronisées : c'est un soft-delete, pas
   * une suppression définitive côté IdP — utile pour relancer une sync propre.
   */
  async remove(orgId: string, teamId: string) {
    const existing = await this.assertTeam(orgId, teamId);
    await this.prisma.team.update({
      where: { id: teamId },
      data: { deletedAt: new Date() },
    });
    return { id: teamId, name: existing.name, source: existing.source, deleted: true };
  }

  /** Liste les équipes archivées (soft-deleted) — admin uniquement (gating
   *  contrôleur `team:delete`). Compteur de membres inclus. */
  async listArchived(orgId: string) {
    return this.prisma.team.findMany({
      where: { organizationId: orgId, deletedAt: { not: null } },
      orderBy: { deletedAt: 'desc' },
      include: { _count: { select: { members: true } } },
    });
  }

  /**
   * Restaure une équipe archivée (deletedAt → null). Gère les collisions de
   * contrainte unique (nom/externalId) si une autre équipe active a repris la
   * même clé entre-temps → 409 explicite.
   */
  async restore(orgId: string, teamId: string) {
    const t = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: orgId, deletedAt: { not: null } },
      select: { id: true, name: true, source: true },
    });
    if (!t) throw new NotFoundException('Équipe archivée introuvable');
    try {
      await this.prisma.team.update({ where: { id: teamId }, data: { deletedAt: null } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(
          'Une équipe active porte déjà ce nom ou cet identifiant externe — renommez-la avant de restaurer.',
        );
      }
      throw e;
    }
    return { id: teamId, name: t.name, source: t.source, restored: true };
  }

  /**
   * Suppression DÉFINITIVE (hard-delete). Étape 2 : n'opère QUE sur une équipe
   * déjà archivée (soft-delete obligatoire avant — garde-fou anti-erreur). Les
   * liens (membres, affectations projet, skills, scopes de pack) tombent en
   * cascade (`onDelete: Cascade`). Irréversible.
   */
  async purge(orgId: string, teamId: string) {
    const t = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: orgId, deletedAt: { not: null } },
      select: { id: true, name: true },
    });
    if (!t) {
      throw new NotFoundException(
        "Équipe archivée introuvable — archivez-la d'abord (soft-delete) avant la suppression définitive.",
      );
    }
    await this.prisma.team.delete({ where: { id: teamId } });
    return { id: teamId, name: t.name, purged: true };
  }

  /**
   * Autorise l'ajout / retrait / promotion de membres :
   *  - admin global → toujours OK
   *  - sinon → l'appelant doit être lead de l'équipe ciblée (TEAM_MANAGER)
   *  - bloque les équipes non-LOCAL (les membres viennent de l'IdP)
   */
  private async assertCanManageMembers(orgId: string, teamId: string, caller: CallerCtx) {
    const team = await this.assertTeam(orgId, teamId);
    if (team.source !== 'LOCAL') {
      throw new ForbiddenException(
        `Équipe synchronisée depuis ${team.source} : composition gérée par l'IdP`,
      );
    }
    if (caller.isAdmin) return team;
    const lead = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId: caller.userId } },
      select: { isLead: true },
    });
    if (!lead?.isLead) {
      throw new ForbiddenException(
        "Seul un Team Manager de cette équipe (ou un admin) peut en gérer les membres",
      );
    }
    return team;
  }

  async addMember(
    orgId: string,
    teamId: string,
    caller: CallerCtx,
    dto: AddTeamMemberDto,
  ) {
    await this.assertCanManageMembers(orgId, teamId, caller);
    await this.assertUserInOrg(orgId, dto.userId);
    try {
      const created = await this.prisma.teamMember.create({
        data: { teamId, userId: dto.userId, isLead: dto.isLead ?? false },
        include: {
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              status: true,
              canCreateNonBillableProject: true,
              defaultCostRate: true,
              defaultBillRate: true,
            },
          },
        },
      });
      // L'appelant est lead/admin (assertCanManageMembers) → taux visibles.
      this.reconcileTeam(orgId, teamId);
      // Auto-licence : si l'équipe l'est, le nouveau membre reçoit un siège.
      this.autoLicense(orgId, teamId, { grant: [dto.userId] }, caller);
      return {
        ...created,
        user: {
          ...created.user,
          defaultCostRate: money(created.user.defaultCostRate),
          defaultBillRate: money(created.user.defaultBillRate),
        },
      };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('Utilisateur déjà membre de cette équipe');
      }
      throw e;
    }
  }

  async updateMember(
    orgId: string,
    teamId: string,
    userId: string,
    caller: CallerCtx,
    dto: UpdateTeamMemberDto,
  ) {
    await this.assertCanManageMembers(orgId, teamId, caller);
    const existing = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!existing) throw new NotFoundException('Membre introuvable dans cette équipe');
    if (dto.isLead !== undefined) {
      await this.prisma.teamMember.update({
        where: { teamId_userId: { teamId, userId } },
        data: { isLead: dto.isLead },
      });
    }
    const userPatch: Prisma.UserUpdateInput = {};
    if (dto.canCreateNonBillableProject !== undefined) {
      // Override par user, stocké directement sur User (le flag est global,
      // pas par équipe — un user n'a qu'un seul override quelle que soit
      // l'équipe d'où on l'édite).
      userPatch.canCreateNonBillableProject = dto.canCreateNonBillableProject;
    }
    // Coûts par défaut du user (mêmes règles : stockés sur User, globaux,
    // éditables par le lead de n'importe laquelle de ses équipes ou un admin
    // — assertCanManageMembers a déjà validé l'appelant).
    if (dto.defaultCostRate !== undefined) userPatch.defaultCostRate = dto.defaultCostRate;
    if (dto.defaultBillRate !== undefined) userPatch.defaultBillRate = dto.defaultBillRate;
    if (Object.keys(userPatch).length > 0) {
      await this.prisma.user.update({ where: { id: userId }, data: userPatch });
    }
    const updated = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            canCreateNonBillableProject: true,
            defaultCostRate: true,
            defaultBillRate: true,
          },
        },
      },
    });
    if (!updated) throw new NotFoundException('Membre introuvable dans cette équipe');
    return {
      ...updated,
      user: {
        ...updated.user,
        defaultCostRate: money(updated.user.defaultCostRate),
        defaultBillRate: money(updated.user.defaultBillRate),
      },
    };
  }

  async removeMember(
    orgId: string,
    teamId: string,
    userId: string,
    caller: CallerCtx,
  ) {
    await this.assertCanManageMembers(orgId, teamId, caller);
    const existing = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
    });
    if (!existing) throw new NotFoundException('Membre introuvable dans cette équipe');
    await this.prisma.teamMember.delete({
      where: { teamId_userId: { teamId, userId } },
    });
    this.reconcileTeam(orgId, teamId);
    // Auto-licence : si l'équipe l'est, le membre retiré perd son siège (sauf
    // s'il reste couvert par une autre équipe auto-licence).
    this.autoLicense(orgId, teamId, { revoke: [userId] }, caller);
    return { teamId, userId, removed: true };
  }

  private async assertTeam(orgId: string, teamId: string) {
    const t = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: orgId, deletedAt: null },
      select: { id: true, source: true, name: true, autoLicense: true },
    });
    if (!t) throw new NotFoundException('Équipe introuvable');
    return t;
  }

  private async assertUserInOrg(orgId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!u) throw new NotFoundException('Utilisateur introuvable dans cette organisation');
  }
}
