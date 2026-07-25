/**
 * Configuration du serveur MCP, lue depuis l'environnement.
 *
 * Le serveur MCP est volontairement « pauvre » (zéro secret, zéro accès DB) :
 * il ne connaît que l'URL interne de l'API et la façon de router le tenant.
 * Toute la sécurité (validation du jeton, RBAC) est appliquée par l'API.
 */
/** Stratégie d'annonce de l'Authorization Server (RFC 9728). */
export type AuthServerMode = 'self' | 'tenant';

export interface McpConfig {
  /** Port d'écoute HTTP (Streamable HTTP). */
  port: number;
  /** Base URL interne de l'API (overlay Swarm). Ex. http://api:3000 */
  apiBaseUrl: string;
  /** Préfixe global de l'API NestJS. */
  apiPrefix: string;
  /**
   * Label `mcp` injecté dans le host public du serveur MCP, retiré pour
   * reconstituer le Host tenant attendu par l'API. Géré en **préfixe** OU en
   * **infixe** :
   *   - préfixe  : `mcp.<slug>.<base>` → `<slug>.<base>`
   *   - infixe   : `<slug>.mcp.<base>` → `<slug>.<base>`   (recommandé : un seul
   *     wildcard `*.mcp.<base>` couvre tous les tenants en DMZ).
   * L'API résout le tenant depuis ce Host (mode pooled). En mode dedicated
   * c'est sans effet (l'API vise la base globale).
   */
  mcpLabel: string;
  /**
   * Host tenant forcé (optionnel). S'il est défini, on l'utilise tel quel et on
   * ignore le Host entrant — utile pour un déploiement dedicated/simple.
   */
  forcedTenantHost: string | null;
  /** Timeout des appels vers l'API (ms). */
  apiTimeoutMs: number;
  /**
   * Où pointe l'Authorization Server annoncé aux clients IA (RFC 9728) :
   *   - `self` (défaut) : l'AS = **CE serveur MCP** (host entrant). Convient au
   *     déploiement **DMZ** où la box forwarde `/oauth`, `/login`, le discovery…
   *     vers l'API on-premise — l'API interne n'est jamais exposée directement.
   *   - `tenant` : l'AS = le **host tenant** (label `mcp` retiré). Convient au
   *     déploiement co-localisé où le domaine tenant est lui-même joignable par
   *     le client IA.
   */
  authServerMode: AuthServerMode;
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function loadConfig(): McpConfig {
  return {
    port: intEnv('PORT', 8080),
    apiBaseUrl: (process.env.VAKS_API_URL ?? 'http://api:3000').replace(/\/+$/, ''),
    apiPrefix: '/' + (process.env.VAKS_API_PREFIX ?? 'api/v1').replace(/^\/+|\/+$/g, ''),
    // VAKS_STRIP_HOST_PREFIX conservé comme alias rétrocompatible de VAKS_MCP_LABEL.
    mcpLabel: (process.env.VAKS_MCP_LABEL ?? process.env.VAKS_STRIP_HOST_PREFIX ?? 'mcp')
      .trim()
      .toLowerCase(),
    forcedTenantHost: process.env.VAKS_TENANT_HOST?.trim() || null,
    apiTimeoutMs: intEnv('VAKS_API_TIMEOUT_MS', 20000),
    authServerMode: process.env.VAKS_AUTH_SERVER_MODE === 'tenant' ? 'tenant' : 'self',
  };
}

/**
 * Reconstitue le Host tenant attendu par l'API à partir du Host entrant, en
 * retirant le label `mcp` qu'il soit en **préfixe** (`mcp.demo.vaks-pm.com`) ou
 * en **infixe** (`demo.mcp.vaks-pm.com`) → `demo.vaks-pm.com`. Si
 * `forcedTenantHost` est posé, il l'emporte. Renvoie `undefined` si aucun Host
 * exploitable (l'API tombera sur la base globale en dedicated, rejettera en
 * pooled).
 */
export function resolveTenantHost(cfg: McpConfig, incomingHost?: string): string | undefined {
  if (cfg.forcedTenantHost) return cfg.forcedTenantHost;
  if (!incomingHost) return undefined;
  const host = incomingHost.toLowerCase().split(':')[0].trim();
  if (!host) return undefined;
  const label = cfg.mcpLabel;
  if (!label) return host;
  const parts = host.split('.');
  // Préfixe : `mcp.<slug>.<base>`.
  if (parts[0] === label && parts.length > 1) return parts.slice(1).join('.');
  // Infixe : `<slug>.mcp.<base>` (retire le 2e label).
  if (parts.length > 2 && parts[1] === label) {
    return [parts[0], ...parts.slice(2)].join('.');
  }
  return host;
}

/**
 * Origine publique de CE serveur MCP (= l'identifiant de ressource OAuth /
 * audience attendue dans les jetons, RFC 8707). Dérivée du Host entrant tel que
 * vu par le client IA (donc inclut le préfixe `mcp.`). Derrière Traefik, on est
 * toujours en https.
 */
export function resourceOrigin(incomingHost?: string): string {
  const host = (incomingHost ?? '').trim();
  return host ? `https://${host}` : '';
}

/**
 * Origine de l'Authorization Server annoncé aux clients IA.
 *   - `self`  : CE serveur MCP (host entrant). Le client fait tout le flux OAuth
 *     contre le host MCP, qui forwarde `/oauth`, `/login`, le discovery… vers
 *     l'API on-premise (déploiement DMZ — l'API n'est jamais exposée en direct).
 *   - `tenant`: le host tenant (label `mcp` retiré). Le client tape directement
 *     le domaine tenant (déploiement co-localisé, domaine tenant internet-facing).
 */
export function authorizationServer(cfg: McpConfig, incomingHost?: string): string {
  if (cfg.authServerMode === 'tenant') {
    const tenantHost = resolveTenantHost(cfg, incomingHost);
    return tenantHost ? `https://${tenantHost}` : '';
  }
  return resourceOrigin(incomingHost);
}
