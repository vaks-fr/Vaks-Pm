/**
 * Types internes de la façade OAuth 2.1 pour MCP (phase 11).
 *
 * Rappel d'architecture : l'API est ici l'**Authorization Server**. Elle ne
 * réimplémente PAS l'authentification — elle réutilise le login existant (local
 * ou SSO Entra, phase 10) — et n'invente PAS un nouveau format de jeton : le
 * `access_token` qu'elle émet est un **jeton `vaks_pat_` court** (phase 9), que
 * l'API sait déjà valider (public-gate + scopes). Le serveur MCP n'est qu'un
 * relais.
 */
import type { Permission } from '@vaks-pm/shared';

/** Client OAuth enregistré (DCR RFC 7591 ou pré-enregistré par l'admin). */
export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string;
  createdAt: number;
  /**
   * OIDC Dynamic Registration / spec MCP 2026-07-28 : `native` = application
   * desktop/CLI (redirections loopback à port variable, RFC 8252), `web` =
   * application serveur (correspondance **exacte** du redirect_uri).
   * `undefined` = client enregistré avant l'introduction du champ : on conserve
   * l'ancien comportement permissif pour ne pas casser les connexions en place.
   */
  applicationType?: 'native' | 'web';
  /** Client **confidentiel** (pré-enregistré, ex. Copilot Studio) : porte un
   *  secret. Les clients DCR (Claude/ChatGPT) sont publics (PKCE, pas de secret). */
  confidential?: boolean;
  /** sha256 du client_secret (clair jamais stocké). Présent si confidentiel. */
  secretHash?: string;
}

/** Requête d'autorisation en attente, le temps que l'utilisateur se logue puis
 *  consente (entre `/authorize` et `/consent`). Clé = `tx` opaque. */
export interface PendingAuthorization {
  clientId: string;
  redirectUri: string;
  /** null = pas de PKCE (client confidentiel avec secret). */
  codeChallenge: string | null;
  codeChallengeMethod: 'S256' | null;
  scope: string | null;
  state: string | null;
  /** RFC 8707 : ressource visée (l'URL du serveur MCP). */
  resource: string | null;
  /**
   * RFC 9207 : émetteur (issuer) qui a démarré ce flux, renvoyé tel quel dans la
   * réponse d'autorisation. Stocké ici plutôt que recalculé au consentement :
   * c'est ce qui garantit que l'`iss` annoncé au client est bien celui qui a
   * émis le code, y compris si la requête de consentement arrivait par un autre
   * hôte. `null` = transaction créée avant cette version (rétrocompatibilité).
   */
  issuer?: string | null;
  createdAt: number;
}

/** Code d'autorisation émis après consentement. Clé = le code (one-shot). */
export interface AuthorizationCode {
  userId: string;
  orgId: string;
  clientId: string;
  redirectUri: string;
  /** null = pas de PKCE (client confidentiel — vérification par secret au /token). */
  codeChallenge: string | null;
  scopes: Permission[];
  resource: string | null;
  createdAt: number;
}

/** Refresh token côté serveur (stocké haché). Clé = sha256(secret). */
export interface RefreshRecord {
  userId: string;
  orgId: string;
  clientId: string;
  scopes: Permission[];
  createdAt: number;
  /** Connexion IA stable à laquelle ce refresh appartient (survit aux rotations). */
  connId: string;
}

/**
 * Connexion IA active = un client IA branché par un utilisateur. **Stable** à
 * travers les rotations de refresh (le `connId` ne change pas). Sert à lister /
 * révoquer les connexions (self-service user + offboarding admin). Révoquer la
 * connexion casse la chaîne de refresh (le refreshGrant exige qu'elle existe).
 */
export interface OAuthConnection {
  connId: string;
  userId: string;
  orgId: string;
  clientId: string;
  clientName: string;
  createdAt: number;
  lastUsedAt: number;
  /** Id du **PAT actif** (access token courant) émis pour cette connexion. Permet
   *  de révoquer le jeton **immédiatement** quand la connexion est coupée (sinon
   *  l'access token survivrait jusqu'à son expiration ≤1 h). Mis à jour à chaque
   *  rotation par `issue()` (qui révoque aussi le précédent). */
  tokenId?: string;
}
