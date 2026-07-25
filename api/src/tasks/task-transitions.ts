import { TaskStatus } from '@vaks-pm/shared';

/**
 * Matrice de transitions de statut d'une tâche (AGENTS_ARCHITECTURE.md chantier 2)
 * — **fonction pure**, spec exécutable (voir `__tests__/task-transitions.spec.ts`).
 *
 * Deux couches :
 *  1. **Arêtes structurées** du cycle de vie agent (claim → progress → review →
 *     approved/changes → done) avec des gardes précises (claimant, reviewer,
 *     anti auto-approbation).
 *  2. **Zone humaine « legacy »** : un humain `task:update` circule librement
 *     entre les statuts classiques (TODO/IN_PROGRESS/IN_REVIEW/DONE) + ON_HOLD.
 *     C'est ce qui garantit **zéro régression** du Kanban/drag-drop existant.
 *
 * La fonction ne connaît RIEN de la DB : l'appelant (TaskTransitionService)
 * résout le contexte (claimant ? permissions ? auteur du livrable ?) et applique
 * (ou seulement observe) le verdict.
 */

export type TransitionActorKind = 'HUMAN' | 'AGENT';

export interface TransitionActor {
  kind: TransitionActorKind;
  /** L'acteur détient le claim de la tâche (`Task.claimedById === acteur`). */
  isClaimant?: boolean;
  /** Permission `task:update`. */
  canUpdate?: boolean;
  /** Permission `task:review` (approuver / demander des changements). */
  canReview?: boolean;
  /** L'acteur approuverait SON PROPRE livrable → interdit (anti auto-approbation). */
  reviewingOwnWork?: boolean;
}

export interface TransitionContext {
  /** `agents.autoCloseOnApproval` effectif pour ce projet (APPROVED→DONE auto). */
  autoClose?: boolean;
}

export interface TransitionVerdict {
  allowed: boolean;
  /** Motif machine du refus (audit / diagnostic). Absent si autorisé. */
  code?: string;
}

// Valeurs de statut manipulées comme des **chaînes** : la matrice ne fait que
// comparer des valeurs, et il existe DEUX types `TaskStatus` nominaux distincts
// (Prisma `@db` côté service, `@vaks-pm/shared` côté DTO). Typer en `string`
// évite tout couplage à l'un ou l'autre — les tests garantissent la correction.
const S = TaskStatus;

/** Statuts du flux humain « classique » (pré-agents). */
const LEGACY_STATUSES = new Set<string>([S.TODO, S.IN_PROGRESS, S.IN_REVIEW, S.DONE]);
const inLegacyZone = (s: string): boolean => LEGACY_STATUSES.has(s) || s === S.ON_HOLD;

const ALLOW: TransitionVerdict = { allowed: true };
const deny = (code: string): TransitionVerdict => ({ allowed: false, code });
const gate = (cond: boolean, code: string): TransitionVerdict => (cond ? ALLOW : deny(code));

/**
 * Évalue une transition `from → to` pour un acteur donné. Retourne un verdict
 * `{ allowed, code? }`. Ne throw jamais — c'est l'appelant qui décide de bloquer
 * (mode enforce) ou de seulement journaliser (mode observation).
 */
export function evaluateTransition(
  from: string,
  to: string,
  actor: TransitionActor,
  ctx: TransitionContext = {},
): TransitionVerdict {
  // No-op : ré-écrire le même statut est toujours toléré (idempotence).
  if (from === to) return ALLOW;

  const isHuman = actor.kind === 'HUMAN';
  const canUpdate = !!actor.canUpdate;
  // « claimant, ou humain qui reprend la main (takeover) ».
  const claimantOrTakeover = !!actor.isClaimant || (isHuman && canUpdate);

  // ---- 1. Arêtes structurées du cycle agent (prioritaires) ----
  switch (`${from}->${to}`) {
    // Claim : l'acteur revendique une tâche libre. L'unicité (un seul gagnant)
    // est garantie atomiquement par l'endpoint de claim, pas ici.
    case `${S.TODO}->${S.CLAIMED}`:
      return ALLOW;

    // Démarrage par le claimant.
    case `${S.CLAIMED}->${S.IN_PROGRESS}`:
      return gate(claimantOrTakeover, 'not_claimant');

    // Release (par le claimant) ou takeover (humain task:update reprend la tâche).
    case `${S.CLAIMED}->${S.TODO}`:
      return gate(!!actor.isClaimant || (isHuman && canUpdate), 'not_claimant_or_updater');

    // Soumission en revue par le claimant. (L'exigence « ≥1 livrable PENDING »
    // pour un agent est vérifiée au niveau service au chantier 2c, pas ici.)
    case `${S.IN_PROGRESS}->${S.IN_REVIEW}`:
      return gate(claimantOrTakeover, 'not_claimant');

    // Décision de revue : reviewer requis ET jamais son propre travail.
    case `${S.IN_REVIEW}->${S.APPROVED}`:
    case `${S.IN_REVIEW}->${S.CHANGES_REQUESTED}`:
      if (!actor.canReview) return deny('needs_review_permission');
      if (actor.reviewingOwnWork) return deny('self_review_forbidden');
      return ALLOW;

    // Resoumission après demande de changements (par le claimant).
    case `${S.CHANGES_REQUESTED}->${S.IN_PROGRESS}`:
      return gate(claimantOrTakeover, 'not_claimant');

    // Clôture : reviewer/PM, ou auto-close configuré au niveau projet.
    case `${S.APPROVED}->${S.DONE}`:
      return gate(!!ctx.autoClose || !!actor.canReview || (isHuman && canUpdate), 'needs_close_permission');

    // Ré-ouverture d'un approuvé (avant clôture) par un reviewer.
    case `${S.APPROVED}->${S.CHANGES_REQUESTED}`:
      return gate(!!actor.canReview, 'needs_review_permission');
  }

  // ---- 2. Zone humaine « legacy » (anti-régression Kanban/drag-drop) ----
  // Un humain task:update circule librement entre statuts classiques + ON_HOLD.
  if (isHuman && canUpdate && inLegacyZone(from) && inLegacyZone(to)) {
    return ALLOW;
  }

  return deny('transition_not_allowed');
}

/** Toutes les valeurs de statut (utilitaire pour les tests / l'introspection). */
export const ALL_TASK_STATUSES: TaskStatus[] = [
  S.TODO, S.CLAIMED, S.IN_PROGRESS, S.IN_REVIEW, S.CHANGES_REQUESTED, S.APPROVED, S.ON_HOLD, S.DONE,
];
