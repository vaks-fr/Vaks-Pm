import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InternalTokenGuard } from '../notifications/internal-token.guard';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { ExportsService } from './exports.service';

/**
 * Chemin worker → API : le worker déclenche le rendu, l'API l'exécute.
 *
 * Overlay-only (jamais routé par Traefik, refusé au bord par `internal-deny`)
 * et protégé par le secret partagé `WORKER_API_TOKEN`.
 *
 * Le tenant est résolu depuis le header `X-Tenant-Slug` posé par le worker —
 * indispensable en mode pooled, sans quoi le rendu viserait la mauvaise base.
 */
@ApiExcludeController()
@Controller('internal/exports')
@UseGuards(InternalTokenGuard)
export class ExportsInternalController {
  constructor(private readonly svc: ExportsService) {}

  /** Exécute le rendu du job (idempotent : un job DONE n'est pas refait). */
  @Post('run')
  @SkipAudit()
  async run(@Body() body: { jobId: string }) {
    await this.svc.run(body.jobId);
    return { ok: true };
  }
}
