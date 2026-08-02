/**
 * Vue AGENT du charter projet (refonte du contexte IA, lot 0).
 *
 * Le charter est une pièce d'initiation **humaine** : il porte le périmètre et
 * les contraintes du projet (utiles à un agent), mais aussi le budget estimé,
 * les parties prenantes nommées et les risques (qui ne le sont pas, et qui
 * relèvent de `finance:view` / de données personnelles).
 *
 * `ProjectsController` est marqué `@PublicApi()` **au niveau classe** : toutes
 * ses routes sont donc atteignables par un jeton d'API. Un agent porteur de la
 * capability `read:project` (→ `project:view`) lisait ainsi le charter ENTIER.
 * Ce module définit l'unique réponse à « qu'a le droit de savoir un agent du
 * charter ? » — réutilisée par la route directe ET par le work-context, pour
 * qu'il n'existe jamais deux définitions divergentes.
 *
 * Volontairement pur (aucune dépendance Nest/Prisma) : testable en isolation.
 */

/**
 * Rubriques du charter exposées aux agents. Tout le reste est refusé par
 * défaut (fail-safe) — notamment :
 *
 *  - `budgetEstimate`  → finance, réservée à `finance:view` ;
 *  - `stakeholders` / `sponsor*` → personnes nommées ;
 *  - `risks`           → analyse interne, non nécessaire à l'exécution ;
 *  - `milestones` / `assumptions` → hors du besoin d'exécution d'une tâche ;
 *  - `extraSections`   → rubriques LIBRES : n'importe quoi a pu y être mis,
 *                        donc jamais exposable en aveugle ;
 *  - `signedDocument`  → le PDF signé rend le charter complet.
 */
export const AGENT_CHARTER_FIELDS = [
  'projectPurpose',
  'objectives',
  'scopeIn',
  'scopeOut',
  'deliverables',
  'constraints',
  'successCriteria',
] as const;

export type AgentCharterField = (typeof AGENT_CHARTER_FIELDS)[number];

export type AgentCharterView = { [K in AgentCharterField]: string | null };

/**
 * Vue « charter vide » : les 7 rubriques à `null`.
 *
 * `agentCharterView` renvoie `null` quand il n'y a rien à dire — c'est la bonne
 * sémantique DANS un pack de contexte (on omet le bloc). Mais une ROUTE REST ne
 * peut pas répondre `null` : Nest sérialise ça en **corps vide**, qu'un client
 * JSON (MCP `vaks_read`, intégration tierce) ne sait pas distinguer d'une
 * erreur. Le controller renvoie donc cet objet plutôt que rien.
 */
export const EMPTY_AGENT_CHARTER_VIEW: AgentCharterView = Object.freeze(
  Object.fromEntries(AGENT_CHARTER_FIELDS.map((f) => [f, null])),
) as AgentCharterView;

/** Normalise une valeur de rubrique : chaîne non vide, sinon `null`. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Projette un charter sur l'allowlist agent.
 *
 * Renvoie `null` quand le charter est absent **ou** que toutes les rubriques
 * autorisées sont vides : un bloc de sept `null` n'apporte rien au contexte
 * d'un agent et lui ferait croire à un charter rempli mais inutilisable.
 *
 * Note : `getCharter` crée la ligne charter à la volée (`upsert`), donc un
 * projet dont personne n'a jamais rempli le charter arrive bien ici avec un
 * objet — d'où le repli sur `null`.
 */
export function agentCharterView(
  charter: Record<string, unknown> | null | undefined,
): AgentCharterView | null {
  if (!charter) return null;

  const view = {} as AgentCharterView;
  let hasContent = false;
  for (const field of AGENT_CHARTER_FIELDS) {
    const value = textOrNull(charter[field]);
    view[field] = value;
    if (value !== null) hasContent = true;
  }

  return hasContent ? view : null;
}
