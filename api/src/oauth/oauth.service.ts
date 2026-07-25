import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Permission } from '@vaks-pm/shared';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { LicenseService } from '../licensing/license.service';
import { PrismaService } from '../prisma/prisma.service';
import { OAuthStoreService } from './oauth-store.service';
import { OAuthClient } from './oauth.types';
import { AgentFederationService } from '../agents/federation/agent-federation.service';

/**
 * Façade **Authorization Server** OAuth 2.1 pour MCP.
 *
 * Choix structurants (réutilisation maximale de l'existant) :
 *  - `access_token` émis = **jeton `vaks_pat_` court** (1 h) via `ApiTokensService`
 *    → validé par le chemin phase 9 (public-gate + scopes). Aucun nouveau format
 *    de jeton, aucune modif de guard.
 *  - PKCE **S256 obligatoire** ; `token_endpoint_auth_method = none` (clients
 *    publics : Claude, ChatGPT, VS Code…).
 *  - Le login (local / SSO Entra) est délégué au front + à l'auth existante :
 *    `/authorize` ne fait que mémoriser la requête et renvoyer vers l'écran de
 *    consentement une fois l'utilisateur authentifié.
 */
@Injectable()
export class OAuthService {
  /** Durée de vie de l'access token (court — l'IA réémet via refresh). */
  private static readonly ACCESS_TTL_SEC = 3600;

  /**
   * Périmètre accordé par défaut à un jeton MCP. Les permissions effectives
   * restent **bornées par le RBAC de l'utilisateur** (PAT user = RBAC ∩ scopes),
   * donc un user basique ne gagne rien au-delà de son périmètre applicatif.
   * Lecture seule pour l'instant (incrément 1 = tools de lecture/suggestion).
   */
  private static readonly DEFAULT_SCOPES: Permission[] = [
    'mcp:access',
    // Périmètre de LECTURE = miroir des permissions « view » du RBAC. Comme
    // l'effectif d'un PAT user = RBAC ∩ scopes, accorder toutes les perms de
    // lecture fait que l'IA voit EXACTEMENT ce que l'utilisateur voit dans
    // l'app (un membre basique n'a pas client:view/finance:view dans son rôle
    // → il ne les obtient pas ; un manager les a → il les obtient). `time:log`
    // est MEMBER-level et requis pour lire timesheet / saisies de temps (les
    // écritures de temps restent gated par l'EXPOSITION du tool, pas le scope).
    'project:view',
    'project:view_all',
    'task:view',
    'report:view',
    'report:view_all',
    'client:view',
    'finance:view',
    'time:log',
  ];

  /**
   * Scopes d'ÉCRITURE ajoutés **uniquement si l'org a activé** `mcp.allowWrites`
   * (toggle admin). Restent bornés par le RBAC de l'utilisateur (un simple
   * membre n'obtient pas `project:create`). C'est l'enforcement serveur : si le
   * toggle est off, ces scopes ne sont jamais accordés → les tools d'écriture
   * échouent en 403, quoi que demande le client.
   */
  // NB : `time:log` n'est PAS listé ici alors qu'il est requis par le tool
  // d'écriture `log_time`. Raison : `time:log` est DÉJÀ dans DEFAULT_SCOPES
  // (lecture timesheet/temps) donc toujours accordé. L'inclure ici casserait la
  // détection « write » (chevauchement lecture/écriture → write:true permanent).
  // Le gating de `log_time` est assuré par l'EXPOSITION du tool (flag allowWrite),
  // pas par ce scope.
  private static readonly WRITE_SCOPES: Permission[] = [
    'project:create',
    'project:update',
    'task:create',
    'task:update',
    'allocation:manage',
    'comment:create',
    // Écriture finance (coûts hors main-d'œuvre + taux + budget) — n'agit QUE si
    // l'org active aussi `mcp.allowFinance` (FinanceApiGateGuard) ET si le user a
    // réellement `finance:manage` dans son RBAC (intersection). Triple verrou.
    'finance:manage',
    // Clients & contacts, équipes (création + membres + affectation projet).
    // Toujours ∩ RBAC : un user sans ces droits ne les obtient pas.
    'client:manage',
    'team:create',
    'team:manage_members',
    'project:assign_managers',
    'task:delete',
  ];

  constructor(
    private readonly store: OAuthStoreService,
    private readonly apiTokens: ApiTokensService,
    private readonly tenantCtx: TenantContext,
    private readonly settings: AdminSettingsService,
    private readonly licenses: LicenseService,
    private readonly prisma: PrismaService,
    private readonly federation: AgentFederationService,
  ) {}

  /** L'utilisateur emprunté existe-t-il encore et est-il ACTIF ? Refuse l'émission
   *  pour un compte suspendu / supprimé (le refresh d'un compte coupé doit mourir).
   *  Réservé aux HUMAINS : la façade OAuth délègue une session utilisateur ; un
   *  agent IA (kind=AGENT) s'authentifie par PAT minté, jamais par OAuth. */
  private async assertUserActive(orgId: string, userId: string): Promise<void> {
    const u = await this.prisma.user.findFirst({
      where: { id: userId, organizationId: orgId, deletedAt: null, status: 'ACTIVE', kind: 'HUMAN' },
      select: { id: true },
    });
    if (!u) throw new UnauthorizedException('Compte désactivé — la connexion IA a été coupée.');
  }

  /**
   * Le connecteur MCP est **disponible** pour ce tenant si DEUX conditions sont
   * réunies : (1) l'admin l'a activé (`mcp.enabled`, opt-in par tenant) ET (2) la
   * licence du tenant accorde la feature premium `mcp` (open-core). L'un OU
   * l'autre manquant ⇒ aucun jeton émis. `hasFeature` lit la licence du tenant
   * courant (contexte tenant déjà posé sur la requête de consentement).
   */
  private async mcpAvailable(orgId: string): Promise<boolean> {
    const [enabled, licensed] = await Promise.all([
      this.settings.getMcpEnabled(orgId),
      this.licenses.hasFeature('mcp'),
    ]);
    return enabled && licensed;
  }

  private slug(): string | undefined {
    return this.tenantCtx.currentSlug() ?? undefined;
  }

  /** Lecture seule, ou lecture+écriture selon le toggle org `mcp.allowWrites`. */
  private async computeScopes(orgId: string): Promise<Permission[]> {
    const writes = await this.settings.getMcpAllowWrites(orgId);
    return writes
      ? [...OAuthService.DEFAULT_SCOPES, ...OAuthService.WRITE_SCOPES]
      : [...OAuthService.DEFAULT_SCOPES];
  }

  /**
   * Pour l'écran de consentement : nom du client, si l'écriture est accordée, et
   * si le connecteur MCP est **activé** pour cette org. Quand `enabled` est faux,
   * le SPA affiche un état « désactivé » plutôt qu'un bouton d'approbation — et
   * `consent()` refuse de toute façon d'émettre un jeton (enforcement serveur).
   */
  async consentInfo(
    orgId: string,
    tx: string,
  ): Promise<{ clientName: string; write: boolean; finance: boolean; enabled: boolean }> {
    const pending = await this.store.peekPending(this.slug(), tx);
    const client = pending ? await this.store.getClient(this.slug(), pending.clientId) : null;
    const [scopes, enabled, finance] = await Promise.all([
      this.computeScopes(orgId),
      this.mcpAvailable(orgId),
      this.settings.getMcpAllowFinance(orgId),
    ]);
    return {
      clientName: client?.clientName ?? 'AI client',
      write: scopes.some((s) => OAuthService.WRITE_SCOPES.includes(s)),
      finance,
      enabled,
    };
  }

  // -------------------- Découverte (RFC 8414) --------------------

  authorizationServerMetadata(issuer: string) {
    return {
      issuer,
      authorization_endpoint: `${issuer}/api/v1/auth/oauth/authorize`,
      token_endpoint: `${issuer}/api/v1/auth/oauth/token`,
      registration_endpoint: `${issuer}/api/v1/auth/oauth/register`,
      scopes_supported: OAuthService.DEFAULT_SCOPES,
      response_types_supported: ['code'],
      grant_types_supported: [
        'authorization_code',
        'refresh_token',
        // Fédération d'identité des agents. Annoncé inconditionnellement : la
        // découverte décrit les capacités du serveur, pas les autorisations du
        // demandeur. Sans émetteur de confiance déclaré, tout échange est refusé.
        AgentFederationService.GRANT_TYPE,
      ],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    };
  }

  // -------------------- DCR (RFC 7591) --------------------

  async registerClient(dto: {
    redirect_uris?: unknown;
    client_name?: unknown;
  }): Promise<Record<string, unknown>> {
    const uris = Array.isArray(dto.redirect_uris)
      ? dto.redirect_uris.filter((u): u is string => typeof u === 'string')
      : [];
    if (uris.length === 0) {
      throw new BadRequestException('redirect_uris requis');
    }
    for (const u of uris) this.assertSafeRedirectUri(u);
    const client: OAuthClient = {
      clientId: `vaks_mcpc_${randomBytes(16).toString('base64url')}`,
      redirectUris: uris,
      clientName:
        typeof dto.client_name === 'string' && dto.client_name.trim()
          ? dto.client_name.trim().slice(0, 120)
          : 'MCP client',
      createdAt: Date.now(),
    };
    await this.store.saveClient(this.slug(), client);
    // Réponse DCR au format **RFC 7591** (snake_case) : les clients (Claude,
    // ChatGPT…) lisent `client_id`/`redirect_uris` — un camelCase casse le flux.
    return {
      client_id: client.clientId,
      redirect_uris: client.redirectUris,
      client_name: client.clientName,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(client.createdAt / 1000),
    };
  }

  /** Anti-open-redirect : https obligatoire, sauf loopback natif (RFC 8252). */
  private assertSafeRedirectUri(uri: string): void {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new BadRequestException(`redirect_uri invalide : ${uri}`);
    }
    const isLoopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopback)) {
      throw new BadRequestException(`redirect_uri doit être https (ou loopback) : ${uri}`);
    }
  }

  private async resolveClient(clientId: string): Promise<OAuthClient> {
    // Client DCR (Claude/ChatGPT, éphémère) OU pré-enregistré par l'admin
    // (Copilot Studio / intégrations, durable + confidentiel).
    const c =
      (await this.store.getClient(this.slug(), clientId)) ??
      (await this.store.getPreClient(this.slug(), clientId));
    if (!c) throw new BadRequestException('client_id inconnu.');
    return c;
  }

  private sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  // -------------------- Clients pré-enregistrés (admin) --------------------

  /** Crée un client confidentiel (id + secret). Le secret n'est renvoyé qu'ICI. */
  async createPreregisteredClient(
    name: string,
    redirectUris: string[],
  ): Promise<{ client_id: string; client_secret: string; redirect_uris: string[]; client_name: string }> {
    const uris = (redirectUris ?? []).filter((u) => typeof u === 'string' && u.trim());
    if (uris.length === 0) throw new BadRequestException('Au moins une URL de callback est requise.');
    for (const u of uris) this.assertSafeRedirectUri(u);
    const clientId = `vaks_mcpc_${randomBytes(16).toString('base64url')}`;
    const clientSecret = `vaks_cs_${randomBytes(32).toString('base64url')}`;
    const client: OAuthClient = {
      clientId,
      redirectUris: uris,
      clientName: (name?.trim() || 'Integration').slice(0, 120),
      createdAt: Date.now(),
      confidential: true,
      secretHash: this.sha256(clientSecret),
    };
    await this.store.savePreClient(this.slug(), client);
    return { client_id: clientId, client_secret: clientSecret, redirect_uris: uris, client_name: client.clientName };
  }

  async listPreregisteredClients(): Promise<
    Array<{ clientId: string; clientName: string; redirectUris: string[]; createdAt: number }>
  > {
    const rows = await this.store.listPreClients(this.slug());
    return rows.map((c) => ({
      clientId: c.clientId,
      clientName: c.clientName,
      redirectUris: c.redirectUris,
      createdAt: c.createdAt,
    }));
  }

  async revokePreregisteredClient(clientId: string): Promise<{ revoked: boolean }> {
    const n = await this.store.deletePreClient(this.slug(), clientId);
    return { revoked: n > 0 };
  }

  // -------------------- Connexions IA (self-service / offboarding) --------------------

  async listUserConnections(
    userId: string,
  ): Promise<Array<{ connId: string; clientName: string; createdAt: number; lastUsedAt: number }>> {
    const conns = await this.store.listConnections(this.slug(), userId);
    return conns.map((c) => ({
      connId: c.connId,
      clientName: c.clientName,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));
  }

  /** Révoque un PAT en best-effort (déjà révoqué / introuvable = on ignore). */
  private async revokeTokenSafe(orgId: string, tokenId: string, actorId: string): Promise<void> {
    try {
      await this.apiTokens.revoke(orgId, tokenId, { type: 'USER', actorId });
    } catch {
      /* token déjà révoqué / rotaté : best-effort */
    }
  }

  async revokeConnection(userId: string, connId: string): Promise<{ revoked: boolean }> {
    const conn = await this.store.getConnection(this.slug(), connId);
    // Couper l'access token courant IMMÉDIATEMENT (sinon il survivrait ≤1 h).
    if (conn?.tokenId) await this.revokeTokenSafe(conn.orgId, conn.tokenId, userId);
    return { revoked: await this.store.deleteConnection(this.slug(), userId, connId) };
  }

  /** Coupe TOUTES les connexions IA d'un user (appelé à la suspension/suppression). */
  async revokeAllUserConnections(userId: string): Promise<number> {
    const conns = await this.store.listConnections(this.slug(), userId);
    for (const c of conns) if (c.tokenId) await this.revokeTokenSafe(c.orgId, c.tokenId, userId);
    return this.store.revokeUserConnections(this.slug(), userId);
  }

  /** Vue **admin org-wide** : toutes les connexions IA de l'org, enrichies du
   *  nom/email de l'utilisateur (offboarding, réponse à incident). */
  async listAllConnections(orgId: string): Promise<
    Array<{
      connId: string;
      clientName: string;
      userId: string;
      userName: string | null;
      userEmail: string | null;
      createdAt: number;
      lastUsedAt: number;
    }>
  > {
    const conns = await this.store.listAllConnections(this.slug());
    const ids = [...new Set(conns.map((c) => c.userId))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids }, organizationId: orgId },
          select: { id: true, name: true, email: true },
        })
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return conns.map((c) => ({
      connId: c.connId,
      clientName: c.clientName,
      userId: c.userId,
      userName: byId.get(c.userId)?.name ?? null,
      userEmail: byId.get(c.userId)?.email ?? null,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    }));
  }

  /** Révocation **par un admin** d'une connexion IA (n'importe quel user). */
  async adminRevokeConnection(connId: string): Promise<{ revoked: boolean }> {
    const conn = await this.store.getConnection(this.slug(), connId);
    if (!conn) return { revoked: false };
    if (conn.tokenId) await this.revokeTokenSafe(conn.orgId, conn.tokenId, conn.userId);
    return { revoked: await this.store.deleteConnection(this.slug(), conn.userId, connId) };
  }

  /** Validation stricte du redirect_uri : exact, ou loopback à port variable. */
  private redirectAllowed(client: OAuthClient, presented: string): boolean {
    if (client.redirectUris.includes(presented)) return true;
    let p: URL;
    try {
      p = new URL(presented);
    } catch {
      return false;
    }
    const isLoopback = p.hostname === '127.0.0.1' || p.hostname === 'localhost';
    if (!isLoopback) return false;
    // Loopback : on ignore le port (VS Code en choisit un aléatoire).
    return client.redirectUris.some((r) => {
      try {
        const ru = new URL(r);
        return (
          (ru.hostname === '127.0.0.1' || ru.hostname === 'localhost') &&
          ru.pathname === p.pathname
        );
      } catch {
        return false;
      }
    });
  }

  // -------------------- /authorize --------------------

  /**
   * Valide le param `resource` (RFC 8707, audience-binding) : s'il est présent,
   * il doit désigner **ce déploiement** — même hôte que le tenant, ou un
   * sous-domaine du même domaine enregistrable (couvre la variante `mcp.<host>`).
   * Anti **confused-deputy** : on refuse d'émettre un code pour une ressource
   * d'un autre domaine. Absence de `resource` tolérée (clients non-conformes).
   *
   * NB : restriction d'audience **complète** (jeton borné à la ressource) =
   * différée — elle exige un champ `audience` sur `ApiToken` (changement de
   * schéma + db push par tenant). Ici on borne **côté AS** (émission).
   */
  private assertResourceAudience(resource: string | undefined, requestOrigin: string): void {
    if (!resource) return;
    let r: URL;
    try {
      r = new URL(resource);
    } catch {
      throw new BadRequestException(`resource (audience) invalide : ${resource}`);
    }
    if (r.protocol !== 'https:' && !(r.protocol === 'http:' && (r.hostname === '127.0.0.1' || r.hostname === 'localhost'))) {
      throw new BadRequestException('resource (audience) doit être https.');
    }
    const reqHost = new URL(requestOrigin).hostname;
    const reg = (h: string) => h.split('.').slice(-2).join('.');
    const ok = r.hostname === reqHost || r.hostname.endsWith('.' + reg(reqHost)) || reqHost.endsWith('.' + reg(r.hostname));
    if (!ok) {
      throw new BadRequestException(
        `resource (audience) « ${r.origin} » ne correspond pas à ce serveur.`,
      );
    }
  }

  /** Valide la requête d'autorisation et crée une transaction `tx` à consentir. */
  async startAuthorization(
    q: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      code_challenge?: string;
      code_challenge_method?: string;
      scope?: string;
      state?: string;
      resource?: string;
    },
    requestOrigin: string,
  ): Promise<{ tx: string }> {
    if (q.response_type !== 'code') {
      throw new BadRequestException('response_type doit valoir "code".');
    }
    if (!q.client_id || !q.redirect_uri) {
      throw new BadRequestException('client_id et redirect_uri requis.');
    }
    this.assertResourceAudience(q.resource, requestOrigin);
    const client = await this.resolveClient(q.client_id);
    if (!this.redirectAllowed(client, q.redirect_uri)) {
      throw new BadRequestException('redirect_uri non enregistré pour ce client.');
    }
    // PKCE **obligatoire pour les clients publics** (Claude/ChatGPT). Pour un
    // client **confidentiel** (pré-enregistré, ex. Copilot Studio), le secret
    // tient lieu de preuve → PKCE optionnel (honoré s'il est fourni).
    const hasPkce = !!q.code_challenge && q.code_challenge_method === 'S256';
    if (!client.confidential && !hasPkce) {
      throw new BadRequestException('PKCE S256 obligatoire (code_challenge + code_challenge_method=S256).');
    }
    const tx = await this.store.createPending(this.slug(), {
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      codeChallenge: hasPkce ? q.code_challenge! : null,
      codeChallengeMethod: hasPkce ? 'S256' : null,
      scope: q.scope ?? null,
      state: q.state ?? null,
      resource: q.resource ?? null,
    });
    return { tx };
  }

  // -------------------- /consent (utilisateur authentifié) --------------------

  /**
   * Appelé par le front une fois l'utilisateur logué : transforme la
   * transaction en code d'autorisation et renvoie l'URL de redirection finale
   * vers le client (avec `code` + `state`), ou une erreur `access_denied`.
   */
  async consent(
    user: { userId: string; orgId: string },
    tx: string,
    approve: boolean,
  ): Promise<{ redirect: string }> {
    // Opt-in strict **par tenant** + gating licence (feature `mcp`) : on n'émet
    // un jeton que si l'admin a activé le connecteur ET que la licence l'accorde.
    // Refus uniquement sur l'approbation (un refus utilisateur doit aboutir).
    if (approve && !(await this.mcpAvailable(user.orgId))) {
      throw new BadRequestException(
        "Le connecteur MCP est désactivé pour cette organisation. Contactez votre administrateur.",
      );
    }
    const pending = await this.store.consumePending(this.slug(), tx);
    if (!pending) throw new BadRequestException('Demande expirée ou inconnue. Relancer la connexion.');

    const url = new URL(pending.redirectUri);
    if (!approve) {
      url.searchParams.set('error', 'access_denied');
      if (pending.state) url.searchParams.set('state', pending.state);
      return { redirect: url.toString() };
    }

    const code = await this.store.createCode(this.slug(), {
      userId: user.userId,
      orgId: user.orgId,
      clientId: pending.clientId,
      redirectUri: pending.redirectUri,
      codeChallenge: pending.codeChallenge,
      scopes: await this.computeScopes(user.orgId),
      resource: pending.resource,
    });
    url.searchParams.set('code', code);
    if (pending.state) url.searchParams.set('state', pending.state);
    return { redirect: url.toString() };
  }

  // -------------------- /token --------------------

  async token(body: Record<string, string | undefined>) {
    switch (body.grant_type) {
      case 'authorization_code':
        return this.exchangeCode(body);
      case 'refresh_token':
        return this.refreshGrant(body);
      // Fédération d'identité des agents (RFC 8693). Chemin totalement distinct
      // des deux autres : pas de client OAuth, pas de code, pas de refresh — un
      // JWT de plateforme est échangé contre un PAT court. Le gating MCP
      // (`mcpAvailable`) ne s'y applique PAS : c'est la surface agents, pas la
      // surface IA conversationnelle. Erreurs au format RFC 6749, contrairement
      // au reste du module (les clients de token exchange l'exigent).
      case AgentFederationService.GRANT_TYPE:
        return this.federation.exchange(body);
      default:
        throw new BadRequestException('grant_type non supporté.');
    }
  }

  private verifyPkce(verifier: string, challenge: string): boolean {
    if (!verifier) return false;
    const h = createHash('sha256').update(verifier).digest('base64url');
    return h === challenge;
  }

  private async exchangeCode(body: Record<string, string | undefined>) {
    const { code, redirect_uri, code_verifier, client_id, client_secret } = body;
    if (!code || !client_id || !redirect_uri) {
      throw new BadRequestException('code, client_id et redirect_uri requis.');
    }
    const rec = await this.store.consumeCode(this.slug(), code);
    if (!rec) throw new UnauthorizedException('Code invalide ou expiré.');
    if (rec.clientId !== client_id || rec.redirectUri !== redirect_uri) {
      throw new UnauthorizedException('client_id / redirect_uri ne correspondent pas au code.');
    }
    const client = await this.resolveClient(client_id);
    if (client.confidential) {
      // Client confidentiel (Copilot Studio…) : preuve par secret.
      if (!client_secret || this.sha256(client_secret) !== client.secretHash) {
        throw new UnauthorizedException('client_secret invalide.');
      }
      // PKCE en défense-en-profondeur s'il a été fourni à l'autorisation.
      if (rec.codeChallenge && !this.verifyPkce(code_verifier ?? '', rec.codeChallenge)) {
        throw new UnauthorizedException('Vérification PKCE échouée.');
      }
    } else {
      // Client public (Claude/ChatGPT) : PKCE obligatoire.
      if (!code_verifier || !rec.codeChallenge || !this.verifyPkce(code_verifier, rec.codeChallenge)) {
        throw new UnauthorizedException('Vérification PKCE échouée.');
      }
    }
    // Première émission : on ouvre une **connexion IA** stable (listable/révocable).
    const connId = await this.store.createConnection(this.slug(), {
      userId: rec.userId,
      orgId: rec.orgId,
      clientId: rec.clientId,
      clientName: client.clientName,
    });
    return this.issue(rec.userId, rec.orgId, rec.clientId, rec.scopes, connId);
  }

  private async refreshGrant(body: Record<string, string | undefined>) {
    const { refresh_token, client_id } = body;
    if (!refresh_token) throw new BadRequestException('refresh_token requis.');
    const rec = await this.store.consumeRefresh(this.slug(), refresh_token);
    if (!rec) throw new UnauthorizedException('refresh_token invalide ou expiré.');
    if (client_id && client_id !== rec.clientId) {
      throw new UnauthorizedException('client_id incohérent.');
    }
    // La connexion doit exister (sinon : révoquée par l'user/admin) ET l'utilisateur
    // doit être encore actif (sinon : suspendu/supprimé → on coupe la chaîne).
    if (!(await this.store.getConnection(this.slug(), rec.connId))) {
      throw new UnauthorizedException('Connexion IA révoquée — se reconnecter.');
    }
    await this.assertUserActive(rec.orgId, rec.userId);
    await this.store.touchConnection(this.slug(), rec.connId);
    return this.issue(rec.userId, rec.orgId, rec.clientId, rec.scopes, rec.connId);
  }

  /** Émet la paire access (PAT court) + refresh, au format réponse OAuth. */
  private async issue(
    userId: string,
    orgId: string,
    clientId: string,
    scopes: Permission[],
    connId: string,
  ) {
    const expiresAt = new Date(Date.now() + OAuthService.ACCESS_TTL_SEC * 1000).toISOString();
    const minted = await this.apiTokens.create(orgId, 'USER', {
      userId,
      createdById: userId,
      dto: { name: `MCP (${clientId.slice(0, 18)})`, scopes, expiresAt },
    });
    // Rotation : révoquer le PAT précédent de cette connexion (anti-accumulation)
    // puis enregistrer le nouveau, pour pouvoir couper l'accès NET à la déconnexion.
    const prev = await this.store.getConnection(this.slug(), connId);
    if (prev?.tokenId && prev.tokenId !== minted.id) {
      await this.revokeTokenSafe(orgId, prev.tokenId, userId);
    }
    await this.store.setConnectionToken(this.slug(), connId, minted.id);
    const refresh = await this.store.createRefresh(this.slug(), {
      userId,
      orgId,
      clientId,
      scopes,
      connId,
    });
    return {
      access_token: minted.token,
      token_type: 'Bearer',
      expires_in: OAuthService.ACCESS_TTL_SEC,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }
}
