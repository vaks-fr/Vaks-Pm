import http from 'node:http';
import https from 'node:https';
import type { McpConfig } from './config.js';

/**
 * Client HTTP minimal vers l'API Vaks-PM, **lié à une requête MCP** : il porte
 * le jeton (`Authorization: Bearer vaks_…`) présenté par le client IA et le Host
 * tenant reconstitué. Chaque requête MCP construit son propre client → aucune
 * identité partagée entre utilisateurs.
 *
 * ⚠️ On utilise le module **`http`/`https` natif** et PAS `fetch` : le standard
 * Fetch classe `Host` comme en-tête **interdit**, donc undici l'ignore sur le
 * fil et envoie le Host de l'URL (`api:3000`). Or l'API résout le tenant depuis
 * le Host (mode pooled) → sans le bon Host, mauvaise base, jeton introuvable
 * (401). Le module `http` natif, lui, respecte un `Host` explicite.
 *
 * Le serveur MCP ne valide PAS le jeton : il le relaie. L'API applique l'auth
 * (phase 9), le public-gate (`@PublicApi`) et le RBAC.
 */
/** Identifiant d'agent posé sur chaque requête relayée (header + User-Agent). */
const MCP_AGENT_ID = 'vaks-pm-mcp/0.1.0';

export class VaksApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'VaksApiError';
  }
}

/** Contexte d'audit optionnel d'un appel : tool MCP d'origine + justification. */
export interface CallContext {
  tool?: string;
  justification?: string;
}

export class ApiClient {
  /** Contexte posé par le tool courant (client par requête MCP → pas de course). */
  private callContext: CallContext = {};

  constructor(
    private readonly cfg: McpConfig,
    private readonly bearer: string,
    private readonly tenantHost: string | undefined,
  ) {}

  /**
   * Pose le contexte d'audit du prochain appel (nom du tool + justification en
   * langage naturel fournie par l'agent). Transmis à l'API via les headers
   * `X-Vaks-Mcp-Tool` / `X-Vaks-Justification` → visibles dans le journal d'audit.
   */
  setCallContext(ctx: CallContext): void {
    this.callContext = ctx;
  }

  private url(path: string, query?: Record<string, string | number | undefined>): string {
    const base = `${this.cfg.apiBaseUrl}${this.cfg.apiPrefix}/${path.replace(/^\/+/, '')}`;
    if (!query) return base;
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  }

  async get(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.request('GET', this.url(path, query));
  }

  async post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', this.url(path), body);
  }

  async patch(path: string, body: unknown): Promise<unknown> {
    return this.request('PATCH', this.url(path), body);
  }

  async put(path: string, body: unknown): Promise<unknown> {
    return this.request('PUT', this.url(path), body);
  }

  async delete(path: string): Promise<unknown> {
    return this.request('DELETE', this.url(path));
  }

  private request(method: string, urlStr: string, body?: unknown): Promise<unknown> {
    const u = new URL(urlStr);
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const payload = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.bearer}`,
      accept: 'application/json',
      // Marque l'origine « agent IA » : l'API (audit) en déduit actorType=AGENT,
      // distinct d'un script API brut portant le même jeton. `user-agent` double
      // le signal en clair dans le journal d'audit.
      'x-vaks-agent': MCP_AGENT_ID,
      'user-agent': MCP_AGENT_ID,
    };
    // Contexte d'audit (chantier agents 1) : nom du tool + justification.
    // Headers ASCII only — on encode la justification en RFC 2047 n'étant pas
    // praticable côté serveur, on remplace les caractères non-latin1 (rare).
    if (this.callContext.tool) headers['x-vaks-mcp-tool'] = this.callContext.tool.slice(0, 200);
    if (this.callContext.justification) {
      headers['x-vaks-justification'] = this.callContext.justification
        .slice(0, 1000)
        // eslint-disable-next-line no-control-regex
        .replace(/[^\x20-\x7E -ÿ]/g, '?');
    }
    // Host explicite → l'API (pooled) résout le bon tenant. Respecté par le
    // module http natif (contrairement à fetch).
    if (this.tenantHost) headers.host = this.tenantHost;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(payload));
    }

    return new Promise((resolve, reject) => {
      const req = mod.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
          timeout: this.cfg.apiTimeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c as Buffer));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : null;
            } catch {
              /* corps non-JSON : on garde le texte brut */
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) return resolve(parsed);
            const detail =
              parsed && typeof parsed === 'object' && 'message' in parsed
                ? String((parsed as { message: unknown }).message)
                : res.statusMessage || '';
            reject(new VaksApiError(this.explain(status, detail), status, parsed));
          });
        },
      );
      req.on('error', (e) =>
        reject(new VaksApiError(`Impossible de joindre l'API Vaks-PM (${e.message}).`, 0)),
      );
      req.on('timeout', () => req.destroy(new VaksApiError("Délai dépassé en joignant l'API.", 0)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Traduit un statut HTTP en message exploitable par l'agent IA. */
  private explain(status: number, detail: string): string {
    switch (status) {
      case 401:
        return (
          'Accès Vaks-PM coupé : cette connexion IA a été déconnectée (par l’utilisateur dans ' +
          'Sécurité → Connexions IA, ou par un administrateur) ou le jeton a expiré. ' +
          'Pour continuer, l’utilisateur doit reconnecter le connecteur Vaks-PM dans son client IA.'
        );
      case 403:
        return `Accès refusé : le périmètre de l'utilisateur ne couvre pas cette opération (${detail}).`;
      case 404:
        return `Ressource introuvable (${detail}).`;
      case 429:
        return 'Trop de requêtes (rate-limit). Réessayer plus tard.';
      default:
        return `Erreur API (${status}) : ${detail}`;
    }
  }
}
