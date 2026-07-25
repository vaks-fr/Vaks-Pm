import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, SkillRequestStatus, SkillRequestType } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import {
  CreateSkillRequestDto,
  UpdateSkillRequestStatusDto,
} from './dto/skill-request.dto';

export interface CallerCtx {
  userId: string;
  isAdmin: boolean;
}

/**
 * Demandeur sentinelle des demandes créées par le moteur d'automatisations.
 *
 * `SkillRequest.requestedById` est non-nullable mais **sans clé étrangère**
 * (référence scalaire, pattern maison) : cette valeur s'insère donc sans
 * contrainte. Délibérément **pas un UUID** — aucun `User.id` ne peut la
 * heurter, et un coup d'œil en base dit tout de suite d'où vient la ligne.
 *
 * Choix assumé : on ne met JAMAIS un humain (le PM par exemple) comme
 * demandeur d'une demande qu'il n'a pas faite — ce serait un mensonge dans
 * l'audit, et sa boîte « mes demandes » se remplirait de choses qu'il n'a pas
 * demandées. Le libellé est résolu à l'affichage (`enrich`).
 */
export const SYSTEM_REQUESTER_ID = 'system';

type Box = 'mine' | 'inbox' | 'all';

const TYPE_LABELS: Record<SkillRequestType, string> = {
  ASSIGN_SKILL: 'Assign skill to a member',
  TRAINING: 'Training / upskilling',
  EXTERNAL: 'External resource',
};

@Injectable()
export class SkillRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
  ) {}

  async create(orgId: string, caller: CallerCtx, dto: CreateSkillRequestDto) {
    if (!dto.skillId && !dto.proposedName) {
      throw new BadRequestException('Fournir un skillId ou un proposedName');
    }

    // Gating PM-only : seuls les Project Managers (du projet de la tâche ou
    // du projet ciblé), les Portfolio Managers et les admins peuvent
    // émettre une demande de compétence.
    const projectIdForGate = await this.resolveProjectIdForGate(orgId, dto);
    await this.assertCanRequest(orgId, caller, projectIdForGate);

    return this.createInternal(orgId, dto, caller.userId);
  }

  /**
   * Demande émise par le **moteur d'automatisations** (règle « compétence
   * manquante », mode auto). Même chemin que `create` — validations, notif aux
   * leads, webhook — mais **sans le gate PM** : l'appelant n'est pas un humain.
   *
   * Le demandeur est la sentinelle `SYSTEM_REQUESTER_ID` : `requestedById` est
   * non-nullable et sans FK, mais on n'y met JAMAIS un vrai humain — attribuer
   * à quelqu'un une demande qu'il n'a pas faite fausserait l'audit et la boîte
   * « mes demandes ». Le libellé est résolu à l'affichage (voir `enrich`).
   */
  async createFromAutomation(orgId: string, dto: CreateSkillRequestDto) {
    if (!dto.skillId && !dto.proposedName) {
      throw new BadRequestException('Fournir un skillId ou un proposedName');
    }
    return this.createInternal(orgId, dto, SYSTEM_REQUESTER_ID);
  }

  /** Corps commun post-gate : validations, création, notif+webhook. */
  private async createInternal(
    orgId: string,
    dto: CreateSkillRequestDto,
    requestedById: string,
  ) {
    // Équipe destinataire valide.
    const team = await this.prisma.team.findFirst({
      where: { id: dto.teamId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!team) throw new NotFoundException('Équipe introuvable');

    if (dto.skillId) {
      const skill = await this.prisma.skill.findFirst({
        where: { id: dto.skillId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      if (!skill) throw new NotFoundException('Skill introuvable');
    }
    if (dto.desiredLevel != null) {
      const maxLevel = await this.settings.getSkillsMaxLevel(orgId);
      if (dto.desiredLevel < 1 || dto.desiredLevel > maxLevel) {
        throw new BadRequestException(`desiredLevel doit être entre 1 et ${maxLevel}`);
      }
    }
    if (dto.projectId) await this.assertOrgEntity('project', orgId, dto.projectId);
    if (dto.taskId) await this.assertOrgEntity('task', orgId, dto.taskId);
    if (dto.targetUserId) await this.assertOrgEntity('user', orgId, dto.targetUserId);

    const created = await this.prisma.skillRequest.create({
      data: {
        organizationId: orgId,
        teamId: dto.teamId,
        requestedById,
        type: dto.type,
        skillId: dto.skillId ?? null,
        proposedName: dto.skillId ? null : (dto.proposedName ?? null),
        desiredLevel: dto.desiredLevel ?? null,
        projectId: dto.projectId ?? null,
        taskId: dto.taskId ?? null,
        targetUserId: dto.targetUserId ?? null,
        note: dto.note ?? null,
      },
    });
    const [enriched] = await this.enrich(orgId, [created]);
    // Best-effort, hors chemin critique : email aux leads de l'équipe + webhook.
    void this.dispatchCreated(orgId, enriched);
    return enriched;
  }

  /** Notifie les leads de l'équipe par email et émet le webhook `skill_request.created`. */
  private async dispatchCreated(orgId: string, r: any) {
    try {
      const leads = await this.prisma.teamMember.findMany({
        where: {
          teamId: r.teamId,
          isLead: true,
          user: { deletedAt: null, status: 'ACTIVE' },
        },
        select: { user: { select: { email: true, name: true, preferredLanguage: true } } },
      });
      const recipients = leads.map((l) => ({
        email: l.user.email,
        name: l.user.name,
        preferredLanguage: l.user.preferredLanguage,
      }));
      const skillName = r.skill?.name ?? r.proposedName ?? '—';
      await this.notifications.notifySkillRequest(orgId, recipients, {
        requesterName: r.requestedBy?.name ?? '—',
        teamName: r.team?.name ?? '—',
        typeLabel: TYPE_LABELS[r.type as SkillRequestType] ?? String(r.type),
        skillName,
        targetName: r.targetUser?.name ?? undefined,
        desiredLevel: r.desiredLevel ?? undefined,
        projectName: r.project?.name ?? undefined,
        note: r.note ?? undefined,
      });
      await this.webhooks.dispatch(orgId, 'skill_request.created', {
        id: r.id,
        type: r.type,
        status: r.status,
        team: r.team,
        skill: r.skill,
        proposedName: r.proposedName,
        desiredLevel: r.desiredLevel,
        requestedBy: r.requestedBy,
        targetUser: r.targetUser,
        project: r.project,
        task: r.task,
        note: r.note,
        createdAt: r.createdAt,
      }, { teamId: r.teamId, projectId: r.projectId ?? null });
    } catch {
      /* best-effort — ne bloque jamais la création */
    }
  }

  /**
   * Liste les demandes selon la « boîte » :
   *  - mine  : émises par l'appelant
   *  - inbox : pour les équipes dont l'appelant est lead (admin → toutes)
   *  - all   : admin only
   * Défaut : admin → all ; sinon union(mine, inbox).
   */
  async list(
    orgId: string,
    caller: CallerCtx,
    box: Box | undefined,
    status?: SkillRequestStatus,
  ) {
    const baseWhere: Prisma.SkillRequestWhereInput = {
      organizationId: orgId,
      ...(status ? { status } : {}),
    };

    const ledTeamIds = await this.ledTeamIds(orgId, caller.userId);

    let where: Prisma.SkillRequestWhereInput;
    if (box === 'all') {
      if (!caller.isAdmin) throw new ForbiddenException('Réservé aux admins');
      where = baseWhere;
    } else if (box === 'mine') {
      where = { ...baseWhere, requestedById: caller.userId };
    } else if (box === 'inbox') {
      where = caller.isAdmin
        ? baseWhere
        : { ...baseWhere, teamId: { in: ledTeamIds } };
    } else {
      // défaut
      where = caller.isAdmin
        ? baseWhere
        : {
            ...baseWhere,
            OR: [
              { requestedById: caller.userId },
              { teamId: { in: ledTeamIds } },
            ],
          };
    }

    const rows = await this.prisma.skillRequest.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
    return this.enrich(orgId, rows);
  }

  async updateStatus(
    orgId: string,
    caller: CallerCtx,
    id: string,
    dto: UpdateSkillRequestStatusDto,
  ) {
    const req = await this.prisma.skillRequest.findFirst({
      where: { id, organizationId: orgId },
    });
    if (!req) throw new NotFoundException('Demande introuvable');

    // Seul un admin ou un lead de l'équipe destinataire peut faire évoluer
    // le statut. Le demandeur peut annuler (REJECTED) sa propre demande.
    const canManage =
      caller.isAdmin ||
      (await this.isLeadOfTeam(req.teamId, caller.userId)) ||
      (req.requestedById === caller.userId &&
        dto.status === SkillRequestStatus.REJECTED);
    if (!canManage) {
      throw new ForbiddenException(
        "Seul un lead de l'équipe (ou un admin) peut traiter cette demande.",
      );
    }

    const terminal =
      dto.status === SkillRequestStatus.RESOLVED ||
      dto.status === SkillRequestStatus.REJECTED;
    const updated = await this.prisma.skillRequest.update({
      where: { id },
      data: {
        status: dto.status,
        ...(dto.note !== undefined ? { note: dto.note } : {}),
        resolvedById: terminal ? caller.userId : null,
        resolvedAt: terminal ? new Date() : null,
      },
    });
    const [enriched] = await this.enrich(orgId, [updated]);

    // Webhook lifecycle : .acknowledged / .resolved / .rejected
    const evMap: Record<SkillRequestStatus, string | null> = {
      [SkillRequestStatus.OPEN]: null,
      [SkillRequestStatus.ACK]: 'skill_request.acknowledged',
      [SkillRequestStatus.RESOLVED]: 'skill_request.resolved',
      [SkillRequestStatus.REJECTED]: 'skill_request.rejected',
    };
    const ev = evMap[dto.status];
    if (ev && req.status !== dto.status) {
      void this.webhooks
        .dispatch(orgId, ev as 'skill_request.acknowledged', enriched, {
          teamId: enriched.team?.id ?? null,
          projectId: enriched.project?.id ?? null,
        })
        .catch(() => { /* best-effort */ });
    }
    return enriched;
  }

  /** Compteurs des demandes émises par l'appelant (par statut). */
  async summaryForRequester(orgId: string, userId: string) {
    const rows = await this.prisma.skillRequest.groupBy({
      by: ['status'],
      where: { organizationId: orgId, requestedById: userId },
      _count: { _all: true },
    });
    const out: Record<string, number> = { OPEN: 0, ACK: 0, RESOLVED: 0, REJECTED: 0 };
    for (const r of rows) out[r.status] = r._count._all;
    out.pending = out.OPEN + out.ACK;
    return out;
  }

  /**
   * Cron de relance : pour chaque demande OPEN > `staleDays`, envoie un
   * email "rappel" aux leads de l'équipe et émet `skill_request.reminded`.
   * Une fois relancée, la demande est marquée comme rappelée pour ne pas
   * re-déclencher tant que rien ne change (anti-spam basique).
   */
  async sendReminders(orgId: string, staleDays = 5) {
    const threshold = new Date(Date.now() - staleDays * 86_400_000);
    const stale = await this.prisma.skillRequest.findMany({
      where: {
        organizationId: orgId,
        status: SkillRequestStatus.OPEN,
        createdAt: { lt: threshold },
        // Anti-doublon : updatedAt > createdAt = au moins une modif (relance déjà passée).
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    if (stale.length === 0) return { sent: 0 };

    const enriched = (await this.enrich(orgId, stale)) as Array<Record<string, any>>;
    let sent = 0;
    for (const r of enriched) {
      try {
        await this.dispatchReminder(orgId, r);
        // Bump updatedAt pour éviter de re-relancer immédiatement.
        await this.prisma.skillRequest.update({
          where: { id: r.id as string },
          data: { updatedAt: new Date() },
        });
        sent++;
      } catch {
        /* swallow */
      }
    }
    return { sent };
  }

  private async dispatchReminder(orgId: string, r: any) {
    const leads = await this.prisma.teamMember.findMany({
      where: {
        teamId: r.teamId,
        isLead: true,
        user: { deletedAt: null, status: 'ACTIVE' },
      },
      select: { user: { select: { email: true, name: true, preferredLanguage: true } } },
    });
    const recipients = leads.map((l) => ({ email: l.user.email, name: l.user.name, preferredLanguage: l.user.preferredLanguage }));
    const skillName = r.skill?.name ?? r.proposedName ?? '—';
    await this.notifications.notifySkillRequest(orgId, recipients, {
      requesterName: r.requestedBy?.name ?? '—',
      teamName: r.team?.name ?? '—',
      typeLabel: '[RAPPEL] ' + String(r.type),
      skillName,
      targetName: r.targetUser?.name ?? undefined,
      desiredLevel: r.desiredLevel ?? undefined,
      projectName: r.project?.name ?? undefined,
      note: r.note ?? undefined,
    });
    await this.webhooks.dispatch(orgId, 'skill_request.reminded', r, {
      teamId: r.teamId,
      projectId: r.projectId ?? null,
    });
  }

  // ---------- Gating PM ----------
  /**
   * Vrai si l'appelant a le droit d'émettre une demande de compétence :
   *  - admin global, OU
   *  - rôle org PORTFOLIO_MANAGER, OU
   *  - rôle projet PROJECT_MANAGER sur le projet ciblé (si fourni).
   */
  async canRequestForProject(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    projectId?: string | null,
  ): Promise<boolean> {
    if (isAdmin) return true;
    const m = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, userId },
      select: { role: { select: { key: true } } },
    });
    if (m?.role.key === 'PORTFOLIO_MANAGER') return true;
    if (!projectId) return false;
    const pm = await this.prisma.projectMember.findFirst({
      where: { projectId, userId },
      select: { role: { select: { key: true } } },
    });
    return pm?.role.key === 'PROJECT_MANAGER';
  }

  private async resolveProjectIdForGate(
    orgId: string,
    dto: CreateSkillRequestDto,
  ): Promise<string | null> {
    if (dto.projectId) return dto.projectId;
    if (dto.taskId) {
      const t = await this.prisma.task.findFirst({
        where: { id: dto.taskId, organizationId: orgId, deletedAt: null },
        select: { projectId: true },
      });
      return t?.projectId ?? null;
    }
    return null;
  }

  private async assertCanRequest(
    orgId: string,
    caller: CallerCtx,
    projectId: string | null,
  ) {
    const ok = await this.canRequestForProject(
      orgId,
      caller.userId,
      caller.isAdmin,
      projectId,
    );
    if (!ok) {
      throw new ForbiddenException(
        "Seul un Project Manager (du projet concerné), un Portfolio Manager ou un admin peut émettre une demande de compétence.",
      );
    }
  }

  // ---------- Helpers ----------
  private async ledTeamIds(orgId: string, userId: string): Promise<string[]> {
    const led = await this.prisma.teamMember.findMany({
      where: {
        userId,
        isLead: true,
        team: { organizationId: orgId, deletedAt: null },
      },
      select: { teamId: true },
    });
    return led.map((l) => l.teamId);
  }

  private async isLeadOfTeam(teamId: string, userId: string): Promise<boolean> {
    const m = await this.prisma.teamMember.findUnique({
      where: { teamId_userId: { teamId, userId } },
      select: { isLead: true },
    });
    return !!m?.isLead;
  }

  private async assertOrgEntity(
    kind: 'project' | 'task' | 'user',
    orgId: string,
    id: string,
  ) {
    const where = { id, organizationId: orgId, deletedAt: null };
    const found =
      kind === 'project'
        ? await this.prisma.project.findFirst({ where, select: { id: true } })
        : kind === 'task'
          ? await this.prisma.task.findFirst({ where, select: { id: true } })
          : await this.prisma.user.findFirst({ where, select: { id: true } });
    if (!found) throw new NotFoundException(`${kind} introuvable`);
  }

  /** Résout les libellés (équipe, demandeur, cible, skill, projet, tâche). */
  private async enrich(orgId: string, rows: { [k: string]: any }[]) {
    if (rows.length === 0) return [];
    const ids = (sel: (r: any) => string | null) =>
      Array.from(new Set(rows.map(sel).filter(Boolean))) as string[];

    const [teams, users, skills, projects, tasks] = await Promise.all([
      this.prisma.team.findMany({
        where: { id: { in: ids((r) => r.teamId) } },
        select: { id: true, name: true, color: true },
      }),
      this.prisma.user.findMany({
        where: {
          id: { in: ids((r) => r.requestedById).concat(ids((r) => r.targetUserId), ids((r) => r.resolvedById)) },
        },
        select: { id: true, name: true, email: true },
      }),
      this.prisma.skill.findMany({
        where: { id: { in: ids((r) => r.skillId) } },
        select: { id: true, name: true, color: true, category: true },
      }),
      this.prisma.project.findMany({
        where: { id: { in: ids((r) => r.projectId) } },
        select: { id: true, name: true },
      }),
      this.prisma.task.findMany({
        where: { id: { in: ids((r) => r.taskId) } },
        select: { id: true, title: true, number: true },
      }),
    ]);
    const byId = <T extends { id: string }>(arr: T[]) =>
      new Map(arr.map((x) => [x.id, x]));
    const tM = byId(teams);
    const uM = byId(users);
    const sM = byId(skills);
    const pM = byId(projects);
    const kM = byId(tasks);

    return rows.map((r) => ({
      ...r,
      team: tM.get(r.teamId) ?? null,
      // Demande émise par le moteur : l'id sentinelle ne résout aucun user
      // (c'est voulu) — on rend un pseudo-acteur explicite plutôt qu'un `null`
      // qui afficherait un demandeur vide.
      requestedBy:
        r.requestedById === SYSTEM_REQUESTER_ID
          ? { id: SYSTEM_REQUESTER_ID, name: 'Automatisation', email: '' }
          : (uM.get(r.requestedById) ?? null),
      targetUser: r.targetUserId ? (uM.get(r.targetUserId) ?? null) : null,
      resolvedBy: r.resolvedById ? (uM.get(r.resolvedById) ?? null) : null,
      skill: r.skillId ? (sM.get(r.skillId) ?? null) : null,
      project: r.projectId ? (pM.get(r.projectId) ?? null) : null,
      task: r.taskId ? (kM.get(r.taskId) ?? null) : null,
    }));
  }
}
