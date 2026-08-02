import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { createHash } from 'crypto';
import type { Request } from 'express';
import { Observable } from 'rxjs';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { McpConfirmStore, CONFIRM_TTL_SEC } from './mcp-confirm.store';
import { argsHash, requiresConfirmation, type ConfirmPolicy } from './mcp-confirm-scope';

const MCP_TOOL_HEADER = 'x-vaks-mcp-tool';
const CONFIRM_TOKEN_HEADER = 'x-vaks-confirm-token';

interface McpUser {
  userId?: string;
  orgId?: string;
  email?: string;
  viaApiToken?: boolean;
  /** Nature du principal : seul un humain (HUMAN) est concerné par le garde-fou. */
  actorKind?: 'HUMAN' | 'AGENT';
  agentOwnerId?: string;
}

/**
 * Garde-fou de confirmation des actions destructrices demandées via MCP.
 *
 * Aujourd'hui une IA qui appelle « supprime ce client » l'exécute, point : rien
 * ne s'intercale entre l'intention et l'effet. Ce garde-fou impose un
 * aller-retour — le premier appel est refusé avec un défi, et l'agent doit
 * **re-formuler explicitement** son intention en rappelant le tool avec le
 * jeton. C'est ce second passage qui donne à l'agent (et à l'humain derrière)
 * l'occasion de s'arrêter.
 *
 * Le motif existait déjà en dur pour un seul cas (`plan_project_preview` puis
 * `_apply`) ; on le généralise au lieu de le refaire tool par tool.
 *
 * ⚠️ **Intercepteur et non guard** : un `APP_GUARD` global tourne avant les
 * guards de contrôleur, or `JwtAuthGuard` est posé par contrôleur — `req.user`
 * n'existerait pas encore. Voir aussi `McpToolQuotaInterceptor`.
 *
 * ⚠️ **Le jeton voyage en en-tête**, jamais dans le corps : les routes DELETE
 * n'ont pas de corps, et injecter un champ dans les corps POST/PATCH
 * collisionnerait avec la whitelist de validation de chaque DTO. En en-tête,
 * **zéro DTO à modifier dans toute l'API**.
 *
 * Les sessions navigateur ne sont jamais concernées : il faut un jeton d'API ET
 * l'en-tête `X-Vaks-Mcp-Tool` (que l'UI web n'envoie pas).
 */
@Injectable()
export class McpConfirmInterceptor implements NestInterceptor {
  constructor(
    private readonly settings: AdminSettingsService,
    private readonly store: McpConfirmStore,
    private readonly audit: AuditLogService,
  ) {}

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Request & { user?: McpUser }>();
    const user = req.user;
    if (!user?.viaApiToken || !user.orgId || !user.userId) return next.handle();

    // ⚠️ Le garde-fou ne concerne QUE l'utilisateur humain qui pilote un
    // assistant IA (Claude Desktop, ChatGPT…) — le « MCP user ». C'est un
    // contrôle **avec humain dans la boucle** : le défi n'a de sens que si
    // quelqu'un peut le voir et l'approuver. Un agent autonome (kind=AGENT)
    // travaille sans humain au moment de l'appel — il ne ferait que rappeler le
    // tool avec le jeton lui-même, une friction qu'il lève seul, sans valeur de
    // sécurité. La gouvernance des agents est ailleurs (moteur de policies,
    // budgets, capabilities, revue des livrables) et bien plus stricte : la
    // plupart de ces mêmes actions destructrices leur sont déjà interdites au
    // niveau RBAC (finance, clients, temps, membres d'équipe…).
    if (user.actorKind === 'AGENT') return next.handle();

    const rawTool = req.headers[MCP_TOOL_HEADER];
    const tool = (Array.isArray(rawTool) ? rawTool[0] : rawTool)?.trim();
    if (!tool) return next.handle();

    const method = req.method.toUpperCase();
    const isWrite = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    if (!isWrite) return next.handle();

    const policy = (await this.settings.getMcpConfirmPolicy(user.orgId)) as ConfirmPolicy;
    if (!requiresConfirmation(policy, tool, isWrite)) return next.handle();

    const auth = req.headers['authorization'];
    const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const bearerHash = createHash('sha256').update(bearer).digest('hex').slice(0, 32);
    const hash = argsHash(method, req.originalUrl, req.body);

    const rawTok = req.headers[CONFIRM_TOKEN_HEADER];
    const presented = (Array.isArray(rawTok) ? rawTok[0] : rawTok)?.trim();

    if (presented) {
      // GETDEL : le jeton est consommé même si la vérification échoue ensuite —
      // pas de tâtonnement possible sur un jeton volé.
      const rec = await this.store.redeem(presented);
      const ok =
        !!rec &&
        rec.orgId === user.orgId &&
        rec.userId === user.userId &&
        rec.bearerHash === bearerHash &&
        rec.tool === tool &&
        rec.argsHash === hash;
      if (ok) return next.handle();

      this.audit.log({
        organizationId: user.orgId,
        action: 'mcp.confirm_rejected',
        severity: 'WARNING',
        outcome: 'FAILURE',
        actorType: 'AGENT',
        actorId: user.userId,
        actorLabel: user.email ?? null,
        route: req.originalUrl,
        method,
        detail: {
          tool,
          // Pourquoi le refus, sans jamais journaliser le jeton lui-même.
          reason: !rec ? 'unknown_or_expired' : rec.tool !== tool ? 'tool_mismatch' : 'args_or_principal_mismatch',
          ...(user.agentOwnerId ? { ownerId: user.agentOwnerId } : {}),
        },
      });
      throw new ConflictException({
        code: 'CONFIRMATION_INVALID',
        message:
          'Jeton de confirmation invalide, expiré ou déjà utilisé. Relancez l’action pour obtenir un nouveau défi.',
      });
    }

    // --- Pas de jeton : on émet le défi ---
    const impact = {
      tool,
      method,
      path: req.originalUrl,
      target: targetOf(req),
    };
    const token = await this.store.issue({
      orgId: user.orgId,
      userId: user.userId,
      bearerHash,
      tool,
      argsHash: hash,
      impact,
    });

    this.audit.log({
      organizationId: user.orgId,
      action: 'mcp.confirm_challenged',
      severity: 'WARNING',
      outcome: 'SUCCESS',
      actorType: 'AGENT',
      actorId: user.userId,
      actorLabel: user.email ?? null,
      route: req.originalUrl,
      method,
      detail: { tool, ...(user.agentOwnerId ? { ownerId: user.agentOwnerId } : {}) },
    });

    /**
     * `ExceptionI18nFilter` étale l'objet et ne traduit que `message` : les
     * champs supplémentaires (`code`, `confirmToken`, `impact`…) survivent tels
     * quels. L'impact reste **structuré** plutôt que rédigé, précisément pour
     * qu'il n'y ait pas de prose non traduite à côté d'un message traduit.
     */
    throw new ConflictException({
      code: 'CONFIRMATION_REQUIRED',
      message: `Confirmation requise pour « ${tool} ». Rappelez ce tool avec le jeton fourni pour l’exécuter.`,
      confirmToken: token,
      expiresInSec: CONFIRM_TTL_SEC,
      impact,
    });
  }
}

/**
 * Cible de l'action, telle qu'on peut la déduire **sans requête** : dernier
 * segment d'URL non-verbal + libellé si le corps en porte un.
 *
 * Volontairement pauvre. Calculer les vraies cascades de suppression serait un
 * travail par modèle, subtil à rendre exact, et d'une valeur faible ici : le but
 * du défi est de faire re-formuler l'intention, pas de produire un diff
 * d'audit. Un « ceci supprime définitivement la tâche “Foo” » suffit à ça.
 */
function targetOf(req: Request): { type: string | null; id: string | null; label: string | null } {
  const segs = req.path.split('/').filter(Boolean);
  // …/tasks/<id> ou …/tasks/<id>/sub → on remonte au dernier couple type/id.
  let type: string | null = null;
  let id: string | null = null;
  for (let i = segs.length - 1; i >= 1; i--) {
    if (/^[0-9a-f-]{8,}$/i.test(segs[i])) {
      id = segs[i];
      type = segs[i - 1] ?? null;
      break;
    }
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const label =
    typeof body.name === 'string'
      ? body.name
      : typeof body.title === 'string'
        ? body.title
        : null;
  return { type, id, label };
}
