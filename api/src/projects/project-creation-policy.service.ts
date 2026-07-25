import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';

export type ProjectKind = 'billable' | 'nonBillable';

export interface CreationCapabilities {
  canBillable: boolean;
  canNonBillable: boolean;
}

/**
 * Résout qui peut créer un projet facturable / non-facturable.
 *
 * Modèle (org policy = plafond) :
 *   1. PORTFOLIO_MANAGER : peut TOUJOURS créer un projet facturable
 *      (bypass policy). Pour non-facturable, suit la policy comme tout le monde.
 *   2. Mode 'everyone'   : OK pour tout user authentifié.
 *   3. Mode 'roles'      : OK si le rôle org du user est dans roleKeys[].
 *   4. Mode 'teams'      : OK si user est membre d'une équipe de teamIds[]
 *                          ET le tag équipe/user autorise la création de ce type :
 *                          - billable     : `Team.canCreateBillableProject`* ¹
 *                          - nonBillable  : override `User.canCreateNonBillableProject`
 *                                           (null = hérite) > `Team.canCreateNonBillableProject`
 *
 * ¹ Le user n'a demandé l'overrride équipe/utilisateur QUE pour non-billable
 *   (cf. discussion). Pour billable en mode 'teams', on retient simplement
 *   « membre d'une des teamIds » sans tag additionnel.
 */
@Injectable()
export class ProjectCreationPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  async getCapabilities(orgId: string, userId: string, isAdmin: boolean): Promise<CreationCapabilities> {
    const [canBillable, canNonBillable] = await Promise.all([
      this.canCreate(orgId, userId, isAdmin, 'billable'),
      this.canCreate(orgId, userId, isAdmin, 'nonBillable'),
    ]);
    return { canBillable, canNonBillable };
  }

  async assertCanCreate(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    kind: ProjectKind,
  ): Promise<void> {
    const ok = await this.canCreate(orgId, userId, isAdmin, kind);
    if (!ok) {
      throw new ForbiddenException(
        kind === 'billable'
          ? "Vous n'êtes pas autorisé à créer un projet facturable"
          : "Vous n'êtes pas autorisé à créer un projet non-facturable",
      );
    }
  }

  async canCreate(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    kind: ProjectKind,
  ): Promise<boolean> {
    if (isAdmin) return true;

    const membership = await this.prisma.membership.findFirst({
      where: { organizationId: orgId, userId },
      include: { role: { select: { key: true } } },
    });
    const roleKey = membership?.role.key;

    // Bypass Portfolio Manager pour les projets facturables.
    if (kind === 'billable' && roleKey === 'PORTFOLIO_MANAGER') return true;

    const policy = await this.settings.getProjectCreationPolicy(orgId, kind);

    if (policy.mode === 'everyone') return true;

    if (policy.mode === 'roles') {
      return !!roleKey && policy.roleKeys.includes(roleKey);
    }

    // mode === 'teams'
    if (policy.teamIds.length === 0) return false;
    const teamMembership = await this.prisma.teamMember.findFirst({
      where: { userId, teamId: { in: policy.teamIds } },
      select: { teamId: true, team: { select: { canCreateNonBillableProject: true } } },
    });
    if (!teamMembership) return false;

    if (kind === 'billable') {
      // L'appartenance à une équipe autorisée suffit (pas de tag billable
      // au niveau team/user dans cette version — cf. choix produit).
      return true;
    }

    // kind === 'nonBillable' : override user > tag équipe.
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { canCreateNonBillableProject: true },
    });
    if (user?.canCreateNonBillableProject !== null && user?.canCreateNonBillableProject !== undefined) {
      return user.canCreateNonBillableProject;
    }
    // Hérite : true si au moins une équipe parmi les teamMemberships du user
    // (dans le set teamIds) a le flag true.
    const ledTeams = await this.prisma.teamMember.findMany({
      where: { userId, teamId: { in: policy.teamIds } },
      select: { team: { select: { canCreateNonBillableProject: true } } },
    });
    return ledTeams.some((tm) => tm.team.canCreateNonBillableProject);
  }
}
