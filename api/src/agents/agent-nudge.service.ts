import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { TaskStatus } from '@db';
import { isIP } from 'node:net';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { getEmailQueue } from '../notifications/email-queue';
import { getAgentNudgeQueue } from './agent-nudge-queue';
import { computeRoom, RoomVerdict } from './agent-nudge-capacity';
import { AgentBudgetService } from './agent-budget.service';
import { PolicyEngineService } from './policy-engine.service';
// ⚠️ **`import type` OBLIGATOIRE ici, jamais un import de valeur.**
//
// Ces trois services sont en cycle avec celui-ci (agent-dispatch → tasks →
// agent-nudge ; automations → … → tasks → agent-nudge). Un import de valeur
// crée une arête de chargement : `agent-dispatch.js` est alors évalué avant que
// `tasks.js` ait fini de s'initialiser, donc le `design:paramtypes` de
// `AgentDispatchService` capture `undefined` pour `TasksService` et Nest refuse
// de démarrer (« Nest can't resolve dependencies of the AgentDispatchService
// (PrismaService, ?, PolicyEngineService) »). Vécu en prod, api 0/2.
//
// `import type` disparaît à la compilation → aucune arête. La résolution se
// fait à l'appel par **token string** (cf. `AGENT_NUDGE_LAZY_TOKENS`), enregistré
// en alias `useExisting` par le module propriétaire de chaque service.
import type { AgentDispatchService } from './agent-dispatch.service';
import type { AutomationActionsService } from '../automations/automation-actions.service';
import type { AutomationRecipientsService } from '../automations/automation-recipients.service';

/**
 * Tokens d'injection différée. Le module qui possède le service en enregistre
 * l'alias (`{ provide: <token>, useExisting: <Class> }`) ; ici on ne connaît que
 * la chaîne, donc aucun import de valeur n'est nécessaire.
 */
export const LAZY_AGENT_DISPATCH = 'LAZY_AGENT_DISPATCH';
export const LAZY_AUTOMATION_ACTIONS = 'LAZY_AUTOMATION_ACTIONS';
export const LAZY_AUTOMATION_RECIPIENTS = 'LAZY_AUTOMATION_RECIPIENTS';

/** Statuts « l'agent tient la tâche » — même ensemble que le 409 `BUDGET_CONCURRENCY` au claim. */
const ACTIVE_STATUSES: TaskStatus[] = [
  TaskStatus.CLAIMED,
  TaskStatus.IN_PROGRESS,
  TaskStatus.CHANGES_REQUESTED,
];

/**
 * Réservation de slot **atomique** (AGENT_NUDGE_CAPACITY.md §4).
 *
 * Sans ce script, le calcul de `room` est un *read-compute-write* : trois hooks
 * de reprise qui partent en même temps (un PM qui approuve 3 tâches d'affilée)
 * lisent tous « 0 réservation », concluent tous « 3 slots libres » et envoient
 * 9 nudges pour 3 slots. Le `ZCARD` **à l'intérieur** du script voit les
 * réservations concurrentes → les appels se sérialisent proprement.
 *
 * Le score du membre est son instant d'expiration : les réservations mortes sont
 * purgées à chaque passage (un nudge qui n'a jamais abouti à un claim ne bloque
 * pas un slot éternellement).
 */
const RESERVE_LUA = `
local now = tonumber(ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[4])
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[5]))
return 1
`;

/**
 * Durée de vie d'une réservation non consommée (secondes).
 *
 * Généreux **par construction** : un claim réussi libère le slot immédiatement
 * (`consumeSlot`), donc un TTL long ne coûte jamais de sous-utilisation — il ne
 * sert qu'à nettoyer les réveils qui n'ont mené à rien. Trop court, en revanche,
 * ferait expirer la réservation avant que l'agent n'ait eu le temps de claim
 * (démarrage du flow + tours LLM + allers-retours MCP), donc sur-envoi et
 * crédits gaspillés. En cas de doute : allonger.
 */
const RESERVATION_TTL_S = 600;

/** Events qui peuvent réveiller un agent (assignation + boucle de revue). */
export const NUDGE_EVENTS = [
  'task.assigned',
  'task.changes_requested',
  'comment.created',
] as const;
export type NudgeEvent = (typeof NUDGE_EVENTS)[number];

/**
 * Sujet **sentinelle** d'un abonnement **org-level** : un seul callback qui
 * reçoit les nudges de TOUS les agents de l'org (registré par une clé org).
 * Stocké dans la colonne `agentUserId` (pas de FK → une valeur non-uuid est
 * légale) → une souscription org par org, sans changement de schéma. Un vrai
 * agent a un `agentUserId` = son userId ; l'org a cette sentinelle.
 */
export const ORG_NUDGE_SUBJECT = '__org__';

interface SubscribeDto {
  callbackUrl: string;
  events?: string[];
}

/**
 * Nudge sortant vers les agents IA (chantier « réveil sur assignation »).
 *
 * Deux responsabilités :
 *  1. **Souscription self-provisionnée** : un provider enregistre son URL de
 *     callback via `POST /me/webhook-subscriptions` avec le PAT de l'agent. La
 *     souscription est liée à l'identité de l'agent (`agentUserId`).
 *  2. **Émission** : sur `task.assigned` / `task.changes_requested` /
 *     `comment.created`, résout le(s) agent(s) sujet(s) de l'event, vérifie
 *     `Project.agentsEnabled` + souscription active, puis enfile un job de
 *     livraison. Le payload est un **signal sans autorité** — l'agent tire et
 *     claim atomiquement ensuite.
 *
 * Le routage est par **sujet de l'event** (assigné / claimant / agent de la
 * tâche), volontairement séparé du `WebhooksService.dispatch` (routage par
 * scope org/projet/équipe).
 */
@Injectable()
export class AgentNudgeService {
  private readonly log = new Logger(AgentNudgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantCtx: TenantContext,
    private readonly webhooks: WebhooksService,
    private readonly config: ConfigService,
    private readonly settings: AdminSettingsService,
    private readonly audit: AuditLogService,
    private readonly budgets: AgentBudgetService,
    private readonly policies: PolicyEngineService,
    private readonly moduleRef: ModuleRef,
  ) {}

  // ============================================================
  // Résolutions lazy (anti-cycles)
  // ============================================================
  //
  // Ce service est `@Global` et injecté par `TasksService` ; il ne peut donc pas
  // injecter directement ce qui dépend de `TasksService` (cycle) ni le moteur
  // d'automatisations (qui importe Workload/Finance). Même motif que les hooks
  // `automationHooks()` / `watchers()` de `TasksService`.

  /** Résolution par token string — `null` si le module n'est pas chargé. */
  private lazy<T>(token: string): T | null {
    try {
      return this.moduleRef.get<T>(token, { strict: false });
    } catch {
      return null;
    }
  }

  private dispatch(): AgentDispatchService | null {
    return this.lazy<AgentDispatchService>(LAZY_AGENT_DISPATCH);
  }

  private automationActions(): AutomationActionsService | null {
    return this.lazy<AutomationActionsService>(LAZY_AUTOMATION_ACTIONS);
  }

  private automationRecipients(): AutomationRecipientsService | null {
    return this.lazy<AutomationRecipientsService>(LAZY_AUTOMATION_RECIPIENTS);
  }

  // ============================================================
  // Mode on-prem : callbacks internes (double-gate + CIDR approuvés)
  // ============================================================

  /**
   * Double-gate opérateur : les callbacks LAN ne sont autorisés QUE si le
   * déploiement est `dedicated` OU l'env `ALLOW_INTERNAL_NUDGE_CALLBACKS=true`.
   * Le SaaS pooled par défaut reste strict (default-deny).
   */
  internalCallbacksEnabled(): boolean {
    const mode = this.config.get<{ mode?: string }>('deployment')?.mode;
    return mode === 'dedicated' || process.env.ALLOW_INTERNAL_NUDGE_CALLBACKS === 'true';
  }

  /** CIDR internes approuvés à appliquer — [] si le gate est fermé (default-deny). */
  private async gatedInternalCidrs(orgId: string): Promise<string[]> {
    if (!this.internalCallbacksEnabled()) return [];
    return this.settings.getInternalNudgeCidrs(orgId);
  }

  /** Statut + CIDR pour l'admin (l'éditeur affiche si le gate est actif). */
  async internalCidrsStatus(orgId: string) {
    return {
      enabled: this.internalCallbacksEnabled(),
      cidrs: await this.settings.getInternalNudgeCidrs(orgId),
    };
  }

  /** Valide le format puis persiste les CIDR + entrée d'audit (CRITICAL). */
  async setInternalCidrs(orgId: string, cidrs: string[], actorId: string) {
    const cleaned = (cidrs ?? []).map((c) => String(c).trim()).filter(Boolean);
    for (const c of cleaned) {
      const m = c.match(/^(.+)\/(\d+)$/);
      const fam = m ? isIP(m[1]) : 0;
      const prefix = m ? Number(m[2]) : NaN;
      const ok = m && ((fam === 4 && prefix >= 0 && prefix <= 32) || (fam === 6 && prefix >= 0 && prefix <= 128));
      if (!ok) throw new BadRequestException(`CIDR invalide : « ${c} » (attendu X.X.X.X/XX).`);
    }
    await this.prisma.orgSetting.upsert({
      where: { organizationId_key: { organizationId: orgId, key: 'nudge.internalCallbackCidrs' } },
      update: { value: cleaned as never },
      create: { organizationId: orgId, key: 'nudge.internalCallbackCidrs', value: cleaned as never },
    });
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.SETTINGS_UPDATED,
      actorId,
      resourceType: 'orgSetting',
      resourceId: 'nudge.internalCallbackCidrs',
      resourceLabel: 'Nudge — CIDR internes approuvés',
      detail: { key: 'nudge.internalCallbackCidrs', cidrs: cleaned },
    });
    return { cidrs: cleaned };
  }

  // ============================================================
  // Souscription (self-only, appelée par le controller /me)
  // ============================================================

  /** Upsert la souscription de l'agent. Réutilise la gouvernance d'URL webhook. */
  async subscribe(orgId: string, agentUserId: string, dto: SubscribeDto) {
    const url = (dto?.callbackUrl ?? '').trim();
    if (!url) throw new BadRequestException('callbackUrl requis');
    // Gouvernance : http(s), port allowlist, anti-SSRF, domain/tenant allowlist.
    // En mode on-prem gaté, les CIDR internes approuvés relâchent l'anti-SSRF.
    await this.webhooks.validateExternalUrl(orgId, url, await this.gatedInternalCidrs(orgId));
    const events = this.sanitizeEvents(dto.events);
    const secret = randomBytes(32).toString('base64url');
    const sub = await this.prisma.agentWebhookSubscription.upsert({
      where: { organizationId_agentUserId: { organizationId: orgId, agentUserId } },
      create: { organizationId: orgId, agentUserId, callbackUrl: url, secret, events, active: true },
      update: {
        callbackUrl: url,
        secret,
        events,
        active: true,
        consecutiveFailures: 0,
        autoDisabledAt: null,
      },
    });
    // Le secret n'est renvoyé qu'ici (idiome show-once des ApiToken).
    return { ...this.toSelfDto(sub), secret };
  }

  /**
   * Désactive la souscription courante du sujet **sans id** — cible d'unsubscribe
   * STATIQUE pour les triggers qui exigent une URI d'unsubscribe fixe au design
   * (Logic Apps `HttpWebhook` / Copilot). Idempotent.
   */
  async unsubscribeCurrent(orgId: string, agentUserId: string) {
    await this.prisma.agentWebhookSubscription.updateMany({
      where: { organizationId: orgId, agentUserId, active: true },
      data: { active: false },
    });
    return { ok: true };
  }

  /** Désactive la souscription. Self-only + idempotent (jamais 404 au teardown). */
  async unsubscribe(orgId: string, agentUserId: string, id: string) {
    const sub = await this.prisma.agentWebhookSubscription.findFirst({
      where: { id, organizationId: orgId, agentUserId },
      select: { id: true, active: true },
    });
    if (sub?.active) {
      await this.prisma.agentWebhookSubscription.update({
        where: { id: sub.id },
        data: { active: false },
      });
    }
    return { ok: true };
  }

  /** La souscription courante de l'agent (sans secret), ou null. */
  async mySubscription(orgId: string, agentUserId: string) {
    const sub = await this.prisma.agentWebhookSubscription.findUnique({
      where: { organizationId_agentUserId: { organizationId: orgId, agentUserId } },
    });
    return sub ? this.toSelfDto(sub) : null;
  }

  // ============================================================
  // Gate de capacité (AGENT_NUDGE_CAPACITY.md §3-4)
  // ============================================================

  private slotsKey(agentId: string): string {
    return `vaks:nudge:slots:${this.tenantCtx.currentSlug() ?? '_'}:${agentId}`;
  }

  /**
   * Ids des agents de l'org. `Task.claimedById` est un **scalaire sans relation**
   * (choix de découplage du schéma) → impossible de filtrer `claimedBy.kind` en
   * Prisma ; on résout le petit ensemble des agents puis on filtre par `in`.
   */
  private async agentIds(orgId: string): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { organizationId: orgId, kind: 'AGENT' },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  /**
   * Combien de réveils cet agent peut recevoir maintenant, et qui le bloque.
   *
   * ⚠️ `reservations: 0` est **voulu** : la valeur renvoyée est le budget TOTAL
   * de slots en vol, et c'est le script Lua qui compare le `ZCARD` réel à ce
   * budget (atomiquement). Compter les réservations ici en plus les
   * déduirait deux fois.
   */
  private async roomFor(
    orgId: string,
    agent: { id: string; maxConcurrentTasks: number | null; dailyRunBudget: number | null },
    projectId: string,
  ): Promise<RoomVerdict> {
    const [activeTasks, backpressureMax, agentIds, maxParallel] = await Promise.all([
      this.prisma.task.count({
        where: {
          organizationId: orgId,
          deletedAt: null,
          status: { in: ACTIVE_STATUSES },
          assignees: { some: { userId: agent.id } },
        },
      }),
      this.policies.getBackpressureMax(orgId),
      this.agentIds(orgId),
      this.settings.getNudgeMaxParallel(orgId),
    ]);

    // Backpressure : seules les tâches **produites par des agents** consomment la
    // capacité de revue qu'on protège. Une file de relecture entre humains ne
    // doit pas bloquer les agents (cf. §3.1).
    const inReviewByAgents = agentIds.length
      ? await this.prisma.task.count({
          where: {
            organizationId: orgId,
            projectId,
            deletedAt: null,
            status: TaskStatus.IN_REVIEW,
            claimedById: { in: agentIds },
          },
        })
      : 0;

    return computeRoom({
      maxConcurrentTasks: agent.maxConcurrentTasks,
      activeTasks,
      reservations: 0,
      backpressureMax,
      inReviewByAgents,
      budgetExhausted: await this.budgetExhausted(orgId, agent, projectId),
      maxParallel,
    });
  }

  /**
   * Enveloppes de coût atteintes, ou budget de revendications du jour épuisé —
   * les deux refusent le claim (`TasksService.claim`). Réveiller un agent dans
   * cet état lui fait démarrer une conversation facturée pour rien.
   */
  private async budgetExhausted(
    orgId: string,
    agent: { id: string; dailyRunBudget: number | null },
    projectId: string,
  ): Promise<boolean> {
    const snap = await this.budgets.snapshot(orgId, agent.id, { projectId });
    if (snap.stop) return true;
    if (agent.dailyRunBudget == null) return false;
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const claimsToday = await this.prisma.taskStatusHistory.count({
      where: {
        organizationId: orgId,
        changedById: agent.id,
        toStatus: TaskStatus.CLAIMED,
        changedAt: { gte: since },
      },
    });
    return claimsToday >= agent.dailyRunBudget;
  }

  /** Réserve UN slot si le budget le permet. `false` = ne pas envoyer de nudge. */
  private async reserveSlot(agentId: string, budget: number): Promise<boolean> {
    if (budget <= 0) return false;
    try {
      const redis = (await getEmailQueue().client) as unknown as {
        eval: (...args: unknown[]) => Promise<unknown>;
      };
      const now = Date.now();
      const res = await redis.eval(
        RESERVE_LUA,
        1,
        this.slotsKey(agentId),
        String(now),
        String(now + RESERVATION_TTL_S * 1000),
        String(budget),
        `${now}-${randomBytes(4).toString('hex')}`,
        String(RESERVATION_TTL_S),
      );
      return Number(res) === 1;
    } catch (err) {
      // Fail-open EXPLICITE : une panne Redis ne doit pas priver les agents de
      // travail. On retombe sur le comportement d'avant le gate (le claim, lui,
      // refusera toujours ce qui doit l'être).
      this.log.warn(`reserveSlot(${agentId}) failed, letting through: ${(err as Error).message}`);
      return true;
    }
  }

  /**
   * Consomme un slot réservé — appelé au **claim réussi** d'un agent.
   *
   * C'est la pièce qui rend le TTL non critique : sans elle, un slot resterait
   * compté à la fois comme réservation ET comme tâche active jusqu'à expiration,
   * et l'agent serait sous-utilisé. On ne cherche pas *quelle* réservation :
   * c'est un compteur de réveils en vol, un claim en consomme un (`ZPOPMIN`).
   */
  async consumeSlot(agentId: string): Promise<void> {
    try {
      const redis = (await getEmailQueue().client) as unknown as {
        zpopmin: (k: string, c: number) => Promise<unknown>;
      };
      await redis.zpopmin(this.slotsKey(agentId), 1);
    } catch {
      /* fail-open : la réservation expirera d'elle-même (TTL). */
    }
  }

  /**
   * Réveille un agent dont la capacité vient de se libérer (approbation,
   * clôture, release, poison). Recalcule `room`, réserve, et envoie **un nudge
   * par tâche distincte** du haut du classement — le choix des tâches reste
   * entièrement côté serveur (`rankCandidates`), le nudge ne dit jamais quoi
   * prendre.
   *
   * Fire-and-forget : ne jette jamais.
   */
  async resumeAgent(orgId: string, agentId: string | null | undefined): Promise<void> {
    if (!agentId) return;
    try {
      if (!(await this.settings.getNudgeCapacityGating(orgId))) return;
      const agent = await this.prisma.user.findFirst({
        where: { id: agentId, organizationId: orgId, kind: 'AGENT' },
        select: { id: true, email: true, name: true, maxConcurrentTasks: true, dailyRunBudget: true },
      });
      if (!agent) return; // id d'humain (takeover, release par un PM) → no-op

      const dispatch = this.dispatch();
      if (!dispatch) return;
      const { ranked } = await dispatch.rankClaimable(orgId, agent.id, 'AGENT');
      if (ranked.length === 0) return;

      // Le room est recalculé PAR projet (le backpressure est projet-scoped) :
      // on regroupe les candidates par projet et on sert projet par projet.
      const seenProjects = new Map<string, number>();
      for (const cand of ranked) {
        let budget = seenProjects.get(cand.projectId);
        if (budget === undefined) {
          budget = (await this.roomFor(orgId, agent, cand.projectId)).room;
          seenProjects.set(cand.projectId, budget);
        }
        if (budget <= 0) continue;
        if (!(await this.reserveSlot(agent.id, budget))) continue;
        await this.deliverNudge(orgId, 'task.assigned', agent, cand.id, cand.projectId);
      }
    } catch (err) {
      this.log.warn(`resumeAgent(${agentId}) failed: ${(err as Error).message}`);
    }
  }

  /** Alerte « file de revue du projet pleine » — cause PROJET, pas agent (§6). */
  private async notifyReviewQueueFull(orgId: string, projectId: string, agentName: string) {
    try {
      const [actions, recipients] = [this.automationActions(), this.automationRecipients()];
      if (!actions || !recipients) return;
      const [project, pms] = await Promise.all([
        this.prisma.project.findFirst({
          where: { id: projectId, organizationId: orgId },
          select: { name: true },
        }),
        recipients.projectPMs(projectId),
      ]);
      if (!pms.length) return;
      await actions.emit(orgId, {
        kind: 'review_queue_full',
        // Keyé sur le PROJET : deux agents bloqués par la même file, c'est UN
        // problème et une seule alerte — pas une notif par owner.
        entityId: projectId,
        qualifier: new Date().toISOString().slice(0, 10),
        recipients: pms,
        params: {
          projectName: project?.name ?? '',
          userName: agentName,
          pct: await this.policies.getBackpressureMax(orgId),
        },
        projectId,
      });
    } catch (err) {
      this.log.warn(`notifyReviewQueueFull(${projectId}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Alerte « budget épuisé » — réutilise le kind `agent_budget` existant avec
   * les vrais chiffres de l'enveloppe dépassée (pas de kind supplémentaire, pas
   * de paramètres inventés).
   */
  private async notifyBudgetBlocked(
    orgId: string,
    agent: { id: string; name: string; ownerId?: string | null },
    projectId: string,
  ) {
    try {
      const [actions, recipients] = [this.automationActions(), this.automationRecipients()];
      if (!actions || !recipients) return;
      const [snap, currency] = await Promise.all([
        this.budgets.snapshot(orgId, agent.id, { projectId }),
        this.settings.getCurrency(orgId).catch(() => 'EUR'),
      ]);
      const hit = snap.envelopes.find((e) => snap.exceeded.includes(e.scope));
      if (!hit) return;
      const to = await recipients.agentSupervisors(orgId, agent.ownerId ?? null);
      if (!to.length) return;
      const money = (n: number) => `${Math.round(n * 100) / 100} ${currency}`;
      await actions.emit(orgId, {
        kind: 'agent_budget',
        entityId: agent.id,
        // Qualifier distinct de la règle 19 (qui alerte AVANT le blocage) :
        // celle-ci signale que des réveils sont effectivement supprimés.
        qualifier: `${hit.scope}:nudge_blocked:${new Date().toISOString().slice(0, 10)}`,
        recipients: to,
        params: {
          scope: `${agent.name} (${hit.scope})`,
          pct: hit.budget > 0 ? Math.round((hit.spent / hit.budget) * 100) : 100,
          amount: money(hit.spent),
          budget: money(hit.budget),
        },
        projectId,
      });
    } catch (err) {
      this.log.warn(`notifyBudgetBlocked(${agent.id}) failed: ${(err as Error).message}`);
    }
  }

  // ============================================================
  // Émission (appelée par TasksService / CommentsService)
  // ============================================================

  async nudgeTaskAssigned(
    orgId: string,
    task: { id: string; projectId: string },
    addedUserIds: string[],
  ): Promise<void> {
    await this.resolveAndEnqueue(orgId, 'task.assigned', {
      taskId: task.id,
      projectId: task.projectId,
      candidateUserIds: addedUserIds,
    });
  }

  async nudgeChangesRequested(
    orgId: string,
    task: { id: string; projectId: string },
    claimantUserId: string | null,
  ): Promise<void> {
    if (!claimantUserId) return;
    await this.resolveAndEnqueue(orgId, 'task.changes_requested', {
      taskId: task.id,
      projectId: task.projectId,
      candidateUserIds: [claimantUserId],
    });
  }

  async nudgeCommentCreated(orgId: string, comment: { taskId: string }): Promise<void> {
    // Le DTO commentaire ne porte pas les assignés → on recharge la tâche.
    const task = await this.prisma.task.findFirst({
      where: { id: comment.taskId, organizationId: orgId },
      select: {
        id: true,
        projectId: true,
        claimedById: true,
        assignees: { select: { userId: true } },
      },
    });
    if (!task) return;
    const candidates = [task.claimedById, ...task.assignees.map((a) => a.userId)];
    await this.resolveAndEnqueue(orgId, 'comment.created', {
      taskId: task.id,
      projectId: task.projectId,
      candidateUserIds: candidates.filter((x): x is string => !!x),
    });
  }

  /**
   * Résout les agents destinataires et enfile un nudge par (agent, event).
   * Fire-and-forget : ne jette jamais (silence les erreurs pour ne pas casser
   * la mutation métier appelante).
   */
  private async resolveAndEnqueue(
    orgId: string,
    event: NudgeEvent,
    ctx: { taskId: string | null; projectId: string | null; candidateUserIds: string[] },
  ): Promise<void> {
    try {
      const uniq = [...new Set(ctx.candidateUserIds.filter(Boolean))];
      if (uniq.length === 0 || !ctx.projectId) return;

      // Gate d'activation : le projet doit avoir agentsEnabled=true.
      const proj = await this.prisma.project.findFirst({
        where: { id: ctx.projectId, organizationId: orgId },
        select: { agentsEnabled: true },
      });
      if (!proj?.agentsEnabled) return;

      // Candidats réellement AGENT (email/nom résolus pour le dispatch côté
      // provider — un Switch sur l'email est plus lisible qu'un uuid).
      const agents = await this.prisma.user.findMany({
        where: { id: { in: uniq }, organizationId: orgId, kind: 'AGENT' },
        select: {
          id: true, email: true, name: true, ownerId: true,
          maxConcurrentTasks: true, dailyRunBudget: true,
        },
      });
      if (agents.length === 0) return;

      const gating = await this.settings.getNudgeCapacityGating(orgId);

      // Souscriptions actives : per-agent (ciblées) + org-level (tous agents,
      // un seul callback registré par une clé org).
      const [perAgent, orgSub] = await Promise.all([
        this.prisma.agentWebhookSubscription.findMany({
          where: { organizationId: orgId, agentUserId: { in: agents.map((a) => a.id) }, active: true },
        }),
        this.prisma.agentWebhookSubscription.findFirst({
          where: { organizationId: orgId, agentUserId: ORG_NUDGE_SUBJECT, active: true },
        }),
      ]);
      if (perAgent.length === 0 && !orgSub) return;
      const perAgentByUser = new Map(perAgent.map((s) => [s.agentUserId, s]));

      // Mode on-prem : CIDR internes approuvés (gatés) passés au worker pour que
      // safe-fetch autorise les IP privées matchantes. [] hors mode = strict.
      const allowedInternalCidrs = await this.gatedInternalCidrs(orgId);

      for (const agent of agents) {
        const targets: typeof perAgent = [];
        const pa = perAgentByUser.get(agent.id);
        if (pa && this.eventMatches(pa.events, event)) targets.push(pa);
        if (orgSub && this.eventMatches(orgSub.events, event)) targets.push(orgSub);
        if (targets.length === 0) continue;

        // Gate de capacité : UNE réservation par réveil logique, même si
        // plusieurs souscriptions doivent en être informées.
        if (gating) {
          const verdict = await this.roomFor(orgId, agent, ctx.projectId);
          if (verdict.room <= 0) {
            // On ne notifie que sur les causes qui ne se résolvent pas seules.
            if (verdict.blocker === 'backpressure') {
              void this.notifyReviewQueueFull(orgId, ctx.projectId, agent.name);
            } else if (verdict.blocker === 'budget') {
              void this.notifyBudgetBlocked(orgId, agent, ctx.projectId);
            }
            continue;
          }
          if (!(await this.reserveSlot(agent.id, verdict.room))) continue;
        }

        for (const sub of targets) {
          await this.deliverNudge(orgId, event, agent, ctx.taskId, ctx.projectId, sub.id, allowedInternalCidrs);
        }
      }
    } catch (err) {
      this.log.warn(`nudge(${event}) failed: ${(err as Error).message}`);
    }
  }

  /**
   * Écrit la livraison et enfile le job. Le slot est supposé **déjà réservé**
   * par l'appelant — ce helper ne décide de rien.
   *
   * Sans `subscriptionId` (chemin reprise), livre à toutes les souscriptions
   * actives concernées : per-agent et/ou org-level.
   */
  private async deliverNudge(
    orgId: string,
    event: NudgeEvent,
    agent: { id: string; email: string | null; name: string | null },
    taskId: string | null,
    projectId: string | null,
    subscriptionId?: string,
    allowedInternalCidrs?: string[],
  ): Promise<void> {
    const cidrs = allowedInternalCidrs ?? (await this.gatedInternalCidrs(orgId));
    let subIds: string[];
    if (subscriptionId) {
      subIds = [subscriptionId];
    } else {
      const subs = await this.prisma.agentWebhookSubscription.findMany({
        where: {
          organizationId: orgId,
          active: true,
          agentUserId: { in: [agent.id, ORG_NUDGE_SUBJECT] },
        },
        select: { id: true, events: true },
      });
      subIds = subs.filter((s) => this.eventMatches(s.events, event)).map((s) => s.id);
    }
    if (subIds.length === 0) return;

    const queue = getAgentNudgeQueue();
    const tenantSlug = this.tenantCtx.currentSlug();
    for (const subId of subIds) {
      const payload = {
        event,
        taskId,
        projectId,
        agentId: agent.id,
        agentEmail: agent.email,
        agentName: agent.name,
      };
      const delivery = await this.prisma.agentNudgeDelivery.create({
        data: {
          organizationId: orgId,
          subscriptionId: subId,
          agentUserId: agent.id,
          event,
          taskId,
          projectId,
          payload,
        },
      });
      await queue.add('nudge', {
        deliveryId: delivery.id,
        subscriptionId: subId,
        organizationId: orgId,
        event,
        taskId,
        projectId,
        agentId: agent.id,
        agentEmail: agent.email ?? null,
        agentName: agent.name ?? null,
        allowedInternalCidrs: cidrs,
        tenantSlug,
      });
    }
  }

  // ============================================================
  // Vue admin (visibilité)
  // ============================================================

  async listSubscriptionsForAdmin(orgId: string) {
    const subs = await this.prisma.agentWebhookSubscription.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
    });
    const names = await this.agentNames(orgId, subs.map((s) => s.agentUserId));
    return subs.map((s) => ({
      ...this.toSelfDto(s),
      scope: s.agentUserId === ORG_NUDGE_SUBJECT ? 'ORG' : 'AGENT',
      agentName:
        s.agentUserId === ORG_NUDGE_SUBJECT
          ? 'Tous les agents (org)'
          : names.get(s.agentUserId) ?? null,
    }));
  }

  async listDeliveriesForAdmin(orgId: string, limit = 100) {
    const rows = await this.prisma.agentNudgeDelivery.findMany({
      where: { organizationId: orgId },
      orderBy: { queuedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
    const names = await this.agentNames(orgId, rows.map((r) => r.agentUserId));
    return rows.map((r) => ({
      id: r.id,
      agentUserId: r.agentUserId,
      agentName: names.get(r.agentUserId) ?? null,
      event: r.event,
      taskId: r.taskId,
      projectId: r.projectId,
      status: r.status,
      responseStatus: r.responseStatus,
      error: r.error,
      attemptCount: r.attemptCount,
      queuedAt: r.queuedAt.toISOString(),
      deliveredAt: r.deliveredAt?.toISOString() ?? null,
    }));
  }

  /** Admin : (ré)active ou désactive une souscription. Réactiver reset le streak. */
  async setActiveForAdmin(orgId: string, id: string, active: boolean) {
    const sub = await this.prisma.agentWebhookSubscription.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true },
    });
    if (!sub) throw new BadRequestException('Souscription introuvable');
    const updated = await this.prisma.agentWebhookSubscription.update({
      where: { id: sub.id },
      data: active
        ? { active: true, consecutiveFailures: 0, autoDisabledAt: null }
        : { active: false },
    });
    return this.toSelfDto(updated);
  }

  // ============================================================
  // Helpers
  // ============================================================

  private sanitizeEvents(events?: string[]): string[] {
    if (!events || events.length === 0) return []; // [] = tous les events de nudge
    if (events.includes('*')) return [];
    const set = new Set<string>(NUDGE_EVENTS);
    const kept = events.filter((e) => set.has(e));
    return [...new Set(kept)];
  }

  private eventMatches(events: string[], event: string): boolean {
    return events.length === 0 || events.includes('*') || events.includes(event);
  }

  private async agentNames(orgId: string, ids: string[]): Promise<Map<string, string>> {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (uniq.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: uniq }, organizationId: orgId },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private toSelfDto(sub: {
    id: string;
    agentUserId: string;
    callbackUrl: string;
    events: string[];
    active: boolean;
    consecutiveFailures: number;
    autoDisabledAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: sub.id,
      agentUserId: sub.agentUserId,
      // Host seul, jamais l'URL complète ni le secret (anti-fuite dans l'UI/API).
      callbackHost: this.hostOf(sub.callbackUrl),
      events: sub.events,
      active: sub.active,
      consecutiveFailures: sub.consecutiveFailures,
      autoDisabledAt: sub.autoDisabledAt?.toISOString() ?? null,
      createdAt: sub.createdAt.toISOString(),
      updatedAt: sub.updatedAt.toISOString(),
    };
  }

  private hostOf(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return '';
    }
  }
}
