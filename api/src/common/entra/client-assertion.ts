import { randomUUID } from 'crypto';
import { importPKCS8, SignJWT } from 'jose';

/**
 * Authentification d'une app registration Entra pour un échange de jetons
 * (client-credentials Graph, ou private_key_jwt SSO). Deux modes exclusifs :
 *
 *  - `client_secret`    : secret partagé symétrique (historique). Le secret
 *                         voyage sur le réseau et Entra en garde une copie.
 *  - `client_assertion` : **private_key_jwt** (RFC 7523). L'app signe un JWT
 *                         court avec sa clé privée ; Entra ne détient que le
 *                         certificat public. Rien de secret ne quitte l'API.
 *
 * ⚠️ Spécificité Entra : l'assertion DOIT porter dans son en-tête l'empreinte
 * du certificat (`x5t`, SHA-1 base64url). Entra matche le certificat sur `x5t`,
 * jamais sur `kid` — c'est pour cela qu'on signe nous-mêmes (les libs OIDC
 * génériques ne posent que `kid`).
 */
export type EntraCredential =
  | { tenantId: string; clientId: string; authMethod: 'client_secret'; clientSecret: string }
  | {
      tenantId: string;
      clientId: string;
      authMethod: 'client_assertion';
      /** Clé privée PKCS#8 en PEM (`-----BEGIN PRIVATE KEY-----`). */
      privateKeyPem: string;
      /** Empreinte du certificat telle qu'affichée par Entra (hex, séparateurs tolérés). */
      thumbprint: string;
      /** Algorithme de signature (défaut RS256). */
      alg?: 'RS256' | 'PS256';
    };

const TOKEN_ENDPOINT = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`;

/** Empreinte hex (`A1:B2:…` / `a1b2…`) → `x5t` (bytes du digest en base64url). */
function thumbprintToX5t(thumbprint: string): string {
  const hex = thumbprint.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < 40 || hex.length % 2 !== 0) {
    throw new Error('Empreinte de certificat invalide (hex SHA-1/SHA-256 attendu).');
  }
  return Buffer.from(hex, 'hex').toString('base64url');
}

/** Paramètres de signature d'une assertion client `private_key_jwt`. */
export interface ClientAssertionParams {
  clientId: string;
  /** Clé privée PKCS#8 (PEM). */
  privateKeyPem: string;
  /** Empreinte du certificat (hex) → en-tête `x5t`. */
  thumbprint: string;
  /**
   * `aud` de l'assertion = **token endpoint** de l'AS. Graph :
   * `entraTokenEndpoint(tenantId)`. SSO/OIDC : le `token_endpoint` **découvert**
   * (ne pas le reconstruire — Entra exige l'endpoint exact).
   */
  audience: string;
  alg?: 'RS256' | 'PS256';
}

/**
 * Signe une assertion client `private_key_jwt` (Entra). Durée de vie courte
 * (5 min), `jti` unique (anti-rejeu), en-tête porteur de `x5t`.
 */
export async function signClientAssertion(p: ClientAssertionParams): Promise<string> {
  const alg = p.alg ?? 'RS256';
  const key = await importPKCS8(p.privateKeyPem, alg);
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg, typ: 'JWT', x5t: thumbprintToX5t(p.thumbprint) })
    .setIssuer(p.clientId)
    .setSubject(p.clientId)
    .setAudience(p.audience)
    .setJti(randomUUID())
    .setIssuedAt(now)
    .setNotBefore(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

/**
 * Construit le corps `application/x-www-form-urlencoded` d'un échange OAuth2
 * pour la credential donnée : `client_secret` ou couple `client_assertion*`.
 * L'appelant ajoute `grant_type`/`scope`/… et POSTe vers le token endpoint.
 */
export async function applyCredentialToForm(form: URLSearchParams, cred: EntraCredential): Promise<void> {
  form.set('client_id', cred.clientId);
  if (cred.authMethod === 'client_assertion') {
    form.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    form.set(
      'client_assertion',
      await signClientAssertion({
        clientId: cred.clientId,
        privateKeyPem: cred.privateKeyPem,
        thumbprint: cred.thumbprint,
        audience: TOKEN_ENDPOINT(cred.tenantId),
        alg: cred.alg,
      }),
    );
  } else {
    form.set('client_secret', cred.clientSecret);
  }
}

/** Token endpoint Entra pour un tenant (réutilisé par les échanges maison). */
export const entraTokenEndpoint = TOKEN_ENDPOINT;
