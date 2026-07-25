import {
  Body,
  Controller,
  Get,
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
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { OAuthService } from './oauth.service';

/**
 * Façade OAuth 2.1 pour MCP (phase 11). Surface **publique pré-auth** (comme
 * `/auth/sso/*`), donc gardée par `LoginEnabledGuard` et exclue de la doc
 * OpenAPI. `/consent` est la seule route authentifiée (l'utilisateur vient de se
 * loguer dans le SPA).
 *
 * NB : la découverte RFC 8414 (`/.well-known/oauth-authorization-server`) est
 * servie **à la racine** (hors préfixe `api/v1`) — voir l'`exclude` dans
 * `main.ts`. Les autres routes restent sous `/api/v1/auth/oauth/*`.
 */
@ApiExcludeController()
@Controller()
@UseGuards(LoginEnabledGuard)
export class OAuthController {
  constructor(private readonly oauth: OAuthService) {}

  private origin(req: Request): string {
    const proto = (req.headers['x-forwarded-proto'] as string)?.split(',')[0] || req.protocol;
    return `${proto}://${req.headers.host}`;
  }

  // ---- Découverte (racine, hors préfixe) ----
  @Get('.well-known/oauth-authorization-server')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  metadata(@Req() req: Request) {
    return this.oauth.authorizationServerMetadata(this.origin(req));
  }

  // ---- DCR (RFC 7591) ----
  @Post('auth/oauth/register')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  register(@Body() body: { redirect_uris?: unknown; client_name?: unknown }) {
    return this.oauth.registerClient(body);
  }

  // ---- /authorize : valide puis renvoie vers l'écran de consentement du SPA ----
  @Get('auth/oauth/authorize')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async authorize(@Query() q: Record<string, string>, @Req() req: Request, @Res() res: Response) {
    const { tx } = await this.oauth.startAuthorization(q, this.origin(req));
    // Le SPA affiche le consentement (après login si besoin) puis appelle
    // POST /auth/oauth/consent, et redirige enfin le navigateur vers le client.
    return res.redirect(`${this.origin(req)}/oauth-consent?tx=${encodeURIComponent(tx)}`);
  }

  // ---- /consent-info : ce que l'écran de consentement doit afficher ----
  @Get('auth/oauth/consent-info')
  @UseGuards(JwtAuthGuard)
  consentInfo(@CurrentUser() user: AuthUser, @Query('tx') tx: string) {
    return this.oauth.consentInfo(user.orgId, tx);
  }

  // ---- /consent : utilisateur authentifié → émet le code d'autorisation ----
  @Post('auth/oauth/consent')
  @UseGuards(JwtAuthGuard)
  consent(
    @CurrentUser() user: AuthUser,
    @Body() body: { tx: string; approve: boolean },
  ) {
    return this.oauth.consent(
      { userId: user.userId, orgId: user.orgId },
      body.tx,
      body.approve === true,
    );
  }

  // ---- /token : échange code↔jeton, ou refresh ----
  @Post('auth/oauth/token')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  token(@Body() body: Record<string, string | undefined>, @Req() req: Request) {
    // Support `client_secret_basic` (Authorization: Basic base64(id:secret)) en
    // plus de `client_secret_post` (dans le body) — certains clients (Power
    // Platform / Copilot Studio) utilisent l'un ou l'autre.
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth.startsWith('Basic ')) {
      try {
        const [id, secret] = Buffer.from(auth.slice(6).trim(), 'base64').toString('utf8').split(':');
        if (id && !body.client_id) body.client_id = decodeURIComponent(id);
        if (secret && !body.client_secret) body.client_secret = decodeURIComponent(secret);
      } catch {
        /* en-tête Basic malformé : ignoré, on retombe sur le body */
      }
    }
    return this.oauth.token(body);
  }
}
