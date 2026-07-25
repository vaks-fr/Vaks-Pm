import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuthService } from './auth.service';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/**
 * Cron léger qui révoque toutes les 15 minutes les refresh tokens "morts par
 * inactivité" (lastActivityAt + sessionTimeout < now). Évite l'accumulation de
 * sessions zombies dans la liste Active sessions de l'admin panel.
 *
 * Pas de lock distribué : `updateMany` est idempotent sur le filtre
 * `revokedAt: null` → si N réplicas tournent en parallèle, seul le premier
 * "voit" les tokens à révoquer, les autres trouvent 0. Pas de problème.
 *
 * Si l'org n'a pas configuré `sessionTimeout` (ou = 0), le service ignore
 * cette org → désactivable en remettant le timeout à 0 dans Admin Security.
 */
@Injectable()
export class SessionsCronService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(SessionsCronService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly auth: AuthService) {}

  onModuleInit() {
    // Premier tick à 90s pour laisser le boot terminer (Prisma, etc.).
    setTimeout(() => void this.tick(), 90_000);
    this.timer = setInterval(() => void this.tick(), FIFTEEN_MIN_MS);
    this.log.log('Sessions cleanup cron armé (interval 15min).');
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    try {
      const n = await this.auth.cleanupStaleSessions();
      if (n > 0) this.log.log(`Revoked ${n} stale session(s) (idle timeout exceeded).`);
    } catch (err) {
      this.log.warn(`cleanup tick failed: ${(err as Error).message}`);
    }
  }
}
