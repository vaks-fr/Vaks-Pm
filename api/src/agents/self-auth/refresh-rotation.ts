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
  /**
   * Rotation : `newPrev` devient le nouveau précédent. `graceConsumed` = la
   * rotation a été obtenue EN présentant le précédent (grâce) : la fenêtre de
   * grâce se ferme alors immédiatement — un 2e usage du même refresh sera un
   * rejeu détecté (révocation de la chaîne), pas une nouvelle rotation.
   */
  | { action: 'rotate'; newPrev: string; graceConsumed: boolean }
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
 * - hash == précédent, DANS la grâce → rotation UNIQUE (l'agent qui a raté la
 *   réponse récupère) : le présenté reste le précédent mais sa grâce est
 *   CONSOMMÉE. Avant, la grâce glissait à chaque usage → un refresh volé restait
 *   rejouable indéfiniment et évinçait l'agent légitime sans jamais déclencher
 *   la détection de rejeu (RFC 6819 §5.2.2.3).
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
    // Dans la grâce : une seule récupération ; la grâce est consommée.
    return { action: 'rotate', newPrev: presentedHash, graceConsumed: true };
  }

  if (matchedCurrent) {
    if (row.expiresAt.getTime() < nowMs) return { action: 'expired' };
    return { action: 'rotate', newPrev: row.tokenHash, graceConsumed: false };
  }

  // Ni courant ni précédent : le service traite ça en amont (row introuvable).
  return { action: 'reuse' };
}
