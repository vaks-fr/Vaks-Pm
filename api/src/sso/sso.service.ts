import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { AuthService } from '../auth/auth.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { AuthTokens } from '@vaks-pm/shared';
import { OidcClientService } from './oidc-client.service';
import { SamlClientService } from './saml-client.service';
import { SsoStateService } from './sso-state.service';
import { SsoProvisioningService } from './sso-provisioning.service';
import { LicenseService } from '../licensing/license.service';

/** Provider exposé publiquement à l'écran de login (rien de sensible). */
export interface PublicProviderDto {
  slug: string;
  type: 'OIDC' | 'SAML';
  displayName: string;
}

@Injectable()
export class SsoService {
  private readonly logger = new Logger(SsoService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly tenantCtx: TenantContext,
    private readonly auth: AuthService,
    private readonly audit: AuditLogService,
    private readonly oidc: OidcClientService,
    private readonly saml: SamlClientService,
    private readonly state: SsoStateService,
    private readonly provisioning: SsoProvisioningService,
    private readonly licenses: LicenseService,
  ) {}

  /**
   * Garde de licence sur la **fédération** (SPEC §16.4 : licence expirée ⇒ « SSO
   * refuse de fédérer »). Bloque l'amorce du flow ; les callbacks consomment un
   * state créé ici, donc gater le start suffit. La config admin reste possible
   * sans licence (on peut préparer le provider), seul le login fédéré est gated.
   */
  private async assertSsoFeature(type: 'OIDC' | 'SAML'): Promise<void> {
    const feature = type === 'OIDC' ? 'sso-oidc' : 'sso-saml';
    if (!(await this.licenses.hasFeature(feature))) {
      throw new ForbiddenException({
        statusCode: 403,
        error: 'LICENSE_FEATURE_DISABLED',
        message:
          `Le single sign-on ${type} requiert une licence active. ` +
          `Connectez-vous avec un compte local ou contactez votre éditeur.`,
        feature,
      });
    }
  }

  /** Liste des providers activés pour le tenant courant (résolu par Host). */
  async listProviders(): Promise<PublicProviderDto[]> {
    const rows = await this.prisma.identityProvider.findMany({
      where: { enabled: true },
      select: { slug: true, type: true, displayName: true },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((r) => ({ slug: r.slug, type: r.type, displayName: r.displayName }));
  }

  private async loadEnabledProvider(slug: string) {
    const provider = await this.prisma.identityProvider.findFirst({
      where: { slug, enabled: true },
    });
    if (!provider) throw new NotFoundException('Fournisseur SSO inconnu ou désactivé.');
    return provider;
  }

  /** Origine publique de la requête (`https://<host>`), derrière Traefik. */
  private origin(req: Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim()
      || req.protocol
      || 'https';
    const host = req.headers.host;
    if (!host) {
      // Fallback dedicated / hors HTTP : APP_URL.
      return this.config.get<string>('appUrl') ?? 'http://localhost';
    }
    return `${proto}://${host}`;
  }

  /** redirect_uri OIDC, par sous-domaine (pooled) ou domaine unique (dedicated). */
  private callbackUri(req: Request, slug: string): string {
    return `${this.origin(req)}/api/v1/auth/oidc/${slug}/callback`;
  }

  /** ACS URL SAML, par sous-domaine (pooled). */
  private samlCallbackUri(req: Request, slug: string): string {
    return `${this.origin(req)}/api/v1/auth/saml/${slug}/callback`;
  }

  /** Démarre le flow OIDC : renvoie l'URL d'autorisation IdP. */
  async startOidc(slug: string, req: Request): Promise<string> {
    const provider = await this.loadEnabledProvider(slug);
    if (provider.type !== 'OIDC') {
      throw new BadRequestException('Ce fournisseur n’est pas de type OIDC.');
    }
    await this.assertSsoFeature('OIDC');
    const redirectUri = this.callbackUri(req, slug);
    const { codeVerifier, codeChallenge } = this.oidc.pkce();
    const nonce = this.oidc.newNonce();
    const state = await this.state.create({
      providerSlug: slug,
      tenantSlug: this.tenantCtx.currentSlug(),
      nonce,
      codeVerifier,
      redirectUri,
    });
    return this.oidc.authorizationUrl(provider, redirectUri, { state, nonce, codeChallenge });
  }

  /**
   * Traite le callback OIDC : valide le state (anti-replay + cohérence tenant),
   * échange le code, provisionne, émet les tokens. Renvoie les tokens d'app.
   */
  async handleOidcCallback(
    slug: string,
    query: Record<string, string | undefined>,
    req: Request,
  ): Promise<AuthTokens> {
    const tx = await this.state.consume(query.state ?? '');
    if (!tx || tx.providerSlug !== slug) {
      throw new BadRequestException('État de session SSO invalide ou expiré.');
    }
    // Cohérence tenant : le state mémorise le tenant du /start ; il doit matcher
    // le tenant résolu depuis le Host du /callback (anti cross-tenant).
    const currentSlug = this.tenantCtx.currentSlug();
    if ((tx.tenantSlug ?? null) !== (currentSlug ?? null)) {
      throw new BadRequestException('Incohérence de tenant sur le callback SSO.');
    }
    const provider = await this.loadEnabledProvider(slug);
    const meta = {
      ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    };
    const claims = await this.oidc.exchangeCode(
      provider,
      tx.redirectUri,
      {
        code: query.code,
        state: query.state,
        error: query.error,
        error_description: query.error_description,
      },
      { codeVerifier: tx.codeVerifier, nonce: tx.nonce, state: query.state ?? '' },
    );
    const result = await this.provisioning.provision(provider, claims, meta);
    const tokens = await this.auth.issueTokensForUser(result.userId, {
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
    });
    this.audit.logCritical({
      organizationId: result.organizationId,
      action: AUDIT_ACTIONS.AUTH_SSO_LOGIN,
      actorType: 'USER',
      actorId: result.userId,
      actorLabel: result.email,
      resourceType: 'user',
      resourceId: result.userId,
      resourceLabel: result.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: { idp: slug, created: result.created, linked: result.linked },
    });
    return tokens;
  }

  // ============================================================
  // SAML 2.0 (lot 3)
  // ============================================================

  /** Démarre le flow SAML : renvoie l'URL d'AuthnRequest (302 vers l'IdP). */
  async startSaml(slug: string, req: Request): Promise<string> {
    const provider = await this.loadEnabledProvider(slug);
    if (provider.type !== 'SAML') {
      throw new BadRequestException('Ce fournisseur n’est pas de type SAML.');
    }
    await this.assertSsoFeature('SAML');
    const callbackUrl = this.samlCallbackUri(req, slug);
    const relayState = await this.state.createSaml({
      providerSlug: slug,
      tenantSlug: this.tenantCtx.currentSlug(),
      callbackUrl,
    });
    return this.saml.authorizeUrl(provider, callbackUrl, relayState);
  }

  /**
   * Traite l'ACS callback SAML : consomme le RelayState (anti-replay + cohérence
   * tenant), valide l'assertion, provisionne, émet les tokens.
   */
  async handleSamlCallback(
    slug: string,
    body: { SAMLResponse?: string; RelayState?: string },
    req: Request,
  ): Promise<AuthTokens> {
    const tx = await this.state.consumeSaml(body.RelayState ?? '');
    if (!tx || tx.providerSlug !== slug) {
      throw new BadRequestException('État de session SAML invalide ou expiré.');
    }
    const currentSlug = this.tenantCtx.currentSlug();
    if ((tx.tenantSlug ?? null) !== (currentSlug ?? null)) {
      throw new BadRequestException('Incohérence de tenant sur le callback SAML.');
    }
    const provider = await this.loadEnabledProvider(slug);
    const meta = {
      ip: (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() || req.ip,
      userAgent: String(req.headers['user-agent'] ?? ''),
    };
    const claims = await this.saml.validateCallback(provider, tx.callbackUrl, body);
    const result = await this.provisioning.provision(provider, claims, meta);
    const tokens = await this.auth.issueTokensForUser(result.userId, {
      userAgent: meta.userAgent,
      ipAddress: meta.ip,
    });
    this.audit.logCritical({
      organizationId: result.organizationId,
      action: AUDIT_ACTIONS.AUTH_SSO_LOGIN,
      actorType: 'USER',
      actorId: result.userId,
      actorLabel: result.email,
      resourceType: 'user',
      resourceId: result.userId,
      resourceLabel: result.email,
      ip: meta.ip,
      userAgent: meta.userAgent,
      detail: { idp: slug, protocol: 'saml', created: result.created, linked: result.linked },
    });
    return tokens;
  }

  /** Métadonnées SP SAML (XML) à fournir à l'IdP. */
  async samlMetadata(slug: string, req: Request): Promise<string> {
    const provider = await this.prisma.identityProvider.findFirst({ where: { slug } });
    if (!provider || provider.type !== 'SAML') {
      throw new NotFoundException('Fournisseur SAML inconnu.');
    }
    return this.saml.metadata(provider, this.samlCallbackUri(req, slug));
  }

  /** Origine vers laquelle rediriger le navigateur après le callback (front). */
  frontOrigin(req: Request): string {
    return this.origin(req);
  }
}
