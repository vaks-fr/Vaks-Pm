import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from './admin-settings.service';
import { DataManagementService } from './data-management.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { getEmailQueue } from '../notifications/email-queue';

const TICK_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Auto-purge des enregistrements soft-deleted (Admin > Data Management).
 * Pour chaque org dont `autoPurge` est activé, supprime définitivement ce qui
 * dépasse le délai de grâce `purgeAfter` (jours). Même armature que
 * `AuditRetentionCronService` : setInterval natif + lock Redis (une exécution
 * cluster-wide par jour) + énumération des bases tenant en mode pooled.
 */
@Injectable()
export class DataPurgeCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(DataPurgeCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly data: DataManagementService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // Premier passage 6 min après le boot (laisse le rolling update converger).
    setTimeout(() => void this.tick(), 6 * 60_000).unref();
    this.log.log('Data purge cron armé (interval 6h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposé pour test manuel. `force` saute le lock (debug uniquement). */
  async tick(force = false): Promise<void> {
    if (!force) {
      const client = await getEmailQueue().client;
      const lockKey = `vaks:data-purge:${new Date().toISOString().slice(0, 10)}`;
      const ok = await (
        client as unknown as {
          set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
        }
      ).set(lockKey, '1', 'EX', 82_800, 'NX');
      if (ok !== 'OK') return;
    }

    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.runForCurrentDb(slug));
        } catch (err) {
          this.log.warn(`data purge tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    await this.runForCurrentDb(null);
  }

  private async runForCurrentDb(slug: string | null): Promise<void> {
    const tag = slug ? ` tenant=${slug}` : '';
    try {
      const orgs = await this.prisma.organization.findMany({ select: { id: true } });
      for (const org of orgs) {
        if (!(await this.settings.getAutoPurgeEnabled(org.id))) continue;
        const days = await this.settings.getPurgeAfterDays(org.id);
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        try {
          const res = await this.data.purge(org.id, cutoff);
          if (res.total > 0) {
            this.log.log(`auto-purge${tag} org=${org.id}: ${res.total} (>${days}j)`);
          }
        } catch (err) {
          this.log.warn(`auto-purge${tag} org=${org.id} failed: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      this.log.warn(`data purge cron${tag} skipped: ${(err as Error).message}`);
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
