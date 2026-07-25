import { Injectable, Logger } from '@nestjs/common';
import {
  AgentPolicyContext,
  AgentPolicyOutcome,
  AgentPolicyRule,
  DEFAULT_AGENT_POLICIES,
  evaluateAgentPolicies,
  normalizeAgentPolicies,
} from '@vaks-pm/shared';
import { AdminSettingsService } from '../admin/admin-settings.service';

/**
 * Moteur de policies agents (AGENTS_ARCHITECTURE.md chantier 3). Les règles
 * vivent dans `OrgSetting agents.policies` (JSON array), validées/normalisées à
 * la lecture. Le cœur d'évaluation est la fonction PURE `evaluateAgentPolicies`
 * (shared, vitest) ; ce service ne fait que charger + cacher les règles par org
 * et exposer un `evaluate` ergonomique.
 *
 * Appelé au **claim** (deny/notify) et à la **résolution d'auto-close**
 * (require_review) côté `TasksService` ; s'étendra à `next_task` (chantier 4).
 * La **backpressure** (débit de revue humaine) est aussi réglée ici.
 *
 * Cache 30 s par org : les transitions sont fréquentes (drag-drop, claim) — on
 * évite une lecture settings par mouvement, comme `TaskTransitionService`.
 */
@Injectable()
export class PolicyEngineService {
  private readonly log = new Logger(PolicyEngineService.name);
  private readonly cache = new Map<
    string,
    {
      rules: AgentPolicyRule[];
      backpressureMax: number;
      requireRunDeclaration: boolean;
      expires: number;
    }
  >();
  private readonly CACHE_TTL_MS = 30_000;
  private readonly DEFAULT_BACKPRESSURE_MAX = 5;

  constructor(private readonly settings: AdminSettingsService) {}

  private async load(orgId: string): Promise<{
    rules: AgentPolicyRule[];
    backpressureMax: number;
    requireRunDeclaration: boolean;
  }> {
    const now = Date.now();
    const hit = this.cache.get(orgId);
    if (hit && hit.expires > now) return hit;

    let rules: AgentPolicyRule[] = DEFAULT_AGENT_POLICIES;
    let backpressureMax = this.DEFAULT_BACKPRESSURE_MAX;
    // Défaut OFF : opt-in non-cassant (les agents pilotes ne déclarent pas
    // forcément leur run aujourd'hui). L'admin l'active pour rendre la
    // traçabilité du coût par tâche obligatoire.
    let requireRunDeclaration = false;
    try {
      const all = await this.settings.getAll(orgId);
      const raw = all['agents.policies'];
      // Clé jamais initialisée → défauts. Tableau vide EXPLICITE → aucune règle
      // (l'admin a désactivé toutes les policies volontairement).
      if (Array.isArray(raw)) rules = normalizeAgentPolicies(raw);
      const bp = Number(all['agents.backpressure.maxPendingReviews']);
      if (Number.isInteger(bp) && bp >= 0 && bp <= 1000) backpressureMax = bp;
      requireRunDeclaration = all['agents.requireRunDeclaration'] === true;
    } catch (e) {
      // Fail-safe : on garde les défauts plutôt que de crasher un claim.
      this.log.warn(`[policy] lecture settings échouée org=${orgId}: ${String(e)}`);
    }
    const entry = {
      rules,
      backpressureMax,
      requireRunDeclaration,
      expires: now + this.CACHE_TTL_MS,
    };
    this.cache.set(orgId, entry);
    return entry;
  }

  /** Évalue les policies de l'org contre un contexte de tâche/transition. */
  async evaluate(orgId: string, ctx: AgentPolicyContext): Promise<AgentPolicyOutcome> {
    const { rules } = await this.load(orgId);
    return evaluateAgentPolicies(rules, ctx);
  }

  /** Seuil de backpressure (nombre max de revues en attente). 0 = illimité. */
  async getBackpressureMax(orgId: string): Promise<number> {
    const { backpressureMax } = await this.load(orgId);
    return backpressureMax;
  }

  /**
   * Vrai si un agent doit avoir déclaré ≥1 run de coût (`AgentRun`) sur une
   * tâche avant de la passer en revue. Sert la traçabilité du budget par tâche.
   */
  async getRequireRunDeclaration(orgId: string): Promise<boolean> {
    const { requireRunDeclaration } = await this.load(orgId);
    return requireRunDeclaration;
  }

  /** Règles effectives (défauts inclus) — pour l'UI / le diagnostic. */
  async getRules(orgId: string): Promise<AgentPolicyRule[]> {
    const { rules } = await this.load(orgId);
    return rules;
  }

  /** Invalide le cache d'une org (après édition des policies). */
  invalidate(orgId: string): void {
    this.cache.delete(orgId);
  }
}
