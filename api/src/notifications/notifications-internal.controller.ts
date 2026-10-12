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
   * Conf SMTP courante de l'org (première org de la base courante — en pooled
   * le tenant est posé par `X-Tenant-Slug` ; `?orgId=` pour cibler).
   *
   * Le mot de passe SMTP (chiffré at-rest dans OrgSetting) est renvoyé ICI,
   * déchiffré, au worker — route overlay-only + `X-Worker-Token`. C'est le seul
   * canal : l'API ne l'embarque plus dans le payload des jobs BullMQ (Redis sans
   * auth, persistant, jobs failed conservés = secret de tous les tenants en
   * clair). Le worker le garde en mémoire (cache 60 s par tenant).
   */
  @Get('smtp')
  async getSmtp(@Query('orgId') orgId?: string) {
    const id = orgId ?? (await this.firstOrgId());
    if (!id) return { smtp: null, notifications: null };
    const all = await this.settings.getAll(id);
    const smtp = readSmtpSettings(all);
    const password =
      smtp.authMode === 'password'
        ? await this.settings.getDecryptedSecret(id, 'smtp.password').catch(() => '')
        : '';
    return {
      smtp: { ...smtp, password: password || null },
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
