/**
 * Décision de rotation d'un refresh d'agent — logique PURE (aucun accès DB),
 * pour être spécifiée exécutablement en vitest. Le service applique la décision.
 */

export interface RefreshRow {
  tokenHash: string;
  prevTokenHash: string | null;
  prevValidUntil: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
}

export type RefreshDecision =
  /** Rotation normale : `newPrev` devient le nouveau précédent. */
  | { action: 'rotate'; newPrev: string }
  /** Ancien refresh présenté hors grâce → rejeu/vol : révoquer la chaîne. */
  | { action: 'reuse' }
  /** Refresh courant expiré (agent dormant trop longtemps). */
  | { action: 'expired' }
  /** Chaîne déjà révoquée. */
  | { action: 'revoked' };

/**
 * Décide ce qu'il faut faire d'un refresh présenté.
 *
 * - hash == courant, non expiré → rotation (le courant devient le précédent).
 * - hash == précédent, DANS la grâce → rotation (on conserve le présenté comme
 *   précédent : grâce glissante, l'agent qui a raté le nouveau récupère).
 * - hash == précédent, HORS grâce → rejeu/vol.
 * - courant expiré → expired.
 */
export function classifyRefresh(row: RefreshRow, presentedHash: string, nowMs: number): RefreshDecision {
  if (row.revokedAt) return { action: 'revoked' };

  const matchedCurrent = row.tokenHash === presentedHash;
  const matchedPrev = row.prevTokenHash === presentedHash;

  if (matchedPrev) {
    const graceOk = !!row.prevValidUntil && row.prevValidUntil.getTime() >= nowMs;
    if (!graceOk) return { action: 'reuse' };
    // Dans la grâce : on garde le présenté comme précédent (fenêtre glissante).
    return { action: 'rotate', newPrev: presentedHash };
  }

  if (matchedCurrent) {
    if (row.expiresAt.getTime() < nowMs) return { action: 'expired' };
    return { action: 'rotate', newPrev: row.tokenHash };
  }

  // Ni courant ni précédent : le service traite ça en amont (row introuvable).
  return { action: 'reuse' };
}
