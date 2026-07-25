import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { TenancyService } from './tenancy.service';
import { TenantConnectionService } from './tenant-connection.service';
import { TenantContext } from './tenant-context.service';

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
    if (!tenant) {
      // Appels internes worker→API (`/internal/…`, overlay-only, jamais routés
      // par Traefik) : pas de sous-domaine → on route via le header explicite
      // `X-Tenant-Slug` posé par le worker. Confiné aux routes internes pour ne
      // pas ouvrir un switch de base sur les routes publiques.
      const path = req.originalUrl || req.url || '';
      if (path.includes('/internal/')) {
        const hdr = req.headers['x-tenant-slug'];
        const slug = (Array.isArray(hdr) ? hdr[0] : hdr)?.trim();
        if (slug) tenant = { id: slug, slug };
      }
    }
    if (!tenant) {
      // Pas de sous-domaine tenant : on laisse passer sans contexte. Les routes
      // tenant échoueront proprement (ex. login → 401 côté controller).
      return next();
    }
    const client = this.conn.getClient(tenant);
    this.ctx.run({ client, slug: tenant.slug ?? tenant.id }, () => next());
  }
}
