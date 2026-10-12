import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { UserStatus } from '@db';
import * as argon2 from 'argon2';
import { RolesService } from '../admin/roles.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { PasswordPolicyService } from '../auth/password-policy.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS, severityForAction } from '../audit-logs/audit-actions';
import { LicenseService } from '../licensing/license.service';
import { anonEmail, anonLabel, isAnonymizedEmail, scrubJsonColumn } from '../common/rgpd.util';

/** Acteur d'une mutation admin (audit + garde anti-escalade). */
export interface UserMutationActor {
  isAdmin: boolean;
  id?: string;
  email?: string;
}

interface CreateUserInput {
  email: string;
  name: string;
  password?: string;
  isAdmin?: boolean;
  timezone?: string;
  status?: UserStatus;
  /** Clé du rôle org (Membership) : ORG_ADMIN, PORTFOLIO_MANAGER, ORG_MEMBER… */
  roleKey?: string;
  employeeId?: string | null;
  /** Attribuer un siège de licence. Défaut true (user « normal ») ; false pour
   *  un compte admin-only / sans siège. true ⇒ vérifie le plafond `maxUsers`. */
  licensed?: boolean;
}

interface UpdateUserInput {
  email?: string;
  name?: string;
  isAdmin?: boolean;
  timezone?: string;
  status?: UserStatus;
  password?: string;
  roleKey?: string;
  countryCode?: string | null;
  preferredLanguage?: string | null;
  employeeId?: string | null;
  /** Siège de licence : true→false libère le siège (et coupe les sessions),
   *  false→true en attribue un (vérifie le plafond `maxUsers`). */
  licensed?: boolean;
  /** Grant « AI administrator » (Membership.isAgentAdmin) : accorde `agent:manage`
   *  par-dessus le rôle org. Empilable, ne consomme pas le slot de rôle. */
  isAgentAdmin?: boolean;
}

/** Langues d'interface supportées (axe distinct de la locale de formatage). */
const SUPPORTED_LANGUAGES = ['en', 'fr', 'it', 'de'];

/** Normalise une langue d'UI : 'fr'/'fr-FR' → 'fr' si supportée, sinon null (hérite). */
function normalizeLanguage(input: string | null | undefined): string | null {
  if (!input) return null;
  const sub = String(input).trim().toLowerCase().split('-')[0];
  return SUPPORTED_LANGUAGES.includes(sub) ? sub : null;
}

const PUBLIC_SELECT = {
  id: true,
  email: true,
  name: true,
  kind: true,
  isAdmin: true,
  licensed: true,
  timezone: true,
  status: true,
  countryCode: true,
  preferredLanguage: true,
  employeeId: true,
  // Security fields — utiles à l'admin pour gérer break-glass / MFA / SSO.
  authProvider: true,
  allowLocalLogin: true,
  mfaEnabled: true,
  // Identité IdP (lecture seule côté admin) : `externalId` = clé stable de l'IdP
  // (objectId Entra / id SCIM), `idpSource` = origine du provisioning ('scim',
  // 'oidc', …). Affichés non modifiables sur les comptes SSO/SCIM.
  externalId: true,
  idpSource: true,
} as const;

/**
 * Sélection ALLÉGÉE pour le picker public `GET /users` (tout membre / PAT
 * `project:view`) : volontairement SANS les champs de posture sécurité/identité
 * (`mfaEnabled`, `allowLocalLogin`, `authProvider`, `externalId`, `idpSource`,
 * `employeeId`). Sinon un membre lambda (ou un jeton MCP) peut recenser l'annuaire
 * pour repérer les comptes les plus faibles (MFA off / login local autorisé) ou
 * moissonner les identifiants IdP/RH. Ces champs restent réservés à l'annuaire
 * admin `GET /users/directory` (`member:manage`, cf. `PUBLIC_SELECT`).
 * Audit sécu 2026-08-02.
 */
const PICKER_SELECT = {
  id: true,
  email: true,
  name: true,
  kind: true,
  isAdmin: true,
  licensed: true,
  timezone: true,
  status: true,
  countryCode: true,
  preferredLanguage: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly settings: AdminSettingsService,
    @Inject(forwardRef(() => PasswordPolicyService))
    private readonly policy: PasswordPolicyService,
    private readonly audit: AuditLogService,
    private readonly licenses: LicenseService,
  ) {}

  async findAllInOrg(orgId: string, opts?: { includeAgents?: boolean }) {
    // Humains seulement par défaut : les agents IA (kind=AGENT) ne polluent pas
    // les pickers (assignés, owners, mentions…) — ils vivent dans Admin > Agents.
    // `includeAgents` : opt-in des pickers d'AFFECTATION (équipes, projets) où
    // un agent est éligible « comme un humain » (AGENTS_ARCHITECTURE.md).
    const rows = await this.prisma.user.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        ...(opts?.includeAgents ? {} : { kind: 'HUMAN' as const }),
      },
      select: {
        ...PICKER_SELECT,
        // Owner d'un agent : alimente l'héritage owner→agent dans le picker
        // d'affectation (un agent assignable si son owner est membre du projet).
        // null pour les humains — aucune info sensible.
        ownerId: true,
        memberships: {
          where: { organizationId: orgId },
          select: { role: { select: { key: true, name: true } } },
          take: 1,
        },
      },
      orderBy: { name: 'asc' },
    });
    return rows.map((u) => {
      const { memberships, ...rest } = u;
      return {
        ...rest,
        roleKey: memberships[0]?.role.key ?? null,
        roleName: memberships[0]?.role.name ?? null,
      };
    });
  }

  /**
   * Annuaire admin **paginé** : remplace le `findAllInOrg` + N+1 de schedules
   * côté UI. Filtre serveur (search/status/role), pagination, et **batch** des
   * WorkSchedule (une seule requête pour toute la page, défaut org en fallback).
   */
  async findDirectory(
    orgId: string,
    opts: {
      search?: string;
      status?: UserStatus;
      role?: string;
      page?: number;
      pageSize?: number;
      includeSchedule?: boolean;
    },
  ) {
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(opts.pageSize ?? 50)));
    const search = opts.search?.trim();
    // Filtre commun (search + role), SANS le statut : sert aux compteurs
    // par statut (onglets Active / Suspended) indépendamment de la page.
    const baseWhere: Record<string, unknown> = {
      organizationId: orgId,
      deletedAt: null,
      // L'annuaire admin ne liste que les humains ; les agents IA ont leur
      // section dédiée (Admin > Agents) et ne consomment pas de siège.
      kind: 'HUMAN',
    };
    if (search) {
      baseWhere.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        { employeeId: { contains: search, mode: 'insensitive' } },
      ];
    }
    if (opts.role === 'TEAM_MANAGER') {
      // TEAM_MANAGER n'est PAS un rôle Membership : il est dérivé du flag
      // `TeamMember.isLead`. On filtre donc sur les leads d'équipe (équipe
      // non supprimée), pas sur le rôle org.
      baseWhere.teamMembers = {
        some: { isLead: true, team: { organizationId: orgId, deletedAt: null } },
      };
    } else if (opts.role) {
      baseWhere.memberships = {
        some: { organizationId: orgId, role: { key: opts.role } },
      };
    }
    const where = opts.status ? { ...baseWhere, status: opts.status } : baseWhere;

    const [total, active, suspended, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.count({ where: { ...baseWhere, status: UserStatus.ACTIVE } }),
      this.prisma.user.count({ where: { ...baseWhere, status: UserStatus.SUSPENDED } }),
      this.prisma.user.findMany({
        where,
        select: {
          ...PUBLIC_SELECT,
          // Verrouillage (lockout après trop d'échecs de login) — exposé à
          // l'annuaire admin uniquement (pas dans PUBLIC_SELECT, qui alimente
          // le /users public), pour piloter le bouton « Déverrouiller ».
          lockedUntil: true,
          memberships: {
            where: { organizationId: orgId },
            select: { role: { select: { key: true, name: true } }, isAgentAdmin: true },
            take: 1,
          },
        },
        orderBy: { name: 'asc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    const base = rows.map((u) => {
      const { memberships, ...rest } = u;
      return {
        ...rest,
        roleKey: memberships[0]?.role.key ?? null,
        roleName: memberships[0]?.role.name ?? null,
        isAgentAdmin: memberships[0]?.isAgentAdmin ?? false,
      };
    });

    let scheduleByUser: Record<string, unknown> = {};
    if (opts.includeSchedule !== false && base.length) {
      scheduleByUser = await this.batchSchedules(
        orgId,
        base.map((u) => u.id),
      );
    }

    return {
      items: base.map((u) => ({
        ...u,
        schedule: scheduleByUser[u.id] ?? null,
      })),
      total,
      page,
      pageSize,
      counts: { active, suspended },
    };
  }

  /**
   * Charge en **une seule requête** le WorkSchedule actif (effectiveFrom <=
   * aujourd'hui, le plus récent) de chaque user demandé, et complète les
   * manquants par le schedule par défaut de l'org (`isDefault: true`).
   */
  private async batchSchedules(
    orgId: string,
    userIds: string[],
  ): Promise<Record<string, unknown>> {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const schedules = await this.prisma.workSchedule.findMany({
      where: {
        organizationId: orgId,
        userId: { in: userIds },
        effectiveFrom: { lte: today },
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    const map: Record<string, unknown> = {};
    // findMany trié desc → le premier vu pour un user est le plus récent.
    for (const s of schedules) {
      if (!map[s.userId]) map[s.userId] = { ...s, isDefault: false };
    }
    const missing = userIds.filter((id) => !map[id]);
    if (missing.length) {
      const [hpd, days] = await Promise.all([
        this.settings.getHoursPerDay(orgId),
        this.settings.getDefaultWorkDays(orgId),
      ]);
      const def = {
        hoursMon: days[0] ? hpd : 0,
        hoursTue: days[1] ? hpd : 0,
        hoursWed: days[2] ? hpd : 0,
        hoursThu: days[3] ? hpd : 0,
        hoursFri: days[4] ? hpd : 0,
        hoursSat: days[5] ? hpd : 0,
        hoursSun: days[6] ? hpd : 0,
        occupancyPct: 100,
        isDefault: true,
      };
      for (const id of missing) {
        map[id] = {
          id: '',
          userId: id,
          organizationId: orgId,
          effectiveFrom: today,
          createdAt: new Date(0),
          updatedAt: new Date(0),
          ...def,
        };
      }
    }
    return map;
  }

  findOne(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      select: PUBLIC_SELECT,
    });
  }

  /**
   * Self-service : l'utilisateur courant change sa langue d'interface préférée.
   * `null`/'' ou langue non supportée → remet la valeur à null (hérite du défaut
   * org). Aucune permission spéciale (chacun gère sa propre préférence).
   */
  async setMyLanguage(userId: string, language: string | null | undefined) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { preferredLanguage: normalizeLanguage(language) },
      select: PUBLIC_SELECT,
    });
  }

  /**
   * Anti-escalade : `member:manage` ne suffit pas à conférer le statut admin
   * global (directement via `isAdmin` ou indirectement via `roleKey:
   * ORG_ADMIN`) — seul un admin peut promouvoir un admin. Sans ce garde-fou,
   * tout rôle délégué porteur de `member:manage` serait root de facto.
   */
  private assertCanGrantAdmin(
    actor: { isAdmin: boolean },
    dto: { isAdmin?: boolean; roleKey?: string },
  ) {
    if (actor.isAdmin) return;
    if (dto.isAdmin === true || dto.roleKey === 'ORG_ADMIN') {
      throw new ForbiddenException(
        'Seul un administrateur global peut accorder le statut admin',
      );
    }
  }

  /** Trace d'audit user (fire-and-forget). Sévérité pilotée par la table
   *  centrale (cf. AUDIT_SEVERITY) : rôle/admin/suspension/suppression/mot de
   *  passe = CRITICAL (écrit immédiatement) ; création = WARNING ; siège = INFO
   *  (bufferisés). */
  private auditUser(
    orgId: string,
    action: string,
    actor: UserMutationActor,
    target: { id: string; email?: string | null },
    detail?: unknown,
  ): void {
    const severity = severityForAction(action);
    const entry = {
      organizationId: orgId,
      action,
      severity,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'user',
      resourceId: target.id,
      resourceLabel: target.email ?? null,
      detail: { targetEmail: target.email ?? undefined, ...(detail as object | undefined) },
    };
    if (severity === 'CRITICAL') void this.audit.logNow(entry);
    else this.audit.log(entry);
  }

  async create(orgId: string, dto: CreateUserInput, actor: UserMutationActor) {
    this.assertCanGrantAdmin(actor, dto);
    if (!dto.email || !dto.name) throw new BadRequestException('email and name are required');
    const email = dto.email.trim().toLowerCase();
    const existing = await this.prisma.user.findFirst({
      where: { organizationId: orgId, email },
      select: { id: true },
    });
    if (existing) throw new ConflictException('A user with this email already exists');
    if (dto.password) {
      await this.policy.validateStrength(orgId, dto.password);
    }
    const passwordHash = dto.password ? await argon2.hash(dto.password) : null;
    // Le rôle org demandé → on aligne `isAdmin` sur ORG_ADMIN automatiquement.
    const roleKey = dto.roleKey ?? 'ORG_MEMBER';
    const role = await this.roles.findByKey(orgId, roleKey);
    const isAdmin = dto.isAdmin ?? roleKey === 'ORG_ADMIN';
    const employeeId = dto.employeeId ? dto.employeeId.trim() : null;
    if (employeeId) {
      const dup = await this.prisma.user.findFirst({
        where: { organizationId: orgId, employeeId },
        select: { id: true },
      });
      if (dup) throw new ConflictException('A user with this employee ID already exists');
    }
    // Siège de licence : une création **licenciée** consomme un siège (vérif du
    // plafond `maxUsers`). Défaut true (user « normal ») ; un compte admin-only
    // ou parqué est créé licensed=false et ne consomme rien.
    const licensed = dto.licensed ?? true;
    if (licensed) {
      await this.licenses.assertSeatAvailable(orgId);
    }
    const created = await this.prisma.user.create({
      data: {
        organizationId: orgId,
        email,
        name: dto.name,
        passwordHash,
        isAdmin,
        licensed,
        timezone: dto.timezone ?? 'UTC',
        status: dto.status ?? UserStatus.ACTIVE,
        createdVia: 'local',
        employeeId,
        // Initialise la date de changement de password si l'admin en a fourni un
        // à la création — sert au calcul d'expiration. Sinon laissé null (legacy).
        passwordChangedAt: passwordHash ? new Date() : null,
        memberships: {
          create: { organizationId: orgId, roleId: role.id },
        },
      },
      select: PUBLIC_SELECT,
    });
    this.auditUser(orgId, AUDIT_ACTIONS.USER_CREATED, actor, created, {
      roleKey: role.key,
      isAdmin,
      licensed,
    });
    return { ...created, roleKey: role.key, roleName: role.name };
  }

  /** Patch partiel. `password` est optionnel — si fourni, on hash et on remplace. */
  async update(orgId: string, id: string, dto: UpdateUserInput, actor: UserMutationActor) {
    this.assertCanGrantAdmin(actor, dto);
    // Les comptes agents (kind=AGENT) ne se gèrent PAS via /users : leur cycle
    // de vie (owner, capabilities, jetons, sièges jamais attribués) vit dans
    // /admin/agents — 404 ici pour ne pas contourner ses garde-fous.
    const user = await this.prisma.user.findFirst({
      where: { id, organizationId: orgId, deletedAt: null, kind: 'HUMAN' },
      select: { id: true, email: true, authProvider: true, isAdmin: true, status: true, licensed: true },
    });
    if (!user) throw new NotFoundException('User not found');
    // Symétrique : un non-admin (member:manage délégué) ne modifie pas le
    // compte d'un admin global (mot de passe, email, suspension…).
    if (user.isAdmin && !actor.isAdmin) {
      throw new ForbiddenException(
        'Seul un administrateur global peut modifier le compte d’un admin',
      );
    }
    const data: Record<string, unknown> = {};
    if (dto.email !== undefined) {
      const email = dto.email.trim().toLowerCase();
      if (email !== user.email) {
        const dup = await this.prisma.user.findFirst({
          where: { organizationId: orgId, email, id: { not: id } },
          select: { id: true },
        });
        if (dup) throw new ConflictException('Another user already uses this email');
      }
      data.email = email;
    }
    if (dto.name !== undefined) data.name = dto.name;
    if (dto.isAdmin !== undefined) data.isAdmin = dto.isAdmin;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.status !== undefined) data.status = dto.status;

    // --- Sièges de licence ---------------------------------------------------
    // Le siège est désormais un flag explicite (`licensed`), source de vérité
    // unique du comptage, découplé du `status`. Transitions gérées ici :
    //  • Suspension (→SUSPENDED) : libère le siège (licensed=false) — un compte
    //    suspendu ne consomme pas de siège payant. La réactivation n'attribue
    //    PAS de siège automatiquement : l'admin le ré-accorde explicitement.
    //  • dto.licensed true→false : retire le siège.
    //  • dto.licensed false→true : attribue un siège (vérifie le plafond).
    // `revokeSeat` = on doit couper les sessions (lockout dashboard immédiat au
    // prochain refresh) ; `grantSeat` = on a accordé un siège (audit).
    let revokeSeat = false; // couper les sessions (lockout) — toute perte de siège
    let grantSeat = false; // siège accordé explicitement (audit)
    let revokeSeatExplicit = false; // retrait explicite via dto.licensed (audit)
    if (dto.status === UserStatus.SUSPENDED && user.licensed) {
      // La suspension libère le siège ; l'événement `user.suspended` en rend compte.
      data.licensed = false;
      revokeSeat = true;
    }
    if (dto.licensed !== undefined && dto.status !== UserStatus.SUSPENDED) {
      if (dto.licensed && !user.licensed) {
        await this.licenses.assertSeatAvailable(orgId);
        data.licensed = true;
        grantSeat = true;
      } else if (!dto.licensed && user.licensed) {
        data.licensed = false;
        revokeSeat = true;
        revokeSeatExplicit = true;
      }
    }
    if (dto.password) {
      // Policies (complexité, historique) : LOCAL uniquement.
      // Break-glass (authProvider != LOCAL avec allowLocalLogin=true) et SSO
      // sont exemptés — l'admin choisit librement le mot de passe d'urgence.
      const policyApplies = user.authProvider === 'LOCAL';
      if (policyApplies) {
        await this.policy.validateStrength(orgId, dto.password);
        await this.policy.checkHistory(orgId, id, dto.password);
      }
      const before = await this.prisma.user.findUnique({
        where: { id }, select: { passwordHash: true },
      });
      data.passwordHash = await argon2.hash(dto.password);
      data.passwordChangedAt = new Date();
      // Reset par un admin → on force le user à le changer au prochain login.
      // Note : la force du change forcé ne s'applique pas non plus aux comptes
      // exemptés (un break-glass dont l'admin a fixé le mot de passe ne doit
      // pas être bloqué à son prochain login d'urgence).
      data.mustChangePassword = policyApplies;
      if (policyApplies) {
        await this.policy.recordHistory(orgId, id, before?.passwordHash ?? null);
      }
    }
    if (dto.countryCode !== undefined) {
      data.countryCode = dto.countryCode
        ? dto.countryCode.trim().toUpperCase()
        : null;
    }
    if (dto.preferredLanguage !== undefined) {
      data.preferredLanguage = normalizeLanguage(dto.preferredLanguage);
    }
    if (dto.employeeId !== undefined) {
      const eid = dto.employeeId ? dto.employeeId.trim() : null;
      if (eid) {
        const dup = await this.prisma.user.findFirst({
          where: { organizationId: orgId, employeeId: eid, id: { not: id } },
          select: { id: true },
        });
        if (dup) throw new ConflictException('Another user already uses this employee ID');
      }
      data.employeeId = eid;
    }
    // Si le rôle org change → on synchronise aussi `isAdmin` (ORG_ADMIN ↔ true,
    // tout autre rôle ↔ false), sauf si le caller a explicitement fourni isAdmin.
    if (dto.roleKey !== undefined && dto.isAdmin === undefined) {
      data.isAdmin = dto.roleKey === 'ORG_ADMIN';
    }
    // Rôle org AVANT mutation (pour le diff d'audit du changement de rôle).
    const prevMembership =
      dto.roleKey !== undefined
        ? await this.prisma.membership.findUnique({
            where: { organizationId_userId: { organizationId: orgId, userId: id } },
            include: { role: { select: { key: true } } },
          })
        : null;
    const updated = await this.prisma.user.update({
      where: { id },
      data,
      select: PUBLIC_SELECT,
    });
    // Événements de privilège — audités explicitement (CRITICAL), en plus de la
    // couverture générique `users.update` (INFO) de l'interceptor.
    if (data.isAdmin !== undefined && data.isAdmin !== user.isAdmin) {
      this.auditUser(orgId, AUDIT_ACTIONS.USER_ADMIN_TOGGLED, actor, user, {
        isAdmin: { old: user.isAdmin, new: data.isAdmin },
      });
    }
    if (dto.status !== undefined && dto.status !== user.status) {
      this.auditUser(
        orgId,
        dto.status === UserStatus.SUSPENDED
          ? AUDIT_ACTIONS.USER_SUSPENDED
          : AUDIT_ACTIONS.USER_REACTIVATED,
        actor,
        user,
        { status: { old: user.status, new: dto.status } },
      );
    }
    if (dto.password) {
      this.auditUser(orgId, AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED, actor, user, {
        by: 'admin_reset',
      });
    }
    // Sièges : couper les sessions sur toute perte de siège (lockout dashboard
    // dès le prochain refresh ; le JWT courant expire avec son TTL court), et
    // tracer l'attribution / le retrait **explicite** (le retrait par suspension
    // est déjà couvert par l'événement `user.suspended`).
    if (revokeSeat) {
      await this.prisma.refreshToken.updateMany({
        where: { userId: id, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    }
    if (grantSeat) {
      this.auditUser(orgId, AUDIT_ACTIONS.USER_SEAT_GRANTED, actor, user, {
        licensed: { old: false, new: true },
      });
    }
    if (revokeSeatExplicit) {
      this.auditUser(orgId, AUDIT_ACTIONS.USER_SEAT_REVOKED, actor, user, {
        licensed: { old: true, new: false },
      });
    }
    let roleKey: string | null = null;
    let roleName: string | null = null;
    if (dto.roleKey !== undefined) {
      const m = await this.roles.setOrgRole(orgId, id, dto.roleKey);
      roleKey = m.role.key;
      roleName = m.role.name;
      if (prevMembership?.role.key !== m.role.key) {
        this.auditUser(orgId, AUDIT_ACTIONS.USER_ROLE_CHANGED, actor, user, {
          roleKey: { old: prevMembership?.role.key ?? null, new: m.role.key },
        });
      }
    }
    // Grant « AI administrator » (Membership.isAgentAdmin). Empilable, indépendant
    // du rôle org : accorde `agent:manage`. On lit d'abord l'état pour n'auditer
    // (CRITICAL, changement de privilège) que sur un vrai changement.
    let isAgentAdmin = false;
    if (dto.isAgentAdmin !== undefined) {
      const cur = await this.prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: id } },
        select: { isAgentAdmin: true },
      });
      const next = dto.isAgentAdmin === true;
      if (cur && cur.isAgentAdmin !== next) {
        await this.prisma.membership.update({
          where: { organizationId_userId: { organizationId: orgId, userId: id } },
          data: { isAgentAdmin: next },
        });
        this.auditUser(orgId, AUDIT_ACTIONS.USER_AGENT_ADMIN_TOGGLED, actor, user, {
          isAgentAdmin: { old: cur.isAgentAdmin, new: next },
        });
      }
      isAgentAdmin = next;
    }
    // (Re)lecture de la membership pour renvoyer un état cohérent (roleKey/name +
    // isAgentAdmin) que le rôle ait changé ou non.
    {
      const m = await this.prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: orgId, userId: id } },
        include: { role: { select: { key: true, name: true } } },
      });
      roleKey = m?.role.key ?? roleKey;
      roleName = m?.role.name ?? roleName;
      isAgentAdmin = m?.isAgentAdmin ?? isAgentAdmin;
    }
    return { ...updated, roleKey, roleName, isAgentAdmin };
  }

  /**
   * Déverrouille un compte verrouillé par le lockout anti-brute-force
   * (`lockedUntil` dans le futur après trop d'échecs de login) : remet le
   * compteur d'échecs à zéro et efface la date de verrou. Ne touche à rien
   * d'autre (statut, siège, mot de passe inchangés). Idempotent (déverrouiller
   * un compte non verrouillé = no-op). Audité `user.unlocked` (CRITICAL).
   */
  async unlock(orgId: string, id: string, actor: UserMutationActor) {
    const user = await this.prisma.user.findFirst({
      // Agents exclus : pas de session interactive, donc jamais de lockout.
      where: { id, organizationId: orgId, deletedAt: null, kind: 'HUMAN' },
      select: {
        id: true,
        email: true,
        isAdmin: true,
        lockedUntil: true,
        failedLoginAttempts: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    // Symétrique à `update` : un non-admin (member:manage délégué) n'agit pas
    // sur le compte d'un admin global.
    if (user.isAdmin && !actor.isAdmin) {
      throw new ForbiddenException(
        'Seul un administrateur global peut déverrouiller le compte d’un admin',
      );
    }
    const wasLocked =
      !!user.lockedUntil && user.lockedUntil > new Date();
    const updated = await this.prisma.user.update({
      where: { id },
      data: { failedLoginAttempts: 0, lockedUntil: null },
      select: { ...PUBLIC_SELECT, lockedUntil: true },
    });
    // Audit seulement si le compte était effectivement verrouillé (sinon no-op
    // silencieux — pas de bruit d'audit pour un clic sur un compte déjà sain).
    if (wasLocked) {
      this.auditUser(orgId, AUDIT_ACTIONS.USER_UNLOCKED, actor, user, {
        lockedUntil: { old: user.lockedUntil?.toISOString() ?? null, new: null },
      });
    }
    return { ...updated, wasLocked };
  }

  /** Soft-delete. Refuse de supprimer le dernier admin global. */
  async softDelete(orgId: string, id: string, actorId: string) {
    if (id === actorId) throw new BadRequestException("You can't delete your own account");
    const target = await this.prisma.user.findFirst({
      // Agents exclus : suppression via /admin/agents uniquement (révoque aussi les jetons).
      where: { id, organizationId: orgId, deletedAt: null, kind: 'HUMAN' },
      select: { id: true, isAdmin: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');
    if (target.isAdmin) {
      const adminsLeft = await this.prisma.user.count({
        where: { organizationId: orgId, deletedAt: null, isAdmin: true, id: { not: id } },
      });
      if (adminsLeft === 0) {
        throw new BadRequestException('Cannot delete the last global administrator');
      }
    }
    const deleted = await this.prisma.user.update({
      where: { id },
      data: { deletedAt: new Date(), status: UserStatus.SUSPENDED, licensed: false },
      select: PUBLIC_SELECT,
    });
    // Couper les sessions : un compte supprimé ne doit plus pouvoir rafraîchir
    // (même règle que le retrait de siège / SCIM / SeatService).
    await this.prisma.refreshToken.updateMany({
      where: { userId: id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.auditUser(orgId, AUDIT_ACTIONS.USER_DELETED, { isAdmin: true, id: actorId }, target);
    return deleted;
  }

  /**
   * **RGPD — anonymisation (droit à l'effacement, Art. 17).** Pseudonymisation
   * irréversible : on ne supprime AUCUNE ligne, on écrase les champs PII de
   * l'utilisateur par une valeur dérivée de son id, et on blanchit les copies
   * de PII figées ailleurs (libellés/`detail` d'audit, destinataire d'email,
   * IP/UA de session, payloads de webhook). Les FK restent intactes →
   * l'historique métier (temps, finance, audit) continue d'agréger, mais plus
   * rien ne pointe vers une personne identifiable.
   *
   * Idempotent (ré-anonymiser = no-op). Refuse le dernier admin global et le
   * compte de l'acteur. L'acte lui-même est tracé (`user.anonymized`, CRITICAL)
   * **par id uniquement** — jamais l'ancien nom/email.
   */
  async anonymize(orgId: string, id: string, actor: UserMutationActor) {
    if (id === actor.id) throw new BadRequestException("You can't anonymize your own account");
    const target = await this.prisma.user.findFirst({
      // Agents exclus : un compte agent est déjà pseudonyme (aucune PII —
      // email synthétique @agents.invalid), rien à anonymiser.
      where: { id, organizationId: orgId, kind: 'HUMAN' },
      select: { id: true, isAdmin: true, email: true, name: true, deletedAt: true, status: true },
    });
    if (!target) throw new NotFoundException('User not found');

    // Idempotence : déjà pseudonymisé → ne rien refaire.
    if (isAnonymizedEmail(target.email)) {
      return { id, anonymized: true, alreadyAnonymized: true };
    }
    // Garde-fou : n'anonymiser qu'un compte déjà suspendu (accès déjà coupé,
    // décision délibérée et distincte de l'irréversibilité de l'anonymisation).
    if (target.status !== UserStatus.SUSPENDED) {
      throw new BadRequestException(
        'Le compte doit être suspendu avant de pouvoir être anonymisé.',
      );
    }
    // Même garde que la suppression : ne pas anonymiser le dernier admin global.
    if (target.isAdmin) {
      const adminsLeft = await this.prisma.user.count({
        where: { organizationId: orgId, deletedAt: null, isAdmin: true, id: { not: id } },
      });
      if (adminsLeft === 0) {
        throw new BadRequestException('Cannot anonymize the last global administrator');
      }
    }

    const newEmail = anonEmail(id);
    const newName = anonLabel('Utilisateur anonymisé', id);
    const oldEmail = target.email;
    const oldName = target.name;

    await this.prisma.$transaction(async (tx) => {
      // 1. La ligne User : PII directe écrasée, quasi-identifiants nullés, compte neutralisé.
      await tx.user.update({
        where: { id },
        data: {
          email: newEmail,
          name: newName,
          passwordHash: null,
          externalId: null,
          idpSource: null,
          employeeId: null,
          mfaSecret: null,
          mfaEnabled: false,
          allowLocalLogin: false,
          isAdmin: false,
          licensed: false,
          countryCode: null,
          preferredLanguage: null,
          timezone: 'UTC',
          status: UserStatus.SUSPENDED,
          deletedAt: target.deletedAt ?? new Date(),
        },
      });

      // 2. Libellés d'audit lisibles (les événements eux-mêmes sont conservés).
      await tx.auditLog.updateMany({
        where: { organizationId: orgId, actorId: id },
        data: { actorLabel: newName },
      });
      await tx.auditLog.updateMany({
        where: { organizationId: orgId, resourceType: 'user', resourceId: id },
        data: { resourceLabel: newName },
      });

      // 3. Destinataire des emails envoyés à cet utilisateur.
      if (oldEmail) {
        await tx.emailDelivery.updateMany({
          where: { organizationId: orgId, toAddress: oldEmail },
          data: { toAddress: newEmail },
        });
      }

      // 4. IP / User-Agent des sessions (on blanchit, on ne supprime pas).
      await tx.refreshToken.updateMany({
        where: { userId: id },
        data: { ipAddress: null, userAgent: null },
      });

      // 5. PII figée dans le JSON : `AuditLog.detail` (diffs) + `WebhookDelivery.payload`.
      const exec = tx.$executeRawUnsafe.bind(tx);
      const pairs: Array<[string | null | undefined, string]> = [
        [oldEmail, newEmail],
        [oldName, newName],
      ];
      await scrubJsonColumn(exec, 'AuditLog', 'detail', orgId, pairs);
      await scrubJsonColumn(exec, 'WebhookDelivery', 'payload', orgId, pairs);
    });

    // 6. Tracer l'anonymisation — par id seulement, jamais l'ancienne identité.
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.USER_ANONYMIZED,
      actorId: actor.id ?? null,
      actorLabel: actor.email ?? null,
      resourceType: 'user',
      resourceId: id,
      resourceLabel: newName,
      detail: { reason: 'rgpd', anonymizedUserId: id },
    });

    return { id, anonymized: true, alreadyAnonymized: false };
  }

  /**
   * **RGPD — portabilité (Art. 20).** Export JSON structuré des données
   * personnelles d'un utilisateur. Secrets exclus (passwordHash, mfaSecret,
   * tokens). Pour les pièces jointes : métadonnées seulement (pas le binaire).
   * L'appelant garantit le scoping (self-only sur `/me/export`, `member:manage`
   * sur la variante admin) ; l'acte est tracé par le contrôleur.
   */
  async exportData(orgId: string, userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId },
      select: {
        id: true,
        email: true,
        name: true,
        status: true,
        timezone: true,
        countryCode: true,
        preferredLanguage: true,
        employeeId: true,
        authProvider: true,
        idpSource: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    const [timeEntries, allocations, timeOffs, workSchedules, comments, skills, attachments] =
      await Promise.all([
        this.prisma.timeEntry.findMany({
          where: { organizationId: orgId, userId },
          select: {
            id: true, taskId: true, date: true, durationMinutes: true,
            overtimeMinutes: true, description: true, createdAt: true,
          },
          orderBy: { date: 'desc' },
        }),
        this.prisma.allocation.findMany({
          where: { organizationId: orgId, userId },
          select: {
            id: true, taskId: true, projectId: true, startDate: true,
            endDate: true, hoursPerDay: true, notes: true,
          },
        }),
        this.prisma.timeOff.findMany({
          where: { organizationId: orgId, userId },
          select: { id: true, startDate: true, endDate: true, type: true, notes: true },
        }),
        this.prisma.workSchedule.findMany({
          where: { organizationId: orgId, userId },
          select: {
            id: true, effectiveFrom: true, hoursMon: true, hoursTue: true,
            hoursWed: true, hoursThu: true, hoursFri: true, hoursSat: true,
            hoursSun: true, occupancyPct: true,
          },
        }),
        this.prisma.comment.findMany({
          where: { organizationId: orgId, authorId: userId, deletedAt: null },
          select: { id: true, taskId: true, body: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.userSkill.findMany({
          where: { userId, skill: { organizationId: orgId } },
          select: {
            skillId: true, level: true, lastValidatedAt: true, expiresAt: true,
            skill: { select: { name: true, category: true } },
          },
        }),
        this.prisma.attachment.findMany({
          where: { organizationId: orgId, uploaderId: userId, deletedAt: null },
          select: { id: true, taskId: true, filename: true, mimeType: true, sizeBytes: true, createdAt: true },
        }),
      ]);

    return {
      exportedAt: new Date().toISOString(),
      format: 'vaks-pm.gdpr-export.v1',
      profile: user,
      timeEntries,
      allocations,
      timeOffs,
      workSchedules,
      comments,
      skills,
      attachments,
    };
  }

  /**
   * Import CSV d'utilisateurs avec **dry-run** : `commit=false` (défaut) valide
   * chaque ligne et renvoie une prévisualisation SANS rien écrire ; `commit=true`
   * crée les comptes valides. Colonnes reconnues (en-têtes, insensibles à la
   * casse) : `email` (requis), `name` (requis), `role` (clé OU nom du rôle ;
   * défaut ORG_MEMBER), `timezone`, `employeeId`, `countryCode`.
   *
   * Les comptes sont créés **sans mot de passe** (login local impossible tant
   * qu'un lien de réinitialisation n'a pas été utilisé — cf. reset par email),
   * ce qui évite de transporter des secrets en clair dans un fichier.
   */
  async importUsers(
    orgId: string,
    csv: string,
    commit: boolean,
    actor: { isAdmin: boolean },
  ) {
    const { parseCsvRows } = await import('../common/csv.util');
    const parsed = parseCsvRows(csv);
    if (parsed.length === 0) {
      throw new BadRequestException('CSV vide ou sans ligne de données');
    }
    if (!('email' in parsed[0].row) || !('name' in parsed[0].row)) {
      throw new BadRequestException(
        'Colonnes obligatoires manquantes : email et name',
      );
    }

    // Index des rôles org : clé OU nom → clé canonique.
    const roles = await this.roles.list(orgId);
    const roleByKey = new Map<string, { key: string }>();
    for (const r of roles) {
      roleByKey.set(r.key.toLowerCase(), { key: r.key });
      roleByKey.set(r.name.toLowerCase(), { key: r.key });
    }

    // Emails / employeeIds déjà présents en base (un seul round-trip).
    const existing = await this.prisma.user.findMany({
      where: { organizationId: orgId, deletedAt: null },
      select: { email: true, employeeId: true },
    });
    const existingEmails = new Set(existing.map((u) => u.email.toLowerCase()));
    const existingEmployeeIds = new Set(
      existing.filter((u) => u.employeeId).map((u) => u.employeeId!.toLowerCase()),
    );

    const seenEmails = new Set<string>();
    const seenEmployeeIds = new Set<string>();
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    type Row = import('@vaks-pm/shared').UserImportRowDto;
    const rows: Row[] = [];

    for (const { line, row } of parsed) {
      const email = (row.email ?? '').trim().toLowerCase();
      const name = (row.name ?? '').trim();
      const rawRole = (row.role ?? '').trim();
      const employeeId = (row.employeeId ?? row.employeeid ?? '').trim();

      const mk = (
        valid: boolean,
        action: Row['action'],
        roleKey: string,
        error?: string,
      ): Row => ({ line, email, name, roleKey, valid, action, error });

      if (!email) {
        rows.push(mk(false, 'error', '', 'email manquant'));
        continue;
      }
      if (!emailRe.test(email)) {
        rows.push(mk(false, 'error', '', `email invalide : ${email}`));
        continue;
      }
      if (!name) {
        rows.push(mk(false, 'error', '', 'name manquant'));
        continue;
      }
      if (seenEmails.has(email)) {
        rows.push(mk(false, 'error', '', `doublon dans le fichier : ${email}`));
        continue;
      }
      seenEmails.add(email);

      // Rôle : résolu par clé ou par nom. Vide → ORG_MEMBER.
      let roleKey = 'ORG_MEMBER';
      if (rawRole) {
        const hit = roleByKey.get(rawRole.toLowerCase());
        if (!hit) {
          rows.push(mk(false, 'error', '', `rôle inconnu : ${rawRole}`));
          continue;
        }
        roleKey = hit.key;
      }
      // Anti-escalade : un non-admin ne peut pas provisionner d'admin.
      if (roleKey === 'ORG_ADMIN' && !actor.isAdmin) {
        rows.push(
          mk(false, 'error', roleKey, 'seul un admin peut importer un ORG_ADMIN'),
        );
        continue;
      }

      if (employeeId) {
        const eidKey = employeeId.toLowerCase();
        if (seenEmployeeIds.has(eidKey) || existingEmployeeIds.has(eidKey)) {
          rows.push(mk(false, 'error', roleKey, `employeeId en doublon : ${employeeId}`));
          continue;
        }
        seenEmployeeIds.add(eidKey);
      }

      if (existingEmails.has(email)) {
        rows.push(mk(true, 'skip-existing', roleKey));
        continue;
      }
      rows.push(mk(true, 'create', roleKey));
    }

    const toCreate = rows.filter((r) => r.action === 'create');
    let created = 0;
    if (commit && toCreate.length) {
      // Sièges : les imports créent des utilisateurs ACTIVE → vérifier la
      // capacité pour tout le lot avant d'en créer aucun (blocage net).
      await this.licenses.assertSeatAvailable(orgId, toCreate.length);
      for (const r of toCreate) {
        const src = parsed.find((p) => p.line === r.line)?.row ?? {};
        const role = await this.roles.findByKey(orgId, r.roleKey);
        try {
          await this.prisma.user.create({
            data: {
              organizationId: orgId,
              email: r.email,
              name: r.name,
              passwordHash: null,
              isAdmin: r.roleKey === 'ORG_ADMIN',
              // Import = onboarding d'utilisateurs « réels » → siège attribué
              // (la capacité du lot a été vérifiée juste au-dessus).
              licensed: true,
              timezone: (src.timezone ?? '').trim() || 'UTC',
              status: UserStatus.ACTIVE,
              createdVia: 'import',
              employeeId: (src.employeeId ?? src.employeeid ?? '').trim() || null,
              countryCode:
                (src.countryCode ?? src.countrycode ?? '').trim().toUpperCase() ||
                null,
              memberships: { create: { organizationId: orgId, roleId: role.id } },
            },
          });
          created++;
        } catch {
          // Course (email créé entre-temps) → on bascule la ligne en erreur.
          r.valid = false;
          r.action = 'error';
          r.error = 'création échouée (email déjà pris ?)';
        }
      }
    }

    return {
      dryRun: !commit,
      total: rows.length,
      willCreate: toCreate.length,
      created,
      skipped: rows.filter((r) => r.action === 'skip-existing').length,
      invalid: rows.filter((r) => r.action === 'error').length,
      rows,
    };
  }
}
