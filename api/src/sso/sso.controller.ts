import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { LoginEnabledGuard } from '../auth/guards/login-enabled.guard';
import { SsoService } from './sso.service';
import { pickExcLang, translateExc } from '../common/i18n/exception-i18n';

/**
 * Les erreurs SSO ne remontent pas en exception : elles repartent en redirection
 * `/login?sso_error=…`, hors de portée du filtre i18n global. On traduit donc
 * ici. L'utilisateur n'étant pas encore authentifié, la langue vient de
 * l'Accept-Language du NAVIGATEUR — la seule préférence disponible à ce stade.
 */
function ssoErrorMessage(req: Request, e: unknown, fallback: string): string {
  const lang = pickExcLang(req.headers['accept-language'] as string | undefined);
  return translateExc((e as Error)?.message || fallback, lang);
}

/**
 * Routes SSO **publiques** (pré-auth) — pas de `JwtAuthGuard`. Comme les autres
 * routes `/auth/*`, gardées par `LoginEnabledGuard` (404 sur une cellule
 * data-plane : l'auth est portée par le control-plane). Exclu de la doc OpenAPI
 * publique (`@ApiExcludeController`) : flow navigateur, pas une API REST.
 */
@ApiExcludeController()
@Controller('auth')
@UseGuards(LoginEnabledGuard)
export class SsoController {
  constructor(private readonly sso: SsoService) {}

  /** Providers activés pour ce tenant (résolu par Host) → boutons de login. */
  @Get('sso/providers')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async providers() {
    return this.sso.listProviders();
  }

  /** Démarre le flow OIDC : 302 vers l'IdP (Entra). */
  @Get('oidc/:slug/start')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async start(
    @Param('slug') slug: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    try {
      const url = await this.sso.startOidc(slug, req);
      return res.redirect(url);
    } catch (e) {
      const msg = encodeURIComponent(ssoErrorMessage(req, e, 'SSO indisponible'));
      return res.redirect(`${this.sso.frontOrigin(req)}/login?sso_error=${msg}`);
    }
  }

  /** Callback OIDC : valide, provisionne, émet les tokens et redirige le front. */
  @Get('oidc/:slug/callback')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async callback(
    @Param('slug') slug: string,
    @Query() query: Record<string, string | undefined>,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const front = this.sso.frontOrigin(req);
    try {
      const tokens = await this.sso.handleOidcCallback(slug, query, req);
      // Tokens passés au SPA via le **fragment** (jamais envoyé au serveur,
      // donc pas journalisé par Traefik/reverse-proxy). Le front les consomme
      // au montage de /login puis nettoie l'URL (history.replaceState).
      const frag = new URLSearchParams({
        sso: '1',
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
      }).toString();
      return res.redirect(`${front}/login#${frag}`);
    } catch (e) {
      const msg = encodeURIComponent(ssoErrorMessage(req, e, 'Échec de la connexion SSO'));
      return res.redirect(`${front}/login?sso_error=${msg}`);
    }
  }

  // -------------------- SAML 2.0 (lot 3) --------------------

  /** Métadonnées SP (XML) — à fournir à l'IdP pour configurer l'app SAML. */
  @Get('saml/:slug/metadata')
  async samlMetadata(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    try {
      const xml = await this.sso.samlMetadata(slug, req);
      return res.type('application/xml').send(xml);
    } catch (e) {
      return res.status(404).send(`<!-- ${(e as Error).message} -->`);
    }
  }

  /** Démarre le flow SAML : 302 (AuthnRequest) vers l'IdP. */
  @Get('saml/:slug/login')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async samlLogin(@Param('slug') slug: string, @Req() req: Request, @Res() res: Response) {
    try {
      const url = await this.sso.startSaml(slug, req);
      return res.redirect(url);
    } catch (e) {
      const msg = encodeURIComponent(ssoErrorMessage(req, e, 'SSO indisponible'));
      return res.redirect(`${this.sso.frontOrigin(req)}/login?sso_error=${msg}`);
    }
  }

  /** ACS : reçoit la réponse SAML POST, valide, provisionne, émet les tokens. */
  @Post('saml/:slug/callback')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async samlCallback(
    @Param('slug') slug: string,
    @Body() body: { SAMLResponse?: string; RelayState?: string },
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const front = this.sso.frontOrigin(req);
    try {
      const tokens = await this.sso.handleSamlCallback(slug, body, req);
      const frag = new URLSearchParams({
        sso: '1',
        access: tokens.accessToken,
        refresh: tokens.refreshToken,
      }).toString();
      return res.redirect(`${front}/login#${frag}`);
    } catch (e) {
      const msg = encodeURIComponent(ssoErrorMessage(req, e, 'Échec de la connexion SSO'));
      return res.redirect(`${front}/login?sso_error=${msg}`);
    }
  }
}
