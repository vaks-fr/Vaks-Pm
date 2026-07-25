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
app.use(express.json({ limit: '4mb' }));

/** Réponse d'erreur JSON-RPC (le corps attendu par un client MCP). */
function rpcError(res: Response, status: number, code: number, message: string) {
  res.status(status).json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
}

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
  const api = new ApiClient(cfg, bearer, tenantHost);

  // 2bis. Contexte du jeton (validation **tôt** + scopes accordés). Un 401 ici
  // = jeton invalide/expiré/révoqué → on propage `WWW-Authenticate` pour que le
  // client IA relance le login (RFC 9728). Un 403 = jeton valide mais sans le
  // scope `mcp:access`. Toute autre erreur (API injoignable) → on dégrade en
  // lecture seule plutôt que de bloquer la session.
  let allowWrite = false;
  try {
    const ctx = (await api.get('me/mcp-context')) as { write?: boolean };
    allowWrite = ctx?.write === true;
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
      return rpcError(res, 403, -32003, "Ce jeton n'a pas le scope « mcp:access ».");
    }
    // API injoignable / autre : on continue en lecture seule (les tools de
    // lecture marcheront ou échoueront d'eux-mêmes avec un message clair).
  }

  // 3. Serveur + transport jetables (stateless).
  const server = buildServer(api, allowWrite);
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

app.listen(cfg.port, () => {
  // eslint-disable-next-line no-console
  console.log(`[mcp] Vaks-PM MCP server à l'écoute sur :${cfg.port} → API ${cfg.apiBaseUrl}${cfg.apiPrefix}`);
});
