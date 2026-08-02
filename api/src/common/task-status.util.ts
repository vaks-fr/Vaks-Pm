import { TaskStatus } from '@db';

/**
 * Compteur par statut de tâche, initialisé à 0 pour CHAQUE valeur de
 * `TaskStatus` (dérivé de l'enum runtime, y compris les statuts agents
 * `CLAIMED`/`CHANGES_REQUESTED`/`APPROVED`) — évite de recopier le littéral
 * `{ TODO: 0, CLAIMED: 0, ... }` à chaque endroit qui agrège des tâches par
 * statut, et reste correct si l'enum gagne une valeur.
 */
export function blankStatusCounts(): Record<TaskStatus, number> {
  const out = {} as Record<TaskStatus, number>;
  for (const s of Object.values(TaskStatus)) out[s] = 0;
  return out;
}
