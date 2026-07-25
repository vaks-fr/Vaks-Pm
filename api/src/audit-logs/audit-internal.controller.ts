import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { InternalTokenGuard } from '../notifications/internal-token.guard';
import { SkipAudit } from './audited.decorator';

/**
 * Callback interne worker → API : résultat du test de connexion syslog
 * (bouton admin). Stocké en OrgSetting `audit.syslog.lastTest`, relu par
 * l'UI pour afficher le badge ok/erreur. Protégé `X-Worker-Token` (+
 * `X-Tenant-Slug` routé par le middleware tenant comme les autres internals).
 */
@Controller('internal/audit')
@UseGuards(InternalTokenGuard)
@SkipAudit()
export class AuditInternalController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('syslog-test-result')
  async testResult(
    @Body() body: { organizationId: string; ok: boolean; error?: string | null },
  ) {
    if (!body?.organizationId) return { ok: false };
    const value = {
      ok: !!body.ok,
      error: body.error ? String(body.error).slice(0, 500) : undefined,
      at: new Date().toISOString(),
    };
    await this.prisma.orgSetting.upsert({
      where: {
        organizationId_key: {
          organizationId: body.organizationId,
          key: 'audit.syslog.lastTest',
        },
      },
      update: { value: value as never },
      create: {
        organizationId: body.organizationId,
        key: 'audit.syslog.lastTest',
        value: value as never,
      },
    });
    return { ok: true };
  }

  /**
   * Perte TERMINALE d'un lot syslog (5 tentatives BullMQ épuisées). Stocke la
   * dernière erreur + un compteur journalier (lots + entrées perdues) que
   * l'UI affiche en badge d'avertissement. Pas une métrique exacte sous
   * concurrence (read-modify-write), mais largement suffisant comme signal.
   */
  @Post('syslog-failure')
  async syslogFailure(
    @Body() body: { organizationId: string; error?: string | null; entryCount?: number },
  ) {
    if (!body?.organizationId) return { ok: false };
    const today = new Date().toISOString().slice(0, 10);
    const key = 'audit.syslog.failures';
    const existing = await this.prisma.orgSetting.findUnique({
      where: { organizationId_key: { organizationId: body.organizationId, key } },
    });
    const prev = (existing?.value ?? {}) as {
      date?: string;
      batches?: number;
      entries?: number;
    };
    const sameDay = prev.date === today;
    const value = {
      date: today,
      batches: (sameDay ? prev.batches ?? 0 : 0) + 1,
      entries: (sameDay ? prev.entries ?? 0 : 0) + Math.max(0, body.entryCount ?? 0),
      lastError: body.error ? String(body.error).slice(0, 500) : undefined,
      lastAt: new Date().toISOString(),
    };
    await this.prisma.orgSetting.upsert({
      where: { organizationId_key: { organizationId: body.organizationId, key } },
      update: { value: value as never },
      create: { organizationId: body.organizationId, key, value: value as never },
    });
    return { ok: true };
  }
}
