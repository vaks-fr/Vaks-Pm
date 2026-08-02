/**
 * Enveloppes de budget agent — partie PURE (vitest). Le calcul des sommes vit
 * dans `AgentBudgetService` (accès DB) ; ici on ne fait que **décider** à partir
 * de chiffres déjà agrégés.
 *
 * Pourquoi une partie pure : le coupe-circuit budgétaire (lot A §2) doit être
 * lisible et testable sans base — c'est lui qui arrête un agent parti en boucle,
 * on ne veut pas qu'il dépende d'un mock Prisma pour être vérifié.
 */

import type { AgentBudgetEnvelopeDto, AgentBudgetScope } from '@vaks-pm/shared';

export type { AgentBudgetScope };
/** Une enveloppe : même forme que le DTO exposé (une seule définition). */
export type AgentBudgetEnvelope = AgentBudgetEnvelopeDto;

/** Arrondi monétaire commun (4 décimales, comme `AgentRun.cost`). */
const round4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Construit une enveloppe. Retourne `null` quand aucun plafond n'est défini
 * (`null`/`undefined`) — une enveloppe absente n'est pas une enveloppe à zéro.
 */
export function buildEnvelope(
  scope: AgentBudgetScope,
  budget: number | null | undefined,
  spent: number,
): AgentBudgetEnvelope | null {
  if (budget == null || !Number.isFinite(budget)) return null;
  const b = round4(budget);
  const s = round4(Math.max(0, spent));
  return {
    scope,
    budget: b,
    spent: s,
    remaining: round4(Math.max(0, b - s)),
    exceeded: s >= b,
  };
}

/**
 * Verdict global : la moindre enveloppe consommée arrête l'agent. On renvoie
 * TOUTES les enveloppes dépassées (un agent qui crève à la fois le budget de la
 * tâche et le sien doit voir les deux — sinon il corrige l'un et retombe sur
 * l'autre au coup suivant).
 */
export function evaluateBudgetStop(envelopes: readonly AgentBudgetEnvelope[]): {
  stop: boolean;
  exceeded: AgentBudgetScope[];
} {
  const exceeded = envelopes.filter((e) => e.exceeded).map((e) => e.scope);
  return { stop: exceeded.length > 0, exceeded };
}

/** Durée par défaut d'un bail d'exécution, en minutes. */
export const DEFAULT_EXECUTION_LEASE_MINUTES = 30;
/** Bornes du bail : sous 5 min un agent normal serait fauché en plein travail ;
 *  au-delà de 24 h le filet ne sert plus à rien. `0` = mécanisme désactivé. */
export const MIN_EXECUTION_LEASE_MINUTES = 5;
export const MAX_EXECUTION_LEASE_MINUTES = 1440;

/**
 * Normalise le réglage `agents.executionLeaseMinutes`. Valeur absente/illisible
 * → défaut (le filet reste armé : c'est un garde-fou, pas une option). `0` est
 * la SEULE façon de le désactiver, et elle est explicite.
 */
export function resolveLeaseMinutes(raw: unknown): number {
  if (raw === 0 || raw === '0') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_EXECUTION_LEASE_MINUTES;
  const i = Math.round(n);
  if (i < MIN_EXECUTION_LEASE_MINUTES) return MIN_EXECUTION_LEASE_MINUTES;
  if (i > MAX_EXECUTION_LEASE_MINUTES) return MAX_EXECUTION_LEASE_MINUTES;
  return i;
}

/** Échéance d'un bail à partir de maintenant (`null` si le mécanisme est off). */
export function leaseExpiryFrom(now: Date, minutes: number): Date | null {
  if (minutes <= 0) return null;
  return new Date(now.getTime() + minutes * 60_000);
}
