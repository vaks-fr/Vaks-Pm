import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../admin/roles.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { LicenseService } from '../licensing/license.service';
import { SeatService } from '../licensing/seat.service';
import {
  applyPatch,
  parseEqFilter,
  parseGroupPatch,
  readWrite,
  ScimGroupWrite,
  ScimPatchOp,
  ScimUserWrite,
  TeamForScim,
  toScimGroup,
  toScimUser,
  UserForScim,
} from './scim.types';

const USER_SELECT = {
  id: true, email: true, name: true, status: true, externalId: true,
  employeeId: true, createdAt: true, updatedAt: true,
} as const;

interface ScimActor {
  orgId: string;
  userId: string; // l'admin créateur de la clé org
}

@Injectable()
export class ScimService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly audit: AuditLogService,
    private readonly licenses: LicenseService,
    private readonly seats: SeatService,
  ) {}

  /** Réconcilie les sièges auto-licence pour un groupe (équipe) SCIM, si le
   *  flag `autoLicense` est posé. Best-effort, ne casse jamais la sync. */
  private async applyAutoLicense(
    actor: ScimActor,
    teamId: string,
    change: { grant?: string[]; revoke?: string[] },
  ): Promise<void> {
    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      select: { autoLicense: true },
    });
    if (!team?.autoLicense) return;
    await this.seats.reconcileAutoLicense(actor.orgId, change, {
      actorId: actor.userId,
      actorLabel: 'scim',
      via: 'scim',
    });
  }

  private audited(action: string, actor: ScimActor, target: { id: string; email: string }, detail?: unknown) {
    void this.audit.logCritical({
      organizationId: actor.orgId,
      action,
      actorType: 'API_TOKEN',
      actorId: actor.userId,
      actorLabel: 'scim',
      resourceType: 'user',
      resourceId: target.id,
      resourceLabel: target.email,
      detail,
    });
  }

  /**
   * Update User en interceptant la collision d'email (`@@unique[org,email]`) :
   * un changement d'email/userName côté IdP qui viserait l'adresse d'un AUTRE
   * compte → 409 SCIM (au lieu d'un 500). Le compte n'est jamais dédoublé : on
   * met à jour EN PLACE (même id) → toutes les données applicatives sont
   * conservées quand l'email change.
   */
  private async updateUserSafe(id: string, data: Record<string, unknown>) {
    try {
      return await this.prisma.user.update({ where: { id }, data, select: USER_SELECT });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('userName (email) already used by another account');
      }
      throw e;
    }
  }

  /** Révoque toutes les sessions actives d'un user (déprovisioning). */
  private async revokeSessions(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async list(orgId: string, filter: string | undefined, startIndex: number, count: number, baseUrl: string) {
    // SCIM ne gère QUE les humains — les agents IA ont leur propre provisioning
    // (connecteurs AgentDirectoryProvider / POST /agents), jamais via l'IdP users.
    const where: Record<string, unknown> = { organizationId: orgId, deletedAt: null, kind: 'HUMAN' };
    const eq = parseEqFilter(filter);
    if (eq) {
      if (eq.attr.toLowerCase() === 'username') where.email = eq.value.toLowerCase();
      else if (eq.attr.toLowerCase() === 'externalid') where.externalId = eq.value;
      else return { resources: [], total: 0 }; // filtre non supporté → vide
    }
    const [total, rows] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where, select: USER_SELECT, orderBy: { createdAt: 'asc' },
        skip: Math.max(0, startIndex - 1), take: Math.min(Math.max(1, count), 200),
      }),
    ]);
    return { resources: rows.map((u) => toScimUser(u as UserForScim, baseUrl)), total };
  }

  async get(orgId: string, id: string, baseUrl: string) {
    const u = await this.prisma.user.findFirst({
      where: { id, organizationId: orgId, deletedAt: null, kind: 'HUMAN' }, select: USER_SELECT,
    });
    if (!u) throw new NotFoundException('User not found');
    return toScimUser(u as UserForScim, baseUrl);
  }

  async create(actor: ScimActor, body: ScimUserWrite, baseUrl: string) {
    const w = readWrite(body);
    if (!w.email) throw new BadRequestException('userName (email) is required');
    // Match existant : externalId d'abord (clé stable IdP), puis email.
    const existing = await this.prisma.user.findFirst({
      where: {
        organizationId: actor.orgId,
        OR: [
          ...(w.externalId ? [{ externalId: w.externalId }] : []),
          { email: w.email },
        ],
      },
      select: { id: true, deletedAt: true },
    });
    if (existing && !existing.deletedAt) {
      throw new ConflictException('User already exists');
    }
    const role = await this.roles.findByKey(actor.orgId, 'ORG_MEMBER').catch(() => null);
    const active = w.active !== false; // défaut actif
    // Sièges de licence : le provisioning SCIM crée des comptes **sans siège**
    // (`licensed=false`, défaut du modèle). On ne vérifie donc PAS le plafond ici
    // → un débordement au-delà de `maxUsers` ne renvoie jamais 403 à l'IdP : le
    // compte existe et se synchronise, l'admin lui attribue un siège ensuite
    // (modèle « seat-pending »). Cf. SPEC §16.
    if (existing && existing.deletedAt) {
      // Résurrection d'un compte précédemment supprimé via SCIM.
      const u = await this.updateUserSafe(existing.id, {
        deletedAt: null,
        email: w.email,
        name: w.name || w.email,
        externalId: w.externalId ?? undefined,
        ...(w.employeeId ? { employeeId: w.employeeId } : {}),
        status: active ? 'ACTIVE' : 'SUSPENDED',
      });
      this.audited(AUDIT_ACTIONS.USER_PROVISIONED_SSO, actor, u, { via: 'scim', resurrected: true });
      return toScimUser(u as UserForScim, baseUrl);
    }
    let u;
    try {
      u = await this.prisma.user.create({
        data: {
          organizationId: actor.orgId,
          email: w.email,
          name: w.name || w.email,
          passwordHash: null,
          isAdmin: false,
          status: active ? 'ACTIVE' : 'SUSPENDED',
          // Compte géré par l'IdP : login local refusé (SSO-only) tant qu'aucun
          // break-glass n'est posé. La convergence avec OIDC se fait par externalId.
          authProvider: 'OIDC',
          externalId: w.externalId ?? null,
          employeeId: w.employeeId ?? null,
          idpSource: 'scim',
          createdVia: 'scim',
          memberships: role ? { create: { organizationId: actor.orgId, roleId: role.id } } : undefined,
        },
        select: USER_SELECT,
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException('userName (email) or employeeNumber already in use');
      }
      throw e;
    }
    this.audited(AUDIT_ACTIONS.USER_PROVISIONED_SSO, actor, u, { via: 'scim' });
    return toScimUser(u as UserForScim, baseUrl);
  }

  async replace(actor: ScimActor, id: string, body: ScimUserWrite, baseUrl: string) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: actor.orgId, deletedAt: null, kind: 'HUMAN' }, select: { id: true, status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    const w = readWrite(body);
    const active = w.active !== false;
    // Réactivation via SCIM : n'attribue PAS de siège (seat-pending). Le compte
    // redevient ACTIVE mais reste sans accès dashboard tant qu'un admin ne lui
    // accorde pas de siège. (Pas de 403 vers l'IdP.)
    const u = await this.updateUserSafe(id, {
      ...(w.email ? { email: w.email } : {}),
      ...(w.name ? { name: w.name } : {}),
      ...(w.externalId ? { externalId: w.externalId } : {}),
      ...(w.employeeId ? { employeeId: w.employeeId } : {}),
      status: active ? 'ACTIVE' : 'SUSPENDED',
      // Déprovisioning → libère le siège (ne pas immobiliser une licence).
      ...(!active && target.status === 'ACTIVE' ? { licensed: false } : {}),
    });
    if (!active && target.status === 'ACTIVE') {
      await this.revokeSessions(id);
      this.audited(AUDIT_ACTIONS.USER_SUSPENDED, actor, u, { via: 'scim' });
    }
    return toScimUser(u as UserForScim, baseUrl);
  }

  async patch(actor: ScimActor, id: string, ops: ScimPatchOp['Operations'], baseUrl: string) {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: actor.orgId, deletedAt: null, kind: 'HUMAN' }, select: { id: true, status: true },
    });
    if (!target) throw new NotFoundException('User not found');
    const delta = applyPatch(ops);
    const data: Record<string, unknown> = {};
    if (delta.name) data.name = delta.name;
    if (delta.email) data.email = delta.email;
    if (delta.employeeId !== undefined) data.employeeId = delta.employeeId; // null = effacer
    if (typeof delta.active === 'boolean') data.status = delta.active ? 'ACTIVE' : 'SUSPENDED';
    // Réactivation via SCIM : n'attribue PAS de siège (seat-pending) — l'admin
    // l'accorde ensuite. Pas de vérif de plafond, donc pas de 403 vers l'IdP.
    // Déprovisioning (active:false) → on libère le siège pour ne pas immobiliser
    // une licence sur un compte suspendu.
    if (delta.active === false && target.status === 'ACTIVE') {
      data.licensed = false;
    }
    const u = await this.updateUserSafe(id, data);
    // Déprovisioning (active:false) → on coupe les sessions et on trace.
    if (delta.active === false && target.status === 'ACTIVE') {
      await this.revokeSessions(id);
      this.audited(AUDIT_ACTIONS.USER_SUSPENDED, actor, u, { via: 'scim' });
    } else if (delta.active === true && target.status === 'SUSPENDED') {
      this.audited(AUDIT_ACTIONS.USER_REACTIVATED, actor, u, { via: 'scim' });
    }
    return toScimUser(u as UserForScim, baseUrl);
  }

  /** DELETE = déprovisioning fort : soft-delete + sessions coupées (siège libéré). */
  async remove(actor: ScimActor, id: string): Promise<void> {
    const target = await this.prisma.user.findFirst({
      where: { id, organizationId: actor.orgId, deletedAt: null, kind: 'HUMAN' }, select: { id: true, email: true },
    });
    if (!target) throw new NotFoundException('User not found');
    await this.prisma.user.update({
      where: { id }, data: { deletedAt: new Date(), status: 'SUSPENDED' },
    });
    await this.revokeSessions(id);
    this.audited(AUDIT_ACTIONS.USER_DELETED, actor, target, { via: 'scim' });
  }

  // ============================================================
  // Groups → Teams (keyé sur externalId)
  // ============================================================

  private auditedGroup(action: string, actor: ScimActor, team: { id: string; name: string }, detail?: unknown) {
    void this.audit.logCritical({
      organizationId: actor.orgId,
      action,
      actorType: 'API_TOKEN',
      actorId: actor.userId,
      actorLabel: 'scim',
      resourceType: 'team',
      resourceId: team.id,
      resourceLabel: team.name,
      detail,
    });
  }

  private async teamForScim(where: Record<string, unknown>): Promise<TeamForScim | null> {
    const t = await this.prisma.team.findFirst({
      where,
      select: {
        id: true, name: true, externalId: true, createdAt: true, updatedAt: true,
        members: { select: { userId: true, user: { select: { name: true } } } },
      },
    });
    if (!t) return null;
    return {
      id: t.id, name: t.name, externalId: t.externalId, createdAt: t.createdAt, updatedAt: t.updatedAt,
      members: t.members.map((m) => ({ userId: m.userId, name: m.user.name })),
    };
  }

  /** Filtre les ids reçus aux users réellement présents (org, non supprimés). */
  private async validMemberIds(orgId: string, ids: string[]): Promise<string[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.user.findMany({
      where: { id: { in: ids }, organizationId: orgId, deletedAt: null },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /** Rejette un displayName déjà porté par une autre team (contrainte unique). */
  private async assertNameFree(orgId: string, name: string, exceptId?: string): Promise<void> {
    const dup = await this.prisma.team.findFirst({
      where: { organizationId: orgId, name, deletedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException(`A team named "${name}" already exists.`);
    }
  }

  async listGroups(orgId: string, filter: string | undefined, startIndex: number, count: number, baseUrl: string) {
    const where: Record<string, unknown> = { organizationId: orgId, deletedAt: null };
    const eq = parseEqFilter(filter);
    if (eq) {
      if (eq.attr.toLowerCase() === 'displayname') where.name = eq.value;
      else if (eq.attr.toLowerCase() === 'externalid') where.externalId = eq.value;
      else return { resources: [], total: 0 };
    }
    const total = await this.prisma.team.count({ where });
    const rows = await this.prisma.team.findMany({
      where,
      select: {
        id: true, name: true, externalId: true, createdAt: true, updatedAt: true,
        members: { select: { userId: true, user: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'asc' },
      skip: Math.max(0, startIndex - 1), take: Math.min(Math.max(1, count), 200),
    });
    const resources = rows.map((t) =>
      toScimGroup(
        { ...t, members: t.members.map((m) => ({ userId: m.userId, name: m.user.name })) },
        baseUrl,
      ),
    );
    return { resources, total };
  }

  async getGroup(orgId: string, id: string, baseUrl: string) {
    const t = await this.teamForScim({ id, organizationId: orgId, deletedAt: null });
    if (!t) throw new NotFoundException('Group not found');
    return toScimGroup(t, baseUrl);
  }

  async createGroup(actor: ScimActor, body: ScimGroupWrite, baseUrl: string) {
    const name = body.displayName?.trim();
    if (!name) throw new BadRequestException('displayName is required');
    const externalId = body.externalId?.trim() || null;
    // Match par externalId : déjà présent → 409 (Entra aurait dû le trouver).
    if (externalId) {
      const existing = await this.prisma.team.findFirst({
        where: { organizationId: actor.orgId, externalId },
        select: { id: true, deletedAt: true },
      });
      if (existing && !existing.deletedAt) throw new ConflictException('Group already exists');
      if (existing && existing.deletedAt) {
        // Résurrection d'un groupe supprimé.
        await this.assertNameFree(actor.orgId, name, existing.id);
        await this.prisma.team.update({
          where: { id: existing.id },
          data: { deletedAt: null, name, source: 'SCIM' },
        });
        const set = await this.setMembers(actor, existing.id, body.members?.map((m) => m.value ?? '').filter(Boolean) ?? []);
        const t = await this.teamForScim({ id: existing.id });
        this.auditedGroup('scim.group.provisioned', actor, t!, {
          resurrected: true,
          members: set.applied,
          ...(set.dropped.length ? { droppedUnprovisioned: set.dropped } : {}),
        });
        return toScimGroup(t!, baseUrl);
      }
    }
    await this.assertNameFree(actor.orgId, name);
    const team = await this.prisma.team.create({
      data: { organizationId: actor.orgId, name, externalId, source: 'SCIM' },
      select: { id: true, name: true },
    });
    const set = await this.setMembers(actor, team.id, body.members?.map((m) => m.value ?? '').filter(Boolean) ?? []);
    const t = await this.teamForScim({ id: team.id });
    this.auditedGroup('scim.group.provisioned', actor, team, {
      externalId,
      members: set.applied,
      ...(set.dropped.length ? { droppedUnprovisioned: set.dropped } : {}),
    });
    return toScimGroup(t!, baseUrl);
  }

  async replaceGroup(actor: ScimActor, id: string, body: ScimGroupWrite, baseUrl: string) {
    const team = await this.prisma.team.findFirst({
      where: { id, organizationId: actor.orgId, deletedAt: null }, select: { id: true, name: true },
    });
    if (!team) throw new NotFoundException('Group not found');
    const name = body.displayName?.trim();
    if (name && name !== team.name) {
      await this.assertNameFree(actor.orgId, name, id);
      await this.prisma.team.update({ where: { id }, data: { name } });
    }
    const set = await this.setMembers(actor, id, body.members?.map((m) => m.value ?? '').filter(Boolean) ?? []);
    const t = await this.teamForScim({ id });
    this.auditedGroup('scim.group.updated', actor, t!, {
      op: 'replace',
      members: set.applied,
      ...(set.dropped.length ? { droppedUnprovisioned: set.dropped } : {}),
    });
    return toScimGroup(t!, baseUrl);
  }

  async patchGroup(actor: ScimActor, id: string, ops: ScimPatchOp['Operations'], baseUrl: string) {
    const team = await this.prisma.team.findFirst({
      where: { id, organizationId: actor.orgId, deletedAt: null }, select: { id: true, name: true },
    });
    if (!team) throw new NotFoundException('Group not found');
    const d = parseGroupPatch(ops);
    if (d.displayName && d.displayName !== team.name) {
      await this.assertNameFree(actor.orgId, d.displayName, id);
      await this.prisma.team.update({ where: { id }, data: { name: d.displayName } });
    }
    let appliedAdd = 0;
    let droppedAdd: string[] = [];
    if (d.replaceMembers !== undefined) {
      const set = await this.setMembers(actor, id, d.replaceMembers);
      appliedAdd = set.applied;
      droppedAdd = set.dropped;
    } else {
      let addedValid: string[] = [];
      if (d.removeMembers.length) {
        await this.prisma.teamMember.deleteMany({ where: { teamId: id, userId: { in: d.removeMembers } } });
      }
      if (d.addMembers.length) {
        const valid = await this.validMemberIds(actor.orgId, d.addMembers);
        droppedAdd = d.addMembers.filter((x) => !valid.includes(x));
        if (valid.length) {
          await this.prisma.teamMember.createMany({
            data: valid.map((userId) => ({ teamId: id, userId })),
            skipDuplicates: true,
          });
        }
        appliedAdd = valid.length;
        addedValid = valid;
      }
      // Auto-licence sur l'ajout/retrait incrémental (PATCH delta Entra).
      await this.applyAutoLicense(actor, id, { grant: addedValid, revoke: d.removeMembers });
    }
    const t = await this.teamForScim({ id });
    this.auditedGroup('scim.group.updated', actor, t!, {
      op: 'patch',
      // `added` = membres réellement insérés ; `requestedAdd` = ce que l'IdP a
      // demandé. Un écart (+ `droppedUnprovisioned`) = l'IdP référence des users
      // pas encore provisionnés via SCIM (ordre de cycle / scope d'assignation).
      added: appliedAdd,
      requestedAdd: d.replaceMembers !== undefined ? d.replaceMembers.length : d.addMembers.length,
      removed: d.removeMembers.length,
      ...(droppedAdd.length ? { droppedUnprovisioned: droppedAdd } : {}),
    });
    return toScimGroup(t!, baseUrl);
  }

  /** DELETE groupe = soft-delete la team. */
  async removeGroup(actor: ScimActor, id: string): Promise<void> {
    const team = await this.prisma.team.findFirst({
      where: { id, organizationId: actor.orgId, deletedAt: null },
      select: { id: true, name: true, autoLicense: true, members: { select: { userId: true } } },
    });
    if (!team) throw new NotFoundException('Group not found');
    await this.prisma.team.update({ where: { id }, data: { deletedAt: new Date() } });
    this.auditedGroup('scim.group.deleted', actor, team, { via: 'scim' });
    // L'équipe auto-licence disparaît → ses membres perdent le siège (sauf s'ils
    // sont couverts par une autre équipe auto-licence). Le soft-delete est déjà
    // appliqué donc l'orphan-check l'exclut.
    if (team.autoLicense && team.members.length) {
      await this.seats.reconcileAutoLicense(
        actor.orgId,
        { revoke: team.members.map((m) => m.userId) },
        { actorId: actor.userId, actorLabel: 'scim', via: 'scim' },
      );
    }
  }

  /**
   * Remplace l'ensemble des membres de l'équipe par `ids` (filtrés valides).
   * Retourne le nombre réellement appliqué et les ids rejetés parce que non
   * provisionnés dans l'org (users que l'IdP référence mais que SCIM n'a pas
   * encore créés) — sert à distinguer « l'IdP n'envoie rien » de « on a droppé ».
   */
  private async setMembers(
    actor: ScimActor,
    teamId: string,
    ids: string[],
  ): Promise<{ applied: number; dropped: string[] }> {
    // Composition AVANT mutation (pour calculer added/removed → auto-licence).
    const prev = await this.prisma.teamMember.findMany({ where: { teamId }, select: { userId: true } });
    const prevIds = prev.map((p) => p.userId);
    const valid = await this.validMemberIds(actor.orgId, ids);
    const dropped = ids.filter((x) => !valid.includes(x));
    await this.prisma.teamMember.deleteMany({ where: { teamId, userId: { notIn: valid.length ? valid : ['__none__'] } } });
    if (valid.length) {
      await this.prisma.teamMember.createMany({
        data: valid.map((userId) => ({ teamId, userId })),
        skipDuplicates: true,
      });
    }
    // Auto-licence : siège aux nouveaux membres, libéré pour ceux retirés.
    await this.applyAutoLicense(actor, teamId, {
      grant: valid.filter((id) => !prevIds.includes(id)),
      revoke: prevIds.filter((id) => !valid.includes(id)),
    });
    return { applied: valid.length, dropped };
  }
}
