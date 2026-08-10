import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { Prisma, ProjectStatus, TaskStatus, ProjectDocumentKind } from '@db';
import { isBriefEmpty, normalizeAgentBrief } from '../agents/context/agent-brief';
import {
  documentAiSource,
  effectiveAiFolderIds,
  isDocumentAiContext,
} from './document-context';
import {
  defaultContextFolderId,
  findDuplicateTextDoc,
  sanitizeDocName,
  type OnDuplicate,
} from './text-document';

/**
 * Champs financiers sensibles du projet (budget + taux par défaut). Ils ne
 * doivent JAMAIS transiter par les lectures projet ordinaires (`project:view`)
 * — uniquement par le module `finance/` gardé par `finance:view`. On les `omit`
 * donc systématiquement des requêtes Prisma de lecture/écriture projet, ce qui
 * garantit l'absence de fuite quel que soit l'appelant (et dans les payloads
 * webhook). C'est un fail-safe au niveau requête, indépendant du DTO client.
 */
const PROJECT_FINANCE_OMIT = {
  budgetAmount: true,
  defaultCostRate: true,
  defaultBillRate: true,
} as const;

/**
 * Conversion d'un P2002 (violation d'unicité) sur la contrainte
 * `(organizationId, clientId, name)` en 409 explicite. Re-jette toute autre
 * erreur Prisma intacte.
 */
function rethrowProjectNameConflict(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
    const target = (e.meta?.target ?? []) as string[] | string;
    const fields = Array.isArray(target) ? target : [String(target)];
    if (fields.includes('name') || fields.includes('clientId')) {
      throw new ConflictException(
        'Un projet portant ce nom existe déjà pour ce client. Choisissez un autre nom ou un autre client.',
      );
    }
  }
  throw e as Error;
}

/**
 * Normalise la liste des dépôts CI autorisés d'un projet (onglet IA) : trim,
 * retrait des vides, déduplication. Sert au binding `ci_signed` (finding #3).
 */
function normalizeCiRepos(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map((r) => String(r ?? '').trim()).filter(Boolean))];
}
import { RbacService } from '../rbac/rbac.service';
import { ProjectCreationPolicyService } from './project-creation-policy.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { buildCharterDocx, fillCharterTemplate } from './charter-docx';
import { S3Service } from '../storage/s3.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { SkillsService } from '../skills/skills.service';
import { EventsGateway } from '../realtime/events.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { auditDiff } from '../audit-logs/audit-sanitize';
import { TeamsProvisioningService } from '../teams-provisioning/teams-provisioning.service';
import { SlackProvisioningService } from '../slack-provisioning/slack-provisioning.service';
import { GoogleChatProvisioningService } from '../google-chat-provisioning/google-chat-provisioning.service';
import { GoogleDriveProvisioningService } from '../google-drive-provisioning/google-drive-provisioning.service';

/**
 * Deux machines à états selon `Project.billable` :
 *
 *  - facturable     : DRAFT → CHARTER_REVIEW → ACTIVE → COMPLETED → ARCHIVED
 *                     Le gating « charter signé requis » est appliqué dans
 *                     `update()` au moment du passage en ACTIVE.
 *
 *  - non-facturable : DRAFT → ACTIVE → COMPLETED → ARCHIVED
 *                     Pas de phase CHARTER_REVIEW, pas de charter signé requis.
 *                     Le charter (métadonnées + docx) reste disponible mais
 *                     purement informatif.
 *
 * Les transitions COMPLETED ↔ ACTIVE et ARCHIVED → ACTIVE sont partagées.
 */
const BILLABLE_STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: [ProjectStatus.OFFER_SENT, ProjectStatus.ARCHIVED],
  // Les arêtes de décision OFFER_SENT → {DRAFT, CHARTER_REVIEW} passent par les
  // endpoints dédiés (accept/refuse) qui captent le compteur et la raison ;
  // seul ARCHIVED (abandon) reste accessible par le PATCH générique de statut.
  OFFER_SENT: [ProjectStatus.DRAFT, ProjectStatus.CHARTER_REVIEW, ProjectStatus.ARCHIVED],
  CHARTER_REVIEW: [ProjectStatus.DRAFT, ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED],
  ACTIVE: [ProjectStatus.COMPLETED, ProjectStatus.ARCHIVED],
  COMPLETED: [ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED],
  ARCHIVED: [ProjectStatus.ACTIVE],
};

const NON_BILLABLE_STATUS_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  DRAFT: [ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED],
  // Étape offre non utilisée en non-facturable : si jamais un projet s'y
  // trouvait (flip billable), on le laisse revenir en DRAFT ou avancer.
  OFFER_SENT: [ProjectStatus.DRAFT, ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED],
  CHARTER_REVIEW: [ProjectStatus.DRAFT, ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED],
  ACTIVE: [ProjectStatus.COMPLETED, ProjectStatus.ARCHIVED],
  COMPLETED: [ProjectStatus.ACTIVE, ProjectStatus.ARCHIVED],
  ARCHIVED: [ProjectStatus.ACTIVE],
};

/**
 * Arêtes de transition « décision d'offre » réservées aux endpoints dédiés
 * (`/offer/accept`, `/offer/refuse`). Le PATCH générique de statut les refuse
 * pour forcer le passage par le chemin qui incrémente `offerRefusalCount` et
 * journalise l'événement.
 */
const OFFER_DECISION_TARGETS = new Set<ProjectStatus>([
  ProjectStatus.CHARTER_REVIEW,
  ProjectStatus.DRAFT,
]);

function transitionsFor(billable: boolean) {
  return billable ? BILLABLE_STATUS_TRANSITIONS : NON_BILLABLE_STATUS_TRANSITIONS;
}

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rbac: RbacService,
    private readonly s3: S3Service,
    private readonly creationPolicy: ProjectCreationPolicyService,
    private readonly webhooks: WebhooksService,
    private readonly skills: SkillsService,
    private readonly events: EventsGateway,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditLogService,
    private readonly teamsProvisioning: TeamsProvisioningService,
    private readonly slackProvisioning: SlackProvisioningService,
    private readonly googleChatProvisioning: GoogleChatProvisioningService,
    private readonly googleDriveProvisioning: GoogleDriveProvisioningService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Hooks d'automatisation en lazy (même pattern que TasksService) : un import
   * de module direct ferait un cycle Projects ↔ Automations (via Workload/
   * Finance). `strict:false` = résolution globale, null si absent.
   */
  private automationHooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Transitions de statut légales depuis l'état courant — exposées dans le
   * DTO (`allowedTransitions`) pour que l'UI grise les statuts inatteignables
   * au lieu de laisser le serveur rejeter au save.
   */
  private allowedTransitionsOf(p: { status: ProjectStatus; billable: boolean }): ProjectStatus[] {
    return transitionsFor(p.billable)[p.status] ?? [];
  }

  /**
   * Notifie la room org qu'un projet a changé. Payload minimal (id seul) :
   * les clients refetchent `GET /projects`, qui ré-applique la visibilité —
   * pas de fuite de nom/détail de draft vers les non-membres.
   */
  /** Best-effort : ré-synchronise la membership de l'équipe Teams du projet
   *  (si provisionnée) après un changement de membres/équipes. Ne casse jamais
   *  la mutation appelante. */
  private reconcileTeams(orgId: string, projectId: string) {
    void this.teamsProvisioning
      .enqueueReconcileForProject(orgId, projectId)
      .catch(() => { /* swallow — best-effort */ });
  }

  private notifyProjectsChanged(orgId: string, event: string, projectId: string) {
    try {
      this.events.emitToOrg(orgId, event, { id: projectId });
    } catch {
      /* best-effort — le WS ne doit jamais casser une mutation */
    }
  }

  /**
   * Liste les projets visibles par l'utilisateur :
   *  - admin global (isAdmin) OU rôle org avec `project:view_all` → tout l'org
   *  - sinon → projets dont il est membre direct (ProjectMember)
   *           OU projets assignés à une de ses équipes (ProjectTeam ∩ TeamMember)
   */
  async findAll(
    orgId: string,
    userId: string,
    isAdmin: boolean,
    opts: { scope?: 'mine' | 'all'; q?: string } = {},
  ) {
    // `kind: STANDARD` partout : les projets EXTERNAL (conteneurs de tickets
    // d'outils externes, timesheet only) n'apparaissent JAMAIS dans les
    // listings/menus/pickers — pour personne, admin compris. Ils restent
    // lisibles individuellement (timesheet, time entries) via la jointure.
    //
    // Les projets DRAFT et CHARTER_REVIEW ne sont visibles qu'aux membres
    // directs (le portfolio manager qui les a créés, et tout PM/contributeur
    // qu'il a explicitement ajouté). Les users qui ne voient un projet que
    // par leur équipe ne doivent pas voir les drafts d'autrui.
    // `scope=mine` forces the "projects I'm involved in" filter even for
    // privileged users (admin / view_all) — the default panel view. Without it,
    // privileged users see every project in the org.
    const canSeeAll =
      opts.scope !== 'mine' && (isAdmin || (await this.hasViewAll(userId, orgId)));
    const accessClause: Prisma.ProjectWhereInput = canSeeAll
      ? {}
      : {
          OR: [
            { members: { some: { userId } } },
            {
              AND: [
                { status: { notIn: [ProjectStatus.DRAFT, ProjectStatus.CHARTER_REVIEW] } },
                { teams: { some: { team: { members: { some: { userId } } } } } },
              ],
            },
          ],
        };
    // Filtre texte optionnel (nom OU clé, contains insensible casse) — pour
    // résoudre un projet nommé (tool MCP `vaks_project_status`) sans lister
    // tout le portefeuille. Combiné via AND avec l'accès (jamais un second OR
    // au même niveau, qui écraserait silencieusement le OR d'accès ci-dessus
    // — fuite ou sur-restriction selon lequel des deux gagne).
    const q = opts.q?.trim();
    const where: Prisma.ProjectWhereInput = {
      organizationId: orgId,
      deletedAt: null,
      kind: 'STANDARD',
      ...(q
        ? {
            AND: [
              accessClause,
              {
                OR: [
                  { key: { contains: q, mode: 'insensitive' } },
                  { name: { contains: q, mode: 'insensitive' } },
                ],
              },
            ],
          }
        : accessClause),
    };
    const projects = await this.prisma.project.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      omit: PROJECT_FINANCE_OMIT,
      include: { client: { select: { id: true, name: true, company: true } } },
    });

    // Enrichissement pour les cartes du panel : avancement (tâches done/total)
    // et Project Managers. 2 requêtes groupées quelle que soit la taille de la
    // liste — pas de N+1.
    const ids = projects.map((p) => p.id);
    if (ids.length === 0) return projects;
    const [taskGroups, pms] = await Promise.all([
      this.prisma.task.groupBy({
        by: ['projectId', 'status'],
        where: { projectId: { in: ids }, deletedAt: null },
        _count: { _all: true },
      }),
      this.prisma.projectMember.findMany({
        where: { projectId: { in: ids }, role: { key: 'PROJECT_MANAGER' } },
        select: { projectId: true, user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const counts = new Map<string, { total: number; done: number }>();
    for (const g of taskGroups) {
      const c = counts.get(g.projectId) ?? { total: 0, done: 0 };
      c.total += g._count._all;
      if (g.status === TaskStatus.DONE) c.done += g._count._all;
      counts.set(g.projectId, c);
    }
    const managers = new Map<string, { id: string; name: string }[]>();
    for (const m of pms) {
      const list = managers.get(m.projectId) ?? [];
      list.push(m.user);
      managers.set(m.projectId, list);
    }
    return projects.map((p) => ({
      ...p,
      taskCounts: counts.get(p.id) ?? { total: 0, done: 0 },
      managers: managers.get(p.id) ?? [],
      allowedTransitions: this.allowedTransitionsOf(p),
    }));
  }

  async findOne(orgId: string, id: string, userId?: string, isAdmin = false) {
    const project = await this.prisma.project.findFirst({
      where: { id, organizationId: orgId, deletedAt: null },
      omit: PROJECT_FINANCE_OMIT,
      include: {
        boards: { include: { columns: { orderBy: { order: 'asc' } } } },
        client: { select: { id: true, name: true, company: true } },
      },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (userId && !isAdmin) {
      const canSeeAll = await this.hasViewAll(userId, orgId);
      if (!canSeeAll) {
        const [directMember, viaTeam] = await Promise.all([
          this.prisma.projectMember.findFirst({
            where: { projectId: id, userId },
            select: { projectId: true },
          }),
          this.prisma.projectTeam.findFirst({
            where: { projectId: id, team: { members: { some: { userId } } } },
            select: { projectId: true },
          }),
        ]);
        if (!directMember && !viaTeam) throw new NotFoundException('Projet introuvable');
      }
    }
    return {
      ...project,
      agentCostBudget: project.agentCostBudget != null ? Number(project.agentCostBudget) : null,
      allowedTransitions: this.allowedTransitionsOf(project),
    };
  }

  private async hasViewAll(userId: string, orgId: string): Promise<boolean> {
    const perms = await this.rbac.getEffectivePermissions(userId, orgId);
    return perms.has('project:view_all');
  }

  // ----------------------------------------------------------------
  // Project Managers — endpoints réservés à `project:assign_managers`
  // ----------------------------------------------------------------

  /** Liste les membres d'un projet (avec le rôle), pour l'écran d'admin. */
  async listMembers(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    return this.prisma.projectMember.findMany({
      where: { projectId },
      include: {
        user: { select: { id: true, name: true, email: true, status: true } },
        role: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Ajoute (ou re-désigne) un utilisateur comme PROJECT_MANAGER. */
  async addManager(orgId: string, projectId: string, userId: string) {
    await this.assertProject(orgId, projectId);
    await this.assertUserInOrg(orgId, userId);
    const pmRole = await this.prisma.role.findFirstOrThrow({
      where: { organizationId: orgId, key: 'PROJECT_MANAGER' },
    });
    const r = await this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { roleId: pmRole.id },
      create: { projectId, userId, roleId: pmRole.id },
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: { select: { id: true, key: true, name: true } },
      },
    });
    this.reconcileTeams(orgId, projectId);
    return r;
  }

  /**
   * Upsert d'un membre de projet avec un rôle project-scoped quelconque
   * (PROJECT_MANAGER / CONTRIBUTOR / VIEWER / GUEST). Refuse les rôles
   * org-scopés — ceux-là vivent dans `Membership`, pas dans `ProjectMember`.
   */
  async upsertMember(
    orgId: string,
    projectId: string,
    userId: string,
    roleKey: string,
    isSponsor?: boolean,
  ) {
    await this.assertProject(orgId, projectId);
    await this.assertUserInOrg(orgId, userId);
    const role = await this.prisma.role.findUnique({
      where: { organizationId_key: { organizationId: orgId, key: roleKey } },
    });
    if (!role) throw new NotFoundException(`Rôle ${roleKey} introuvable`);
    if (role.scope !== 'PROJECT') {
      throw new BadRequestException(`${roleKey} n'est pas un rôle de projet`);
    }
    const r = await this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      update: { roleId: role.id, ...(isSponsor !== undefined ? { isSponsor } : {}) },
      create: { projectId, userId, roleId: role.id, isSponsor: isSponsor ?? false },
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: { select: { id: true, key: true, name: true } },
      },
    });
    this.reconcileTeams(orgId, projectId);
    return r;
  }

  /** Flags orthogonaux au rôle d'un membre existant (aujourd'hui : isSponsor). */
  async updateMember(
    orgId: string,
    projectId: string,
    userId: string,
    dto: { isSponsor?: boolean },
  ) {
    await this.assertProject(orgId, projectId);
    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!existing) throw new NotFoundException('Membre introuvable sur ce projet');
    return this.prisma.projectMember.update({
      where: { projectId_userId: { projectId, userId } },
      data: { ...(dto.isSponsor !== undefined ? { isSponsor: dto.isSponsor } : {}) },
      include: {
        user: { select: { id: true, name: true, email: true } },
        role: { select: { id: true, key: true, name: true } },
      },
    });
  }

  /** Retire un membre quelconque d'un projet. */
  async removeMember(orgId: string, projectId: string, userId: string) {
    await this.assertProject(orgId, projectId);
    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!existing) throw new NotFoundException('Membre introuvable sur ce projet');
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    this.reconcileTeams(orgId, projectId);
    return { projectId, userId, removed: true };
  }

  /** Retire un PROJECT_MANAGER (supprime sa ProjectMember). */
  async removeManager(orgId: string, projectId: string, userId: string) {
    await this.assertProject(orgId, projectId);
    const existing = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      include: { role: { select: { key: true } } },
    });
    if (!existing) throw new NotFoundException('Membre introuvable sur ce projet');
    if (existing.role.key !== 'PROJECT_MANAGER') {
      // On évite de supprimer un non-PM par erreur via cette route.
      throw new NotFoundException("Cet utilisateur n'est pas Project Manager");
    }
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    this.reconcileTeams(orgId, projectId);
    return { projectId, userId, removed: true };
  }

  // ----------------------------------------------------------------
  // Project Teams (visibilité par équipe)
  // ----------------------------------------------------------------

  async listTeams(orgId: string, projectId: string) {
    await this.assertProject(orgId, projectId);
    return this.prisma.projectTeam.findMany({
      where: { projectId },
      include: {
        team: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, email: true } } },
            },
          },
        },
        role: { select: { id: true, key: true, name: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Résout un rôle **project-scopé** par sa clé dans l'org. Refuse les rôles
   * org-scopés (ils vivent dans `Membership`, pas sur un lien projet).
   */
  private async resolveProjectRole(orgId: string, roleKey: string) {
    const role = await this.prisma.role.findUnique({
      where: { organizationId_key: { organizationId: orgId, key: roleKey } },
    });
    if (!role) throw new NotFoundException(`Rôle ${roleKey} introuvable`);
    if (role.scope !== 'PROJECT') {
      throw new BadRequestException(`${roleKey} n'est pas un rôle de projet`);
    }
    return role;
  }

  async addTeam(orgId: string, projectId: string, teamId: string, roleKey = 'CONTRIBUTOR') {
    await this.assertProject(orgId, projectId);
    const team = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!team) throw new NotFoundException('Équipe introuvable');
    const role = await this.resolveProjectRole(orgId, roleKey);
    const r = await this.prisma.projectTeam.upsert({
      where: { projectId_teamId: { projectId, teamId } },
      // Réassigner une équipe déjà liée ne réinitialise PAS son niveau d'accès.
      update: {},
      create: { projectId, teamId, roleId: role.id },
      include: {
        team: { select: { id: true, name: true, color: true } },
        role: { select: { id: true, key: true, name: true } },
      },
    });
    this.reconcileTeams(orgId, projectId);
    return r;
  }

  /** Change le niveau d'accès project-scopé d'une équipe assignée. */
  async setTeamRole(orgId: string, projectId: string, teamId: string, roleKey: string) {
    await this.assertProject(orgId, projectId);
    const existing = await this.prisma.projectTeam.findUnique({
      where: { projectId_teamId: { projectId, teamId } },
      select: { projectId: true },
    });
    if (!existing) throw new NotFoundException('Équipe non assignée à ce projet');
    const role = await this.resolveProjectRole(orgId, roleKey);
    return this.prisma.projectTeam.update({
      where: { projectId_teamId: { projectId, teamId } },
      data: { roleId: role.id },
      include: {
        team: { select: { id: true, name: true, color: true } },
        role: { select: { id: true, key: true, name: true } },
      },
    });
  }

  /**
   * Détache une équipe du projet. Avec `removeMembers`, retire aussi — dans la
   * MÊME transaction — les membres directs du projet qui font partie du roster
   * de cette équipe (ils n'étaient là que par elle). Atomique : pas d'état
   * intermédiaire « membres retirés mais équipe encore assignée » en cas
   * d'échec à mi-parcours.
   */
  async removeTeam(orgId: string, projectId: string, teamId: string, removeMembers = false) {
    await this.assertProject(orgId, projectId);
    const membersRemoved = await this.prisma.$transaction(async (tx) => {
      let n = 0;
      if (removeMembers) {
        const roster = await tx.teamMember.findMany({
          where: { teamId },
          select: { userId: true },
        });
        const userIds = roster.map((m) => m.userId);
        if (userIds.length > 0) {
          const res = await tx.projectMember.deleteMany({
            where: { projectId, userId: { in: userIds } },
          });
          n = res.count;
        }
      }
      await tx.projectTeam.deleteMany({ where: { projectId, teamId } });
      return n;
    });
    this.reconcileTeams(orgId, projectId);
    return { projectId, teamId, removed: true, membersRemoved };
  }

  /**
   * Candidats à devenir membre direct du projet : union des membres des
   * équipes assignées. Si aucune équipe n'est assignée, on retombe sur
   * l'ensemble des utilisateurs de l'org (comportement legacy).
   * Exclut les users déjà membres directs du projet.
   */
  async listCandidates(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true, agentsEnabled: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    // Agents candidats seulement si le projet les autorise (case « Agents IA »).
    const includeAgents = project.agentsEnabled;
    const teamLinks = await this.prisma.projectTeam.findMany({
      where: { projectId },
      select: { teamId: true },
    });
    const teamIds = teamLinks.map((t) => t.teamId);
    const existingMembers = await this.prisma.projectMember.findMany({
      where: { projectId },
      select: { userId: true },
    });
    const excludeIds = new Set(existingMembers.map((m) => m.userId));

    const baseSelect = { id: true, name: true, email: true, kind: true } as const;
    if (teamIds.length === 0) {
      // Pas d'équipe assignée → tous les users de l'org sont éligibles
      // (sinon il deviendrait impossible d'ajouter quelqu'un sur un projet
      // tant qu'aucune équipe n'est définie).
      const all = await this.prisma.user.findMany({
        where: {
          organizationId: orgId, deletedAt: null, status: 'ACTIVE',
          ...(includeAgents ? {} : { kind: 'HUMAN' as const }),
        },
        select: baseSelect,
        orderBy: { name: 'asc' },
      });
      return all.filter((u) => !excludeIds.has(u.id));
    }
    const members = await this.prisma.teamMember.findMany({
      where: { teamId: { in: teamIds } },
      include: { user: { select: baseSelect } },
    });
    // Dédup par userId (un user peut être dans plusieurs équipes).
    const seen = new Set<string>();
    const out: { id: string; name: string; email: string; kind?: string }[] = [];
    for (const m of members) {
      if (excludeIds.has(m.userId) || seen.has(m.userId)) continue;
      seen.add(m.userId);
      out.push(m.user);
    }
    // Agents IA : candidats à une affectation projet EXPLICITE, mais SEULEMENT
    // si le projet les autorise (case « Agents IA »). Ressource org-level → hors
    // team-scoping. Badge « Agent » côté UI.
    if (includeAgents) {
      const agents = await this.prisma.user.findMany({
        where: { organizationId: orgId, deletedAt: null, status: 'ACTIVE', kind: 'AGENT' },
        select: baseSelect,
        orderBy: { name: 'asc' },
      });
      for (const a of agents) {
        if (excludeIds.has(a.id) || seen.has(a.id)) continue;
        seen.add(a.id);
        out.push(a);
      }
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  private async assertProject(orgId: string, projectId: string) {
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!p) throw new NotFoundException('Projet introuvable');
  }

  private async assertUserInOrg(orgId: string, userId: string) {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!u) throw new NotFoundException('Utilisateur introuvable');
  }

  /**
   * Crée un projet en DRAFT (phase d'initiation). Le créateur est ajouté
   * comme Project Manager pour qu'il puisse éditer le charter. Pas de
   * board Kanban à ce stade — il est créé automatiquement quand le projet
   * passe à ACTIVE (après upload du charter signé). Un `ProjectCharter`
   * vide est initialisé pour que le wizard puisse écrire incrémentalement.
   *
   * Scoping TEAM_MANAGER : un créateur qui n'a pas `project:view_all`
   * (typiquement un Team Manager) doit fournir ≥1 `teamIds`, et chaque
   * équipe listée doit faire partie de celles qu'il pilote (`isLead`).
   * Ça évite qu'il rattache son projet à une équipe arbitraire (et donc
   * étende sa propre visibilité) ou qu'il crée un projet orphelin qu'il
   * serait ensuite seul à voir.
   */
  /**
   * Un projet agent-activé doit porter un brief non vide — structuré
   * (`agentBrief`) **ou** en notes libres (`agentContext`). L'un OU l'autre
   * suffit : les projets antérieurs à la refonte n'ont que les notes libres, et
   * on ne les casse pas ; les nouveaux peuvent ne remplir que le formulaire.
   */
  private assertAgentContext(
    agentsEnabled: boolean,
    agentContext: string | null,
    agentBrief: unknown = null,
  ): void {
    if (agentsEnabled && !agentContext && isBriefEmpty(agentBrief)) {
      throw new BadRequestException(
        "Un projet ouvert aux agents IA doit définir un contexte agent (brief). " +
          'Renseignez-le avant d\'activer les agents.',
      );
    }
  }

  async create(orgId: string, userId: string, isAdmin: boolean, dto: CreateProjectDto) {
    // billable par défaut (rétro-compat). La policy org gate qui peut créer
    // quel type — appliquée AVANT toute lecture/écriture pour court-circuiter
    // en 403 propre.
    const billable = dto.billable ?? true;
    await this.creationPolicy.assertCanCreate(
      orgId,
      userId,
      isAdmin,
      billable ? 'billable' : 'nonBillable',
    );

    // Contexte agents : un projet agent-activé DOIT porter un brief (le PM le
    // rédige — cf. AGENTS_ARCHITECTURE.md § Contexte de travail des agents).
    const agentsEnabled = dto.agentsEnabled ?? false;
    const agentContext = dto.agentContext?.trim() || null;
    const agentGuardrails = dto.agentGuardrails?.trim() || null;
    const agentBrief = normalizeAgentBrief(dto.agentBrief);
    const ciRepos = normalizeCiRepos(dto.ciRepos);
    this.assertAgentContext(agentsEnabled, agentContext, agentBrief);

    const pmRole = await this.prisma.role.findFirstOrThrow({
      where: { organizationId: orgId, key: 'PROJECT_MANAGER' },
    });

    if (dto.clientId) {
      const c = await this.prisma.client.findFirst({
        where: { id: dto.clientId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      if (!c) throw new NotFoundException('Client introuvable');
    } else {
      // Pas de client : Postgres laisserait passer plusieurs NULL+même nom
      // (NULLs distincts dans une unique). Garde explicite côté service pour
      // que les projets internes (sans client) restent uniques par nom.
      const dup = await this.prisma.project.findFirst({
        where: { organizationId: orgId, clientId: null, name: dto.name, deletedAt: null },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException(
          'Un projet interne portant ce nom existe déjà. Choisissez un autre nom ou rattachez le projet à un client.',
        );
      }
    }

    // Détermine la portée du créateur : un user sans view_all est forcément
    // team-scoped (TEAM_MANAGER) et doit rattacher le projet à au moins une
    // de ses équipes.
    const teamIds = dto.teamIds ?? [];
    const canSeeAll = isAdmin || (await this.hasViewAll(userId, orgId));
    if (!canSeeAll && teamIds.length === 0) {
      throw new BadRequestException(
        'Un Team Manager doit rattacher le projet à au moins une de ses équipes',
      );
    }
    if (teamIds.length > 0) {
      const teams = await this.prisma.team.findMany({
        where: { id: { in: teamIds }, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      if (teams.length !== teamIds.length) {
        throw new NotFoundException('Une ou plusieurs équipes sont introuvables');
      }
      if (!canSeeAll) {
        // Vérifie que le créateur est lead de toutes les équipes listées.
        const led = await this.prisma.teamMember.findMany({
          where: { userId, teamId: { in: teamIds }, isLead: true },
          select: { teamId: true },
        });
        const ledSet = new Set(led.map((m) => m.teamId));
        const notLed = teamIds.filter((id) => !ledSet.has(id));
        if (notLed.length > 0) {
          throw new ForbiddenException(
            "Vous ne pouvez rattacher le projet qu'à des équipes que vous pilotez",
          );
        }
      }
    }

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            organizationId: orgId,
            key: dto.key,
            name: dto.name,
            description: dto.description,
            status: ProjectStatus.DRAFT,
            clientId: dto.clientId ?? null,
            billable,
            agentsEnabled,
            agentContext,
            agentBrief: agentBrief ?? Prisma.DbNull,
            agentGuardrails,
            ciRepos,
          },
        });

        await tx.projectMember.create({
          data: { projectId: project.id, userId, roleId: pmRole.id },
        });

        if (teamIds.length > 0) {
          await tx.projectTeam.createMany({
            data: teamIds.map((teamId) => ({ projectId: project.id, teamId })),
            skipDuplicates: true,
          });
        }

        await tx.projectCharter.create({
          data: { projectId: project.id },
        });

        return project;
      });
      void this.webhooks.dispatch(orgId, 'project.created', created, { projectId: created.id });
      this.notifyProjectsChanged(orgId, 'project.created', created.id);
      return created;
    } catch (e) {
      rethrowProjectNameConflict(e);
    }
  }

  /**
   * Duplique un projet existant en DRAFT : crée une nouvelle entrée projet avec
   * la même description / facturable / skills, puis clone toutes les tâches
   * (titre, description, statut, priorité, position, estimate, dates, hierarchie
   * parent/enfant, milestone/group/color, skill requis) ainsi que les labels du
   * projet, les liens TaskLabel et les TaskDependency entre tâches.
   *
   * Ne sont PAS copiés : assignees, time entries, commentaires, pièces jointes,
   * placement board/column (le nouveau projet n'a pas encore de board), charter,
   * équipes assignées et membres (re-paramétrables via le panneau Manage).
   *
   * Le créateur (`userId`) devient PROJECT_MANAGER du nouveau projet, comme
   * pour `create()`.
   */
  async copy(
    orgId: string,
    sourceId: string,
    userId: string,
    isAdmin: boolean,
    dto: CreateProjectDto,
  ) {
    // 1. Lecture du source (gate de visibilité réutilise findOne)
    const source = await this.findOne(orgId, sourceId, userId, isAdmin);

    // 2. Validations identiques à create()
    const billable = dto.billable ?? source.billable;
    await this.creationPolicy.assertCanCreate(
      orgId,
      userId,
      isAdmin,
      billable ? 'billable' : 'nonBillable',
    );

    const pmRole = await this.prisma.role.findFirstOrThrow({
      where: { organizationId: orgId, key: 'PROJECT_MANAGER' },
    });

    if (dto.clientId) {
      const c = await this.prisma.client.findFirst({
        where: { id: dto.clientId, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      if (!c) throw new NotFoundException('Client introuvable');
    } else {
      const dup = await this.prisma.project.findFirst({
        where: { organizationId: orgId, clientId: null, name: dto.name, deletedAt: null },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException(
          'Un projet interne portant ce nom existe déjà. Choisissez un autre nom ou rattachez le projet à un client.',
        );
      }
    }

    const teamIds = dto.teamIds ?? [];
    const canSeeAll = isAdmin || (await this.hasViewAll(userId, orgId));
    if (!canSeeAll && teamIds.length === 0) {
      throw new BadRequestException(
        'Un Team Manager doit rattacher le projet à au moins une de ses équipes',
      );
    }
    if (teamIds.length > 0) {
      const teams = await this.prisma.team.findMany({
        where: { id: { in: teamIds }, organizationId: orgId, deletedAt: null },
        select: { id: true },
      });
      if (teams.length !== teamIds.length) {
        throw new NotFoundException('Une ou plusieurs équipes sont introuvables');
      }
      if (!canSeeAll) {
        const led = await this.prisma.teamMember.findMany({
          where: { userId, teamId: { in: teamIds }, isLead: true },
          select: { teamId: true },
        });
        const ledSet = new Set(led.map((m) => m.teamId));
        const notLed = teamIds.filter((id) => !ledSet.has(id));
        if (notLed.length > 0) {
          throw new ForbiddenException(
            "Vous ne pouvez rattacher le projet qu'à des équipes que vous pilotez",
          );
        }
      }
    }

    // 3. Lecture des données à cloner — hors transaction (lecture seule).
    const [srcTasks, srcLabels, srcTaskLabels, srcDeps, srcSkills] = await Promise.all([
      this.prisma.task.findMany({
        where: { projectId: sourceId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.label.findMany({ where: { projectId: sourceId } }),
      this.prisma.taskLabel.findMany({
        where: { task: { projectId: sourceId, deletedAt: null } },
      }),
      this.prisma.taskDependency.findMany({ where: { projectId: sourceId } }),
      this.prisma.projectSkill.findMany({ where: { projectId: sourceId } }),
    ]);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const project = await tx.project.create({
          data: {
            organizationId: orgId,
            key: dto.key,
            name: dto.name,
            description: dto.description ?? null,
            status: ProjectStatus.DRAFT,
            clientId: dto.clientId ?? null,
            billable,
          },
        });

        await tx.projectMember.create({
          data: { projectId: project.id, userId, roleId: pmRole.id },
        });

        if (teamIds.length > 0) {
          await tx.projectTeam.createMany({
            data: teamIds.map((teamId) => ({ projectId: project.id, teamId })),
            skipDuplicates: true,
          });
        }

        await tx.projectCharter.create({ data: { projectId: project.id } });

        // Skills du projet (référentiels — pas de remap, les Skill sont org-global).
        if (srcSkills.length > 0) {
          await tx.projectSkill.createMany({
            data: srcSkills.map((s) => ({ projectId: project.id, skillId: s.skillId })),
            skipDuplicates: true,
          });
        }

        // Labels — remap source labelId → new labelId.
        const labelIdMap = new Map<string, string>();
        for (const l of srcLabels) {
          const nl = await tx.label.create({
            data: { projectId: project.id, name: l.name, color: l.color },
          });
          labelIdMap.set(l.id, nl.id);
        }

        // Tâches — 2 passes pour mapper parentTaskId. Pass 1 : crée tout sans parent.
        const taskIdMap = new Map<string, string>();
        let nextNumber = 1;
        for (const t of srcTasks) {
          const nt = await tx.task.create({
            data: {
              organizationId: orgId,
              projectId: project.id,
              number: nextNumber++,
              parentTaskId: null,
              boardColumnId: null, // pas de board avant ACTIVE
              title: t.title,
              description: t.description,
              status: t.status,
              priority: t.priority,
              position: t.position,
              estimateHours: t.estimateHours,
              dueDate: t.dueDate,
              startDate: t.startDate,
              endDate: t.endDate,
              progressPct: t.progressPct,
              isMilestone: t.isMilestone,
              isGroup: t.isGroup,
              color: t.color,
              requiredSkillId: t.requiredSkillId,
              requiredSkillLevel: t.requiredSkillLevel,
              createdById: userId,
            },
          });
          taskIdMap.set(t.id, nt.id);
        }
        // Pass 2 : applique le parentTaskId remappé.
        for (const t of srcTasks) {
          if (!t.parentTaskId) continue;
          const newParent = taskIdMap.get(t.parentTaskId);
          const newId = taskIdMap.get(t.id);
          if (!newParent || !newId) continue;
          await tx.task.update({
            where: { id: newId },
            data: { parentTaskId: newParent },
          });
        }

        // TaskLabel links
        if (srcTaskLabels.length > 0) {
          const data = srcTaskLabels
            .map((tl) => ({
              taskId: taskIdMap.get(tl.taskId),
              labelId: labelIdMap.get(tl.labelId),
            }))
            .filter((r): r is { taskId: string; labelId: string } => !!r.taskId && !!r.labelId);
          if (data.length > 0) {
            await tx.taskLabel.createMany({ data, skipDuplicates: true });
          }
        }

        // Dépendances
        if (srcDeps.length > 0) {
          const data = srcDeps
            .map((d) => ({
              organizationId: orgId,
              projectId: project.id,
              predecessorId: taskIdMap.get(d.predecessorId),
              successorId: taskIdMap.get(d.successorId),
              type: d.type,
              lagDays: d.lagDays,
            }))
            .filter(
              (r): r is {
                organizationId: string;
                projectId: string;
                predecessorId: string;
                successorId: string;
                type: typeof srcDeps[number]['type'];
                lagDays: number;
              } => !!r.predecessorId && !!r.successorId,
            );
          if (data.length > 0) {
            await tx.taskDependency.createMany({ data, skipDuplicates: true });
          }
        }

        return project;
      }, { timeout: 30_000 });
      void this.webhooks.dispatch(orgId, 'project.created', created, { projectId: created.id });
      this.notifyProjectsChanged(orgId, 'project.created', created.id);
      return created;
    } catch (e) {
      rethrowProjectNameConflict(e);
    }
  }

  /**
   * Initialise le board Kanban par défaut. Appelé une seule fois au passage
   * DRAFT/CHARTER_REVIEW → ACTIVE. Idempotent : ne fait rien si un board
   * existe déjà pour le projet.
   */
  private async ensureDefaultBoard(
    tx: Parameters<Parameters<PrismaService['$transaction']>[0]>[0],
    projectId: string,
  ) {
    const existing = await tx.board.findFirst({
      where: { projectId },
      select: { id: true },
    });
    if (existing) return;
    const board = await tx.board.create({
      data: { projectId, name: 'Board principal' },
    });
    // Default board columns. Stored language-neutral (English); the UI
    // localizes recognized default names to the user's language at render.
    const columns = [
      { name: 'To do', order: 1, status: TaskStatus.TODO },
      { name: 'In progress', order: 2, status: TaskStatus.IN_PROGRESS },
      { name: 'In review', order: 3, status: TaskStatus.IN_REVIEW },
      { name: 'On hold', order: 4, status: TaskStatus.ON_HOLD },
      { name: 'Done', order: 5, status: TaskStatus.DONE },
    ];
    for (const c of columns) {
      await tx.boardColumn.create({ data: { boardId: board.id, ...c } });
    }
  }

  /**
   * Mise à jour partielle d'un projet. L'utilisateur doit pouvoir voir le projet
   * (admin global, view_all, ou membre). startDate / dueDate acceptent null pour
   * remettre à vide ; sinon une ISO date YYYY-MM-DD.
   */
  async update(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    dto: UpdateProjectDto,
  ) {
    // Réutilise la garde "le user peut voir le projet" — sinon 404.
    const current = await this.findOne(orgId, projectId, userId, isAdmin);
    const data: Record<string, unknown> = {};
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;

    // Le flag facturable n'est mutable QUE tant que le projet est en DRAFT.
    // Une fois sorti du brouillon, il fait partie de l'identité du projet
    // (charter signé éventuel, reporting financier, etc.) et se verrouille.
    if (dto.billable !== undefined && dto.billable !== current.billable) {
      if (current.status !== ProjectStatus.DRAFT) {
        throw new BadRequestException(
          'Le type facturable / non-facturable ne peut être changé qu\'en DRAFT',
        );
      }
      data.billable = dto.billable;
    }

    // Statut effectif APRÈS prise en compte du flip billable ci-dessus —
    // utilisé pour piquer la bonne machine à états.
    const effectiveBillable =
      data.billable !== undefined ? (data.billable as boolean) : current.billable;

    if (dto.status !== undefined && dto.status !== current.status) {
      const allowed = transitionsFor(effectiveBillable)[current.status] ?? [];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(
          `Transition ${current.status} → ${dto.status} interdite (lifecycle ${effectiveBillable ? 'facturable' : 'non-facturable'})`,
        );
      }
      // La décision sur une offre envoyée (accept → CHARTER_REVIEW / refus →
      // DRAFT) doit passer par les endpoints `/offer/accept` et `/offer/refuse`
      // afin de capter le compteur de refus et la raison. On la refuse ici.
      if (
        current.status === ProjectStatus.OFFER_SENT &&
        OFFER_DECISION_TARGETS.has(dto.status)
      ) {
        throw new BadRequestException(
          "Utilisez les actions « Accepter » / « Refuser » l'offre pour cette transition.",
        );
      }
      // Une date de début est obligatoire pour activer un projet : elle sert de
      // plancher au planning (CPM, auto-plan, workload). On prend en compte la
      // valeur fournie dans ce même PATCH avant de retomber sur l'existante.
      if (dto.status === ProjectStatus.ACTIVE) {
        const effectiveStart =
          dto.startDate !== undefined
            ? dto.startDate
              ? new Date(dto.startDate)
              : null
            : current.startDate;
        if (!effectiveStart) {
          throw new BadRequestException(
            'Une date de début doit être définie avant d\'activer le projet',
          );
        }
      }
      // Gating charter signé : uniquement pour les projets facturables.
      // Un projet non-facturable peut passer DRAFT → ACTIVE sans charter.
      if (dto.status === ProjectStatus.ACTIVE && effectiveBillable) {
        const charter = await this.prisma.projectCharter.findUnique({
          where: { projectId },
          select: { signedDocumentFilename: true },
        });
        if (!charter?.signedDocumentFilename) {
          throw new BadRequestException(
            'Le charter signé doit être uploadé avant d\'activer le projet',
          );
        }
      }
      data.status = dto.status;
    }
    // Santé / résumé du point de statut client (éditorial, distinct du statut).
    if (dto.statusHealth !== undefined) data.statusHealth = dto.statusHealth || null;
    if (dto.statusSummary !== undefined) data.statusSummary = dto.statusSummary?.trim() || null;
    if (dto.startDate !== undefined)
      data.startDate = dto.startDate ? new Date(dto.startDate) : null;
    if (dto.dueDate !== undefined)
      data.dueDate = dto.dueDate ? new Date(dto.dueDate) : null;
    if (dto.clientId !== undefined) {
      if (dto.clientId === null) {
        data.clientId = null;
      } else {
        const c = await this.prisma.client.findFirst({
          where: { id: dto.clientId, organizationId: orgId, deletedAt: null },
          select: { id: true },
        });
        if (!c) throw new NotFoundException('Client introuvable');
        data.clientId = dto.clientId;
      }
    }
    // Pré-vérif manuelle pour le cas clientId = NULL : Postgres considère
    // chaque NULL comme distinct dans la contrainte d'unicité, donc on doit
    // l'attraper côté service avant l'update. Pour clientId set, c'est la
    // contrainte DB qui jouera (capturée par rethrowProjectNameConflict).
    const nextName = (data.name as string | undefined) ?? current.name;
    const nextClientId =
      (data.clientId as string | null | undefined) !== undefined
        ? (data.clientId as string | null)
        : current.clientId ?? null;
    if (nextClientId === null && (data.name !== undefined || data.clientId !== undefined)) {
      const dup = await this.prisma.project.findFirst({
        where: {
          organizationId: orgId,
          clientId: null,
          name: nextName,
          deletedAt: null,
          id: { not: projectId },
        },
        select: { id: true },
      });
      if (dup) {
        throw new ConflictException(
          'Un projet interne portant ce nom existe déjà. Choisissez un autre nom ou rattachez le projet à un client.',
        );
      }
    }

    // Contexte agents : activer les agents exige un brief non vide (nouveau ou
    // déjà présent). On lit l'état courant seulement si l'un des champs bouge.
    if (
      dto.agentsEnabled !== undefined ||
      dto.agentContext !== undefined ||
      dto.agentBrief !== undefined ||
      dto.agentGuardrails !== undefined
    ) {
      const cur = await this.prisma.project.findUnique({
        where: { id: projectId },
        select: { agentsEnabled: true, agentContext: true, agentBrief: true },
      });
      const nextEnabled = dto.agentsEnabled ?? cur?.agentsEnabled ?? false;
      const nextContext =
        dto.agentContext !== undefined
          ? dto.agentContext?.trim() || null
          : cur?.agentContext ?? null;
      const nextBrief =
        dto.agentBrief !== undefined
          ? normalizeAgentBrief(dto.agentBrief)
          : normalizeAgentBrief(cur?.agentBrief);
      this.assertAgentContext(nextEnabled, nextContext, nextBrief);
      if (dto.agentsEnabled !== undefined) data.agentsEnabled = nextEnabled;
      if (dto.agentContext !== undefined) data.agentContext = nextContext;
      // `null` explicite = effacer le brief structuré (Prisma Json : DbNull).
      if (dto.agentBrief !== undefined) data.agentBrief = nextBrief ?? Prisma.DbNull;
      if (dto.agentGuardrails !== undefined) data.agentGuardrails = dto.agentGuardrails?.trim() || null;
    }
    if (dto.agentAutoCloseOnApproval !== undefined) {
      data.agentAutoCloseOnApproval = dto.agentAutoCloseOnApproval;
    }
    if (dto.spContextEnabled !== undefined) {
      data.spContextEnabled = dto.spContextEnabled;
    }
    if (dto.agentCostBudget !== undefined) {
      data.agentCostBudget = dto.agentCostBudget;
    }
    if (dto.verificationCapabilities !== undefined) {
      // Normalise : sous-ensemble unique des méthodes mécaniques (l'ordre importe peu).
      const allowed = new Set(['tool_output', 'agent_validator', 'ci_signed']);
      const list = Array.isArray(dto.verificationCapabilities)
        ? [...new Set(dto.verificationCapabilities.filter((m) => allowed.has(m)))]
        : [];
      data.verificationCapabilities = list as unknown as Prisma.InputJsonValue;
    }
    if (dto.stakes !== undefined) data.stakes = dto.stakes;
    if (dto.verificationMode !== undefined) data.verificationMode = dto.verificationMode || null;
    if (dto.ciRepos !== undefined) data.ciRepos = normalizeCiRepos(dto.ciRepos);
    if (dto.sponsorNotify !== undefined) {
      if (dto.sponsorNotify === null) {
        data.sponsorNotify = Prisma.JsonNull;
      } else {
        // Whitelist stricte des clés connues, valeurs coercées en booléens.
        const allowed = ['milestoneReached', 'projectStatus', 'milestoneAtRisk', 'budgetThresholds'];
        const clean: Record<string, boolean> = {};
        for (const k of allowed) {
          const v = (dto.sponsorNotify as Record<string, unknown>)[k];
          if (typeof v === 'boolean') clean[k] = v;
        }
        data.sponsorNotify = clean as unknown as Prisma.InputJsonValue;
      }
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const u = await tx.project.update({
          where: { id: projectId },
          data,
          omit: PROJECT_FINANCE_OMIT,
          include: { client: { select: { id: true, name: true, company: true } } },
        });
        if (data.status === ProjectStatus.ACTIVE) {
          await this.ensureDefaultBoard(tx, projectId);
        }
        return u;
      });
      void this.webhooks.dispatch(orgId, 'project.updated', updated, { projectId });
      // Diff lisible old→new pour l'entrée `projects.update` du journal d'audit.
      const norm = (p: { name: string; status: unknown; billable: boolean; startDate: Date | string | null; dueDate: Date | string | null; clientId?: string | null }) => ({
        name: p.name,
        status: p.status,
        billable: p.billable,
        startDate: p.startDate ? new Date(p.startDate).toISOString().slice(0, 10) : null,
        dueDate: p.dueDate ? new Date(p.dueDate).toISOString().slice(0, 10) : null,
        clientId: p.clientId ?? null,
      });
      const changes = auditDiff(norm(current), norm(updated));
      if (changes) this.audit.enrichRequest(changes);
      this.notifyProjectsChanged(orgId, 'project.updated', projectId);
      // Skills lifecycle : à la clôture (transition vers COMPLETED), bumper
      // les UserSkill des participants sur les ProjectSkill. Best-effort,
      // off chemin critique — ne doit jamais faire échouer l'update projet.
      if (
        data.status === ProjectStatus.COMPLETED &&
        current.status !== ProjectStatus.COMPLETED
      ) {
        void this.skills
          .bumpForProjectClose(orgId, projectId)
          .catch(() => { /* swallow — best-effort */ });
      }
      // Provisioning Microsoft Teams (feature premium) : entrée en ACTIVE →
      // création/désarchivage de l'équipe ; sortie de ACTIVE → archivage. Tout
      // est gated + best-effort dans le service ; ne doit jamais casser l'update.
      if (data.status && data.status !== current.status) {
        void this.teamsProvisioning
          .onProjectStatusChanged(orgId, projectId, current.status, String(data.status))
          .catch(() => { /* swallow — best-effort */ });
        // Entrée en ACTIVE : event dédié `project.activated`, en plus du
        // `project.updated` générique déjà émis. C'est le déclencheur qu'un
        // provisioner externe attend pour créer l'espace de collaboration puis
        // le déclarer via `PUT /projects/:id/collab-spaces/:provider`.
        if (data.status === ProjectStatus.ACTIVE) {
          void this.webhooks.dispatch(orgId, 'project.activated', updated, { projectId });
          // Provisioning Slack (2ᵉ fournisseur de collaboration) — inline,
          // fire-and-forget, gaté par le toggle + le bot token dans le service.
          void this.slackProvisioning.onProjectActivated(orgId, projectId);
          // Provisioning Google Chat (3ᵉ fournisseur) — même modèle inline.
          void this.googleChatProvisioning.onProjectActivated(orgId, projectId);
          // Provisioning Google Drive (4ᵉ fournisseur) : un Drive partagé par
          // projet — l'équivalent Google du site SharePoint d'une équipe Teams.
          void this.googleDriveProvisioning.onProjectActivated(orgId, projectId);
        }
        // Feed sponsor : changement de statut projet → sponsors (gaté par
        // `Project.sponsorNotify` dans le hook, fire-and-forget).
        void this.automationHooks()?.onProjectStatusChanged(
          orgId,
          { id: projectId, name: updated.name, sponsorNotify: updated.sponsorNotify },
          String(current.status),
          String(data.status),
        );
      }
      return {
        ...updated,
        agentCostBudget: updated.agentCostBudget != null ? Number(updated.agentCostBudget) : null,
        allowedTransitions: this.allowedTransitionsOf(updated),
      };
    } catch (e) {
      rethrowProjectNameConflict(e);
    }
  }

  /**
   * Suppression définitive d'un projet. Autorisée uniquement en DRAFT ou
   * CHARTER_REVIEW — une fois ACTIVE/COMPLETED/ARCHIVED, le projet est
   * considéré comme historiquement significatif (tâches, time entries,
   * allocations potentiels) et seule l'archive est possible. Nettoie les
   * blobs MinIO (charter signé, documents d'offre, pièces jointes) après
   * commit.
   */
  async delete(orgId: string, projectId: string) {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId: orgId, deletedAt: null },
      include: { charter: true },
    });
    if (!project) throw new NotFoundException('Projet introuvable');
    if (
      project.status !== ProjectStatus.DRAFT &&
      project.status !== ProjectStatus.CHARTER_REVIEW
    ) {
      throw new BadRequestException(
        'Seuls les projets en DRAFT ou CHARTER_REVIEW peuvent être supprimés. Archive le projet à la place.',
      );
    }
    // Clés S3 relevées AVANT la transaction (les lignes disparaissent avec
    // elle), blobs supprimés APRÈS commit — un rollback ne doit jamais laisser
    // une ligne pointant sur un blob déjà détruit. Pas de filtre deletedAt :
    // une pièce jointe soft-deleted garde sa ligne (et parfois son blob).
    const [projectDocs, taskAttachments] = await Promise.all([
      this.prisma.projectDocument.findMany({
        where: { projectId },
        select: { storageKey: true },
      }),
      this.prisma.attachment.findMany({
        where: { task: { projectId } },
        select: { storageKey: true },
      }),
    ]);
    await this.prisma.$transaction(async (tx) => {
      // Un projet DRAFT/CHARTER_REVIEW peut déjà porter des tâches (créées via
      // POST /projects/:id/tasks ou clonées par la duplication de projet — qui
      // sont soft-deleted côté app, donc gardent leur FK) ainsi qu'un board
      // auto-créé : cascade explicite sur tout ce qui référence le projet sans
      // onDelete: Cascade. Les relations task-scopées en Cascade (TimeEntry,
      // Comment, TaskLabel, TaskDependency, TaskStatusHistory,
      // TaskRequiredSkill, Deliverable, Allocation) tombent avec les tâches.
      await tx.taskAssignee.deleteMany({ where: { task: { projectId } } });
      await tx.attachment.deleteMany({ where: { task: { projectId } } });
      await tx.task.deleteMany({ where: { projectId } });
      await tx.boardColumn.deleteMany({ where: { board: { projectId } } });
      await tx.board.deleteMany({ where: { projectId } });
      await tx.label.deleteMany({ where: { projectId } });
      await tx.projectCharter.deleteMany({ where: { projectId } });
      await tx.projectMember.deleteMany({ where: { projectId } });
      await tx.projectTeam.deleteMany({ where: { projectId } });
      // Références scalaires (sans FK, non bloquantes) : purge des données
      // projet-scopées, mais on DÉTACHE seulement les runs d'agents — coûts
      // réels déclarés, conservés au niveau org/agent pour la facturation.
      await tx.msTeamProvisionLog.deleteMany({ where: { projectId } });
      await tx.agentJournalEntry.deleteMany({ where: { projectId } });
      await tx.agentRun.updateMany({
        where: { projectId },
        data: { projectId: null },
      });
      await tx.webhook.deleteMany({
        where: { organizationId: orgId, scopeType: 'PROJECT', scopeId: projectId },
      });
      await tx.project.delete({ where: { id: projectId } });
    });
    // Best-effort : un blob orphelin est tolérable, une erreur S3 ne doit pas
    // faire échouer une suppression déjà commitée.
    if (project.charter?.signedDocumentFilename) {
      const key = `${projectId}/${project.charter.signedDocumentFilename}`;
      await this.s3.removeObject(this.s3.buckets.charters, key).catch(() => {});
    }
    for (const doc of projectDocs) {
      await this.s3
        .removeObject(this.s3.buckets.charters, doc.storageKey)
        .catch(() => {});
    }
    for (const att of taskAttachments) {
      await this.s3
        .removeObject(this.s3.buckets.attachments, att.storageKey)
        .catch(() => {});
    }
    this.notifyProjectsChanged(orgId, 'project.deleted', projectId);
    return { id: projectId, name: project.name, deleted: true };
  }

  // ----------------------------------------------------------------
  // Project charter (PMBOK-style) — phase d'initiation
  // ----------------------------------------------------------------

  private charterInclude = {
    signedUploadedBy: { select: { id: true, name: true } },
  } as const;

  private serializeCharter(c: {
    projectId: string;
    projectPurpose: string | null;
    objectives: string | null;
    scopeIn: string | null;
    scopeOut: string | null;
    deliverables: string | null;
    milestones: string | null;
    stakeholders: string | null;
    sponsor: string | null;
    sponsorUserId: string | null;
    assumptions: string | null;
    constraints: string | null;
    risks: string | null;
    budgetEstimate: string | null;
    successCriteria: string | null;
    extraSections: unknown;
    signedDocumentFilename: string | null;
    signedDocumentMimeType: string | null;
    signedDocumentSizeBytes: number | null;
    signedDocumentUploadedAt: Date | null;
    signedUploadedBy: { id: string; name: string } | null;
    createdAt: Date;
    updatedAt: Date;
  }, sponsorUser: { id: string; name: string } | null = null) {
    return {
      projectId: c.projectId,
      projectPurpose: c.projectPurpose,
      objectives: c.objectives,
      scopeIn: c.scopeIn,
      scopeOut: c.scopeOut,
      deliverables: c.deliverables,
      milestones: c.milestones,
      stakeholders: c.stakeholders,
      sponsor: c.sponsor,
      sponsorUserId: c.sponsorUserId,
      sponsorUser,
      assumptions: c.assumptions,
      constraints: c.constraints,
      risks: c.risks,
      budgetEstimate: c.budgetEstimate,
      successCriteria: c.successCriteria,
      extraSections: (c.extraSections as Record<string, string> | null) ?? null,
      signedDocument: c.signedDocumentFilename
        ? {
            filename: c.signedDocumentFilename,
            mimeType: c.signedDocumentMimeType ?? '',
            sizeBytes: c.signedDocumentSizeBytes ?? 0,
            uploadedAt: c.signedDocumentUploadedAt?.toISOString() ?? '',
            uploadedBy: c.signedUploadedBy,
          }
        : null,
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
    };
  }

  /** Résout le membre sponsor (nom) pour pré-sélectionner le picker. */
  private async resolveSponsor(sponsorUserId: string | null) {
    if (!sponsorUserId) return null;
    return this.prisma.user.findUnique({
      where: { id: sponsorUserId },
      select: { id: true, name: true },
    });
  }

  async getCharter(orgId: string, projectId: string, userId: string, isAdmin: boolean) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    const charter = await this.prisma.projectCharter.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
      include: this.charterInclude,
    });
    return this.serializeCharter(charter, await this.resolveSponsor(charter.sponsorUserId));
  }

  async upsertCharter(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    patch: Record<string, unknown>,
  ) {
    const project = await this.findOne(orgId, projectId, userId, isAdmin);
    // Une fois le projet ACTIF, le charter est gelé (lecture seule).
    if (project.status !== ProjectStatus.DRAFT && project.status !== ProjectStatus.CHARTER_REVIEW) {
      throw new ForbiddenException(
        'Le charter ne peut être édité qu\'en phase DRAFT ou CHARTER_REVIEW',
      );
    }
    const allowed = [
      'projectPurpose', 'objectives', 'scopeIn', 'scopeOut', 'deliverables',
      'milestones', 'stakeholders', 'sponsor', 'assumptions', 'constraints',
      'risks', 'budgetEstimate', 'successCriteria', 'extraSections',
    ] as const;
    const data: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch) data[k] = patch[k] ?? null;
    }

    // Sponsor exécutif lié à l'identité : le sélecteur envoie un `sponsorUserId`
    // (userId d'un membre du projet) ou null. On résout le nom (imprimé sur le
    // .docx), on pose le tag `ProjectMember.isSponsor` (audience de com), et on
    // garde `sponsor` (texte) en phase. Effacer le sponsor NE retire PAS le tag
    // (d'autres membres peuvent être sponsors — la gestion se fait dans l'onglet
    // Accès) : on nettoie seulement la désignation de la charte.
    let sponsorMemberToTag: string | null = null;
    if ('sponsorUserId' in patch) {
      const raw = patch.sponsorUserId;
      if (raw == null || raw === '') {
        data.sponsorUserId = null;
        data.sponsor = null;
      } else {
        const uid = String(raw);
        const member = await this.prisma.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId: uid } },
          select: { user: { select: { id: true, name: true } } },
        });
        if (!member) {
          throw new BadRequestException('Le sponsor doit être un membre du projet.');
        }
        data.sponsorUserId = uid;
        data.sponsor = member.user.name;
        sponsorMemberToTag = uid;
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const c = await tx.projectCharter.upsert({
        where: { projectId },
        create: { projectId, ...data },
        update: data,
        include: this.charterInclude,
      });
      if (sponsorMemberToTag) {
        await tx.projectMember.update({
          where: { projectId_userId: { projectId, userId: sponsorMemberToTag } },
          data: { isSponsor: true },
        });
      }
      return c;
    });
    return this.serializeCharter(updated, await this.resolveSponsor(updated.sponsorUserId));
  }

  /**
   * Enregistre un upload de charter signé. v1 minimal : on stocke les
   * métadonnées (nom, mime, taille, qui+quand). Le blob lui-même va en MinIO
   * en v1.2 — pour l'instant l'appelant est responsable de la persistence.
   */
  /**
   * Génère un .docx du charter à partir des champs structurés. Le projet
   * peut être à n'importe quel statut (utile pour archiver le charter d'un
   * projet déjà ACTIVE/COMPLETED).
   */
  async exportCharterDocx(orgId: string, projectId: string, userId: string, isAdmin: boolean) {
    const project = await this.findOne(orgId, projectId, userId, isAdmin);
    const charter = await this.prisma.projectCharter.upsert({
      where: { projectId },
      create: { projectId },
      update: {},
    });
    const input = {
      project: {
        key: project.key,
        name: project.name,
        description: project.description,
        client: (project as { client?: { name: string; company: string | null } | null }).client ?? null,
        createdAt: project.createdAt,
      },
      charter,
    };
    // Si l'organisation a uploadé un template, on s'en sert ; sinon défaut.
    const tpl = await this.prisma.organizationDocumentTemplate.findUnique({
      where: { organizationId_kind: { organizationId: orgId, kind: 'CHARTER' } },
    });
    let buffer: Buffer;
    let usedTemplate = false;
    if (tpl) {
      try {
        const tplBuffer = await this.s3.getObjectBuffer(
          this.s3.buckets.templates,
          tpl.storageKey,
        );
        buffer = fillCharterTemplate(tplBuffer, input);
        usedTemplate = true;
      } catch {
        // Si le template est cassé/manquant, on retombe sur le défaut plutôt
        // que de casser l'export entier.
        buffer = await buildCharterDocx(input);
      }
    } else {
      buffer = await buildCharterDocx(input);
    }
    return { buffer, project, usedTemplate };
  }

  async recordSignedCharter(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    file: { filename: string; mimeType: string; sizeBytes: number },
  ) {
    const project = await this.findOne(orgId, projectId, userId, isAdmin);
    if (project.status !== ProjectStatus.CHARTER_REVIEW && project.status !== ProjectStatus.DRAFT) {
      throw new BadRequestException(
        'Le charter signé ne peut être uploadé qu\'en phase DRAFT ou CHARTER_REVIEW',
      );
    }
    const updated = await this.prisma.projectCharter.upsert({
      where: { projectId },
      create: {
        projectId,
        signedDocumentFilename: file.filename,
        signedDocumentMimeType: file.mimeType,
        signedDocumentSizeBytes: file.sizeBytes,
        signedDocumentUploadedAt: new Date(),
        signedDocumentUploadedBy: userId,
      },
      update: {
        signedDocumentFilename: file.filename,
        signedDocumentMimeType: file.mimeType,
        signedDocumentSizeBytes: file.sizeBytes,
        signedDocumentUploadedAt: new Date(),
        signedDocumentUploadedBy: userId,
      },
      include: this.charterInclude,
    });
    return this.serializeCharter(updated, await this.resolveSponsor(updated.sponsorUserId));
  }

  // ============================================================
  // Documents projet (offres commerciales, propositions…) — multi-docs
  // ============================================================
  private serializeDoc(
    d: {
      id: string;
      kind: ProjectDocumentKind;
      folderId: string | null;
      aiContext: boolean;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      uploadedAt: Date;
      contentUpdatedAt?: Date | null;
      uploadedBy: { id: string; name: string } | null;
    },
    /**
     * Dossiers effectivement « contexte IA » (cf. `document-context.ts`).
     * Optionnel : passé par les listings qui ont déjà chargé l'arborescence.
     * Absent → on ne prétend pas connaître l'héritage et on retombe sur le
     * drapeau propre, plutôt que d'afficher un « non exposé » mensonger.
     */
    aiFolderIds?: ReadonlySet<string>,
  ) {
    const folders = aiFolderIds ?? new Set<string>();
    return {
      id: d.id,
      kind: d.kind,
      folderId: d.folderId,
      aiContext: d.aiContext,
      /** Exposition RÉELLE = drapeau propre OU dossier « contexte IA » hérité. */
      aiContextEffective: isDocumentAiContext(d, folders),
      /** `own` | `folder` | `null` — pilote le badge « hérité » et le toggle. */
      aiContextSource: documentAiSource(d, folders),
      filename: d.filename,
      mimeType: d.mimeType,
      sizeBytes: d.sizeBytes,
      uploadedAt: d.uploadedAt.toISOString(),
      contentUpdatedAt: d.contentUpdatedAt ? d.contentUpdatedAt.toISOString() : null,
      uploadedBy: d.uploadedBy ? { id: d.uploadedBy.id, name: d.uploadedBy.name } : null,
    };
  }

  /** Dossiers « contexte IA » effectifs d'un projet (marqués + descendance). */
  private async aiFolderIdsFor(orgId: string, projectId: string): Promise<Set<string>> {
    const folders = await this.prisma.projectDocumentFolder.findMany({
      where: { projectId, organizationId: orgId },
      select: { id: true, parentId: true, aiContext: true },
    });
    return effectiveAiFolderIds(folders);
  }

  // ============================================================
  // Étape commerciale « offre » (projets facturables uniquement)
  // DRAFT → OFFER_SENT → [refus → DRAFT, compteur++] / [accept → CHARTER_REVIEW]
  // ============================================================

  /**
   * Garde commune aux actions d'offre : applique le gate d'accès (findOne →
   * 404 si non visible) puis exige un projet facturable (l'étape offre n'existe
   * pas en non-facturable). Renvoie l'état courant.
   */
  private async loadOfferProject(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
  ) {
    const p = await this.findOne(orgId, projectId, userId, isAdmin);
    if (!p.billable) {
      throw new BadRequestException(
        "L'étape « offre » ne concerne que les projets facturables.",
      );
    }
    return p;
  }

  /**
   * Applique une transition d'offre : update projet + écriture d'un
   * `ProjectOfferEvent` dans la même transaction, puis webhook + WS. Renvoie le
   * projet enrichi de `allowedTransitions`.
   */
  private async transitionOffer(
    orgId: string,
    projectId: string,
    data: Prisma.ProjectUpdateInput,
    eventKind: 'SENT' | 'ACCEPTED' | 'REFUSED',
    actorId: string,
    reason: string | null,
  ) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.project.update({
        where: { id: projectId },
        data,
        omit: PROJECT_FINANCE_OMIT,
        include: { client: { select: { id: true, name: true, company: true } } },
      });
      await tx.projectOfferEvent.create({
        data: {
          organizationId: orgId,
          projectId,
          kind: eventKind,
          reason,
          actorId,
        },
      });
      return u;
    });
    void this.webhooks.dispatch(orgId, 'project.updated', updated, { projectId });
    this.notifyProjectsChanged(orgId, 'project.updated', projectId);
    return { ...updated, allowedTransitions: this.allowedTransitionsOf(updated) };
  }

  /**
   * Résout le destinataire de l'offre côté client : contact principal avec
   * email en priorité, puis n'importe quel contact avec email, puis l'email du
   * client lui-même. `null` si aucune adresse exploitable.
   */
  private async resolveClientRecipient(
    orgId: string,
    clientId: string,
  ): Promise<{ email: string; name: string } | null> {
    const primary = await this.prisma.contact.findFirst({
      where: { organizationId: orgId, clientId, isPrimary: true, deletedAt: null, email: { not: null } },
      select: { email: true, name: true },
    });
    if (primary?.email) return { email: primary.email, name: primary.name };
    const any = await this.prisma.contact.findFirst({
      where: { organizationId: orgId, clientId, deletedAt: null, email: { not: null } },
      orderBy: { createdAt: 'asc' },
      select: { email: true, name: true },
    });
    if (any?.email) return { email: any.email, name: any.name };
    const client = await this.prisma.client.findFirst({
      where: { id: clientId, organizationId: orgId, deletedAt: null, email: { not: null } },
      select: { email: true, name: true },
    });
    if (client?.email) return { email: client.email, name: client.name };
    return null;
  }

  /**
   * Marque l'offre comme envoyée manuellement (DRAFT → OFFER_SENT) sans email.
   * Renvoie un flag `noOfferDocument` si aucune offre n'est téléversée (l'UI
   * peut avertir, mais on ne bloque pas — l'envoi peut se faire hors de l'app).
   */
  async sendOffer(orgId: string, projectId: string, userId: string, isAdmin: boolean) {
    const current = await this.loadOfferProject(orgId, projectId, userId, isAdmin);
    if (current.status !== ProjectStatus.DRAFT) {
      throw new BadRequestException(
        `L'offre ne peut être envoyée que depuis le statut DRAFT (actuel : ${current.status}).`,
      );
    }
    const offerDoc = await this.prisma.projectDocument.findFirst({
      where: { projectId, organizationId: orgId, kind: ProjectDocumentKind.OFFER },
      select: { id: true },
    });
    const updated = await this.transitionOffer(
      orgId,
      projectId,
      { status: ProjectStatus.OFFER_SENT, offerSentAt: new Date() },
      'SENT',
      userId,
      null,
    );
    return { ...updated, noOfferDocument: !offerDoc };
  }

  /**
   * Envoie l'offre par email au contact client, avec le document d'offre en
   * pièce jointe, puis (si le projet est en DRAFT) le fait passer en OFFER_SENT.
   * Garde-fous : l'offre doit exister, le projet doit avoir un client avec un
   * email exploitable. La confirmation se fait côté UI (cf. dialog).
   */
  async emailOffer(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    opts: { intro?: string } = {},
  ) {
    const current = await this.loadOfferProject(orgId, projectId, userId, isAdmin);
    if (
      current.status !== ProjectStatus.DRAFT &&
      current.status !== ProjectStatus.OFFER_SENT
    ) {
      throw new BadRequestException(
        `L'offre ne peut être envoyée qu'en phase DRAFT ou OFFER_SENT (actuel : ${current.status}).`,
      );
    }
    // Garde 1 : une offre doit avoir été téléversée.
    const offerDoc = await this.prisma.projectDocument.findFirst({
      where: { projectId, organizationId: orgId, kind: ProjectDocumentKind.OFFER },
      orderBy: { uploadedAt: 'desc' },
    });
    if (!offerDoc) {
      throw new BadRequestException("Aucune offre n'a été téléversée pour ce projet.");
    }
    // Garde 2 : un client avec une adresse email exploitable.
    if (!current.clientId) {
      throw new BadRequestException("Le projet n'est rattaché à aucun client.");
    }
    const recipient = await this.resolveClientRecipient(orgId, current.clientId);
    if (!recipient) {
      throw new BadRequestException(
        "Le client n'a pas de contact principal avec une adresse email.",
      );
    }
    // Récupère les octets de l'offre depuis le stockage (même chemin que le download).
    const exists = await this.s3.objectExists(this.s3.buckets.charters, offerDoc.storageKey);
    if (!exists) {
      throw new BadRequestException("Le fichier de l'offre est introuvable dans le stockage.");
    }
    const buffer = await this.s3.getObjectBuffer(this.s3.buckets.charters, offerDoc.storageKey);
    const result = await this.notifications.sendOfferEmail(
      orgId,
      recipient.email,
      recipient.name,
      {
        projectName: current.name,
        clientName: current.client?.name ?? null,
        intro: opts.intro,
      },
      {
        filename: offerDoc.filename,
        contentType: offerDoc.mimeType,
        contentBase64: buffer.toString('base64'),
      },
    );
    if (result.skipped) {
      throw new BadRequestException(
        "Les notifications email sont désactivées (kill switch org). Activez-les dans Admin > Notifications.",
      );
    }
    // Avance en OFFER_SENT si on partait de DRAFT ; sinon (renvoi) on rafraîchit
    // juste l'horodatage d'envoi. Dans les deux cas on journalise un SENT.
    const updated = await this.transitionOffer(
      orgId,
      projectId,
      current.status === ProjectStatus.DRAFT
        ? { status: ProjectStatus.OFFER_SENT, offerSentAt: new Date() }
        : { offerSentAt: new Date() },
      'SENT',
      userId,
      recipient.email,
    );
    return { ...updated, sentTo: recipient.email, deliveryId: result.deliveryId };
  }

  /** OFFER_SENT → CHARTER_REVIEW : le client a accepté l'offre. */
  async acceptOffer(orgId: string, projectId: string, userId: string, isAdmin: boolean) {
    const current = await this.loadOfferProject(orgId, projectId, userId, isAdmin);
    if (current.status !== ProjectStatus.OFFER_SENT) {
      throw new BadRequestException(
        `Seule une offre envoyée (OFFER_SENT) peut être acceptée (actuel : ${current.status}).`,
      );
    }
    return this.transitionOffer(
      orgId,
      projectId,
      { status: ProjectStatus.CHARTER_REVIEW, offerDecidedAt: new Date() },
      'ACCEPTED',
      userId,
      null,
    );
  }

  /**
   * OFFER_SENT → DRAFT : le client a refusé l'offre. Incrémente
   * `offerRefusalCount` et journalise la raison. Le projet repart en DRAFT pour
   * révision et renvoi.
   */
  async refuseOffer(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    reason?: string,
  ) {
    const current = await this.loadOfferProject(orgId, projectId, userId, isAdmin);
    if (current.status !== ProjectStatus.OFFER_SENT) {
      throw new BadRequestException(
        `Seule une offre envoyée (OFFER_SENT) peut être refusée (actuel : ${current.status}).`,
      );
    }
    return this.transitionOffer(
      orgId,
      projectId,
      {
        status: ProjectStatus.DRAFT,
        offerDecidedAt: new Date(),
        offerRefusalCount: { increment: 1 },
      },
      'REFUSED',
      userId,
      reason?.trim() ? reason.trim() : null,
    );
  }

  async listDocuments(orgId: string, projectId: string, userId: string, isAdmin: boolean) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    // L'arborescence est chargée UNE fois puis appliquée à tous les documents :
    // l'héritage « dossier contexte IA » se calcule en mémoire, pas par document.
    const [docs, aiFolderIds] = await Promise.all([
      this.prisma.projectDocument.findMany({
        where: { projectId, organizationId: orgId },
        orderBy: { uploadedAt: 'desc' },
        include: { uploadedBy: { select: { id: true, name: true } } },
      }),
      this.aiFolderIdsFor(orgId, projectId),
    ]);
    return docs.map((d) => this.serializeDoc(d, aiFolderIds));
  }

  async recordDocument(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    data: {
      kind: ProjectDocumentKind;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      folderId?: string | null;
      aiContext?: boolean;
    },
  ) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    if (data.folderId) await this.assertFolder(orgId, projectId, data.folderId);
    const doc = await this.prisma.projectDocument.create({
      data: {
        organizationId: orgId,
        projectId,
        kind: data.kind,
        folderId: data.folderId ?? null,
        aiContext: !!data.aiContext,
        filename: data.filename,
        mimeType: data.mimeType,
        sizeBytes: data.sizeBytes,
        storageKey: data.storageKey,
        uploadedById: userId,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    return this.serializeDoc(doc, await this.aiFolderIdsFor(orgId, projectId));
  }

  /** Renvoie la métadonnée brute (storageKey inclus) pour download/suppression. */
  async getDocumentRaw(orgId: string, projectId: string, userId: string, isAdmin: boolean, docId: string) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    const doc = await this.prisma.projectDocument.findFirst({
      where: { id: docId, projectId, organizationId: orgId },
    });
    if (!doc) throw new NotFoundException('Document introuvable');
    return doc;
  }

  /** Supprime la ligne DB et renvoie le doc (le controller efface le blob S3). */
  async deleteDocument(orgId: string, projectId: string, userId: string, isAdmin: boolean, docId: string) {
    const doc = await this.getDocumentRaw(orgId, projectId, userId, isAdmin, docId);
    await this.prisma.projectDocument.delete({ where: { id: docId } });
    return doc;
  }

  // ============================================================
  // Espace documents — dossiers (arborescence libre par projet)
  // ============================================================

  private serializeFolder(
    f: {
      id: string;
      parentId: string | null;
      name: string;
      aiContext?: boolean;
      createdAt: Date;
      updatedAt: Date;
    },
    /** Ensemble effectif (marqués + descendance) — pour distinguer hérité/propre. */
    aiFolderIds?: ReadonlySet<string>,
  ) {
    return {
      id: f.id,
      parentId: f.parentId,
      name: f.name,
      /** Drapeau propre du dossier (ce que le toggle UI écrit). */
      aiContext: !!f.aiContext,
      /** Exposition réelle : marqué OU descendant d'un dossier marqué. */
      aiContextEffective: aiFolderIds ? aiFolderIds.has(f.id) : !!f.aiContext,
      createdAt: f.createdAt.toISOString(),
      updatedAt: f.updatedAt.toISOString(),
    };
  }

  private async assertFolder(orgId: string, projectId: string, folderId: string) {
    const folder = await this.prisma.projectDocumentFolder.findFirst({
      where: { id: folderId, projectId, organizationId: orgId },
    });
    if (!folder) throw new NotFoundException('Dossier introuvable');
    return folder;
  }

  /** Unicité douce du nom parmi les frères (insensible à la casse). */
  private async assertFolderNameFree(
    orgId: string,
    projectId: string,
    parentId: string | null,
    name: string,
    excludeId?: string,
  ) {
    const dup = await this.prisma.projectDocumentFolder.findFirst({
      where: {
        projectId,
        organizationId: orgId,
        parentId,
        name: { equals: name, mode: 'insensitive' },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (dup) throw new ConflictException(`Un dossier « ${name} » existe déjà à cet emplacement.`);
  }

  /** Liste plate des dossiers du projet — l'UI construit l'arbre. */
  async listFolders(orgId: string, projectId: string, userId: string, isAdmin: boolean) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    const folders = await this.prisma.projectDocumentFolder.findMany({
      where: { projectId, organizationId: orgId },
      orderBy: { name: 'asc' },
    });
    const aiFolderIds = effectiveAiFolderIds(folders);
    return folders.map((f) => this.serializeFolder(f, aiFolderIds));
  }

  async createFolder(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    dto: { name: string; parentId?: string | null; aiContext?: boolean },
  ) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Nom de dossier requis');
    const parentId = dto.parentId ?? null;
    if (parentId) await this.assertFolder(orgId, projectId, parentId);
    await this.assertFolderNameFree(orgId, projectId, parentId, name);
    const folder = await this.prisma.projectDocumentFolder.create({
      data: {
        organizationId: orgId,
        projectId,
        parentId,
        name: name.slice(0, 120),
        aiContext: dto.aiContext === true,
      },
    });
    return this.serializeFolder(folder, await this.aiFolderIdsFor(orgId, projectId));
  }

  async updateFolder(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    folderId: string,
    dto: { name?: string; parentId?: string | null; aiContext?: boolean },
  ) {
    await this.findOne(orgId, projectId, userId, isAdmin);
    const folder = await this.assertFolder(orgId, projectId, folderId);
    const data: { name?: string; parentId?: string | null; aiContext?: boolean } = {};
    if (dto.aiContext !== undefined) data.aiContext = dto.aiContext;
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Nom de dossier requis');
      data.name = name.slice(0, 120);
    }
    if (dto.parentId !== undefined) {
      const newParent = dto.parentId ?? null;
      if (newParent === folderId) {
        throw new BadRequestException('Un dossier ne peut pas être son propre parent.');
      }
      if (newParent) {
        await this.assertFolder(orgId, projectId, newParent);
        // Anti-cycle : le nouveau parent ne doit pas être un descendant du
        // dossier déplacé (remontée de la chaîne des parents, garde-fou 100).
        let cursor: string | null = newParent;
        const seen = new Set<string>();
        while (cursor && !seen.has(cursor) && seen.size < 100) {
          if (cursor === folderId) {
            throw new BadRequestException(
              'Impossible de déplacer un dossier dans un de ses sous-dossiers.',
            );
          }
          seen.add(cursor);
          const parent: { parentId: string | null } | null =
            await this.prisma.projectDocumentFolder.findFirst({
              where: { id: cursor, projectId },
              select: { parentId: true },
            });
          cursor = parent?.parentId ?? null;
        }
      }
      data.parentId = newParent;
    }
    // Unicité vérifiée à l'emplacement final (nouveau parent et/ou nouveau nom).
    const finalParent = data.parentId !== undefined ? data.parentId : folder.parentId;
    const finalName = data.name ?? folder.name;
    await this.assertFolderNameFree(orgId, projectId, finalParent, finalName, folderId);
    const updated = await this.prisma.projectDocumentFolder.update({
      where: { id: folderId },
      data,
    });
    return this.serializeFolder(updated, await this.aiFolderIdsFor(orgId, projectId));
  }

  /** Suppression : le contenu (documents + sous-dossiers) REMONTE au parent. */
  async deleteFolder(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    folderId: string,
  ): Promise<{ removed: true }> {
    await this.findOne(orgId, projectId, userId, isAdmin);
    const folder = await this.assertFolder(orgId, projectId, folderId);
    await this.prisma.$transaction([
      this.prisma.projectDocument.updateMany({
        where: { folderId, projectId },
        data: { folderId: folder.parentId },
      }),
      this.prisma.projectDocumentFolder.updateMany({
        where: { parentId: folderId, projectId },
        data: { parentId: folder.parentId },
      }),
      this.prisma.projectDocumentFolder.delete({ where: { id: folderId } }),
    ]);
    return { removed: true };
  }

  /** Déplacement (folderId, null = racine) et/ou toggle « Contexte IA ». */
  /**
   * Remplace le **contenu texte** d'un document existant, en place (même clé
   * S3, donc même id et mêmes liens). Sert au maintien d'un contexte IA vivant :
   * l'assistant réécrit la note plutôt que d'empiler des versions homonymes.
   *
   * Refuse les documents **non textuels** : on ne remplace pas un PDF ou un
   * tableur par une chaîne de caractères. Le type MIME d'origine est conservé —
   * cette route ne change pas la nature du document, seulement son contenu.
   */
  async replaceDocumentText(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    docId: string,
    content: string,
  ) {
    const doc = await this.getDocumentRaw(orgId, projectId, userId, isAdmin, docId);
    if (!doc.mimeType.startsWith('text/') && doc.mimeType !== 'application/json') {
      throw new BadRequestException(
        `Ce document n'est pas textuel (${doc.mimeType}) : son contenu ne peut pas être remplacé par du texte.`,
      );
    }
    const buf = Buffer.from(content, 'utf8');
    await this.s3.putObject(this.s3.buckets.charters, doc.storageKey, buf, doc.mimeType);
    const updated = await this.prisma.projectDocument.update({
      where: { id: docId },
      // `contentUpdatedAt` : sans lui, une note réécrite continuait d'afficher
      // la date de son PREMIER dépôt — la fraîcheur montrée était fausse.
      data: { sizeBytes: buf.byteLength, contentUpdatedAt: new Date() },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    return this.serializeDoc(updated, await this.aiFolderIdsFor(orgId, projectId));
  }

  /**
   * Dépôt d'une note TEXTE, en **upsert par nom** : si une note textuelle du
   * même nom existe déjà dans le dossier cible, son contenu est remplacé au lieu
   * de créer un homonyme.
   *
   * C'est ce qui empêche un agent sans `docId` d'empiler « decisions-archi.md »
   * à chaque passage — l'empilement dégradait le contexte de tous les agents
   * suivants (la description du tool MCP le déconseillait déjà en langue
   * naturelle, sans que rien ne l'applique).
   *
   * Le `mimeType` du document remplacé est CONSERVÉ : renommer une note en
   * `.json` ne doit pas changer la nature du document sous les pieds des agents.
   */
  async upsertTextDocument(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    input: {
      filename: string;
      mimeType: string;
      content: string;
      kind: ProjectDocumentKind;
      folderId?: string | null;
      aiContext?: boolean;
      onDuplicate?: OnDuplicate;
      /** Fabrique la clé S3 d'une création (le controller connaît la convention). */
      storageKeyFor: (storedName: string) => string;
    },
  ) {
    await this.findOne(orgId, projectId, userId, isAdmin);

    const filename = sanitizeDocName(input.filename);
    if (!filename) throw new BadRequestException('Nom de document requis');

    // Dossier cible : celui demandé, sinon l'unique dossier « Contexte IA »
    // racine s'il en existe un (et un seul), sinon la racine.
    let folderId = input.folderId ?? null;
    if (folderId) {
      await this.assertFolder(orgId, projectId, folderId);
    } else {
      const folders = await this.prisma.projectDocumentFolder.findMany({
        where: { projectId, organizationId: orgId },
        select: { id: true, parentId: true, aiContext: true },
      });
      folderId = defaultContextFolderId(folders);
    }

    const buf = Buffer.from(input.content, 'utf8');
    const existing = await this.prisma.projectDocument.findMany({
      where: { projectId, organizationId: orgId, folderId },
      select: {
        id: true,
        filename: true,
        folderId: true,
        mimeType: true,
        uploadedAt: true,
        storageKey: true,
      },
    });
    const match = findDuplicateTextDoc(existing, filename, folderId, input.onDuplicate);

    if (match) {
      const target = existing.find((d) => d.id === match.target.id)!;
      await this.s3.putObject(this.s3.buckets.charters, target.storageKey, buf, target.mimeType);
      const updated = await this.prisma.projectDocument.update({
        where: { id: target.id },
        data: {
          sizeBytes: buf.byteLength,
          contentUpdatedAt: new Date(),
          uploadedById: userId,
          ...(input.aiContext !== undefined ? { aiContext: input.aiContext } : {}),
        },
        include: { uploadedBy: { select: { id: true, name: true } } },
      });
      return {
        ...this.serializeDoc(updated, await this.aiFolderIdsFor(orgId, projectId)),
        replaced: true,
        /** > 1 = des homonymes préexistaient : ménage à faire côté humain. */
        duplicates: match.duplicates,
      };
    }

    const storageKey = input.storageKeyFor(filename);
    await this.s3.putObject(this.s3.buckets.charters, storageKey, buf, input.mimeType);
    const created = await this.prisma.projectDocument.create({
      data: {
        organizationId: orgId,
        projectId,
        kind: input.kind,
        folderId,
        aiContext: input.aiContext !== false,
        filename,
        mimeType: input.mimeType,
        sizeBytes: buf.byteLength,
        storageKey,
        uploadedById: userId,
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    return {
      ...this.serializeDoc(created, await this.aiFolderIdsFor(orgId, projectId)),
      replaced: false,
      duplicates: 0,
    };
  }

  async updateDocument(
    orgId: string,
    projectId: string,
    userId: string,
    isAdmin: boolean,
    docId: string,
    dto: { folderId?: string | null; aiContext?: boolean },
  ) {
    await this.getDocumentRaw(orgId, projectId, userId, isAdmin, docId);
    if (dto.folderId != null) await this.assertFolder(orgId, projectId, dto.folderId);
    const updated = await this.prisma.projectDocument.update({
      where: { id: docId },
      data: {
        ...(dto.folderId !== undefined ? { folderId: dto.folderId } : {}),
        ...(dto.aiContext !== undefined ? { aiContext: dto.aiContext } : {}),
      },
      include: { uploadedBy: { select: { id: true, name: true } } },
    });
    return this.serializeDoc(updated, await this.aiFolderIdsFor(orgId, projectId));
  }
}
