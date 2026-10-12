import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantConnectionService } from '../tenancy/tenant-connection.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { getEmailQueue } from '../notifications/email-queue';
import { readAutomationsSettings } from './automations-settings';
import { AutomationsEvaluatorService, RunCounters } from './automations-evaluator.service';
import { RecurringTasksService } from './recurring-tasks.service';
import { AgentNudgeService, ORG_NUDGE_SUBJECT } from '../agents/agent-nudge.service';
import { AutomationsHooksService } from './automations-hooks.service';
// `import type` : même patron que `automation-actions.service.ts` (résolution
// lazy par token, aucun import de valeur RisksModule → AutomationsModule).
import type { RiskAutoService } from '../risks/risk-auto.service';
import { LAZY_RISK_AUTO } from '../risks/risk-auto.tokens';

/** Péremption des risques AUTO sans condition re-déclenchée (§ RiskAutoService.reapStale). */
const RISK_REAP_STALE_DAYS = 14;

const HOUR_MS = 60 * 60 * 1000;

/**
 * Cron du moteur d'automatisations — même squelette que
 * `NotificationsCronService` : setInterval natif 1 h, lock Redis distribué
 * par heure UTC, énumération des bases tenant en pooled.
 *
 * Cadences :
 *  - règles quotidiennes : exécutées au tick dont l'heure UTC == le
 *    `automations.dailyHour` de l'org (gate par org, pas global) ;
 *  - règles horaires / hebdo / récurrence : lots suivants.
 *
 * Le cooldown Redis par (règle, entité) dans `AutomationActionsService` rend
 * les ré-exécutions idempotentes (un tick admin forcé + le tick planifié ne
 * doublonnent pas).
 */
@Injectable()
export class AutomationsCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(AutomationsCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly evaluator: AutomationsEvaluatorService,
    private readonly recurring: RecurringTasksService,
    private readonly tenancy: TenancyService,
    private readonly conn: TenantConnectionService,
    private readonly tenantCtx: TenantContext,
    private readonly nudge: AgentNudgeService,
    // Même module (AutomationsModule) → injection directe sans cycle.
    private readonly hooks: AutomationsHooksService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /** `RiskAutoService` en lazy (cf. commentaire d'import : sens de dépendance). */
  private riskAuto(): RiskAutoService | null {
    try {
      return this.moduleRef.get<RiskAutoService>(LAZY_RISK_AUTO, { strict: false });
    } catch {
      return null;
    }
  }

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.tick();
    }, HOUR_MS);
    setTimeout(() => void this.tick(), 90_000);
    this.log.log('Automations cron armed (1h interval).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    const client = await getEmailQueue().client;
    const lockKey = `vaks:auto-cron:${new Date().toISOString().slice(0, 13)}`; // par heure UTC
    const ok = await (client as unknown as {
      set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
    }).set(lockKey, '1', 'EX', 3300, 'NX');
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

  /** Traite toutes les orgs de la base courante (contexte tenant déjà posé). */
  private async processAllOrgs(): Promise<void> {
    const now = new Date();
    const hour = now.getUTCHours();
    // Jour ISO : lundi = 1 … dimanche = 7 (le setting `weekday` suit la même
    // convention que le reste de l'app).
    const weekday = now.getUTCDay() || 7;
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      try {
        const s = readAutomationsSettings(await this.settings.getAll(org.id));
        if (!s.enabled) continue;

        // Horaire : budgets agent + livrables en attente (latence courte).
        const h = await this.evaluator.runHourlyRules(org.id, s);
        this.report(org.id, 'hourly', h);

        // Rattrapage des réveils d'agents (AGENT_NUDGE_CAPACITY.md §7) : un
        // nudge peut avoir été supprimé (capacité pleine au moment de l'event),
        // perdu (webhook en échec) ou réservé sans jamais aboutir à un claim.
        // `resumeAgent` re-vérifie la capacité et ne fait rien s'il n'y a pas de
        // travail — coût nul quand tout va bien.
        void this.resumeIdleAgents(org.id);

        // Backstop du meter d'appels MCP (AGENT_MCP_CALL_METER.md) : persiste les
        // compteurs d'agents crédits qu'aucun claim/heartbeat/submit n'a matérialisés
        // (tâche abandonnée sans retour de l'agent). Le compteur Redis survit au
        // crash, donc rien n'est perdu ; ce balayage ne fait que rattraper la trace.
        void this.hooks.sweepAgentMeters(org.id);

        // Matérialisation des tâches récurrentes (gate propre : `recurrence.enabled`).
        if (s.recurrenceEnabled) {
          const n = await this.recurring.materialize(org.id, now);
          if (n) this.log.log(`recurrence org=${org.id}: ${n} tâche(s) créée(s)`);
        }

        if (hour === s.dailyHour) {
          const c = await this.evaluator.runDailyRules(org.id, s);
          this.report(org.id, 'daily', c);

          // Réconciliation « condition levée » du registre de risques AUTO
          // (RiskAutoService.reapStale) : cadence quotidienne, best-effort,
          // fire-and-forget — ne bloque jamais le reste du tick.
          void this.riskAuto()?.reapStale(org.id, RISK_REAP_STALE_DAYS);
        }
        // Règles hebdo : même jour+heure pour les deux (le rappel timesheet
        // porte le réglage, l'overtime et l'occupation suivent la même cadence
        // — ce sont des constats de fin de semaine).
        if (weekday === s.timesheetReminder.weekday && hour === s.timesheetReminder.hour) {
          const c = await this.evaluator.runWeeklyRules(org.id, s);
          this.report(org.id, 'weekly', c);
        }
      } catch (err) {
        this.log.warn(`tick org=${org.id} failed: ${(err as Error).message}`);
      }
    }
  }

  /**
   * Re-réveille les agents qui ont une souscription de nudge active et du
   * travail en attente. Filet de sécurité du chemin événementiel : sans lui, un
   * agent dont le nudge a été supprimé faute de capacité resterait endormi
   * jusqu'à la prochaine mutation sur une de ses tâches.
   *
   * Fire-and-forget, jamais bloquant pour le reste du tick.
   */
  private async resumeIdleAgents(orgId: string): Promise<void> {
    try {
      const subs = await this.prisma.agentWebhookSubscription.findMany({
        where: { organizationId: orgId, active: true },
        select: { agentUserId: true },
      });
      // Une souscription org-level (sentinelle `__org__`) ne désigne pas un
      // agent : on énumère alors tous les agents de l'org.
      const hasOrgSub = subs.some((s) => s.agentUserId === ORG_NUDGE_SUBJECT);
      const ids = hasOrgSub
        ? (
            await this.prisma.user.findMany({
              where: { organizationId: orgId, kind: 'AGENT', status: 'ACTIVE', deletedAt: null },
              select: { id: true },
            })
          ).map((u) => u.id)
        : subs.map((s) => s.agentUserId).filter((id) => id !== ORG_NUDGE_SUBJECT);

      for (const agentId of [...new Set(ids)]) {
        await this.nudge.resumeAgent(orgId, agentId);
      }
    } catch (err) {
      this.log.warn(`resumeIdleAgents(org=${orgId}) failed: ${(err as Error).message}`);
    }
  }

  private report(orgId: string, kind: 'hourly' | 'daily' | 'weekly', c: RunCounters): void {
    if (!c.sent && !c.capped) return;
    this.log.log(
      `${kind} rules org=${orgId}: sent=${c.sent} cooldown=${c.cooldown} deferred=${c.deferred} capped=${c.capped}`,
    );
  }

  /**
   * Exécution forcée pour UNE org (route admin de test) — ignore les gates de
   * cadence (`dailyHour`, jour hebdo), pas le kill switch ni les cooldowns.
   * `scope` permet de ne déclencher qu'une famille (`weekly` évalue la semaine
   * ISO échue, pas la semaine en cours).
   */
  async runNowForOrg(
    orgId: string,
    scope: 'hourly' | 'daily' | 'weekly' | 'all' = 'daily',
  ): Promise<RunCounters & { enabled: boolean }> {
    const s = readAutomationsSettings(await this.settings.getAll(orgId));
    if (!s.enabled) return { enabled: false, sent: 0, cooldown: 0, deferred: 0, capped: 0 };
    const total: RunCounters = { sent: 0, cooldown: 0, deferred: 0, capped: 0 };
    if (scope === 'hourly' || scope === 'all') {
      this.add(total, await this.evaluator.runHourlyRules(orgId, s));
      // La route de test doit exercer exactement ce que fait le tick planifié,
      // récurrence comprise — sinon elle donnerait une fausse assurance.
      if (s.recurrenceEnabled) {
        total.sent += await this.recurring.materialize(orgId, new Date());
      }
    }
    if (scope === 'daily' || scope === 'all') {
      this.add(total, await this.evaluator.runDailyRules(orgId, s));
    }
    if (scope === 'weekly' || scope === 'all') {
      this.add(total, await this.evaluator.runWeeklyRules(orgId, s));
    }
    return { enabled: true, ...total };
  }

  private add(into: RunCounters, from: RunCounters): void {
    into.sent += from.sent;
    into.cooldown += from.cooldown;
    into.deferred += from.deferred;
    into.capped += from.capped;
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
    // `\_` = underscore littéral (sinon `_` est un joker LIKE).
    const rows = await this.prisma.$queryRawUnsafe<{ datname: string }[]>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${dbName}\\_%'`,
    );
    return rows.map((r) => r.datname.slice(dbName.length + 1)).filter(Boolean);
  }
}
