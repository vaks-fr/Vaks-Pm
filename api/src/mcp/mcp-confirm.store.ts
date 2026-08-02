import { Injectable, OnModuleDestroy, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import Redis from 'ioredis';
import { TenantContext } from '../tenancy/tenant-context.service';

/**
 * Durée de vie d'un défi de confirmation.
 *
 * 10 minutes et non 5 : un agent présente l'impact à un humain et attend sa
 * réponse ; 5 minutes expirent régulièrement en pleine conversation. C'est déjà
 * le `PENDING_TTL` d'`OAuthStoreService`, pour exactement la même raison (« un
 * humain lit un écran »).
 */
export const CONFIRM_TTL_SEC = 600;

/** Ce qu'un jeton de confirmation autorise, et pour qui. */
export interface ConfirmRecord {
  orgId: string;
  userId: string;
  /** Hash du bearer : un autre principal ne peut pas racheter ce jeton. */
  bearerHash: string;
  tool: string;
  /** Empreinte de l'action exacte (méthode + URL + corps canonique). */
  argsHash: string;
  impact: unknown;
  createdAt: number;
}

/**
 * Jetons de confirmation à **usage unique** pour les actions destructrices
 * demandées via MCP.
 *
 * Modelé sur `OAuthStoreService`, qui établit déjà l'idiome GETDEL anti-rejeu.
 *
 * ⚠️ **Fail-closed, contrairement au reste du codebase.** `CacheService` et
 * `ApiThrottlerGuard` sont fail-open et documentés comme tels : chez eux, un
 * hoquet Redis dégrade la performance. Ici il désactiverait **silencieusement un
 * contrôle de sécurité** — on préfère un 503 explicite à une suppression qui
 * passe sans confirmation. La divergence est délibérée.
 */
@Injectable()
export class McpConfirmStore implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService, private readonly tenant: TenantContext) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error(`[mcp-confirm] redis error: ${e.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  /** Le jeton n'est jamais stocké en clair : la clé porte son hash. */
  private key(token: string): string {
    const slug = this.tenant.currentSlug() ?? '_';
    return `mcp:confirm:${slug}:${createHash('sha256').update(token).digest('hex')}`;
  }

  /** Émet un jeton opaque lié à `rec`. Renvoie le secret (montré une seule fois). */
  async issue(rec: Omit<ConfirmRecord, 'createdAt'>): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    try {
      await this.redis.set(
        this.key(token),
        JSON.stringify({ ...rec, createdAt: Date.now() } satisfies ConfirmRecord),
        'EX',
        CONFIRM_TTL_SEC,
      );
    } catch {
      throw new ServiceUnavailableException(
        'Confirmation indisponible : le service de sécurité est momentanément injoignable.',
      );
    }
    return token;
  }

  /**
   * Consomme un jeton (GETDEL — un jeton ne sert qu'une fois, même si la
   * vérification échoue ensuite) et renvoie son contenu, ou `null` s'il est
   * inconnu/expiré.
   */
  async redeem(token: string): Promise<ConfirmRecord | null> {
    try {
      const raw = await this.redis.getdel(this.key(token));
      return raw ? (JSON.parse(raw) as ConfirmRecord) : null;
    } catch {
      throw new ServiceUnavailableException(
        'Confirmation indisponible : le service de sécurité est momentanément injoignable.',
      );
    }
  }
}
