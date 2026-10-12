import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenancyService } from './tenancy.service';
import { TenantConnectionService } from './tenant-connection.service';
import { TenantContext } from './tenant-context.service';

/** Préfixe des contrôleurs internes (worker→API), sous le préfixe global. */
const INTERNAL_PREFIX = '/api/v1/internal/';

/**
 * Vrai si la requête vise une route interne. On lit `originalUrl` (insensible
 * au point de montage du middleware) en retirant la query string : `?x=/internal/`
 * sur une route publique ne doit jamais matcher.
 */
export function isInternalRoute(req: Pick<Request, 'originalUrl' | 'url'>): boolean {
  const full = req.originalUrl || req.url || '';
  const path = full.split('?')[0];
  return path.startsWith(INTERNAL_PREFIX);
}

/**
 * Forme canonique d'un slug tenant (label DNS minuscule). Seule forme admise
 * pour dériver un nom de base `<db>_<slug>` — tout le reste est ignoré.
 */
export const TENANT_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function isValidTenantSlug(slug: string | null | undefined): slug is string {
  return typeof slug === 'string' && TENANT_SLUG_RE.test(slug);
}

/**
 * Pose le contexte tenant pour toute la requête (mode `pooled`) :
 * résout le tenant depuis le `Host`, ouvre/choisit le client de sa base, et
 * exécute le reste de la requête dans ce contexte (AsyncLocalStorage) → tous
 * les accès `PrismaService` en aval visent la base du tenant.
 *
 * En mode `dedicated` : no-op (le contexte reste vide → base globale).
 */
@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly ctx: TenantContext,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction) {
    if (this.tenancy.mode !== 'pooled') return next();

    let tenant = await this.tenancy.resolveFromHost(req.headers.host);
    if (!tenant && isInternalRoute(req)) {
      // Appels internes worker→API (`/api/v1/internal/…`, overlay-only, jamais
      // routés par Traefik) : pas de sous-domaine → on route via le header
      // explicite `X-Tenant-Slug` posé par le worker. Confiné aux routes
      // internes (préfixe exact, sans query string) pour ne pas ouvrir un switch
      // de base sur les routes publiques.
      const hdr = req.headers['x-tenant-slug'];
      const slug = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim().toLowerCase();
      if (slug && isValidTenantSlug(slug)) tenant = { id: slug, slug };
    }
    if (!tenant) {
      // Pas de sous-domaine tenant : on laisse passer sans contexte. Les routes
      // tenant échoueront proprement (ex. login → 401 côté controller).
      return next();
    }
    if (!isValidTenantSlug(tenant.slug ?? tenant.id)) {
      // Label Host exotique (caractères hors slug) : jamais de base dérivée
      // d'une valeur non validée (`..`, `/`, `%`…) — on continue sans contexte.
      return next();
    }
    const client = this.conn.getClient(tenant);
    this.ctx.run({ client, slug: tenant.slug ?? tenant.id }, () => next());
  }
}
