import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { CiWebhooksService } from './ci-webhooks.service';

const TICK_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Purge des résultats CI en attente expirés (buffer §8.1, TTL 24 h). La purge
 * (`DELETE … WHERE expiresAt < now`) est **idempotente** → pas besoin de lock
 * distribué : plusieurs réplicas peuvent l'exécuter sans dommage. En mode pooled
 * on énumère les bases tenant (façon `AuditRetentionCronService`), sinon la base
 * courante suffit.
 */
@Injectable()
export class CiWebhooksCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(CiWebhooksCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ci: CiWebhooksService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    setTimeout(() => void this.tick(), 6 * 60_000).unref(); // premier passage après boot
    this.log.log('CI pending purge cron armé (interval 6h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.purgeCurrent(slug));
        } catch (err) {
          this.log.warn(`CI purge tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    await this.purgeCurrent(null);
  }

  private async purgeCurrent(slug: string | null): Promise<void> {
    try {
      const n = await this.ci.purgeExpired();
      if (n > 0) this.log.log(`CI pending purge${slug ? ` tenant=${slug}` : ''}: ${n} expiré(s) supprimé(s)`);
    } catch (err) {
      // Table absente (P2021, rollout) ou base injoignable : on passe.
      this.log.warn(`CI purge${slug ? ` tenant=${slug}` : ''} skipped: ${(err as Error).message}`);
    }
  }

  /** Slugs des tenants (mode pooled) : énumère les bases `<db>_<slug>`. */
  private async tenantSlugs(): Promise<string[]> {
    const base = process.env.DATABASE_URL;
    if (!base) return [];
    let dbName: string;
    try {
      dbName = new URL(base).pathname.replace(/^\//, '') || 'vakspm';
    } catch {
      return [];
    }
    const rows = await this.prisma.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${dbName}\\_%'`,
    );
    return rows.map((r) => r.datname.slice(dbName.length + 1)).filter(Boolean);
  }
}
