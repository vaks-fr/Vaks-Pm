import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { LicenseService } from '../licensing/license.service';
import { AuditLogService } from './audit-log.service';
import { AUDIT_ACTIONS } from './audit-actions';
import { getAuditSyslogQueue } from './audit-syslog-queue';

/**
 * Détection d'anomalies sur le journal d'audit — premier cas : brute-force
 * (N `auth.login.failure` sur un même compte dans une fenêtre glissante).
 *
 * Déclenchée à chaud par AuthService après chaque échec journalisé. Quand le
 * seuil est franchi :
 *   1. email à chaque admin global (template `security_alert`) ;
 *   2. webhook org `audit.alert` (Teams/SIEM/automation) ;
 *   3. entrée d'audit `audit.alert` (l'alerte est elle-même tracée).
 *
 * Anti-spam : lock Redis `vaks:audit-alert:<org>:<userId>` (SET NX EX 3600)
 * → une alerte max par compte et par heure, cluster-wide.
 *
 * Invariant : **fail-open intégral** — aucune erreur ici ne doit remonter
 * jusqu'au flux de login.
 */
@Injectable()
export class AuditAlertsService {
  private readonly log = new Logger(AuditAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditLogService,
    private readonly licenses: LicenseService,
  ) {}

  /** À appeler après chaque échec de login journalisé (fire-and-forget). */
  async checkLoginFailures(
    orgId: string,
    userId: string,
    email: string,
    ip?: string | null,
  ): Promise<void> {
    try {
      const cfg = await this.settings.getAuditAlertLoginFailures(orgId);
      if (!cfg.enabled) return;
      // Alerting brute-force = feature premium `audit-advanced`. Fail-open :
      // hors licence, aucune alerte n'est levée (le login reste intact).
      if (!(await this.licenses.hasFeature('audit-advanced'))) return;

      const since = new Date(Date.now() - cfg.windowMinutes * 60_000);
      const failures = await this.prisma.auditLog.count({
        where: {
          organizationId: orgId,
          action: AUDIT_ACTIONS.AUTH_LOGIN_FAILURE,
          actorId: userId,
          createdAt: { gte: since },
        },
      });
      if (failures < cfg.threshold) return;

      // Cooldown distribué : une alerte par compte et par heure.
      const redis = await getAuditSyslogQueue().client;
      const ok = await (redis as unknown as {
        set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
      }).set(`vaks:audit-alert:${orgId}:${userId}`, '1', 'EX', 3600, 'NX');
      if (ok !== 'OK') return;

      const payload = {
        targetEmail: email,
        failures,
        windowMinutes: cfg.windowMinutes,
        ip: ip ?? null,
      };

      // 1. Email aux admins globaux actifs.
      const admins = await this.prisma.user.findMany({
        where: { organizationId: orgId, isAdmin: true, deletedAt: null, status: 'ACTIVE' },
        select: { email: true, name: true, preferredLanguage: true },
      });
      for (const a of admins) {
        try {
          await this.notifications.sendSecurityAlert(orgId, a.email, a.name, payload, a.preferredLanguage);
        } catch (err) {
          this.log.warn(`security alert mail to ${a.email} failed: ${(err as Error).message}`);
        }
      }

      // 2. Webhook org (Teams / automation / SIEM push).
      void this.webhooks.dispatch(orgId, 'audit.alert', {
        kind: 'login_failures',
        ...payload,
        at: new Date().toISOString(),
      });

      // 3. L'alerte est elle-même un fait d'audit.
      void this.audit.logCritical({
        organizationId: orgId,
        action: AUDIT_ACTIONS.AUDIT_ALERT,
        actorType: 'SYSTEM',
        resourceType: 'user',
        resourceId: userId,
        resourceLabel: email,
        ip: ip ?? undefined,
        detail: { kind: 'login_failures', failures, windowMinutes: cfg.windowMinutes },
      });

      this.log.warn(
        `Alerte brute-force org=${orgId} compte=${email} (${failures} échecs/${cfg.windowMinutes}min)`,
      );
    } catch (err) {
      // Fail-open : l'alerting ne casse jamais le login.
      this.log.error(`checkLoginFailures failed: ${(err as Error).message}`);
    }
  }
}
