/**
 * Tools qui reçoivent le paramètre optionnel `confirmToken`, avec — pour les
 * tools FUSIONNÉS (param `action`) — la liste des actions destructrices.
 *
 * ⚠️ **Miroir de `DESTRUCTIVE_TOOLS`** (`api/src/mcp/mcp-confirm-scope.ts`),
 * qui reste la source de vérité — c'est l'API qui décide, le serveur MCP ne
 * fait qu'exposer le paramètre. Là-bas les entrées sont aplaties en
 * identifiants composites `tool:action` (le seul format qui voyage dans le
 * header `X-Vaks-Mcp-Tool`) ; ici la map garde la forme tool → actions parce
 * que le schéma est figé à l'enregistrement du tool : le paramètre est exposé
 * dès qu'AU MOINS une action du tool est destructrice, et sa description
 * précise qu'il ne sert que sur celles-là.
 *
 * Pourquoi ne pas l'ajouter à tous les tools d'écriture, ce qui supprimerait la
 * duplication : ce paramètre coûterait alors ~2-3 k tokens de description à
 * **chaque** `tools/list`, sur des dizaines de tools dont l'immense majorité
 * ne sera jamais challengée.
 *
 * Un décalage n'est pas dangereux : si un tool manque ici, l'agent reçoit le
 * défi mais n'a pas le paramètre pour y répondre — visible immédiatement, et
 * jamais une action qui passe sans confirmation.
 */
export const CONFIRM_TOOL_ACTIONS: ReadonlyMap<string, '*' | ReadonlySet<string>> = new Map<
  string,
  '*' | ReadonlySet<string>
>([
  // Tools dédiés : challengés quelle que soit l'entrée.
  ['vaks_delete_task', '*'],
  ['vaks_notify_stakeholders', '*'],
  ['vaks_plan_project_apply', '*'],
  // Tools fusionnés : seules ces actions déclenchent le défi côté API.
  ['vaks_time_entries', new Set(['delete'])],
  ['vaks_time_off_manage', new Set(['delete'])],
  ['vaks_allocations_manage', new Set(['delete'])],
  ['vaks_labels_manage', new Set(['delete'])],
  ['vaks_dependencies_manage', new Set(['delete'])],
  ['vaks_clients_manage', new Set(['delete_client', 'delete_contact'])],
  ['vaks_teams_manage', new Set(['remove_member'])],
  ['vaks_skills_catalog', new Set(['delete'])],
  ['vaks_skills_assign', new Set(['remove_user'])],
  ['vaks_expenses_manage', new Set(['delete'])],
  ['vaks_project_finance', new Set(['delete_rate'])],
  // `resolve` n'est destructif qu'en REJECTED — l'API challenge toute
  // résolution (statu quo de l'ancien `vaks_resolve_skill_request`).
  ['vaks_skill_requests', new Set(['resolve'])],
]);
