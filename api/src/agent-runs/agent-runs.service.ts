import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, TaskStatus } from '@db';
import { PrismaService } from '../prisma/prisma.service';
import { AutomationsHooksService } from '../automations/automations-hooks.service';
import { AgentBudgetService } from '../agents/agent-budget.service';
import { PolicyEngineService } from '../agents/policy-engine.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { AdminSettingsService } from '../admin/admin-settings.service';
import {
  billingUnitForProvider,
  estimateCopilotCredits,
  COPILOT_STUDIO_RATE_CARD,
} from '@vaks-pm/shared';
import { CreateAgentRunDto } from './dto/create-agent-run.dto';
import { detectAnomaly, resolveRunSource } from './agent-run-logic';
import { McpToolUsageService } from '../mcp/mcp-tool-usage.service';
import { ProjectAccessService } from '../rbac/project-access.service';

const toNum = (d: Prisma.Decimal | null): number | null => (d == null ? null : Number(d));

/** Parse une valeur de setting en nombre borné (défaut si non finie). */
function clampNum(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/** Config de meter d'un agent crédits, dérivée des settings + profil (cachée). */
interface MeterCfg {
  baseline: number;
  rateCard: typeof COPILOT_STUDIO_RATE_CARD;
  ratePerK: number;
  model: string | null;
}

/**
 * Runs d'agent — **coût réel déclaratif** (chantier finance agents). L'agent
 * déclare sa propre consommation (tokens + €).
 *
 * **Dérivation-référence** (2026-07-26) : on recalcule TOUJOURS un coût de
 * référence côté serveur depuis les tokens × les taux du profil agent (taux
 * DISTINCTS entrée/sortie — l'output coûte 3–5× l'input) :
 * `tokensIn/1000 × costRateIn + tokensOut/1000 × costRateOut`. Ce `derivedCost`
 * est stocké à côté du `cost` déclaré, qui reste **prioritaire pour la
 * facturation/les budgets** (il capture le cache/tiers qu'un taux fixe ignore).
 * Si l'agent ne déclare rien, `cost = derivedCost`. La comparaison des deux sert
 * l'**anti-triche** : un `cost` déclaré implausiblement bas déclenche une alerte
 * à l'owner (automation `agent_run_anomaly`), sans jamais fausser la facturation.
 *
 * **Idempotence** : une déclaration de coût = un livrable. La clé de
 * dédoublonnage (`runKey`) est dérivée du `deliverableId` quand l'agent n'en
 * fournit pas — un second `report_run` sur le même livrable est un no-op qui
 * renvoie le run existant (`alreadyDeclared:true`), jamais un doublon de coût.
 * Une nouvelle version de livrable (après refus humain/CI) a un nouvel id, donc
 * une nouvelle clé, donc une nouvelle déclaration légitime.
 */
@Injectable()
export class AgentRunsService {
  private readonly log = new Logger(AgentRunsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly budgets: AgentBudgetService,
    private readonly policies: PolicyEngineService,
    private readonly audit: AuditLogService,
    private readonly moduleRef: ModuleRef,
    private readonly settings: AdminSettingsService,
    private readonly projectAccess: ProjectAccessService,
  ) {}

  /**
   * L'acteur courant (un agent) déclare un de SES runs.
   *
   * `gatewaySecret` (Lot 3) = header `X-Vaks-Gateway-Secret` porté par la
   * passerelle LLM Vaks. S'il matche le setting org `agents.gateway.sharedSecret`,
   * le run est marqué `source='gateway'` (usage MESURÉ) et échappe aux anomalies
   * « déclaré sans tokens / sous la référence ». Jamais accepté via le DTO.
   */
  async report(
    orgId: string,
    actor: { userId: string; actorKind: 'HUMAN' | 'AGENT' },
    dto: CreateAgentRunDto,
    gatewaySecret?: string | null,
    /** Header `X-Vaks-Run-Source` : raffine la source MESURÉE (`gateway` par
     *  défaut vs `runtime_log` pour le collecteur de logs). Honoré uniquement si
     *  le secret passerelle matche — sinon ignoré (reste `self`). */
    sourceHint?: string | null,
  ) {
    if (actor.actorKind !== 'AGENT') {
      throw new ForbiddenException('Seul un agent peut déclarer un run.');
    }
    // Dénormalise le projet depuis la tâche (agrégation + budgets par projet).
    let projectId: string | null = null;
    if (dto.taskId) {
      const task = await this.prisma.task.findFirst({
        where: { id: dto.taskId, organizationId: orgId },
        select: { projectId: true },
      });
      projectId = task?.projectId ?? null;
      // Anti-injection de coût cross-projet (audit sécu 2026-08-01) : un agent ne
      // peut imputer un run qu'à une tâche d'un projet dont il est membre.
      // `dto.taskId` n'étant scopé qu'à l'org, sans ce contrôle un agent pouvait
      // attribuer sa dépense — et donc épuiser le budget par projet (DoS au claim)
      // ou fausser le P&L/la facturation — d'un projet concurrent auquel il n'a
      // aucun lien.
      if (projectId && !(await this.isProjectMember(orgId, actor.userId, projectId))) {
        throw new ForbiddenException(
          "Cet agent n'est pas membre du projet de cette tâche — run refusé.",
        );
      }
    }
    // Coût de RÉFÉRENCE : toujours dérivé du profil agent (taux distincts
    // entrée/sortie). Sert de garde-fou anti-triche même quand l'agent déclare
    // son propre coût. Null si aucun taux configuré ou zéro token.
    const tokensIn = dto.tokensIn ?? 0;
    const tokensOut = dto.tokensOut ?? 0;
    let derivedCost: Prisma.Decimal | null = null;
    // Modèle : déclaré par l'agent s'il le précise, sinon celui de son profil.
    // Un run sans modèle n'est pas exploitable (on ne sait plus ce qui a produit
    // la dépense) — et l'information est déjà connue de la plateforme, autant la
    // renseigner que d'afficher un vide dans le journal d'usage.
    let model = dto.model?.trim() || null;
    if (tokensIn + tokensOut > 0 || !model) {
      const profile = await this.prisma.user.findFirst({
        where: { id: actor.userId, organizationId: orgId },
        select: { costRateInPerKTokens: true, costRateOutPerKTokens: true, model: true },
      });
      if (!model) model = profile?.model ?? null;
      // Le coût de référence n'a de sens qu'avec des tokens : sans eux on
      // laisse `null` (et non 0, qui se lirait « gratuit » au lieu de « inconnu »).
      if (tokensIn + tokensOut > 0) {
        const rateIn = profile?.costRateInPerKTokens != null ? Number(profile.costRateInPerKTokens) : null;
        const rateOut = profile?.costRateOutPerKTokens != null ? Number(profile.costRateOutPerKTokens) : null;
        if (rateIn != null || rateOut != null) {
          const derived = (tokensIn / 1000) * (rateIn ?? 0) + (tokensOut / 1000) * (rateOut ?? 0);
          derivedCost = new Prisma.Decimal(Math.round(derived * 10000) / 10000);
        }
      }
    }
    // Coût facturé/budgété : déclaré s'il existe (cache/tiers), sinon la
    // référence dérivée. **Sauf agent crédits (Copilot)** : leur coût est
    // MESURÉ par le meter d'appels MCP (`persistMeteredRun`), pas déclaré —
    // l'outil `vaks_report_run` leur est d'ailleurs masqué. On garde la ligne
    // (tokens/note pour trace) mais `cost=null` : elle ne compte ni au budget ni
    // en finance, sinon elle doublerait la ligne metered. Défensif (client en
    // cache) — le cas nominal est que l'outil n'est jamais appelé.
    const billingUnit = billingUnitForProvider(
      (
        await this.prisma.user.findFirst({
          where: { id: actor.userId, organizationId: orgId },
          select: { modelProvider: true },
        })
      )?.modelProvider,
    );
    const declaredCost = dto.cost != null ? new Prisma.Decimal(dto.cost) : null;
    const cost = billingUnit === 'credits' ? null : declaredCost ?? derivedCost;

    // Provenance : source MESURÉE UNIQUEMENT si le secret partagé matche le
    // setting org (jamais depuis le DTO). Un secret manquant/faux → 'self'. Le
    // hint raffine le libellé mesuré : `runtime_log` (collecteur de logs) vs
    // `gateway` (relais sur le fil) — défaut `gateway`.
    let source = 'self';
    if (await this.isGatewayAuthenticated(orgId, gatewaySecret)) {
      source = sourceHint?.trim() === 'runtime_log' ? 'runtime_log' : 'gateway';
    }

    const data = {
      organizationId: orgId,
      agentId: actor.userId,
      taskId: dto.taskId ?? null,
      projectId,
      deliverableId: dto.deliverableId ?? null,
      model,
      tokensIn: dto.tokensIn ?? null,
      tokensOut: dto.tokensOut ?? null,
      cost,
      derivedCost,
      note: dto.note?.trim() || null,
      source,
    };

    // Idempotence : une déclaration de coût = UN livrable. Sans `runKey`
    // explicite, on en dérive un du `deliverableId` → un agent qui rappelle
    // `report_run` pour le MÊME livrable ne double jamais le coût : il reçoit
    // le run existant avec `alreadyDeclared:true` (aucune 2ᵉ ligne, aucune
    // ré-alerte). Une nouvelle VERSION de livrable (après revue humaine
    // « changements demandés » ou CI en échec) porte un nouvel id — donc une
    // nouvelle clé — et une nouvelle déclaration est bien acceptée.
    const runKey =
      dto.runKey?.trim() || (data.deliverableId ? `deliverable:${data.deliverableId}` : null);
    const whereKey = runKey
      ? { organizationId_agentId_runKey: { organizationId: orgId, agentId: actor.userId, runKey } }
      : null;
    const { run, alreadyDeclared } = await (async () => {
      if (!whereKey) {
        return { run: await this.prisma.agentRun.create({ data }), alreadyDeclared: false };
      }
      const existing = await this.prisma.agentRun.findUnique({ where: whereKey });
      if (existing) return { run: existing, alreadyDeclared: true };
      try {
        return {
          run: await this.prisma.agentRun.create({ data: { ...data, runKey } }),
          alreadyDeclared: false,
        };
      } catch (e) {
        // Course concurrente (deux déclarations simultanées de la même clé) :
        // la contrainte unique tranche, on renvoie la déclaration gagnante.
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          return {
            run: await this.prisma.agentRun.findUniqueOrThrow({ where: whereKey }),
            alreadyDeclared: true,
          };
        }
        throw e;
      }
    })();

    // Anti-triche (fire-and-forget, fail-open) : coût déclaré implausiblement
    // bas vs la référence, ou livrable produit « gratuitement ». Alerte l'owner.
    // Les runs 'gateway' sont MESURÉS → aucune anomalie de déclaration.
    // Sur un no-op (coût déjà déclaré pour ce livrable), l'anomalie a déjà été
    // évaluée à la première déclaration : ne pas la rejouer.
    const anomaly = alreadyDeclared
      ? null
      : detectAnomaly({
          hasDeliverable: !!dto.deliverableId,
          tokensTotal: tokensIn + tokensOut,
          declaredCost: declaredCost != null ? Number(declaredCost) : null,
          derivedCost: derivedCost != null ? Number(derivedCost) : null,
          source,
        });
    if (anomaly) {
      void this.hooks()?.onAgentRunReported(orgId, {
        runId: run.id,
        agentId: actor.userId,
        taskId: dto.taskId ?? null,
        projectId,
        reason: anomaly,
        declaredCost: declaredCost != null ? Number(declaredCost) : null,
        derivedCost: derivedCost != null ? Number(derivedCost) : null,
      });
    }

    // Coupe-circuit budgétaire (lot A §2). Les enveloppes n'étaient vérifiées
    // qu'au CLAIM : un agent parti en boucle brûlait tout son budget sur une
    // seule tâche sans que rien ne l'arrête. La déclaration de run est le seul
    // moment où le serveur voit la dépense arriver — c'est donc ici qu'on coupe.
    const budget = await this.budgets
      .snapshot(orgId, actor.userId, { taskId: dto.taskId ?? null, projectId })
      .catch(() => null);
    let taskReleased = false;
    if (!alreadyDeclared && budget?.stop) {
      taskReleased = await this.tripBudgetBreaker(orgId, actor.userId, dto.taskId ?? null, projectId, budget);
    }

    return {
      ...this.toDto(run),
      ...(alreadyDeclared ? { alreadyDeclared: true } : {}),
      ...(budget ? { budget } : {}),
      ...(taskReleased ? { taskReleased: true } : {}),
    };
  }

  /**
   * ESTIMATION du coût d'un agent Copilot (non mesurable : inférence chez
   * Microsoft, jamais routable par la passerelle) à la complétion d'une tâche.
   * On applique la **grille tarifaire Copilot Studio** (crédits/activité,
   * déterministe et publique) à l'activité OBSERVÉE par Vaks + une baseline
   * réglable (part générative non vue), converti en € via le prix crédit.
   *
   * Crée un `AgentRun source='estimated'` (affiché « estimé », jamais « mesuré »).
   * **Opt-in** (`agents.copilotEstimate.enabled`), **idempotent par tâche**
   * (`runKey='estimate:<taskId>'`), **sauté** si un run RÉEL (déclaré/mesuré)
   * existe déjà pour la tâche (le vrai chiffre prime). Fail-open : ne jette
   * jamais (appelé depuis un hook de complétion).
   */
  /** `McpToolUsageService` en lazy (vit dans `McpModule`, non importé ici). */
  private usage(): McpToolUsageService | null {
    try {
      return this.moduleRef.get(McpToolUsageService, { strict: false });
    } catch {
      return null;
    }
  }

  // ============================================================
  // Meter d'appels MCP — coût MESURÉ des agents crédits (Copilot)
  // ============================================================
  //
  // Pour un agent facturé en crédits, Microsoft facture **chaque appel d'outil**
  // (5 crédits/action) + des tours génératifs invisibles (baseline). On ne peut
  // pas mesurer ses tokens → on compte ses appels MCP. Ce meter est **la vérité**
  // pour ces agents : ce qu'ils déclareraient via `vaks_report_run` n'est plus
  // compté (l'outil leur est d'ailleurs masqué). Voir `AGENT_MCP_CALL_METER.md`.
  //
  // Le compteur vit en Redis (INCR par appel, gratuit). On le PERSISTE en une
  // ligne `AgentRun` metered par (agent, tâche/projet), **recalculée** à chaque
  // passage depuis le total cumulé (upsert idempotent — jamais de double compte).
  // Persistance déclenchée aux points naturels (claim, heartbeat, submit, DONE)
  // + un balayage horaire de rattrapage. Le compteur Redis survivant à un crash
  // de l'agent, aucun appel n'est perdu.

  // Caches mémoire (TTL court) : la persistance tourne À CHAQUE APPEL MCP, donc
  // ses lectures (settings, profil agent, membership, task→projet) — toutes
  // stables à la seconde — sont mises en cache pour ne laisser au chemin chaud
  // que l'upsert. Par réplica, staleness ≤ TTL, acceptable pour du bookkeeping.
  private meterCfgCache = new Map<string, { exp: number; cfg: MeterCfg | null }>();
  private memberCache = new Map<string, { exp: number; ok: boolean }>();
  private taskProjCache = new Map<string, { exp: number; projectId: string | null }>();

  /** Config de meter d'un agent (null = pas concerné : non-crédits ou toggle off). */
  private async meterCfg(orgId: string, agentId: string): Promise<MeterCfg | null> {
    const key = `${orgId}:${agentId}`;
    const hit = this.meterCfgCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.cfg;
    let cfg: MeterCfg | null = null;
    const settings = await this.settings.getAll(orgId);
    if (String(settings['agents.copilotEstimate.enabled']) === 'true') {
      const agent = await this.prisma.user.findFirst({
        where: { id: agentId, organizationId: orgId, kind: 'AGENT' },
        select: { modelProvider: true, model: true, costRateInPerKTokens: true },
      });
      if (agent && billingUnitForProvider(agent.modelProvider) === 'credits') {
        const rc = settings['agents.copilotEstimate.rateCard'];
        const rateCard = (
          rc && typeof rc === 'object'
            ? { ...COPILOT_STUDIO_RATE_CARD, ...(rc as Record<string, unknown>) }
            : COPILOT_STUDIO_RATE_CARD
        ) as typeof COPILOT_STUDIO_RATE_CARD;
        const globalPrice = clampNum(settings['agents.copilotEstimate.creditPriceEur'], 0, 0, 1000);
        cfg = {
          baseline: clampNum(settings['agents.copilotEstimate.baselineCreditsPerTask'], 7, 0, 100_000),
          rateCard,
          ratePerK: globalPrice > 0 ? globalPrice : Number(agent.costRateInPerKTokens ?? 0),
          model: agent.model ?? null,
        };
      }
    }
    this.meterCfgCache.set(key, { exp: Date.now() + 30_000, cfg });
    return cfg;
  }

  private async cachedMember(orgId: string, agentId: string, projectId: string): Promise<boolean> {
    const key = `${agentId}:${projectId}`;
    const hit = this.memberCache.get(key);
    if (hit && hit.exp > Date.now()) return hit.ok;
    const ok = await this.isProjectMember(orgId, agentId, projectId);
    this.memberCache.set(key, { exp: Date.now() + 60_000, ok });
    return ok;
  }

  private async cachedTaskProject(orgId: string, taskId: string): Promise<string | null> {
    const hit = this.taskProjCache.get(taskId);
    if (hit && hit.exp > Date.now()) return hit.projectId;
    const task = await this.prisma.task.findFirst({
      where: { id: taskId, organizationId: orgId },
      select: { projectId: true },
    });
    const projectId = task?.projectId ?? null;
    this.taskProjCache.set(taskId, { exp: Date.now() + 60_000, projectId });
    return projectId;
  }

  /** DONE d'une tâche par un agent : persistance finale. On NE vide PAS le compteur
   *  — un appel tardif après DONE le recréerait à 1 et ferait CHUTER la ligne
   *  metered de sa valeur cumulée à ~une action. Le TTL 7 j nettoie de lui-même. */
  async recordEstimatedRun(orgId: string, agentId: string, taskId: string): Promise<void> {
    await this.persistMeteredRun(orgId, agentId, { taskId });
  }

  /** Persiste tous les compteurs d'UN agent (avant un contrôle de budget au claim). */
  async persistAgentMeters(orgId: string, agentId: string): Promise<void> {
    const usage = this.usage();
    if (!usage) return;
    const rows = (await usage.scanAccrued()).filter((r) => r.agentId === agentId);
    for (const r of rows) {
      await this.persistMeteredRun(orgId, agentId, { taskId: r.taskId, projectId: r.projectId });
    }
  }

  /** Balayage de rattrapage (cron horaire) : persiste TOUS les compteurs du tenant. */
  async sweepMeters(orgId: string): Promise<void> {
    const usage = this.usage();
    if (!usage) return;
    for (const r of await usage.scanAccrued()) {
      await this.persistMeteredRun(orgId, r.agentId, { taskId: r.taskId, projectId: r.projectId });
    }
  }

  /**
   * Persiste (upsert) UNE ligne metered depuis le compteur d'appels Redis d'un
   * périmètre. No-op si l'agent n'est pas facturé en crédits, ou si l'estimation
   * Copilot est désactivée pour l'org, ou si le compteur est vide.
   *
   * `ctx` porte soit un `taskId` (row de tâche, avec baseline), soit un
   * `projectId` (overhead projet : exploration ciblée, sans baseline), soit rien
   * (overhead org : `next_task`/`list_*`). La baseline (tours génératifs) ne vaut
   * que pour une TÂCHE.
   */
  async persistMeteredRun(
    orgId: string,
    agentId: string,
    ctx: { taskId?: string | null; projectId?: string | null },
  ): Promise<void> {
    try {
      const usage = this.usage();
      if (!usage) return;
      // Décision de meter (cachée) : null = agent non concerné ou toggle off.
      const cfg = await this.meterCfg(orgId, agentId);
      if (!cfg) return;

      const taskId = ctx.taskId ?? null;
      // Tâche → projet (caché) + garde membership anti-injection (cachée) : un
      // agent ne doit pas imputer sa dépense à un projet dont il n'est pas
      // membre (même raison que `report()`). Un scope non légitime est abandonné
      // (le compteur reste, sans ligne facturée — pas d'imputation cross-projet).
      let projectId = ctx.projectId ?? null;
      if (taskId) projectId = await this.cachedTaskProject(orgId, taskId);
      if (projectId && !(await this.cachedMember(orgId, agentId, projectId))) return;

      const count = await usage.readAccrued(agentId, { taskId, projectId: ctx.projectId ?? null });
      if (count <= 0) return;

      // Baseline (tours génératifs) UNIQUEMENT pour une tâche — l'exploration
      // (project/overhead) n'a pas de tour génératif propre.
      const baseline = taskId ? cfg.baseline : 0;
      const credits =
        Math.round((baseline + estimateCopilotCredits({ agentActions: count }, cfg.rateCard)) * 100) / 100;
      if (credits <= 0) return;

      const costEur = Math.round((credits / 1000) * cfg.ratePerK * 10_000) / 10_000;

      const runKey = taskId
        ? `metered:task:${taskId}`
        : ctx.projectId
          ? `metered:project:${ctx.projectId}`
          : 'metered:overhead';
      const data = {
        organizationId: orgId,
        agentId,
        taskId,
        projectId,
        deliverableId: null,
        model: cfg.model ?? 'copilot-credits',
        tokensIn: Math.round(credits), // crédits (convention : tout dans tokensIn, out=0)
        tokensOut: 0,
        cost: costEur > 0 ? new Prisma.Decimal(costEur) : null,
        derivedCost: null,
        note: taskId ? 'mesuré (appels MCP × grille Copilot)' : 'mesuré (exploration hors tâche)',
        source: 'metered',
      };
      await this.prisma.agentRun.upsert({
        where: { organizationId_agentId_runKey: { organizationId: orgId, agentId, runKey } },
        create: { ...data, runKey },
        update: data,
      });
    } catch (e) {
      this.log.warn(`persistMeteredRun failed: ${(e as Error).message}`);
    }
  }

  /**
   * Enveloppe consommée en cours de tâche : on alerte TOUJOURS (audit + owner de
   * l'agent), et on retire la tâche à l'agent SI l'org a armé le coupe-circuit
   * (`agents.budgetBreaker`).
   *
   * Pourquoi ne pas lever une exception : le run doit rester enregistré (l'argent
   * a été dépensé, on ne l'efface pas d'un 402), et un agent qui vient de payer
   * son travail doit pouvoir le soumettre plutôt que le jeter. L'arrêt passe donc
   * par la réponse (`budget.stop`), pas par une erreur — et le prochain claim est
   * de toute façon refusé par les garde-fous existants.
   *
   * Le retrait reprend la mécanique « poison task » : claim + assignation
   * retirés, la tâche sort du circuit agent et attend une reprise humaine (le
   * travail déjà produit reste attaché à la tâche).
   */
  private async tripBudgetBreaker(
    orgId: string,
    agentId: string,
    taskId: string | null,
    projectId: string | null,
    budget: { exceeded: string[]; envelopes: { scope: string; budget: number; spent: number }[] },
  ): Promise<boolean> {
    const breaker = await this.policies.getBudgetBreaker(orgId).catch(() => false);
    const canRelease = breaker && !!taskId;
    let released = false;
    if (canRelease && taskId) {
      try {
        released = await this.prisma.$transaction(async (tx) => {
          // Conditionné au claimant : on ne retire jamais la tâche de quelqu'un
          // d'autre (un agent peut déclarer un run sur une tâche qu'il ne tient
          // plus — bail expiré, takeover).
          const res = await tx.task.updateMany({
            where: {
              id: taskId,
              organizationId: orgId,
              claimedById: agentId,
              status: { in: [TaskStatus.CLAIMED, TaskStatus.IN_PROGRESS] },
              deletedAt: null,
            },
            data: { claimedById: null, leaseExpiresAt: null },
          });
          if (res.count === 0) return false;
          await tx.taskAssignee
            .deleteMany({ where: { taskId, userId: agentId } })
            .catch(() => undefined);
          return true;
        });
      } catch (err) {
        this.log.warn(`budget breaker on task=${taskId} failed: ${(err as Error).message}`);
      }
    }

    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.AGENT_BUDGET_EXCEEDED,
      // Retirer une tâche à un agent en plein travail est irréversible pour lui.
      severity: released ? 'CRITICAL' : 'WARNING',
      actorType: 'AGENT',
      actorId: agentId,
      resourceType: taskId ? 'task' : 'agent',
      resourceId: taskId ?? agentId,
      detail: {
        projectId,
        exceeded: budget.exceeded,
        envelopes: budget.envelopes,
        breakerEnabled: breaker,
        taskReleased: released,
      },
    });

    // Alerte l'owner humain via le canal automations existant (kind
    // `agent_budget`, déjà traduit ×4 + carte Teams). Qualifier distinct de
    // celui du cron horaire : c'est un événement, pas un seuil périodique.
    void this.hooks()?.onAgentBudgetExceeded(orgId, {
      agentId,
      taskId,
      projectId,
      exceeded: budget.exceeded,
      envelopes: budget.envelopes,
      taskReleased: released,
    });
    return released;
  }

  /**
   * Un agent n'impute un run qu'à un projet auquel il a **accès** — garde-fou
   * anti-injection de coût cross-projet (audit sécu 2026-08-01).
   *
   * Délègue à {@link ProjectAccessService.canAccessProject}, la **source unique
   * de vérité** de l'accès projet (déjà appliquée par `@ProjectAccess` sur
   * claim / update / submit_deliverable). Crucial : elle honore l'**héritage
   * owner→agent** (un agent PAT accède au projet `agentsEnabled` dont son owner
   * humain est membre, sans être matérialisé `ProjectMember`). L'ancienne
   * vérification maison ne comptait que le membership matérialisé de l'agent →
   * un agent qui pouvait claim + soumettre un livrable se voyait refuser
   * `report_run`, créant une impasse avec le prérequis « run avant revue » de
   * `submitForReview` (bug flux agent PAT, 2026-08-20). `isAdmin=false` : un
   * agent n'est jamais admin **global** (kind=AGENT ; `isAgentAdmin` est un
   * grant de gestion, pas le flag global). L'anti-injection tient : un agent
   * dont l'owner n'est pas dans le projet cible n'y a pas accès → run refusé.
   */
  private async isProjectMember(orgId: string, userId: string, projectId: string): Promise<boolean> {
    return this.projectAccess.canAccessProject(orgId, userId, false, projectId);
  }

  /**
   * Vrai si le run est authentifié comme venant de la passerelle LLM : un secret
   * non vide fourni ET égal au setting org `agents.gateway.sharedSecret`. Toute
   * défaillance (setting absent, lecture KO) → false (retombe sur 'self').
   */
  private async isGatewayAuthenticated(orgId: string, provided?: string | null): Promise<boolean> {
    if (!provided?.trim()) return false;
    try {
      const all = await this.settings.getAll(orgId);
      const expected = typeof all['agents.gateway.sharedSecret'] === 'string'
        ? (all['agents.gateway.sharedSecret'] as string)
        : '';
      return resolveRunSource(provided, expected) === 'gateway';
    } catch {
      return false;
    }
  }

  /** Hooks automations en lazy (évite un cycle de modules ; fail-open). */
  private hooks(): AutomationsHooksService | null {
    try {
      return this.moduleRef.get(AutomationsHooksService, { strict: false });
    } catch {
      return null;
    }
  }

  /**
   * Journal de TOUS les runs d'agent de l'organisation — le pendant du journal
   * d'audit, côté consommation IA.
   *
   * La synthèse par agent existait déjà, mais il n'y avait aucune vue
   * transverse : impossible de répondre à « qu'est-ce que l'IA a coûté ce
   * mois-ci, sur quels projets, et est-ce que quelque chose cloche ». Filtres
   * cumulatifs (agent, projet, période, anomalies), pagination par offset —
   * l'ordre est stable (`createdAt desc, id desc`) et les volumes se comptent en
   * milliers, pas en millions comme l'audit : un curseur keyset serait du zèle.
   *
   * `anomaliesOnly` rejoue le même détecteur qu'à l'écriture plutôt que de
   * stocker un drapeau : la règle peut évoluer sans migration, et l'historique
   * est relu avec la règle courante.
   */
  async list(
    orgId: string,
    q: {
      agentId?: string;
      projectId?: string;
      from?: string;
      to?: string;
      anomaliesOnly?: boolean;
      page?: number;
      pageSize?: number;
    },
  ) {
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    const pageSize = Math.min(200, Math.max(1, Math.floor(Number(q.pageSize) || 50)));
    const where: Prisma.AgentRunWhereInput = { organizationId: orgId };
    if (q.agentId) where.agentId = q.agentId;
    if (q.projectId) where.projectId = q.projectId;
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from ? { gte: new Date(q.from) } : {}),
        // `to` est une DATE côté UI : on inclut la journée entière.
        ...(q.to ? { lt: new Date(new Date(q.to).getTime() + 86_400_000) } : {}),
      };
    }

    // L'anomalie n'est pas une colonne stockée : elle se recalcule à la lecture
    // (cf. commentaire de classe). Une passe scalaire SANS pagination sur le
    // périmètre filtré donne (a) le set d'ids anomalie pour scoper `anomaliesOnly`
    // correctement — auparavant filtré APRÈS la pagination, ce qui faussait le
    // total et la page affichée — et (b) le compteur KPI org-wide, indépendant du
    // toggle. Les volumes de runs restent en milliers (cf. commentaire de
    // méthode), donc ce passage scalaire reste bon marché.
    const scalarRows = await this.prisma.agentRun.findMany({
      where,
      select: { id: true, cost: true, derivedCost: true, tokensIn: true, tokensOut: true, deliverableId: true, source: true },
    });
    const anomalousIds = scalarRows
      .filter((r) =>
        detectAnomaly({
          hasDeliverable: !!r.deliverableId,
          tokensTotal: (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
          declaredCost: r.cost != null ? Number(r.cost) : null,
          derivedCost: r.derivedCost != null ? Number(r.derivedCost) : null,
          source: r.source,
        }),
      )
      .map((r) => r.id);
    const scopedWhere: Prisma.AgentRunWhereInput = q.anomaliesOnly
      ? { ...where, id: { in: anomalousIds } }
      : where;

    const [rows, total, agg] = await Promise.all([
      this.prisma.agentRun.findMany({
        where: scopedWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.agentRun.count({ where: scopedWhere }),
      this.prisma.agentRun.aggregate({
        where: scopedWhere,
        _sum: { cost: true, tokensIn: true, tokensOut: true, derivedCost: true },
      }),
    ]);

    // Libellés résolus en une passe (agents + projets + tâches de la page).
    const [agents, projects, tasks] = await Promise.all([
      this.labelUsers(orgId, rows.map((r) => r.agentId)),
      this.labelProjects(orgId, rows.map((r) => r.projectId)),
      this.labelTasks(orgId, rows.map((r) => r.taskId)),
    ]);

    const items = rows.map((r) => {
      const anomaly = detectAnomaly({
        hasDeliverable: !!r.deliverableId,
        tokensTotal: (r.tokensIn ?? 0) + (r.tokensOut ?? 0),
        declaredCost: r.cost != null ? Number(r.cost) : null,
        derivedCost: r.derivedCost != null ? Number(r.derivedCost) : null,
        source: r.source,
      });
      const task = r.taskId ? tasks.get(r.taskId) : null;
      return {
        ...this.toDto(r),
        agentName: agents.get(r.agentId) ?? null,
        projectName: r.projectId ? (projects.get(r.projectId) ?? null) : null,
        taskTitle: task?.title ?? null,
        taskNumber: task?.number ?? null,
        anomaly,
      };
    });

    return {
      items,
      page,
      pageSize,
      total,
      /** Totaux sur le PÉRIMÈTRE FILTRÉ (et sur `anomaliesOnly` si actif), pas sur la page affichée. */
      totals: {
        cost: Math.round(Number(agg._sum.cost ?? 0) * 10000) / 10000,
        tokensIn: agg._sum.tokensIn ?? 0,
        tokensOut: agg._sum.tokensOut ?? 0,
        derivedCost: Math.round(Number(agg._sum.derivedCost ?? 0) * 10000) / 10000,
      },
      /** Toujours sur agent/projet/période — indépendant du toggle `anomaliesOnly`. */
      anomalyCount: anomalousIds.length,
    };
  }

  private async labelUsers(orgId: string, ids: (string | null)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((v): v is string => !!v))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.user.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async labelProjects(orgId: string, ids: (string | null)[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter((v): v is string => !!v))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.project.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, name: true },
    });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async labelTasks(
    orgId: string,
    ids: (string | null)[],
  ): Promise<Map<string, { title: string; number: number }>> {
    const uniq = [...new Set(ids.filter((v): v is string => !!v))];
    if (!uniq.length) return new Map();
    const rows = await this.prisma.task.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, title: true, number: true },
    });
    return new Map(rows.map((r) => [r.id, { title: r.title, number: r.number }]));
  }

  /** Synthèse d'usage d'un agent (lecture admin `agent:manage`). */
  async summaryForAgent(orgId: string, agentId: string) {
    const agent = await this.prisma.user.findFirst({
      where: { id: agentId, organizationId: orgId, kind: 'AGENT' },
      select: { id: true },
    });
    if (!agent) throw new NotFoundException('Agent introuvable');

    const runs = await this.prisma.agentRun.findMany({
      where: { organizationId: orgId, agentId },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    const costByTask = new Map<string, number>();
    for (const r of runs) {
      const c = toNum(r.cost) ?? 0;
      totalCost += c;
      totalTokensIn += r.tokensIn ?? 0;
      totalTokensOut += r.tokensOut ?? 0;
      if (r.taskId) costByTask.set(r.taskId, (costByTask.get(r.taskId) ?? 0) + c);
    }
    const taskCosts = [...costByTask.values()].filter((v) => v > 0);
    return {
      agentId,
      runCount: runs.length,
      totalTokensIn,
      totalTokensOut,
      totalCost: Math.round(totalCost * 10000) / 10000,
      avgCostPerRun: runs.length ? Math.round((totalCost / runs.length) * 10000) / 10000 : null,
      avgCostPerTask: taskCosts.length
        ? Math.round((taskCosts.reduce((a, b) => a + b, 0) / taskCosts.length) * 10000) / 10000
        : null,
      runs: runs.slice(0, 50).map((r) => this.toDto(r)),
    };
  }

  private toDto(r: {
    id: string;
    agentId: string;
    taskId: string | null;
    projectId: string | null;
    deliverableId: string | null;
    model: string | null;
    tokensIn: number | null;
    tokensOut: number | null;
    cost: Prisma.Decimal | null;
    derivedCost?: Prisma.Decimal | null;
    runKey?: string | null;
    note: string | null;
    source?: string | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      agentId: r.agentId,
      taskId: r.taskId,
      projectId: r.projectId,
      deliverableId: r.deliverableId,
      model: r.model,
      tokensIn: r.tokensIn,
      tokensOut: r.tokensOut,
      cost: toNum(r.cost),
      derivedCost: r.derivedCost != null ? toNum(r.derivedCost) : null,
      runKey: r.runKey ?? null,
      note: r.note,
      source: r.source ?? 'self',
      createdAt: r.createdAt.toISOString(),
    };
  }
}
