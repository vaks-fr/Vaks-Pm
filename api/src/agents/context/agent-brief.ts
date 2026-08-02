/**
 * Brief agent STRUCTURÉ + composition (refonte du contexte IA, lot 2).
 *
 * Avant : `Project.agentContext` était un pavé libre où chaque PM réinventait sa
 * structure — et y retapait à la main des choses que l'application connaît déjà
 * (« Reviewer: Thomas », « English output »). Résultat : du bruit pour les
 * agents, et de la saisie en double pour les humains.
 *
 * Maintenant : le PM remplit 4 champs courts (`AgentBrief`), et le SERVEUR
 * compose le markdown final en y injectant les FAITS qu'il sait déjà résoudre
 * (`BriefFacts`). Le pavé libre survit en « notes libres », rendu en dernier.
 *
 * INVARIANT — le brief composé est **actor-independent** : il ne contient jamais
 * une propriété de l'agent appelant (concurrence, budget quotidien, niveau de
 * confiance). Sans ça, l'écran « ce que voient les agents » serait faux pour
 * tout le monde sauf un. Ces limites-là remontent en codes d'erreur au claim.
 *
 * INVARIANT — aucun montant. Les budgets sont rendus QUALITATIVEMENT (« un
 * plafond est défini, ~62 % consommé »), jamais en euros : le chiffré reste
 * derrière `finance:view`. Même règle que les paliers budget sponsor.
 *
 * Volontairement pur (aucune dépendance Nest/Prisma) : testable en isolation.
 */

/** Les 4 champs du brief structuré, dans l'ordre de rendu. */
export const AGENT_BRIEF_FIELDS = [
  'role',
  'outputConventions',
  'deliveryTarget',
  'outOfScope',
] as const;

export type AgentBriefField = (typeof AGENT_BRIEF_FIELDS)[number];

export type AgentBrief = { [K in AgentBriefField]: string | null };

/** Cap par champ — un brief n'est pas un cahier des charges. */
export const AGENT_BRIEF_FIELD_MAX = 4000;

/**
 * Faits résolus par le serveur, injectés dans le brief composé. Tous optionnels :
 * un fait non résolu (panne de lecture, réglage absent) fait OMETTRE sa ligne —
 * jamais « Reviewer: — », qu'un agent prendrait pour une information.
 */
export interface BriefFacts {
  /** Noms des PROJECT_MANAGER du projet (audience de revue). */
  reviewers?: string[];
  /** `report_only` | `enforce`. */
  verificationMode?: string | null;
  /** `low` | `medium` | `high` | `critical`. */
  stakes?: string | null;
  /** Méthodes de preuve disponibles sur le projet. */
  verificationCapabilities?: string[];
  /** Langue de travail de l'organisation (ex. `fr`, `en`). */
  locale?: string | null;
  /** Un plafond de coût agent existe-t-il sur le projet ? (jamais le montant) */
  hasCostBudget?: boolean;
  /** Part consommée du plafond, 0-100, arrondie. (jamais le montant) */
  costBudgetSpentPct?: number | null;
}

/** Titres de section du markdown composé (stables — le hash n'en dépend pas). */
const SECTION_TITLES: Record<AgentBriefField, string> = {
  role: 'Role & mission',
  outputConventions: 'Output conventions',
  deliveryTarget: 'Where deliverables go',
  outOfScope: 'Out of scope',
};

const FACTS_TITLE = 'What the system already knows';
const NOTES_TITLE = 'Project notes (maintained by the PM)';

function textOrNull(value: unknown, max = AGENT_BRIEF_FIELD_MAX): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Normalise une valeur brute (colonne Json, réglage org, DTO) en `AgentBrief`.
 *
 * Tolérant en entrée, strict en sortie : rejette non-objet et tableau, ignore
 * les clés inconnues et les valeurs non-string, trim, cap par champ. Renvoie
 * `null` si rien d'exploitable — un brief tout-vide n'existe pas.
 *
 * La MÊME fonction sert au champ projet et au défaut org, pour que les deux
 * offrent exactement les mêmes garanties.
 */
export function normalizeAgentBrief(raw: unknown): AgentBrief | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const source = raw as Record<string, unknown>;
  const brief = {} as AgentBrief;
  let hasContent = false;
  for (const field of AGENT_BRIEF_FIELDS) {
    const value = textOrNull(source[field]);
    brief[field] = value;
    if (value !== null) hasContent = true;
  }

  return hasContent ? brief : null;
}

/** `true` si le brief structuré n'apporte rien (absent ou tous champs vides). */
export function isBriefEmpty(brief: unknown): boolean {
  return normalizeAgentBrief(brief) === null;
}

/**
 * Fusionne le brief projet sur le défaut organisation, **champ par champ**.
 *
 * La précédence par champ (et non en bloc) est ce qui rend le défaut org utile :
 * « conventions de sortie » et langue se règlent une fois pour toute l'org,
 * tandis que « rôle/mission » reste propre à chaque projet. Un défaut org écrasé
 * en bloc par le premier projet qui définit un seul champ ne servirait à rien.
 */
export function mergeAgentBrief(
  projectBrief: unknown,
  orgDefault: unknown,
): { brief: AgentBrief | null; inheritedFields: AgentBriefField[] } {
  const own = normalizeAgentBrief(projectBrief);
  const fallback = normalizeAgentBrief(orgDefault);
  if (!own && !fallback) return { brief: null, inheritedFields: [] };

  const brief = {} as AgentBrief;
  const inheritedFields: AgentBriefField[] = [];
  for (const field of AGENT_BRIEF_FIELDS) {
    const mine = own?.[field] ?? null;
    if (mine !== null) {
      brief[field] = mine;
      continue;
    }
    const inherited = fallback?.[field] ?? null;
    brief[field] = inherited;
    if (inherited !== null) inheritedFields.push(field);
  }
  return { brief, inheritedFields };
}

/** Rend le bloc « faits système » en puces. Chaîne vide si aucun fait résolu. */
function renderFacts(facts: BriefFacts): string {
  const lines: string[] = [];

  const reviewers = (facts.reviewers ?? []).filter((n) => typeof n === 'string' && n.trim());
  if (reviewers.length) {
    lines.push(
      `- Reviewer${reviewers.length > 1 ? 's' : ''} (approve your work): ${reviewers.join(', ')}`,
    );
  }
  if (facts.stakes) {
    lines.push(`- Project stakes: ${facts.stakes}`);
  }
  if (facts.verificationMode) {
    lines.push(
      `- Verification mode: ${facts.verificationMode}` +
        (facts.verificationMode === 'enforce'
          ? ' (proof requirements are enforced before approval)'
          : ' (proof requirements are recorded, not enforced)'),
    );
  }
  const caps = (facts.verificationCapabilities ?? []).filter(
    (c) => typeof c === 'string' && c.trim(),
  );
  if (caps.length) {
    lines.push(`- Available proof methods on this project: ${caps.join(', ')}`);
  }
  if (facts.locale) {
    lines.push(`- Working language of this organisation: ${facts.locale}`);
  }
  // Budget : QUALITATIF uniquement — jamais de montant (cf. en-tête du module).
  if (facts.hasCostBudget) {
    const pct = facts.costBudgetSpentPct;
    lines.push(
      typeof pct === 'number' && Number.isFinite(pct)
        ? `- An agent cost cap is set on this project (about ${Math.round(pct)}% used).`
        : '- An agent cost cap is set on this project.',
    );
  }

  return lines.length ? lines.join('\n') : '';
}

/**
 * Compose le brief markdown servi aux agents.
 *
 * Les sections vides sont **intégralement omises** (jamais de titre orphelin :
 * un « ## Out of scope » suivi de rien se lit comme « rien n'est hors
 * périmètre »). Les notes libres viennent EN DERNIER et sont étiquetées —
 * sinon on aurait deux sources d'instructions sans ordre de préséance, et
 * l'agent arbitrerait au hasard.
 *
 * Déterministe : même entrée ⇒ même sortie (aucune date, aucun aléa).
 */
export function composeAgentBrief(
  brief: AgentBrief | null,
  freeNotes: string | null | undefined,
  facts: BriefFacts = {},
): string {
  const blocks: string[] = [];

  for (const field of AGENT_BRIEF_FIELDS) {
    const value = brief?.[field] ?? null;
    if (value) blocks.push(`## ${SECTION_TITLES[field]}\n${value}`);
  }

  const factsBlock = renderFacts(facts);
  if (factsBlock) blocks.push(`## ${FACTS_TITLE}\n${factsBlock}`);

  const notes = textOrNull(freeNotes, 20000);
  if (notes) blocks.push(`## ${NOTES_TITLE}\n${notes}`);

  return blocks.join('\n\n');
}
