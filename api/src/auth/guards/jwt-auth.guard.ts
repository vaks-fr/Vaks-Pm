import { ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { ApiTokensService } from '../../api-tokens/api-tokens.service';
import { PUBLIC_API_KEY } from '../../rbac/require-permissions.decorator';
import { SEAT_EXEMPT_KEY } from '../seat-exempt.decorator';

/**
 * Authentification : soit un JWT (session utilisateur, via passport-jwt), soit
 * un **jeton d'API** (`Authorization: Bearer vaks_…`).
 *
 * Un jeton d'API n'est accepté QUE sur les routes marquées `@PublicApi`
 * (l'API publique). Sur une route app-privée → refus (les jetons ne peuvent
 * pas piloter l'admin / l'auth / la plomberie UI).
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private readonly apiTokens: ApiTokensService,
    private readonly reflector: Reflector,
  ) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request>();
    const auth = req.headers['authorization'];
    const raw = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;

    if (raw && raw.startsWith('vaks_')) {
      const principal = await this.apiTokens.verify(raw);
      if (!principal) throw new UnauthorizedException('Jeton API invalide ou révoqué');
      // Gate : un jeton API n'agit que sur l'API publique (`@PublicApi`).
      const isPublic = this.reflector.getAllAndOverride(PUBLIC_API_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);
      if (!isPublic) {
        throw new ForbiddenException("Ce point d'accès n'est pas ouvert aux jetons d'API.");
      }
      (req as Request & { user: unknown }).user = principal;
      return true;
    }

    // Sinon : JWT classique (passport).
    const ok = (await super.canActivate(context)) as boolean;
    if (ok) this.enforceSeat(context, req);
    return ok;
  }

  /**
   * **Frontière de siège de licence.** Un principal JWT dont le compte est
   * `licensed=false` (admin-only ou parqué) n'a PAS accès au dashboard : on ne
   * le laisse passer que sur une route `@SeatExempt` (identité / gestion de son
   * compte / état de licence) ou — s'il est admin — sur le portail admin
   * (`/admin/*`). Tout le reste → 403. Les jetons d'API (gérés plus haut) ne
   * sont pas concernés : ils n'agissent que sur l'API publique, pas le dashboard.
   */
  private enforceSeat(context: ExecutionContext, req: Request): void {
    const user = (req as Request & { user?: { licensed?: boolean; isAdmin?: boolean } }).user;
    // `licensed !== false` : licencié, ou token legacy (claim absent) → on laisse.
    if (!user || user.licensed !== false) return;

    const exempt = this.reflector.getAllAndOverride<boolean>(SEAT_EXEMPT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exempt) return;

    // Admin sans siège (admin-only) : autorisé sur le portail admin uniquement.
    const path = req.path || req.url || '';
    if (user.isAdmin && path.includes('/admin/')) return;

    throw new ForbiddenException(
      'Aucun siège de licence attribué à ce compte : accès limité au portail d’administration. ' +
        'Contactez un administrateur pour obtenir un siège.',
    );
  }
}
