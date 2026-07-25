import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { permissionsForCapabilities, type Permission } from '@vaks-pm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { ApiTokensService } from '../../api-tokens/api-tokens.service';
import { LicenseService } from '../../licensing/license.service';
import { AuditLogService } from '../../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../../audit-logs/audit-actions';
import { classifyRefresh } from './refresh-rotation';

/**
 * Auto-authentification des agents *headless* (sans plateforme d'identité).
 *
 * L'agent détient un **refresh rotatif** durable (`vaks_agr_…`, émis une fois
 * par un humain) et l'échange sur `POST /agents/token` contre un `vaks_pat_`
 * court. Chaque échange **fait tourner** le refresh : le précédent ne vaut plus
 * que le temps d'une courte grâce, puis sa réutilisation devient un signal de
 * vol.
 *
 * **Frontière stricte avec la délégation utilisateur (MCP)** : ce service ne
 * touche jamais `OAuthConnection`, n'exige jamais de navigateur, et n'émet QUE
 * des jetons d'agent (`kind=AGENT`). Le flux OAuth navigateur, lui, reste
 * réservé aux humains (`assertUserActive kind=HUMAN`). Aucun credential, aucune
 * session n'est partagé entre les deux.
 */

const WORKING_TTL_SEC = 3600;
/** Durée de vie roulante du refresh (repoussée à chaque rotation). */
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60 j
/** Fenêtre pendant laquelle l'ancien refresh reste accepté (panne réseau). */
const GRACE_MS = 30 * 60 * 1000; // 30 min

export interface AgentTokenResult {
  access_token: string;
  refresh_token: string;
  token_type: 'Bearer';
  expires_in: number;
  scope: string;
}

interface AgentRow {
  id: string;
  name: string;
  status: string;
  deletedAt: Date | null;
  trustLevel: string | null;
  ownerId: string | null;
  capabilities: string[];
}

@Injectable()
export class AgentSelfAuthService {
  private readonly logger = new Logger(AgentSelfAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly apiTokens: ApiTokensService,
    private readonly audit: AuditLogService,
    private readonly licenses: LicenseService,
  ) {}

  private sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private newSecret(): string {
    return `vaks_agr_${randomBytes(32).toString('base64url')}`;
  }

  // Erreurs au format RFC 6749 (mêmes conventions que la fédération).
  private invalidRequest(desc: string): never {
    throw new BadRequestException({ error: 'invalid_request', error_description: desc });
  }
  private invalidGrant(desc: string): never {
    throw new UnauthorizedException({ error: 'invalid_grant', error_description: desc });
  }

  // ─────────────────────────── Émission (admin) ───────────────────────────

  /**
   * Émet le PREMIER refresh d'une chaîne pour un agent. Acte humain, app-privé.
   * Le secret est renvoyé en clair une seule fois.
   */
  async issueCredential(
    orgId: string,
    agentId: string,
    actorId: string,
    label?: string,
  ): Promise<{ id: string; chainId: string; secret: string; expiresAt: Date }> {
    const agent = await this.loadAgent(orgId, agentId);
    if (!agent) throw new NotFoundException('Agent introuvable');
    // On n'exige pas l'activation à l'ÉMISSION (un admin peut préparer le
    // credential avant d'activer l'agent) — mais l'ÉCHANGE, lui, l'exigera.

    const secret = this.newSecret();
    const chainId = randomBytes(12).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    const row = await this.prisma.agentRefreshToken.create({
      data: {
        organizationId: orgId,
        agentId,
        chainId,
        tokenHash: this.sha256(secret),
        expiresAt,
        createdById: actorId,
        label: label?.trim() || null,
      },
      select: { id: true },
    });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_CREDENTIAL_ISSUED,
      actorId,
      resourceType: 'agent',
      resourceId: agentId,
      resourceLabel: agent.name,
      detail: { chainId, credentialId: row.id, label: label ?? null },
    });
    return { id: row.id, chainId, secret, expiresAt };
  }

  async listCredentials(orgId: string, agentId: string) {
    const rows = await this.prisma.agentRefreshToken.findMany({
      where: { organizationId: orgId, agentId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, chainId: true, expiresAt: true, rotationCount: true,
        lastUsedAt: true, revokedAt: true, reuseDetectedAt: true, label: true, createdAt: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      chainId: r.chainId,
      label: r.label,
      expiresAt: r.expiresAt,
      rotationCount: r.rotationCount,
      lastUsedAt: r.lastUsedAt,
      revoked: !!r.revokedAt,
      reuseDetected: !!r.reuseDetectedAt,
      createdAt: r.createdAt,
    }));
  }

  /** Révoque une chaîne (par id de credential). Coupe l'agent : il devra qu'un
   *  humain lui en réémette une. */
  async revokeCredential(orgId: string, agentId: string, id: string, actorId: string) {
    const row = await this.prisma.agentRefreshToken.findFirst({
      where: { id, organizationId: orgId, agentId },
      select: { id: true, chainId: true, revokedAt: true },
    });
    if (!row) throw new NotFoundException('Identifiant introuvable');
    if (!row.revokedAt) {
      await this.prisma.agentRefreshToken.update({
        where: { id },
        data: { revokedAt: new Date() },
      });
    }
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_CREDENTIAL_REVOKED,
      actorId,
      resourceType: 'agent',
      resourceId: agentId,
      detail: { credentialId: id, chainId: row.chainId },
    });
    return { id, revoked: true };
  }

  // ─────────────────────────── Échange (agent) ───────────────────────────

  /**
   * Échange un refresh contre un jeton de travail court + un nouveau refresh.
   * Appelé par `POST /agents/token` (non authentifié : le refresh EST l'auth).
   */
  async exchange(refreshSecret: string | undefined, requestedScope?: string): Promise<AgentTokenResult> {
    const secret = refreshSecret?.trim();
    if (!secret || !secret.startsWith('vaks_agr_')) {
      this.invalidRequest('refresh_token requis.');
    }
    const hash = this.sha256(secret!);

    // Le tenant est déjà résolu par le Host (TenantMiddleware) → on interroge la
    // bonne base. On cherche le refresh comme COURANT ou comme PRÉCÉDENT.
    const row = await this.prisma.agentRefreshToken.findFirst({
      where: { OR: [{ tokenHash: hash }, { prevTokenHash: hash }] },
    });
    if (!row) this.invalidGrant('Refresh inconnu.');

    const now = Date.now();
    const decision = classifyRefresh(row!, hash, now);

    if (decision.action === 'revoked') this.invalidGrant('Refresh révoqué.');
    if (decision.action === 'reuse') {
      // Rejeu/vol : un ancien refresh présenté hors grâce. On révoque
      // DÉFENSIVEMENT toute la chaîne — l'agent légitime devra qu'un humain lui
      // en réémette une, ce qui est le bon comportement en cas de vol.
      await this.prisma.agentRefreshToken.update({
        where: { id: row!.id },
        data: { revokedAt: new Date(), reuseDetectedAt: new Date() },
      });
      await this.denied(row!.organizationId, row!.agentId, 'refresh_reuse');
      this.invalidGrant('Refresh déjà utilisé — chaîne révoquée par précaution.');
    }
    if (decision.action === 'expired') {
      await this.denied(row!.organizationId, row!.agentId, 'refresh_expired');
      this.invalidGrant('Refresh expiré — un administrateur doit en réémettre un.');
    }
    // À partir d'ici : decision.action === 'rotate'.
    const newPrev = decision.newPrev;

    const orgId = row!.organizationId;

    if (!(await this.licenses.hasFeature('agent-federation'))) {
      await this.denied(orgId, row!.agentId, 'license_missing');
      throw new UnauthorizedException({
        error: 'invalid_client',
        error_description: "Auto-authentification des agents non incluse dans la licence.",
      });
    }

    const agent = await this.loadAgent(orgId, row!.agentId);
    if (!agent || agent.deletedAt) {
      await this.denied(orgId, row!.agentId, 'agent_unknown');
      this.invalidGrant('Agent introuvable.');
    }
    this.assertActivated(agent!, orgId, row!.agentId);
    await this.assertOwnerActive(agent!, orgId, row!.agentId);

    // Rotation atomique : on n'avance QUE si le hash courant est toujours celui
    // qu'on a lu (garde optimiste contre deux refresh simultanés → un seul gagne,
    // pas de double émission du même nouveau refresh).
    const nextSecret = this.newSecret();
    const nextHash = this.sha256(nextSecret);
    const updated = await this.prisma.agentRefreshToken.updateMany({
      where: { id: row!.id, tokenHash: row!.tokenHash, revokedAt: null },
      data: {
        tokenHash: nextHash,
        prevTokenHash: newPrev,
        prevValidUntil: new Date(now + GRACE_MS),
        expiresAt: new Date(now + REFRESH_TTL_MS),
        rotationCount: { increment: 1 },
        lastUsedAt: new Date(),
      },
    });
    if (updated.count === 0) {
      // Un refresh concurrent a déjà tourné la chaîne. L'agent réessaiera avec
      // le refresh le plus récent qu'il détient.
      this.invalidGrant('Rotation concurrente — réessayez avec le dernier refresh.');
    }

    const capPerms = permissionsForCapabilities(agent!.capabilities ?? []) as Permission[];
    const requested = (requestedScope ?? '').split(/\s+/).filter(Boolean);
    const scopes = requested.length ? capPerms.filter((p) => requested.includes(p)) : capPerms;
    if (scopes.length === 0) {
      await this.denied(orgId, row!.agentId, 'empty_scope');
      this.invalidGrant("Aucun périmètre accordable (capabilities vides ou scope disjoint).");
    }

    const expiresAt = new Date(now + WORKING_TTL_SEC * 1000).toISOString();
    const minted = await this.apiTokens.create(orgId, 'USER', {
      userId: agent!.id,
      createdById: agent!.id,
      skipAudit: true,
      dto: { name: `Agent self-auth (${agent!.name})`, scopes, expiresAt, source: 'agent_self' },
    });
    // Un seul jeton de travail vivant par agent (même logique que la fédération).
    await this.revokePreviousWorking(orgId, agent!.id, minted.id);

    this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_SELF_AUTH_REFRESHED,
      severity: 'INFO',
      actorType: 'AGENT',
      actorId: agent!.id,
      actorLabel: agent!.name,
      resourceType: 'agent',
      resourceId: agent!.id,
      resourceLabel: agent!.name,
      detail: { chainId: row!.chainId, tokenId: minted.id, scopes, rotationCount: row!.rotationCount + 1 },
    });

    return {
      access_token: minted.token,
      refresh_token: nextSecret,
      token_type: 'Bearer',
      expires_in: WORKING_TTL_SEC,
      scope: scopes.join(' '),
    };
  }

  // ─────────────────────────── Portes d'activation ───────────────────────────

  private assertActivated(agent: AgentRow, orgId: string, agentId: string): void {
    if (agent.status !== 'ACTIVE') {
      void this.denied(orgId, agentId, 'agent_suspended');
      this.invalidGrant('Agent suspendu.');
    }
    if (!agent.trustLevel || agent.trustLevel === 'DRAFT_ONLY') {
      void this.denied(orgId, agentId, 'agent_not_activated');
      this.invalidGrant("Agent non activé (niveau de confiance requis).");
    }
    if (!agent.capabilities?.length) {
      void this.denied(orgId, agentId, 'agent_no_capabilities');
      this.invalidGrant('Agent sans capability.');
    }
    if (!agent.ownerId) {
      void this.denied(orgId, agentId, 'owner_missing');
      this.invalidGrant('Agent sans responsable humain.');
    }
  }

  private async assertOwnerActive(agent: AgentRow, orgId: string, agentId: string): Promise<void> {
    const owner = await this.prisma.user.findFirst({
      where: {
        id: agent.ownerId!,
        organizationId: orgId,
        kind: 'HUMAN',
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!owner) {
      await this.denied(orgId, agentId, 'owner_inactive');
      this.invalidGrant('Le responsable humain de cet agent est inactif.');
    }
  }

  // ─────────────────────────── Helpers ───────────────────────────

  private async loadAgent(orgId: string, agentId: string): Promise<AgentRow | null> {
    return (await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId, kind: 'AGENT' },
      select: {
        id: true, name: true, status: true, deletedAt: true,
        trustLevel: true, ownerId: true, capabilities: true,
      },
    })) as AgentRow | null;
  }

  private async revokePreviousWorking(orgId: string, agentId: string, keepId: string): Promise<void> {
    try {
      await this.prisma.apiToken.updateMany({
        where: {
          organizationId: orgId, userId: agentId, type: 'USER',
          source: 'agent_self', revokedAt: null, id: { not: keepId },
        },
        data: { revokedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(`could not revoke previous agent_self tokens: ${(e as Error).message}`);
    }
  }

  private async denied(orgId: string, agentId: string, reason: string): Promise<void> {
    this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_SELF_AUTH_DENIED,
      severity: 'WARNING',
      actorType: 'AGENT',
      actorId: agentId,
      outcome: 'FAILURE',
      resourceType: 'agent',
      resourceId: agentId,
      detail: { reason },
    });
  }
}
