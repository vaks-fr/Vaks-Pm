import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  loadConfig,
  resolveTenantHost,
  resourceOrigin,
  authorizationServer,
} from './config.js';
import { buildServer } from './server.js';
import { ApiClient, VaksApiError } from './api-client.js';
import { ACCEPT_LANGUAGE, pickLang } from './i18n.js';

/**
 * Point d'entrée du serveur MCP Vaks-PM.
 *
 * Transport : **Streamable HTTP stateless** (le seul commun à Claude, Copilot
 * Studio et ChatGPT ; SSE abandonné par ces deux derniers). Chaque POST /mcp
 * crée un serveur + transport jetables → simple à scaler horizontalement,
 * sans état de session partagé entre réplicas.
 *
 * Auth (incrément 1) : on extrait le `Authorization: Bearer vaks_…` et on le
 * relaie à l'API, qui le valide (phase 9) et applique le RBAC. Le serveur MCP
 * ne détient AUCUN secret et ne touche ni la DB, ni Redis, ni Garage.
 * L'incrément 2 ajoutera la couche OAuth (RFC 9728 + façade Entra) pour le login
 * navigateur sans coller de jeton.
 */
const cfg = loadConfig();
const app = express();

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
      return rpcError(res, 503, -32000, 'Serveur MCP en cours d’arrêt, réessayer (un autre réplica prend le relais).');
    }
  }
  inFlight++;
  res.on('close', () => {
    inFlight--;
  });
  next();
});

app.use(express.json({ limit: '4mb' }));

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
  // 1. Jeton bearer obligatoire.
  const auth = req.headers['authorization'];
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!bearer) {
    // RFC 9728 §5.1 : on pointe le client vers les métadonnées de la ressource
    // → il découvre l'AS et lance le flux OAuth (login navigateur).
    res.setHeader(
      'WWW-Authenticate',
      `Bearer realm="vaks-pm-mcp", resource_metadata="${resourceMetadataUrl(req)}"`,
    );
    return rpcError(res, 401, -32001, "Jeton d'accès requis (Authorization: Bearer …).");
  }

  // 2. Host tenant reconstitué (mode pooled) pour que l'API résolve la bonne org.
  const tenantHost = resolveTenantHost(cfg, req.headers.host);
  // Le `User-Agent` entrant identifie le CLIENT IA (Claude Desktop, Copilot
  // Studio, ChatGPT…). Relayé à l'API pour le journal d'audit — c'est la seule
  // trace de la provenance d'une action, et elle manquait.
  const clientUa = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
  const api = new ApiClient(cfg, bearer, tenantHost, clientUa);

  // 2bis. Contexte du jeton (validation **tôt** + scopes accordés). Un 401 ici
  // = jeton refusé côté API (invalide, expiré, révoqué, ou — pour un agent —
  // propriétaire humain inactif) → on propage `WWW-Authenticate` pour que le
  // client IA relance le login (RFC 9728). `me/mcp-context` ne renvoie PAS de
  // 403 en pratique (`verify()` retombe sur 401 dans tous les cas de refus) ;
  // la branche 403 ci-dessous est un filet défensif générique, pas un check du
  // scope `mcp:access` (aucun gate ne lit ce scope — cf. commentaire
  // `PERMISSIONS` côté shared). Toute autre erreur (API injoignable) → on
  // dégrade en lecture seule plutôt que de bloquer la session.
  let allowWrite = false;
  let lang = pickLang(null);
  try {
    const ctx = (await api.get('me/mcp-context')) as {
      write?: boolean;
      preferredLanguage?: string | null;
    };
    allowWrite = ctx?.write === true;
    // Langue de l'utilisateur : pilote les libellés de prompts ET la langue de
    // réponse demandée au modèle. Posée sur le client pour que les appels
    // suivants portent `Accept-Language` (erreurs et exports traduits).
    lang = pickLang(ctx?.preferredLanguage);
    api.setLanguage(ACCEPT_LANGUAGE[lang]);
  } catch (e) {
    if (e instanceof VaksApiError && e.status === 401) {
      res.setHeader(
        'WWW-Authenticate',
        `Bearer realm="vaks-pm-mcp", error="invalid_token", resource_metadata="${resourceMetadataUrl(req)}"`,
      );
      return rpcError(
        res,
        401,
        -32001,
        'Accès Vaks-PM expiré ou déconnecté. Cette connexion IA a été révoquée (par vous-même ' +
          'dans Sécurité → Connexions IA, ou par un administrateur) ou le jeton a expiré. ' +
          'Reconnectez le connecteur Vaks-PM pour continuer.',
      );
    }
    if (e instanceof VaksApiError && e.status === 403) {
      // Filet défensif : `me/mcp-context` ne 403 pas aujourd'hui (refus = 401),
      // mais si un futur guard le faisait, on rend un message honnête plutôt que
      // d'incriminer un scope qui n'est pas vérifié.
      return rpcError(res, 403, -32003, 'Accès refusé par Vaks-PM pour ce jeton.');
    }
    // API injoignable / autre : on continue en lecture seule (les tools de
    // lecture marcheront ou échoueront d'eux-mêmes avec un message clair).
  }

  // 3. Serveur + transport jetables (stateless).
  const server = buildServer(api, allowWrite, lang);
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
      rpcError(res, 500, -32603, 'Erreur interne du serveur MCP.');
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
  return rpcError(res, 405, -32000, 'Méthode non autorisée (serveur MCP stateless : utiliser POST /mcp).');
});
// DELETE (fin de session) n'a pas de sens en stateless.
app.delete('/mcp', (_req: Request, res: Response) =>
  rpcError(res, 405, -32000, 'Méthode non autorisée (serveur MCP stateless : utiliser POST /mcp).'),
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
