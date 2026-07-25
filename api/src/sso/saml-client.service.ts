import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { SAML, SamlConfig } from '@node-saml/node-saml';
import type { IdentityProvider } from '@db';
import { ClaimMappings, ENTRA_SAML_DEFAULTS, NormalizedClaims } from './sso.types';

/**
 * Enveloppe `@node-saml/node-saml` (SAML 2.0). Comme pour OIDC, on pilote la lib
 * directement dans un service (pas de passport-strategy) pour garder le contrôle
 * du routing tenant (pooled : l'ACS URL dépend du sous-domaine).
 *
 * Le service est sans état : un objet `SAML` est construit à la demande à partir
 * de la config DB du provider + l'ACS URL résolue par Host (mis en cache court par
 * (provider, callbackUrl) car la construction est purement locale). La vérif de
 * signature d'assertion (cert IdP `samlIdpCert`), des conditions (NotBefore /
 * NotOnOrAfter) et de l'audience est faite par la lib.
 */
@Injectable()
export class SamlClientService {
  private readonly logger = new Logger(SamlClientService.name);
  private readonly cache = new Map<string, { saml: SAML; fingerprint: string }>();

  /** Construit (ou réutilise) l'instance SAML pour un provider + ACS URL. */
  private getSaml(provider: IdentityProvider, callbackUrl: string): SAML {
    if (!provider.samlEntryPoint || !provider.samlIdpCert) {
      throw new BadRequestException('Provider SAML incomplet (entryPoint / certificat IdP manquant).');
    }
    // entityID du SP (nous). Défaut : l'URL des métadonnées du provider.
    const issuer = provider.samlIssuer?.trim() || this.defaultEntityId(callbackUrl);
    const fingerprint = `${provider.samlEntryPoint}|${issuer}|${callbackUrl}|${this.certFingerprint(provider.samlIdpCert)}`;
    const cacheKey = `${provider.id}:${callbackUrl}`;
    const hit = this.cache.get(cacheKey);
    if (hit && hit.fingerprint === fingerprint) return hit.saml;

    const config: SamlConfig = {
      callbackUrl,
      entryPoint: provider.samlEntryPoint,
      issuer,
      idpCert: this.normalizeCert(provider.samlIdpCert),
      // L'assertion DOIT être signée (Entra signe l'assertion par défaut).
      wantAssertionsSigned: true,
      // La réponse englobante n'est pas toujours signée séparément ; on n'exige
      // que la signature de l'assertion (réglage robuste avec Entra).
      wantAuthnResponseSigned: false,
      // Audience attendue = notre entityID SP.
      audience: issuer,
      signatureAlgorithm: 'sha256',
      digestAlgorithm: 'sha256',
      // Anti-replay porté par notre RelayState one-shot (Redis), multi-réplica :
      // node-saml exige un CacheProvider partagé pour InResponseTo, on s'appuie
      // donc sur le consume one-shot du RelayState + la condition NotOnOrAfter.
      validateInResponseTo: 'never',
      // Pas de clé privée SP → AuthnRequest non signée (Entra l'accepte).
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    } as SamlConfig;

    const saml = new SAML(config);
    this.cache.set(cacheKey, { saml, fingerprint });
    return saml;
  }

  /** URL d'AuthnRequest (redirect 302 vers l'IdP), `RelayState` = clé d'état. */
  async authorizeUrl(
    provider: IdentityProvider,
    callbackUrl: string,
    relayState: string,
  ): Promise<string> {
    const saml = this.getSaml(provider, callbackUrl);
    return saml.getAuthorizeUrlAsync(relayState, undefined, {});
  }

  /**
   * Valide la réponse POST (ACS) et renvoie les claims normalisés. Lève si la
   * signature / les conditions / l'audience sont invalides.
   */
  async validateCallback(
    provider: IdentityProvider,
    callbackUrl: string,
    body: { SAMLResponse?: string; RelayState?: string },
  ): Promise<NormalizedClaims> {
    if (!body.SAMLResponse) {
      throw new BadRequestException('Réponse SAML absente (SAMLResponse manquant).');
    }
    const saml = this.getSaml(provider, callbackUrl);
    let profile: Record<string, unknown> | null;
    try {
      const res = await saml.validatePostResponseAsync({
        SAMLResponse: body.SAMLResponse,
        RelayState: body.RelayState,
      } as { SAMLResponse: string; RelayState?: string });
      profile = res.profile as unknown as Record<string, unknown>;
    } catch (e) {
      const msg = (e as Error).message || 'unknown';
      // Détail (cert configuré vs signataire, emplacement de la signature) gardé
      // côté logs serveur uniquement — JAMAIS renvoyé au client : un oracle
      // `certMatch` + un préfixe de cert aideraient à aligner une assertion
      // forgée et fuiteraient la config IdP.
      this.logger.error(`SAML assertion validation failed: ${msg}`);
      throw new BadRequestException("Échec de validation de l'assertion SAML.");
    }
    if (!profile) throw new BadRequestException('Assertion SAML vide.');
    return this.normalize(provider, profile);
  }

  /** Métadonnées SP (entityID, ACS URL) à fournir à l'IdP. */
  metadata(provider: IdentityProvider, callbackUrl: string): string {
    // On peut générer les métadonnées même sans cert IdP encore saisi (pour que
    // l'admin les récupère AVANT de configurer l'IdP) → instance minimale.
    const issuer = provider.samlIssuer?.trim() || this.defaultEntityId(callbackUrl);
    const saml = new SAML({
      callbackUrl,
      issuer,
      entryPoint: provider.samlEntryPoint ?? 'https://login.microsoftonline.com/',
      idpCert: provider.samlIdpCert ? this.normalizeCert(provider.samlIdpCert) : 'PLACEHOLDER',
      identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    } as SamlConfig);
    return saml.generateServiceProviderMetadata(null, null);
  }

  /** entityID SP par défaut quand l'admin ne l'a pas fixé. Base de l'endpoint
   *  SAML du provider (`…/auth/saml/<slug>`), volontairement DISTINCT de l'ACS
   *  (`/callback`) et de l'URL de métadonnées (`/metadata`). */
  private defaultEntityId(callbackUrl: string): string {
    return callbackUrl.replace(/\/callback$/, '');
  }

  private normalizeCert(cert: string): string | string[] {
    // node-saml accepte PEM avec ou sans en-têtes ; on transmet tel quel.
    return cert.trim();
  }

  private certFingerprint(cert: string): string {
    // Empreinte légère pour invalider le cache si le cert change.
    return String(cert.length) + ':' + cert.slice(0, 24);
  }

  /** Mappe le profil SAML (attributs par URI de claim) → claims normalisés. */
  private normalize(provider: IdentityProvider, raw: Record<string, unknown>): NormalizedClaims {
    const m = (provider.claimMappings ?? {}) as ClaimMappings;
    const pick = (key: string | undefined): unknown => (key ? raw[key] : undefined);
    const first = (v: unknown): string | undefined => {
      if (Array.isArray(v)) return v.length ? String(v[0]) : undefined;
      return v == null ? undefined : String(v);
    };

    const externalId = (
      first(pick(m.externalId ?? ENTRA_SAML_DEFAULTS.externalId)) ??
      first(raw['nameID']) ??
      ''
    ).trim();

    const email = (
      first(pick(m.email ?? ENTRA_SAML_DEFAULTS.email)) ??
      first(raw['email']) ??
      first(raw['nameID']) ??
      ''
    )
      .trim()
      .toLowerCase();

    const upnRaw = first(pick(ENTRA_SAML_DEFAULTS.upn));
    const upn = upnRaw ? upnRaw.trim().toLowerCase() || undefined : undefined;

    const name = (
      first(pick(m.name ?? ENTRA_SAML_DEFAULTS.name)) ??
      first(raw['displayName']) ??
      first(raw['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname']) ??
      email ??
      'Utilisateur'
    ).trim();

    const groupsRaw = pick(m.groups ?? ENTRA_SAML_DEFAULTS.groups);
    const groups = Array.isArray(groupsRaw)
      ? groupsRaw.map((g) => String(g))
      : typeof groupsRaw === 'string' && groupsRaw
        ? [groupsRaw]
        : [];

    if (!externalId || !email) {
      throw new BadRequestException(
        "L'assertion SAML ne contient pas d'identifiant (objectId/nameID) ou d'email exploitable.",
      );
    }
    return { externalId, email, name: name || email, groups, upn };
  }
}
