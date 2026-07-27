import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { importPKCS8, SignJWT } from 'jose';
import {
  GOOGLE_TOKEN_ENDPOINT,
  WifTokenProvider,
  buildJwtBearerForm,
  describeGoogleError,
  normalizePrivateKey,
} from '../../google-chat-provisioning/google-token-provider';
import {
  ConnectorTestResult,
  FileEntry,
  FileListResult,
  FileSourceContext,
  FileSourceError,
  FileSourceProvider,
  ProviderDescriptor,
} from '../file-source-provider.types';

/** Base de l'API Drive v3 (constante — jamais reconstruite côté appelant). */
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
/** Scope minimal : lecture seule. Le connecteur ne modifie JAMAIS le drive. */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
/** mimeType d'un dossier Google Drive. */
const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Champs demandés à l'API pour un item de drive (list + get). */
const FILE_FIELDS = 'id,name,mimeType,size,modifiedTime,webViewLink';
const TIMEOUT_MS = 12_000;

/**
 * Types Google-natifs (Docs/Sheets/Slides) → mimeType d'export texte. Ces fichiers
 * n'ont pas de blob téléchargeable (`alt=media` renvoie 403) : il faut passer par
 * `/export`. On exporte directement en texte exploitable par les agents.
 */
const GOOGLE_NATIVE_EXPORT: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/** Credential de compte de service résolu depuis le secret du connecteur. */
interface DriveCredential {
  clientEmail: string;
  privateKeyPem: string;
  /** Utilisateur Workspace impersonné (délégation domain-wide), optionnel. */
  subject?: string;
}

/** Entrée de cache d'access token (par org). */
interface CachedToken {
  token: string;
  /** Expiration epoch (secondes). */
  exp: number;
}

/**
 * Provider Google Drive — deuxième source de fichiers du seam (après SharePoint).
 * `managedElsewhere` : il ne détient PAS de connecteur propre. La config/secret
 * de lecture est dérivée du **provisioning Google Drive** (`gdrive.provisioning.*`,
 * via `AdminSettingsService.getGoogleDriveReadContext`) et injectée dans le
 * `FileSourceContext` par `FileSourcesService.buildResolution` — l'identité qui
 * a créé le Drive partagé du projet le lit (le scope `drive` inclut `drive.readonly`).
 * Une seule config à maintenir, comme SharePoint réutilise l'identité Teams.
 * Proxy live, aucune copie. La racine lue est le Drive partagé du projet
 * (`ctx.project.gdriveId`).
 *
 * Deux modes d'authentification (`authMode`, hérités du provisioning) :
 *  - **`sa_key`** (défaut) : clé de compte de service téléchargée (JSON). Simple,
 *    mais exige de détenir une clé SA — refusé par la contrainte d'org
 *    `iam.disableServiceAccountKeyCreation` (fréquente en sécurité renforcée).
 *  - **`wif`** : Workload Identity Federation, **sans aucune clé SA**. On génère
 *    une paire RS256 côté serveur (bouton admin) ; Google n'en connaît que le
 *    JWKS public (collé dans la config du pool WIF) ; l'accès est gouverné par le
 *    pool + le grant IAM, révocables par le client. Impersonation domain-wide
 *    obligatoire (`impersonateSubject`). Même moteur que Google Chat.
 *
 * Deux façons de donner accès (mode `sa_key`) :
 *  - **Partage direct** : partager le dossier / Shared Drive avec l'email du
 *    compte de service en lecteur (pas de délégation, `impersonateSubject` vide).
 *  - **Délégation domain-wide** : renseigner l'utilisateur Workspace à impersoner.
 *
 * Config : `authMode`, `rootFolderId`, `impersonateSubject?` (requis en `wif`),
 * `serviceAccountEmail` (`wif`), `wifAudience` (`wif`), + métadonnées de clé
 * générées (`wifKeyId`/`wifIssuer`/`wifJwksPublic`).
 * Secret : `serviceAccountKey` (`sa_key`) ou `wifSigningKey` (`wif`, généré).
 */
@Injectable()
export class GoogleDriveProvider implements FileSourceProvider {
  readonly source = 'google-drive';
  readonly label = 'Google Drive';
  private readonly log = new Logger(GoogleDriveProvider.name);
  /** Cache d'access token en mémoire, par org (jetons courts, jamais persistés). */
  private readonly tokenCache = new Map<string, CachedToken>();

  describe(): ProviderDescriptor {
    return {
      source: this.source,
      label: this.label,
      blurb:
        "Lecture des documents du Drive partagé provisionné pour le projet. Réutilise l'identité du provisioning Google Drive — configurée dans « Google Drive — provisioning ». Proxy live, aucune copie.",
      accent: '#1a73e8',
      short: 'gd',
      // `managedElsewhere` : pas de connecteur chiffré propre. La config/secret de
      // lecture est dérivée de `gdrive.provisioning.*` (le scope d'écriture `drive`
      // inclut la lecture `drive.readonly`) — une seule config à maintenir, comme
      // SharePoint qui réutilise l'identité Graph du provisioning Teams.
      managedElsewhere: true,
      fields: [],
    };
  }

  // ------------------------------------------------------------
  // Auth (compte de service → access token, mis en cache)
  // ------------------------------------------------------------

  /** Résout le credential depuis le contexte (secret + config). Jette si incomplet. */
  private credential(ctx: FileSourceContext): DriveCredential {
    const raw = ctx.secret?.serviceAccountKey;
    if (!raw || !raw.trim()) {
      throw new FileSourceError('FS_AUTH_FAILED', 'Clé du compte de service Google non configurée.');
    }
    let parsed: { client_email?: unknown; private_key?: unknown };
    try {
      parsed = JSON.parse(raw) as typeof parsed;
    } catch {
      throw new FileSourceError('FS_AUTH_FAILED', 'Clé du compte de service : JSON illisible.');
    }
    const clientEmail = typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
    if (!clientEmail || typeof parsed.private_key !== 'string') {
      throw new FileSourceError('FS_AUTH_FAILED', "Clé du compte de service : `client_email`/`private_key` manquant.");
    }
    let privateKeyPem: string;
    try {
      privateKeyPem = normalizePrivateKey(String(parsed.private_key));
    } catch (e) {
      throw new FileSourceError('FS_AUTH_FAILED', `Clé du compte de service : ${(e as Error).message}`);
    }
    const subject = typeof ctx.config?.impersonateSubject === 'string' ? ctx.config.impersonateSubject.trim() : '';
    return { clientEmail, privateKeyPem, subject: subject || undefined };
  }

  /** Mode d'auth du connecteur (`sa_key` par défaut). */
  private authMode(ctx: FileSourceContext): 'sa_key' | 'wif' {
    return ctx.config?.authMode === 'wif' ? 'wif' : 'sa_key';
  }

  private cfgStr(ctx: FileSourceContext, key: string): string {
    const v = ctx.config?.[key];
    return typeof v === 'string' ? v.trim() : '';
  }

  /** Access token Drive (readonly), depuis le cache si frais, sinon (re)minté. */
  private async accessToken(ctx: FileSourceContext): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const cached = this.tokenCache.get(ctx.orgId);
    // Marge de 60 s pour ne pas servir un token au bord de l'expiration.
    if (cached && cached.exp - 60 > now) return cached.token;

    let token: string;
    try {
      token =
        this.authMode(ctx) === 'wif'
          ? await this.mintWifToken(ctx)
          : await this.mintSaKeyToken(ctx, now);
    } catch (e) {
      if (e instanceof FileSourceError) throw e;
      throw new FileSourceError('FS_AUTH_FAILED', `Token Google indisponible : ${(e as Error).message}`);
    }
    if (!token) throw new FileSourceError('FS_AUTH_FAILED', 'Google OAuth2 : access_token absent.');
    this.tokenCache.set(ctx.orgId, { token, exp: now + 3300 });
    return token;
  }

  /** Mode sa_key : on signe l'assertion nous-mêmes avec la clé du compte de service. */
  private async mintSaKeyToken(ctx: FileSourceContext, now: number): Promise<string> {
    const cred = this.credential(ctx);
    const key = await importPKCS8(cred.privateKeyPem, 'RS256');
    let signer = new SignJWT({ scope: DRIVE_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(cred.clientEmail)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 3300);
    if (cred.subject) signer = signer.setSubject(cred.subject);
    const assertion = await signer.sign(key);

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildJwtBearerForm(assertion).toString(),
        signal: ac.signal,
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        throw new FileSourceError(
          'FS_AUTH_FAILED',
          `Authentification Google refusée : ${describeGoogleError(json) ?? `HTTP ${res.status}`}`,
        );
      }
      return typeof json.access_token === 'string' ? json.access_token : '';
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Mode wif : Workload Identity Federation (aucune clé SA détenue). Impersonation
   * domain-wide obligatoire. La clé de signature (générée par le bouton admin) vit
   * dans le secret `wifSigningKey` ; l'audience/issuer/kid dans la config.
   */
  private async mintWifToken(ctx: FileSourceContext): Promise<string> {
    const serviceAccountEmail = this.cfgStr(ctx, 'serviceAccountEmail');
    const subjectEmail = this.cfgStr(ctx, 'impersonateSubject');
    const wifAudience = this.cfgStr(ctx, 'wifAudience');
    const issuer = this.cfgStr(ctx, 'wifIssuer');
    const keyId = this.cfgStr(ctx, 'wifKeyId');
    const signingKeyPem = ctx.secret?.wifSigningKey;
    if (!serviceAccountEmail || !subjectEmail) {
      throw new FileSourceError(
        'FS_AUTH_FAILED',
        'Mode WIF : compte de service et utilisateur impersonné requis.',
      );
    }
    if (!wifAudience || !issuer || !keyId || !signingKeyPem) {
      throw new FileSourceError(
        'FS_AUTH_FAILED',
        "Mode WIF : clé de signature non générée ou audience du pool manquante (générer la clé, puis renseigner l'audience).",
      );
    }
    const provider = new WifTokenProvider({
      serviceAccountEmail,
      subjectEmail,
      wifAudience,
      issuer,
      keyId,
      signingKeyPem,
      scopes: [DRIVE_SCOPE],
    });
    return provider.getAccessToken();
  }

  // ------------------------------------------------------------
  // Lecture (test / list / fetch)
  // ------------------------------------------------------------

  async testConnection(ctx: FileSourceContext): Promise<ConnectorTestResult> {
    const rootFolderId = this.rootFolderId(ctx);
    if (!rootFolderId) return { ok: false, error: 'ID du dossier racine non configuré.' };
    try {
      const token = await this.accessToken(ctx);
      // Valide credential + accès en lisant les métadonnées du dossier racine.
      const res = await this.driveGet(
        token,
        `/files/${encodeURIComponent(rootFolderId)}?fields=id,name,mimeType&supportsAllDrives=true`,
      );
      if (res.status === 404) return { ok: false, error: 'Dossier racine introuvable (ID ou partage à vérifier).' };
      if (res.status === 403) return { ok: false, error: 'Accès refusé (partagez le dossier avec le compte de service).' };
      if (!this.ok(res.status)) return { ok: false, error: `Réponse Google inattendue (HTTP ${res.status}).` };
      const name = typeof res.json?.name === 'string' ? res.json.name : rootFolderId;
      return { ok: true, detail: `Accès OK — dossier « ${name} ».` };
    } catch (e) {
      return { ok: false, error: e instanceof FileSourceError ? e.message : (e as Error).message };
    }
  }

  async list(ctx: FileSourceContext, opts: { folderId?: string; cursor?: string }): Promise<FileListResult> {
    const parent = opts.folderId || this.rootFolderId(ctx);
    if (!parent) throw new FileSourceError('FS_SOURCE_UNAVAILABLE', 'Dossier racine Google Drive non configuré.');
    const token = await this.accessToken(ctx);
    const params = new URLSearchParams({
      q: `'${parent.replace(/'/g, "\\'")}' in parents and trashed = false`,
      fields: `nextPageToken,files(${FILE_FIELDS})`,
      pageSize: '50',
      orderBy: 'folder,name',
      supportsAllDrives: 'true',
      includeItemsFromAllDrives: 'true',
    });
    if (opts.cursor) params.set('pageToken', opts.cursor);
    const res = await this.driveGet(token, `/files?${params.toString()}`);
    this.assertOk(res.status, res.headers, res.json);
    const items: FileEntry[] = (res.json?.files ?? []).map((it: any) => this.toEntry(it));
    const next = typeof res.json?.nextPageToken === 'string' ? res.json.nextPageToken : null;
    return { items, nextCursor: next };
  }

  async fetch(ctx: FileSourceContext, itemId: string): Promise<{ meta: FileEntry; buffer: Buffer }> {
    const token = await this.accessToken(ctx);
    const metaRes = await this.driveGet(
      token,
      `/files/${encodeURIComponent(itemId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`,
    );
    this.assertOk(metaRes.status, metaRes.headers, metaRes.json);
    const meta = this.toEntry(metaRes.json);
    if (meta.isFolder) {
      throw new FileSourceError('FS_UNSUPPORTED_FORMAT', "L'item est un dossier, pas un fichier.");
    }

    const nativeMime = String(metaRes.json?.mimeType ?? '');
    const exportMime = GOOGLE_NATIVE_EXPORT[nativeMime];
    let path: string;
    if (nativeMime.startsWith('application/vnd.google-apps.')) {
      // Fichier Google-natif : export texte (les autres — Forms, Drawings… — non lisibles).
      if (!exportMime) {
        throw new FileSourceError('FS_UNSUPPORTED_FORMAT', 'Type de document Google non exportable en texte.', {
          mimeType: nativeMime,
        });
      }
      path = `/files/${encodeURIComponent(itemId)}/export?mimeType=${encodeURIComponent(exportMime)}`;
      // L'extraction en aval s'appuie sur le mimeType : on annonce le format exporté.
      meta.mimeType = exportMime;
    } else {
      path = `/files/${encodeURIComponent(itemId)}?alt=media&supportsAllDrives=true`;
    }

    const contentRes = await this.driveGetBinary(token, path);
    this.assertOk(contentRes.status, contentRes.headers, undefined);
    if (!contentRes.buffer) {
      throw new FileSourceError('FS_ITEM_NOT_FOUND', 'Contenu du fichier indisponible.');
    }
    return { meta, buffer: contentRes.buffer };
  }

  // ------------------------------------------------------------
  // Helpers HTTP
  // ------------------------------------------------------------

  /**
   * Racine de lecture pour ce projet. Le **Drive partagé provisionné** pour le
   * projet prime (un drive par projet, comme le site SharePoint d'une équipe
   * Teams) ; à défaut, on retombe sur la racine org configurée sur le connecteur.
   */
  private rootFolderId(ctx: FileSourceContext): string {
    const perProject = ctx.project?.gdriveId;
    if (typeof perProject === 'string' && perProject.trim()) return perProject.trim();
    const v = ctx.config?.rootFolderId;
    return typeof v === 'string' ? v.trim() : '';
  }

  private async driveGet(
    token: string,
    path: string,
  ): Promise<{ status: number; headers: Headers; json: any }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${DRIVE_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      const json = await res.json().catch(() => ({}));
      return { status: res.status, headers: res.headers, json };
    } finally {
      clearTimeout(timer);
    }
  }

  private async driveGetBinary(
    token: string,
    path: string,
  ): Promise<{ status: number; headers: Headers; buffer: Buffer | null }> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${DRIVE_API}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: ac.signal,
      });
      if (!this.ok(res.status)) return { status: res.status, headers: res.headers, buffer: null };
      const buffer = Buffer.from(await res.arrayBuffer());
      return { status: res.status, headers: res.headers, buffer };
    } finally {
      clearTimeout(timer);
    }
  }

  private ok(status: number): boolean {
    return status >= 200 && status < 300;
  }

  /** Mappe un statut Drive d'erreur en `FileSourceError`. No-op si 2xx. */
  private assertOk(status: number, headers: Headers | undefined, json: any): void {
    if (this.ok(status)) return;
    if (status === 429) {
      const ra = headers?.get('retry-after');
      throw new FileSourceError('FS_THROTTLED', 'Google Drive a limité le débit.', {
        retryAfter: ra ? Number(ra) : undefined,
      });
    }
    if (status === 401) throw new FileSourceError('FS_AUTH_FAILED', 'Authentification Google refusée.');
    if (status === 403) {
      throw new FileSourceError(
        'FS_GRANT_PENDING',
        "Accès Google Drive refusé (dossier non partagé avec le compte de service ou délégation manquante).",
      );
    }
    if (status === 404) throw new FileSourceError('FS_ITEM_NOT_FOUND', 'Item introuvable.');
    const detail = json ? describeGoogleError(json) : undefined;
    throw new FileSourceError('FS_SOURCE_UNAVAILABLE', `Réponse Google inattendue (HTTP ${status})${detail ? ` : ${detail}` : ''}.`);
  }

  private toEntry(it: any): FileEntry {
    const mimeType = it?.mimeType ? String(it.mimeType) : undefined;
    const sizeNum = it?.size != null ? Number(it.size) : NaN;
    return {
      id: String(it?.id ?? ''),
      name: String(it?.name ?? ''),
      isFolder: mimeType === FOLDER_MIME,
      size: Number.isFinite(sizeNum) ? sizeNum : undefined,
      mimeType,
      lastModified: it?.modifiedTime ? String(it.modifiedTime) : undefined,
      webUrl: it?.webViewLink ? String(it.webViewLink) : undefined,
    };
  }
}
