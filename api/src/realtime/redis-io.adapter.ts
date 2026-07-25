import { INestApplicationContext, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { ServerOptions } from 'socket.io';

/**
 * IoAdapter qui branche le Redis adapter de socket.io pour permettre la
 * diffusion d'events entre plusieurs replicas de l'API (Swarm). Sans ça,
 * un emit fait sur l'instance A n'atteint pas les clients connectés sur B.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(private readonly appCtx: INestApplicationContext) {
    super(appCtx);
  }

  async connectToRedis(): Promise<void> {
    const config = this.appCtx.get(ConfigService);
    const url = config.get<string>('redisUrl') ?? 'redis://redis:6379';
    const pub = new Redis(url, { lazyConnect: false, maxRetriesPerRequest: null });
    const sub = pub.duplicate();
    pub.on('error', (e) => this.logger.error(`redis pub error: ${e.message}`));
    sub.on('error', (e) => this.logger.error(`redis sub error: ${e.message}`));
    this.adapterConstructor = createAdapter(pub, sub);
    this.logger.log(`Socket.IO Redis adapter connected (${url})`);
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) server.adapter(this.adapterConstructor);
    return server;
  }
}
