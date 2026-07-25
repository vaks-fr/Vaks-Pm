import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { BackupTokenGuard } from './backup-token.guard';
import { BackupAlertService } from './backup-alert.service';
import { SkipAudit } from '../audit-logs/audited.decorator';

/**
 * Endpoints d'exploitation appelés par les scripts d'infrastructure côté hôte
 * (cron de sauvegarde). Volontairement **hors** `@PublicApi` : exclus de la doc
 * et de la frontière jeton (un PAT/clé org ne peut pas les atteindre). Joignables
 * via Traefik (le host n'est pas sur l'overlay), protégés par `X-Backup-Token`.
 *
 * Le contexte tenant est résolu par le `TenantMiddleware` depuis le Host de la
 * requête (`ALERT_WEBHOOK` pointe sur le sous-domaine de l'org à notifier).
 */
@Controller('ops')
@UseGuards(BackupTokenGuard)
@SkipAudit()
export class OpsController {
  constructor(private readonly backupAlerts: BackupAlertService) {}

  /**
   * Signal d'échec de sauvegarde émis par `infra/backup/_common.sh` :
   * `{ event:"backup.failed", host, message, tier? }`. → audit + email admins +
   * webhook `backup.failed`.
   */
  @Post('backup-alert')
  async backupAlert(
    @Body() body: { event?: string; host?: string; message?: string; tier?: string },
  ) {
    if (!body?.host && !body?.message) return { ok: false };
    return this.backupAlerts.handleFailure({
      host: body.host ?? 'unknown',
      message: body.message ?? 'unspecified error',
      tier: body.tier ?? null,
    });
  }
}
