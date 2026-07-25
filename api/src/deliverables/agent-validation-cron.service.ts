import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';

const TICK_MS = 5 * 60 * 1000; // 5 min

/**
 * Balayage des baux de validation expirés (phase D, §8.7). Un agent validateur
 * zombie (mort pendant la revue) voit son bail expirer : ce cron **libère** le
 * livrable (remet `validatorClaimedById/At/LeaseExpiresAt` à null) pour qu'il
 * retombe dans la file de validation. Filet déterministe côté serveur — pas de
 * gardien-du-gardien.
 *
 * Le `claimValidation` traite DÉJÀ un bail expiré comme disponible (OR sur
 * `validatorLeaseExpiresAt < now`) → ce cron n'est PAS requis pour la correction,
 * il assure l'hygiène (champs remis à zéro) + une trace d'audit. Idempotent →
 * pas de lock distribué ; énumère les bases tenant en pooled.
 */
@Injectable()
export class AgentValidationCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AgentValidationCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    setTimeout(() => void this.tick(), 4 * 60_000).unref();
    this.log.log('Agent validation lease sweeper armé (interval 5min).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const client = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client, slug }, () => this.sweepCurrent(slug));
        } catch (err) {
          this.log.warn(`validation sweep tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    }
    await this.sweepCurrent(null);
  }

  private async sweepCurrent(slug: string | null): Promise<void> {
    const tag = slug ? ` tenant=${slug}` : '';
    try {
      const now = new Date();
      const expired = await this.prisma.deliverable.findMany({
        where: {
          reviewStatus: 'PENDING',
          validatorClaimedById: { not: null },
          validatorLeaseExpiresAt: { lt: now },
        },
        select: { id: true, organizationId: true, taskId: true, validatorClaimedById: true },
      });
      if (!expired.length) return;
      await this.prisma.deliverable.updateMany({
        where: { id: { in: expired.map((e) => e.id) } },
        data: { validatorClaimedById: null, validatorClaimedAt: null, validatorLeaseExpiresAt: null },
      });
      for (const e of expired) {
        void this.audit.log({
          organizationId: e.organizationId,
          action: 'agent.validation.lease_expired',
          severity: 'WARNING',
          actorType: 'SYSTEM',
          resourceType: 'deliverable',
          resourceId: e.id,
          detail: { taskId: e.taskId, previousValidatorId: e.validatorClaimedById },
        });
      }
      this.log.log(`validation sweep${tag}: ${expired.length} bail(s) expiré(s) libéré(s)`);
    } catch (err) {
      this.log.warn(`validation sweep${tag} skipped: ${(err as Error).message}`);
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
