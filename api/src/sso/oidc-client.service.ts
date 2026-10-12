import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Issuer, generators, Client, TokenSet } from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { IdentityProvider } from '@db';
import { TenantCryptoService } from '../common/crypto/tenant-crypto.service';
import { signClientAssertion } from '../common/entra/client-assertion';
import { ClaimMappings, ENTRA_CLAIM_DEFAULTS, NormalizedClaims } from './sso.types';

/** Credential certificat résolue (mode private_key_jwt). */
interface CertCredential {
  privateKeyPem: string;
  thumbprint: string;
}

interface CachedClient {
  client: Client;
  fetchedAt: number;
  /** Empreinte de la config (discoveryUrl|clientId|redirectUri) — invalide le
   *  cache si l'admin édite le provider. */
  fingerprint: string;
}

/**
 * Enveloppe `openid-client` (v5) : découverte OIDC (cachée), construction de
 * l'URL d'autorisation avec PKCE, et échange + **validation** du code au
 * callback (signature JWKS, iss, aud, nonce, exp — tout est fait par la lib).
 *
 * Le client secret ne vient JAMAIS de la DB : il est lu depuis l'env (Swarm
 * secret `SSO_OIDC_CLIENT_SECRET`, cf. SSO.md §5).
 */
@Injectable()
export class OidcClientService {
  private readonly logger = new Logger(OidcClientService.name);
  private readonly cache = new Map<string, CachedClient>();
  /** JWKS distants (mode certificat) — mis en cache par `jwks_uri` ; jose gère
   *  le refresh/rotation des clés en interne. */
  private readonly jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
  private static readonly DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 h

  constructor(
    private readonly config: ConfigService,
    private readonly tenantCrypto: TenantCryptoService,
  ) {}

  /**
   * Secret du client OIDC. PRIORITÉ au secret **par tenant** chiffré en base
   * (`oidcClientSecretEnc`) ; fallback sur le Swarm secret partagé (back-compat
   * mono-secret, ex. tenant demo historique). Vide → config incomplète.
   */
  private async clientSecret(provider: IdentityProvider): Promise<string> {
    if (provider.oidcClientSecretEnc) {
      try {
        return await this.tenantCrypto.decrypt(provider.organizationId, provider.oidcClientSecretEnc);
      } catch (e) {
        this.logger.error(`OIDC client secret decryption failed (${provider.slug}): ${(e as Error).message}`);
        throw new BadRequestException('Secret client OIDC illisible (clé de chiffrement ?).');
      }
    }
    return this.config.get('sso')?.oidcClientSecret ?? '';
  }

  /**
   * Credential **certificat** (private_key_jwt) si configurée pour ce provider.
   * Sa présence bascule tout le flux token en mode secretless (échange fait main,
   * cf. `exchangeCodeWithCert`) — openid-client ne peut pas émettre le header
   * `x5t` requis par Entra. `null` ⇒ mode client secret classique.
   */
  private async certCredential(provider: IdentityProvider): Promise<CertCredential | null> {
    if (!provider.oidcPrivateKeyEnc || !provider.oidcCertThumbprint) return null;
    try {
      const privateKeyPem = await this.tenantCrypto.decrypt(provider.organizationId, provider.oidcPrivateKeyEnc);
      return { privateKeyPem, thumbprint: provider.oidcCertThumbprint };
    } catch (e) {
      this.logger.error(`OIDC private key decryption failed (${provider.slug}): ${(e as Error).message}`);
      throw new BadRequestException('Clé privée OIDC illisible (clé de chiffrement ?).');
    }
  }

  /**
   * Construit (ou réutilise) le client OIDC pour un provider + redirect_uri
   * donné. La découverte réseau est cachée 1 h par (provider, redirectUri).
   */
  private async getClient(provider: IdentityProvider, redirectUri: string): Promise<Client> {
    if (!provider.oidcDiscoveryUrl || !provider.oidcClientId) {
      throw new BadRequestException('Provider OIDC incomplet (discovery/clientId manquant).');
    }
    // Mode certificat : aucun secret requis. Le client openid-client ne sert
    // qu'à la découverte + l'URL d'autorisation (pas d'auth au token endpoint —
    // l'échange de code est fait main dans `exchangeCodeWithCert`).
    const cert = await this.certCredential(provider);
    let secret = '';
    if (!cert) {
      secret = await this.clientSecret(provider);
      if (!secret) {
        throw new BadRequestException(
          "Secret client OIDC absent (SSO_OIDC_CLIENT_SECRET non monté). Contactez l'administrateur.",
        );
      }
    }
    const mode = cert ? 'cert' : 'secret';
    const fingerprint = `${provider.oidcDiscoveryUrl}|${provider.oidcClientId}|${redirectUri}|${mode}`;
    const cacheKey = `${provider.id}:${redirectUri}`;
    const hit = this.cache.get(cacheKey);
    if (
      hit &&
      hit.fingerprint === fingerprint &&
      Date.now() - hit.fetchedAt < OidcClientService.DISCOVERY_TTL_MS
    ) {
      return hit.client;
    }
    const issuer = await Issuer.discover(provider.oidcDiscoveryUrl);
    const client = new issuer.Client({
      client_id: provider.oidcClientId,
      ...(cert ? { token_endpoint_auth_method: 'none' as const } : { client_secret: secret }),
      redirect_uris: [redirectUri],
      response_types: ['code'],
    });
    this.cache.set(cacheKey, { client, fetchedAt: Date.now(), fingerprint });
    return client;
  }

  /** Génère un couple PKCE (verifier secret + challenge à envoyer). */
  pkce(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = generators.codeVerifier();
    const codeChallenge = generators.codeChallenge(codeVerifier);
    return { codeVerifier, codeChallenge };
  }

  newNonce(): string {
    return generators.nonce();
  }

  /** URL d'autorisation vers l'IdP (302 du navigateur). */
  async authorizationUrl(
    provider: IdentityProvider,
    redirectUri: string,
    opts: { state: string; nonce: string; codeChallenge: string },
  ): Promise<string> {
    const client = await this.getClient(provider, redirectUri);
    const scopes = provider.oidcScopes?.length
      ? provider.oidcScopes
      : ['openid', 'profile', 'email'];
    return client.authorizationUrl({
      scope: Array.from(new Set(['openid', ...scopes])).join(' '),
      response_mode: 'query',
      code_challenge: opts.codeChallenge,
      code_challenge_method: 'S256',
      state: opts.state,
      nonce: opts.nonce,
    });
  }

  /**
   * Échange le code au callback et valide l'id_token. Lève si la validation
   * échoue (signature, iss, aud, nonce, exp). Renvoie les claims normalisés.
   */
  async exchangeCode(
    provider: IdentityProvider,
    redirectUri: string,
    params: { code?: string; state?: string; error?: string; error_description?: string },
    checks: { codeVerifier: string; nonce: string; state: string },
  ): Promise<NormalizedClaims> {
    if (params.error) {
      throw new BadRequestException(
        `IdP a refusé : ${params.error}${params.error_description ? ` — ${params.error_description}` : ''}`,
      );
    }
    // Mode certificat : openid-client ne peut pas signer l'assertion Entra (x5t)
    // → échange + validation faits main.
    const cert = await this.certCredential(provider);
    if (cert) {
      return this.exchangeCodeWithCert(provider, redirectUri, params, checks, cert);
    }
    const client = await this.getClient(provider, redirectUri);
    let tokenSet: TokenSet;
    try {
      tokenSet = await client.callback(
        redirectUri,
        { code: params.code, state: params.state },
        { code_verifier: checks.codeVerifier, nonce: checks.nonce, state: checks.state },
      );
    } catch (e) {
      this.logger.warn(`OIDC callback validation failed: ${(e as Error).message}`);
      throw new BadRequestException("Échec de validation de la réponse de l'IdP.");
    }
    const claims = tokenSet.claims();
    return this.normalize(provider, claims as Record<string, unknown>);
  }

  /** JWKS distant mémoïsé par `jwks_uri` (jose gère refresh + rotation). */
  private jwksFor(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
    let jwks = this.jwksCache.get(jwksUri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(jwksUri));
      this.jwksCache.set(jwksUri, jwks);
    }
    return jwks;
  }

  /**
   * Échange du code en **mode certificat** (private_key_jwt) : openid-client ne
   * pouvant pas poser l'en-tête `x5t` exigé par Entra, on fait l'échange à la
   * main (assertion signée nous-mêmes) PUIS on valide l'`id_token` avec `jose`
   * (signature JWKS + iss + aud + exp + nonce) — même garanties que le flux
   * openid-client du mode secret.
   */
  private async exchangeCodeWithCert(
    provider: IdentityProvider,
    redirectUri: string,
    params: { code?: string; state?: string },
    checks: { codeVerifier: string; nonce: string; state: string },
    cert: CertCredential,
  ): Promise<NormalizedClaims> {
    if (!params.code) throw new BadRequestException("Code d'autorisation OIDC manquant.");
    if (!params.state || params.state !== checks.state) {
      throw new BadRequestException('Paramètre state OIDC invalide (CSRF ?).');
    }
    // Métadonnées découvertes (réutilise le cache de découverte via getClient).
    const client = await this.getClient(provider, redirectUri);
    const meta = client.issuer.metadata;
    const tokenEndpoint = typeof meta.token_endpoint === 'string' ? meta.token_endpoint : '';
    const jwksUri = typeof meta.jwks_uri === 'string' ? meta.jwks_uri : '';
    const expectedIssuer = String(meta.issuer);
    if (!tokenEndpoint || !jwksUri) {
      throw new BadRequestException('Métadonnées OIDC incomplètes (token_endpoint / jwks_uri).');
    }

    // 1. Échange du code avec assertion client porteuse de x5t.
    const assertion = await signClientAssertion({
      clientId: provider.oidcClientId!,
      privateKeyPem: cert.privateKeyPem,
      thumbprint: cert.thumbprint,
      audience: tokenEndpoint,
    });
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: redirectUri,
      client_id: provider.oidcClientId!,
      code_verifier: checks.codeVerifier,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    let res: Response;
    try {
      res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new BadRequestException(`Token endpoint OIDC injoignable : ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    const txt = await res.text();
    let json: { id_token?: string; error?: string; error_description?: string } | null = null;
    try {
      json = txt ? JSON.parse(txt) : null;
    } catch {
      /* laissé null */
    }
    if (!res.ok || !json?.id_token) {
      const msg = json?.error_description || json?.error || `HTTP ${res.status}`;
      this.logger.warn(`OIDC (cert) token exchange failed (${provider.slug}): ${msg}`);
      throw new BadRequestException("Échec de l'échange de code OIDC (certificat).");
    }

    // 2. Validation de l'id_token (signature JWKS + iss + aud + exp).
    let payload: Record<string, unknown>;
    try {
      const verified = await jwtVerify(json.id_token, this.jwksFor(jwksUri), {
        issuer: expectedIssuer,
        audience: provider.oidcClientId!,
      });
      payload = verified.payload as Record<string, unknown>;
    } catch (e) {
      this.logger.warn(`OIDC (cert) id_token validation failed (${provider.slug}): ${(e as Error).message}`);
      throw new BadRequestException('id_token OIDC invalide (signature / iss / aud / exp).');
    }

    // 3. Nonce anti-rejeu (openid-client le fait pour le mode secret).
    if (!payload.nonce || payload.nonce !== checks.nonce) {
      throw new BadRequestException('Nonce OIDC invalide (rejeu possible).');
    }
    return this.normalize(provider, payload);
  }

  /** Applique le claimMappings du provider (+ défauts Entra) aux claims bruts. */
  private normalize(
    provider: IdentityProvider,
    raw: Record<string, unknown>,
  ): NormalizedClaims {
    const m = (provider.claimMappings ?? {}) as ClaimMappings;
    const pick = (key: string): unknown => raw[key];
    const externalId = String(
      pick(m.externalId ?? ENTRA_CLAIM_DEFAULTS.externalId) ?? pick('sub') ?? '',
    ).trim();
    const email = String(
      pick(m.email ?? ENTRA_CLAIM_DEFAULTS.email) ??
        pick('preferred_username') ??
        pick('upn') ??
        '',
    )
      .trim()
      .toLowerCase();
    // UPN capturé SÉPARÉMENT, depuis le SEUL claim `upn` (pas de repli sur
    // `preferred_username`/`email`, mutables et non garantis uniques côté
    // Microsoft). C'est la clé de rapprochement sûre : un guest Entra a un UPN
    // `…#EXT#@…onmicrosoft.com` qui ne peut valoir un email du domaine interne.
    // Absent → en mode 'upn', le provisioning ne rapprochera pas (fallback JIT).
    const upnRaw = pick('upn');
    const upn = upnRaw ? String(upnRaw).trim().toLowerCase() || undefined : undefined;
    // `email_verified` : présent sur certains IdP (OIDC standard). undefined si absent.
    const evRaw = pick('email_verified');
    const emailVerified =
      typeof evRaw === 'boolean'
        ? evRaw
        : evRaw === 'true'
          ? true
          : evRaw === 'false'
            ? false
            : undefined;
    const name = String(
      pick(m.name ?? ENTRA_CLAIM_DEFAULTS.name) ?? email ?? 'Utilisateur',
    ).trim();
    const groupsRaw = pick(m.groups ?? ENTRA_CLAIM_DEFAULTS.groups) ?? pick('roles');
    const groups = Array.isArray(groupsRaw)
      ? groupsRaw.map((g) => String(g))
      : typeof groupsRaw === 'string'
        ? [groupsRaw]
        : [];
    if (!externalId || !email) {
      throw new BadRequestException(
        "L'id_token ne contient pas d'identifiant ou d'email exploitable.",
      );
    }
    return { externalId, email, name: name || email, groups, upn, emailVerified };
  }

  /** Test de connectivité : la découverte aboutit-elle ? (utilisé par l'admin). */
  async testDiscovery(discoveryUrl: string): Promise<{ ok: boolean; issuer?: string; error?: string }> {
    try {
      const issuer = await Issuer.discover(discoveryUrl);
      return { ok: true, issuer: String(issuer.metadata.issuer) };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}
