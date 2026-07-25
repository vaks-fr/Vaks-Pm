import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { TeamsProvisioningService } from './teams-provisioning.service';
import { getTeamsQueue } from './teams-queue';

const TICK_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * Filet de sécurité du provisioning Teams : toutes les 6 h, enqueue une
 * reconcile de membership pour chaque projet provisionné actif. Rattrape les
 * changements de membres qui auraient échappé aux hooks event-driven (ex.
 * mutation directe, event manqué pendant un rollout).
 *
 * Même pattern que les autres crons (NotificationsCronService /
 * AuditRetentionCronService) : setInterval natif + lock Redis cluster-wide +
 * énumération des bases tenant en mode pooled.
 */
@Injectable()
export class TeamsReconcileCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TeamsReconcileCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
    private readonly svc: TeamsProvisioningService,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    // Premier passage 5 min après le boot (laisse le rolling update converger).
    setTimeout(() => void this.tick(), 5 * 60_000).unref();
    this.log.log('Teams reconcile cron armé (interval 6h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposé pour test manuel. `force` saute le lock (debug uniquement). */
  async tick(force = false): Promise<void> {
    if (!force) {
      const client = await getTeamsQueue().client;
      // Un slot de 6 h, cluster-wide (un seul réplica exécute).
      const slot = Math.floor(Date.now() / TICK_MS);
      const lockKey = `vaks:teams-reconcile:${slot}`;
      const ok = await (client as unknown as {
        set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
      }).set(lockKey, '1', 'EX', Math.floor(TICK_MS / 1000) - 120, 'NX');
      if (ok !== 'OK') return;
    }

    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.runForCurrentDb(slug));
        } catch (err) {
          this.log.warn(`teams reconcile tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    // Base courante dans tous les cas (dedicated : la seule).
    await this.runForCurrentDb(null);
  }

  private async runForCurrentDb(slug: string | null): Promise<void> {
    const tag = slug ? ` tenant=${slug}` : '';
    try {
      const n = await this.svc.reconcileAllProvisioned();
      if (n > 0) this.log.log(`teams reconcile${tag}: ${n} projet(s) enqueue(s).`);
    } catch (err) {
      // Table absente (P2021, rollout) ou base injoignable : on passe.
      this.log.warn(`teams reconcile${tag} skipped: ${(err as Error).message}`);
    }
  }

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
