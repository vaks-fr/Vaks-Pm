import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AGENT_CAPABILITY_KEYS,
  AGENT_TRUST_LEVELS,
  AgentDto,
  CreateAgentDto,
  RegisterAgentDto,
  UpdateAgentDto,
  UpdateAgentCostProfileDto,
  WorkspaceAgentDto,
  WorkspaceAgentsPageDto,
  WorkspaceAgentDetailDto,
  WorkspaceAgentProjectDto,
  KNOWN_AGENT_MODELS,
  permissionsForCapabilities,
  billingUnitForProvider,
} from '@vaks-pm/shared';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../admin/roles.service';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { LicenseService } from '../licensing/license.service';
import { RemoteAgent } from './agent-directory.types';
import { ModelPricingService } from './model-pricing/model-pricing.service';

/** Acteur d'une mutation (audit). */
export interface AgentMutationActor {
  id?: string;
  email?: string | null;
  /** 'USER' (session admin) ou 'API_TOKEN' (clé org — POST /agents). */
  actorType?: 'USER' | 'API_TOKEN';
}

/** Domaine réservé aux comptes agents — motif `.invalid` (RFC 2606), comme rgpd.util. */
export const AGENT_EMAIL_DOMAIN = 'agents.invalid';

/** TTL par défaut d'un jeton d'agent : 90 jours (décision 2026-07-01). */
const DEFAULT_TOKEN_TTL_DAYS = 90;

const VALID_CAPABILITIES = new Set<string>(AGENT_CAPABILITY_KEYS);
const VALID_TRUST = new Set<string>(AGENT_TRUST_LEVELS);

/** Champs sélectionnés pour construire un AgentDto. */
const AGENT_SELECT = {
  id: true, email: true, name: true, status: true, trustLevel: true,
  ownerId: true, capabilities: true, maxConcurrentTasks: true, dailyRunBudget: true,
  modelProvider: true, model: true, hostingRegion: true,
  costRateInPerKTokens: true, costRateOutPerKTokens: true, defaultBillRatePerKTokens: true,
  followCatalogPricing: true,
  dailyCostBudget: true, monthlyCostBudget: true,
  idpSource: true, externalId: true, createdAt: true,
  owner: { select: { name: true, email: true } },
} as const;

type AgentRow = {
  id: string; email: string; name: string; status: string; trustLevel: string | null;
  ownerId: string | null; capabilities: string[];
  maxConcurrentTasks: number | null; dailyRunBudget: number | null;
  modelProvider: string | null; model: string | null; hostingRegion: string | null;
  costRateInPerKTokens: unknown; costRateOutPerKTokens: unknown; defaultBillRatePerKTokens: unknown;
  followCatalogPricing: boolean;
  dailyCostBudget: unknown; monthlyCostBudget: unknown;
  idpSource: string | null; externalId: string | null; createdAt: Date;
  owner: { name: string; email: string } | null;
};

@Injectable()
export class AgentsService {
  private readonly log = new Logger(AgentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly apiTokens: ApiTokensService,
    private readonly audit: AuditLogService,
    private readonly licenses: LicenseService,
    private readonly modelPricing: ModelPricingService,
  ) {}

  // ---------- Helpers ----------

  private toDto(r: AgentRow): AgentDto {
    const dec = (v: unknown): number | null => (v == null ? null : Number(v));
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      status: r.status as AgentDto['status'],
      trustLevel: (r.trustLevel ?? 'DRAFT_ONLY') as AgentDto['trustLevel'],
      ownerId: r.ownerId ?? '',
      ownerName: r.owner?.name ?? null,
      ownerEmail: r.owner?.email ?? null,
      capabilities: r.capabilities ?? [],
      maxConcurrentTasks: r.maxConcurrentTasks,
      dailyRunBudget: r.dailyRunBudget,
      modelProvider: r.modelProvider,
      model: r.model,
      hostingRegion: r.hostingRegion,
      billingUnit: billingUnitForProvider(r.modelProvider),
      costRateInPerKTokens: dec(r.costRateInPerKTokens),
      costRateOutPerKTokens: dec(r.costRateOutPerKTokens),
      defaultBillRatePerKTokens: dec(r.defaultBillRatePerKTokens),
      followCatalogPricing: r.followCatalogPricing ?? false,
      dailyCostBudget: dec(r.dailyCostBudget),
      monthlyCostBudget: dec(r.monthlyCostBudget),
      source: r.idpSource ?? 'manual',
      externalId: r.externalId,
      createdAt: r.createdAt.toISOString(),
    };
  }

  /** `agent-<slug>@agents.invalid`, unique par org (suffixe -2, -3… si collision). */
  private async uniqueAgentEmail(orgId: string, name: string): Promise<string> {
    const slug =
      name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
    for (let i = 0; i < 50; i++) {
      const email = `agent-${slug}${i === 0 ? '' : `-${i + 1}`}@${AGENT_EMAIL_DOMAIN}`;
      const dup = await this.prisma.user.findFirst({
        where: { organizationId: orgId, email },
        select: { id: true },
      });
      if (!dup) return email;
    }
    // Improbable : 50 collisions — suffixe aléatoire.
    return `agent-${slug}-${Date.now().toString(36)}@${AGENT_EMAIL_DOMAIN}`;
  }

  /** Résout et valide l'owner : humain ACTIF de l'org (obligatoire pour tout agent). */
  private async assertOwner(orgId: string, ownerId: string): Promise<void> {
    const owner = await this.prisma.user.findFirst({
      where: { id: ownerId, organizationId: orgId, deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
      select: { id: true },
    });
    if (!owner) {
      throw new BadRequestException(
        "Owner invalide : un agent doit être rattaché à un humain ACTIF de l'organisation.",
      );
    }
  }

  private sanitizeCapabilities(caps?: string[]): string[] | undefined {
    if (caps === undefined) return undefined;
    const bad = caps.filter((c) => !VALID_CAPABILITIES.has(c));
    if (bad.length) throw new BadRequestException(`Capability(ies) inconnue(s) : ${bad.join(', ')}`);
    return [...new Set(caps)];
  }

  private sanitizeTrust(level?: string): string | undefined {
    if (level === undefined) return undefined;
    if (!VALID_TRUST.has(level)) throw new BadRequestException(`trustLevel invalide : ${level}`);
    return level;
  }

  /** Champs numériques de budget/profil, normalisés (null = effacer). */
  private profileData(dto: Partial<CreateAgentDto>): Record<string, unknown> {
    const num = (v: number | null | undefined) =>
      v === undefined ? undefined : v === null ? null : Number(v);
    return {
      maxConcurrentTasks: dto.maxConcurrentTasks === undefined ? undefined : dto.maxConcurrentTasks,
      dailyRunBudget: dto.dailyRunBudget === undefined ? undefined : dto.dailyRunBudget,
      modelProvider: dto.modelProvider === undefined ? undefined : dto.modelProvider || null,
      model: dto.model === undefined ? undefined : dto.model || null,
      hostingRegion: dto.hostingRegion === undefined ? undefined : dto.hostingRegion || null,
      costRateInPerKTokens: num(dto.costRateInPerKTokens),
      costRateOutPerKTokens: num(dto.costRateOutPerKTokens),
      defaultBillRatePerKTokens: num(dto.defaultBillRatePerKTokens),
      followCatalogPricing:
        dto.followCatalogPricing === undefined ? undefined : dto.followCatalogPricing === true,
      dailyCostBudget: num(dto.dailyCostBudget),
      monthlyCostBudget: num(dto.monthlyCostBudget),
    };
  }

  /**
   * En unité crédits (Copilot), il n'y a pas de sortie facturée séparément :
   * on force `costRateOutPerKTokens = null` pour qu'un taux résiduel ne fausse
   * pas `derivedCost` (formule `tokensIn×in + tokensOut×out`, out toujours 0).
   * Mute `data` en place. `effectiveProvider` = provider après application du dto.
   */
  private normalizeCreditRates(data: Record<string, unknown>, effectiveProvider?: string | null) {
    if (billingUnitForProvider(effectiveProvider) === 'credits') {
      data.costRateOutPerKTokens = null;
    }
  }

  private async findAgentOrThrow(orgId: string, id: string) {
    const agent = await this.prisma.user.findFirst({
      where: { id, organizationId: orgId, kind: 'AGENT', deletedAt: null },
      select: AGENT_SELECT,
    });
    if (!agent) throw new NotFoundException('Agent introuvable');
    return agent as unknown as AgentRow;
  }

  private auditAgent(
    orgId: string,
    action: string,
    agent: { id: string; name: string; ownerId?: string | null },
    actor: AgentMutationActor,
    detail?: Record<string, unknown>,
  ): void {
    void this.audit.logCritical({
      organizationId: orgId,
      action,
      actorType: actor.actorType ?? 'USER',
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'agent',
      resourceId: agent.id,
      resourceLabel: agent.name,
      detail: { ...(detail ?? {}), ...(agent.ownerId ? { ownerId: agent.ownerId } : {}) },
    });
  }

  // ---------- Lecture ----------

  async list(orgId: string): Promise<AgentDto[]> {
    const rows = await this.prisma.user.findMany({
      where: { organizationId: orgId, kind: 'AGENT', deletedAt: null },
      select: AGENT_SELECT,
      orderBy: { name: 'asc' },
    });
    const dtos = (rows as unknown as AgentRow[]).map((r) => this.toDto(r));
    // Jetons actifs par agent (métadonnées seulement) — pas de relation Prisma
    // sur ApiToken (scalaire), donc une requête groupée.
    const tokens = await this.prisma.apiToken.findMany({
      where: {
        organizationId: orgId, type: 'USER', revokedAt: null,
        userId: { in: dtos.map((d) => d.id) },
      },
      select: { id: true, userId: true, name: true, prefix: true, expiresAt: true, lastUsedAt: true },
      orderBy: { createdAt: 'desc' },
    });
    const byAgent = new Map<string, NonNullable<AgentDto['tokens']>>();
    for (const t of tokens) {
      if (!t.userId) continue;
      const list = byAgent.get(t.userId) ?? [];
      list.push({
        id: t.id, name: t.name, prefix: t.prefix,
        expiresAt: t.expiresAt ? t.expiresAt.toISOString() : null,
        lastUsedAt: t.lastUsedAt ? t.lastUsedAt.toISOString() : null,
      });
      byAgent.set(t.userId, list);
    }
    // Lot 2 — joint le prix catalogue résolu + le flag de drift (une lecture).
    const enriched = await this.modelPricing.enrichAgentsWithCatalog(orgId, dtos);
    return enriched.map((d) => ({
      ...d,
      tokens: byAgent.get(d.id) ?? [],
      catalogPrice:
        d.catalogPrice && d.catalogPrice.costInPerKUnits != null
          ? {
              unit: d.catalogPrice.unit,
              costInPerKUnits: d.catalogPrice.costInPerKUnits,
              costOutPerKUnits: d.catalogPrice.costOutPerKUnits,
              source: d.catalogPrice.source,
            }
          : null,
      priceDrift: d.priceDrift,
    }));
  }

  /**
   * Agents visibles par un **utilisateur** dans le workspace (`GET /me/agents`) :
   * ceux dont il est **owner** + ceux qui sont membres d'une **équipe qu'il
   * mène** (TeamMember.isLead). Vue allégée (sans jetons ni budgets), paginée.
   * Self-scoped — jamais d'id en paramètre.
   */
  async listForUser(
    orgId: string,
    userId: string,
    page = 1,
    pageSize = 10,
  ): Promise<WorkspaceAgentsPageDto> {
    const ps = Math.min(50, Math.max(1, Math.floor(pageSize) || 10));
    const pg = Math.max(1, Math.floor(page) || 1);

    // Équipes menées par l'utilisateur → agents membres de ces équipes.
    const leadTeams = await this.prisma.teamMember.findMany({
      where: { userId, isLead: true, team: { organizationId: orgId, deletedAt: null } },
      select: { teamId: true },
    });
    const teamAgentIds: string[] = [];
    const teamsByAgent = new Map<string, string[]>();
    if (leadTeams.length) {
      const rows = await this.prisma.teamMember.findMany({
        where: {
          teamId: { in: leadTeams.map((t) => t.teamId) },
          user: { kind: 'AGENT', deletedAt: null },
        },
        select: { userId: true, team: { select: { name: true } } },
      });
      for (const r of rows) {
        teamAgentIds.push(r.userId);
        const arr = teamsByAgent.get(r.userId) ?? [];
        arr.push(r.team.name);
        teamsByAgent.set(r.userId, arr);
      }
    }

    const where = {
      organizationId: orgId,
      kind: 'AGENT' as const,
      deletedAt: null,
      OR: [{ ownerId: userId }, { id: { in: [...new Set(teamAgentIds)] } }],
    };
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        select: {
          id: true, name: true, email: true, status: true, trustLevel: true, ownerId: true,
          model: true, modelProvider: true, capabilities: true,
          owner: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
        skip: (pg - 1) * ps,
        take: ps,
      }),
    ]);

    // Compétences des agents de la page (ce qu'ils savent faire).
    const ids = rows.map((r) => r.id);
    const skills = ids.length
      ? await this.prisma.userSkill.findMany({
          where: { userId: { in: ids } },
          select: { userId: true, skillId: true, level: true, skill: { select: { name: true } } },
        })
      : [];
    const skillsByAgent = new Map<string, WorkspaceAgentDto['skills']>();
    for (const s of skills) {
      const arr = skillsByAgent.get(s.userId) ?? [];
      arr.push({ skillId: s.skillId, name: s.skill?.name ?? s.skillId, level: s.level });
      skillsByAgent.set(s.userId, arr);
    }

    const items: WorkspaceAgentDto[] = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      status: r.status as WorkspaceAgentDto['status'],
      trustLevel: (r.trustLevel ?? 'DRAFT_ONLY') as WorkspaceAgentDto['trustLevel'],
      ownerId: r.ownerId ?? '',
      ownerName: r.owner?.name ?? null,
      model: r.model,
      modelProvider: r.modelProvider,
      billingUnit: billingUnitForProvider(r.modelProvider),
      capabilities: r.capabilities ?? [],
      skills: skillsByAgent.get(r.id) ?? [],
      linkedAsOwner: r.ownerId === userId,
      linkedTeams: teamsByAgent.get(r.id) ?? [],
    }));
    return { items, total, page: pg, pageSize: ps };
  }

  /**
   * Charge un agent SI l'utilisateur y a accès (owner OU lead d'une équipe dont
   * l'agent est membre). 404 si l'agent n'existe pas, 403 sinon. Renvoie l'agent
   * + le contexte de lien (owner ? équipes menées le contenant).
   */
  private async loadAccessibleAgent(orgId: string, callerId: string, agentId: string) {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId, kind: 'AGENT', deletedAt: null },
      select: {
        id: true, name: true, email: true, status: true, trustLevel: true, ownerId: true,
        model: true, modelProvider: true, capabilities: true,
        owner: { select: { name: true } },
      },
    });
    if (!agent) throw new NotFoundException('Agent introuvable');
    const isOwner = agent.ownerId === callerId;
    const ledTeams = await this.prisma.teamMember.findMany({
      where: {
        userId: callerId, isLead: true,
        team: { organizationId: orgId, deletedAt: null, members: { some: { userId: agentId } } },
      },
      select: { team: { select: { name: true } } },
    });
    const teams = ledTeams.map((t) => t.team.name);
    if (!isOwner && teams.length === 0) {
      throw new ForbiddenException("Vous n'avez pas accès à cet agent.");
    }
    return { agent, isOwner, teams };
  }

  /** Détail d'un agent pour l'owner/lead : profil + compétences + usage + projets. */
  async getDetailForUser(
    orgId: string,
    callerId: string,
    agentId: string,
  ): Promise<WorkspaceAgentDetailDto> {
    const { agent, isOwner, teams } = await this.loadAccessibleAgent(orgId, callerId, agentId);

    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);
    const [skillRows, runAgg, monthAgg, byTask, projects] = await Promise.all([
      this.prisma.userSkill.findMany({
        where: { userId: agentId },
        select: { skillId: true, level: true, skill: { select: { name: true } } },
      }),
      this.prisma.agentRun.aggregate({
        where: { organizationId: orgId, agentId },
        _count: { _all: true },
        _sum: { cost: true, tokensIn: true, tokensOut: true },
      }),
      this.prisma.agentRun.aggregate({
        where: { organizationId: orgId, agentId, createdAt: { gte: monthStart } },
        _sum: { cost: true },
      }),
      this.prisma.agentRun.groupBy({
        by: ['taskId'],
        where: { organizationId: orgId, agentId, taskId: { not: null } },
        _sum: { cost: true },
      }),
      this.agentProjects(orgId, agentId),
    ]);

    const runCount = runAgg._count._all;
    const usage = runCount
      ? {
          runCount,
          totalCost: Number(runAgg._sum.cost ?? 0),
          monthlyCost: Number(monthAgg._sum.cost ?? 0),
          totalTokens: (runAgg._sum.tokensIn ?? 0) + (runAgg._sum.tokensOut ?? 0),
          avgCostPerTask: byTask.length
            ? byTask.reduce((a, g) => a + Number(g._sum.cost ?? 0), 0) / byTask.length
            : null,
        }
      : null;

    return {
      id: agent.id,
      name: agent.name,
      email: agent.email,
      status: agent.status as WorkspaceAgentDetailDto['status'],
      trustLevel: (agent.trustLevel ?? 'DRAFT_ONLY') as WorkspaceAgentDetailDto['trustLevel'],
      ownerId: agent.ownerId ?? '',
      ownerName: agent.owner?.name ?? null,
      model: agent.model,
      modelProvider: agent.modelProvider,
      billingUnit: billingUnitForProvider(agent.modelProvider),
      capabilities: agent.capabilities ?? [],
      skills: skillRows.map((s) => ({ skillId: s.skillId, name: s.skill?.name ?? s.skillId, level: s.level })),
      linkedAsOwner: isOwner,
      linkedTeams: teams,
      usage,
      projects,
    };
  }

  /** Projets sur lesquels l'agent est affecté : membre direct + projets où il a
   *  des tâches assignées non terminées (compte affiché). */
  private async agentProjects(orgId: string, agentId: string): Promise<WorkspaceAgentProjectDto[]> {
    const [memberProjects, taskCounts] = await Promise.all([
      this.prisma.projectMember.findMany({
        where: {
          userId: agentId,
          project: {
            organizationId: orgId, deletedAt: null, kind: 'STANDARD', status: 'ACTIVE',
          },
        },
        select: { project: { select: { id: true, key: true, name: true, status: true } } },
      }),
      this.prisma.task.groupBy({
        by: ['projectId'],
        where: {
          organizationId: orgId, deletedAt: null,
          status: { not: 'DONE' },
          assignees: { some: { userId: agentId } },
          project: { status: 'ACTIVE' },
        },
        _count: { _all: true },
      }),
    ]);
    const active = new Map<string, number>();
    for (const g of taskCounts) active.set(g.projectId, g._count._all);
    const byId = new Map<string, WorkspaceAgentProjectDto>();
    for (const m of memberProjects) {
      byId.set(m.project.id, {
        id: m.project.id, key: m.project.key, name: m.project.name,
        status: m.project.status, activeTasks: active.get(m.project.id) ?? 0,
      });
    }
    const missing = [...active.keys()].filter((id) => !byId.has(id));
    if (missing.length) {
      const projs = await this.prisma.project.findMany({
        where: { id: { in: missing }, organizationId: orgId, deletedAt: null, status: 'ACTIVE' },
        select: { id: true, key: true, name: true, status: true },
      });
      for (const p of projs) byId.set(p.id, { ...p, activeTasks: active.get(p.id) ?? 0 });
    }
    return [...byId.values()].sort((a, b) => b.activeTasks - a.activeTasks || a.name.localeCompare(b.name));
  }

  /** L'owner/lead change le MODÈLE de l'agent (provider inchangé). Le modèle doit
   *  appartenir au catalogue connu — et, si l'agent a un provider, à ce provider. */
  async updateModelForUser(orgId: string, callerId: string, agentId: string, model: string | null) {
    const { agent } = await this.loadAccessibleAgent(orgId, callerId, agentId);
    const m = (model ?? '').trim();
    if (m) {
      const match = KNOWN_AGENT_MODELS.find((k) => k.model === m);
      if (!match) throw new BadRequestException(`Modèle inconnu : ${m}`);
      if (agent.modelProvider && match.provider !== agent.modelProvider) {
        throw new BadRequestException(
          `Le modèle ${m} n'appartient pas au provider ${agent.modelProvider}.`,
        );
      }
    }
    await this.prisma.user.update({ where: { id: agentId }, data: { model: m || null } });
    void this.audit.log({
      organizationId: orgId,
      action: 'agent.model_updated',
      severity: 'INFO',
      actorType: 'USER',
      actorId: callerId,
      resourceType: 'agent',
      resourceId: agentId,
      detail: { model: m || null, by: 'owner_or_lead' },
    });
    return this.getDetailForUser(orgId, callerId, agentId);
  }

  /** L'owner/lead pose/met à jour une compétence de l'agent (niveau 1..10). */
  async setSkillForUser(
    orgId: string,
    callerId: string,
    agentId: string,
    skillId: string,
    level: number,
  ) {
    await this.loadAccessibleAgent(orgId, callerId, agentId);
    const skill = await this.prisma.skill.findFirst({
      where: { id: skillId, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    if (!skill) throw new BadRequestException('Compétence introuvable.');
    const lvl = Math.max(1, Math.min(10, Math.floor(level) || 1));
    await this.prisma.userSkill.upsert({
      where: { userId_skillId: { userId: agentId, skillId } },
      create: { userId: agentId, skillId, level: lvl, setById: callerId },
      update: { level: lvl, setById: callerId },
    });
    return this.getDetailForUser(orgId, callerId, agentId);
  }

  /** L'owner/lead retire une compétence de l'agent. */
  async removeSkillForUser(orgId: string, callerId: string, agentId: string, skillId: string) {
    await this.loadAccessibleAgent(orgId, callerId, agentId);
    await this.prisma.userSkill.deleteMany({ where: { userId: agentId, skillId } });
    return this.getDetailForUser(orgId, callerId, agentId);
  }

  /** Catalogue des capabilities (clé + permissions mappées) pour l'UI. */
  listCapabilities(): { key: string }[] {
    return AGENT_CAPABILITY_KEYS.map((key) => ({ key }));
  }

  // ---------- Création / mise à jour ----------

  /**
   * Création manuelle (admin) — fallback on-premise et voie du pilote.
   * L'agent naît : `licensed=false` (aucun siège), sans mot de passe, login
   * local interdit, Membership ORG_MEMBER (le RBAC réel = ∩ capabilities).
   */
  async create(orgId: string, dto: CreateAgentDto, actor: AgentMutationActor): Promise<AgentDto> {
    const name = dto.name?.trim();
    if (!name) throw new BadRequestException('Nom requis');
    if (!dto.ownerId) throw new BadRequestException('ownerId requis (owner humain obligatoire)');
    // Quota freemium : borne le NOMBRE d'identités agents (5 gratuites, illimité
    // sous licence `agents`). Ne touche pas l'opération des agents existants.
    await this.licenses.assertAgentSlotAvailable(orgId, 1);
    await this.assertOwner(orgId, dto.ownerId);
    const capabilities = this.sanitizeCapabilities(dto.capabilities) ?? [];
    const trustLevel = this.sanitizeTrust(dto.trustLevel) ?? 'DRAFT_ONLY';
    const email = await this.uniqueAgentEmail(orgId, name);
    const role = await this.roles.findByKey(orgId, 'ORG_MEMBER').catch(() => null);

    const profile = this.profileData(dto);
    this.normalizeCreditRates(profile, dto.modelProvider);
    const created = await this.prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        name,
        kind: 'AGENT',
        trustLevel: trustLevel as never,
        ownerId: dto.ownerId,
        capabilities,
        passwordHash: null,
        isAdmin: false,
        licensed: false,
        allowLocalLogin: false,
        authProvider: 'LOCAL',
        idpSource: 'manual',
        createdVia: 'agent',
        status: 'ACTIVE',
        ...profile,
        memberships: role ? { create: { organizationId: orgId, roleId: role.id } } : undefined,
      },
      select: AGENT_SELECT,
    });
    const dtoOut = this.toDto(created as unknown as AgentRow);
    this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_CREATED, { id: dtoOut.id, name, ownerId: dto.ownerId }, actor, {
      source: 'manual', trustLevel, capabilities,
    });
    return dtoOut;
  }

  async update(orgId: string, id: string, dto: UpdateAgentDto, actor: AgentMutationActor): Promise<AgentDto> {
    const existing = await this.findAgentOrThrow(orgId, id);
    const data: Record<string, unknown> = { ...this.profileData(dto) };
    // Provider effectif après application du dto → normalise l'out en crédits.
    const effectiveProvider =
      dto.modelProvider !== undefined ? dto.modelProvider || null : existing.modelProvider;
    this.normalizeCreditRates(data, effectiveProvider);
    if (dto.name !== undefined) {
      const name = dto.name.trim();
      if (!name) throw new BadRequestException('Nom requis');
      data.name = name;
    }
    if (dto.ownerId !== undefined) {
      if (!dto.ownerId) throw new BadRequestException('Un agent doit toujours avoir un owner humain.');
      await this.assertOwner(orgId, dto.ownerId);
      data.ownerId = dto.ownerId;
    }
    const caps = this.sanitizeCapabilities(dto.capabilities);
    if (caps !== undefined) data.capabilities = caps;
    const trust = this.sanitizeTrust(dto.trustLevel);
    if (trust !== undefined) data.trustLevel = trust as never;
    if (dto.status !== undefined) {
      if (dto.status !== 'ACTIVE' && dto.status !== 'SUSPENDED') {
        throw new BadRequestException('status invalide');
      }
      data.status = dto.status;
    }

    const updated = await this.prisma.user.update({
      where: { id }, data, select: AGENT_SELECT,
    });
    const out = this.toDto(updated as unknown as AgentRow);

    const statusChanged = dto.status !== undefined && dto.status !== existing.status;
    if (statusChanged) {
      this.auditAgent(
        orgId,
        dto.status === 'SUSPENDED' ? AUDIT_ACTIONS.AGENT_SUSPENDED : AUDIT_ACTIONS.AGENT_REACTIVATED,
        { id, name: out.name, ownerId: out.ownerId },
        actor,
      );
    }
    // Diff minimal lisible (audit) — hors statut déjà tracé ci-dessus.
    const changes: Record<string, unknown> = {};
    for (const k of ['name', 'ownerId', 'capabilities', 'trustLevel'] as const) {
      if ((dto as Record<string, unknown>)[k] !== undefined) changes[k] = (dto as Record<string, unknown>)[k];
    }
    if (Object.keys(changes).length) {
      this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_UPDATED, { id, name: out.name, ownerId: out.ownerId }, actor, changes);
    }
    return out;
  }

  /** Soft-delete + révocation de tous les jetons de l'agent. */
  async remove(orgId: string, id: string, actor: AgentMutationActor): Promise<void> {
    const existing = await this.findAgentOrThrow(orgId, id);
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id },
        data: { deletedAt: new Date(), status: 'SUSPENDED' },
      }),
      this.prisma.apiToken.updateMany({
        where: { organizationId: orgId, type: 'USER', userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);
    this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_SUSPENDED, { id, name: existing.name, ownerId: existing.ownerId }, actor, {
      deleted: true,
    });
  }

  // ---------- Jetons ----------

  /**
   * Mint un PAT pour l'agent (règle « un jeton distinct par agent »).
   * TTL par défaut 90 j (max 2 ans hérité d'ApiTokensService). Le secret n'est
   * renvoyé qu'UNE fois.
   *
   * **Scopes = permissions dérivées des capabilities** (défense en profondeur :
   * le jeton ne porte jamais plus que ce que l'agent sait faire — et le serveur
   * MCP n'expose ses tools d'écriture que si le jeton porte les scopes
   * correspondants). Un `dto.scopes` explicite est intersecté avec ce plafond.
   * Le guard runtime ré-intersecte de toute façon avec les capabilities vivantes.
   */
  async mintToken(
    orgId: string,
    agentId: string,
    dto: { name?: string; expiresAt?: string | null; scopes?: string[] },
    actor: AgentMutationActor,
  ): Promise<{ id: string; token: string; prefix: string }> {
    const agent = await this.findAgentOrThrow(orgId, agentId);
    const expiresAt =
      dto.expiresAt ?? new Date(Date.now() + DEFAULT_TOKEN_TTL_DAYS * 86_400_000).toISOString();
    const capPerms = permissionsForCapabilities(agent.capabilities ?? []);
    const scopes = dto.scopes?.length
      ? dto.scopes.filter((s) => (capPerms as string[]).includes(s))
      : capPerms;
    const created = await this.apiTokens.create(orgId, 'USER', {
      userId: agentId,
      createdById: actor.id ?? agentId,
      dto: { name: dto.name?.trim() || `${agent.name} — token`, scopes, expiresAt },
    });
    this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_TOKEN_ISSUED, { id: agentId, name: agent.name, ownerId: agent.ownerId }, actor, {
      tokenId: created.id, prefix: created.prefix, expiresAt,
    });
    return created;
  }

  async revokeToken(orgId: string, agentId: string, tokenId: string, actor: AgentMutationActor): Promise<void> {
    const agent = await this.findAgentOrThrow(orgId, agentId);
    await this.apiTokens.revoke(orgId, tokenId, {
      type: 'USER', requireUserId: agentId, actorId: actor.id,
    });
    this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_TOKEN_REVOKED, { id: agentId, name: agent.name, ownerId: agent.ownerId }, actor, {
      tokenId,
    });
  }

  // ---------- Enregistrement entrant (POST /agents, clé org) ----------

  /**
   * Upsert idempotent sur `(idpSource='api', externalId)` — pour les
   * plateformes sans connecteur (self-hosted, LangGraph, n8n, CI…).
   * Garde-fous : l'agent arrive `DRAFT_ONLY`, capabilities lecture seule,
   * SANS jeton — le mint et l'élévation trust/capabilities restent app-privés
   * (humain dans l'UI). L'API déclare l'existence ; l'humain active.
   */
  async registerViaApi(
    orgId: string,
    dto: RegisterAgentDto,
    actor: AgentMutationActor,
  ): Promise<{ agent: AgentDto; created: boolean }> {
    const name = dto.name?.trim();
    const externalId = dto.externalId?.trim();
    const ownerEmail = dto.ownerEmail?.trim().toLowerCase();
    if (!name) throw new BadRequestException('name requis');
    if (!externalId) throw new BadRequestException('externalId requis');
    if (!ownerEmail) throw new BadRequestException('ownerEmail requis');
    const owner = await this.prisma.user.findFirst({
      where: {
        organizationId: orgId, email: ownerEmail,
        deletedAt: null, status: 'ACTIVE', kind: 'HUMAN',
      },
      select: { id: true },
    });
    if (!owner) {
      throw new BadRequestException(
        `ownerEmail introuvable : aucun humain actif « ${ownerEmail} » dans l'organisation.`,
      );
    }

    // Lookup SANS filtre `deletedAt` — cf. `syncFromDirectory` : une ligne
    // soft-deleted occupe le créneau unique `(organizationId, idpSource,
    // externalId)`, la filtrer ferait basculer sur le chemin création et
    // violerait la contrainte.
    const existing = await this.prisma.user.findFirst({
      where: { organizationId: orgId, kind: 'AGENT', idpSource: 'api', externalId },
      select: { id: true, deletedAt: true },
    });
    // Ré-enregistrer un agent supprimé ne le ressuscite pas : la suppression est
    // un acte d'admin (elle a révoqué tous ses jetons), et une clé org scopée
    // `agent:manage` ne doit pas pouvoir la défaire.
    if (existing?.deletedAt) {
      throw new ConflictException(
        "Un agent supprimé porte déjà cet identifiant externe. Réactivez-le depuis l'administration.",
      );
    }
    const profile = {
      ...(dto.modelProvider !== undefined ? { modelProvider: dto.modelProvider || null } : {}),
      ...(dto.model !== undefined ? { model: dto.model || null } : {}),
      ...(dto.hostingRegion !== undefined ? { hostingRegion: dto.hostingRegion || null } : {}),
    };

    if (existing) {
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: { name, ownerId: owner.id, ...profile },
        select: AGENT_SELECT,
      });
      const out = this.toDto(updated as unknown as AgentRow);
      this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_UPDATED, { id: out.id, name, ownerId: owner.id }, actor, {
        source: 'api', externalId, upsert: true,
      });
      return { agent: out, created: false };
    }

    // Branche INSERT uniquement (un upsert qui met à jour n'ajoute pas de slot) :
    // le quota freemium borne la création d'une nouvelle identité agent.
    await this.licenses.assertAgentSlotAvailable(orgId, 1);
    const role = await this.roles.findByKey(orgId, 'ORG_MEMBER').catch(() => null);
    const email = await this.uniqueAgentEmail(orgId, name);
    const created = await this.prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        name,
        kind: 'AGENT',
        trustLevel: 'DRAFT_ONLY',
        ownerId: owner.id,
        capabilities: ['read:project'],
        passwordHash: null,
        isAdmin: false,
        licensed: false,
        allowLocalLogin: false,
        authProvider: 'LOCAL',
        idpSource: 'api',
        externalId,
        createdVia: 'agent',
        status: 'ACTIVE',
        ...profile,
        memberships: role ? { create: { organizationId: orgId, roleId: role.id } } : undefined,
      },
      select: AGENT_SELECT,
    });
    const out = this.toDto(created as unknown as AgentRow);
    this.auditAgent(orgId, AUDIT_ACTIONS.AGENT_CREATED, { id: out.id, name, ownerId: owner.id }, actor, {
      source: 'api', externalId, trustLevel: 'DRAFT_ONLY',
    });
    return { agent: out, created: true };
  }

  /**
   * Met à jour le **profil de coût interne** d'un agent (`PATCH
   * /agents/cost-profile`, clé org `agent:manage`). Agent résolu par
   * `externalId` toutes sources confondues (optionnellement borné par
   * `idpSource`). **Coût interne uniquement** : le taux facturé client n'est
   * pas modifiable par ici (absent du DTO). Audité avec diff ancien→nouveau.
   */
  async updateCostProfileByExternalId(
    orgId: string,
    dto: UpdateAgentCostProfileDto,
    actor: AgentMutationActor,
  ): Promise<AgentDto> {
    const externalId = dto.externalId?.trim();
    if (!externalId) throw new BadRequestException('externalId requis');

    const hasIn = dto.costRateInPerKTokens !== undefined;
    const hasOut = dto.costRateOutPerKTokens !== undefined;
    if (!hasIn && !hasOut) {
      throw new BadRequestException(
        'Au moins un taux requis : costRateInPerKTokens ou costRateOutPerKTokens.',
      );
    }
    // Décimales ≥ 0 (Decimal(12,4) côté schéma) ; null = effacer le taux.
    const norm = (v: number | null | undefined, field: string): number | null | undefined => {
      if (v === undefined) return undefined;
      if (v === null) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        throw new BadRequestException(`${field} doit être un nombre ≥ 0.`);
      }
      return v;
    };
    const rateIn = norm(dto.costRateInPerKTokens, 'costRateInPerKTokens');
    const rateOut = norm(dto.costRateOutPerKTokens, 'costRateOutPerKTokens');

    // Résolution par externalId (idpSource optionnel pour désambiguïser). On ne
    // filtre PAS `deletedAt` d'emblée : on veut distinguer « supprimé » de
    // « introuvable » (message clair), mais on refuse d'écrire dessus.
    const matches = await this.prisma.user.findMany({
      where: {
        organizationId: orgId,
        kind: 'AGENT',
        externalId,
        ...(dto.idpSource ? { idpSource: dto.idpSource } : {}),
      },
      select: {
        id: true, name: true, ownerId: true, deletedAt: true, idpSource: true,
        costRateInPerKTokens: true, costRateOutPerKTokens: true,
      },
    });
    const live = matches.filter((m) => !m.deletedAt);
    if (live.length === 0) {
      if (matches.length > 0) {
        throw new ConflictException(
          "Un agent supprimé porte cet identifiant externe. Réactivez-le depuis l'administration.",
        );
      }
      throw new NotFoundException(`Aucun agent avec l'externalId « ${externalId} ».`);
    }
    if (live.length > 1) {
      const sources = [...new Set(live.map((m) => m.idpSource ?? 'null'))].join(', ');
      throw new ConflictException(
        `Plusieurs agents portent l'externalId « ${externalId} » (sources : ${sources}). ` +
          'Précisez idpSource pour désambiguïser.',
      );
    }
    const target = live[0];

    const data: Record<string, unknown> = {};
    if (rateIn !== undefined) data.costRateInPerKTokens = rateIn;
    if (rateOut !== undefined) data.costRateOutPerKTokens = rateOut;

    const dec = (v: unknown): number | null => (v == null ? null : Number(v));
    const before = {
      costRateInPerKTokens: dec(target.costRateInPerKTokens),
      costRateOutPerKTokens: dec(target.costRateOutPerKTokens),
    };

    const updated = await this.prisma.user.update({
      where: { id: target.id },
      data,
      select: AGENT_SELECT,
    });
    const out = this.toDto(updated as unknown as AgentRow);

    // Champ financier → audit avec diff ancien→nouveau explicite.
    this.auditAgent(
      orgId,
      AUDIT_ACTIONS.AGENT_COST_UPDATED,
      { id: target.id, name: target.name, ownerId: target.ownerId },
      actor,
      {
        source: 'api',
        externalId,
        before,
        after: {
          costRateInPerKTokens: out.costRateInPerKTokens ?? null,
          costRateOutPerKTokens: out.costRateOutPerKTokens ?? null,
        },
      },
    );
    return out;
  }

  // ---------- Sync connecteur (annuaire de plateforme) ----------

  /**
   * Upsert des agents énumérés par un connecteur. Clé `(idpSource=provider,
   * externalId)`. Désactivation plateforme → suspension vaks ; JAMAIS de
   * suppression. Owner : owner natif (email résolu) sinon defaultOwner du
   * connecteur — toujours requis (agents sans owner résolvable = ignorés).
   */
  async syncFromDirectory(
    orgId: string,
    provider: string,
    remote: RemoteAgent[],
    defaultOwnerId: string | null,
    actor: AgentMutationActor,
  ): Promise<{ created: number; updated: number; suspended: number; skipped: number; skippedOverLimit: number }> {
    let created = 0, updated = 0, suspended = 0, skipped = 0, skippedOverLimit = 0;
    const role = await this.roles.findByKey(orgId, 'ORG_MEMBER').catch(() => null);
    // Quota freemium : on borne la CRÉATION de nouvelles identités, mais un sync
    // ne doit jamais échouer en bloc — au-delà du plafond, on compte les agents
    // non créés dans `skippedOverLimit` (miroir souple du seat-pending SCIM).
    const cap = await this.licenses.agentLimit(); // null = illimité
    let used = cap == null ? 0 : await this.licenses.agentsUsed(orgId);

    for (const r of remote) {
      // Owner : natif d'abord, sinon défaut connecteur.
      let ownerId = defaultOwnerId;
      if (r.ownerEmail) {
        const nat = await this.prisma.user.findFirst({
          where: {
            organizationId: orgId, email: r.ownerEmail.toLowerCase(),
            deletedAt: null, status: 'ACTIVE', kind: 'HUMAN',
          },
          select: { id: true },
        });
        if (nat) ownerId = nat.id;
      }
      if (!ownerId) { skipped++; continue; }

      // Lookup SANS filtre `deletedAt` : une ligne soft-deleted occupe toujours
      // le créneau unique `(organizationId, idpSource, externalId)`, donc la
      // filtrer ferait basculer sur le chemin création → violation d'unicité.
      const existing = await this.prisma.user.findFirst({
        where: { organizationId: orgId, kind: 'AGENT', idpSource: provider, externalId: r.externalId },
        select: { id: true, status: true, deletedAt: true },
      });
      // Agent supprimé par un admin mais toujours présent dans l'annuaire : on
      // ne le ressuscite JAMAIS (la suppression est un acte délibéré, et
      // `remove()` a révoqué tous ses jetons). Le re-créer serait une porte
      // dérobée : il suffirait de laisser l'agent dans l'annuaire distant.
      if (existing?.deletedAt) { skipped++; continue; }
      if (existing) {
        const wantStatus = r.enabled ? 'ACTIVE' : 'SUSPENDED';
        await this.prisma.user.update({
          where: { id: existing.id },
          data: {
            name: r.displayName,
            status: wantStatus,
            ...(r.modelProvider ? { modelProvider: r.modelProvider } : {}),
            ...(r.model ? { model: r.model } : {}),
          },
        });
        if (wantStatus === 'SUSPENDED' && existing.status === 'ACTIVE') suspended++;
        else updated++;
        continue;
      }
      // Création d'une NOUVELLE identité : refusée en douceur au-delà du plafond.
      if (cap != null && used >= cap) { skippedOverLimit++; continue; }
      const email = await this.uniqueAgentEmail(orgId, r.displayName);
      await this.prisma.user.create({
        data: {
          organizationId: orgId,
          email,
          name: r.displayName,
          kind: 'AGENT',
          trustLevel: 'DRAFT_ONLY',
          ownerId,
          capabilities: ['read:project'],
          passwordHash: null,
          isAdmin: false,
          licensed: false,
          allowLocalLogin: false,
          authProvider: 'LOCAL',
          idpSource: provider,
          externalId: r.externalId,
          createdVia: 'agent',
          status: r.enabled ? 'ACTIVE' : 'SUSPENDED',
          ...(r.modelProvider ? { modelProvider: r.modelProvider } : {}),
          ...(r.model ? { model: r.model } : {}),
          memberships: role ? { create: { organizationId: orgId, roleId: role.id } } : undefined,
        },
      });
      created++;
      used++;
    }

    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_SYNCED,
      actorType: actor.actorType ?? 'USER',
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'agentConnector',
      resourceLabel: provider,
      detail: { provider, created, updated, suspended, skipped, skippedOverLimit },
    });
    this.log.log(
      `[agents] sync ${provider} (org=${orgId}): created=${created} updated=${updated} suspended=${suspended} skipped=${skipped} skippedOverLimit=${skippedOverLimit}`,
    );
    return { created, updated, suspended, skipped, skippedOverLimit };
  }
}
