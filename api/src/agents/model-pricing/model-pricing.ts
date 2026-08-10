import type { AgentBillingUnit } from '@vaks-pm/shared';

/**
 * Logique PURE du Lot 2 (AGENT_COST_UNITS_PLAN.md) : lecture des settings,
 * parsing/validation du feed LiteLLM, résolution des applications et calcul du
 * drift. Aucun accès DB/réseau ici → testable en isolation (`model-pricing.spec.ts`).
 */

export type ApplyMode = 'off' | 'all' | 'per_agent';

export interface ModelPricingSettings {
  /** Opt-in air-gap : aucun fetch sortant tant que ce n'est pas activé. */
  feedEnabled: boolean;
  /** off = drift/badge seulement · all = tous les agents matchés · per_agent = flag. */
  applyMode: ApplyMode;
  /** Les prix LiteLLM sont en USD ; conversion €/kUnit = USD/token ×1000 ×taux. */
  usdToEurRate: number;
}

/** Forme interne normalisée (indépendante du feed source). */
export interface NormalizedModelPrice {
  provider: string;
  model: string;
  label?: string;
  unit: AgentBillingUnit;
  /** € par 1000 unités (tokens d'entrée / crédits). */
  costInPerKUnits: number;
  /** € par 1000 tokens de sortie (null en crédits). */
  costOutPerKUnits: number | null;
}

/** Seuil de drift : écart relatif au-delà duquel un taux est signalé « dévie ». */
export const PRICE_DRIFT_THRESHOLD = 0.05; // 5 %

/** Plafond de garde-fou : un taux au-delà est aberrant → clampé (feed non fiable). */
const MAX_RATE_PER_KUNIT = 10;

/** Minimum de modèles connus attendus dans un feed sain (sinon abort). */
export const MIN_KNOWN_MODELS = 3;

/**
 * Providers LiteLLM retenus + mapping vers notre nomenclature interne
 * (`modelProvider` des agents / `KNOWN_AGENT_MODELS`).
 */
const LITELLM_PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  azure: 'azure-openai',
  gemini: 'google',
  vertex_ai: 'google',
  mistral: 'mistral',
};

/**
 * Table de correspondance COURTE des noms LiteLLM → notre nomenclature. Le feed
 * communautaire nomme les modèles avec suffixes de date / variantes ; on ne
 * mappe que les modèles qu'on connaît, fallback = nom brut (préfixe provider
 * retiré). Étendre à la demande.
 */
const MODEL_ALIAS_MAP: Record<string, string> = {
  'claude-sonnet-4-5': 'claude-sonnet-5',
  'claude-opus-4-1': 'claude-opus-4-8',
  'claude-haiku-4-5': 'claude-haiku-4-5',
  'gpt-5': 'gpt-5',
  'gpt-5-mini': 'gpt-5-mini',
  'gpt-4.1': 'gpt-4.1',
  'gemini-2.5-pro': 'gemini-2.5-pro',
  'gemini-2.5-flash': 'gemini-2.5-flash',
  'mistral-large-latest': 'mistral-large',
};

/** Normalise un nom de modèle LiteLLM vers notre nomenclature. */
export function normalizeModelName(raw: string): string {
  // Retire un éventuel préfixe provider (`anthropic/claude-…`).
  const bare = raw.includes('/') ? raw.slice(raw.lastIndexOf('/') + 1) : raw;
  if (MODEL_ALIAS_MAP[bare]) return MODEL_ALIAS_MAP[bare];
  // Retire un suffixe de date `-YYYYMMDD` puis re-teste l'alias.
  const undated = bare.replace(/-\d{6,8}$/, '');
  return MODEL_ALIAS_MAP[undated] ?? undated;
}

/** Lecture/normalisation des settings `agents.pricing.*` (défauts air-gap). */
export function readModelPricingSettings(all: Record<string, unknown>): ModelPricingSettings {
  const rateRaw = Number(all['agents.pricing.usdToEurRate']);
  const rate = Number.isFinite(rateRaw) && rateRaw >= 0.1 && rateRaw <= 10 ? rateRaw : 0.92;
  const mode = all['agents.pricing.applyMode'];
  return {
    feedEnabled: all['agents.pricing.feedEnabled'] === true,
    applyMode: (mode === 'all' || mode === 'per_agent' ? mode : 'off') as ApplyMode,
    usdToEurRate: rate,
  };
}

/** Clamp d'un taux : nombre fini, ≥0, borné au plafond de garde-fou. */
function clampRate(v: number): number {
  if (!Number.isFinite(v) || v < 0) return 0;
  const r = Math.min(v, MAX_RATE_PER_KUNIT);
  // 4 décimales comme les colonnes Decimal(12,4).
  return Math.round(r * 10000) / 10000;
}

/**
 * Parseur du feed LiteLLM (`model_prices_and_context_window.json`) → forme
 * interne. Le feed est de la DONNÉE non contrôlée : entrées invalides ignorées,
 * jamais d'exception qui remonte, valeurs clampées. Un futur feed Vaks se
 * branchera sur la même sortie.
 */
export function parseLiteLLM(raw: unknown, usdToEurRate: number): NormalizedModelPrice[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const rate = Number.isFinite(usdToEurRate) && usdToEurRate > 0 ? usdToEurRate : 0.92;
  const out: NormalizedModelPrice[] = [];
  for (const [rawName, entryRaw] of Object.entries(raw as Record<string, unknown>)) {
    if (!entryRaw || typeof entryRaw !== 'object' || Array.isArray(entryRaw)) continue;
    const e = entryRaw as Record<string, unknown>;
    const litellmProvider = typeof e.litellm_provider === 'string' ? e.litellm_provider : '';
    const provider = LITELLM_PROVIDER_MAP[litellmProvider];
    if (!provider) continue;
    // Uniquement les modèles de chat (pas embeddings/audio/rerank…).
    if (e.mode !== undefined && e.mode !== 'chat') continue;
    const inTok = Number(e.input_cost_per_token);
    if (!Number.isFinite(inTok) || inTok < 0) continue; // pas de prix d'entrée → ignoré.
    const outTokRaw = e.output_cost_per_token;
    const outTok = outTokRaw == null ? null : Number(outTokRaw);
    const model = normalizeModelName(rawName);
    if (!model || model.length > 200) continue;
    out.push({
      provider,
      model,
      label: typeof e.litellm_provider === 'string' ? `${rawName}`.slice(0, 200) : undefined,
      unit: 'tokens', // LiteLLM ne couvre pas les crédits Copilot.
      costInPerKUnits: clampRate(inTok * 1000 * rate),
      costOutPerKUnits:
        outTok != null && Number.isFinite(outTok) && outTok >= 0
          ? clampRate(outTok * 1000 * rate)
          : null,
    });
  }
  // Dédoublonne sur (provider, model) : le dernier gagne (feed ordonné du plus
  // ancien au plus récent en pratique).
  const byKey = new Map<string, NormalizedModelPrice>();
  for (const p of out) byKey.set(`${p.provider}/${p.model}`, p);
  return [...byKey.values()];
}

/** Providers OpenRouter retenus → nomenclature interne. */
const OPENROUTER_PROVIDER_MAP: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  'x-ai': 'xai',
  deepseek: 'deepseek',
  mistralai: 'mistral',
  'z-ai': 'zai',
  cohere: 'cohere',
  'meta-llama': 'meta',
  qwen: 'qwen',
  moonshotai: 'moonshot',
};

/** Une ligne de catalogue (liste + prix optionnel + provenance du prix). */
export interface CatalogRow {
  provider: string;
  model: string;
  label?: string;
  unit: AgentBillingUnit;
  /** € par 1000 unités — null = modèle listé sans prix connu. */
  costInPerKUnits: number | null;
  costOutPerKUnits: number | null;
  priceSource: 'openrouter' | 'litellm' | 'seed' | null;
}

/** Rejette les variantes de service / snapshots datés / non-chat d'OpenRouter. */
function isExcludedModel(model: string): boolean {
  return /-\d{4,8}$/.test(model) || /tiny|nano|guard|embed|ocr|image|rerank|-fast$|build/i.test(model);
}

/**
 * Parseur de l'API OpenRouter (`/api/v1/models`) → catalogue (liste + prix).
 * Source UNIQUE liste+prix : mêmes noms, aucune correspondance à deviner. Prix
 * `pricing.prompt/completion` en USD/token → €/kUnit. Défensif : jamais d'exception.
 */
export function parseOpenRouter(raw: unknown, usdToEurRate: number): CatalogRow[] {
  if (!raw || typeof raw !== 'object') return [];
  const data = (raw as Record<string, unknown>).data;
  if (!Array.isArray(data)) return [];
  const rate = Number.isFinite(usdToEurRate) && usdToEurRate > 0 ? usdToEurRate : 0.92;
  const byKey = new Map<string, CatalogRow>();
  for (const m of data) {
    if (!m || typeof m !== 'object') continue;
    const e = m as Record<string, unknown>;
    const id = typeof e.id === 'string' ? e.id : '';
    if (!id || id.includes(':')) continue; // pas de :free/:batch/:thinking…
    const [pref, ...rest] = id.split('/');
    const model = rest.join('/');
    const provider = OPENROUTER_PROVIDER_MAP[pref];
    if (!provider || !model || model.length > 200 || isExcludedModel(model)) continue;
    const p = (e.pricing as Record<string, unknown>) || {};
    const usdIn = Number(p.prompt);
    const usdOut = Number(p.completion);
    const costIn = Number.isFinite(usdIn) && usdIn > 0 ? clampRate(usdIn * 1000 * rate) : null;
    const costOut = Number.isFinite(usdOut) && usdOut > 0 ? clampRate(usdOut * 1000 * rate) : null;
    const label = typeof e.name === 'string' ? e.name.split(': ').pop()?.slice(0, 200) : undefined;
    byKey.set(`${provider}/${model}`, {
      provider,
      model,
      label,
      unit: 'tokens',
      costInPerKUnits: costIn,
      costOutPerKUnits: costOut,
      priceSource: costIn != null || costOut != null ? 'openrouter' : null,
    });
  }
  return [...byKey.values()];
}

/** Index prix LiteLLM keyé `provider/model` (nomenclature interne) pour le fallback. */
export function buildLiteLLMIndex(rows: NormalizedModelPrice[]): Map<string, NormalizedModelPrice> {
  const m = new Map<string, NormalizedModelPrice>();
  for (const r of rows) m.set(`${r.provider}/${r.model}`, r);
  return m;
}

/** Complète les prix manquants d'un catalogue OpenRouter par le fallback LiteLLM. */
export function applyLiteLLMFallback(rows: CatalogRow[], liteIndex: Map<string, NormalizedModelPrice>): CatalogRow[] {
  return rows.map((r) => {
    if (r.costInPerKUnits != null || r.costOutPerKUnits != null) return r;
    const lite = liteIndex.get(`${r.provider}/${r.model}`);
    if (!lite) return r;
    return { ...r, costInPerKUnits: lite.costInPerKUnits, costOutPerKUnits: lite.costOutPerKUnits, priceSource: 'litellm' };
  });
}

/** Agent minimal pour la résolution d'application (sous-ensemble d'`AgentDto`). */
export interface PricingAgent {
  agentId: string;
  provider: string | null | undefined;
  model: string | null | undefined;
  followCatalogPricing: boolean;
}

export interface CatalogEntry {
  provider: string;
  model: string;
  unit: AgentBillingUnit;
  costInPerKUnits: number;
  costOutPerKUnits: number | null;
}

export interface PricingApplication {
  agentId: string;
  price: CatalogEntry;
}

/**
 * Décide quels agents reçoivent quel prix, selon le mode. Fonction PURE (cœur
 * testable) : `off` → aucune application (le drift/badge se calcule ailleurs) ;
 * `all` → tout agent dont (provider, model) matche le catalogue ; `per_agent`
 * → seulement ceux ayant opté (`followCatalogPricing`).
 */
export function resolveApplications(
  mode: ApplyMode,
  agents: PricingAgent[],
  catalog: CatalogEntry[],
): PricingApplication[] {
  if (mode === 'off') return [];
  const byKey = new Map<string, CatalogEntry>();
  for (const c of catalog) byKey.set(`${c.provider}/${c.model}`, c);
  const apps: PricingApplication[] = [];
  for (const a of agents) {
    if (mode === 'per_agent' && !a.followCatalogPricing) continue;
    if (!a.provider || !a.model) continue;
    const price = byKey.get(`${a.provider}/${a.model}`);
    if (!price) continue;
    apps.push({ agentId: a.agentId, price });
  }
  return apps;
}

/** Écart relatif entre deux taux (∞ si l'actuel est 0/absent et le catalogue > 0). */
function relDrift(current: number | null | undefined, catalog: number | null | undefined): number {
  const cat = catalog ?? 0;
  const cur = current ?? 0;
  if (cat === 0) return 0;
  return Math.abs(cur - cat) / cat;
}

/**
 * Calcule le drift d'un agent vs le prix catalogue. En crédits, seul le taux
 * d'entrée compte (pas de sortie). `drift` vrai si l'écart dépasse le seuil sur
 * l'un des taux pertinents.
 */
export function computeDrift(
  current: { costRateInPerKTokens?: number | null; costRateOutPerKTokens?: number | null },
  price: CatalogEntry,
): { drift: boolean; inDriftPct: number; outDriftPct: number } {
  const inDrift = relDrift(current.costRateInPerKTokens, price.costInPerKUnits);
  const outDrift =
    price.unit === 'credits' ? 0 : relDrift(current.costRateOutPerKTokens, price.costOutPerKUnits);
  return {
    drift: inDrift > PRICE_DRIFT_THRESHOLD || outDrift > PRICE_DRIFT_THRESHOLD,
    inDriftPct: Math.round(inDrift * 1000) / 10,
    outDriftPct: Math.round(outDrift * 1000) / 10,
  };
}
