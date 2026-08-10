/**
 * Cœur PUR du gate de capacité du nudge (AGENT_NUDGE_CAPACITY.md §3) — aucune
 * I/O, aucune dépendance Nest : c'est la surface testée en vitest. Les lectures
 * Prisma/Redis vivent dans `agent-nudge.service.ts` ; ici on ne fait que décider
 * **combien** de réveils un agent peut recevoir, et **qui** l'en empêche.
 *
 * Trois contraintes indépendantes, jamais fusionnées en une soustraction unique
 * (sinon `backpressureMax` cesserait d'être un levier distinct de
 * `maxConcurrentTasks`) :
 *
 *  1. **concurrence** — portée AGENT, tous projets confondus, comme le vrai gate
 *     de claim (`TasksService.claim`) ;
 *  2. **backpressure** — portée PROJET, et **ne compte que les tâches produites
 *     par des agents** : une file de relecture entre humains ne consomme pas la
 *     capacité de revue des livrables d'agents ;
 *  3. **budget** — binaire : un agent sans budget ne pourra pas claim, donc le
 *     réveiller lui fait payer une conversation pour rien.
 */

/** Plafond dur de fan-out quand rien n'est configuré (ni concurrence ni backpressure). */
export const DEFAULT_FANOUT_CAP = 10;

export interface RoomInput {
  /** `null` = pas de limite de concurrence sur cet agent. */
  maxConcurrentTasks: number | null;
  /** Tâches CLAIMED / IN_PROGRESS / CHANGES_REQUESTED de l'agent (toutes orgs-projets). */
  activeTasks: number;
  /** Réveils déjà en vol pour cet agent (réservations Redis non consommées). */
  reservations: number;
  /** `agents.backpressure.maxPendingReviews` — 0 = illimité. */
  backpressureMax: number;
  /** Tâches IN_REVIEW du projet **dont le claimant est un agent**. */
  inReviewByAgents: number;
  /** Une enveloppe de coût est atteinte, ou le budget de runs du jour est épuisé. */
  budgetExhausted: boolean;
  /** `agents.nudge.maxParallel` — 0 = pas de plafond explicite (→ `DEFAULT_FANOUT_CAP`). */
  maxParallel?: number;
}

/** Contrainte qui a mis `room` à 0 — décide s'il faut notifier, et qui. */
export type RoomBlocker = 'none' | 'concurrency' | 'backpressure' | 'budget';

export interface RoomVerdict {
  /** Nombre de réveils autorisés maintenant (0 = ne rien envoyer). */
  room: number;
  blocker: RoomBlocker;
}

/**
 * Combien de nudges cet agent peut-il recevoir, et qui le bloque le cas échéant.
 *
 * Ordre de priorité du `blocker` quand plusieurs contraintes sont à 0 : budget >
 * backpressure > concurrence. C'est l'ordre de l'**actionnabilité** — un budget
 * épuisé et une file de revue pleine demandent une décision humaine, alors que
 * la concurrence se résout d'elle-même dès qu'une tâche se termine (d'où le
 * silence sur ce cas, cf. §6).
 */
export function computeRoom(input: RoomInput): RoomVerdict {
  if (input.budgetExhausted) return { room: 0, blocker: 'budget' };

  const concurrencyRoom =
    input.maxConcurrentTasks == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, input.maxConcurrentTasks - input.activeTasks - input.reservations);

  const backpressureRoom =
    input.backpressureMax > 0
      ? Math.max(0, input.backpressureMax - input.inReviewByAgents)
      : Number.POSITIVE_INFINITY;

  const cap =
    input.maxParallel && input.maxParallel > 0 ? input.maxParallel : DEFAULT_FANOUT_CAP;

  const room = Math.min(concurrencyRoom, backpressureRoom, cap);

  if (room > 0) return { room, blocker: 'none' };
  // Backpressure d'abord : c'est la cause actionnable (relire, ou relever le seuil).
  return {
    room: 0,
    blocker: backpressureRoom <= 0 ? 'backpressure' : 'concurrency',
  };
}
