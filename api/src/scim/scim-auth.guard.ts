import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { ApiTokensService } from '../api-tokens/api-tokens.service';
import { extractBearer, isApiToken } from '../auth/bearer.util';

/**
 * Authentifie la surface SCIM par **clé organisation** (`Authorization: Bearer
 * vaks_org_…`) portant le scope `scim:provision`. C'est le secret de
 * provisioning que l'IdP (Entra) présente. Aucune session JWT ici.
 *
 * SÉCURITÉ — clé ORG **obligatoire** : un PAT utilisateur (`vaks_pat_…`) est
 * refusé même s'il porte le scope. Ce contrôleur n'a pas de `PermissionsGuard`
 * (pas de RBAC par-dessus), et n'importe quel membre peut se frapper un PAT :
 * accepter un PAT ici donnerait à un simple MEMBER le pouvoir de suspendre /
 * supprimer / renommer l'email de n'importe quel compte, admins compris. Une
 * clé org, elle, n'est frappable que par un porteur de `org:manage`.
 *
 * Le tenant est déjà résolu par le `TenantMiddleware` (Host) → la recherche du
 * jeton tape la bonne base. Le scope `scim:provision` n'ouvre QUE `/scim/v2/*`.
 */
@Injectable()
export class ScimAuthGuard implements CanActivate {
  constructor(private readonly apiTokens: ApiTokensService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<Request & { user?: unknown }>();
    const raw = extractBearer(req);
    if (!isApiToken(raw)) throw new UnauthorizedException('Missing SCIM token');
    const principal = await this.apiTokens.verify(raw);
    if (!principal) throw new UnauthorizedException('Invalid or revoked SCIM token');
    if (!principal.isOrgToken) {
      throw new UnauthorizedException('SCIM requires an organization API key (user tokens are refused)');
    }
    if (!principal.tokenScopes?.includes('scim:provision')) {
      throw new UnauthorizedException('Token lacks the scim:provision scope');
    }
    req.user = principal;
    return true;
  }
}
