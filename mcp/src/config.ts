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
   * Host tenant forcé (optionnel). S'il est défini, on l'utilise tel quel et on
   * ignore le Host entrant — utile pour un déploiement **mono-tenant** où aucun
   * sous-domaine par tenant n'existe.
   */
  forcedTenantHost: string | null;
  /** Timeout des appels vers l'API (ms). */
  apiTimeoutMs: number;
  /**
   * Où pointe l'Authorization Server annoncé aux clients IA (RFC 9728) :
   *   - `self` (défaut) : l'AS = **CE serveur MCP** (host entrant). Convient au
   *     déploiement **DMZ** où la box forwarde `/oauth`, `/login`, le discovery…
   *     vers l'API on-premise — l'API interne n'est jamais exposée directement.
   *   - `tenant` : l'AS = le host tenant. Depuis le pass-through du Host (plus
   *     de retrait du label `mcp`), il vaut le Host entrant — donc **équivalent
   *     à `self`**, sauf avec `VAKS_TENANT_HOST` (mono-tenant) où il annonce le
   *     host épinglé. Option conservée pour compatibilité des déploiements.
   */
  authServerMode: AuthServerMode;
  /**
   * Suffixes de domaine publics acceptés dans le Host entrant (env
   * `VAKS_PUBLIC_HOST_SUFFIXES`, séparés par des virgules, ex.
   * `vaks-pm.com,mcp.exemple.fr`). Vide = contrôle syntaxique seul.
   */
  publicHostSuffixes: string[];
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
    forcedTenantHost: process.env.VAKS_TENANT_HOST?.trim() || null,
    apiTimeoutMs: intEnv('VAKS_API_TIMEOUT_MS', 20000),
    authServerMode: process.env.VAKS_AUTH_SERVER_MODE === 'tenant' ? 'tenant' : 'self',
    publicHostSuffixes: (process.env.VAKS_PUBLIC_HOST_SUFFIXES ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase().replace(/^\.+/, ''))
      .filter(Boolean),
  };
}

const HOST_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)*(?::\d{1,5})?$/;
/** Littéral IPv6 entre crochets (ex. `[::1]:8080`) — tests locaux / accès par IP. */
const IPV6_HOST_RE = /^\[[0-9a-f:.]{2,45}\](?::\d{1,5})?$/;

/**
 * Host entrant **validé**, ou `undefined`. Le Host alimente des URLs renvoyées
 * au client (redirection `GET /mcp`, `resource_metadata`, issuer OAuth) : sans
 * contrôle, un Host forgé produisait une redirection ouverte et injectait du
 * texte arbitraire dans `WWW-Authenticate`. Syntaxe DNS stricte + allow-list
 * de suffixes optionnelle (`cfg.publicHostSuffixes`).
 */
export function validHost(cfg: Pick<McpConfig, 'publicHostSuffixes'>, incomingHost?: string): string | undefined {
  const host = (incomingHost ?? '').trim().toLowerCase();
  if (!host || host.length > 253 || !(HOST_RE.test(host) || IPV6_HOST_RE.test(host))) return undefined;
  if (cfg.publicHostSuffixes.length) {
    const name = host.split(':')[0];
    const ok = cfg.publicHostSuffixes.some((sfx) => name === sfx || name.endsWith(`.${sfx}`));
    if (!ok) return undefined;
  }
  return host;
}

/**
 * Host à présenter à l'API pour que celle-ci résolve le tenant.
 *
 * **Pass-through** : on relaie le Host public **tel quel**. C'est l'API qui
 * connaît la topologie et résout le tenant depuis ce Host — sous-domaine
 * canonique `<slug>.<base>`, domaine custom, ou domaine MCP public déclaré dans
 * `TENANCY_MCP_DOMAINS` (cas du MCP en DMZ sur un domaine distinct de l'interne).
 * Le serveur MCP n'a donc plus rien à reconstituer ni à deviner.
 *
 * `forcedTenantHost` (env `VAKS_TENANT_HOST`) l'emporte : pour un déploiement
 * **mono-tenant** sans sous-domaine par tenant, on épingle le Host tenant.
 * Renvoie `undefined` si aucun Host exploitable.
 */
export function resolveTenantHost(cfg: McpConfig, incomingHost?: string): string | undefined {
  if (cfg.forcedTenantHost) return cfg.forcedTenantHost;
  if (!incomingHost) return undefined;
  const host = incomingHost.toLowerCase().split(':')[0].trim();
  return host || undefined;
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
 *   - `tenant`: le host tenant. En pass-through, c'est le host entrant — pertinent
 *     en co-localisé où le domaine tenant est lui-même internet-facing.
 */
export function authorizationServer(cfg: McpConfig, incomingHost?: string): string {
  if (cfg.authServerMode === 'tenant') {
    const tenantHost = resolveTenantHost(cfg, incomingHost);
    return tenantHost ? `https://${tenantHost}` : '';
  }
  return resourceOrigin(incomingHost);
}
