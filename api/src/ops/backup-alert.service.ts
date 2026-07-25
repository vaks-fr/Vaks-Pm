import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';

export interface BackupFailureInput {
  /** Hostname du nœud DB ayant signalé l'échec. */
  host: string;
  /** Message d'erreur du script de sauvegarde. */
  message: string;
  /** Palier concerné (logical / base / wal…), optionnel. */
  tier?: string | null;
}

/**
 * Traite un signal `backup.failed` émis par les scripts de sauvegarde host-side
 * (`infra/backup/_common.sh` → POST `/ops/backup-alert`). Triple effet, calqué
 * sur `AuditAlertsService` :
 *   1. entrée d'audit CRITICAL `backup.failed` (→ visible UI + forward SIEM) ;
 *   2. email à chaque admin global actif (template `backup_failed`) ;
 *   3. webhook org `backup.failed` (Teams / automation).
 *
 * Le contexte tenant (donc l'org) est déjà posé par le `TenantMiddleware` à
 * partir du Host de la requête (mode pooled) ou de la base unique (dedicated).
 * Fail-safe : aucune étape ne fait échouer la réponse — on accuse réception même
 * en cas d'erreur partielle, le script host ne doit jamais boucler là-dessus.
 */
@Injectable()
export class BackupAlertService {
  private readonly log = new Logger(BackupAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly audit: AuditLogService,
  ) {}

  async handleFailure(input: BackupFailureInput): Promise<{ ok: boolean }> {
    const host = String(input.host || 'unknown').slice(0, 200);
    const message = String(input.message || 'unspecified error').slice(0, 2000);
    const tier = input.tier ? String(input.tier).slice(0, 60) : null;
    const at = new Date().toISOString();

    const org = await this.prisma.organization.findFirst({ select: { id: true } });
    if (!org) {
      this.log.warn('backup.failed reçu mais aucune organisation dans le contexte tenant');
      return { ok: false };
    }
    const orgId = org.id;

    // 1. Fait d'audit (immédiat, forwardé SIEM si configuré).
    void this.audit.logCritical({
      organizationId: orgId,
      action: AUDIT_ACTIONS.BACKUP_FAILED,
      actorType: 'SYSTEM',
      resourceType: 'backup',
      resourceLabel: host,
      detail: { host, tier, message },
    });

    // 2. Email aux admins globaux actifs.
    const admins = await this.prisma.user.findMany({
      where: { organizationId: orgId, isAdmin: true, deletedAt: null, status: 'ACTIVE' },
      select: { email: true, name: true, preferredLanguage: true },
    });
    for (const a of admins) {
      try {
        await this.notifications.sendBackupAlert(orgId, a.email, a.name, {
          host,
          message,
          tier,
          at,
        }, a.preferredLanguage);
      } catch (err) {
        this.log.warn(`backup alert mail to ${a.email} failed: ${(err as Error).message}`);
      }
    }

    // 3. Webhook org (Teams / automation / SIEM push).
    void this.webhooks.dispatch(orgId, 'backup.failed', { host, tier, message, at });

    this.log.warn(`Alerte backup.failed org=${orgId} host=${host}${tier ? ` tier=${tier}` : ''}`);
    return { ok: true };
  }
}
