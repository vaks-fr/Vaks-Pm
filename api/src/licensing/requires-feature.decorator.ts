import { SetMetadata } from '@nestjs/common';
import type { LicenseFeature } from '@vaks-pm/shared';

export const REQUIRES_FEATURE_KEY = 'requires_license_feature';

/**
 * Marque une route (ou un contrôleur) comme nécessitant une **feature premium**
 * active dans la licence du tenant (SPEC §16.3). Combiné au
 * {@link LicenseFeatureGuard}, renvoie `403 LICENSE_FEATURE_DISABLED` si la
 * feature n'est pas couverte / licence expirée. Le core n'est jamais gated.
 *
 * Exemple : `@RequiresFeature('scim')` sur le contrôleur SCIM.
 */
export const RequiresFeature = (feature: LicenseFeature) =>
  SetMetadata(REQUIRES_FEATURE_KEY, feature);
