import { ExecutionContext, Injectable, Logger } from '@nestjs/common';
import { ThrottlerException, ThrottlerGuard, ThrottlerRequest } from '@nestjs/throttler';
import { createHash } from 'crypto';
import type { Request } from 'express';

const int = (v: string | undefined, def: number): number => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};

/**
 * Paliers de rate-limit (req / fenêtre). Surchargables par variables d'env.
 * Source de vérité unique, importée aussi par `ThrottlerModule.forRoot`.
 */
export const RL = {
  /** Fenêtre glissante en ms (commune à tous les paliers). */
  windowMs: int(process.env.RL_WINDOW_MS, 60_000),
  /** Filet par IP, par route (sessions UI + anonyme). Inchangé vs historique. */
  ip: int(process.env.RL_IP_LIMIT, 600),
  /** PAT utilisateur (`vaks_pat_…`) : budget global du jeton, toutes routes confondues. */
  pat: int(process.env.RL_PAT_LIMIT, 300),
  /** Clé organisation (`vaks_org_…`) : identité service, budget plus large. */
  org: int(process.env.RL_ORG_LIMIT, 1200),
} as const;

/** Nom du throttler dédié aux jetons d'API (cf. app.module). */
export const TOKEN_THROTTLER = 'token';

interface BearerToken {
  hash: string;
  isOrg: boolean;
}

/** Extrait le jeton `vaks_…` du header Authorization, sans lookup DB. */
function bearerToken(req: Request): BearerToken | null {
  const auth = req.headers['authorization'];
  const raw = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!raw || !raw.startsWith('vaks_')) return null;
  // On bucket par hash du secret : identité stable du jeton, jamais le clair en clé Redis.
  return { hash: createHash('sha256').update(raw).digest('hex').slice(0, 32), isOrg: raw.startsWith('vaks_org_') };
}

/**
 * Rate-limit distribué (Redis), conscient des jetons d'API.
 *
 * Deux throttlers s'appliquent :
 *  - `default` : filet **par IP, par route** (comportement historique, désormais
 *    partagé entre réplicas via Redis — plus de compteur ×3 réinitialisé au déploiement).
 *  - `token`   : budget **global par jeton** (org vs PAT), uniquement quand un
 *    `Bearer vaks_…` est présent — donc, de fait, sur l'API publique seule
 *    (les jetons sont déjà gated `@PublicApi`). Lu sur le header brut, donc
 *    indépendant de l'ordre des guards (s'exécute avant `JwtAuthGuard`).
 *
 * Fail-open : une panne du store Redis ne doit jamais bloquer l'API (Redis est
 * déjà une dépendance critique ; on log et on laisse passer).
 */
@Injectable()
export class ApiThrottlerGuard extends ThrottlerGuard {
  private readonly rlLog = new Logger(ApiThrottlerGuard.name);

  /** Tracker du throttler `default` : IP cliente (vraie IP derrière Traefik). */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const r = req as unknown as Request;
    const ips = r.ips;
    return ips && ips.length ? ips[0] : (r.ip ?? 'unknown');
  }

  /**
   * Clé Redis. Pour le throttler `token`, on ignore classe/handler → un seul
   * seau par jeton, tous endpoints confondus (budget global). Pour `default`,
   * comportement par défaut (par route + IP), pour préserver les @Throttle
   * spécifiques (ex. /auth/login).
   */
  protected generateKey(context: ExecutionContext, suffix: string, name: string): string {
    if (name === TOKEN_THROTTLER) {
      const tok = bearerToken(context.switchToHttp().getRequest<Request>());
      return `vaks-rl:token:${tok?.hash ?? 'none'}`;
    }
    return super.generateKey(context, suffix, name);
  }

  protected async handleRequest(props: ThrottlerRequest): Promise<boolean> {
    const isTokenThrottler = props.throttler.name === TOKEN_THROTTLER;
    if (isTokenThrottler) {
      const tok = bearerToken(props.context.switchToHttp().getRequest<Request>());
      // Pas de jeton → ce throttler ne s'applique pas (sessions/anonyme = palier IP).
      if (!tok) return true;
      props = { ...props, limit: tok.isOrg ? RL.org : RL.pat };
    }
    try {
      return await super.handleRequest(props);
    } catch (e) {
      // Limite dépassée → on laisse remonter le 429 (avec headers RateLimit-*).
      if (e instanceof ThrottlerException) throw e;
      // Sinon le store (Redis) a flanché : fail-open plutôt que de tomber l'API.
      this.rlLog.error(`rate-limit store error (fail-open): ${(e as Error).message}`);
      return true;
    }
  }
}
