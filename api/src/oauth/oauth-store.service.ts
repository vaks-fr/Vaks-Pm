import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomBytes } from 'crypto';
import {
  AuthorizationCode,
  OAuthClient,
  OAuthConnection,
  PendingAuthorization,
  RefreshRecord,
} from './oauth.types';

/**
 * Stockage **Redis** des artefacts OAuth (multi-réplica : `/authorize`,
 * `/consent` et `/token` peuvent tomber sur des conteneurs API différents).
 * Mirroir de `SsoStateService` : les secrets one-shot (codes, pending) sont lus
 * en `GETDEL` (anti-replay), et restent côté serveur.
 *
 * Tenant : on **préfixe toutes les clés par le slug** du tenant pour cloisonner
 * les artefacts entre orgs sur le Redis partagé (mode pooled).
 */
@Injectable()
export class OAuthStoreService implements OnModuleDestroy {
  private readonly redis: Redis;
  private static readonly PENDING_TTL = 600; // 10 min pour se loguer + consentir
  private static readonly CODE_TTL = 60; // 1 min entre /consent et /token
  private static readonly REFRESH_TTL = 30 * 24 * 3600; // 30 jours
  private static readonly CLIENT_TTL = 90 * 24 * 3600; // 90 jours (DCR)
  /**
   * TTL d'un client DCR JAMAIS utilisé (aucun code échangé). La route
   * d'enregistrement est publique : sans ce TTL court, des enregistrements
   * jetables occupaient le plafond par tenant pendant 90 j (verrouillage du
   * DCR pour tous). Promu au TTL plein au premier échange de code.
   */
  private static readonly UNUSED_CLIENT_TTL = 3600; // 1 h

  constructor(config: ConfigService) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error(`[oauth-store] redis error: ${e.message}`);
    });
  }

  private key(scope: string, slug: string | undefined, id: string): string {
    return `oauth:${scope}:${slug ?? '_'}:${id}`;
  }

  static sha256(s: string): string {
    return createHash('sha256').update(s).digest('hex');
  }

  // ---------- Clients (DCR) ----------

  /**
   * Enregistre un client DCR **dans la limite de `max` clients vivants par
   * tenant**. Route publique (RFC 7591, relayée par la DMZ) : sans plafond,
   * chaque appel posait une clé Redis de 90 j sur le Redis partagé → croissance
   * mémoire illimitée. Index = sorted set (score = expiration), purgé des
   * entrées expirées à chaque enregistrement. Renvoie false si plafond atteint.
   */
  async saveClientCapped(slug: string | undefined, client: OAuthClient, max: number): Promise<boolean> {
    const idx = this.key('clientidx', slug, 'all');
    const now = Date.now();
    await this.redis.zremrangebyscore(idx, 0, now);
    if ((await this.redis.zcard(idx)) >= max) return false;
    // Enregistré « à l'essai » (1 h) : ne compte durablement dans le plafond
    // qu'une fois utilisé (`promoteClient`).
    await this.redis.set(
      this.key('client', slug, client.clientId),
      JSON.stringify(client),
      'EX',
      OAuthStoreService.UNUSED_CLIENT_TTL,
    );
    await this.redis
      .multi()
      .zadd(idx, now + OAuthStoreService.UNUSED_CLIENT_TTL * 1000, client.clientId)
      .expire(idx, OAuthStoreService.CLIENT_TTL)
      .exec();
    return true;
  }

  /** Premier échange de code réussi : le client DCR passe au TTL plein (90 j). */
  async promoteClient(slug: string | undefined, clientId: string): Promise<void> {
    await this.redis
      .multi()
      .expire(this.key('client', slug, clientId), OAuthStoreService.CLIENT_TTL)
      // XX : ne met à jour que si l'entrée existe (jamais d'ajout ici).
      .zadd(this.key('clientidx', slug, 'all'), 'XX', Date.now() + OAuthStoreService.CLIENT_TTL * 1000, clientId)
      .exec();
  }

  async saveClient(slug: string | undefined, client: OAuthClient): Promise<void> {
    await this.redis.set(
      this.key('client', slug, client.clientId),
      JSON.stringify(client),
      'EX',
      OAuthStoreService.CLIENT_TTL,
    );
  }

  async getClient(slug: string | undefined, clientId: string): Promise<OAuthClient | null> {
    const raw = await this.redis.get(this.key('client', slug, clientId));
    return raw ? (JSON.parse(raw) as OAuthClient) : null;
  }

  // ---------- Clients PRÉ-ENREGISTRÉS (admin, durables) ----------
  // Namespace distinct des clients DCR + AUCUNE expiration (ils survivent aux
  // redémarrages via le volume Redis ; supprimés uniquement par révocation).

  async savePreClient(slug: string | undefined, client: OAuthClient): Promise<void> {
    await this.redis.set(this.key('preclient', slug, client.clientId), JSON.stringify(client));
  }

  async getPreClient(slug: string | undefined, clientId: string): Promise<OAuthClient | null> {
    const raw = await this.redis.get(this.key('preclient', slug, clientId));
    return raw ? (JSON.parse(raw) as OAuthClient) : null;
  }

  async deletePreClient(slug: string | undefined, clientId: string): Promise<number> {
    const n = await this.redis.del(this.key('preclient', slug, clientId));
    // Marqueur de révocation (durée de vie max d'un refresh) : les clients DCR
    // portent le même préfixe `vaks_mcpc_` — on ne peut donc PAS déduire la
    // révocation de l'absence du client, il faut la noter explicitement.
    if (n > 0) {
      await this.redis.set(this.key('preclient-revoked', slug, clientId), '1', 'EX', OAuthStoreService.REFRESH_TTL);
    }
    return n;
  }

  async isPreClientRevoked(slug: string | undefined, clientId: string): Promise<boolean> {
    return (await this.redis.exists(this.key('preclient-revoked', slug, clientId))) === 1;
  }

  async listPreClients(slug: string | undefined): Promise<OAuthClient[]> {
    const match = this.key('preclient', slug, '*');
    const out: OAuthClient[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 200);
      cursor = next;
      if (keys.length) {
        const vals = await this.redis.mget(keys);
        for (const v of vals) if (v) out.push(JSON.parse(v) as OAuthClient);
      }
    } while (cursor !== '0');
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  // ---------- Pending authorization (avant consentement) ----------

  async createPending(
    slug: string | undefined,
    p: Omit<PendingAuthorization, 'createdAt'>,
  ): Promise<string> {
    const tx = randomBytes(32).toString('base64url');
    const payload: PendingAuthorization = { ...p, createdAt: Date.now() };
    await this.redis.set(
      this.key('pending', slug, tx),
      JSON.stringify(payload),
      'EX',
      OAuthStoreService.PENDING_TTL,
    );
    return tx;
  }

  async consumePending(
    slug: string | undefined,
    tx: string,
  ): Promise<PendingAuthorization | null> {
    if (!tx) return null;
    const raw = await this.redis.getdel(this.key('pending', slug, tx));
    return raw ? (JSON.parse(raw) as PendingAuthorization) : null;
  }

  /** Lit SANS consommer (pour l'écran de consentement, avant l'approbation). */
  async peekPending(
    slug: string | undefined,
    tx: string,
  ): Promise<PendingAuthorization | null> {
    if (!tx) return null;
    const raw = await this.redis.get(this.key('pending', slug, tx));
    return raw ? (JSON.parse(raw) as PendingAuthorization) : null;
  }

  // ---------- Authorization code (one-shot) ----------

  async createCode(
    slug: string | undefined,
    c: Omit<AuthorizationCode, 'createdAt'>,
  ): Promise<string> {
    const code = randomBytes(32).toString('base64url');
    const payload: AuthorizationCode = { ...c, createdAt: Date.now() };
    await this.redis.set(
      this.key('code', slug, code),
      JSON.stringify(payload),
      'EX',
      OAuthStoreService.CODE_TTL,
    );
    return code;
  }

  async consumeCode(slug: string | undefined, code: string): Promise<AuthorizationCode | null> {
    if (!code) return null;
    const raw = await this.redis.getdel(this.key('code', slug, code));
    return raw ? (JSON.parse(raw) as AuthorizationCode) : null;
  }

  // ---------- Refresh tokens (rotation) ----------

  /** Stocke un refresh et renvoie le secret en clair (jamais persisté en clair). */
  async createRefresh(
    slug: string | undefined,
    r: Omit<RefreshRecord, 'createdAt'>,
  ): Promise<string> {
    const secret = `vaks_rt_${randomBytes(40).toString('base64url')}`;
    const payload: RefreshRecord = { ...r, createdAt: Date.now() };
    await this.redis.set(
      this.key('refresh', slug, OAuthStoreService.sha256(secret)),
      JSON.stringify(payload),
      'EX',
      OAuthStoreService.REFRESH_TTL,
    );
    return secret;
  }

  /** Lit ET supprime un refresh (rotation = anti-replay). */
  /** Lecture SANS consommation : permet d'authentifier le client AVANT de
   *  brûler le refresh (un secret erroné ne doit pas tuer la chaîne). */
  async peekRefresh(slug: string | undefined, secret: string): Promise<RefreshRecord | null> {
    if (!secret) return null;
    const raw = await this.redis.get(this.key('refresh', slug, OAuthStoreService.sha256(secret)));
    return raw ? (JSON.parse(raw) as RefreshRecord) : null;
  }

  async consumeRefresh(
    slug: string | undefined,
    secret: string,
  ): Promise<RefreshRecord | null> {
    if (!secret) return null;
    const raw = await this.redis.getdel(
      this.key('refresh', slug, OAuthStoreService.sha256(secret)),
    );
    return raw ? (JSON.parse(raw) as RefreshRecord) : null;
  }

  // ---------- Connexions IA (stables, listables/révocables) ----------

  private userConnKey(slug: string | undefined, userId: string): string {
    return `oauth:userconn:${slug ?? '_'}:${userId}`;
  }

  async createConnection(
    slug: string | undefined,
    data: { userId: string; orgId: string; clientId: string; clientName: string },
  ): Promise<string> {
    const connId = randomBytes(18).toString('base64url');
    const now = Date.now();
    const conn: OAuthConnection = { connId, ...data, createdAt: now, lastUsedAt: now };
    await this.redis.set(
      this.key('conn', slug, connId),
      JSON.stringify(conn),
      'EX',
      OAuthStoreService.REFRESH_TTL,
    );
    await this.redis.sadd(this.userConnKey(slug, data.userId), connId);
    return connId;
  }

  async getConnection(slug: string | undefined, connId: string): Promise<OAuthConnection | null> {
    if (!connId) return null;
    const raw = await this.redis.get(this.key('conn', slug, connId));
    return raw ? (JSON.parse(raw) as OAuthConnection) : null;
  }

  /** Bumpe lastUsedAt + prolonge la durée de vie (idle 30 j → expiration). */
  async touchConnection(slug: string | undefined, connId: string): Promise<void> {
    const conn = await this.getConnection(slug, connId);
    if (!conn) return;
    conn.lastUsedAt = Date.now();
    await this.redis.set(
      this.key('conn', slug, connId),
      JSON.stringify(conn),
      'EX',
      OAuthStoreService.REFRESH_TTL,
    );
  }

  /** Enregistre l'id du PAT actif sur la connexion (pour pouvoir le révoquer
   *  immédiatement à la déconnexion). Préserve le TTL idle 30 j. */
  async setConnectionToken(
    slug: string | undefined,
    connId: string,
    tokenId: string,
  ): Promise<void> {
    const conn = await this.getConnection(slug, connId);
    if (!conn) return;
    conn.tokenId = tokenId;
    await this.redis.set(
      this.key('conn', slug, connId),
      JSON.stringify(conn),
      'EX',
      OAuthStoreService.REFRESH_TTL,
    );
  }

  async listConnections(slug: string | undefined, userId: string): Promise<OAuthConnection[]> {
    const ids = await this.redis.smembers(this.userConnKey(slug, userId));
    if (!ids.length) return [];
    const raws = await this.redis.mget(ids.map((id) => this.key('conn', slug, id)));
    const out: OAuthConnection[] = [];
    const stale: string[] = [];
    ids.forEach((id, i) => {
      const raw = raws[i];
      if (raw) out.push(JSON.parse(raw) as OAuthConnection);
      else stale.push(id); // record expiré : on purge l'index paresseusement
    });
    if (stale.length) await this.redis.srem(this.userConnKey(slug, userId), ...stale);
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Révoque UNE connexion (casse la chaîne de refresh : voir refreshGrant). */
  async deleteConnection(slug: string | undefined, userId: string, connId: string): Promise<boolean> {
    const n = await this.redis.del(this.key('conn', slug, connId));
    await this.redis.srem(this.userConnKey(slug, userId), connId);
    return n > 0;
  }

  /** Toutes les connexions IA du tenant (vue admin org-wide). SCAN par préfixe. */
  async listAllConnections(slug: string | undefined): Promise<OAuthConnection[]> {
    const match = this.key('conn', slug, '*');
    const out: OAuthConnection[] = [];
    let cursor = '0';
    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', match, 'COUNT', 300);
      cursor = next;
      if (keys.length) {
        const vals = await this.redis.mget(keys);
        for (const v of vals) if (v) out.push(JSON.parse(v) as OAuthConnection);
      }
    } while (cursor !== '0');
    return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** Révoque TOUTES les connexions d'un user (offboarding / suspension). */
  async revokeUserConnections(slug: string | undefined, userId: string): Promise<number> {
    const ids = await this.redis.smembers(this.userConnKey(slug, userId));
    if (ids.length) {
      await this.redis.del(...ids.map((id) => this.key('conn', slug, id)));
      await this.redis.del(this.userConnKey(slug, userId));
    }
    return ids.length;
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      /* ignore */
    }
  }
}
