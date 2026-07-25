import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalTokenGuard } from '../notifications/internal-token.guard';

/**
 * Endpoints internes (worker BullMQ → API) pour la file webhook.
 *
 * Le worker n'a pas d'accès Prisma direct. Il :
 *  1. récupère la conf (url, secret, active) d'un webhook via GET
 *  2. POST le payload signé HMAC vers l'URL externe
 *  3. rapporte l'issue (status code, error) via PATCH delivery
 *
 * Routes overlay-only, protégées par `X-Worker-Token` comme les autres internals.
 */
@Controller('internal/webhooks')
@UseGuards(InternalTokenGuard)
export class WebhooksInternalController {
  constructor(private readonly prisma: PrismaService) {}

  /** Conf d'un webhook (utilisée par le worker juste avant l'émission). */
  @Get(':id')
  async get(@Param('id') id: string) {
    const hook = await this.prisma.webhook.findUnique({
      where: { id },
      select: { id: true, url: true, secret: true, active: true, format: true },
    });
    if (!hook) return null;
    return hook;
  }

  /** MAJ statut d'une livraison après tentative HTTP. */
  @Patch('deliveries/:id')
  async updateDelivery(
    @Param('id') id: string,
    @Body()
    body: {
      status: 'SUCCESS' | 'FAILED' | 'PENDING';
      responseStatus?: number | null;
      responseBody?: string | null;
      error?: string | null;
      attemptCount?: number;
    },
  ) {
    const data: {
      status: 'SUCCESS' | 'FAILED' | 'PENDING';
      responseStatus: number | null;
      responseBody: string | null;
      error: string | null;
      attemptCount?: number;
      deliveredAt?: Date;
    } = {
      status: body.status,
      responseStatus: body.responseStatus ?? null,
      responseBody: body.responseBody ?? null,
      error: body.error ?? null,
    };
    if (typeof body.attemptCount === 'number') data.attemptCount = body.attemptCount;
    if (body.status === 'SUCCESS') data.deliveredAt = new Date();
    const updated = await this.prisma.webhookDelivery.update({
      where: { id },
      data,
      select: { webhookId: true, status: true, attemptCount: true },
    });
    await this.updateFailureStreak(updated.webhookId, updated.status, updated.attemptCount);
    return { ok: true };
  }

  // Nombre max de tentatives BullMQ (cf. api/src/webhooks/webhook-queue.ts).
  private static readonly MAX_ATTEMPTS = 5;
  // Livraisons terminales en échec consécutives avant auto-désactivation.
  private static readonly DISABLE_THRESHOLD = 5;

  /**
   * Met à jour le compteur d'échecs consécutifs du webhook et l'auto-désactive
   * après `DISABLE_THRESHOLD` livraisons terminales en échec d'affilée. Un succès
   * remet le compteur à zéro.
   */
  private async updateFailureStreak(
    webhookId: string,
    status: string,
    attemptCount: number,
  ): Promise<void> {
    if (status === 'SUCCESS') {
      await this.prisma.webhook.updateMany({
        where: { id: webhookId, consecutiveFailures: { not: 0 } },
        data: { consecutiveFailures: 0 },
      });
      return;
    }
    // On ne compte qu'un échec TERMINAL (toutes les tentatives BullMQ épuisées),
    // pas chaque retry intermédiaire.
    if (status !== 'FAILED' || attemptCount < WebhooksInternalController.MAX_ATTEMPTS) return;
    const hook = await this.prisma.webhook.update({
      where: { id: webhookId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { active: true, consecutiveFailures: true },
    });
    if (hook.active && hook.consecutiveFailures >= WebhooksInternalController.DISABLE_THRESHOLD) {
      await this.prisma.webhook.update({
        where: { id: webhookId },
        data: { active: false, autoDisabledAt: new Date() },
      });
    }
  }
}
