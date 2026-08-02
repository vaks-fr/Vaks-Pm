import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request, Response } from 'express';
import { Observable } from 'rxjs';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { CacheService } from '../common/cache.service';
import { McpToolUsageService, MCP_USAGE_WINDOW_SEC } from './mcp-tool-usage.service';

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
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: { orgId?: string; viaApiToken?: boolean } }>();
    const user = req.user;

    // Hors trafic MCP authentifié par jeton : on ne compte rien.
    if (!user?.viaApiToken || !user.orgId) return next.handle();
    const raw = req.headers[MCP_TOOL_HEADER];
    const tool = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!tool) return next.handle();
    // Un nom de tool inattendu ne doit pas fabriquer des clés Redis arbitraires.
    if (!/^[a-z0-9_/:-]{1,80}$/i.test(tool)) return next.handle();

    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
    if (!bearer) return next.handle();
    // Même dérivation d'identité que `ApiThrottlerGuard` : jamais le clair en clé.
    const tokenHash = createHash('sha256').update(bearer).digest('hex').slice(0, 32);

    const n = await this.usage.hit(tokenHash, tool);
    if (n < 0) return next.handle(); // Redis KO ⇒ fail-open (équité, pas sécurité)

    // Cache court : une boucle MCP chaude ne doit pas ajouter une lecture DB par
    // appel. La clé porte l'orgId (cloisonnement exigé par CacheService).
    const quotas = await this.cache.wrap([user.orgId, 'mcp.toolQuotas'], 30, () =>
      this.settings.getMcpToolQuotas(user.orgId!),
    );
    const limit = quotas[tool] ?? quotas['*'];
    if (limit == null || limit <= 0) return next.handle();

    if (n > limit) {
      const res = ctx.switchToHttp().getResponse<Response>();
      res.setHeader('Retry-After', String(MCP_USAGE_WINDOW_SEC));
      // Message volontairement distinct de celui du throttler : en support, il
      // faut pouvoir dire lequel des deux plafonds a parlé. Traduit par
      // `ExceptionI18nFilter` (source française + placeholders `{}`).
      throw new HttpException(
        `Quota de l'outil « ${tool} » atteint pour cette organisation (${limit} appels/minute).`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return next.handle();
  }
}
