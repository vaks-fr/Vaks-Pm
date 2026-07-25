/* ============================================================
   Client Google Drive API minimal (fetch), côté PROVISIONING (écriture).
   L'acquisition du jeton est déléguée à un `GoogleTokenProvider` (mode
   `sa_key` ou `wif` — voir `google-token-provider`), toujours scopé
   `drive` (écriture) : créer un Drive partagé, y ajouter des membres,
   éventuellement le supprimer.

   ⚠️ À ne pas confondre avec le provider de LECTURE
   `filesources/providers/google-drive.provider.ts`, qui n'utilise que
   `drive.readonly` et ne crée jamais rien. Les deux chemins sont
   volontairement séparés : la lecture reste en lecture seule.
   ============================================================ */
import { randomUUID } from 'crypto';
import { GoogleTokenProvider } from '../google-chat-provisioning/google-token-provider';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const TIMEOUT_MS = 12_000;

/** Scope d'ÉCRITURE Drive — nécessaire pour créer un Drive partagé et gérer ses membres. */
export const DRIVE_WRITE_SCOPE = 'https://www.googleapis.com/auth/drive';

/** Appel Drive API authentifié (bearer). Lève sur HTTP non-2xx. */
async function call<T = Record<string, unknown>>(
  accessToken: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DRIVE_API}/${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    // DELETE renvoie 204 sans corps.
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
    if (!res.ok) throw new Error(`Google Drive ${method} ${path}: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Un Drive partagé (shared drive). */
export interface SharedDrive {
  id: string;
  name: string;
}

/**
 * ⚠️ Le `GoogleTokenProvider` reçu DOIT avoir été construit avec le scope
 * `DRIVE_WRITE_SCOPE` dans son credential (`scopes`) — les implémentations
 * lisent le scope du credential, pas d'un argument d'appel.
 */
export class GoogleDriveClient {
  constructor(private readonly tokens: GoogleTokenProvider) {}

  private async token(): Promise<string> {
    return this.tokens.getAccessToken();
  }

  /**
   * Vérifie que l'auth configurée est acceptée (bouton « Tester »). Listing
   * borné des Drives partagés — n'exerce aucune création.
   */
  async testConnection(): Promise<void> {
    const t = await this.token();
    await call(t, 'GET', 'drives?pageSize=1');
  }

  /**
   * Crée un **Drive partagé**. `requestId` rend l'appel idempotent côté Google
   * (rejouer le même id ne crée pas de doublon). L'utilisateur impersonné doit
   * avoir le droit de créer des Drives partagés (paramètre Workspace).
   */
  async createSharedDrive(name: string, requestId = randomUUID()): Promise<SharedDrive> {
    const t = await this.token();
    return call<SharedDrive>(t, 'POST', `drives?requestId=${encodeURIComponent(requestId)}`, { name });
  }

  /**
   * Ajoute un membre au Drive partagé par email. `role` = `reader` (défaut,
   * moindre privilège) ou `writer`. `supportsAllDrives` est obligatoire sur
   * les Drives partagés.
   */
  async addMember(driveId: string, email: string, role: 'reader' | 'writer' = 'reader'): Promise<void> {
    const t = await this.token();
    await call(
      t,
      'POST',
      `files/${encodeURIComponent(driveId)}/permissions?supportsAllDrives=true&sendNotificationEmail=false`,
      { type: 'user', role, emailAddress: email },
    );
  }

  /**
   * Supprime un Drive partagé. **Destructif et définitif.** `allowItemDeletion`
   * autorise la suppression même s'il contient des fichiers (sinon Google exige
   * un Drive vide).
   */
  async deleteDrive(driveId: string): Promise<void> {
    const t = await this.token();
    await call(
      t,
      'DELETE',
      `drives/${encodeURIComponent(driveId)}?allowItemDeletion=true&useDomainAdminAccess=true`,
    );
  }
}
