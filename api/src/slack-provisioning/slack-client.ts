/* ============================================================
   Client Slack Web API minimal (fetch). On ne dépend pas du SDK
   officiel : trois endpoints suffisent au provisioning d'un canal.
   Toutes les réponses Slack sont `{ ok: boolean, error?: string, … }`.
   ============================================================ */

const SLACK_API = 'https://slack.com/api';
const TIMEOUT_MS = 10_000;

export interface SlackChannel {
  id: string;
  name: string;
}

/**
 * Appel Slack authentifié (bot token). Lève sur `ok:false` ou HTTP non-2xx.
 *
 * ⚠️ Toutes les méthodes Slack n'acceptent PAS le même encodage : les méthodes
 * « JSON-friendly » (`conversations.*`, `chat.*`) prennent un corps JSON, mais
 * d'autres — notamment `users.lookupByEmail` — n'acceptent QUE du
 * `x-www-form-urlencoded` et répondent `invalid_arguments` à du JSON. D'où
 * `form: true` pour ces méthodes-là.
 */
async function call<T = Record<string, unknown>>(
  token: string,
  method: string,
  body: Record<string, unknown>,
  opts: { form?: boolean } = {},
): Promise<T & { ok: true }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': opts.form
          ? 'application/x-www-form-urlencoded; charset=utf-8'
          : 'application/json; charset=utf-8',
      },
      body: opts.form
        ? new URLSearchParams(
            Object.entries(body).map(([k, v]) => [k, String(v)] as [string, string]),
          ).toString()
        : JSON.stringify(body),
      signal: ac.signal,
    });
    const json = (await res.json()) as { ok: boolean; error?: string } & Record<string, unknown>;
    if (!res.ok) throw new Error(`Slack ${method}: HTTP ${res.status}`);
    if (!json.ok) throw new Error(`Slack ${method}: ${json.error ?? 'erreur inconnue'}`);
    return json as T & { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

export class SlackClient {
  constructor(private readonly token: string) {}

  /** Vérifie le token (auth.test) — renvoie le domaine du workspace. */
  async authTest(): Promise<{ team: string; url: string }> {
    const r = await call<{ team: string; url: string }>(this.token, 'auth.test', {});
    return { team: r.team, url: r.url };
  }

  /** Crée un canal (public ou privé). 409-like `name_taken` remonté par `call`. */
  async createChannel(name: string, isPrivate: boolean): Promise<SlackChannel> {
    const r = await call<{ channel: SlackChannel }>(this.token, 'conversations.create', {
      name,
      is_private: isPrivate,
    });
    return r.channel;
  }

  /**
   * Archive un canal. Slack ne permet PAS de le SUPPRIMER par API
   * (`conversations.delete` est réservé à Enterprise Grid) : l'archivage est le
   * seul nettoyage disponible — le canal passe en lecture seule et sort des
   * listes, le contenu est conservé. Scope : `groups:write` (privé) /
   * `channels:manage` (public) — déjà requis pour créer et inviter.
   * `already_archived` est traité comme un succès (idempotence).
   */
  async archive(channelId: string): Promise<'ok' | 'already'> {
    try {
      await call(this.token, 'conversations.archive', { channel: channelId });
      return 'ok';
    } catch (e) {
      if (/already_archived/.test((e as Error).message)) return 'already';
      throw e;
    }
  }

  /**
   * Résout un utilisateur Slack par email. Ne lève jamais, mais **remonte la
   * raison** de l'échec : `users_not_found` (email absent du workspace) et
   * `missing_scope` (scope `users:read.email` non accordé) doivent être
   * distinguables — sinon un problème de configuration ressemble à un simple
   * email inconnu, et personne ne comprend pourquoi rien n'est invité.
   */
  async lookupByEmail(email: string): Promise<{ id: string | null; error?: string }> {
    try {
      // `form: true` obligatoire : cette méthode refuse le JSON (invalid_arguments).
      const r = await call<{ user: { id: string } }>(
        this.token,
        'users.lookupByEmail',
        { email },
        { form: true },
      );
      return { id: r.user.id };
    } catch (e) {
      return { id: null, error: (e as Error).message };
    }
  }

  /**
   * Invite UN utilisateur dans un canal. Invitation unitaire (et non un CSV
   * global) pour tolérer les échecs individuels : Slack fait échouer tout
   * l'appel si un seul id est déjà membre (`already_in_channel`).
   * Renvoie `already` quand l'utilisateur y est déjà — ce n'est pas une erreur.
   */
  async inviteOne(channelId: string, userId: string): Promise<'ok' | 'already' | string> {
    try {
      await call(this.token, 'conversations.invite', { channel: channelId, users: userId });
      return 'ok';
    } catch (e) {
      const msg = (e as Error).message;
      return /already_in_channel/.test(msg) ? 'already' : msg;
    }
  }
}
