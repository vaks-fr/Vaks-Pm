/**
 * Anti auto-gouvernance des agents (chantier 3.3).
 *
 * Un agent porteur de la capability `task:update` (→ `task:update` REST) peut
 * patcher une tâche. Certains champs de la tâche ne sont pas des données de
 * travail mais les *garde-fous de gouvernance* de l'agent lui-même — dérivés de
 * l'enjeu × confiance (chantier 3.3). Les laisser modifiables par l'agent
 * revient à le laisser réécrire ses propres limites :
 *
 *  - `stakes`            → abaisser son plancher de vérification (enjeu faible = self-attest) ;
 *  - `agentCostBudget`   → relever/effacer son plafond de coût finance ;
 *  - `agentGuardrails`   → réécrire ce qu'il n'a pas le droit de faire ;
 *  - `acceptanceCriteria`→ réécrire les critères contre lesquels son travail est jugé.
 *
 * Même philosophie que l'anti auto-approbation de la revue (reviewer ≠ auteur) :
 * la gouvernance d'un agent est fixée par un humain, jamais par l'agent. Ce
 * module est volontairement pur (aucune dépendance Nest/Prisma) pour être
 * testable en isolation et réutilisable par toute surface d'écriture (REST, MCP).
 */

/** Champs de gouvernance qu'un agent ne doit jamais pouvoir écrire lui-même. */
export const AGENT_SELF_GOVERNANCE_FIELDS = [
  'stakes',
  'agentCostBudget',
  'agentGuardrails',
  'acceptanceCriteria',
] as const;

export type AgentSelfGovernanceField = (typeof AGENT_SELF_GOVERNANCE_FIELDS)[number];

/**
 * Renvoie la liste des champs de gouvernance qu'un appelant AGENT tente de
 * modifier dans un PATCH. Vide si l'appelant n'est pas un agent, ou si aucun de
 * ces champs n'est présent dans le DTO.
 *
 * Un champ est considéré « tenté » dès qu'il est présent dans le DTO — y compris
 * à `null` : effacer `agentCostBudget` (retirer le plafond) ou remettre `stakes`
 * à `null` (rabaisser l'enjeu au défaut) sont tout aussi interdits qu'une hausse.
 */
export function agentSelfGovernanceViolation(
  actorKind: 'HUMAN' | 'AGENT' | undefined,
  dto: Partial<Record<AgentSelfGovernanceField, unknown>>,
): AgentSelfGovernanceField[] {
  if (actorKind !== 'AGENT') return [];
  return AGENT_SELF_GOVERNANCE_FIELDS.filter((field) => dto[field] !== undefined);
}
