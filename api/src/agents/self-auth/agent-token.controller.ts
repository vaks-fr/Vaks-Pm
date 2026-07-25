import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { AgentSelfAuthService } from './agent-self-auth.service';

/**
 * Auto-authentification des agents headless — **surface distincte de l'AS OAuth**.
 *
 * Volontairement hors de `/auth/oauth/*` : cette route sert les AGENTS qui se
 * gèrent seuls (refresh rotatif → jeton court), jamais les humains via
 * navigateur. Pas de consentement, pas d'`OAuthConnection`, pas de session
 * utilisateur — le refresh présenté EST l'authentification.
 *
 * **Servie par le DATA-PLANE** (contrairement à l'AS OAuth humain, sur le
 * control-plane) : l'agent s'authentifie là où il travaille. Cette séparation
 * physique renforce la frontière délégation-humaine ↔ auto-service-agent. Donc
 * PAS de `LoginEnabledGuard` (qui 404 les routes d'auth sur le data-plane) : le
 * refresh présenté fait foi, et la route est bornée par un rate-limit.
 * `@ApiExcludeController` : hors OpenAPI public.
 */
@ApiExcludeController()
@Controller('agents')
export class AgentTokenController {
  constructor(private readonly selfAuth: AgentSelfAuthService) {}

  @Post('token')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  token(@Body() body: Record<string, string | undefined>) {
    if (body?.grant_type !== 'refresh_token') {
      // Format d'erreur OAuth 2.0 (RFC 6749) : les clients machine l'attendent.
      throw new BadRequestException({
        error: 'unsupported_grant_type',
        error_description: "Seul grant_type=refresh_token est supporté sur /agents/token.",
      });
    }
    return this.selfAuth.exchange(body.refresh_token, body.scope);
  }
}
