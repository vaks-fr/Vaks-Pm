import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from './skills.service';
import { SkillRequestsService } from '../skill-requests/skill-requests.service';
import { getEmailQueue } from '../notifications/email-queue';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Cron quotidien skills :
 *   - Applique le decay (UserSkill non touchés depuis `skills.decayPeriodDays`)
 *     pour chaque org où `skills.decayEnabled = true`.
 *
 * Lock distribué Redis (clé datée à la journée UTC) pour qu'une seule
 * réplique API exécute le tick sur un cluster Swarm.
 *
 * Cron natif (setInterval) — pas de @nestjs/schedule pour rester léger,
 * cohérent avec NotificationsCronService.
 */
@Injectable()
export class SkillsCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SkillsCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly skills: SkillsService,
    private readonly skillRequests: SkillRequestsService,
  ) {}

  onModuleInit() {
    // Premier tick dans 5 min (laisse le boot finir), puis toutes les 24h.
    this.timer = setInterval(() => {
      void this.tick();
    }, DAY_MS);
    setTimeout(() => void this.tick(), 5 * 60_000);
    this.log.log('Skills cron armé (interval 24h).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposé pour test manuel (route admin éventuelle / debug). */
  async tick(): Promise<void> {
    const queue = getEmailQueue();
    const client = await queue.client;
    // Lock par jour UTC — TTL juste sous 24h pour qu'un crash libère le slot.
    const lockKey = `vaks:skills-cron:${new Date().toISOString().slice(0, 10)}`;
    const ok = await (client as unknown as {
      set: (k: string, v: string, ex: 'EX', ttl: number, nx: 'NX') => Promise<string | null>;
    }).set(lockKey, '1', 'EX', 86_400 - HOUR_MS / 1000, 'NX');
    if (ok !== 'OK') {
      this.log.debug(`tick skip (lock held: ${lockKey})`);
      return;
    }

    const orgs = await this.prisma.organization.findMany({ select: { id: true, name: true } });
    for (const org of orgs) {
      try {
        const r = await this.skills.applyDecayForOrg(org.id);
        if ('decayed' in r && (r.decayed || r.removed)) {
          this.log.log(
            `decay org=${org.id} (${org.name}): -${r.decayed} niveau(x), ${r.removed} skill(s) supprimé(s)`,
          );
        }
      } catch (err) {
        this.log.warn(`decay org=${org.id} failed: ${(err as Error).message}`);
      }
      try {
        const r = await this.skillRequests.sendReminders(org.id);
        if (r.sent > 0) {
          this.log.log(`reminders org=${org.id} (${org.name}): ${r.sent} envoyé(s)`);
        }
      } catch (err) {
        this.log.warn(`reminders org=${org.id} failed: ${(err as Error).message}`);
      }
      try {
        const r = await this.skills.sendExpirationReminders(org.id);
        if (r.sent > 0) {
          this.log.log(`expiry org=${org.id} (${org.name}): ${r.sent} relance(s) envoyée(s)`);
        }
      } catch (err) {
        this.log.warn(`expiry org=${org.id} failed: ${(err as Error).message}`);
      }
    }
  }
}
