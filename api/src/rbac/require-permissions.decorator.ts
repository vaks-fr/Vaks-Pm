import { SetMetadata } from '@nestjs/common';
import { Permission } from '@vaks-pm/shared';

export const PERMISSIONS_KEY = 'required_permissions';
export const RequirePermissions = (...perms: Permission[]) =>
  SetMetadata(PERMISSIONS_KEY, perms);

/**
 * Marque une route (ou un contrôleur entier) comme faisant partie de l'**API
 * publique** : documentée dans la référence OpenAPI ET, à terme (Phase 9),
 * appelable par un jeton d'API (PAT) avec le `scope` indiqué.
 *
 * TOUT ce qui n'est PAS marqué est considéré **app-privé** : exclu de la doc
 * publique et (futur) interdit aux PAT (JWT user uniquement). Défaut = privé,
 * donc fail-safe : on ne peut pas exposer une route par oubli.
 */
export const PUBLIC_API_KEY = 'public_api';
export interface PublicApiMeta {
  /** Scope PAT associé (ex. 'tasks:write'). Null = pas encore de scope dédié. */
  scope: string | null;
}
export const PublicApi = (scope?: string) =>
  SetMetadata(PUBLIC_API_KEY, { scope: scope ?? null } as PublicApiMeta);
