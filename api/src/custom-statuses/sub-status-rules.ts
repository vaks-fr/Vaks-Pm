/**
 * Règles PURES de cohérence statut ↔ sous-statut (overlay Custom Status).
 * Invariant : une tâche portant un sous-statut a TOUJOURS `status` =
 * `parentStatus` du sous-statut. Ces règles décident, à partir d'un patch,
 * quoi écrire — le service fait les lookups et applique.
 */

export type SubStatusDecision =
  | { error: string }
  | {
      /** Statut moteur imposé par le sous-statut choisi (poser un sous-statut
       *  pose aussi son statut parent). */
      forcedStatus?: string;
      /** Écriture sur Task.subStatusId (`null` = effacer). Absent = intouché. */
      subStatusPatch?: string | null;
    };

export function decideSubStatus(args: {
  /** dto.subStatusId : id, `null` (effacer) ou `undefined` (non fourni). */
  requestedSubId: string | null | undefined;
  /** parentStatus du sous-statut demandé (résolu par le service ; null si non fourni). */
  requestedSubParent: string | null;
  /** dto.status (ou statut de la colonne cible pour un move). */
  requestedStatus: string | undefined;
  /** Statut courant de la tâche. */
  currentStatus: string;
  /** La tâche porte-t-elle déjà un sous-statut ? */
  hasCurrentSub: boolean;
  /** parentStatus du sous-statut courant (null si aucun ou introuvable). */
  currentSubParent: string | null;
}): SubStatusDecision {
  const { requestedSubId, requestedSubParent, requestedStatus, currentStatus, hasCurrentSub, currentSubParent } = args;

  if (requestedSubId != null) {
    // Sous-statut demandé : statut explicite incompatible → refus ; sinon le
    // statut moteur suit le parent.
    if (!requestedSubParent) return { error: 'SUB_STATUS_NOT_FOUND' };
    if (requestedStatus !== undefined && requestedStatus !== requestedSubParent) {
      return { error: 'SUB_STATUS_PARENT_MISMATCH' };
    }
    return { forcedStatus: requestedSubParent, subStatusPatch: requestedSubId };
  }

  if (requestedSubId === null) {
    // Effacement explicite : statut inchangé (ou celui demandé), plus de sous-statut.
    return { subStatusPatch: null };
  }

  // Non fourni : si le statut change et que le sous-statut courant n'appartient
  // plus au nouveau statut, on l'efface (fallback statut principal seul).
  if (
    requestedStatus !== undefined &&
    requestedStatus !== currentStatus &&
    hasCurrentSub &&
    currentSubParent !== requestedStatus
  ) {
    return { subStatusPatch: null };
  }

  return {};
}
