/**
 * Types internes du module SSO (phase 10). Les DTO exposés à l'UI sont définis
 * inline dans les controllers pour rester proches de leur usage.
 */

/** Une règle de mapping groupe/claim IdP → rôle org. */
export interface RoleMapping {
  /** Valeur de groupe/rôle côté IdP (GUID de groupe Entra, ou nom de rôle d'app). */
  match: string;
  /** Clé du rôle org (Role.key) à attribuer, ex. ORG_ADMIN, ORG_MEMBER. */
  roleKey: string;
}

/** Mapping des claims OIDC/SAML vers les champs User. Tous optionnels (défauts
 *  Entra appliqués si absents). */
export interface ClaimMappings {
  email?: string;
  name?: string;
  externalId?: string;
  groups?: string;
}

/** Claims normalisés extraits d'un id_token / d'une assertion. */
export interface NormalizedClaims {
  externalId: string;
  email: string;
  name: string;
  groups: string[];
  /** UPN brut (claim `upn`), capturé SÉPARÉMENT de l'email. Sert de clé de
   *  rapprochement sûre : un guest Entra a un UPN `…#EXT#@…onmicrosoft.com`
   *  qui ne peut valoir un email du domaine interne. Absent si non émis. */
  upn?: string;
  /** Claim `email_verified` (si présent). Utilisé pour refuser un auto-link
   *  quand l'email n'est explicitement pas vérifié. */
  emailVerified?: boolean;
}

/** Transaction OIDC en vol, stockée dans Redis entre /start et /callback. */
export interface OidcTransaction {
  providerSlug: string;
  tenantSlug: string | null;
  nonce: string;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
}

/** Transaction SAML en vol, stockée dans Redis entre /login et l'ACS callback.
 *  La clé sert de `RelayState` (one-shot consume = anti-replay au niveau app). */
export interface SamlTransaction {
  providerSlug: string;
  tenantSlug: string | null;
  callbackUrl: string;
  createdAt: number;
}

/** Défauts de mapping de claims pour Microsoft Entra ID. */
export const ENTRA_CLAIM_DEFAULTS: Required<ClaimMappings> = {
  // `oid` = identifiant stable de l'objet user dans le tenant (ne change jamais,
  // contrairement à `sub` qui est par-app). On préfère `oid` pour Entra.
  externalId: 'oid',
  // `email` n'est pas toujours présent ; `preferred_username` l'est presque
  // toujours (UPN). On essaie email puis preferred_username au runtime.
  email: 'email',
  name: 'name',
  groups: 'groups',
};

/**
 * Défauts de mapping de claims **SAML** pour Microsoft Entra ID (URIs de claim
 * standard émis dans l'assertion). `externalId` = objectidentifier (GUID stable
 * de l'annuaire, équivalent SAML du `oid` OIDC). `upn` capturé séparément.
 */
export const ENTRA_SAML_DEFAULTS: Required<ClaimMappings> & { upn: string } = {
  externalId: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
  email: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  name: 'http://schemas.microsoft.com/identity/claims/displayname',
  groups: 'http://schemas.microsoft.com/ws/2008/06/identity/claims/groups',
  upn: 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn',
};
