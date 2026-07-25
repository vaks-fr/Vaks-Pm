import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { AdminSettingsService } from '../admin/admin-settings.service';

/**
 * Porte d'accès finance pour les **jetons d'API / IA** (phase 11).
 *
 * Les endpoints finance sont marqués `@PublicApi('finance:view')` pour pouvoir
 * être atteints par un jeton (MCP / PAT / clé org), MAIS la finance est
 * sensible : ce guard ne les laisse passer QUE si l'org a activé le toggle
 * admin `mcp.allowFinance`. Les sessions navigateur (JWT) ne sont jamais
 * affectées — l'app montre la finance aux rôles habilités comme avant.
 *
 * À placer APRÈS `JwtAuthGuard`/`PermissionsGuard` (req.user posé, RBAC vérifié).
 */
@Injectable()
export class FinanceApiGateGuard implements CanActivate {
  constructor(private readonly settings: AdminSettingsService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const user = req.user;
    // Sessions navigateur (JWT) : toujours autorisées.
    if (!user?.viaApiToken) return true;
    const all = await this.settings.getAll(user.orgId);
    if (all['mcp.allowFinance'] === true) return true;
    throw new ForbiddenException(
      "L'accès aux données financières via jeton d'API / IA n'est pas activé pour cette organisation.",
    );
  }
}
