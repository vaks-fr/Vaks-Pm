import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { TenantConnectionService } from '../../tenancy/tenant-connection.service';
import { TenantContext } from '../../tenancy/tenant-context.service';

const TICK_MS = 6 * 60 * 60 * 1000; // 6 h
/** Grâce après expiration avant suppression définitive de la ligne. */
const GRACE_DAYS = 7;
/** Suppression batchée pour ne pas verrouiller la table sur un gros volume. */
const BATCH = 5000;

/**
 * Purge des PAT issus de la **fédération d'identité** (`source='federation'`)
 * expirés depuis plus de 7 jours.
 *
 * Pourquoi ce cron existe : la fédération émet un jeton court par agent et par
 * heure. À 100 agents en TTL 1 h, c'est ~2 400 lignes `ApiToken`/jour. La
 * révocation du précédent à chaque échange (dans `AgentFederationService`)
 * borne le nombre de jetons *vivants* à un par agent, mais les lignes révoquées
 * ou expirées s'accumulent — c'est ce que ce cron ramasse.
 *
 * On ne touche QUE `source='federation'` : les PAT manuels, OAuth et d'agents
 * mintés à la main gardent leur cycle de vie propre. Idempotent (DELETE par
 * fenêtre de date) → pas de lock distribué, plusieurs réplicas cohabitent.
 * Mêmes garde-fous que `CiWebhooksCronService` : énumération des bases tenant
 * en pooled, tolérance à la table absente pendant un rollout.
 */
@Injectable()
export class FederatedTokenPurgeCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(FederatedTokenPurgeCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    setTimeout(() => void this.tick(), 7 * 60_000).unref(); // premier passage après boot
    this.log.log('Federated token purge cron armé (interval 6h).');
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
          this.log.warn(`federated purge tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    await this.purgeCurrent(null);
  }

  private async purgeCurrent(slug: string | null): Promise<void> {
    const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
    let total = 0;
    try {
      // Suppression par lots : `deleteMany` ne prend pas de LIMIT, on borne via
      // une sous-requête d'ids. Boucle jusqu'à épuisement (0 supprimé).
      for (;;) {
        const batch = await this.prisma.apiToken.findMany({
          // Jetons de travail COURTS émis par les voies agent self-service
          // (fédération JWT + refresh rotatif headless) — pas les refresh
          // durables (`AgentRefreshToken`, autre table), ni les PAT manuels.
          where: { source: { in: ['federation', 'agent_self'] }, expiresAt: { lt: cutoff } },
          select: { id: true },
          take: BATCH,
        });
        if (batch.length === 0) break;
        const res = await this.prisma.apiToken.deleteMany({
          where: { id: { in: batch.map((r) => r.id) } },
        });
        total += res.count;
        if (batch.length < BATCH) break;
      }
      if (total > 0) {
        this.log.log(`federated token purge${slug ? ` tenant=${slug}` : ''}: ${total} supprimé(s)`);
      }
    } catch (err) {
      // P2021 (table absente pendant un rollout) ou base injoignable : on passe.
      this.log.warn(`federated purge${slug ? ` tenant=${slug}` : ''} skipped: ${(err as Error).message}`);
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
