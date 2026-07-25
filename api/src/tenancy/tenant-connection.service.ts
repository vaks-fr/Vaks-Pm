import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@db';
import { makePgAdapter } from '../prisma/pg-adapter';
import { DeploymentMode, ResolvedTenant } from './tenancy.service';

interface PooledClient {
  client: PrismaClient;
  lastUsed: number;
}

/**
 * Résolveur de connexion DB par tenant — le point de bascule unique qui permet
 * une seule base de code pour les deux modèles de déploiement.
 *
 * - `dedicated` : 1 tenant/instance → la couche n'est pas utilisée (le
 *   middleware ne pose pas de contexte ; `PrismaService` reste sur la base
 *   globale). Comportement historique inchangé.
 * - `pooled` : `getClient(tenant)` renvoie le client Prisma de **la base du
 *   tenant** (`<db>_<slug>` sur le même cluster), créé paresseusement et caché.
 *
 * Convention de nommage : la base d'un tenant = la base de base (`DATABASE_URL`)
 * suffixée `_<slug>` (les `-` du slug deviennent `_`). Provisionnée à
 * l'onboarding par `prisma/provision-tenant.js`.
 *
 * **Bornage du pool** (sinon 1 client/pool pg par tenant gardé à vie = fuite de
 * connexions en SaaS multi-tenant) :
 *  - **Balayage TTL** : un sweeper périodique déconnecte les clients inactifs
 *    depuis `idleMs` — sûr (aucune requête en vol après ce délai).
 *  - **Plafond souple LRU** : au-delà de `maxClients`, on évince le moins
 *    récemment utilisé **uniquement s'il est lui-même inactif** (> `EVICT_GUARD_MS`) ;
 *    sinon on dépasse temporairement + log (jamais déconnecter un client actif).
 *  Réglable via env `TENANT_POOL_MAX` / `TENANT_POOL_IDLE_MS`.
 */
@Injectable()
export class TenantConnectionService implements OnModuleDestroy {
  private readonly log = new Logger(TenantConnectionService.name);
  private readonly pool = new Map<string, PooledClient>();

  /** Délai de grâce avant qu'un client LRU puisse être évincé sous pression. */
  private static readonly EVICT_GUARD_MS = 30_000;
  /** Cadence du balayage d'inactivité. */
  private static readonly SWEEP_MS = 60_000;

  private readonly maxClients: number;
  private readonly idleMs: number;
  private sweeper?: ReturnType<typeof setInterval>;

  constructor(private readonly config: ConfigService) {
    this.maxClients = Math.max(1, Number(process.env.TENANT_POOL_MAX) || 50);
    this.idleMs = Math.max(60_000, Number(process.env.TENANT_POOL_IDLE_MS) || 600_000);
  }

  get mode(): DeploymentMode {
    return this.config.get('deployment').mode;
  }

  /** Client de la base du tenant (mode pooled uniquement). */
  getClient(tenant: ResolvedTenant): PrismaClient {
    const url = this.databaseUrlFor(tenant);
    const now = Date.now();
    const existing = this.pool.get(url);
    if (existing) {
      existing.lastUsed = now;
      return existing.client;
    }
    if (this.pool.size >= this.maxClients) this.evictLruIfIdle(now);
    const client = new PrismaClient({ adapter: makePgAdapter(url) });
    this.pool.set(url, { client, lastUsed: now });
    this.ensureSweeper();
    this.log.log(`Client tenant "${tenant.slug}" créé (cache: ${this.pool.size})`);
    return client;
  }

  /** URL de la base d'un tenant, par convention `<db>_<slug>`. */
  databaseUrlFor(tenant: ResolvedTenant): string {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error('DATABASE_URL manquant');
    const u = new URL(base);
    const dbName = (u.pathname.replace(/^\//, '') || 'vakspm');
    const suffix = (tenant.slug ?? tenant.id).replace(/-/g, '_');
    u.pathname = `/${dbName}_${suffix}`;
    return u.toString();
  }

  /** Déconnecte+retire une entrée du pool (best-effort, async non-bloquant). */
  private drop(url: string, entry: PooledClient, reason: string): void {
    this.pool.delete(url);
    entry.client.$disconnect().catch(() => undefined);
    this.log.log(`Client tenant déconnecté (${reason}) — cache: ${this.pool.size}`);
  }

  /** Sous pression de plafond : évince le LRU s'il est lui-même inactif. */
  private evictLruIfIdle(now: number): void {
    let lruUrl: string | undefined;
    let lru: PooledClient | undefined;
    for (const [url, entry] of this.pool) {
      if (!lru || entry.lastUsed < lru.lastUsed) {
        lru = entry;
        lruUrl = url;
      }
    }
    if (lruUrl && lru && now - lru.lastUsed > TenantConnectionService.EVICT_GUARD_MS) {
      this.drop(lruUrl, lru, 'plafond LRU');
    } else {
      this.log.warn(
        `Pool tenant au plafond (${this.pool.size}/${this.maxClients}) mais tous les clients sont actifs — dépassement temporaire.`,
      );
    }
  }

  /** Démarre le balayage d'inactivité au premier client (unref = ne bloque pas l'arrêt). */
  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweepIdle(), TenantConnectionService.SWEEP_MS);
    this.sweeper.unref?.();
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [url, entry] of this.pool) {
      if (now - entry.lastUsed > this.idleMs) this.drop(url, entry, 'inactivité');
    }
    if (this.pool.size === 0 && this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
  }

  async onModuleDestroy() {
    if (this.sweeper) {
      clearInterval(this.sweeper);
      this.sweeper = undefined;
    }
    for (const { client } of this.pool.values()) {
      await client.$disconnect().catch(() => undefined);
    }
    this.pool.clear();
  }
}
