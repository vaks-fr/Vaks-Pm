import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Permission } from '@vaks-pm/shared';

@Injectable()
export class RbacService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Permissions effectives d'un utilisateur, en combinant son rôle
   * d'organisation et (si fourni) son rôle sur le projet ciblé.
   * Un admin global a toutes les permissions (géré en amont par le guard).
   */
  async getEffectivePermissions(
    userId: string,
    orgId: string,
    projectId?: string,
    teamId?: string,
  ): Promise<Set<Permission>> {
    const perms = new Set<Permission>();

    const membership = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, userId },
      include: { role: true },
    });
    if (membership) {
      for (const p of membership.role.permissions) perms.add(p as Permission);
      // Grant orthogonal « AI administrator » : empilable par-dessus n'importe
      // quel rôle org (un seul rôle org par user), accorde la gestion des agents
      // IA au niveau org. Même mécanisme que le grant lead d'équipe ci-dessous.
      if (membership.isAgentAdmin) perms.add('agent:manage' as Permission);
    }

    if (projectId) {
      const pm = await this.prisma.projectMember.findFirst({
        where: { projectId, userId },
        include: { role: true },
      });
      if (pm) {
        for (const p of pm.role.permissions) perms.add(p as Permission);
      }

      // Rôle hérité d'une équipe assignée au projet (ProjectTeam.roleId) : tout
      // membre d'une équipe affectée gagne le niveau d'accès posé sur le lien.
      // Additif avec un éventuel rôle direct ci-dessus (le plus permissif gagne).
      const teamLinks = await this.prisma.projectTeam.findMany({
        where: {
          projectId,
          roleId: { not: null },
          team: { members: { some: { userId } } },
        },
        include: { role: true },
      });
      for (const link of teamLinks) {
        if (link.role) for (const p of link.role.permissions) perms.add(p as Permission);
      }
    }

    // Grant team-scopé : le lead de l'équipe ciblée peut gérer l'équipe et ses
    // membres (mais PAS la créer/supprimer — réservé à team:create/team:delete).
    if (teamId) {
      const lead = await this.prisma.teamMember.findFirst({
        where: { teamId, userId, isLead: true, team: { organizationId: orgId, deletedAt: null } },
        select: { teamId: true },
      });
      if (lead) perms.add('team:manage_members' as Permission);
    }

    return perms;
  }
}
