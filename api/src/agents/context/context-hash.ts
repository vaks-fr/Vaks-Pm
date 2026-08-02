/**
 * Empreinte du contexte lu par un agent au claim (traçabilité DORA, lot 2).
 *
 * L'ancien `buildContextSnapshot` posait UN hash sur un payload mêlant les
 * instructions humaines et l'environnement. Problème : depuis que le brief est
 * composé avec des faits résolus (reviewers, mode de vérification, langue),
 * ajouter un chef de projet ferait bouger ce hash — et il cesserait de répondre
 * à la question DORA (« un humain a-t-il modifié les instructions après que
 * l'agent les a lues ? ») pour répondre à « quelque chose a-t-il bougé ? ».
 *
 * D'où DEUX empreintes :
 *  - `authoredHash` : ce qu'un humain a ÉCRIT (brief, notes, garde-fous,
 *    critères, charter). C'est le signal DORA.
 *  - `factsHash`    : l'environnement résolu. La dérive reste observable, sans
 *    polluer le signal précédent.
 *
 * DEUX PIÈGES qu'on ferme ici :
 *  1. `JSON.stringify` d'un objet littéral n'est stable que PAR ACCIDENT (ordre
 *     d'insertion). Dès qu'un champ devient conditionnel (`...(x ? {k} : {})`),
 *     deux payloads sémantiquement identiques donnent deux hashes. On sérialise
 *     donc en **triant les clés, récursivement**.
 *  2. On ne hashe JAMAIS le texte composé : il dépend du gabarit de rendu, donc
 *     d'un déploiement de code — toutes les empreintes bougeraient à la moindre
 *     retouche de formulation. On hashe la DONNÉE, on stocke le texte.
 *
 * Volontairement pur côté logique (seul `crypto` est importé) : testable.
 */
import { createHash } from 'crypto';

/** Longueur du hash tronqué (inchangée : compat des lignes déjà écrites). */
const HASH_LENGTH = 16;

/**
 * Sérialisation canonique : clés triées à tous les niveaux, tableaux gardés
 * dans l'ordre (l'ordre d'un tableau est porteur de sens), `undefined` traité
 * comme absent pour que « champ omis » et « champ à undefined » coïncident.
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value === undefined ? null : value;
  if (Array.isArray(value)) return value.map(canonicalize);
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] === undefined) continue;
    out[key] = canonicalize(source[key]);
  }
  return out;
}

/** sha256 tronqué d'un objet, insensible à l'ordre des clés. */
export function contextHash(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/** Instructions écrites par un humain. */
export interface AuthoredContext {
  /** Brief structuré du projet (4 champs) — après fusion avec le défaut org. */
  brief?: unknown;
  /** Notes libres du projet (`Project.agentContext`). */
  freeNotes?: string | null;
  /** Garde-fous projet. */
  projectGuardrails?: string | null;
  /** Garde-fous de la tâche. */
  taskGuardrails?: string | null;
  /** Critères d'acceptation de la tâche. */
  criteria?: unknown;
  /** Charter filtré (allowlist agent) — c'est de l'instruction humaine, et il
   *  est gelé dès que le projet passe ACTIVE. */
  charter?: unknown;
}

/** Environnement résolu par le serveur. */
export interface ContextFacts {
  reviewers?: string[];
  verificationMode?: string | null;
  stakes?: string | null;
  verificationCapabilities?: string[];
  locale?: string | null;
  hasCostBudget?: boolean;
}

export interface ContextSnapshot {
  /** Alias de `authoredHash` — conserve le nom du champ historique. */
  hash: string;
  authoredHash: string;
  factsHash: string;
  capturedAt: string;
  /** Texte RÉELLEMENT servi à l'agent (cap 8 Ko) — l'artefact forensique. */
  composedBrief: string | null;
  authored: AuthoredContext;
  facts: ContextFacts;
}

/** Cap du texte stocké : un snapshot ne doit pas gonfler la ligne Task. */
const COMPOSED_BRIEF_MAX = 8 * 1024;

/**
 * Construit le snapshot complet. `capturedAt` est injecté par l'appelant pour
 * que la fonction reste déterministe (et testable sans geler l'horloge).
 */
export function buildContextSnapshot(
  authored: AuthoredContext,
  facts: ContextFacts,
  composedBrief: string | null,
  capturedAt: Date = new Date(),
): ContextSnapshot {
  const authoredHash = contextHash(authored);
  return {
    hash: authoredHash,
    authoredHash,
    factsHash: contextHash(facts),
    capturedAt: capturedAt.toISOString(),
    composedBrief:
      typeof composedBrief === 'string' && composedBrief.length
        ? composedBrief.slice(0, COMPOSED_BRIEF_MAX)
        : null,
    authored,
    facts,
  };
}
