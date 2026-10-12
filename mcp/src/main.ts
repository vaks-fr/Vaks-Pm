import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  loadConfig,
  resolveTenantHost,
  resourceOrigin,
  authorizationServer,
  validHost,
} from './config.js';
import { buildServer } from './server.js';
import { ApiClient } from './api-client.js';
import { ACCEPT_LANGUAGE, pickLang } from './i18n.js';
import { classifyHandshakeError, extractBearer, isVaksToken } from './auth.js';
import { langFromAcceptLanguage, msg } from './i18n-messages.js';

/**
 * Point d'entrée du serveur MCP Vaks-PM.
 *
 * Transport : **Streamable HTTP stateless** (le seul commun à Claude, Copilot
 * Studio et ChatGPT ; SSE abandonné par ces deux derniers). Chaque POST /mcp
 * crée un serveur + transport jetables → simple à scaler horizontalement,
 * sans état de session partagé entre réplicas.
 *
 * Auth : on extrait le `Authorization: Bearer vaks_…` et on le relaie à l'API,
 * qui le valide (phase 9) et applique le RBAC. Seuls les jetons `vaks_…` sont
 * relayés (cf. `isVaksToken`). Le login navigateur passe par la façade OAuth
 * (RFC 9728, métadonnées ci-dessous). Le serveur MCP ne détient AUCUN secret
 * et ne touche ni la DB, ni Redis, ni Garage.
 */
const cfg = loadConfig();
const app = express();
// Derrière Traefik (un saut) : `req.ip` = IP réelle du client IA, relayée à
// l'API en `X-Forwarded-For`. Sans ça l'API voit l'IP du conteneur mcp pour
// TOUS les clients de TOUS les tenants → un seul seau de throttling (DoS).
app.set('trust proxy', 1);

/** Réponse d'erreur JSON-RPC (le corps attendu par un client MCP). */
function rpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

/**
 * Arrêt gracieux (`stop_grace_period: 30s` côté Swarm).
 *
 * Sans ça, Node applique l'action SIGTERM par défaut — terminer immédiatement —
 * et chaque rolling update coupe les requêtes en vol au milieu de la réponse.
 * Avec 2 réplicas derrière le VIP Swarm, ça se produit à chaque déploiement.
 *
 * L'invariant à respecter est `apiTimeoutMs < DRAIN_MS < stop_grace_period` :
 * un appel de tool légitime peut occuper `apiTimeoutMs` (20 s par défaut), donc
 * drainer moins longtemps couperait exactement les appels lents qu'on protège.
 */
const DRAIN_MS = 25_000;
let draining = false;
let inFlight = 0;

/**
 * Compteur de requêtes en vol + refus des nouvelles pendant le drain. Enregistré
 * AVANT `express.json()` : on veut compter la requête dès son arrivée, sans
 * attendre d'avoir parsé un corps qu'on va peut-être refuser.
 */
app.use((req, res, next) => {
  if (draining) {
    // 503 + `Connection: close` plutôt qu'un reset TCP : le client IA voit une
    // erreur explicitement retryable et rejoue sur un autre réplica.
    // `/healthz` est exempté — c'est la sonde Swarm, pas du trafic MCP.
    if (req.path !== '/healthz') {
      res.setHeader('Connection', 'close');
      return rpcError(res, 503, -32000, msg(langFromAcceptLanguage(req.headers['accept-language']), 'shuttingDown'));
    }
  }
  inFlight++;
  res.on('close', () => {
    inFlight--;
  });
  next();
});

app.use(express.json({ limit: '4mb' }));

// Host entrant validé AVANT tout usage (URLs renvoyées au client, Host relayé à
// l'API). Un Host invalide ou hors allow-list → 421 (Misdirected Request).
// `/healthz` exempté : la sonde Swarm frappe 127.0.0.1:8080.
app.use((req, res, next) => {
  if (req.path === '/healthz') return next();
  const host = validHost(cfg, req.headers.host);
  if (!host) return rpcError(res, 421, -32000, msg(langFromAcceptLanguage(req.headers['accept-language']), 'unknownHost'));
  req.headers.host = host;
  next();
});

// Healthchecks Swarm/K8s.
app.get('/healthz', (_req, res) => res.status(200).json({ status: 'ok' }));

/**
 * RFC 9728 — Protected Resource Metadata. Les clients IA (Claude, ChatGPT,
 * Copilot Studio, VS Code) lisent ce document pour découvrir QUEL serveur
 * d'autorisation interroger. On y annonce l'AS (= l'API du tenant, qui héberge
 * la façade OAuth et fédère vers Entra) et l'identifiant de cette ressource
 * (= l'origine publique du serveur MCP, qui doit être l'audience du jeton).
 */
function protectedResourceMetadata(req: Request) {
  const resource = resourceOrigin(req.headers.host);
  const as = authorizationServer(cfg, req.headers.host);
  return {
    resource,
    authorization_servers: as ? [as] : [],
    scopes_supported: ['mcp:access'],
    bearer_methods_supported: ['header'],
  };
}

app.get('/.well-known/oauth-protected-resource', (req, res) => {
  res.status(200).json(protectedResourceMetadata(req));
});
// Variante « par ressource » (certains clients suffixent le chemin de la
// ressource, ici `/mcp`) — on sert les mêmes métadonnées.
app.get('/.well-known/oauth-protected-resource/mcp', (req, res) => {
  res.status(200).json(protectedResourceMetadata(req));
});

/** URL des métadonnées RFC 9728 à pointer dans le `WWW-Authenticate`. */
function resourceMetadataUrl(req: Request): string {
  return `${resourceOrigin(req.headers.host)}/.well-known/oauth-protected-resource`;
}

app.post('/mcp', async (req: Request, res: Response) => {
  // Langue des erreurs AVANT le handshake : celle annoncée par le client IA.
  const reqLang = langFromAcceptLanguage(req.headers['accept-language']);
  // 1. Jeton bearer obligatoire (Authorization: Bearer …, repli X-Api-Key).
  const bearer = extractBearer(req.headers);
  if (!bearer || !isVaksToken(bearer)) {
    // RFC 9728 §5.1 : on pointe le client vers les métadonnées de la ressource
    // → il découvre l'AS et lance le flux OAuth (login navigateur).
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="vaks-pm-mcp", resource_metadata="${resourceMetadataUrl(req)}"`,
    );
    return rpcError(res, 401, -32001, msg(reqLang, 'tokenRequired'));
  }

  // 2. Host tenant reconstitué (mode pooled) pour que l'API résolve la bonne org.
  const tenantHost = resolveTenantHost(cfg, req.headers.host);
  // Le `User-Agent` entrant identifie le CLIENT IA (Claude Desktop, Copilot
  // Studio, ChatGPT…). Relayé à l'API pour le journal d'audit — c'est la seule
  // trace de la provenance d'une action, et elle manquait.
  const clientUa = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  const api = new ApiClient(cfg, bearer, tenantHost, clientUa, req.ip);
  // Le handshake part dans la langue du client : un refus de l'API (connecteur
  // désactivé…) revient ainsi traduit. Remplacée ensuite par la langue du user.
  api.setLanguage(ACCEPT_LANGUAGE[reqLang]);

  // 2bis. Contexte du jeton (validation **tôt** + scopes accordés). Un 401 ici
  // = jeton refusé côté API (invalide, expiré, révoqué, ou — pour un agent —
  // propriétaire humain inactif) → on propage `WWW-Authenticate` pour que le
  // client IA relance le login (RFC 9728). Un 403 = connecteur désactivé par
  // l'organisation (`mcp.enabled`). Toute autre erreur → 503 (fail-closed,
  // cf. `classifyHandshakeError`).
  let allowWrite = false;
  let allowFinance = false;
  let actorKind: string | undefined;
  let billingUnit: string | undefined;
  let lang = pickLang(null);
  try {
    const ctx = (await api.get('me/mcp-context')) as {
      write?: boolean;
      finance?: boolean;
      preferredLanguage?: string | null;
      actorKind?: string;
      billingUnit?: string;
    };
    allowWrite = ctx?.write === true;
    // Toggle org « finance exposée à l'IA » : pilote l'EXPOSITION des tools
    // finance (l'enforcement reste `FinanceApiGateGuard` côté API, fail-closed).
    allowFinance = ctx?.finance === true;
    actorKind = ctx?.actorKind;
    billingUnit = ctx?.billingUnit;
    // Langue de l'utilisateur : pilote les libellés de prompts ET la langue de
    // réponse demandée au modèle. Posée sur le client pour que les appels
    // suivants portent `Accept-Language` (erreurs et exports traduits).
    lang = pickLang(ctx?.preferredLanguage);
    api.setLanguage(ACCEPT_LANGUAGE[lang]);
  } catch (e) {
    const failure = classifyHandshakeError(e);
    if (failure.kind === 'unauthorized') {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="vaks-pm-mcp", error="invalid_token", resource_metadata="${resourceMetadataUrl(req)}"`,
      );
      return rpcError(res, 401, -32001, msg(reqLang, 'accessExpired'));
    }
    if (failure.kind === 'forbidden') {
      // L'organisation a désactivé le connecteur. Échec DUR volontaire — se
      // réauthentifier n'y changerait rien, donc pas de relance du flux OAuth.
      return rpcError(res, 403, -32003, failure.reason ?? msg(reqLang, 'accessDenied'));
    }
    // API injoignable / 429 / 5xx : jamais de serveur dégradé (fail-closed).
    res.setHeader('Connection', 'close');
    return rpcError(res, 503, -32000, msg(reqLang, 'apiUnavailable'));
  }

  // 3. Serveur + transport jetables (stateless).
  const server = buildServer(api, allowWrite, lang, actorKind, allowFinance, billingUnit);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[mcp] handler error', e);
    if (!res.headersSent) {
      rpcError(res, 500, -32603, msg(lang, 'internalError'));
    }
  }
});

// GET /mcp : un client MCP n'en fait jamais (stateless = POST). Si c'est un
// NAVIGATEUR (Accept: text/html), on redirige vers la page de login de l'app
// plutôt que d'afficher du JSON technique. Sinon (outil/curl), 405 JSON-RPC.
app.get('/mcp', (req: Request, res: Response) => {
  const accept = String(req.headers['accept'] ?? '');
  if (accept.includes('text/html')) {
    return res.redirect(302, `${authorizationServer(cfg, req.headers.host)}/login`);
  }
  return rpcError(res, 405, -32000, msg(langFromAcceptLanguage(req.headers['accept-language']), 'methodNotAllowed'));
});
// DELETE (fin de session) n'a pas de sens en stateless.
app.delete('/mcp', (req: Request, res: Response) =>
  rpcError(res, 405, -32000, msg(langFromAcceptLanguage(req.headers['accept-language']), 'methodNotAllowed')),
);

const httpServer = app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[mcp] Vaks-PM MCP server listening on :${cfg.port} → API ${cfg.apiBaseUrl}${cfg.apiPrefix}`);
});

function shutdown(signal: string): void {
  if (draining) return; // idempotent : SIGTERM puis SIGINT ne relancent pas le drain
  draining = true;
  // eslint-disable-next-line no-console
  console.log(`[mcp] ${signal} received, draining (${inFlight} request(s) in flight)`);

  let done = false;
  const finish = (why: string) => {
    if (done) return;
    done = true;
    // Journaliser le compteur à la sortie rend visible la différence entre un
    // drain qui a réellement vidé et un drain qui a juste expiré.
    // eslint-disable-next-line no-console
    console.log(`[mcp] exiting after drain (${why}, ${inFlight} still in flight)`);
    process.exit(0);
  };

  httpServer.close(() => finish('all connections closed'));

  // ⚠️ Point critique : Traefik maintient des sockets keep-alive ouvertes.
  // `close()` seul attend leur fermeture, donc son callback ne se déclenche
  // jamais et le process tient jusqu'à la fin de la grâce à CHAQUE update — un
  // drain qui a l'air de marcher alors qu'il ne fait qu'expirer.
  // On réitère : une socket occupée maintenant deviendra inactive à la fin de
  // sa requête, et doit être fermée à ce moment-là.
  const reap = () => httpServer.closeIdleConnections();
  reap();
  const reaper = setInterval(reap, 250);
  reaper.unref();

  const backstop = setTimeout(() => finish('drain timeout'), DRAIN_MS);
  backstop.unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
