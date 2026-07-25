import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Permission } from '@vaks-pm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

/**
 * Scopes d'écriture exposés via MCP (miroir de `OAuthService.WRITE_SCOPES`).
 * Sert au serveur MCP à **masquer** les tools d'écriture quand le jeton ne les
 * porte pas (org sans `mcp.allowWrites`) — plutôt que de lister des tools qui
 * échoueraient en 403.
 */
// `time:log` volontairement absent : il est aussi un scope de LECTURE (toujours
// accordé pour lire la timesheet) → l'inclure rendrait `write:true` en
// permanence. Le tool d'écriture `log_time` est gated par l'exposition (flag
// allowWrite dérivé d'ICI), pas par ce scope. Garder en phase avec
// `OAuthService.WRITE_SCOPES`.
const MCP_WRITE_SCOPES: Permission[] = [
  'project:create',
  'project:update',
  'task:create',
  'task:update',
  'allocation:manage',
  'comment:create',
  'finance:manage',
  'client:manage',
  'team:create',
  'team:manage_members',
  'project:assign_managers',
  'task:delete',
];

/**
 * Contexte du jeton pour le **serveur MCP** (phase 11). Appelé une fois par
 * requête MCP : (1) valide le jeton tôt (un 401 ici → le serveur MCP propage un
 * `WWW-Authenticate` pour re-déclencher le login du client IA), (2) renvoie les
 * scopes accordés → le serveur enregistre uniquement les tools que le jeton peut
 * réellement utiliser. Route **publique** (jeton `vaks_…`).
 *
 * NB RBAC : **pas** de `@RequirePermissions('mcp:access')` — `mcp:access` est un
 * *scope de jeton* (accordé au consentement), PAS une permission de rôle (elle
 * n'est dans aucun rôle tenant). L'exiger via `@RequirePermissions` la ferait
 * échouer pour tout non-admin (effectif PAT = rôle ∩ scopes). L'endpoint ne
 * révèle que la capacité du jeton appelant → `@PublicApi` suffit comme garde.
 */
@ApiTags('mcp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@PublicApi('mcp:access')
@Controller('me/mcp-context')
export class McpContextController {
  @Get()
  context(@CurrentUser() user: AuthUser) {
    const scopes = user.tokenScopes ?? [];
    return {
      scopes,
      write: MCP_WRITE_SCOPES.some((s) => scopes.includes(s)),
      // Nature du principal (chantier agents 1) : 'AGENT' quand le jeton est
      // porté par un compte agent (kind=AGENT) — permet au serveur MCP et aux
      // clients d'adapter leur comportement (ex. exiger une justification).
      actorKind: user.actorKind ?? 'HUMAN',
    };
  }
}
