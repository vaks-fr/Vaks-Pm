import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Permission } from '@vaks-pm/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PublicApi } from '../rbac/require-permissions.decorator';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { CacheService } from '../common/cache.service';

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
 * n'est dans aucun rôle tenant) NI un gate vérifié au runtime (cf. commentaire
 * `PERMISSIONS` côté shared : l'accès MCP est gouverné par licence + toggle +
 * révocation de connexion, pas par ce scope). L'exiger via `@RequirePermissions`
 * la ferait échouer pour tout non-admin (effectif PAT = rôle ∩ scopes).
 *
 * ⚠️ **Cet endpoint GATE l'accès MCP**, il ne se contente plus de le décrire.
 * C'est le seul point traversé par CHAQUE requête MCP, quelle que soit la porte
 * par laquelle le jeton a été obtenu : consentement OAuth, PAT fabriqué à la
 * main dans les réglages de compte (`POST /me/api-tokens`, sans permission
 * requise), ou clé org. Le toggle `mcp.enabled` est donc relu **ici**, et pas
 * seulement dans `OAuthService.consent` qui ne garde que l'ÉMISSION — ce qui
 * laissait les connexions déjà établies se renouveler indéfiniment après
 * désactivation, et n'opposait jamais rien à un PAT fabriqué à la main (MCP
 * fonctionnait même sur un tenant où le connecteur n'a jamais été activé).
 */
@ApiTags('mcp')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@PublicApi('mcp:access')
@Controller('me/mcp-context')
export class McpContextController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly cache: CacheService,
  ) {}

  @Get()
  async context(@CurrentUser() user: AuthUser) {
    // Kill switch org, relu à chaque requête MCP (cf. en-tête de classe).
    // Cache court : ce handler est sur le chemin chaud (un appel par tool call)
    // et `getMcpEnabled` fait un `findUnique` non caché — sans cache on ajoutait
    // une lecture DB par appel d'outil. `wrap` retombe sur la source autoritaire
    // quand Redis est KO, donc le gate tient même cache indisponible. TTL 30 s =
    // latence de coupure au pire, acceptable pour un interrupteur d'admin.
    const mcpEnabled = await this.cache.wrap([user.orgId, 'mcp.enabled'], 30, () =>
      this.settings.getMcpEnabled(user.orgId),
    );
    if (!mcpEnabled) {
      // 403 et non 401 : se reconnecter n'y changerait rien, c'est une décision
      // de l'organisation. Le serveur MCP rend ce cas en échec dur, là où un 401
      // relancerait en boucle le flux d'autorisation.
      throw new ForbiddenException(
        "Le connecteur IA (MCP) est désactivé pour votre organisation. Contactez votre administrateur.",
      );
    }

    const scopes = user.tokenScopes ?? [];
    // Langue de l'utilisateur : le serveur MCP en a besoin pour servir les
    // libellés de prompts et demander une réponse dans la bonne langue. Elle ne
    // vit ni dans le JWT ni dans `AuthUser` → une lecture ciblée. `null` =
    // l'utilisateur suit le défaut de l'org (le serveur MCP retombera sur EN).
    // Best-effort : une langue manquante ne doit pas faire échouer le handshake.
    let preferredLanguage: string | null = null;
    try {
      const row = await this.prisma.user.findUnique({
        where: { id: user.userId },
        select: { preferredLanguage: true },
      });
      preferredLanguage = row?.preferredLanguage ?? null;
    } catch {
      preferredLanguage = null;
    }
    return {
      scopes,
      write: MCP_WRITE_SCOPES.some((s) => scopes.includes(s)),
      // Nature du principal (chantier agents 1) : 'AGENT' quand le jeton est
      // porté par un compte agent (kind=AGENT) — permet au serveur MCP et aux
      // clients d'adapter leur comportement (ex. exiger une justification).
      actorKind: user.actorKind ?? 'HUMAN',
      preferredLanguage,
    };
  }
}
