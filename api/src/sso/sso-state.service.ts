import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomBytes } from 'crypto';
import { OidcTransaction, SamlTransaction } from './sso.types';

/**
 * Stockage **Redis** des transactions OIDC en vol (entre `/start` et
 * `/callback`). Indispensable en multi-réplica : le `/start` et le `/callback`
 * peuvent tomber sur deux conteneurs API différents — un store en mémoire ne
 * marcherait pas.
 *
 * Le `state` (clé) est un secret aléatoire à usage unique : on le SUPPRIME à la
 * lecture (`consume`), ce qui sert d'anti-replay. Le `codeVerifier` PKCE et le
 * `nonce` restent ainsi côté serveur (jamais exposés au navigateur).
 */
@Injectable()
export class SsoStateService implements OnModuleDestroy {
  private readonly redis: Redis;
  private static readonly TTL_SEC = 600; // 10 min pour compléter le flow
  private static readonly PREFIX = 'sso:oidc:state:';
  private static readonly SAML_PREFIX = 'sso:saml:state:';

  constructor(config: ConfigService) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error(`[sso-state] redis error: ${e.message}`);
    });
  }

  /** Crée une transaction et renvoie le `state` opaque à passer à l'IdP. */
  async create(tx: Omit<OidcTransaction, 'createdAt'>): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const payload: OidcTransaction = { ...tx, createdAt: Date.now() };
    await this.redis.set(
      SsoStateService.PREFIX + state,
      JSON.stringify(payload),
      'EX',
      SsoStateService.TTL_SEC,
    );
    return state;
  }

  /** Lit ET supprime la transaction (usage unique). Null si inconnue/expirée. */
  async consume(state: string): Promise<OidcTransaction | null> {
    if (!state) return null;
    const key = SsoStateService.PREFIX + state;
    // GETDEL : lecture atomique + suppression (anti-replay).
    const raw = await this.redis.getdel(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OidcTransaction;
    } catch {
      return null;
    }
  }

  /** Crée une transaction SAML et renvoie le `RelayState` opaque (one-shot). */
  async createSaml(tx: Omit<SamlTransaction, 'createdAt'>): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const payload: SamlTransaction = { ...tx, createdAt: Date.now() };
    await this.redis.set(
      SsoStateService.SAML_PREFIX + state,
      JSON.stringify(payload),
      'EX',
      SsoStateService.TTL_SEC,
    );
    return state;
  }

  /** Lit ET supprime la transaction SAML (anti-replay). Null si inconnue/expirée. */
  async consumeSaml(state: string): Promise<SamlTransaction | null> {
    if (!state) return null;
    const raw = await this.redis.getdel(SsoStateService.SAML_PREFIX + state);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SamlTransaction;
    } catch {
      return null;
    }
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      /* ignore */
    }
  }
}
