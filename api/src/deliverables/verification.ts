/**
 * Vérification des livrables — moteur déterministe (AGENTS_VERIFICATION.md §1-6).
 * **Fonction pure**, spec exécutable (voir `__tests__/verification.spec.ts`).
 *
 * Phase A (pilote) : méthodes `self_attest` + `human` seulement, mode `report_only`
 * (§11) → le gate **n'auto-approuve ni ne bloque rien** ; il mesure la force de la
 * preuve contre le plancher requis et renvoie un verdict OBSERVÉ, journalisé à
 * l'audit pour calibrer avant de serrer (`enforce`, phases B+). Le moteur ne
 * connaît RIEN de la DB : l'appelant résout le contexte (méthode, plancher, mode).
 */

/** Hiérarchie de force des preuves (§1). Plus haut = plus dur à fabriquer. */
export const VERIFICATION_METHODS = [
  'self_attest', // 0 — déclaration de l'agent
  'tool_output', // 1 — sortie d'outil (phase B)
  'agent_validator', // 2 — contre-visa d'un autre agent (phase D)
  'ci_signed', // 3 — preuve CI signée HMAC (phase C)
  'human', // 4 — revue humaine (terminal, fallback universel)
] as const;

export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];
export type VerificationStatus = 'pass' | 'fail' | 'pending';
export type VerificationMode = 'report_only' | 'enforce';

/** Force numérique d'une méthode (index dans la hiérarchie ; -1 si inconnue). */
export function strength(method: string | null | undefined): number {
  return VERIFICATION_METHODS.indexOf(method as VerificationMethod);
}

/** Verdict du gate (§5). En phase A / report_only, seul `APPROVE` /
 *  `CHANGES_REQUESTED` sont produits ; `ESCALATE`/`WAIT`/`REJECT` sont câblés
 *  pour les phases suivantes (enforce, CI async, signatures). */
export type VerificationDecision =
  | 'APPROVE'
  | 'CHANGES_REQUESTED'
  | 'ESCALATE'
  | 'WAIT'
  | 'REJECT';

export interface VerificationInput {
  /** Preuve attachée au livrable (`Deliverable.verification`). */
  verification: { method?: string | null; status?: string | null } | null | undefined;
  /** Plancher requis (force minimale acceptable) — dérivé enjeu × trust (§4). */
  requiredFloor: VerificationMethod;
  /** `report_only` (défaut pilote) ou `enforce`. */
  mode: VerificationMode;
}

export interface VerificationVerdict {
  decision: VerificationDecision;
  /** Motif machine (audit / diagnostic). */
  code: string;
  /** La méthode fournie est sous le plancher requis. */
  belowFloor: boolean;
  method: string | null;
  status: string | null;
  requiredFloor: VerificationMethod;
  mode: VerificationMode;
}

/**
 * Évalue la preuve d'un livrable à la porte `IN_REVIEW → APPROVED` (§6). Ne throw
 * jamais — l'appelant décide de bloquer (enforce) ou de seulement journaliser
 * (report_only). Sampling (porte 5) et signatures HMAC (porte 2) = phases B/C.
 */
export function evaluateVerification(input: VerificationInput): VerificationVerdict {
  const method = input.verification?.method ?? null;
  const status = (input.verification?.status ?? null) as VerificationStatus | null;
  const floor = strength(input.requiredFloor);
  const base = {
    method,
    status,
    requiredFloor: input.requiredFloor,
    mode: input.mode,
  };

  // Aucune preuve fournie = self_attest implicite le plus faible.
  const s = strength(method);
  const belowFloor = s < floor;

  // Porte 1 — validité structurelle : méthode inconnue = malformé → REJECT.
  if (method != null && s < 0) {
    return { ...base, decision: 'REJECT', code: 'method_unknown', belowFloor: true };
  }

  // Porte 4 — statut asynchrone en attente (preuve CI pas encore arrivée) → WAIT.
  if (status === 'pending') {
    return { ...base, decision: 'WAIT', code: 'evidence_pending', belowFloor };
  }

  // Porte 3 — plancher de force. En report_only : on journalise mais on laisse
  // passer (APPROVE si pass, CHANGES si fail). En enforce : on escalade.
  if (belowFloor) {
    if (input.mode === 'report_only') {
      return {
        ...base,
        decision: status === 'fail' ? 'CHANGES_REQUESTED' : 'APPROVE',
        code: 'below_floor_reported',
        belowFloor: true,
      };
    }
    return { ...base, decision: 'ESCALATE', code: 'below_floor', belowFloor: true };
  }

  // Porte 6 — décision finale (échantillonnage = phase B, pas ici).
  if (status === 'fail') {
    return { ...base, decision: 'CHANGES_REQUESTED', code: 'status_fail', belowFloor: false };
  }
  return { ...base, decision: 'APPROVE', code: 'ok', belowFloor: false };
}

// ---------------------------------------------------------------------------
// Phase B — dérivation du plancher requis (enjeu × trust ∩ capacités projet)
// (AGENTS_VERIFICATION.md §4). PUR, testé dans verification.spec.ts.
// ---------------------------------------------------------------------------

export type TaskStakes = 'low' | 'medium' | 'high' | 'critical';
export type AgentTrust = 'DRAFT_ONLY' | 'SUPERVISED' | 'AUTONOMOUS';

/**
 * Taux d'échantillonnage `p` (§7) : fraction des livrables CONFORMES re-vérifiés
 * par un humain même quand ils passent le plancher. Fonction inverse du trust —
 * plus l'agent est fiable, moins on re-contrôle. C'est ce qui empêche le système
 * de devenir crédule sur les attestations `agent_validator`.
 */
export const RECHECK_RATE: Record<AgentTrust, number> = {
  DRAFT_ONLY: 0.5,
  SUPERVISED: 0.2,
  AUTONOMOUS: 0.05,
};

/**
 * Un livrable conforme doit-il repartir en re-vérification humaine (échantillon) ?
 * PUR : le tirage aléatoire est injecté (`rand` ∈ [0,1)) pour la testabilité —
 * l'appelant passe `Math.random()` en prod. `true` = escalade humaine malgré le
 * verdict positif de l'agent validateur.
 */
export function shouldRecheck(
  trust: AgentTrust | null | undefined,
  rand: number,
): boolean {
  const tr: AgentTrust = trust && trust in RECHECK_RATE ? trust : 'DRAFT_ONLY';
  return rand < RECHECK_RATE[tr];
}

/**
 * Table de référence enjeu × trust → **plancher de force** (méthode minimale
 * acceptable). Modèle single-floor : le gate compare `strength(fourni) ≥
 * strength(plancher)`. Les alternatives `∨` de la spec sont réduites au minimum
 * acceptable ; les cumuls `∧` (ex. critique+AUTONOMOUS = ci∧human) au terminal
 * `human`. Colonnes = DRAFT_ONLY / SUPERVISED / AUTONOMOUS.
 */
const FLOOR_TABLE: Record<TaskStakes, [VerificationMethod, VerificationMethod, VerificationMethod]> = {
  low: ['self_attest', 'self_attest', 'self_attest'],
  medium: ['tool_output', 'tool_output', 'agent_validator'],
  high: ['human', 'ci_signed', 'ci_signed'],
  critical: ['human', 'human', 'human'],
};

const TRUST_COL: Record<AgentTrust, 0 | 1 | 2> = {
  DRAFT_ONLY: 0,
  SUPERVISED: 1,
  AUTONOMOUS: 2,
};

export interface DerivedRequirement {
  /** Plancher effectif (après intersection avec les capacités du projet). */
  floor: VerificationMethod;
  /** Plancher brut de la table, AVANT ajustement au terrain. */
  baseFloor: VerificationMethod;
  /** L'exigence a été remontée à `human` faute de capacité mécanique. */
  escalatedToHuman: boolean;
  stakes: TaskStakes;
  trust: AgentTrust;
}

/**
 * Dérive le plancher requis pour une tâche (§4). `human` est **toujours
 * disponible** (fallback universel anti-deadlock) ; `self_attest` toujours
 * possible aussi. Si le plancher de la table exige une méthode mécanique
 * (`tool_output`/`agent_validator`/`ci_signed`) qu'AUCUNE capacité du projet ne
 * permet d'atteindre, on remonte à `human` (jamais de blocage).
 */
export function deriveVerificationFloor(
  stakes: TaskStakes | null | undefined,
  trust: AgentTrust | null | undefined,
  capabilities: readonly string[] | null | undefined,
): DerivedRequirement {
  const st: TaskStakes = stakes && stakes in FLOOR_TABLE ? stakes : 'low';
  const tr: AgentTrust = trust && trust in TRUST_COL ? trust : 'DRAFT_ONLY';
  const baseFloor = FLOOR_TABLE[st][TRUST_COL[tr]];

  // `human` terminal : rien à intersecter.
  if (baseFloor === 'human') {
    return { floor: 'human', baseFloor, escalatedToHuman: false, stakes: st, trust: tr };
  }
  // Capacités disponibles : celles déclarées + self_attest (toujours) ; human à part.
  const avail = new Set<string>([...(capabilities ?? []), 'self_attest']);
  // Une capacité MÉCANIQUE (≠ human) atteint-elle le plancher ?
  const mechanicalMeets = [...avail].some(
    (m) => m !== 'human' && strength(m) >= 0 && strength(m) >= strength(baseFloor),
  );
  if (mechanicalMeets) {
    return { floor: baseFloor, baseFloor, escalatedToHuman: false, stakes: st, trust: tr };
  }
  return { floor: 'human', baseFloor, escalatedToHuman: true, stakes: st, trust: tr };
}
