import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import {
  AuditActorType,
  AuditEntryInput,
  AuditLogService,
  AuditSeverity,
} from './audit-log.service';
import { AUDITED_KEY, AuditedMeta, SKIP_AUDIT_KEY } from './audited.decorator';
import {
  deriveAction,
  identityFrom,
  lastParamValue,
  shouldCaptureRead,
  type AuditReadMode,
} from './audit-derive';
import { AdminSettingsService } from '../admin/admin-settings.service';

/** Préfixes de routes jamais capturés par la couverture générique. */
const EXCLUDED_PREFIXES = [
  '/api/v1/admin/audit-logs', // anti-boucle : lire le journal ne le remplit pas
  '/api/v1/audit-logs', // idem pour la lecture publique SIEM (évite que le poll s'auto-journalise en mode 'all')
  '/api/v1/internal/', // callbacks worker (déjà tracés à la source)
  '/api/v1/auth/', // bodies avec mots de passe — couverts par hooks explicites
  '/health',
];

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** TTL du cache mémoire (par process) du mode `audit.logReads`, par org.
 *  L'interceptor est GLOBAL : ce mode est consulté sur CHAQUE GET. On le résout
 *  au plus une fois par org et par fenêtre — jamais de Redis/DB sur le hot path
 *  des lectures (et pas d'amplification en tempête si le tier cache/DB tombe). */
const READ_MODE_TTL_MS = 30_000;

/** Première valeur d'un header (Express peut renvoyer un tableau). */
function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' && v.trim() ? v : undefined;
}

/**
 * Header posé par le serveur MCP sur chaque requête relayée → marque l'origine
 * « agent IA » pour un jeton HUMAIN piloté par IA. Fallback seulement : quand le
 * porteur du jeton est lui-même un compte agent (`kind=AGENT`), l'actorType
 * AGENT est dérivé du **principal** (non spoofable), pas du header.
 */
const AGENT_HEADER = 'x-vaks-agent';
/** Justification en langage naturel posée par le serveur MCP (tools d'écriture). */
const JUSTIFICATION_HEADER = 'x-vaks-justification';
/** Nom du tool MCP à l'origine de l'appel (contexte d'audit). */
const MCP_TOOL_HEADER = 'x-vaks-mcp-tool';
/**
 * Client IA d'origine (Claude Desktop, Copilot Studio, ChatGPT…), relayé par le
 * serveur MCP depuis le `User-Agent` entrant. Comble le dernier trou de la
 * chaîne de traçabilité : on savait déjà QUEL agent, POUR QUI et POURQUOI, mais
 * pas DEPUIS QUOI.
 *
 * ⚠️ Déclaratif, comme `justification` : c'est le client qui s'annonce, rien ne
 * l'authentifie. Utile pour comprendre et corréler, jamais comme contrôle.
 */
const MCP_CLIENT_HEADER = 'x-vaks-mcp-client';
/** Taille max de la justification conservée dans `detail` (anti-abus). */
const JUSTIFICATION_MAX = 1000;

/**
 * Vrai si l'erreur est un défi du garde-fou de confirmation MCP (409 avec un
 * `code` `CONFIRMATION_*`). Ces cas sont déjà tracés explicitement par le
 * `McpConfirmInterceptor` (`mcp.confirm_challenged`/`_rejected`) — on évite ici
 * de les re-journaliser en mutation échouée.
 */
function isConfirmationChallenge(err: unknown): boolean {
  const e = err as { getStatus?: () => number; getResponse?: () => unknown };
  if (typeof e?.getStatus !== 'function' || e.getStatus() !== 409) return false;
  const body = typeof e.getResponse === 'function' ? e.getResponse() : undefined;
  const code = (body as { code?: unknown })?.code;
  return code === 'CONFIRMATION_REQUIRED' || code === 'CONFIRMATION_INVALID';
}

interface ReqUser {
  userId?: string;
  orgId?: string;
  email?: string | null;
  viaApiToken?: boolean;
  isOrgToken?: boolean;
  /** Nature du principal (jetons API) : HUMAN | AGENT — dérivée en base. */
  actorKind?: string;
  /** Owner humain de l'agent (kind=AGENT) — tracé dans chaque entrée. */
  agentOwnerId?: string;
}

/**
 * Couverture d'audit générique : toute mutation HTTP (POST/PUT/PATCH/DELETE)
 * authentifiée est journalisée (action dérivée de la route, ou curée via
 * `@Audited`). Les GET ne sont capturés QUE si `@Audited` est posé, OU si
 * l'org a activé `audit.logReads` (mode `agents`/`all` — couverture forensic
 * optionnelle, cf. `shouldCaptureRead`). Fire-and-forget : `audit.log()`
 * bufferise, zéro latence ajoutée.
 */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  /** Cache mémoire process du mode `audit.logReads` par org (TTL court). */
  private readonly readModeCache = new Map<string, { mode: AuditReadMode; exp: number }>();

  constructor(
    private readonly audit: AuditLogService,
    private readonly reflector: Reflector,
    private readonly settings: AdminSettingsService,
  ) {}

  /**
   * Mode `audit.logReads` de l'org, mis en cache en mémoire (TTL court). Zéro
   * I/O sur le hot path : au plus une lecture de setting par org et par fenêtre.
   * **Fail-safe** : toute erreur de résolution ⇒ `'off'` mis en cache (on ne
   * capture pas, et on n'insiste pas — pas de tempête de lectures si la DB blip).
   */
  private async readModeFor(orgId: string): Promise<AuditReadMode> {
    const now = Date.now();
    const hit = this.readModeCache.get(orgId);
    if (hit && hit.exp > now) return hit.mode;
    let mode: AuditReadMode = 'off';
    try {
      mode = await this.settings.getAuditLogReadsMode(orgId);
    } catch {
      mode = 'off';
    }
    this.readModeCache.set(orgId, { mode, exp: now + READ_MODE_TTL_MS });
    return mode;
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request & { user?: ReqUser }>();
    const res = context.switchToHttp().getResponse<Response>();

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const meta = this.reflector.getAllAndOverride<AuditedMeta | undefined>(AUDITED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const method = req.method.toUpperCase();
    // Une lecture (GET sans @Audited) n'est plus jetée d'office : elle peut
    // être capturée selon `audit.logReads` (voir plus bas), après le filtrage
    // des préfixes exclus et la résolution de l'org.
    const isRead = !meta && !MUTATION_METHODS.has(method);

    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    if (!meta && EXCLUDED_PREFIXES.some((p) => path.startsWith(p))) return next.handle();

    const user = req.user;
    // Pas d'org résolue = rien à journaliser (routes anonymes type health).
    const orgId = user?.orgId;
    if (!orgId) return next.handle();

    if (isRead) {
      const isAgentPrincipal = !!user?.viaApiToken && user?.actorKind === 'AGENT';
      // Mode résolu depuis un cache mémoire process (zéro I/O sur le hot path).
      const mode = await this.readModeFor(orgId);
      if (!shouldCaptureRead(mode, isAgentPrincipal)) return next.handle();
    }

    const base = this.buildEntry(req, meta, method, orgId, user, isRead);

    // Le handler s'exécute dans un scope ALS : les services métier peuvent y
    // déposer un diff lisible via `audit.enrichRequest(...)` (ex. tasks.update)
    // qui sera fusionné dans `detail.changes` de l'entrée.
    return new Observable<unknown>((sub) => {
      this.audit.runWithRequestScope(() => {
        next
          .handle()
          .pipe(
            tap((body) => {
              // Post-état : l'id (création) et le libellé lisible de la réponse
              // priment sur ceux dérivés de la requête.
              const resp = identityFrom(body);
              const changes = this.audit.consumeRequestEnrichment();
              const detail =
                changes && base.detail && typeof base.detail === 'object'
                  ? { ...(base.detail as object), changes }
                  : changes
                    ? { changes }
                    : base.detail;
              this.audit.log({
                ...base,
                detail,
                statusCode: res.statusCode ?? 200,
                resourceId:
                  method === 'POST'
                    ? resp.id ?? base.resourceId ?? null
                    : base.resourceId ?? resp.id ?? null,
                resourceLabel: resp.label ?? base.resourceLabel ?? null,
              });
            }),
            catchError((err: unknown) => {
              const status =
                typeof (err as { getStatus?: () => number }).getStatus === 'function'
                  ? (err as { getStatus: () => number }).getStatus()
                  : 500;
              // Le défi du garde-fou de confirmation MCP (409 CONFIRMATION_*) est
              // déjà tracé explicitement (`mcp.confirm_challenged`/`_rejected`).
              // Ne pas le re-journaliser ici en « mutation échouée » : ce n'est
              // pas un échec de l'action, juste sa mise en attente de confirmation
              // — sinon un simple delete produit deux lignes trompeuses.
              if (!isConfirmationChallenge(err)) {
                this.audit.log({
                  ...base,
                  outcome: 'FAILURE',
                  statusCode: status,
                  severity: status === 401 || status === 403 ? 'WARNING' : base.severity,
                });
              }
              return throwError(() => err);
            }),
          )
          .subscribe(sub);
      });
    });
  }

  private buildEntry(
    req: Request & { user?: ReqUser },
    meta: AuditedMeta | undefined,
    method: string,
    orgId: string,
    user: ReqUser,
    isRead: boolean,
  ): AuditEntryInput {
    const rawPath = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const routePattern = (req.route as { path?: string } | undefined)?.path ?? rawPath;
    const params = (req.params ?? {}) as Record<string, string>;

    const derived = deriveAction(routePattern, method);
    // Une lecture capturée (mode `audit.logReads`) est préfixée `read.` :
    // filtrable via l'index (org,action,createdAt) existant, distinguable
    // d'une mutation, sans ajouter de colonne.
    const action = isRead ? `read.${meta?.action ?? derived.action}` : meta?.action ?? derived.action;
    const resourceType = meta?.resource ?? derived.resource;
    // resourceId : param explicite (@Audited) → sinon le DERNIER `:param` de la
    // route (l'entité visée, quel que soit son nom : skillId, teamId, …). L'`id`
    // de la réponse (création) est ajouté ensuite dans le `tap`.
    const resourceId =
      (meta?.idParam ? params[meta.idParam] : undefined) ??
      lastParamValue(routePattern, params) ??
      null;

    // Origine de l'acteur. Priorité au **principal** : un compte agent
    // (`kind=AGENT`, dérivé en base par api-tokens.verify) est AGENT quoi qu'il
    // arrive — non spoofable. Le header `X-Vaks-Agent` reste le fallback pour un
    // humain dont le PAT est piloté via le serveur MCP (l'appel est
    // agent-originé, pas le jeton). Script API brut = API_TOKEN ; session = USER.
    const isAgentPrincipal = user.viaApiToken && user.actorKind === 'AGENT';
    const viaAgentHeader = user.viaApiToken && !!req.headers[AGENT_HEADER];
    const actorType: AuditActorType = isAgentPrincipal || viaAgentHeader
      ? 'AGENT'
      : user.viaApiToken
        ? 'API_TOKEN'
        : 'USER';
    const severity: AuditSeverity = meta?.severity ?? 'INFO';

    // Body sanitizé pour les mutations JSON ; jamais le contenu d'un upload.
    const contentType = String(req.headers['content-type'] ?? '');
    let detail = contentType.includes('multipart/form-data')
      ? ({ multipart: true } as Record<string, unknown>)
      : method !== 'DELETE' && req.body && Object.keys(req.body as object).length
        ? { ...(req.body as Record<string, unknown>) }
        : undefined;

    // Contexte agent : owner responsable + justification en langage naturel +
    // tool MCP d'origine — fusionnés dans `detail` (redaction/cap 8 KB hérités).
    if (actorType === 'AGENT') {
      const justification = firstHeader(req.headers[JUSTIFICATION_HEADER]);
      const mcpTool = firstHeader(req.headers[MCP_TOOL_HEADER]);
      const mcpClient = firstHeader(req.headers[MCP_CLIENT_HEADER]);
      detail = {
        ...(detail ?? {}),
        ...(user.agentOwnerId ? { ownerId: user.agentOwnerId } : {}),
        ...(justification ? { justification: justification.slice(0, JUSTIFICATION_MAX) } : {}),
        ...(mcpTool ? { mcpTool: mcpTool.slice(0, 200) } : {}),
        ...(mcpClient ? { mcpClient: mcpClient.slice(0, 200) } : {}),
      };
      if (Object.keys(detail).length === 0) detail = undefined;
    }

    const xff = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim() || req.ip;

    return {
      organizationId: orgId,
      action,
      severity,
      actorType,
      actorId: user.userId ?? null,
      actorLabel: user.email ?? (user.isOrgToken ? 'org-token' : null),
      resourceType,
      resourceId,
      // Libellé lisible déjà disponible côté requête (création/édition) ; le
      // post-état de la réponse prime et est appliqué dans le `tap`.
      resourceLabel: identityFrom(req.body).label ?? null,
      route: routePattern,
      method,
      ip,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined,
      detail,
    };
  }

}
