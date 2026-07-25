import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { LicenseFeature } from '@vaks-pm/shared';
import { LicenseService } from './license.service';
import { REQUIRES_FEATURE_KEY } from './requires-feature.decorator';

/**
 * Garde de licence : si le handler (ou son contrôleur) porte `@RequiresFeature`,
 * exige que la feature soit active dans la licence du tenant courant. Sinon
 * `403 LICENSE_FEATURE_DISABLED`. À placer **après** les guards d'auth/tenant
 * (le contexte tenant doit déjà être posé pour lire la bonne licence).
 *
 * Fail-safe inversé vs sécurité : une route SANS décorateur passe toujours
 * (c'est du core gratuit). Le gating est explicite et opt-in.
 */
@Injectable()
export class LicenseFeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly licenses: LicenseService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<LicenseFeature | undefined>(
      REQUIRES_FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!feature) return true;
    if (await this.licenses.hasFeature(feature)) return true;
    throw new ForbiddenException({
      statusCode: 403,
      error: 'LICENSE_FEATURE_DISABLED',
      message:
        `Cette fonctionnalité (« ${feature} ») requiert une licence active. ` +
        `Contactez votre éditeur pour l'activer.`,
      feature,
    });
  }
}
