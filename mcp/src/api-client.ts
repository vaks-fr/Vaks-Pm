import http from 'node:http';
import https from 'node:https';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { McpConfig } from './config.js';
import { pickLang } from './i18n.js';
import { msg } from './i18n-messages.js';

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
  /**
   * Jeton de confirmation d'une action destructrice, obtenu au premier appel
   * (défi 409). Relayé en **en-tête** et jamais dans le corps : les routes
   * DELETE n'ont pas de corps, et un champ supplémentaire collisionnerait avec
   * la whitelist de validation de chaque DTO côté API.
   */
  confirmToken?: string;
  /**
   * Tâche / projet sur lequel porte l'appel, lus dans les arguments du tool
   * (`AGENT_MCP_CALL_METER.md` §5). Sert **uniquement** l'attribution du coût :
   * l'API compte les appels MCP par `(agent, tâche)` pour estimer le coût d'un
   * agent facturé en crédits. Déclaratif et non vérifié — comme `justification`.
   * Aucun effet sur l'autorisation : les droits restent ceux de la route.
   */
  taskId?: string;
  projectId?: string;
}

/**
 * Contexte d'audit de l'appel **en cours**.
 *
 * Pourquoi un `AsyncLocalStorage` plutôt qu'un champ d'instance : un `ApiClient`
 * est bien construit par requête HTTP, mais une requête peut porter un **batch
 * JSON-RPC** (plusieurs `tools/call` dans un seul POST — c'est légal et le
 * transport le gère). Les handlers s'exécutent alors en concurrence sur le MÊME
 * client : avec un champ mutable, le contexte posé par le second écrase celui du
 * premier avant que sa requête sortante ne l'ait lu, et le journal d'audit
 * attribue la mauvaise justification au mauvais tool.
 *
 * ⚠️ L'instance est au niveau module mais **immuable**, et chaque contexte async
 * est isolé : ça n'introduit aucun état mutable partagé entre requêtes ou entre
 * utilisateurs. L'invariant de statelessness du serveur (cf. `main.ts`) tient —
 * ne pas prendre ce `const` pour une régression lors d'un prochain audit.
 */
const callContextStore = new AsyncLocalStorage<CallContext>();

/**
 * Exécute `fn` avec le contexte d'audit donné. À utiliser autour de TOUT
 * handler qui déclenche des appels API (tools, resources, completions) — sans
 * quoi les requêtes sortantes héritent du contexte d'un appel précédent.
 */
export function withCallContext<T>(ctx: CallContext, fn: () => T): T {
  return callContextStore.run(ctx, fn);
}

export class ApiClient {
  /**
   * Langue de l'utilisateur, posée après lecture de `/me/mcp-context`. Sans
   * elle, l'API retombait systématiquement sur l'anglais pour TOUT ce qui passe
   * par l'IA : messages d'erreur traduits (`ExceptionI18nFilter`) et exports de
   * rapports (`@CurrentLang()`) résolvent leur langue depuis `Accept-Language`,
   * en-tête que ce client n'envoyait jamais.
   */
  private language: string | null = null;

  constructor(
    private readonly cfg: McpConfig,
    private readonly bearer: string,
    private readonly tenantHost: string | undefined,
    /**
     * `User-Agent` du client IA entrant (Claude Desktop, Copilot Studio…),
     * relayé tel quel à l'API pour le journal d'audit. Déclaratif : c'est le
     * client qui s'annonce, rien ne l'authentifie — comme `justification`.
     */
    private readonly clientUserAgent?: string,
    /**
     * IP du client IA (`req.ip` du MCP, derrière Traefik), relayée en
     * `X-Forwarded-For` : l'API l'utilise comme clé de throttling par IP et
     * comme IP d'audit. Sans elle, tout le trafic MCP partageait un seau unique.
     */
    private readonly clientIp?: string,
  ) {}

  /** Pose la langue relayée à l'API via `Accept-Language` (étiquette IETF). */
  setLanguage(lang: string | null): void {
    this.language = lang;
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
    // IP du client IA : une seule valeur (celle calculée par le MCP), jamais la
    // chaîne XFF entrante brute — l'API fait confiance à un saut (`trust proxy 1`).
    if (this.clientIp && /^[0-9a-fA-F:.]{2,45}$/.test(this.clientIp)) {
      headers['x-forwarded-for'] = this.clientIp;
    }
    // Langue de l'utilisateur → messages d'erreur et exports dans SA langue.
    if (this.language) headers['accept-language'] = this.language;
    // Provenance : QUEL client IA est à l'origine de l'appel. Le `user-agent`
    // ci-dessus identifie le serveur MCP lui-même, pas son appelant.
    if (this.clientUserAgent) {
      headers['x-vaks-mcp-client'] = this.clientUserAgent
        .slice(0, 200)
        // eslint-disable-next-line no-control-regex
        .replace(/[^\x20-\x7E]/g, '?');
    }
    // Contexte d'audit (chantier agents 1) : nom du tool + justification.
    // Headers ASCII only — on encode la justification en RFC 2047 n'étant pas
    // praticable côté serveur, on remplace les caractères non-latin1 (rare).
    // Contexte async (correct sous batch/concurrence) — cf. `callContextStore`.
    const ctx: CallContext = callContextStore.getStore() ?? {};
    if (ctx.tool) headers['x-vaks-mcp-tool'] = ctx.tool.slice(0, 200);
    if (ctx.confirmToken) headers['x-vaks-confirm-token'] = ctx.confirmToken.slice(0, 200);
    // Contexte de coût : imputation de l'appel à une tâche, à défaut un projet.
    if (ctx.taskId) headers['x-vaks-task-id'] = ctx.taskId;
    if (ctx.projectId) headers['x-vaks-project-id'] = ctx.projectId;
    if (ctx.justification) {
      headers['x-vaks-justification'] = ctx.justification
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
        reject(new VaksApiError(msg(this.lang(), 'apiUnreachable', e.message), 0)),
      );
      req.on('timeout', () => req.destroy(new VaksApiError(msg(this.lang(), 'apiTimeout'), 0)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }

  /** Langue des messages : celle posée après le handshake, sinon anglais. */
  private lang() {
    return pickLang(this.language);
  }

  /** Traduit un statut HTTP en message exploitable (lu par l'IA ET l'utilisateur). */
  private explain(status: number, detail: string): string {
    const l = this.lang();
    switch (status) {
      case 401:
        return msg(l, 'api401');
      case 403:
        return msg(l, 'api403', detail);
      case 404:
        return msg(l, 'api404', detail);
      case 429:
        return msg(l, 'api429');
      default:
        return msg(l, 'apiOther', status, detail);
    }
  }
}
