import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { SkipAudit } from '../audit-logs/audited.decorator';
import { CiWebhooksService } from './ci-webhooks.service';

/**
 * Webhook CI ENTRANT (vérification des livrables agents — phase C). La CI pousse
 * ici un résultat signé (`POST /webhooks/ci/:provider`).
 *
 * Volontairement **hors `@PublicApi`** (comme `/ops/*`) : exclu de la doc et de
 * la frontière jeton — un PAT/clé org ne peut pas l'atteindre. Joignable via
 * Traefik (la CI est externe). La seule barrière est la **signature HMAC**
 * vérifiée contre le secret du connecteur CI de l'org (résolue depuis le Host
 * par le `TenantMiddleware`). `@SkipAudit` sur le handler : l'audit métier
 * (`ci_result.received` / `ci_webhook.rejected`) est posé dans le service.
 */
@Controller('webhooks/ci')
@SkipAudit()
export class CiWebhooksController {
  constructor(private readonly service: CiWebhooksService) {}

  @Post(':provider')
  @HttpCode(202)
  async receive(
    @Param('provider') provider: string,
    @Req() req: Request & { rawBody?: Buffer },
    @Body() body: unknown,
  ) {
    const result = await this.service.ingest(provider, req.rawBody, req.headers, body);
    // On accuse toujours réception (202) même en rejet : la CI ne doit pas
    // boucler sur un retry, et on ne divulgue pas pourquoi (anti-oracle).
    return { received: result.ok, ignored: result.ignored ?? false };
  }
}
