import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  KNOWN_AGENT_MODELS,
  billingUnitForProvider,
  type ModelCatalogEntryDto,
  type AgentBillingUnit,
} from '@vaks-pm/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminSettingsService } from '../../admin/admin-settings.service';
import { AuditLogService } from '../../audit-logs/audit-log.service';
import {
  parseLiteLLM,
  parseOpenRouter,
  buildLiteLLMIndex,
  applyLiteLLMFallback,
  readModelPricingSettings,
  resolveApplications,
  computeDrift,
  type CatalogEntry,
  type CatalogRow,
  type ModelPricingSettings,
} from './model-pricing';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models';
const LITELLM_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const FETCH_MAX_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
/** Rétention de la liste PROPOSÉE au picker (l'entrée reste en DB au-delà). */
const RETENTION_MS = 4 * 365 * 24 * 60 * 60 * 1000; // ~4 ans
/** Version du seed committé — bumper à chaque régénération pour ré-appliquer. */
const SEED_VERSION = '2026-08-07';

/** Résultat d'un fetch de catalogue (mémoire, partagé entre orgs au sein d'un tick). */
export interface CatalogFetchResult {
  ok: boolean;
  rows: CatalogRow[];
  error?: string;
  /** Nb de prix résolus via le fallback LiteLLM (info/log). */
  litellmFallback?: number;
}

/** Une ligne du seed committé (JSON, prix en USD/token). */
interface SeedRow {
  provider: string;
  model: string;
  label?: string;
  unit: string;
  usdIn: number;
  usdOut: number;
}

/**
 * Catalogue UNIFIÉ de modèles + prix (AGENT_COST_UNITS). Source de vérité = table
 * `ModelPrice` (par org), **cumulative** : seed committé (air-gap) puis sync live
 * OpenRouter (liste + prix ; fallback LiteLLM). Upsert additif, jamais de
 * suppression ; la liste PROPOSÉE filtre sur `lastSeenAt` (rétention 4 ans).
 * Le CRON (`ModelPricingCronService`) est le seul appelant réseau.
 */
@Injectable()
export class ModelPricingService {
  private readonly log = new Logger(ModelPricingService.name);
  /** Orgs déjà seedées dans CE process (évite un check à chaque lecture). */
  private readonly seededOrgs = new Set<string>();
  private seedCache: SeedRow[] | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly audit: AuditLogService,
  ) {}

  // ---------- Seed committé (défaut air-gap) ----------

  private loadSeed(): SeedRow[] {
    if (this.seedCache) return this.seedCache;
    try {
      const p = path.resolve(process.cwd(), 'prisma/model-catalog-seed.json');
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as SeedRow[];
      this.seedCache = Array.isArray(raw) ? raw : [];
    } catch {
      this.seedCache = [];
    }
    return this.seedCache;
  }

  /**
   * Peuple le catalogue DB depuis le seed committé — additif (upsert, jamais de
   * suppression), version-gated (rejoué seulement quand le seed embarqué change).
   * Ne touche jamais une entrée `source='manual'`. Prix seed convertis USD→€
   * avec le taux de l'org.
   */
  async ensureSeeded(orgId: string): Promise<void> {
    if (this.seededOrgs.has(orgId)) return;
    let rate = 0.92;
    try {
      const all = await this.settings.getAll(orgId);
      if (all['agents.pricing.seedVersion'] === SEED_VERSION) {
        this.seededOrgs.add(orgId);
        return;
      }
      rate = readModelPricingSettings(all).usdToEurRate;
    } catch {
      // settings illisibles : on tente quand même le seed (best-effort).
    }
    const seed = this.loadSeed();
    const now = new Date();
    const clamp = (usd: number) => (Number.isFinite(usd) && usd > 0 ? Math.round(Math.min(usd * 1000 * rate, 10) * 10000) / 10000 : null);
    try {
      for (const s of seed) {
        const existing = await this.prisma.modelPrice.findUnique({
          where: { organizationId_provider_model: { organizationId: orgId, provider: s.provider, model: s.model } },
          select: { id: true, source: true },
        });
        if (existing?.source === 'manual') continue;
        const costIn = s.unit === 'credits' ? null : clamp(s.usdIn);
        const costOut = s.unit === 'credits' ? null : clamp(s.usdOut);
        await this.prisma.modelPrice.upsert({
          where: { organizationId_provider_model: { organizationId: orgId, provider: s.provider, model: s.model } },
          update: { label: s.label ?? null, lastSeenAt: now },
          create: {
            organizationId: orgId, provider: s.provider, model: s.model, label: s.label ?? null,
            unit: s.unit, costInPerKUnits: costIn, costOutPerKUnits: costOut,
            source: 'seed', priceSource: costIn != null || costOut != null ? 'openrouter' : null,
            firstSeenAt: now, lastSeenAt: now, feedUpdatedAt: now,
          },
        });
      }
      await this.writeSetting(orgId, 'agents.pricing.seedVersion', SEED_VERSION);
      this.seededOrgs.add(orgId);
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === 'P2021') { this.log.warn(`ensureSeeded org=${orgId}: table missing (rollout)`); return; }
      this.log.warn(`ensureSeeded org=${orgId} failed: ${(e as Error).message}`);
    }
  }

  // ---------- Catalogue fusionné ----------

  /**
   * Catalogue fusionné (DB `ModelPrice` par-dessus `KNOWN_AGENT_MODELS` builtin).
   * `proposedOnly` applique la rétention 4 ans (liste offerte au picker) ; sinon
   * on renvoie TOUT (pour résoudre le modèle d'un agent, même ancien).
   */
  async mergedCatalog(orgId: string, proposedOnly = false): Promise<ModelCatalogEntryDto[]> {
    await this.ensureSeeded(orgId);
    const byKey = new Map<string, ModelCatalogEntryDto>();
    // 1. Socle embarqué (Copilot crédits + ultime fallback air-gap).
    for (const m of KNOWN_AGENT_MODELS) {
      const unit: AgentBillingUnit = m.unit ?? billingUnitForProvider(m.provider);
      byKey.set(`${m.provider}/${m.model}`, {
        provider: m.provider, model: m.model, label: m.label, unit,
        costInPerKUnits: m.suggestedCostInPerKTokens ?? null,
        costOutPerKUnits: unit === 'credits' ? null : m.suggestedCostOutPerKTokens ?? null,
        source: 'builtin',
      });
    }
    // 2. DB (seed | openrouter | manual) écrase le builtin.
    const cutoff = new Date(Date.now() - RETENTION_MS);
    const rows = await this.prisma.modelPrice.findMany({ where: { organizationId: orgId } });
    for (const r of rows) {
      if (proposedOnly && r.lastSeenAt < cutoff) continue; // rétention : sort de la liste proposée.
      const unit = (r.unit === 'credits' ? 'credits' : 'tokens') as AgentBillingUnit;
      byKey.set(`${r.provider}/${r.model}`, {
        provider: r.provider, model: r.model, label: r.label, unit,
        costInPerKUnits: r.costInPerKUnits == null ? null : Number(r.costInPerKUnits),
        costOutPerKUnits: r.costOutPerKUnits == null ? null : Number(r.costOutPerKUnits),
        source: (r.source === 'manual' ? 'manual' : r.source === 'builtin' ? 'builtin' : 'feed') as 'feed' | 'manual' | 'builtin',
        feedUpdatedAt: r.feedUpdatedAt ? r.feedUpdatedAt.toISOString() : null,
      });
    }
    return [...byKey.values()].sort(
      (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    );
  }

  async catalogEntryFor(orgId: string, provider: string | null | undefined, model: string | null | undefined): Promise<ModelCatalogEntryDto | null> {
    if (!provider || !model) return null;
    const catalog = await this.mergedCatalog(orgId); // tout (pas de rétention) : un agent peut être sur un vieux modèle.
    return catalog.find((c) => c.provider === provider && c.model === model) ?? null;
  }

  async enrichAgentsWithCatalog<
    T extends { modelProvider?: string | null; model?: string | null; costRateInPerKTokens?: number | null; costRateOutPerKTokens?: number | null },
  >(orgId: string, agents: T[]): Promise<(T & { catalogPrice: ModelCatalogEntryDto | null; priceDrift: boolean })[]> {
    const catalog = await this.mergedCatalog(orgId);
    const byKey = new Map(catalog.map((c) => [`${c.provider}/${c.model}`, c]));
    return agents.map((a) => {
      const entry = a.modelProvider && a.model ? byKey.get(`${a.modelProvider}/${a.model}`) ?? null : null;
      let drift = false;
      if (entry && entry.costInPerKUnits != null) {
        drift = computeDrift(
          { costRateInPerKTokens: a.costRateInPerKTokens, costRateOutPerKTokens: a.costRateOutPerKTokens },
          { provider: entry.provider, model: entry.model, unit: entry.unit, costInPerKUnits: entry.costInPerKUnits, costOutPerKUnits: entry.costOutPerKUnits },
        ).drift;
      }
      return { ...a, catalogPrice: entry, priceDrift: drift };
    });
  }

  // ---------- Application manuelle (bouton « appliquer le prix catalogue ») ----------

  async applyCatalogPrice(orgId: string, agentId: string, actor?: { id?: string; email?: string }) {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId, kind: 'AGENT', deletedAt: null },
      select: { id: true, name: true, modelProvider: true, model: true },
    });
    if (!agent) throw new NotFoundException('Agent introuvable');
    const entry = await this.catalogEntryFor(orgId, agent.modelProvider, agent.model);
    if (!entry || entry.costInPerKUnits == null) throw new NotFoundException('Aucun prix catalogue pour ce modèle.');
    await this.prisma.user.update({
      where: { id: agentId },
      data: { costRateInPerKTokens: entry.costInPerKUnits, costRateOutPerKTokens: entry.unit === 'credits' ? null : entry.costOutPerKUnits },
    });
    void this.audit.log({
      organizationId: orgId, action: 'agents.pricing_applied', severity: 'INFO',
      actorType: (actor?.id ? 'USER' : 'SYSTEM') as 'USER' | 'SYSTEM', actorId: actor?.id ?? null, actorLabel: actor?.email ?? null,
      resourceType: 'user', resourceId: agentId, resourceLabel: agent.name,
      detail: { model: `${agent.modelProvider}/${agent.model}`, source: entry.source },
    });
    return { ok: true };
  }

  // ---------- Fetch réseau (OpenRouter liste+prix, fallback LiteLLM) ----------

  private async fetchJson(url: string): Promise<unknown> {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > FETCH_MAX_BYTES) throw new Error(`response too large (${text.length} bytes)`);
      return JSON.parse(text);
    } finally {
      clearTimeout(to);
    }
  }

  /**
   * Fetch du catalogue : OpenRouter (liste + prix) d'abord, puis LiteLLM pour
   * combler les prix manquants. Réseau imité de `LicenseRemoteService` (échec =
   * warn, jamais bloquant). Hôtes hardcodés (pas de surface SSRF).
   */
  async fetchCatalog(usdToEurRate: number): Promise<CatalogFetchResult> {
    let rows: CatalogRow[];
    try {
      rows = parseOpenRouter(await this.fetchJson(OPENROUTER_URL), usdToEurRate);
    } catch (e) {
      return { ok: false, rows: [], error: `openrouter: ${(e as Error).message}` };
    }
    if (rows.length < 3) return { ok: false, rows: [], error: `openrouter yielded only ${rows.length} models` };
    // Fallback prix LiteLLM (best-effort — un échec n'annule pas la liste).
    let litellmFallback = 0;
    try {
      const lite = buildLiteLLMIndex(parseLiteLLM(await this.fetchJson(LITELLM_URL), usdToEurRate));
      const before = rows.filter((r) => r.costInPerKUnits == null).length;
      rows = applyLiteLLMFallback(rows, lite);
      litellmFallback = before - rows.filter((r) => r.costInPerKUnits == null).length;
    } catch (e) {
      this.log.warn(`litellm fallback skipped: ${(e as Error).message}`);
    }
    return { ok: true, rows, litellmFallback };
  }

  // ---------- Synchronisation d'une org (appelée par le cron) ----------

  /**
   * Applique un fetch de catalogue à UNE org : upsert ADDITIF des `ModelPrice`
   * (jamais de suppression ; jamais d'écrasement d'une entrée `manual`), met à
   * jour `lastSeenAt`, puis applique les prix aux agents selon `applyMode`.
   */
  async syncOrg(orgId: string, catalog: CatalogFetchResult, settings: ModelPricingSettings) {
    const now = new Date();
    try {
      await this.ensureSeeded(orgId);
      if (!catalog.ok) {
        await this.writeSyncState(orgId, now, false, catalog.error ?? 'unknown error');
        return { applied: 0, upserted: 0 };
      }
      let upserted = 0;
      for (const p of catalog.rows) {
        const existing = await this.prisma.modelPrice.findUnique({
          where: { organizationId_provider_model: { organizationId: orgId, provider: p.provider, model: p.model } },
          select: { id: true, source: true },
        });
        const isManual = existing?.source === 'manual';
        // Manual : on met à jour uniquement `lastSeenAt`/`label` (jamais le prix).
        await this.prisma.modelPrice.upsert({
          where: { organizationId_provider_model: { organizationId: orgId, provider: p.provider, model: p.model } },
          update: isManual
            ? { label: p.label ?? undefined, lastSeenAt: now }
            : {
                label: p.label ?? null, unit: p.unit,
                costInPerKUnits: p.costInPerKUnits, costOutPerKUnits: p.costOutPerKUnits,
                priceSource: p.priceSource, source: existing?.source === 'seed' ? 'seed' : 'openrouter',
                lastSeenAt: now, feedUpdatedAt: now,
              },
          create: {
            organizationId: orgId, provider: p.provider, model: p.model, label: p.label ?? null,
            unit: p.unit, costInPerKUnits: p.costInPerKUnits, costOutPerKUnits: p.costOutPerKUnits,
            source: 'openrouter', priceSource: p.priceSource,
            firstSeenAt: now, lastSeenAt: now, feedUpdatedAt: now,
          },
        });
        upserted++;
      }
      const applied = await this.applyToAgents(orgId, settings.applyMode);
      await this.writeSyncState(orgId, now, true, null);
      void this.audit.log({
        organizationId: orgId, action: 'agents.pricing_synced', severity: 'INFO', actorType: 'SYSTEM', resourceType: 'orgSetting',
        detail: { models: upserted, litellmFallback: catalog.litellmFallback ?? 0, agentsApplied: applied.count, mode: settings.applyMode },
      });
      return { applied: applied.count, upserted };
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'P2021') { this.log.warn(`syncOrg org=${orgId}: table missing (rollout) — skipped`); return { applied: 0, upserted: 0 }; }
      await this.writeSyncState(orgId, now, false, err.message ?? 'error').catch(() => {});
      throw e;
    }
  }

  /** Applique le catalogue courant aux agents selon le mode (hors fetch). */
  async applyToAgents(orgId: string, mode: ModelPricingSettings['applyMode']) {
    if (mode === 'off') return { count: 0, ids: [] as string[] };
    const agents = await this.prisma.user.findMany({
      where: { organizationId: orgId, kind: 'AGENT', deletedAt: null },
      select: { id: true, modelProvider: true, model: true, followCatalogPricing: true },
    });
    const catalog = await this.mergedCatalog(orgId);
    const catalogEntries: CatalogEntry[] = catalog
      .filter((c) => c.costInPerKUnits != null)
      .map((c) => ({ provider: c.provider, model: c.model, unit: c.unit, costInPerKUnits: c.costInPerKUnits as number, costOutPerKUnits: c.costOutPerKUnits }));
    const apps = resolveApplications(
      mode,
      agents.map((a) => ({ agentId: a.id, provider: a.modelProvider, model: a.model, followCatalogPricing: a.followCatalogPricing })),
      catalogEntries,
    );
    const ids: string[] = [];
    for (const app of apps) {
      await this.prisma.user.update({
        where: { id: app.agentId },
        data: { costRateInPerKTokens: app.price.costInPerKUnits, costRateOutPerKTokens: app.price.unit === 'credits' ? null : app.price.costOutPerKUnits },
      });
      ids.push(app.agentId);
    }
    return { count: ids.length, ids };
  }

  private async writeSetting(orgId: string, key: string, value: unknown) {
    await this.prisma.orgSetting.upsert({
      where: { organizationId_key: { organizationId: orgId, key } },
      update: { value: value as never },
      create: { organizationId: orgId, key, value: value as never },
    });
  }

  private async writeSyncState(orgId: string, at: Date, ok: boolean, error: string | null) {
    const values: Record<string, unknown> = {
      'agents.pricing.lastSyncAt': at.toISOString(),
      'agents.pricing.lastSyncOk': ok,
      'agents.pricing.lastSyncError': error,
    };
    await this.prisma.$transaction(
      Object.entries(values).map(([key, value]) =>
        this.prisma.orgSetting.upsert({
          where: { organizationId_key: { organizationId: orgId, key } },
          update: { value: value as never },
          create: { organizationId: orgId, key, value: value as never },
        }),
      ),
    );
  }

  async settingsFor(orgId: string): Promise<ModelPricingSettings> {
    return readModelPricingSettings(await this.settings.getAll(orgId));
  }
}
