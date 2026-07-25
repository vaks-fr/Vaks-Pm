import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RolesService } from '../admin/roles.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { RoleScope } from '@vaks-pm/shared';
import { Prisma } from '@db';
import type { IdentityProvider } from '@db';
import { NormalizedClaims, RoleMapping } from './sso.types';

/** Résultat d'un provisioning : l'user prêt à recevoir des tokens. */
export interface ProvisionResult {
  userId: string;
  organizationId: string;
  email: string;
  created: boolean;
  linked: boolean;
}

/**
 * Cœur commun de provisioning fédéré (JIT + account linking + mapping de rôle),
 * partagé par OIDC (lot 1), SAML (lot 3) et SCIM (lot 2). Idempotent : un user
 * déjà provisionné est simplement re-résolu (ses name/email rafraîchis).
 */
@Injectable()
export class SsoProvisioningService {
  private readonly logger = new Logger(SsoProvisioningService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly roles: RolesService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Résout le rôle org cible d'après les groupes IdP. Premier mapping qui
   * matche un groupe gagne ; sinon `defaultRoleKey` (ou ORG_MEMBER).
   * Renvoie null si aucune correspondance ET pas de défaut explicite — le
   * caller décide alors de ne pas toucher le rôle d'un compte existant.
   */
  private resolveRoleKey(
    provider: IdentityProvider,
    groups: string[],
  ): { roleKey: string; fromMapping: boolean } {
    const mappings = Array.isArray(provider.roleMappings)
      ? (provider.roleMappings as unknown as RoleMapping[])
      : [];
    const groupSet = new Set(groups);
    for (const m of mappings) {
      if (m && m.match && groupSet.has(m.match) && m.roleKey) {
        return { roleKey: m.roleKey, fromMapping: true };
      }
    }
    return { roleKey: provider.defaultRoleKey || 'ORG_MEMBER', fromMapping: false };
  }

  /**
   * Résout puis applique le rôle org d'après les groupes IdP.
   * - un groupe matche un mapping → on applique ce rôle (premier match gagnant) ;
   * - aucun match MAIS `syncRolesOnLogin` ET des groupes ont été reçus →
   *   downgrade au rôle par défaut ;
   * - aucun match et pas de sync → on ne touche PAS le rôle existant.
   *
   * Garde-fou anti-lockout : on ne rétrograde JAMAIS sur un claim `groups`
   * VIDE. Un claim vide ne distingue pas « l'utilisateur n'est dans aucun
   * groupe » de « le claim groups/roles n'est pas configuré dans l'app
   * registration » (cas le plus fréquent) — c'est presque toujours une mauvaise
   * config, et rétrograder dessus rétrograderait tous les comptes (y compris les
   * admins, modulo le dernier admin global) à chaque login. Dans le doute, on
   * préserve le rôle existant : la rétrogradation par synchro ne s'applique que
   * si l'IdP a réellement émis des groupes qui, eux, ne matchent aucun mapping.
   */
  private async applyRoleFromIdp(
    provider: IdentityProvider,
    userId: string,
    groups: string[],
  ): Promise<void> {
    const role = this.resolveRoleKey(provider, groups);
    if (role.fromMapping) {
      await this.applyRole(provider.organizationId, userId, role.roleKey);
      return;
    }
    if (provider.syncRolesOnLogin && groups.length > 0) {
      await this.applyRole(provider.organizationId, userId, role.roleKey);
    }
  }

  /**
   * Applique le rôle org (Membership upsert) + synchronise `isAdmin`.
   * Garde-fou anti-lockout : on ne rétrograde JAMAIS le dernier admin global
   * (sinon un mauvais mapping pourrait verrouiller toute l'org via SSO).
   */
  private async applyRole(orgId: string, userId: string, roleKey: string): Promise<void> {
    const role = await this.roles.findByKey(orgId, roleKey);
    if (role.scope !== RoleScope.ORG) {
      this.logger.warn(`Role ${roleKey} n'est pas ORG-scoped — ignoré pour le mapping SSO.`);
      return;
    }
    const willBeAdmin = role.key === 'ORG_ADMIN';
    if (!willBeAdmin) {
      const target = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { isAdmin: true },
      });
      if (target?.isAdmin) {
        const otherAdmins = await this.prisma.user.count({
          where: { organizationId: orgId, deletedAt: null, isAdmin: true, id: { not: userId } },
        });
        if (otherAdmins === 0) {
          this.logger.warn(
            `SSO role sync : downgrade du dernier admin global refusé (user ${userId}, org ${orgId}).`,
          );
          return;
        }
      }
    }
    await this.prisma.membership.upsert({
      where: { organizationId_userId: { organizationId: orgId, userId } },
      update: { roleId: role.id },
      create: { organizationId: orgId, userId, roleId: role.id },
    });
    await this.prisma.user.update({
      where: { id: userId },
      data: { isAdmin: willBeAdmin },
    });
  }

  /**
   * Provisionne (ou résout) un compte à partir des claims fédérés.
   * Étapes : match externalId → match email (link/reject) → JIT create.
   */
  async provision(
    provider: IdentityProvider,
    claims: NormalizedClaims,
    meta?: { ip?: string; userAgent?: string },
  ): Promise<ProvisionResult> {
    const orgId = provider.organizationId;
    const idpSource = provider.slug;

    const fail = (reason: string, userId?: string) =>
      this.audit.logCritical({
        organizationId: orgId,
        action: AUDIT_ACTIONS.AUTH_SSO_FAILURE,
        outcome: 'FAILURE',
        actorType: 'USER',
        actorId: userId ?? null,
        actorLabel: claims.email,
        resourceType: 'user',
        resourceId: userId ?? null,
        resourceLabel: claims.email,
        ip: meta?.ip,
        userAgent: meta?.userAgent,
        detail: { reason, idp: idpSource },
      });

    // 1. SEULE clé de rapprochement = `externalId` (objectId immuable de l'IdP).
    //    On INCLUT les comptes soft-deleted pour les RESSUSCITER (re-login après
    //    un déprovisioning / une suppression réversible). Plus de rapprochement
    //    par UPN/email : la liaison se fait uniquement par objectId.
    const byExternal = claims.externalId
      ? await this.prisma.user.findFirst({
          where: { organizationId: orgId, externalId: claims.externalId },
        })
      : null;
    if (byExternal) {
      const data: Prisma.UserUpdateInput = {
        authProvider: provider.type,
        idpSource,
      };
      if (byExternal.deletedAt) {
        data.deletedAt = null;
        data.status = 'ACTIVE';
      }
      if (byExternal.name !== claims.name) data.name = claims.name;
      if (byExternal.email !== claims.email) data.email = claims.email;
      try {
        await this.prisma.user.update({ where: { id: byExternal.id }, data });
      } catch (e) {
        // L'email de l'IdP est repris par un AUTRE compte → on garde l'ancien
        // email plutôt que d'échouer (l'objectId reste la clé d'identité).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          delete (data as Record<string, unknown>).email;
          await this.prisma.user.update({ where: { id: byExternal.id }, data });
        } else {
          throw e;
        }
      }
      await this.applyRoleFromIdp(provider, byExternal.id, claims.groups);
      return {
        userId: byExternal.id,
        organizationId: orgId,
        email: claims.email,
        created: false,
        linked: !!byExternal.deletedAt,
      };
    }

    // 2. Utilisateur INCONNU (aucun objectId connu). Politique au choix de l'org :
    //    JIT désactivé → on REFUSE (aucun siège consommé).
    if (!provider.jitProvisioning) {
      fail('jit_disabled');
      throw new ForbiddenException(
        "Aucun compte ne correspond à cette identité (objectId) et la création automatique est désactivée.",
      );
    }

    // 3. JIT activé, MAIS un compte porte déjà cet email (actif OU soft-deleted)
    //    sans le bon objectId → REFUS propre. On ne rapproche JAMAIS par email
    //    (anti reprise de compte) et on ne crée pas de doublon (contrainte unique).
    //    L'admin doit renseigner l'externalId du compte, ou le purger.
    const emailClash = await this.prisma.user.findFirst({
      where: { organizationId: orgId, email: claims.email },
      select: { id: true },
    });
    if (emailClash) {
      fail('email_collision', emailClash.id);
      throw new ForbiddenException(
        "Un compte avec cet email existe déjà mais n'est pas lié à cette identité IdP (objectId). " +
          "Un administrateur doit le rapprocher (renseigner l'externalId du compte) ou le supprimer définitivement.",
      );
    }

    // 4. Création JIT.
    const role = this.resolveRoleKey(provider, claims.groups);
    const roleRow = await this.roles.findByKey(orgId, role.roleKey).catch(() => null);
    const isAdmin = roleRow?.key === 'ORG_ADMIN';
    let created;
    try {
      created = await this.prisma.user.create({
        data: {
          organizationId: orgId,
          email: claims.email,
          name: claims.name,
          passwordHash: null,
          isAdmin,
          status: 'ACTIVE',
          // JIT à la connexion = utilisateur interactif réel → siège attribué
          // (sinon il tomberait sur l'écran « aucun siège »). NB : un compte
          // pré-provisionné par SCIM (seat-pending) passe par le chemin UPDATE
          // ci-dessus et conserve l'état de siège décidé par l'admin.
          licensed: true,
          authProvider: provider.type,
          externalId: claims.externalId,
          idpSource,
          createdVia: provider.type === 'SAML' ? 'saml' : 'oidc',
          memberships:
            roleRow && roleRow.scope === RoleScope.ORG
              ? { create: { organizationId: orgId, roleId: roleRow.id } }
              : undefined,
        },
      });
    } catch (e) {
      // Course possible (email/externalId déjà pris entre le check et le create).
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        fail('jit_unique_conflict');
        throw new ForbiddenException(
          "Impossible de créer le compte : un compte avec cet email ou cet identifiant existe déjà.",
        );
      }
      throw e;
    }
    this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.USER_PROVISIONED_SSO,
      actorType: 'USER',
      actorId: created.id,
      actorLabel: claims.email,
      resourceType: 'user',
      resourceId: created.id,
      resourceLabel: claims.email,
      ip: meta?.ip,
      userAgent: meta?.userAgent,
      detail: { idp: idpSource, roleKey: role.roleKey, externalId: claims.externalId },
    });
    return {
      userId: created.id,
      organizationId: orgId,
      email: claims.email,
      created: true,
      linked: false,
    };
  }
}
