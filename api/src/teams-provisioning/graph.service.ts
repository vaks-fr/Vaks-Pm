import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import {
  applyCredentialToForm,
  entraTokenEndpoint,
  type EntraCredential,
} from '../common/entra/client-assertion';

/** Base de l'API Microsoft Graph (v1.0). */
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';

/**
 * Acquisition du **token applicatif** Microsoft Graph (OAuth2 client-credentials).
 * C'est l'API — et non le worker — qui mint le token, car seul l'API peut
 * déchiffrer le client secret (stocké AES-256-GCM en base, saisi via l'admin).
 * Cohérent avec le SSO, où l'échange de jetons OIDC vit déjà côté API.
 *
 * Le token (durée ~1 h) est ensuite transmis au worker dans le contexte de
 * provisioning ; le secret, lui, ne quitte jamais l'API.
 */
@Injectable()
export class GraphService {
  // Cache mémoire par (tenantId|clientId) — petit gain, évite de re-minter à
  // chaque appel de contexte. Expiration avec marge de 60 s.
  private cache = new Map<string, { token: string; expMs: number }>();

  async getAppToken(cred: EntraCredential): Promise<string> {
    const { tenantId, clientId } = cred;
    const hasAuth =
      cred.authMethod === 'client_assertion'
        ? !!(cred.privateKeyPem && cred.thumbprint)
        : !!cred.clientSecret;
    if (!tenantId || !clientId || !hasAuth) {
      // Config incomplète = erreur PERMANENTE (400, pas 500) : le worker la traite
      // comme terminale et ne la retente pas (sinon il boucle 5× sur un tenant
      // mal configuré, avec alerte admin à chaque job).
      throw new BadRequestException(
        'Configuration Graph incomplète (tenantId / clientId / secret ou certificat).',
      );
    }
    const key = `${tenantId}|${clientId}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expMs > now + 60_000) return hit.token;

    const url = entraTokenEndpoint(tenantId);
    const form = new URLSearchParams({
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    try {
      // Construction de l'assertion client (private_key_jwt) : `importPKCS8` et
      // `thumbprintToX5t` jettent une Error NUE si la clé privée PEM est malformée
      // (pas du PKCS#8) ou si l'empreinte n'est pas de l'hex valide. Sans ce catch,
      // l'erreur remonte en 500 — que le worker interprète comme une panne serveur
      // TRANSITOIRE et retente en boucle (symptôme `context HTTP 500` en retry). Or
      // une credential certificat invalide est une erreur de config PERMANENTE →
      // 400, échec terminal côté worker (pas de retry, alerte admin unique), au même
      // titre que la config incomplète ci-dessus.
      await applyCredentialToForm(form, cred);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(
        `Credential Graph invalide (clé privée / empreinte de certificat): ${msg}`,
      );
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: ctrl.signal,
      });
    } catch (err) {
      // Panne réseau / timeout vers Entra = TRANSITOIRE : 503 → le worker retente
      // (backoff BullMQ). On ne remonte pas un Error nu (qui deviendrait un 500
      // indistinct, sans le libellé clair).
      const msg = err instanceof Error ? err.message : String(err);
      throw new ServiceUnavailableException(`Endpoint de jeton Entra injoignable: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
    const txt = await res.text();
    let json: any = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      /* laissé null */
    }
    if (!res.ok || !json?.access_token) {
      const code = typeof json?.error === 'string' ? json.error : '';
      const msg = json?.error_description || json?.error || `HTTP ${res.status}`;
      // Distinguer permanent (secret/appli/params invalides → 400, échec terminal
      // côté worker, pas de retry) de transitoire (Entra indispo, throttling 429,
      // 5xx → 503, retriable).
      const transient =
        res.status === 429 ||
        res.status >= 500 ||
        code === 'temporarily_unavailable' ||
        code === 'server_error';
      if (transient) {
        throw new ServiceUnavailableException(`Échec temporaire du token Graph: ${msg}`);
      }
      throw new BadRequestException(`Échec d'obtention du token Graph: ${msg}`);
    }
    const expiresIn = Number(json.expires_in) || 3600;
    this.cache.set(key, { token: json.access_token, expMs: now + expiresIn * 1000 });
    return json.access_token as string;
  }

  /** Invalide le cache (ex. après rotation du secret). */
  invalidate(tenantId: string, clientId: string): void {
    this.cache.delete(`${tenantId}|${clientId}`);
  }

  /**
   * Appel Graph générique côté API (réutilisable par d'autres modules, ex. le
   * proxy de contexte SharePoint). Port du helper `graph()` du worker : base
   * `v1.0`, timeout 20 s, passthrough des URLs absolues (`@odata.nextLink`).
   *
   * Deux modes : JSON (défaut) et `binary` (téléchargement de `/content`, suit
   * les redirections 302 vers le blob). Ne jette PAS sur statut HTTP non-2xx —
   * renvoie `{ status, headers, ... }` pour que l'appelant mappe 429/403/404 en
   * codes d'erreur métier. Jette seulement sur erreur réseau / timeout.
   */
  async request(
    token: string,
    method: string,
    path: string,
    opts: { body?: unknown; binary?: boolean } = {},
  ): Promise<{ status: number; headers: Headers; json?: any; buffer?: Buffer }> {
    const url = path.startsWith('http') ? path : `${GRAPH_BASE}${path}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(opts.binary ? {} : { 'Content-Type': 'application/json' }),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
        // `/content` renvoie un 302 vers le CDN du blob ; fetch suit par défaut.
        redirect: 'follow',
      });
      if (opts.binary) {
        // Sur binaire attendu mais statut d'erreur, Graph renvoie du JSON.
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          let json: any = null;
          try {
            json = txt ? JSON.parse(txt) : null;
          } catch {
            json = txt ? { raw: txt } : null;
          }
          return { status: res.status, headers: res.headers, json };
        }
        const ab = await res.arrayBuffer();
        return { status: res.status, headers: res.headers, buffer: Buffer.from(ab) };
      }
      let json: any = null;
      const txt = await res.text().catch(() => '');
      if (txt) {
        try {
          json = JSON.parse(txt);
        } catch {
          json = { raw: txt };
        }
      }
      return { status: res.status, headers: res.headers, json };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Test de connexion (bouton admin). Deux niveaux, sans exiger AUCUNE permission
   * au-delà de celles du provisioning (pas d'`Organization.Read.All`) :
   *  1. **Mint** du token client-credentials → valide tenantId / clientId / secret
   *     et que l'app existe/est activée (cause d'échec n°1).
   *  2. Un GET Graph anodin (`/organization`) sert UNIQUEMENT à distinguer un
   *     token **accepté** par Graph d'un token rejeté :
   *       - 200            → token accepté (+ Organization.Read.All présent).
   *       - 401            → token rejeté (mauvaise app / secret).
   *       - 403/autre      → token ACCEPTÉ par Graph mais permission absente sur
   *                          CET appel — sans importance : les permissions Teams
   *                          seront validées au premier provisioning réel.
   * On ne renvoie jamais le secret.
   */
  async testConnection(cred: EntraCredential): Promise<{ ok: boolean; message: string }> {
    let token: string;
    try {
      token = await this.getAppToken(cred);
    } catch (e) {
      return { ok: false, message: `Échec d'obtention du token: ${(e as Error).message}` };
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch('https://graph.microsoft.com/v1.0/organization?$select=id', {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 401) {
        return { ok: false, message: 'Token rejeté par Graph (HTTP 401) — vérifiez l’app et le secret.' };
      }
      if (res.ok) {
        return { ok: true, message: 'Connexion Graph OK (token applicatif accepté).' };
      }
      // 403 / autre : le token est accepté, seule la permission de CET appel manque.
      return {
        ok: true,
        message:
          'Token applicatif accepté par Graph. Les permissions Teams (Team.Create, ' +
          'TeamMember.ReadWrite.All, Channel.Create, TeamSettings.ReadWrite.All) seront ' +
          'validées au premier provisioning.',
      };
    } catch {
      // Réseau/timeout sur le GET : le token a quand même été obtenu.
      return { ok: true, message: 'Token applicatif obtenu (appel de vérification Graph injoignable).' };
    }
  }
}
