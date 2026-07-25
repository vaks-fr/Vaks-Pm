import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AdminSettingsService } from '../admin/admin-settings.service';
import { readNotificationsSettings, readSmtpSettings } from './notifications-settings';
import { InternalTokenGuard } from './internal-token.guard';

/**
 * Endpoints internes pour le worker BullMQ. Pas de JWT user — auth via header
 * `X-Worker-Token`. Ne JAMAIS exposer via Traefik (route interne overlay only).
 *
 * Le worker a besoin de :
 *  - lire la conf SMTP courante (host/port/auth/encryption + from/replyTo)
 *  - mettre à jour le statut d'une ligne EmailDelivery après tentative SMTP
 */
@Controller('internal/notifications')
@UseGuards(InternalTokenGuard)
export class NotificationsInternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: AdminSettingsService,
  ) {}

  /**
   * Conf SMTP courante (pour une org donnée — pour l'instant on prend la première
   * org car la stack est mono-tenant ; quand on passera multi-tenant, le worker
   * devra passer `?orgId=`).
   */
  @Get('smtp')
  async getSmtp(@Query('orgId') orgId?: string) {
    const id = orgId ?? (await this.firstOrgId());
    if (!id) return { smtp: null, notifications: null };
    const all = await this.settings.getAll(id);
    return {
      smtp: readSmtpSettings(all),
      notifications: readNotificationsSettings(all),
    };
  }

  /** MAJ statut d'envoi. Appelé par le worker après `transporter.sendMail`. */
  @Patch('deliveries/:id')
  async updateDelivery(
    @Param('id') id: string,
    @Body() body: { status: 'SENT' | 'FAILED'; error?: string | null },
  ) {
    const data: { status: 'SENT' | 'FAILED'; error: string | null; sentAt?: Date } = {
      status: body.status,
      error: body.error ?? null,
    };
    if (body.status === 'SENT') data.sentAt = new Date();
    await this.prisma.emailDelivery.update({ where: { id }, data });
    return { ok: true };
  }

  private async firstOrgId(): Promise<string | null> {
    const row = await this.prisma.organization.findFirst({ select: { id: true } });
    return row?.id ?? null;
  }
}
