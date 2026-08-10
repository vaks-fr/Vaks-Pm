import { Body, Controller, Get, Param, Patch, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalTokenGuard } from '../notifications/internal-token.guard';

/**
 * Endpoints internes (worker BullMQ → API) pour la file `agent-nudge`. Même
 * pattern que `webhooks-internal.controller.ts` : le worker relit la conf de la
 * souscription, POST le nudge signé, puis rapporte l'issue. Routes overlay-only
 * protégées par `X-Worker-Token`.
 */
@Controller('internal/agent-nudges')
@UseGuards(InternalTokenGuard)
export class AgentNudgeInternalController {
  constructor(private readonly prisma: PrismaService) {}

  /** Conf d'une souscription (utilisée par le worker juste avant l'émission). */
  @Get(':id')
  async get(@Param('id') id: string) {
    const sub = await this.prisma.agentWebhookSubscription.findUnique({
      where: { id },
      select: { id: true, callbackUrl: true, secret: true, active: true },
    });
    if (!sub) return null;
    return sub;
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
    const updated = await this.prisma.agentNudgeDelivery.update({
      where: { id },
      data,
      select: { subscriptionId: true, status: true, attemptCount: true },
    });
    await this.updateFailureStreak(updated.subscriptionId, updated.status, updated.attemptCount);
    return { ok: true };
  }

  // Cf. api/src/agents/agent-nudge-queue.ts (attempts BullMQ).
  private static readonly MAX_ATTEMPTS = 5;
  private static readonly DISABLE_THRESHOLD = 5;

  /**
   * Auto-désactive **la souscription** (jamais un hook partagé) après
   * `DISABLE_THRESHOLD` livraisons terminales en échec d'affilée — typiquement
   * un flux Copilot démonté dont le callback 404. Un succès reset le compteur.
   */
  private async updateFailureStreak(
    subscriptionId: string,
    status: string,
    attemptCount: number,
  ): Promise<void> {
    if (status === 'SUCCESS') {
      await this.prisma.agentWebhookSubscription.updateMany({
        where: { id: subscriptionId, consecutiveFailures: { not: 0 } },
        data: { consecutiveFailures: 0 },
      });
      return;
    }
    if (status !== 'FAILED' || attemptCount < AgentNudgeInternalController.MAX_ATTEMPTS) return;
    const sub = await this.prisma.agentWebhookSubscription.update({
      where: { id: subscriptionId },
      data: { consecutiveFailures: { increment: 1 } },
      select: { active: true, consecutiveFailures: true },
    });
    if (sub.active && sub.consecutiveFailures >= AgentNudgeInternalController.DISABLE_THRESHOLD) {
      await this.prisma.agentWebhookSubscription.update({
        where: { id: subscriptionId },
        data: { active: false, autoDisabledAt: new Date() },
      });
    }
  }
}
