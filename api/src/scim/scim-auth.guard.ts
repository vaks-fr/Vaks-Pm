import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTokensService } from '../api-tokens/api-tokens.service';

/**
 * Authentifie la surface SCIM par **jeton d'API** (`Authorization: Bearer vaks_…`)
 * portant le scope `scim:provision`. Pensé pour une **clé organisation** que
 * l'IdP (Entra) utilise comme secret de provisioning. Aucune session JWT ici.
 *
 * Le tenant est déjà résolu par le `TenantMiddleware` (Host) → la recherche du
 * jeton tape la bonne base. Le scope `scim:provision` n'ouvre QUE `/scim/v2/*`.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly apiTokens: ApiTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const auth = req.headers['authorization'];
    const raw =
      typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!raw) throw new UnauthorizedException('Missing SCIM token');
    const principal = await this.apiTokens.verify(raw);
    if (!principal) throw new UnauthorizedException('Invalid or revoked SCIM token');
    if (!principal.tokenScopes?.includes('scim:provision')) {
      throw new UnauthorizedException('Token lacks the scim:provision scope');
    }
    req.user = principal;
    return true;
  }
}
