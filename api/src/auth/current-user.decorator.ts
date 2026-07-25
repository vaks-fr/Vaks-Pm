import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Permission } from '@vaks-pm/shared';

export interface AuthUser {
  userId: string;
  orgId: string;
  email: string;
  isAdmin: boolean;
  /** Présent si la requête est authentifiée par un jeton d'API (et non un JWT de session). */
  viaApiToken?: boolean;
  /** true = clé organisation (identité service) ; false/absent = jeton utilisateur. */
  isOrgToken?: boolean;
  /** Scopes du jeton (sous-ensemble de Permission). Vide = pas de restriction. */
  tokenScopes?: Permission[];
  /** Nature du principal d'un jeton API : 'HUMAN' | 'AGENT' (dérivée en base). */
  actorKind?: 'HUMAN' | 'AGENT';
  /** Owner humain responsable (principals kind=AGENT uniquement). */
  agentOwnerId?: string;
  /** Niveau de confiance de l'agent (kind=AGENT uniquement). */
  trustLevel?: string;
  /** Capabilities de l'agent (kind=AGENT uniquement). */
  capabilities?: string[];
}

/**
 * Réduit un {@link AuthUser} au couple `{ userId, isAdmin }` attendu par les
 * scopings de lecture transverse (`ProjectAccessService.accessibleProjectScope`,
 * `WorkloadService.workloadGrid`, …). Une **clé d'organisation** (identité
 * service, tous scopes) est traitée comme un admin — aucune restriction — au
 * même titre que le bypass de la `ProjectAccessGuard`. Un PAT utilisateur reste
 * soumis au RBAC du user sous-jacent.
 */
export function requesterOf(user: AuthUser): { userId: string; isAdmin: boolean } {
  return {
    userId: user.userId,
    isAdmin: !!user.isAdmin || (!!user.viaApiToken && !!user.isOrgToken),
  };
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);
