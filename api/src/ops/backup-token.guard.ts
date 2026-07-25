import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';

/**
 * Guard des endpoints `/ops/*` appelés par les scripts d'infrastructure côté
 * hôte (cron de sauvegarde). Contrairement aux routes `/internal/*` (overlay
 * Swarm uniquement, jamais routées par Traefik), `/ops/*` est **joignable de
 * l'extérieur via Traefik** — le host n'est pas sur le réseau overlay. La seule
 * barrière est donc un secret partagé en header `X-Backup-Token`.
 *
 * Le secret attendu = `BACKUP_ALERT_TOKEN` si défini, sinon `WORKER_API_TOKEN`
 * (déjà monté en secret Swarm `worker_api_token` sur l'API) — on évite ainsi
 * un nouveau secret obligatoire. Fail-closed : sans secret configuré, on REFUSE.
 */
@Injectable()
export class BackupTokenGuard implements CanActivate {
  private static warned = false;

  canActivate(ctx: ExecutionContext): boolean {
    const expected = process.env.BACKUP_ALERT_TOKEN || process.env.WORKER_API_TOKEN;
    if (!expected) {
      if (!BackupTokenGuard.warned) {
        console.error('[BackupTokenGuard] no BACKUP_ALERT_TOKEN/WORKER_API_TOKEN — /ops endpoints DENIED (fail-closed)');
        BackupTokenGuard.warned = true;
      }
      throw new UnauthorizedException('Ops endpoint unavailable');
    }
    const req = ctx.switchToHttp().getRequest<Request>();
    const got = req.headers['x-backup-token'];
    const value = Array.isArray(got) ? got[0] : got;
    if (value !== expected) throw new UnauthorizedException('Invalid backup token');
    return true;
  }
}
