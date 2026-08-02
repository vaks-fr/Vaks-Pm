import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { TenantContext } from '../tenancy/tenant-context.service';

/** Fenêtre de comptage (secondes). Fixe, alignée sur celle du rate-limit. */
export const MCP_USAGE_WINDOW_SEC = 60;

/** Compteur d'un tool sur la fenêtre courante. */
export interface McpToolCount {
  tool: string;
  count: number;
}

/**
 * Compteurs d'usage **par tool MCP**, en Redis.
 *
 * Comble un angle mort : on savait ce qu'un agent COÛTE (budgets € et tokens via
 * `AgentRun`), pas ce qu'il FAIT. Un agent parti en boucle qui appelle
 * `vaks_list_projects` 4 000 fois reste invisible tant que le budget € ne
 * bouge pas — les lectures ne consomment presque rien.
 *
 * Deux usages distincts et volontairement séparés :
 *  - **compteur** (`hit`) : incrémenté à chaque appel, y compris en lecture ;
 *  - **quota** : décidé par l'appelant à partir du compteur renvoyé.
 *
 * ⚠️ **Fail-open assumé** : toute erreur Redis renvoie `-1` et l'appelant laisse
 * passer. C'est un contrôle d'**équité**, pas de sécurité — à l'inverse du
 * garde-fou de confirmation, qui est fail-closed. L'asymétrie est délibérée :
 * ici une panne Redis ne doit pas bloquer le travail, là elle ne doit pas
 * désactiver silencieusement une protection.
 *
 * Fenêtre **fixe** (pas glissante) : une rafale à cheval sur deux fenêtres peut
 * passer jusqu'à 2× le quota. `ApiThrottlerGuard` a la même propriété ; c'est
 * acceptable pour de l'équité et ça évite un ZSET par jeton et par tool.
 */
@Injectable()
export class McpToolUsageService implements OnModuleDestroy {
  private readonly redis: Redis;
  private static readonly PREFIX = 'vaks-mcpq';

  constructor(config: ConfigService, private readonly tenant: TenantContext) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error(`[mcp-usage] redis error: ${e.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  /** Début de la fenêtre courante (epoch en secondes, aligné). */
  private windowEpoch(): number {
    return Math.floor(Date.now() / 1000 / MCP_USAGE_WINDOW_SEC) * MCP_USAGE_WINDOW_SEC;
  }

  private slug(): string {
    return this.tenant.currentSlug() ?? '_';
  }

  /**
   * Incrémente le compteur `(jeton, tool)` de la fenêtre courante et renvoie sa
   * nouvelle valeur. `-1` si Redis est indisponible (l'appelant laisse passer).
   *
   * `tokenHash` est un **hash** du bearer : jamais le jeton en clair dans une
   * clé Redis (même règle que `ApiThrottlerGuard`).
   */
  async hit(tokenHash: string, tool: string): Promise<number> {
    const k = `${McpToolUsageService.PREFIX}:${this.slug()}:${tokenHash}:${tool}:${this.windowEpoch()}`;
    try {
      const n = await this.redis.incr(k);
      // EXPIRE seulement au premier incrément : inutile de le repousser ensuite,
      // la fenêtre est fixe et la clé doit mourir avec elle.
      if (n === 1) await this.redis.expire(k, MCP_USAGE_WINDOW_SEC * 2);
      return n;
    } catch {
      return -1;
    }
  }

  /**
   * Usage agrégé **par tool** sur la fenêtre courante, tous jetons confondus,
   * pour le tenant courant. Vue « ce qui se passe maintenant ».
   *
   * Complète l'historique déjà disponible dans le journal d'audit (qui porte
   * `mcpTool` dans son `detail`) — mais celui-ci **sous-compte les lectures**,
   * seules les mutations et les GET `@Audited` y étant capturées. D'où cette
   * vue temps réel à côté.
   */
  async currentWindow(): Promise<McpToolCount[]> {
    const pattern = `${McpToolUsageService.PREFIX}:${this.slug()}:*:*:${this.windowEpoch()}`;
    const byTool = new Map<string, number>();
    try {
      let cursor = '0';
      let guard = 0;
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        if (keys.length) {
          const vals = await this.redis.mget(...keys);
          keys.forEach((k, i) => {
            // `<prefix>:<slug>:<tokenHash>:<tool>:<window>` — ni le slug, ni le
            // hash, ni le nom de tool ne contiennent de « : ».
            const parts = k.split(':');
            const tool = parts[parts.length - 2] ?? '?';
            byTool.set(tool, (byTool.get(tool) ?? 0) + Number(vals[i] ?? 0));
          });
        }
        // Garde-fou : SCAN peut boucler longtemps sur un keyspace très large.
      } while (cursor !== '0' && ++guard < 200);
    } catch {
      return [];
    }
    return [...byTool.entries()]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool));
  }
}
