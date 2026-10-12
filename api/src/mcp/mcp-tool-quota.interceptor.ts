import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { extractBearer } from '../auth/bearer.util';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { ModuleRef } from '@nestjs/core';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { CacheService } from '../common/cache.service';
import { McpToolUsageService, MCP_USAGE_WINDOW_SEC } from './mcp-tool-usage.service';
// Type-only (erased à la compilation) + token string : aucun import de VALEUR
// de `AgentRunsService` → l'intercepteur ne tire pas `@db` dans ses tests isolés.
import type { AgentRunsService } from '../agent-runs/agent-runs.service';
import { LAZY_AGENT_RUNS } from '../agent-runs/agent-runs.tokens';

const MCP_TOOL_HEADER = 'x-vaks-mcp-tool';

/**
 * Compte les appels par tool MCP et applique les quotas optionnels de l'org.
 *
 * ⚠️ **Intercepteur et non guard, délibérément.** Un `APP_GUARD` global
 * s'exécute AVANT les guards de contrôleur — or `JwtAuthGuard` est posé par
 * contrôleur, donc `req.user` n'existe pas encore à ce moment et on ne pourrait
 * résoudre ni l'org ni le tenant. Les intercepteurs, eux, tournent APRÈS tous
 * les guards : `req.user` est posé, le RBAC a déjà statué. C'est le seul endroit
 * global où un quota **par organisation** est résoluble.
 *
 * ⚠️ **`ApiThrottlerGuard` n'est pas touché** et ne doit pas l'être : il tourne
 * volontairement pré-auth (il dérive l'identité du bearer brut, sans lookup DB),
 * donc il ne peut pas lire un `OrgSetting`. Son palier par jeton reste le
 * plafond anti-abus ; ce qu'on ajoute ici est une granularité **par tool**, qui
 * répond à une autre question : non pas « ce jeton tape-t-il trop ? » mais
 * « que fait-il, et faut-il borner tel outil en particulier ? ».
 *
 * N'agit que sur le trafic MCP : il faut un jeton d'API **et** l'en-tête
 * `X-Vaks-Mcp-Tool` (posé par le serveur MCP). Les sessions navigateur et les
 * PAT nus ne sont ni comptés ni bornés.
 */
@Injectable()
export class McpToolQuotaInterceptor implements NestInterceptor {
  constructor(
    private readonly settings: AdminSettingsService,
    private readonly usage: McpToolUsageService,
    private readonly cache: CacheService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** `AgentRunsService` en lazy (token string) — persistance du meter à chaque appel. */
  private agentRuns(): AgentRunsService | null {
    try {
      return this.moduleRef.get<AgentRunsService>(LAZY_AGENT_RUNS, { strict: false });
    } catch {
      return null;
    }
  }

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<
      Request & {
        user?: { orgId?: string; viaApiToken?: boolean; userId?: string; actorKind?: string };
      }
    >();
    const user = req.user;

    // Hors trafic MCP authentifié par jeton : on ne compte rien.
    if (!user?.viaApiToken || !user.orgId) return next.handle();
    const raw = req.headers[MCP_TOOL_HEADER];
    const tool = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!tool) return next.handle();
    // Un nom de tool inattendu ne doit pas fabriquer des clés Redis arbitraires.
    if (!/^[a-z0-9_/:-]{1,80}$/i.test(tool)) return next.handle();

    // Même extracteur que JwtAuthGuard : un PAT via X-Api-Key (Copilot Studio)
    // doit être compté (meter crédits) et soumis aux quotas comme les autres.
    const bearer = extractBearer(req);
    if (!bearer) return next.handle();
    // Même dérivation d'identité que `ApiThrottlerGuard` : jamais le clair en clé.
    const tokenHash = createHash('sha256').update(bearer).digest('hex').slice(0, 32);

    // Les tools MCP fusionnés transmettent un identifiant composite
    // `tool:action` (ex. `vaks_teams_manage:add_member`). Le **compteur
    // d'usage et le quota de base** portent sur le nom de base : un quota posé
    // sur `vaks_teams_manage` couvre la somme de ses actions (et la vue admin
    // « tool usage » garde une ligne par tool, pas par action).
    const base = tool.split(':', 1)[0];

    // Meter de coût des agents crédits (Copilot) : Microsoft facture CHAQUE appel
    // d'outil (lectures comprises). Le crédit est consommé À LA RÉCEPTION de
    // l'appel → on compte ET on persiste ICI, pas à un point de passage ultérieur
    // (submit/heartbeat) qui peut échouer ou ne jamais arriver.
    //
    // `accrue` incrémente le compteur Redis (gratuit), puis `persistMeteredRun`
    // recalcule la ligne `AgentRun` metered depuis le total cumulé (upsert
    // idempotent). Tout en **fire-and-forget** : la chaîne tourne hors du chemin
    // de la requête, l'appel métier n'est jamais retardé. `persistMeteredRun`
    // s'auto-gate (no-op si l'agent n'est pas en crédits, ou toggle off).
    if (user.actorKind === 'AGENT' && user.userId) {
      const uuidHeader = (h: string): string | null => {
        const raw = req.headers[h];
        const v = (Array.isArray(raw) ? raw[0] : raw)?.trim();
        // Un en-tête libre ne doit pas fabriquer de clé Redis arbitraire.
        return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null;
      };
      const agentId = user.userId;
      const orgId = user.orgId;
      const scope = {
        taskId: uuidHeader('x-vaks-task-id'),
        projectId: uuidHeader('x-vaks-project-id'),
      };
      // accrue PUIS persist : la ligne reflète le compteur fraîchement incrémenté.
      void this.usage
        .accrue(agentId, scope)
        .then(() => this.agentRuns()?.persistMeteredRun(orgId, agentId, scope))
        .catch(() => undefined);
    }

    const n = await this.usage.hit(tokenHash, base);
    if (n < 0) return next.handle(); // Redis KO ⇒ fail-open (équité, pas sécurité)

    // Cache court : une boucle MCP chaude ne doit pas ajouter une lecture DB par
    // appel. La clé porte l'orgId (cloisonnement exigé par CacheService).
    const quotas = await this.cache.wrap([user.orgId, 'mcp.toolQuotas'], 30, () =>
      this.settings.getMcpToolQuotas(user.orgId!),
    );

    const res = ctx.switchToHttp().getResponse<Response>();
    // Message volontairement distinct de celui du throttler : en support, il
    // faut pouvoir dire lequel des deux plafonds a parlé. Traduit par
    // `ExceptionI18nFilter` (source française + placeholders `{}`).
    const reject = (name: string, limit: number): never => {
      res.setHeader('Retry-After', String(MCP_USAGE_WINDOW_SEC));
      throw new HttpException(
        `Quota de l'outil « ${name} » atteint pour cette organisation (${limit} appels/minute).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    };

    const baseLimit = quotas[base] ?? quotas['*'];
    if (baseLimit != null && baseLimit > 0 && n > baseLimit) reject(base, baseLimit);

    // Quota ciblé sur une action précise (`vaks_teams_manage:remove_member`) :
    // compteur dédié, seulement quand un tel quota est configuré (pas un
    // deuxième INCR sur tout le trafic).
    if (tool !== base) {
      const actionLimit = quotas[tool];
      if (actionLimit != null && actionLimit > 0) {
        const na = await this.usage.hit(tokenHash, tool);
        if (na > actionLimit) reject(tool, actionLimit);
      }
    }
    return next.handle();
  }
}
