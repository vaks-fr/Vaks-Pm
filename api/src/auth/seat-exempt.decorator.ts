import { SetMetadata } from '@nestjs/common';

/**
 * Marque une route (ou un contrôleur entier) comme **accessible sans siège de
 * licence**. Un principal JWT dont le compte est `licensed=false` (admin-only
 * ou parqué) est sinon refusé par `JwtAuthGuard` sur toute route du dashboard.
 *
 * À poser sur le strict nécessaire pour qu'un compte sans siège reste utilisable :
 * identité (`/auth/me`), gestion de son propre compte (`/me/*`), état de licence
 * lisible. **Fail-safe** : non marqué = bloqué pour un compte sans siège (un
 * oubli prive un admin-only d'une fonction, jamais un trou de sécurité). Les
 * routes admin (`/admin/*`) sont autorisées implicitement pour `isAdmin` — pas
 * besoin de les marquer.
 */
export const SEAT_EXEMPT_KEY = 'seat_exempt';
export const SeatExempt = () => SetMetadata(SEAT_EXEMPT_KEY, true);
