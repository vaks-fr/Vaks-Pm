import { Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { TenantUrlService } from '../tenancy/tenant-url.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { getEmailQueue } from '../notifications/email-queue';
import {
  isQuietHour,
  readNotificationsSettings,
} from '../notifications/notifications-settings';
import { renderAutomationAlert, TemplateContext } from '../notifications/email-templates';
import { AutomationKind, COOLDOWN_TTL_S } from './automation-rules';
import { automationMessage, AutomationMessageParams } from './automations-i18n';
import { WatchersService } from './watchers.service';
// `import type` : RisksModule ne dépend JAMAIS d'AutomationsModule (sens
// unique automations → risks), donc RiskAutoService est résolu en LAZY par
// token de classe (ModuleRef, `strict:false`) — même patron que
// `automations-hooks.service.ts` pour TasksService/AgentRunsService. Un
// import de valeur créerait une dépendance de module inutile (RisksModule
// n'a aucune raison d'être importé ici) sans même risquer de cycle réel,
// mais on garde le même filet fail-open que le reste du chokepoint `emit`.
import type { RiskAutoService } from '../risks/risk-auto.service';
import { LAZY_RISK_AUTO } from '../risks/risk-auto.tokens';

/** Destinataire résolu (voir AutomationRecipientsService). */
export interface AutomationRecipient {
  id: string;
  name: string;
  email: string;
  preferredLanguage: string | null;
}

export interface AutomationAlert {
  kind: AutomationKind;
  /** Entité concernée (taskId, projectId, userId…) — partie de la clé de cooldown. */
  entityId: string;
  /** Qualificatif optionnel de la clé de cooldown (palier « :80 », semaine ISO…). */
  qualifier?: string;
  recipients: AutomationRecipient[];
  params: AutomationMessageParams;
  taskId?: string | null;
  projectId?: string | null;
  teamId?: string | null;
  /** URL du CTA de l'email et de la carte. */
  url?: string | null;
}

export type EmitOutcome = 'sent' | 'cooldown' | 'deferred' | 'error';

/** Détail d'une mutation automatique, pour la trace d'audit. */
export interface AutomationMutation {
  kind: AutomationKind;
  resourceType: 'task' | 'project';
  resourceId: string;
  resourceLabel?: string | null;
  field: string;
  before: unknown;
  after: unknown;
}

/**
 * Chokepoint unique d'émission d'une alerte d'automatisation. Généralise le
 * pipeline de `AuditAlertsService` :
 *
 *   cooldown Redis (SET NX EX) → emails destinataires → webhook
 *   `automation.alert` (les webhooks `format:'teams'` rendent la carte) →
 *   entrée d'audit `actorType:'SYSTEM'`.
 *
 * Gating email : kill switch `notif.enabled` (emails seulement — le webhook
 * et l'audit partent quand même) ; quiet hours = report INTÉGRAL de l'alerte
 * (retour avant la pose du cooldown, la condition persistante re-déclenche au
 * tick suivant). ⚠️ un `dailyHour` placé dans les quiet hours supprime les
 * règles quotidiennes — mentionné dans la desc du setting admin.
 *
 * Invariant : **fail-open** — aucune erreur ne remonte à l'appelant.
 */
@Injectable()
export class AutomationActionsService {
  private readonly log = new Logger(AutomationActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditLogService,
    private readonly watchers: WatchersService,
    private readonly tenantUrl: TenantUrlService,
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

  /**
   * Watchers de la tâche / du projet visé, en destinataires additionnels.
   * Résolu ICI (au chokepoint) et pas dans chaque règle : toute règle portant
   * un `taskId`/`projectId` touche donc ses abonnés sans avoir à y penser.
   */
  private async watcherRecipients(
    orgId: string,
    alert: AutomationAlert,
  ): Promise<AutomationRecipient[]> {
    if (!alert.taskId && !alert.projectId) return [];
    const ids = await this.watchers.watchersOf(orgId, {
      taskId: alert.taskId,
      projectId: alert.projectId,
    });
    if (!ids.length) return [];
    return this.prisma.user.findMany({
      where: {
        id: { in: ids },
        organizationId: orgId,
        kind: 'HUMAN',
        status: 'ACTIVE',
        deletedAt: null,
      },
      select: { id: true, name: true, email: true, preferredLanguage: true },
    });
  }

  async emit(orgId: string, alert: AutomationAlert): Promise<EmitOutcome> {
    // Auto-feed du registre de risques (RisksModule) — AVANT le early-return
    // quiet hours/cooldown ci-dessous, pour que la condition persistante
    // rafraîchisse le registre à CHAQUE évaluation qui la retrouve vraie,
    // même quand l'email/webhook est en cooldown ou en heures calmes. Upsert
    // idempotent (cf. RiskAutoService) : coût DB négligeable, aucun doublon.
    // Fail-open (try/catch interne au service), ne bloque jamais l'émission.
    void this.riskAuto()?.reconcileFromAlert(orgId, alert);

    try {
      const prefs = readNotificationsSettings(await this.settings.getAll(orgId));

      // Quiet hours : on reporte TOUT (email + webhook), sans consommer le
      // cooldown — le tick suivant retentera.
      const hour = new Date().getUTCHours();
      if (isQuietHour(hour, prefs.quietHoursStart, prefs.quietHoursEnd)) {
        return 'deferred';
      }

      // Cooldown distribué, cluster-wide (même connexion Redis que la queue email).
      const redis = await getEmailQueue().client;
      const key = `vaks:auto:${alert.kind}:${orgId}:${alert.entityId}${alert.qualifier ? `:${alert.qualifier}` : ''}`;
      const ok = await (redis as unknown as {
        set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
      }).set(key, '1', 'EX', COOLDOWN_TTL_S[alert.kind], 'NX');
      if (ok !== 'OK') return 'cooldown';

      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { name: true },
      });
      const orgName = org?.name ?? 'Vaks';

      // 1. Emails (si le kill switch notifications l'autorise). Les watchers
      // s'ajoutent aux destinataires métier ; la dédup par adresse plus bas
      // évite le doublon quand un PM suit aussi sa propre tâche.
      if (prefs.enabled) {
        const audience = [...alert.recipients, ...(await this.watcherRecipients(orgId, alert))];
        const seen = new Set<string>();
        const persistedIds = new Set<string>();
        for (const r of audience) {
          const email = r.email.toLowerCase();
          if (seen.has(email)) continue;
          seen.add(email);
          try {
            const lang = await this.notifications.resolveRecipientLanguage(orgId, r.preferredLanguage);
            const msg = automationMessage(alert.kind, lang, alert.params);
            // Cloche durable : une ligne par destinataire (dédup par userId, la
            // dédup email plus haut n'empêchant pas un doublon d'id théorique).
            if (r.id && !persistedIds.has(r.id)) {
              persistedIds.add(r.id);
              await this.notifications.persistAndPush(orgId, r.id, {
                kind: 'automation',
                title: msg.heading,
                body: msg.text,
                taskId: alert.taskId ?? undefined,
                projectId: alert.projectId ?? undefined,
                url: alert.url ?? undefined,
                meta: { automationKind: alert.kind },
              });
            }
            const ctx: TemplateContext = {
              recipientName: r.name,
              orgName,
              lang,
              // Origine du TENANT courant (pas l'APP_URL global — en pooled il
              // vaut `http://localhost` et produirait des liens morts).
              appUrl: this.tenantUrl.publicBaseUrl(),
              branding: {
                fromName: prefs.fromName,
                accentColor: prefs.accentColor,
                logoUrl: prefs.logoUrl,
              },
            };
            const rendered = renderAutomationAlert(ctx, {
              heading: msg.heading,
              subject: msg.subject,
              bodyHtml: msg.bodyHtml,
              text: msg.text,
              ctaLabel: alert.url ? msg.ctaLabel : undefined,
              ctaUrl: alert.url ?? undefined,
            });
            await this.notifications.enqueue(orgId, r.email, 'automation', rendered, prefs);
          } catch (err) {
            this.log.warn(`automation mail to ${r.email} failed: ${(err as Error).message}`);
          }
        }
      }

      // 2. Webhook org/projet/équipe (cartes Teams via format:'teams').
      const wire = automationMessage(alert.kind, 'en', alert.params);
      void this.webhooks.dispatch(
        orgId,
        'automation.alert',
        {
          kind: alert.kind,
          title: wire.heading,
          message: wire.text,
          taskId: alert.taskId ?? null,
          projectId: alert.projectId ?? null,
          url: alert.url ?? null,
          at: new Date().toISOString(),
        },
        { projectId: alert.projectId ?? null, teamId: alert.teamId ?? null },
      );

      // 3. Trace d'audit — l'alerte est un fait système.
      this.audit.log({
        organizationId: orgId,
        action: AUDIT_ACTIONS.AUTOMATION_ALERT,
        actorType: 'SYSTEM',
        resourceType: alert.taskId ? 'task' : alert.projectId ? 'project' : 'org',
        resourceId: alert.taskId ?? alert.projectId ?? orgId,
        resourceLabel: alert.params.taskTitle ?? alert.params.projectName ?? null,
        detail: {
          kind: alert.kind,
          recipients: alert.recipients.length,
          ...(alert.qualifier ? { qualifier: alert.qualifier } : {}),
        },
      });

      return 'sent';
    } catch (err) {
      this.log.error(`emit(${alert.kind}) failed: ${(err as Error).message}`);
      return 'error';
    }
  }

  /**
   * Trace une mutation faite par le moteur. À appeler APRÈS l'écriture (via le
   * service métier, jamais Prisma direct — voir les règles de mutation).
   *
   * Séparé de `emit` : une mutation n'est pas une alerte. Elle n'a ni
   * destinataire ni cooldown propre (c'est la règle qui l'a décidée qui porte
   * le cooldown) — seulement une trace, pour qu'un changement non demandé par
   * un humain reste explicable dans le journal.
   */
  logMutation(orgId: string, m: AutomationMutation): void {
    try {
      this.audit.log({
        organizationId: orgId,
        action: AUDIT_ACTIONS.AUTOMATION_MUTATION,
        actorType: 'SYSTEM',
        resourceType: m.resourceType,
        resourceId: m.resourceId,
        resourceLabel: m.resourceLabel ?? null,
        detail: { kind: m.kind, field: m.field, before: m.before, after: m.after },
      });
    } catch (err) {
      this.log.warn(`logMutation(${m.kind}) failed: ${(err as Error).message}`);
    }
  }
}
