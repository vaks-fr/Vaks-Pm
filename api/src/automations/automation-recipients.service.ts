import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationRecipient } from './automation-actions.service';

const USER_SELECT = {
  id: true,
  name: true,
  email: true,
  preferredLanguage: true,
} as const;

/**
 * Résolution des destinataires des alertes d'automatisation. Toujours des
 * humains actifs (jamais d'agents — leur adresse `@agents.invalid` est de
 * toute façon filtrée au chokepoint `NotificationsService.enqueue`, ceinture
 * et bretelles ici). Lot 4 : les watchers de la tâche/du projet s'ajouteront
 * à ces résolutions.
 */
@Injectable()
export class AutomationRecipientsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Filtre commun : humain, actif, non supprimé. */
  private eligible() {
    return { kind: 'HUMAN' as const, status: 'ACTIVE' as const, deletedAt: null };
  }

  /** PROJECT_MANAGER du projet (même résolution que notifyOverEstimate). */
  async projectPMs(projectId: string): Promise<AutomationRecipient[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId, role: { key: 'PROJECT_MANAGER' }, user: this.eligible() },
      select: { user: { select: USER_SELECT } },
    });
    return members.map((m) => m.user).filter(Boolean);
  }

  /** Assignés de la tâche. */
  async assigneesOf(taskId: string): Promise<AutomationRecipient[]> {
    const rows = await this.prisma.taskAssignee.findMany({
      where: { taskId, user: this.eligible() },
      select: { user: { select: USER_SELECT } },
    });
    return rows.map((r) => r.user).filter(Boolean);
  }

  /**
   * Leads des équipes auxquelles `userId` appartient (jamais l'intéressé
   * lui-même, même s'il est lead de sa propre équipe). Fallback : les admins
   * globaux, sinon une alerte de charge sur un user sans équipe n'atteindrait
   * personne.
   */
  async teamLeadsOf(orgId: string, userId: string): Promise<AutomationRecipient[]> {
    const memberships = await this.prisma.teamMember.findMany({
      where: { userId },
      select: { teamId: true },
    });
    const teamIds = memberships.map((m) => m.teamId);
    if (teamIds.length) {
      const leads = await this.prisma.teamMember.findMany({
        where: { teamId: { in: teamIds }, isLead: true, userId: { not: userId }, user: this.eligible() },
        select: { user: { select: USER_SELECT } },
      });
      const out = leads.map((l) => l.user).filter(Boolean);
      if (out.length) return this.merge(out);
    }
    return this.orgAdmins(orgId);
  }

  /** Admins globaux actifs (destinataire de repli). */
  async orgAdmins(orgId: string): Promise<AutomationRecipient[]> {
    return this.prisma.user.findMany({
      where: { organizationId: orgId, isAdmin: true, ...this.eligible() },
      select: USER_SELECT,
    });
  }

  /**
   * Superviseurs d'un agent IA : son owner humain d'abord (il en est
   * responsable), à défaut les AI admins (`Membership.isAgentAdmin`) et les
   * admins globaux. Un agent a toujours un owner humain actif par construction
   * (`verify()` le refuse sinon) — le repli ne sert qu'aux cas de bascule.
   */
  async agentSupervisors(orgId: string, ownerId: string | null): Promise<AutomationRecipient[]> {
    if (ownerId) {
      const owner = await this.prisma.user.findFirst({
        where: { id: ownerId, organizationId: orgId, ...this.eligible() },
        select: USER_SELECT,
      });
      if (owner) return [owner];
    }
    const aiAdmins = await this.prisma.membership.findMany({
      where: { organizationId: orgId, isAgentAdmin: true, user: this.eligible() },
      select: { user: { select: USER_SELECT } },
    });
    const out = aiAdmins.map((m) => m.user).filter(Boolean);
    return out.length ? this.merge(out) : this.orgAdmins(orgId);
  }

  /**
   * Sponsors du projet (`ProjectMember.isSponsor`) — audience du feed sponsor
   * (annonces, jalons atteints, statut projet, opt-in jalon à risque / palier
   * budget qualitatif). Pas de fallback : aucun sponsor = pas d'envoi.
   */
  async projectSponsors(projectId: string): Promise<AutomationRecipient[]> {
    const members = await this.prisma.projectMember.findMany({
      where: { projectId, isSponsor: true, user: this.eligible() },
      select: { user: { select: USER_SELECT } },
    });
    return members.map((m) => m.user).filter(Boolean);
  }

  /**
   * Destinataires configurés sur un sous-statut (Custom Status) : users directs
   * + TOUS les membres des équipes listées (décision produit — « prévenir
   * l'équipe sécurité » = l'équipe entière), dédupliqués, acteur exclu (celui
   * qui déplace la carte sait déjà).
   */
  async subStatusTargets(
    orgId: string,
    notifyUserIds: string[],
    notifyTeamIds: string[],
    excludeUserId?: string | null,
  ): Promise<AutomationRecipient[]> {
    if (notifyUserIds.length === 0 && notifyTeamIds.length === 0) return [];
    const users = await this.prisma.user.findMany({
      where: {
        ...this.eligible(),
        memberships: { some: { organizationId: orgId } },
        OR: [
          ...(notifyUserIds.length ? [{ id: { in: notifyUserIds } }] : []),
          ...(notifyTeamIds.length
            ? [{ teamMembers: { some: { teamId: { in: notifyTeamIds }, team: { organizationId: orgId, deletedAt: null } } } }]
            : []),
        ],
      },
      select: USER_SELECT,
    });
    return users.filter((u) => u.id !== excludeUserId);
  }

  /**
   * Destinataires des alertes financières d'un projet : les PM du projet, à
   * défaut les admins globaux. On ne diffuse PAS à tous les porteurs de
   * `finance:view` — un montant de budget ne s'envoie qu'aux responsables du
   * projet.
   */
  async financeRecipients(orgId: string, projectId: string): Promise<AutomationRecipient[]> {
    const pms = await this.projectPMs(projectId);
    return pms.length ? pms : this.orgAdmins(orgId);
  }

  /** Dédup par id en préservant l'ordre (PMs d'abord, puis assignés, etc.). */
  merge(...groups: AutomationRecipient[][]): AutomationRecipient[] {
    const seen = new Set<string>();
    const out: AutomationRecipient[] = [];
    for (const group of groups) {
      for (const r of group) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        out.push(r);
      }
    }
    return out;
  }
}
