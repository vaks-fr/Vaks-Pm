/* ============================================================
   Client Google Chat API minimal (fetch). L'acquisition du jeton est
   déléguée à un `GoogleTokenProvider` (mode `sa_key` clé téléchargée, ou
   `wif` Workload Identity Federation sans clé — voir `google-token-provider`).
   Trois appels REST suffisent au provisioning d'un espace : jeton, création,
   membres.
   ============================================================ */
import { GoogleTokenProvider } from './google-token-provider';

const CHAT_API = 'https://chat.googleapis.com/v1';
const TIMEOUT_MS = 10_000;

/** Appel Chat API authentifié (bearer). Lève sur HTTP non-2xx. */
async function call<T = Record<string, unknown>>(
  accessToken: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${CHAT_API}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
    if (!res.ok) throw new Error(`Google Chat ${method} ${path}: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

export interface ChatSpace {
  /** Nom de ressource complet, ex. `spaces/AAAAAAAAAAA`. */
  name: string;
  displayName: string;
}

export class GoogleChatClient {
  constructor(private readonly tokens: GoogleTokenProvider) {}

  /** Access token frais (le provider décide comment l'obtenir). */
  private async token(): Promise<string> {
    return this.tokens.getAccessToken();
  }

  /**
   * Vérifie que l'auth configurée est acceptée (bouton « Tester »). Simple
   * listing borné — n'exerce ni création ni permission d'écriture, comme
   * `auth.test` côté Slack.
   */
  async testConnection(): Promise<void> {
    const t = await this.token();
    await call(t, 'GET', 'spaces?pageSize=1');
  }

  /** Crée un espace (non nommé « room » — vocabulaire Chat API v1 : `SPACE`). */
  async createSpace(displayName: string): Promise<ChatSpace> {
    const t = await this.token();
    return call<ChatSpace>(t, 'POST', 'spaces', { displayName, spaceType: 'SPACE' });
  }

  /**
   * Ajoute un membre humain par email. Best-effort par appelant : un email
   * hors du domaine Workspace ou sans compte Chat échoue silencieusement côté
   * appelant (comme `lookupByEmail` côté Slack).
   */
  async addMember(spaceName: string, email: string): Promise<void> {
    const t = await this.token();
    await call(t, 'POST', `${spaceName}/members`, {
      member: { name: `users/${email}`, type: 'HUMAN' },
    });
  }

  /**
   * Supprime un espace (`spaces.delete`). **Destructif et définitif** côté
   * Google — Chat n'a pas d'archivage, seule la suppression existe. Exige un
   * jeton scopé `chat.delete` (le provider doit avoir été construit avec ce
   * scope), sinon Google renvoie un 403.
   */
  async deleteSpace(spaceName: string): Promise<void> {
    const t = await this.token();
    await call(t, 'DELETE', spaceName);
  }
}
