import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PERMISSIONS, Permission } from '@vaks-pm/shared';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

export type ApiTokenType = 'USER' | 'ORG';

/** Principal résolu depuis un jeton API (devient `req.user`). */
export interface ApiTokenPrincipal {
  userId: string;
  orgId: string;
  email: string | null;
  isAdmin: boolean;
  viaApiToken: true;
  isOrgToken: boolean;
  tokenScopes: Permission[];
  /** HUMAN (défaut) ou AGENT — dérivé du user porteur du PAT (jamais du header). */
  actorKind: 'HUMAN' | 'AGENT';
  /** Humain responsable de l'agent (kind=AGENT uniquement) — pour l'audit. */
  agentOwnerId?: string;
  /** Niveau de confiance de l'agent (policies chantier 3). */
  trustLevel?: string;
  /** Capabilities de l'agent (traduites en permissions par PermissionsGuard). */
  capabilities?: string[];
}

export interface CreateTokenInput {
  name: string;
  scopes?: string[];
  /** ISO date ; null/absent = pas d'expiration. */
  expiresAt?: string | null;
  /**
   * Origine : 'manual' (admin), 'oauth' (façade MCP), 'agent' (mint admin),
   * 'inbound' (carte connecteur), 'federation' (échange RFC 8693). Pilote la
   * purge — les jetons fédérés sont émis en continu.
   */
  source?: string;
}

const VALID_PERMS = new Set<string>(PERMISSIONS as readonly string[]);

/** Durée de vie maximale d'un jeton (jamais permanent) : 2 ans. */
const MAX_TTL_MS = 2 * 365 * 24 * 60 * 60 * 1000;

@Injectable()
export class ApiTokensService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
  ) {}

  private sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  private sanitizeScopes(scopes?: string[]): string[] {
    if (!scopes) return [];
    const bad = scopes.filter((s) => !VALID_PERMS.has(s));
    if (bad.length) throw new BadRequestException(`Scope(s) invalide(s) : ${bad.join(', ')}`);
    return Array.from(new Set(scopes));
  }

  /** Expiration OBLIGATOIRE (jamais permanent), dans le futur, ≤ 2 ans. */
  private parseExpiry(iso?: string | null): Date {
    if (!iso) {
      throw new BadRequestException(
        "Une date d'expiration est requise (max 2 ans — pas de jeton permanent).",
      );
    }
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) throw new BadRequestException('expiresAt invalide');
    const now = Date.now();
    if (d.getTime() <= now) throw new BadRequestException("expiresAt doit être dans le futur");
    if (d.getTime() > now + MAX_TTL_MS) {
      throw new BadRequestException('Expiration maximale : 2 ans.');
    }
    return d;
  }

  /**
   * Crée un jeton et renvoie le secret EN CLAIR (à montrer une seule fois).
   * En base : seulement `tokenHash` (SHA-256) + `prefix`.
   */
  async create(
    orgId: string,
    type: ApiTokenType,
    opts: {
      userId?: string | null;
      createdById: string;
      dto: CreateTokenInput;
      /**
       * Ne pas émettre `apiToken.created`. Réservé aux voies qui journalisent
       * déjà leur propre événement métier ET qui émettent en continu (fédération
       * d'agents : un jeton par heure et par agent noierait les entrées
       * CRITICAL de l'audit).
       */
      skipAudit?: boolean;
    },
  ): Promise<{ id: string; token: string; prefix: string }> {
    const name = opts.dto.name?.trim();
    if (!name) throw new BadRequestException('Nom requis');
    const scopes = this.sanitizeScopes(opts.dto.scopes);
    if (type === 'ORG' && scopes.length === 0) {
      throw new BadRequestException("Une clé organisation doit avoir au moins un scope.");
    }
    const expiresAt = this.parseExpiry(opts.dto.expiresAt);

    const kind = type === 'ORG' ? 'org' : 'pat';
    const raw = `vaks_${kind}_${randomBytes(30).toString('base64url')}`;
    const prefix = raw.slice(0, `vaks_${kind}_`.length + 6) + '…';

    const row = await this.prisma.apiToken.create({
      data: {
        organizationId: orgId,
        type,
        userId: type === 'USER' ? (opts.userId ?? null) : null,
        name,
        prefix,
        tokenHash: this.sha256(raw),
        scopes,
        expiresAt,
        source: opts.dto.source ?? 'manual',
        createdById: opts.createdById,
      },
      select: { id: true },
    });
    if (!opts.skipAudit) {
      void this.audit.logCritical({
        organizationId: orgId,
        action: AUDIT_ACTIONS.API_TOKEN_CREATED,
        actorId: opts.createdById,
        resourceType: 'apiToken',
        resourceId: row.id,
        resourceLabel: name,
        detail: { type, name, prefix, scopes, expiresAt: expiresAt.toISOString() },
      });
    }
    return { id: row.id, token: raw, prefix };
  }

  /** Authentifie un secret présenté → principal, ou null si invalide. */
  async verify(raw: string): Promise<ApiTokenPrincipal | null> {
    if (!raw || !raw.startsWith('vaks_')) return null;
    const row = await this.prisma.apiToken.findUnique({
      where: { tokenHash: this.sha256(raw) },
    });
    if (!row) return null;
    if (row.revokedAt) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;

    // Touch lastUsedAt (best-effort, ne bloque pas la requête).
    void this.prisma.apiToken
      .update({ where: { id: row.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    const scopes = row.scopes as Permission[];
    if (row.type === 'ORG') {
      // userId = l'admin créateur (id valide → pas de null à gérer en aval ;
      // attribue les éventuelles actions à un acteur réel). isAdmin forcé false.
      return {
        userId: row.createdById,
        orgId: row.organizationId,
        email: null,
        isAdmin: false,
        viaApiToken: true,
        isOrgToken: true,
        tokenScopes: scopes,
        actorKind: 'HUMAN',
      };
    }
    // USER : on charge l'utilisateur emprunté (droits = son RBAC, ∩ scopes).
    if (!row.userId) return null;
    const user = await this.prisma.user.findFirst({
      where: { id: row.userId, organizationId: row.organizationId, deletedAt: null, status: 'ACTIVE' },
      select: {
        id: true, email: true, isAdmin: true,
        kind: true, trustLevel: true, ownerId: true, capabilities: true,
      },
    });
    if (!user) return null; // user supprimé/suspendu → token inopérant

    if (user.kind === 'AGENT') {
      // L'agent meurt avec son responsable (exigence réglementaire) : owner
      // absent, supprimé, suspendu ou non-humain ⇒ jeton inopérant.
      if (!user.ownerId) return null;
      const owner = await this.prisma.user.findFirst({
        where: {
          id: user.ownerId,
          organizationId: row.organizationId,
          deletedAt: null,
          status: 'ACTIVE',
          kind: 'HUMAN',
        },
        select: { id: true },
      });
      if (!owner) return null;
      return {
        userId: user.id,
        orgId: row.organizationId,
        email: user.email,
        isAdmin: false, // un agent n'est jamais admin, quel que soit le flag
        viaApiToken: true,
        isOrgToken: false,
        tokenScopes: scopes,
        actorKind: 'AGENT',
        agentOwnerId: user.ownerId,
        trustLevel: user.trustLevel ?? 'DRAFT_ONLY',
        capabilities: user.capabilities ?? [],
      };
    }

    return {
      userId: user.id,
      orgId: row.organizationId,
      email: user.email,
      isAdmin: user.isAdmin,
      viaApiToken: true,
      isOrgToken: false,
      tokenScopes: scopes,
      actorKind: 'HUMAN',
    };
  }

  // ---------- Gestion (liste / révocation) ----------

  private toDto = (t: {
    id: string; type: string; name: string; prefix: string; scopes: string[];
    lastUsedAt: Date | null; expiresAt: Date | null; revokedAt: Date | null; createdAt: Date;
  }) => ({
    id: t.id, type: t.type, name: t.name, prefix: t.prefix, scopes: t.scopes,
    lastUsedAt: t.lastUsedAt, expiresAt: t.expiresAt, revoked: !!t.revokedAt, createdAt: t.createdAt,
  });

  async listForUser(orgId: string, userId: string) {
    const rows = await this.prisma.apiToken.findMany({
      where: { organizationId: orgId, type: 'USER', userId, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(this.toDto);
  }

  async listOrg(orgId: string) {
    const rows = await this.prisma.apiToken.findMany({
      where: { organizationId: orgId, type: 'ORG', revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map(this.toDto);
  }

  /** Révoque (soft) un jeton. `requireUserId` borne aux jetons du user (PAT perso). */
  async revoke(
    orgId: string,
    id: string,
    opts: { type: ApiTokenType; requireUserId?: string; actorId?: string },
  ) {
    const where: Record<string, unknown> = { id, organizationId: orgId, type: opts.type };
    if (opts.requireUserId) where.userId = opts.requireUserId;
    const row = await this.prisma.apiToken.findFirst({ where });
    if (!row) throw new NotFoundException('Jeton introuvable');
    await this.prisma.apiToken.update({ where: { id }, data: { revokedAt: new Date() } });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.API_TOKEN_REVOKED,
      actorId: opts.actorId ?? opts.requireUserId ?? null,
      resourceType: 'apiToken',
      resourceId: id,
      resourceLabel: row.name,
      detail: { type: row.type, name: row.name, prefix: row.prefix },
    });
    return { id, revoked: true };
  }

  /**
   * Clés ORG d'une carte « inbound connector » : convention de nommage
   * `inbound:<purpose>:` + scopes EXACTEMENT égaux à ceux de la carte
   * (ceinture-bretelles contre une collision de nom avec une clé créée à la
   * main dans « Organization keys »).
   */
  async listOrgKeysByPurpose(orgId: string, purposePrefix: string, scopes: string[]) {
    const rows = await this.prisma.apiToken.findMany({
      where: {
        organizationId: orgId,
        type: 'ORG',
        revokedAt: null,
        name: { startsWith: purposePrefix },
      },
      orderBy: { createdAt: 'desc' },
    });
    const want = [...scopes].sort().join(',');
    return rows
      .filter((r) => [...r.scopes].sort().join(',') === want)
      .map(this.toDto);
  }

  /**
   * Révocation BORNÉE au purpose : 404 si la clé ne matche pas le préfixe de
   * nom (+ type ORG). Garde-fou des endpoints délégués (ex. un « AI
   * administrator » qui détient `agent:manage` mais pas `org:manage` ne doit
   * pouvoir révoquer QUE les clés d'enregistrement d'agents, jamais une clé
   * org arbitraire).
   */
  async revokeScoped(orgId: string, id: string, purposePrefix: string, actorId: string) {
    const row = await this.prisma.apiToken.findFirst({
      where: { id, organizationId: orgId, type: 'ORG', name: { startsWith: purposePrefix } },
      select: { id: true },
    });
    if (!row) throw new NotFoundException('Jeton introuvable');
    return this.revoke(orgId, id, { type: 'ORG', actorId });
  }

  /** Catalogue des scopes possibles (= permissions) pour l'UI (PAT user). */
  listScopeCatalog(): string[] {
    return [...PERMISSIONS];
  }

  /** Scopes proposables pour une clé ORG (toutes les permissions). */
  listOrgScopeCatalog(): string[] {
    return [...PERMISSIONS];
  }
}
