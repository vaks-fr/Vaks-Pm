import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenancyService } from '../../tenancy/tenancy.service';
import { TenantConnectionService } from '../../tenancy/tenant-connection.service';
import { TenantContext } from '../../tenancy/tenant-context.service';
import { getEmailQueue } from '../../notifications/email-queue';
import { ModelPricingService } from './model-pricing.service';
import type { ModelPricingSettings } from './model-pricing';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/**
 * Cron du feed de prix des modèles (Lot 2, AGENT_COST_UNITS_PLAN.md) — même
 * squelette que `AutomationsCronService` : setInterval natif (6 h), lock Redis
 * distribué par jour UTC, énumération des bases tenant en pooled.
 *
 * **Air-gap par défaut** : un seul fetch réseau par tick, et UNIQUEMENT si au
 * moins une org a activé le feed (`agents.pricing.feedEnabled`). Sans opt-in
 * nulle part → zéro appel sortant. L'échec réseau est silencieux (warn), jamais
 * bloquant (imité de `LicenseRemoteService`).
 */
@Injectable()
export class ModelPricingCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ModelPricingCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: ModelPricingService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.tick(), SIX_HOURS_MS);
    this.timer.unref?.();
    // Premier tick différé : laisser le boot / db push se terminer.
    setTimeout(() => void this.tick(), 120_000);
    this.log.log('Model-pricing cron armed (6h interval, opt-in per org).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const client = await getEmailQueue().client;
    const lockKey = `vaks:model-pricing:${new Date().toISOString().slice(0, 10)}`; // par jour UTC
    const ok = await (client as unknown as {
      set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
    }).set(lockKey, '1', 'EX', 23 * 3600, 'NX');
    if (ok !== 'OK') {
      this.log.debug(`tick skip (lock held: ${lockKey})`);
      return;
    }

    if (this.tenancy.mode === 'pooled') {
      for (const slug of await this.tenantSlugs()) {
        try {
          const tenantClient = this.conn.getClient({ id: slug, slug });
          await this.tenantCtx.run({ client: tenantClient, slug }, () => this.processAllOrgs());
        } catch (err) {
          this.log.warn(`tick tenant=${slug} failed: ${(err as Error).message}`);
        }
      }
    } else {
      await this.processAllOrgs();
    }
  }

  /**
   * Traite toutes les orgs de la base courante. Air-gap : on ne fetch que si au
   * moins une org a activé le feed. Le feed est parsé en €/kUnit avec le taux
   * USD→EUR de l'org ; comme ce taux peut différer d'une org à l'autre, on
   * regroupe les orgs par taux distinct et on fait UN fetch par taux (souvent un
   * seul en pratique) — le contenu HTTP est de toute façon mis en cache réseau.
   */
  private async processAllOrgs(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    const optedIn: { orgId: string; settings: ModelPricingSettings }[] = [];
    for (const org of orgs) {
      try {
        // Seed committé (air-gap) pour TOUTES les orgs, indépendamment du feed.
        await this.pricing.ensureSeeded(org.id);
        const s = await this.pricing.settingsFor(org.id);
        if (s.feedEnabled) optedIn.push({ orgId: org.id, settings: s });
      } catch (err) {
        this.log.warn(`prep org=${org.id} failed: ${(err as Error).message}`);
      }
    }
    if (optedIn.length === 0) return; // air-gap : aucun opt-in → zéro fetch réseau.

    // Le catalogue est converti en €/kUnit avec un taux USD→EUR ; les orgs
    // pouvant avoir des taux distincts, on fetch une fois par taux (souvent 1).
    const byRate = new Map<number, typeof optedIn>();
    for (const o of optedIn) {
      const list = byRate.get(o.settings.usdToEurRate) ?? [];
      list.push(o);
      byRate.set(o.settings.usdToEurRate, list);
    }
    for (const [rate, list] of byRate) {
      const catalog = await this.pricing.fetchCatalog(rate);
      if (!catalog.ok) this.log.warn(`catalog fetch failed (rate ${rate}): ${catalog.error}`);
      for (const o of list) {
        try {
          const r = await this.pricing.syncOrg(o.orgId, catalog, o.settings);
          if (r.upserted || r.applied) {
            this.log.log(`pricing org=${o.orgId}: upserted=${r.upserted} applied=${r.applied}`);
          }
        } catch (err) {
          this.log.warn(`syncOrg org=${o.orgId} failed: ${(err as Error).message}`);
        }
      }
    }
  }

  /** Exécution forcée pour UNE org (route admin « Synchroniser »). */
  async runNowForOrg(orgId: string): Promise<{ enabled: boolean; upserted: number; applied: number; error?: string }> {
    await this.pricing.ensureSeeded(orgId);
    const s = await this.pricing.settingsFor(orgId);
    if (!s.feedEnabled) return { enabled: false, upserted: 0, applied: 0 };
    const catalog = await this.pricing.fetchCatalog(s.usdToEurRate);
    const r = await this.pricing.syncOrg(orgId, catalog, s);
    return { enabled: true, upserted: r.upserted, applied: r.applied, error: catalog.ok ? undefined : catalog.error };
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
