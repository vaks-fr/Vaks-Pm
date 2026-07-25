/* ============================================================
   Acquisition d'un access token Google pour la délégation domain-wide,
   selon deux modes d'authentification exclusifs :

   - `sa_key` : clé privée de compte de service téléchargée (JSON). L'app
     signe elle-même l'assertion JWT-bearer (RFC 7523). Simple, mais exige
     de détenir une clé SA — refusé par la contrainte d'organisation
     `iam.disableServiceAccountKeyCreation`, activée par défaut chez les
     organisations orientées sécurité (notre cible).

   - `wif` : Workload Identity Federation, **sans aucune clé SA**. L'app
     présente un JWT OIDC signé de SA PROPRE clé (dont Google ne connaît que
     le JWKS public, collé dans la config du pool) ; Google l'échange contre
     un jeton fédéré, signe l'assertion domain-wide côté serveur via
     `iamcredentials.signJwt`, puis émet l'access token. La clé que nous
     détenons ne donne aucun accès en soi : l'accès est gouverné par la config
     WIF + le grant IAM, révocables par le client. C'est le chemin qu'un
     client Google sérieux acceptera.

   Les deux modes aboutissent au même `access_token` Chat impersonant
   `subjectEmail` — le client Chat (`google-chat-client.ts`) est agnostique.
   ============================================================ */
import { randomUUID } from 'crypto';
import { exportJWK, generateKeyPair, importPKCS8, SignJWT } from 'jose';

/** Endpoints Google (constantes — jamais reconstruites côté appelant). */
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const GOOGLE_STS_ENDPOINT = 'https://sts.googleapis.com/v1/token';
export const GOOGLE_IAMCREDENTIALS = 'https://iamcredentials.googleapis.com/v1';
const TIMEOUT_MS = 10_000;

/** Scopes Chat nécessaires à la création d'espace + gestion des membres. */
export const CHAT_SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.memberships',
];

/**
 * Scope de SUPPRESSION d'espace (`spaces.delete`). Volontairement HORS de
 * `CHAT_SCOPES` : demandé uniquement pour l'opération delete. Ainsi, tant que
 * l'admin ne l'a pas ajouté à la délégation domain-wide, seule la suppression
 * échoue — la création/l'invitation continuent de marcher.
 */
export const CHAT_DELETE_SCOPE = 'https://www.googleapis.com/auth/chat.delete';

/** Un provider d'access token, quel que soit le mode d'auth sous-jacent. */
export interface GoogleTokenProvider {
  /**
   * Renvoie un access token Chat frais (impersonant l'utilisateur configuré).
   * Les scopes sont portés par la credential du provider (défaut `CHAT_SCOPES`) :
   * pour une opération à scope élargi (ex. suppression → `CHAT_DELETE_SCOPE`),
   * construire un provider dédié avec ces scopes.
   */
  getAccessToken(): Promise<string>;
}

// ============================================================
// Normalisation de la clé privée (mode sa_key)
// ============================================================

/**
 * Normalise ce que l'admin colle dans le champ « clé privée » (mode sa_key).
 *
 * Google livre la clé dans un fichier JSON dont le champ `private_key` porte
 * des `\n` **littéraux** ; collé tel quel, le PEM est invalide et `importPKCS8`
 * échoue sur un message incompréhensible pour l'admin. On accepte donc les
 * trois formes qu'on rencontre réellement : le fichier JSON entier, la valeur
 * brute de `private_key`, ou un PEM déjà propre.
 */
export function normalizePrivateKey(input: string): string {
  let s = (input ?? '').trim();
  if (s.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(s);
    } catch {
      throw new Error('Clé privée : JSON du compte de service illisible.');
    }
    const pk = (parsed as { private_key?: unknown }).private_key;
    if (typeof pk !== 'string' || !pk.trim()) {
      throw new Error('Clé privée : le JSON du compte de service ne contient pas de champ « private_key ».');
    }
    s = pk.trim();
  }
  // `\n` littéraux (copie depuis le JSON) → vrais retours à la ligne ; CRLF → LF.
  s = s
    .replace(/\\r\\n|\\n/g, '\n')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!s.startsWith('-----BEGIN PRIVATE KEY-----') || !s.endsWith('-----END PRIVATE KEY-----')) {
    throw new Error('Clé privée : format PKCS#8 attendu (bloc « -----BEGIN PRIVATE KEY----- »).');
  }
  return s;
}

// ============================================================
// Mode sa_key : clé SA téléchargée, on signe l'assertion nous-mêmes
// ============================================================

export interface ServiceAccountCredential {
  /** Email du compte de service (`…@…iam.gserviceaccount.com`). */
  clientEmail: string;
  /** Clé privée PKCS#8 (PEM) du compte de service. */
  privateKeyPem: string;
  /** Utilisateur Workspace impersonné (délégation domain-wide). */
  subjectEmail: string;
  /** Scopes OAuth demandés. Défaut = `CHAT_SCOPES` (rétro-compat Google Chat). */
  scopes?: string[];
}

/** Timeout partagé pour les fetch Google (un provisioning/test est un événement rare). */
async function fetchJson(
  url: string,
  init: RequestInit,
  errPrefix: string,
): Promise<Record<string, unknown>> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error(`${errPrefix} : ${describeGoogleError(json) ?? `HTTP ${res.status}`}`);
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Extrait un message d'erreur lisible d'une réponse d'erreur Google (formes variées selon l'API). */
export function describeGoogleError(json: Record<string, unknown>): string | undefined {
  const errObj = json.error;
  if (typeof errObj === 'object' && errObj !== null) {
    const m = (errObj as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  // Endpoint OAuth2/STS : `{ error, error_description }` (chaînes plates).
  const desc = json.error_description;
  if (typeof desc === 'string' && desc) return desc;
  if (typeof errObj === 'string' && errObj) return errObj;
  return undefined;
}

export class SaKeyTokenProvider implements GoogleTokenProvider {
  private readonly cred: ServiceAccountCredential;

  constructor(cred: ServiceAccountCredential) {
    // Normalisation à la construction : une clé mal collée échoue ici, avec un
    // message lisible, au lieu de ressortir en erreur `jose` au premier appel.
    this.cred = { ...cred, privateKeyPem: normalizePrivateKey(cred.privateKeyPem) };
  }

  async getAccessToken(): Promise<string> {
    const key = await importPKCS8(this.cred.privateKeyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const assertion = await new SignJWT({ scope: (this.cred.scopes ?? CHAT_SCOPES).join(' ') })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.cred.clientEmail)
      .setSubject(this.cred.subjectEmail)
      .setAudience(GOOGLE_TOKEN_ENDPOINT)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 3300)
      .sign(key);
    const json = await fetchJson(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildJwtBearerForm(assertion).toString(),
      },
      'Google OAuth2',
    );
    const token = json.access_token;
    if (typeof token !== 'string' || !token) throw new Error('Google OAuth2 : access_token absent.');
    return token;
  }
}

// ============================================================
// Mode wif : Workload Identity Federation (aucune clé SA)
// ============================================================

export interface WifCredential {
  /** Compte de service impersonné (identité de service Google). */
  serviceAccountEmail: string;
  /** Utilisateur Workspace impersonné (délégation domain-wide). */
  subjectEmail: string;
  /**
   * Audience WIF = nom de ressource complet du provider :
   * `//iam.googleapis.com/projects/<num>/locations/global/workloadIdentityPools/<pool>/providers/<prov>`.
   */
  wifAudience: string;
  /** Issuer OIDC déclaré côté provider WIF (doit matcher `iss` de notre JWT). */
  issuer: string;
  /** Notre clé privée RS256 (PKCS#8 PEM) — Google n'en connaît que le JWKS public. */
  signingKeyPem: string;
  /** `kid` de notre clé (présent dans le JWKS collé côté WIF). */
  keyId: string;
  /**
   * `sub` du JWT OIDC → `google.subject` par mapping d'attribut. Stable.
   * Défaut = l'email du compte de service (identifiant lisible et unique).
   */
  subject?: string;
  /** Scopes OAuth de l'assertion domain-wide. Défaut = `CHAT_SCOPES`. */
  scopes?: string[];
}

/** Corps `token-exchange` (RFC 8693) posté à STS pour obtenir un jeton fédéré. */
export function buildStsForm(subjectToken: string, wifAudience: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    audience: wifAudience,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    subject_token: subjectToken,
  });
}

/**
 * Charge utile de l'assertion domain-wide, signée côté Google par `signJwt`
 * (jamais par nous). `iss`/`sub` = compte de service / utilisateur impersonné.
 */
export function buildSignJwtPayload(
  serviceAccountEmail: string,
  subjectEmail: string,
  now: number,
  scopes: string[] = CHAT_SCOPES,
): Record<string, unknown> {
  return {
    iss: serviceAccountEmail,
    sub: subjectEmail,
    aud: GOOGLE_TOKEN_ENDPOINT,
    scope: scopes.join(' '),
    iat: now,
    exp: now + 3300,
  };
}

/** Corps `jwt-bearer` (RFC 7523) : échange l'assertion signée contre l'access token. */
export function buildJwtBearerForm(assertion: string): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });
}

/** URL `signJwt` de l'API IAM Credentials pour un compte de service donné. */
export function signJwtUrl(serviceAccountEmail: string): string {
  return `${GOOGLE_IAMCREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(serviceAccountEmail)}:signJwt`;
}

export class WifTokenProvider implements GoogleTokenProvider {
  constructor(private readonly cred: WifCredential) {}

  /** Étape 1 : JWT OIDC self-issued, présenté à STS. Signé de NOTRE clé. */
  private async mintSubjectToken(): Promise<string> {
    const key = await importPKCS8(this.cred.signingKeyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: this.cred.keyId })
      .setIssuer(this.cred.issuer)
      .setSubject(this.cred.subject ?? this.cred.serviceAccountEmail)
      .setAudience(this.cred.wifAudience)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(key);
  }

  async getAccessToken(): Promise<string> {
    // 1. self-OIDC → STS → jeton fédéré.
    const subjectToken = await this.mintSubjectToken();
    const sts = await fetchJson(
      GOOGLE_STS_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildStsForm(subjectToken, this.cred.wifAudience).toString(),
      },
      'Google STS (Workload Identity)',
    );
    const federated = sts.access_token;
    if (typeof federated !== 'string' || !federated) {
      throw new Error('Google STS : access_token fédéré absent (vérifier audience/mapping du pool).');
    }

    // 2. signJwt côté Google : l'assertion domain-wide, signée par le SA sans clé locale.
    const now = Math.floor(Date.now() / 1000);
    const signed = await fetchJson(
      signJwtUrl(this.cred.serviceAccountEmail),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${federated}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          payload: JSON.stringify(
            buildSignJwtPayload(this.cred.serviceAccountEmail, this.cred.subjectEmail, now, this.cred.scopes ?? CHAT_SCOPES),
          ),
        }),
      },
      'Google signJwt (IAM Credentials)',
    );
    const assertion = signed.signedJwt;
    if (typeof assertion !== 'string' || !assertion) {
      throw new Error('Google signJwt : signedJwt absent (vérifier le grant serviceAccountTokenCreator).');
    }

    // 3. jwt-bearer → access token Chat (impersonation domain-wide).
    const tok = await fetchJson(
      GOOGLE_TOKEN_ENDPOINT,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: buildJwtBearerForm(assertion).toString(),
      },
      'Google OAuth2 (jwt-bearer)',
    );
    const token = tok.access_token;
    if (typeof token !== 'string' || !token) {
      throw new Error('Google OAuth2 : access_token absent (délégation domain-wide non accordée ?).');
    }
    return token;
  }
}

// ============================================================
// Génération de la paire de clés WIF (utilisée par l'admin)
// ============================================================

/**
 * Génère une paire RS256 pour le mode WIF. Renvoie la clé privée PKCS#8 (à
 * chiffrer at-rest) et le JWKS public (une seule clé) que l'admin collera dans
 * la config du provider WIF côté Google. Le `kid` lie les deux.
 */
export async function generateWifKeypair(): Promise<{
  privateKeyPem: string;
  keyId: string;
  jwks: { keys: Record<string, unknown>[] };
}> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
  const keyId = randomUUID();
  const pub: Record<string, unknown> = { ...(await exportJWK(publicKey)), kid: keyId, alg: 'RS256', use: 'sig' };
  const { exportPKCS8 } = await import('jose');
  const privateKeyPem = await exportPKCS8(privateKey);
  return { privateKeyPem, keyId, jwks: { keys: [pub] } };
}
