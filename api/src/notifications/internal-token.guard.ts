import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

/**
 * Guard pour les endpoints internes appelés par le worker BullMQ. Valide un
 * header `X-Worker-Token` comparé à la variable d'env `WORKER_API_TOKEN`
 * (montée comme Swarm secret, partagée entre API et worker).
 *
 * Ces endpoints ne sont JAMAIS exposés à l'extérieur via Traefik — ils sont
 * uniquement accessibles sur le réseau overlay Swarm interne (DNS `api:3000`).
 * Le token est une seconde barrière au cas où.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private static warned = false;

  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.WORKER_API_TOKEN;
    if (!expected) {
      // FAIL CLOSED : sans token configuré on REFUSE l'accès (auparavant
      // `return true`, ce qui exposait les endpoints internes si le secret
      // n'était pas monté — fix sécurité P1). Le token est monté comme Swarm
      // secret `worker_api_token` sur api + worker ; son absence est une
      // erreur de configuration, pas un mode dégradé acceptable.
      if (!InternalTokenGuard.warned) {
        console.error('[InternalTokenGuard] WORKER_API_TOKEN not set — internal endpoints DENIED (fail-closed)');
        InternalTokenGuard.warned = true;
      }
      throw new UnauthorizedException('Internal endpoint unavailable');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const got = req.headers['x-worker-token'];
    if (got !== expected) throw new UnauthorizedException('Invalid worker token');
    return true;
  }
}
