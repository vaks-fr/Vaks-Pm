/**
 * Ordre de sélection next_task (AGENTS_ARCHITECTURE.md chantier 4) — **pur**,
 * sans dépendance DB (spec exécutable `__tests__/agent-dispatch.spec.ts`).
 * Isolé du service pour rester testable sans l'alias `@db`.
 */

export interface RankedCandidate {
  id: string;
  projectId: string;
  title: string;
  priority: string;
  dueDate: Date | null;
  stakes: string | null;
  skillScore: number;
  unblocks: number;
  createdAt: Date;
  requireReview: boolean;
}

/** Rang de priorité métier (URGENT > HIGH > NORMAL > LOW), plus haut = plus tôt. */
const PRIORITY_RANK: Record<string, number> = { URGENT: 4, HIGH: 3, NORMAL: 2, LOW: 1 };

/**
 * Ordre de sélection (§4 chantier 4) : priorité desc → échéance proche →
 * successeurs débloqués desc → score skill → FIFO (createdAt).
 */
export function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  const pr = (PRIORITY_RANK[b.priority] ?? 0) - (PRIORITY_RANK[a.priority] ?? 0);
  if (pr !== 0) return pr;
  const ad = a.dueDate ? a.dueDate.getTime() : Number.POSITIVE_INFINITY;
  const bd = b.dueDate ? b.dueDate.getTime() : Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  if (b.unblocks !== a.unblocks) return b.unblocks - a.unblocks;
  if (b.skillScore !== a.skillScore) return b.skillScore - a.skillScore;
  return a.createdAt.getTime() - b.createdAt.getTime();
}
