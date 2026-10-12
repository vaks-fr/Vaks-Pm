import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import { assertSafeExternalUrl, safeFetch } from '../../common/url-guard';

/**
 * Vérification des JWT de plateforme pour la **fédération d'identité des
 * agents** (RFC 8693). Ce service est volontairement PUR (aucun accès DB,
 * aucun Redis) : il prend une config d'émetteur + un jeton, et renvoie des
 * claims validés ou jette. L'anti-rejeu (`jti`), la résolution de l'agent et
 * l'émission du PAT vivent dans `AgentFederationService` — ce qui rend toute
 * cette logique de sécurité testable en vitest sans infrastructure.
 */

/** Codes d'échec — mappés en erreurs OAuth par le grant. */
export type FederationFailure =
  | 'token_malformed'
  | 'alg_not_allowed'
  | 'jwks_unavailable'
  | 'signature_invalid'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'claim_constraint_failed'
  | 'subject_missing'
  | 'jti_required';

export class FederationVerifyError extends Error {
  constructor(
    readonly code: FederationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'FederationVerifyError';
  }
}

/** Sous-ensemble d'`AgentTrustIssuer` dont dépend la vérification. */
export interface TrustIssuerConfig {
  id: string;
  issuer: string;
  audience: string;
  jwksUri: string | null;
  jwksJson: unknown | null;
  algorithms: string[];
  subjectClaim: string;
  claimConstraints: unknown;
  requireJti: boolean;
}

export interface VerifiedFederatedToken {
  /** Valeur du claim configuré (`subjectClaim`) — clé de résolution de l'agent. */
  subject: string;
  jti: string | null;
  /** `exp` en secondes epoch — borne la fenêtre d'anti-rejeu. */
  expSec: number;
  claims: JWTPayload;
}

interface CachedKeySet {
  resolve: ReturnType<typeof createLocalJWKSet>;
  fingerprint: string;
  fetchedAt: number;
  lastAttemptAt: number;
}

/** Un JWT de plateforme dépasse rarement 4 Ko ; au-delà c'est du bruit. */
const MAX_TOKEN_BYTES = 16 * 1024;
/** Tolérance d'horloge entre l'émetteur et nous. */
const CLOCK_TOLERANCE_SEC = 60;
/** Âge max d'un subject_token fédéré (depuis `iat`). */
const MAX_TOKEN_AGE = '24h';
/** Durée de vie d'un JWKS distant en cache. */
const JWKS_TTL_MS = 60 * 60 * 1000;
/** Anti-martèlement : délai minimal entre deux récupérations d'un même JWKS. */
const JWKS_COOLDOWN_MS = 30 * 1000;
const JWKS_FETCH_TIMEOUT_MS = 10_000;
/** Un JWKS légitime tient largement dedans ; borne anti-gavage. */
const MAX_JWKS_BYTES = 512 * 1024;

@Injectable()
export class AgentFederationVerifier {
  private readonly logger = new Logger(AgentFederationVerifier.name);
  private readonly cache = new Map<string, CachedKeySet>();

  /**
   * Les émetteurs internes (OIDC d'un cluster K8s, Keycloak sur une IP privée)
   * sont le cas NOMINAL en on-premise — mais autoriser un admin tenant à faire
   * appeler une IP interne par le serveur est une primitive de scan en SaaS
   * mutualisé. Le risque dépend donc du **mode de déploiement**, pas du tenant :
   * c'est un réglage opérateur (variable d'env), jamais un champ d'admin.
   * Laisser à `false` en pooled ; les installs on-prem l'activent.
   *
   * Alternative sans réseau ni arbitrage : coller le JWKS (`jwksJson`).
   */
  private readonly allowInternalJwks =
    process.env.AGENT_FEDERATION_ALLOW_INTERNAL_JWKS === 'true';

  async verify(issuer: TrustIssuerConfig, rawToken: string): Promise<VerifiedFederatedToken> {
    if (!rawToken || Buffer.byteLength(rawToken, 'utf8') > MAX_TOKEN_BYTES) {
      throw new FederationVerifyError('token_malformed', 'subject_token absent ou trop volumineux.');
    }

    // ── Porte 1 : algorithme, AVANT toute récupération de clé ────────────────
    // Faite en premier pour qu'un jeton hostile ne déclenche même pas d'appel
    // réseau, et pour fermer `alg:none` / `alg:HS*` : avec HMAC, la clé publique
    // du JWKS — donnée publique — deviendrait le secret de signature.
    let alg: string | undefined;
    try {
      alg = decodeProtectedHeader(rawToken).alg;
    } catch {
      throw new FederationVerifyError('token_malformed', 'En-tête JWT illisible.');
    }
    const allowed = this.sanitizeAlgorithms(issuer.algorithms);
    if (!alg || !allowed.includes(alg)) {
      throw new FederationVerifyError(
        'alg_not_allowed',
        `Algorithme de signature refusé (${alg ?? 'absent'}).`,
      );
    }

    // ── Porte 2 : signature ─────────────────────────────────────────────────
    const resolve = await this.keySet(issuer);
    let payload: JWTPayload;
    try {
      // `issuer` et `audience` sont vérifiés par jose en même temps que la
      // signature (portes 3 et 4). L'audience n'est JAMAIS optionnelle : sans
      // elle, un jeton obtenu légitimement par l'agent pour une autre
      // application du même émetteur vaudrait credential ici.
      const res = await jwtVerify(rawToken, resolve, {
        issuer: issuer.issuer,
        audience: issuer.audience,
        algorithms: allowed,
        clockTolerance: CLOCK_TOLERANCE_SEC,
        // jose ne valide `exp` QUE s'il est présent : sans `requiredClaims`, un
        // JWT perpétuel signé par l'émetteur vaudrait credential à vie.
        // `maxTokenAge` (exige `iat`) borne en plus l'âge : 24 h couvre les
        // jetons de plateforme les plus longs (identités managées Azure).
        requiredClaims: ['exp', 'iat'],
        maxTokenAge: MAX_TOKEN_AGE,
      });
      payload = res.payload;
    } catch (e) {
      throw this.mapVerifyError(e);
    }

    // ── Porte 6 : contraintes de claims ─────────────────────────────────────
    this.assertClaimConstraints(issuer, payload);

    // ── Sujet ───────────────────────────────────────────────────────────────
    const subject = payload[issuer.subjectClaim];
    if (typeof subject !== 'string' || !subject.trim()) {
      throw new FederationVerifyError(
        'subject_missing',
        `Claim « ${issuer.subjectClaim} » absent ou non textuel.`,
      );
    }

    // ── `jti` (l'anti-rejeu lui-même est fait par l'appelant) ────────────────
    const jti = typeof payload.jti === 'string' && payload.jti ? payload.jti : null;
    if (issuer.requireJti && !jti) {
      throw new FederationVerifyError(
        'jti_required',
        'Le jeton doit porter un `jti` (protection anti-rejeu).',
      );
    }

    return {
      subject: subject.trim(),
      jti,
      // `exp` est garanti présent : exigé via `requiredClaims` ci-dessus.
      expSec: payload.exp as number,
      claims: payload,
    };
  }

  /** Allowlist stricte : jamais `none`, jamais HS* — quoi qu'ait pu être configuré. */
  private sanitizeAlgorithms(configured: string[]): string[] {
    const out = (configured ?? [])
      .map((a) => String(a).trim())
      .filter((a) => a && a.toLowerCase() !== 'none' && !a.toUpperCase().startsWith('HS'));
    return out.length ? out : ['RS256', 'ES256'];
  }

  private assertClaimConstraints(issuer: TrustIssuerConfig, payload: JWTPayload): void {
    const raw = issuer.claimConstraints;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    for (const [claim, expected] of Object.entries(raw as Record<string, unknown>)) {
      const actual = payload[claim];
      // Égalité stricte sur la forme textuelle. Un claim tableau (ex. `groups`)
      // est satisfait s'il CONTIENT la valeur attendue.
      const ok = Array.isArray(actual)
        ? actual.some((v) => String(v) === String(expected))
        : String(actual) === String(expected);
      if (!ok) {
        throw new FederationVerifyError(
          'claim_constraint_failed',
          `Contrainte non satisfaite sur le claim « ${claim} ».`,
        );
      }
    }
  }

  private mapVerifyError(e: unknown): FederationVerifyError {
    const code = (e as { code?: string })?.code ?? '';
    const claim = (e as { claim?: string })?.claim ?? '';
    if (code === 'ERR_JWT_EXPIRED') {
      return new FederationVerifyError('token_expired', 'Jeton expiré.');
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      if (claim === 'iss') {
        return new FederationVerifyError('issuer_mismatch', 'Émetteur non concordant.');
      }
      if (claim === 'aud') {
        return new FederationVerifyError('audience_mismatch', 'Audience non concordante.');
      }
      if (claim === 'nbf') {
        return new FederationVerifyError('token_not_yet_valid', 'Jeton pas encore valide.');
      }
      if (claim === 'exp' || claim === 'iat') {
        return new FederationVerifyError(
          'token_malformed',
          'Le jeton doit porter les claims `exp` et `iat` (jeton sans expiration refusé).',
        );
      }
    }
    return new FederationVerifyError('signature_invalid', 'Signature ou format du jeton invalide.');
  }

  // ── JWKS ──────────────────────────────────────────────────────────────────

  private fingerprint(issuer: TrustIssuerConfig): string {
    const material = issuer.jwksJson
      ? `static:${JSON.stringify(issuer.jwksJson)}`
      : `remote:${issuer.jwksUri ?? ''}`;
    return createHash('sha256').update(material).digest('hex');
  }

  private async keySet(issuer: TrustIssuerConfig) {
    const fp = this.fingerprint(issuer);

    // JWKS collé : aucune récupération, aucune expiration, aucune surface SSRF.
    // C'est le chemin recommandé pour un émetteur interne ou un site air-gap.
    if (issuer.jwksJson) {
      const hit = this.cache.get(issuer.id);
      if (hit && hit.fingerprint === fp) return hit.resolve;
      const resolve = createLocalJWKSet(issuer.jwksJson as JSONWebKeySet);
      this.cache.set(issuer.id, { resolve, fingerprint: fp, fetchedAt: Date.now(), lastAttemptAt: 0 });
      return resolve;
    }

    if (!issuer.jwksUri) {
      throw new FederationVerifyError(
        'jwks_unavailable',
        "Émetteur sans JWKS : renseignez une URL JWKS ou collez le jeu de clés.",
      );
    }

    const hit = this.cache.get(issuer.id);
    const fresh = hit && hit.fingerprint === fp && Date.now() - hit.fetchedAt < JWKS_TTL_MS;
    if (fresh) return hit!.resolve;

    // Cooldown : si une tentative vient d'échouer, on ne martèle pas l'émetteur.
    // On resert le jeu de clés périmé plutôt que de tout refuser — une rotation
    // de clés est rare, une indisponibilité passagère ne doit pas couper la
    // flotte d'agents.
    if (hit && Date.now() - hit.lastAttemptAt < JWKS_COOLDOWN_MS) return hit.resolve;

    try {
      const jwks = await this.fetchJwks(issuer.jwksUri);
      const resolve = createLocalJWKSet(jwks);
      this.cache.set(issuer.id, { resolve, fingerprint: fp, fetchedAt: Date.now(), lastAttemptAt: Date.now() });
      return resolve;
    } catch (e) {
      if (hit) {
        // Échec de rafraîchissement : on garde l'ancien jeu et on réessaiera
        // après le cooldown.
        hit.lastAttemptAt = Date.now();
        this.logger.warn(
          `JWKS refresh failed for issuer ${issuer.id}, serving cached keys: ${(e as Error).message}`,
        );
        return hit.resolve;
      }
      this.logger.warn(`JWKS fetch failed for issuer ${issuer.id}: ${(e as Error).message}`);
      throw new FederationVerifyError('jwks_unavailable', 'Jeu de clés de l\'émetteur injoignable.');
    }
  }

  private async fetchJwks(uri: string): Promise<JSONWebKeySet> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), JWKS_FETCH_TIMEOUT_MS);
    try {
      // `safeFetch` re-valide la cible à CHAQUE saut de redirection (un 302 vers
      // 169.254.169.254 est bloqué). En on-premise avec émetteur interne,
      // l'opérateur bascule sur un fetch simple — cf. `allowInternalJwks`.
      const res = this.allowInternalJwks
        ? await fetch(this.assertProtocolOnly(uri), { signal: ctrl.signal, redirect: 'follow' })
        : await safeFetch(uri, { httpsOnly: true, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_JWKS_BYTES) throw new Error('JWKS trop volumineux');
      const parsed = JSON.parse(text) as JSONWebKeySet;
      if (!parsed || !Array.isArray(parsed.keys) || parsed.keys.length === 0) {
        throw new Error('JWKS sans clés');
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Mode on-prem : on relâche le filtre d'IP privée, jamais celui de protocole. */
  private assertProtocolOnly(uri: string): string {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      throw new Error('URL JWKS invalide.');
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new Error('URL JWKS doit être en http(s).');
    }
    return u.toString();
  }

  /** Test de configuration côté admin (bouton « Tester »). */
  async probe(issuer: TrustIssuerConfig): Promise<{ ok: boolean; keys?: number; error?: string }> {
    try {
      if (issuer.jwksJson) {
        const keys = (issuer.jwksJson as JSONWebKeySet)?.keys?.length ?? 0;
        if (!keys) return { ok: false, error: 'JWKS collé sans clés.' };
        return { ok: true, keys };
      }
      if (!issuer.jwksUri) return { ok: false, error: 'Ni URL JWKS ni JWKS collé.' };
      if (!this.allowInternalJwks) assertSafeExternalUrl(issuer.jwksUri, { httpsOnly: true });
      const jwks = await this.fetchJwks(issuer.jwksUri);
      return { ok: true, keys: jwks.keys.length };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
