import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash } from 'crypto';
import { TenantContext } from '../tenancy/tenant-context.service';

/**
 * Cache court-terme (Redis) pour les endpoints agrégés lourds (KPI portefeuille,
 * grille workload, rapports) qui recalculent tout à chaque requête. TTL court
 * (30 s par défaut) : la péremption est invisible à l'échelle d'un dashboard et
 * évite de construire une invalidation explicite.
 *
 * **Fail-open** : toute erreur Redis (panne, timeout) ⇒ on calcule directement.
 * Le cache ne doit JAMAIS casser une requête ni servir un résultat périmé
 * indéfiniment (`enableOfflineQueue:false` + `maxRetriesPerRequest:1` ⇒ échec
 * rapide quand Redis est indisponible, pas de hang).
 *
 * **Cloisonnement** : la clé est préfixée par le slug du tenant (Redis partagé
 * en mode pooled). ⚠️ Les `parts` fournies par l'appelant DOIVENT inclure
 * l'orgId ET — si le résultat est filtré RBAC par appelant (scope projet/équipe)
 * — l'userId de l'appelant, sinon fuite cross-user. Voir les call-sites.
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService, private readonly tenant: TenantContext) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error(`[cache] redis error: ${e.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  /** Clé namespacée par tenant : `cache:<slug>:<sha des parts>`. */
  private key(parts: Array<string | number | boolean | null | undefined>): string {
    const slug = this.tenant.currentSlug() ?? '_';
    const raw = parts.map((p) => String(p ?? '')).join('|');
    return `cache:${slug}:${createHash('sha256').update(raw).digest('hex').slice(0, 40)}`;
  }

  /**
   * Renvoie la valeur cachée pour `parts`, sinon exécute `fn`, la met en cache
   * (`ttlSec` secondes) et la renvoie. La valeur transite par JSON — n'utiliser
   * que pour des DTO terminaux sérialisables (mêmes types qu'une réponse HTTP).
   */
  async wrap<T>(
    parts: Array<string | number | boolean | null | undefined>,
    ttlSec: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const k = this.key(parts);
    try {
      const hit = await this.redis.get(k);
      if (hit != null) return JSON.parse(hit) as T;
    } catch {
      /* fail-open read: Redis KO ⇒ on calcule */
    }
    const val = await fn();
    try {
      await this.redis.set(k, JSON.stringify(val), 'EX', ttlSec);
    } catch {
      /* fail-open write */
    }
    return val;
  }
}
